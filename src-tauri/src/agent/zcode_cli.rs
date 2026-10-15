//! 原生 CLI 的短时查询适配：模型目录与离线历史均经过同一 NDJSON 边界。
use std::io::{BufRead,BufReader,Read,Write};
use std::process::Stdio;
use std::sync::{Arc,Mutex,mpsc};
use std::time::Duration;
use serde_json::{json,Value};

pub fn query(bin: &str, cwd: Option<&str>, method: &str, params: Value) -> Result<Value,String> {
    let mut cmd=crate::host::command(bin);
    // 与会话启动统一重建登录环境，避免 USERPROFILE 等路径变量指向另一份历史库。
    crate::login_env::refresh_command(&mut cmd);
    super::executable::prepare_command(&mut cmd,bin);
    cmd.args(["app-server","--stdio","--standalone"]);
    if let Some(cwd)=cwd {cmd.current_dir(cwd);}
    #[cfg(unix)] {use std::os::unix::process::CommandExt;cmd.process_group(0);}
    let mut child=cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|format!("无法查询 Zcode CLI：{e}"))?;
    let stdin=Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let stdout=child.stdout.take().unwrap();
    let stderr=child.stderr.take().unwrap();
    std::thread::spawn(move || {let _=std::io::copy(&mut stderr.take(1024*1024),&mut std::io::sink());});
    let (tx,rx)=mpsc::channel();
    let writer=stdin.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(frame)=serde_json::from_str::<Value>(&line) else {continue};
            if frame["id"]=="vela-query" && frame.get("method").is_none() {
                let result=if frame.get("error").is_some() {Err(frame["error"]["message"].as_str().unwrap_or("Zcode 查询失败").to_string())}else{Ok(frame["result"].clone())};
                let _=tx.send(result);break;
            }
            if frame.get("id").is_some() && frame.get("method").is_some() {
                let answer=if frame["method"]=="session/requestRuntimePreferences" {json!({"id":frame["id"],"result":{"nativeSearchEnhancementsEnabled":true,"memoryEnabled":false,"askUserQuestionAutoResolutionEnabled":false}})}
                    else {json!({"id":frame["id"],"error":{"code":-32601,"message":"只读查询不提供此宿主能力"}})};
                let _=writeln!(writer.lock().unwrap(),"{answer}");
            }
        }
    });
    // 等待回包前释放 stdin；CLI 初始化的反向运行偏好请求也要写入同一标准流。
    let sent={let mut writer=stdin.lock().unwrap();writeln!(writer,"{}",json!({"id":"vela-query","method":method,"params":params})).and_then(|_|writer.flush())};
    let result=match sent {
        Ok(())=>rx.recv_timeout(Duration::from_secs(30)).map_err(|_|"Zcode 查询超时或进程退出".to_string()).and_then(|r|r),
        Err(e)=>Err(format!("无法写入 Zcode 查询：{e}")),
    };
    drop(stdin);
    crate::host::kill_process_tree(&mut child);
    let _=child.wait();
    result
}

pub fn models(bin: &str) -> Result<Vec<String>,String> {
    let cwd=std::env::current_dir().map_err(|e|e.to_string())?.to_string_lossy().into_owned();
    let snapshot=query(bin,Some(&cwd),"session/create",json!({"workspace":{"workspacePath":cwd,"workspaceKey":cwd},"persistence":"deferred","titleGenerationEnabled":false}))?;
    Ok(snapshot["settings"]["model"]["available"].as_array().into_iter().flatten().filter(|m|m["disabledReason"].is_null()).filter_map(|m|Some(format!("{}/{}",m["ref"]["providerId"].as_str()?,m["ref"]["modelId"].as_str()?))).collect())
}

pub fn transcript(bin: &str, cwd: Option<&str>, native: &str) -> Result<Vec<super::transcript::TranscriptMessage>,String> {
    let mut params=json!({"sessionId":native});
    if let Some(cwd)=cwd {params["workspace"]=json!({"workspacePath":cwd,"workspaceKey":cwd});}
    let snapshot=query(bin,cwd,"session/resume",params)?;
    Ok(snapshot["messages"].as_array().into_iter().flatten().filter(|m|matches!(m["info"]["role"].as_str(),Some("user"|"assistant"))).map(|message| {
        let text=message["parts"].as_array().into_iter().flatten().filter(|p|p["type"]=="text").filter_map(|p|p["text"].as_str()).collect::<String>();
        let tools=message["parts"].as_array().into_iter().flatten().filter(|p|p["type"]=="tool").filter_map(|p|p["tool"].as_str().map(str::to_string)).collect();
        super::transcript::TranscriptMessage{role:message["info"]["role"].as_str().unwrap().into(),text,timestamp:None,tools}
    }).collect())
}
