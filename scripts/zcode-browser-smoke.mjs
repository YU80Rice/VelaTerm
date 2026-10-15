// 成品内嵌前端 + 真实后端/CLI；浏览器 profile 与账户均由调用方测试夹具隔离。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export async function checkZcodeBrowser({ base, token, sessionName, root, cold = false }) {
  const executable = process.env.VELATERM_TEST_BROWSER;
  if (!executable) return false;
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, cold ? 'cold-browser-profile' : 'browser-profile')}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
  let socket;
  const pending = new Map();
  const exceptions = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, accept, label) => {
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      const value = await read();
      if (accept(value)) return value;
      await pause(150);
    }
    throw Error(`Zcode 界面验收超时：${label}`);
  };
  try {
    const target = await until(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
        return (await response.json()).find(page => page.type === 'page' && page.webSocketDebuggerUrl);
      } catch { return null; }
    }, Boolean, '浏览器启动');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data);
      if (frame.method === 'Runtime.exceptionThrown') exceptions.push(frame.params.exceptionDetails.exception?.description ?? frame.params.exceptionDetails.text);
      const request = pending.get(frame.id);
      if (!request) return;
      pending.delete(frame.id);
      if (frame.error) request.reject(Error(frame.error.message)); else request.resolve(frame.result);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`浏览器命令超时：${method}`)); }, 20000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.origin===${JSON.stringify(base)})sessionStorage.setItem('vlx-token',${JSON.stringify(token)});` });
    const selectSession = async () => {
      await until(() => evaluate(`Array.from(document.querySelectorAll('.nm')).some(n=>n.textContent===${JSON.stringify(sessionName)})`), Boolean, '独立 Zcode 会话树节点');
      await evaluate(`Array.from(document.querySelectorAll('.nm')).find(n=>n.textContent===${JSON.stringify(sessionName)}).click()`);
      await until(() => evaluate(`Boolean(document.querySelector('.sv-box textarea'))&&(${cold}||Array.from(document.querySelectorAll('.sv-chip-label')).some(n=>n.textContent.includes('gpt-4o')))`), Boolean, '模型目录和聊天输入框');
    };
    await send('Page.navigate', { url: base + '/?view=desktop' });
    await selectSession();
    await evaluate(`(${cold}?document.querySelector('button.sv-chip'):Array.from(document.querySelectorAll('button.sv-chip')).find(n=>n.textContent.includes('gpt-4o'))).click()`);
    await until(() => evaluate(`Array.from(document.querySelectorAll('.sv-chip-box [role="option"]')).some(row=>row.textContent.includes('gpt-4o'))`), Boolean, '展开模型菜单并显示原生模型');
    assert(await evaluate(`Array.from(document.querySelectorAll('.sv-chip-box [role="option"]')).some(row=>row.textContent.includes('gpt-4o')&&row.textContent.includes('Local fixture'))`), '模型菜单应显示原生供应商名称');
    if (cold) {
      assert(!await evaluate(`document.body.innerText.includes('UI_RENDER_OK')`), '空白菜单验收必须发生在首次发送之前');
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path.join(root, 'zcode-cold-model-menu.png'), Buffer.from(screenshot.data, 'base64'));
      assert.deepEqual(exceptions, []);
      await writeFile(path.join(root, 'cold-browser-result.json'), JSON.stringify({ modelMenu: true, providerHint: true, beforeFirstStart: true, uncaughtExceptions: exceptions, embeddedFrontend: true }, null, 2));
      return true;
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await evaluate(`(()=>{const input=document.querySelector('.sv-box textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'UI_RENDER_TEST');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => evaluate(`document.body.innerText.includes('UI_RENDER_OK')`), Boolean, '从界面发送并显示模型回复');
    await send('Page.reload');
    await selectSession();
    await until(() => evaluate(`document.body.innerText.includes('UI_RENDER_OK')`), Boolean, '重新加载后恢复会话');
    assert.deepEqual(exceptions, [], '前端产生了未捕获异常');
    assert(!await evaluate(`document.body.innerText.includes('界面渲染出错')||document.body.innerText.includes('Cannot read properties')`), '前端错误边界被触发');
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(root, 'zcode-render-smoke.png'), Buffer.from(screenshot.data, 'base64'));
    await writeFile(path.join(root, 'browser-result.json'), JSON.stringify({ modelMenu: true, composerSend: true, reply: 'UI_RENDER_OK', reloadResume: true, uncaughtExceptions: exceptions, embeddedFrontend: true }, null, 2));
    return true;
  } finally {
    for (const request of pending.values()) request.reject(Error('测试浏览器已关闭'));
    socket?.close();
    if (browser.exitCode === null && browser.pid) {
      const killed = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve => killed.once('exit', resolve));
    }
  }
}
