// Windows 成品回归：最终 EXE 的真实后端 + 真实 ZCode CLI + 隔离的本地模型服务。
// 用法：VELATERM_TEST_EXE、ZCODE_TEST_BIN 指向已构建程序；需要 Node 22+。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

if (process.platform !== 'win32') throw Error('此回归脚本验证 Windows 成品；协议单测支持其他平台。');
const exe = process.env.VELATERM_TEST_EXE;
const bin = process.env.ZCODE_TEST_BIN;
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
if (!exe || !bin) throw Error('请设置 VELATERM_TEST_EXE 和 ZCODE_TEST_BIN。');
const root = await mkdtemp(path.join(tmpdir(), 'vela-zcode-e2e-'));
console.log(JSON.stringify({ fixtureRoot: root }));
const workspace = path.join(root, 'workspace');
const nativeRoot = path.join(root, 'native');
const profile = path.join(root, 'profile');
await Promise.all([mkdir(workspace), mkdir(profile), mkdir(path.join(nativeRoot, '.zcode/v2'), { recursive: true })]);
// Windows 会话会重建系统环境。仅在测试 wrapper 中指定 profile，避免加载个人 hooks。
const wrapper = path.join(root, 'fixture-zcode.cmd');
const environmentLog = path.join(root, 'launch-profiles.txt');
await writeFile(wrapper, '@echo off\r\n>> "%VELA_ZCODE_ENV_LOG%" echo("%USERPROFILE%"\r\nset "USERPROFILE=%VELA_ZCODE_TEST_PROFILE%"\r\n"%VELA_ZCODE_TEST_BINARY%" %*\r\n');
const modelServer = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const text = body.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (text.includes('STALL')) { response.write(': waiting\n\n'); return; }
  const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o' };
  const chunk = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (!body.messages.some(message => message.role === 'tool')) {
    let tool;
    if (text.includes('WRITE')) tool = { name: 'Write', arguments: { file_path: path.join(workspace, 'written.txt'), content: 'WRITE_OK' } };
    if (text.includes('DENIAL')) tool = { name: 'Bash', arguments: { command: 'printf DENIED > blocked.txt', description: '权限拒绝测试' } };
    if (text.includes('PLAN_REVIEW')) tool = { name: 'ExitPlanMode', arguments: { plan: '实现经过批准的计划。' } };
    if (tool) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
      chunk({}, 'tool_calls'); response.end('data: [DONE]\n\n'); return;
    }
  }
  const textResult = text.includes('ALPHA') ? 'ALPHA_RESULT' : text.includes('BETA') ? 'BETA_RESULT' : 'FIXTURE_RESULT';
  chunk({ role: 'assistant', content: textResult.slice(0, 5) });
  chunk({ content: textResult.slice(5) });
  chunk({}, 'stop'); response.end('data: [DONE]\n\n');
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(nativeRoot, '.zcode/v2/provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {
  providerConfigRules: { providerRules: [{ providerId: 'local-fixture', providerName: 'Local fixture', enabled: true, config: {
    group: 'standard-personal', access: { type: 'api-key', apiKey: 'fixture-only' },
    api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1` }, personalModelIds: ['gpt-4o'], visibility: 'visible',
  } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'local-fixture', modelId: 'gpt-4o' },
} }));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const password = randomUUID();
const app = spawn(exe, ['--serve', '--local-http', '--port', String(port), '--data-dir', path.join(root, 'vela')], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, USERPROFILE: profile, VELA_ZCODE_ENV_LOG: environmentLog, VELA_ZCODE_TEST_PROFILE: profile, VELA_ZCODE_TEST_BINARY: bin, ZCODE_DATA_BASE_DIR: nativeRoot, VELA_ISOLATED_RUNTIME: '1', VELA_SERVE_PASSWORD: password },
});
let socket;
const sessions = [];
let call;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, accept, label, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(100); }
  throw Error(label + ' 超时');
};
try {
  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(base + '/api/mode', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean, '后端启动');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert(login.ok);
  const { token } = await login.json();
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.t !== 'reply') return;
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    if (frame.ok) request.resolve(frame.result); else request.reject(Error(frame.error));
  });
  call = (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(cmd + ' 超时')); }, 45000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(Error(cmd + ': ' + error.message)); } });
    socket.send(JSON.stringify({ t: 'invoke', id, cmd, args }));
  });
  assert.equal(await call('app_version'), expectedVersion);
  await call('set_app_settings', { entries: { 'vlx-settings': JSON.stringify({ agentDefaults: { zcode: { path: wrapper } } }) } });
  const project = await call('import_project', { rootPath: workspace });
  const parent = await call('create_session', { projectId: project.id, name: 'Zcode 测试父会话', kind: 'terminal', cwd: workspace, engine: 'tui' });
  const create = async () => {
    const session = await call('agent_session_create', { request: { requestId: randomUUID(), context: { projectId: project.id, groupId: null, activeSessionId: parent.id, placement: 'child' }, kind: 'zcode', presetId: null } });
    assert.equal(session.kind, 'zcode'); assert.equal(session.parentSessionId, parent.id); assert.equal(session.engine, 'chat');
    sessions.push(session.id);
    await call('chat_start', { sessionId: session.id, fastMode: false });
    await until(() => call('chat_snapshot', { sessionId: session.id }), snapshot => snapshot.model === 'local-fixture/gpt-4o', '原生模型就绪');
    return session.id;
  };
  const finished = sessionId => until(() => call('chat_snapshot', { sessionId }), snapshot => !snapshot.turnStartedAt && snapshot.rows.some(row => row.kind === 'assistant' && !row.streaming), '原生回合结束');
  const [alpha, beta] = await Promise.all([create(), create()]);
  await Promise.all([call('chat_send', { sessionId: alpha, text: 'ALPHA' }), call('chat_send', { sessionId: beta, text: 'BETA' })]);
  const answers = await Promise.all([finished(alpha), finished(beta)]);
  assert(answers[0].rows.some(row => row.kind === 'assistant' && row.text === 'ALPHA_RESULT'));
  assert(!JSON.stringify(answers[0].rows).includes('BETA_RESULT'));
  assert(answers[1].rows.some(row => row.kind === 'assistant' && row.text === 'BETA_RESULT'));
  const before = (await call('list_tree')).sessions.find(session => session.id === alpha).agentSessionId;
  assert(before?.startsWith('sess_'));
  assert(JSON.stringify(await call('chat_models', { sessionId: alpha })).includes('local-fixture/gpt-4o'));
  for (const mode of ['plan', 'edit', 'yolo', 'build']) await call('chat_set_mode', { sessionId: alpha, mode });
  await call('chat_set_effort', { sessionId: alpha, effort: 'disabled' });
  await call('chat_set_effort', { sessionId: alpha, effort: null });
  await call('chat_stop', { sessionId: alpha });
  assert(JSON.stringify(await call('read_agent_transcript', { sessionId: alpha })).includes('ALPHA_RESULT'));
  const launchProfiles = (await readFile(environmentLog, 'utf8')).trim().split(/\r?\n/);
  assert(launchProfiles.length >= 3);
  assert(launchProfiles.every(value => value === launchProfiles[0]), '主 CLI 与历史查询必须使用相同的登录环境');
  await call('chat_start', { sessionId: alpha, fastMode: false });
  await call('chat_send', { sessionId: alpha, text: 'ALPHA AGAIN' });
  await until(() => call('chat_snapshot', { sessionId: alpha }), snapshot => snapshot.rows.filter(row => row.kind === 'assistant' && !row.streaming).length >= 2, '恢复后继续对话');
  assert.equal((await call('list_tree')).sessions.find(session => session.id === alpha).agentSessionId, before);
  const writer = await create();
  await call('chat_set_mode', { sessionId: writer, mode: 'yolo' });
  await call('chat_send', { sessionId: writer, text: 'WRITE' });
  const written = await finished(writer);
  assert.equal(await readFile(path.join(workspace, 'written.txt'), 'utf8'), 'WRITE_OK');
  assert(written.rows.some(row => row.kind === 'tool' && row.name === 'Write' && row.input.content === 'WRITE_OK' && row.status === 'completed'));
  const denied = await create();
  await call('chat_send', { sessionId: denied, text: 'DENIAL' });
  const deny = await until(() => call('chat_snapshot', { sessionId: denied }), snapshot => snapshot.permissions.length, '工具权限确认');
  await delay(2200);
  const repeated = await call('chat_snapshot', { sessionId: denied });
  assert.equal(repeated.permissions.length, 1, '原生交互重发应保留一张卡片');
  assert.equal(repeated.permissions[0].id, deny.permissions[0].id);
  await call('chat_permission', { sessionId: denied, requestId: deny.permissions[0].id, allow: false, message: '测试拒绝' });
  await finished(denied);
  await assert.rejects(readFile(path.join(workspace, 'blocked.txt')), { code: 'ENOENT' });
  const cancelled = await create();
  await call('chat_send', { sessionId: cancelled, text: 'DENIAL' });
  const pendingPermission = await until(() => call('chat_snapshot', { sessionId: cancelled }), snapshot => snapshot.permissions.length, '中断前的待确认卡片');
  await call('chat_interrupt', { sessionId: cancelled });
  await until(() => call('chat_snapshot', { sessionId: cancelled }), snapshot => !snapshot.turnStartedAt && !snapshot.permissions.length, '中断清除待确认卡片');
  await assert.rejects(call('chat_permission', { sessionId: cancelled, requestId: pendingPermission.permissions[0].id, allow: true }));
  const planner = await create();
  await call('chat_set_mode', { sessionId: planner, mode: 'plan' });
  await call('chat_send', { sessionId: planner, text: 'PLAN_REVIEW' });
  const review = await until(() => call('chat_snapshot', { sessionId: planner }), snapshot => snapshot.permissions.some(permission => permission.tool_name === 'AskUserQuestion'), '计划批准卡片');
  const question = review.permissions.find(permission => permission.tool_name === 'AskUserQuestion');
  const plan = question.input.questions[0];
  assert.equal(plan.options[0].label, 'Approve'); assert.equal(plan.options[0].value, 'approve');
  await call('chat_permission', { sessionId: planner, requestId: question.id, allow: true, updatedInput: { ...question.input, answers: { [plan.question]: plan.options[0].value } } });
  const approved = await finished(planner);
  assert(approved.rows.some(row => row.kind === 'tool' && row.name === 'ExitPlanMode' && row.status === 'completed' && !row.isError));
  assert.equal(approved.mode, 'build', '原生计划批准后，界面必须反映实际权限模式');
  await call('chat_send', { sessionId: beta, text: 'STALL' });
  await delay(500);
  await call('chat_interrupt', { sessionId: beta });
  await until(() => call('chat_snapshot', { sessionId: beta }), snapshot => !snapshot.turnStartedAt, '原生中断');
  const result = { appVersion: expectedVersion, nativeConcurrentSessions: true, nativeResume: true, offlineHistory: true, permissionDenial: true, permissionReannouncement: true, pendingInteractionCancellation: true, writeToolAndArguments: true, planApproval: true, interrupt: true, zcodeGuiUsed: false, productionAccountAuthorization: false };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, evidence: path.join(root, 'result.json') }));
} finally {
  if (call && socket?.readyState === WebSocket.OPEN) await Promise.allSettled(sessions.map(sessionId => call('chat_stop', { sessionId })));
  socket?.close();
  const killed = spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => killed.once('exit', resolve));
  modelServer.closeAllConnections();
  await new Promise(resolve => modelServer.close(resolve));
}
