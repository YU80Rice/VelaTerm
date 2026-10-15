//! 登录由原生 CLI 执行，宿主只显示授权 URL 与完成状态。
use std::io::{BufRead, BufReader, Read};
use std::process::Stdio;
use std::sync::{Arc, Mutex, atomic::Ordering};
use std::time::{Duration, Instant};
use super::{AuthState, ChatProcess, AppCtx, emit_extras};

pub(in super::super) fn run(app: &AppCtx, session: &str, proc: &Arc<ChatProcess>, login: bool, family: &str) -> Result<(),String> {
    if !matches!(family,"zai"|"bigmodel") { return Err("Zcode 登录账户应为 zai 或 bigmodel".into()); }
    if super::active(proc) { return Err("Zcode 账户操作正在进行".into()); }
    if proc.turn.lock().unwrap().running { return Err("请先等待 Zcode 当前任务结束".into()); }
    let mut cmd=crate::host::command(&proc.bin);
    crate::agent::executable::prepare_command(&mut cmd,&proc.bin);
    if let Some(cwd)=&proc.cwd { cmd.current_dir(cwd); }
    if login { cmd.args(["login",family,"--no-browser","--json"]); }
    else { cmd.args(["logout","--json"]); }
    #[cfg(unix)] {use std::os::unix::process::CommandExt;cmd.process_group(0);}
    let mut child=cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|format!("无法启动 Zcode 原生登录：{e}"))?;
    let stdout=child.stdout.take().unwrap();
    let stderr=child.stderr.take().unwrap();
    let child=Arc::new(Mutex::new(child));
    proc.zcode.lock().unwrap().auth_child=Some(child.clone());
    proc.extras.lock().unwrap().auth=Some(AuthState::new(if login{"starting"}else{"signingOut"}));
    emit_extras(app,session,proc);
    // CLI 的成功 JSON 可能带账户资料，只排空 stdout，绝不写入聊天或诊断。
    std::thread::spawn(move || { let _=std::io::copy(&mut stdout.take(1024*1024),&mut std::io::sink()); });
    let (app2,session2,proc2)=(app.clone(),session.to_string(),proc.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if line.starts_with("https://") && line.len()<8192 {
                let mut extras=proc2.extras.lock().unwrap();
                if let Some(state)=extras.auth.as_mut().filter(|s|s.active()) { state.status="pending"; state.verification_url=Some(line); }
                drop(extras); emit_extras(&app2,&session2,&proc2);
            }
        }
    });
    let (app,session,proc)=(app.clone(),session.to_string(),proc.clone());
    std::thread::spawn(move || {
        let started=Instant::now();
        let success=loop {
            if !proc.alive.load(Ordering::Relaxed) || !super::active(&proc) || started.elapsed()>Duration::from_secs(900) {
                super::super::terminate_owned(&mut child.lock().unwrap()); break false;
            }
            match child.lock().unwrap().try_wait() { Ok(Some(code))=>break code.success(), Err(_)=>break false, _=>{} }
            std::thread::sleep(Duration::from_millis(200));
        };
        proc.zcode.lock().unwrap().auth_child=None;
        if !super::active(&proc) { return; }
        proc.extras.lock().unwrap().auth=Some(AuthState::new(if success {if login{"success"}else{"signedOut"}}else{"failed"}));
        emit_extras(&app,&session,&proc);
        if success && login && proc.alive.load(Ordering::Relaxed) {
            // 账户注册表由 CLI 启动装配，重新打开同一原生会话以读取新账户，不创建新上下文。
            super::super::release_process(&app,&session,&proc);
            if let Err(error)=crate::command_core::chat_start(&app,&session,None,None,false) {
                super::super::emit(&app,&session,serde_json::json!({"type":"error","message":format!("Zcode 登录已完成，恢复会话失败：{error}")}));
            }
        }
    });
    Ok(())
}

pub(in super::super) fn stop(proc: &ChatProcess) {
    if let Some(child)=proc.zcode.lock().unwrap().auth_child.take() {
        super::super::terminate_owned(&mut child.lock().unwrap());
    }
}

pub(in super::super) fn cancel(app: &AppCtx, session: &str, proc: &Arc<ChatProcess>) -> Result<(),String> {
    stop(proc);
    proc.extras.lock().unwrap().auth=Some(AuthState::new("canceled"));
    emit_extras(app,session,proc);
    Ok(())
}
