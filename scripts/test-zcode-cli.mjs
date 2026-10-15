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
import { checkZcodeBrowser } from './zcode-browser-smoke.mjs';

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
// 0.2.10 还会单独执行 --version；该探测不读取历史，不属于 app-server 环境比较。
await writeFile(wrapper, '@echo off\r\nif /I "%~1"=="app-server" >> "%VELA_ZCODE_ENV_LOG%" echo("%USERPROFILE%"\r\nset "USERPROFILE=%VELA_ZCODE_TEST_PROFILE%"\r\n"%VELA_ZCODE_TEST_BINARY%" %*\r\n');
let generationRequests = 0;
let startPlanPhase = 'pending';
let startPlanRequests = 0;
let startPlanRemaining = 80;
let unexpectedAccountRequests = 0;
const modelServer = createServer(async (request, response) => {
  if (request.url.startsWith('/api/v1/oauth/cli/')) {
    for await (const _chunk of request) { /* 仅消费本地假登录请求。 */ }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 0, data: request.url.includes('/init')
      ? { flow_id: 'start-fixture', poll_token: 'fixture-poll', authorize_url: 'https://example.test/fixture-login', expires_at: Math.floor(Date.now() / 1000) + 120, poll_interval_sec: 1 }
      : { status: 'ready', token: 'fixture-start-jwt', user: { user_id: 'fixture-user' }, bigmodel: { access_token: 'fixture-oauth' } } })); return;
  }
  if (request.url.startsWith('/api/v1/zcode-plan/billing/balance')) {
    assert.equal(request.headers.authorization, 'Bearer fixture-start-jwt');
    assert(request.headers['x-device-mid']);
    assert.equal(request.headers['x-title'], 'Z Code@cli');
    assert(request.url.includes('app_version=3.15.1'), '必须使用真实产品版本，而不是未知开发版本');
    const now = Math.floor(Date.now() / 1000);
    response.writeHead(200, { 'Content-Type': 'application/json', Date: new Date().toUTCString() });
    response.end(JSON.stringify({ code: 0, data: { server_time: now,
      plans: [{ user_plan_id: 'fixture-plan', name: 'ZCode Global Build', status: 'active', ends_at: now + 7200,
        entitlements: [{ entitlement_id: 'fixture-entitlement', effective_at: startPlanPhase === 'pending' ? now + 3600 : now - 3600 }] }],
      balances: startPlanPhase === 'pending' ? [] : [{ user_plan_id: 'fixture-plan', entitlement_id: 'fixture-entitlement',
        show_name: 'GLM-5.3-Flash', capabilities: ['model:GLM-5.3-Flash'], total_units: 100,
        used_units: 100 - startPlanRemaining, available_units: startPlanRemaining, unit_type: 'credits' }],
    } })); return;
  }
  if (request.url.startsWith('/api/v1/zcode-plan/anthropic/')) {
    startPlanRequests++;
    const authorized = request.headers.authorization === 'Bearer fixture-start-jwt' || request.headers['x-api-key'] === 'fixture-start-jwt';
    assert(authorized, '模型请求必须使用 Start Plan JWT');
    for await (const _chunk of request) { /* 消费请求体，禁止记录可能含敏感信息的正文。 */ }
    startPlanRemaining -= 5;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('message_start', { message: { id: 'start-plan-reply', type: 'message', role: 'assistant', model: 'GLM-5.3-Flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'START_PLAN_OK' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
    event('message_stop', {}); response.end(); return;
  }
  if (!request.url.startsWith('/v1/')) {
    if (request.url.includes('token') || request.url.includes('apikey')) unexpectedAccountRequests++;
    response.writeHead(404); response.end(); return;
  }
  generationRequests++;
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
  const textResult = text.includes('UI_RENDER_TEST') ? 'UI_RENDER_OK' : text.includes('ALPHA') ? 'ALPHA_RESULT' : text.includes('BETA') ? 'BETA_RESULT' : 'FIXTURE_RESULT';
  chunk({ role: 'assistant', content: textResult.slice(0, 5) });
  chunk({ content: textResult.slice(5) });
  chunk({}, 'stop'); response.end('data: [DONE]\n\n');
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(nativeRoot, '.zcode/v2/provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {
  providerConfigRules: { providerRules: [{ providerId: 'local-fixture', providerName: 'Local fixture', enabled: true, config: {
    group: 'standard-personal', access: { type: 'api-key', apiKey: 'fixture-only' },
    api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1` }, personalModelIds: ['gpt-4o', 'gpt-4o-mini'], visibility: 'visible',
  } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'local-fixture', modelId: 'gpt-4o' },
} }));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const password = randomUUID();
const app = spawn(exe, ['--serve', '--local-http', '--port', String(port), '--data-dir', path.join(root, 'vela')], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, USERPROFILE: profile, VELA_ZCODE_ENV_LOG: environmentLog, VELA_ZCODE_TEST_PROFILE: profile, VELA_ZCODE_TEST_BINARY: bin, ZCODE_DATA_BASE_DIR: nativeRoot, ZCODE_ENDPOINT_ORIGIN: `http://127.0.0.1:${modelServer.address().port}`, VELA_ISOLATED_RUNTIME: '1', VELA_SERVE_PASSWORD: password },
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
  const create = async (start = true) => {
    const session = await call('agent_session_create', { request: { requestId: randomUUID(), context: { projectId: project.id, groupId: null, activeSessionId: parent.id, placement: 'child' }, kind: 'zcode', presetId: null } });
    assert.equal(session.kind, 'zcode'); assert.equal(session.parentSessionId, parent.id); assert.equal(session.engine, 'chat');
    sessions.push(session.id);
    if (!start) return session.id;
    await call('chat_start', { sessionId: session.id, fastMode: false });
    await until(() => call('chat_snapshot', { sessionId: session.id }), snapshot => snapshot.model === 'local-fixture/gpt-4o', '原生模型就绪');
    return session.id;
  };
  // 空白会话尚无 CLI 进程：必须先能选择模型，不能先发送消息才能解锁菜单。
  const cold = await create(false);
  const noLoginPlan = await call('chat_zcode_start_plan', { sessionId: cold });
  assert(noLoginPlan.plans.length > 0 && noLoginPlan.plans.every(plan => plan.status === 'not-authenticated'), '未登录时需给出明确的 Start Plan 状态');
  const coldModels = await call('chat_models', { sessionId: cold });
  assert(coldModels.some(model => model.id === 'local-fixture/gpt-4o-mini' && model.description.includes('Local fixture')), '首次启动前模型菜单必须显示原生模型和供应商');
  assert(!(await call('list_tree')).sessions.find(session => session.id === cold).agentSessionId, '目录查询不能绑定临时原生会话');
  const coldBrowserUI = await checkZcodeBrowser({ base, token, sessionName: (await call('list_tree')).sessions.find(session => session.id === cold).name, root, cold: true });
  assert.equal(generationRequests, 0, '打开空白模型菜单不能触发模型生成');
  await call('chat_set_model', { sessionId: cold, model: 'local-fixture/gpt-4o-mini' });
  await call('chat_start', { sessionId: cold, fastMode: false });
  await until(() => call('chat_snapshot', { sessionId: cold }), snapshot => snapshot.model === 'local-fixture/gpt-4o-mini', '首次启动应用预选模型');
  const coldNative = (await call('list_tree')).sessions.find(session => session.id === cold).agentSessionId;
  await call('chat_stop', { sessionId: cold });
  assert((await call('chat_models', { sessionId: cold })).some(model => model.id === 'local-fixture/gpt-4o-mini'), '停止后已有会话仍须提供模型菜单');
  assert.equal((await call('list_tree')).sessions.find(session => session.id === cold).agentSessionId, coldNative, '查询不能改写已保存的原生会话 ID');
  const finished = sessionId => until(() => call('chat_snapshot', { sessionId }), snapshot => !snapshot.turnStartedAt && snapshot.rows.some(row => row.kind === 'assistant' && !row.streaming), '原生回合结束');
  const [alpha, beta] = await Promise.all([create(), create()]);
  await Promise.all([call('chat_send', { sessionId: alpha, text: 'ALPHA' }), call('chat_send', { sessionId: beta, text: 'BETA' })]);
  const answers = await Promise.all([finished(alpha), finished(beta)]);
  assert(answers[0].rows.some(row => row.kind === 'assistant' && row.text === 'ALPHA_RESULT'));
  assert(!JSON.stringify(answers[0].rows).includes('BETA_RESULT'));
  assert(answers[1].rows.some(row => row.kind === 'assistant' && row.text === 'BETA_RESULT'));
  const before = (await call('list_tree')).sessions.find(session => session.id === alpha).agentSessionId;
  assert(before?.startsWith('sess_'));
  const catalogue = await call('chat_models', { sessionId: alpha });
  assert(JSON.stringify(catalogue).includes('local-fixture/gpt-4o'));
  assert(catalogue.every(model => typeof model.description === 'string'), '模型目录的说明必须为字符串，避免聊天界面 startsWith 崩溃');
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
  const tree = await call('list_tree');
  const browserUI = await checkZcodeBrowser({ base, token, sessionName: tree.sessions.find(session => session.id === alpha).name, root });
  const loginHelper = spawn(bin, ['login', 'bigmodel', 'start-plan', '--no-browser', '--json'], { cwd: workspace,
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, USERPROFILE: profile,
      ZCODE_DATA_BASE_DIR: nativeRoot, ZCODE_ENDPOINT_ORIGIN: `http://127.0.0.1:${modelServer.address().port}` } });
  loginHelper.stdout.resume();
  assert.equal(await new Promise((resolve, reject) => { const timer = setTimeout(() => { loginHelper.kill(); reject(Error('Start Plan 登录夹具超时')); }, 45000);
    loginHelper.on('error', reject); loginHelper.once('exit', code => { clearTimeout(timer); resolve(code); }); }), 0, '只有 Start Plan 时也必须通过原生 CLI 登录');
  const startPlan = await create(false);
  const pendingPlan = await call('chat_zcode_start_plan', { sessionId: startPlan });
  assert(pendingPlan.plans.some(plan => plan.status === 'pending' && plan.plans.some(item => item.name === 'ZCode Global Build')));
  assert(!(await call('chat_models', { sessionId: startPlan })).some(model => model.id.includes('start-plan/')));
  const startPlanBrowserUI = await checkZcodeBrowser({ base, token, sessionName: (await call('list_tree')).sessions.find(session => session.id === startPlan).name,
    root, cold: true, startPlanFixture: { activate: () => { startPlanPhase = 'available'; } } });
  startPlanPhase = 'available';
  await call('chat_zcode_start_plan', { sessionId: startPlan });
  const planModels = await call('chat_models', { sessionId: startPlan });
  const planModel = 'account:bigmodel-start-plan/GLM-5.3-Flash';
  assert(planModels.some(model => model.id === planModel && model.description.includes('Start Plan')));
  if (!startPlanBrowserUI) {
    await call('chat_set_model', { sessionId: startPlan, model: planModel });
    await call('chat_start', { sessionId: startPlan, fastMode: false });
    await until(() => call('chat_snapshot', { sessionId: startPlan }), snapshot => snapshot.model === planModel, 'Start Plan 模型就绪');
    await call('chat_send', { sessionId: startPlan, text: 'START_PLAN_TEST' });
    assert((await finished(startPlan)).rows.some(row => row.kind === 'assistant' && row.text === 'START_PLAN_OK'));
  }
  const usedPlan = await call('chat_zcode_start_plan', { sessionId: startPlan });
  assert.equal(usedPlan.plans.find(plan => plan.providerId === 'account:bigmodel-start-plan').balances[0].available, 75);
  assert.equal(startPlanRequests, 1); assert.equal(unexpectedAccountRequests, 0, '不能兑换个人 Coding Plan 的 Token 或 Key');
  startPlanRemaining = 0;
  const exhausted = await call('chat_zcode_start_plan', { sessionId: startPlan });
  assert.equal(exhausted.plans.find(plan => plan.providerId === 'account:bigmodel-start-plan').status, 'unavailable');
  assert(!(await call('chat_models', { sessionId: startPlan })).some(model => model.id === planModel), '额度耗尽后运行中的目录也必须移除模型');
  const generationBeforeExhaustedSend = generationRequests;
  await call('chat_send', { sessionId: startPlan, text: 'EXHAUSTED_START_PLAN' }).catch(() => {});
  await delay(1500);
  assert.equal(startPlanRequests, 1); assert.equal(generationRequests, generationBeforeExhaustedSend, '额度耗尽不能自动回退到第三方模型');
  const result = { appVersion: expectedVersion, coldModelCatalogue: true, coldModelSelection: true, stoppedModelCatalogue: true, coldBrowserUI, nativeConcurrentSessions: true, nativeResume: true, offlineHistory: true, permissionDenial: true, permissionReannouncement: true, pendingInteractionCancellation: true, writeToolAndArguments: true, planApproval: true, interrupt: true, browserUI, startPlanBrowserUI, startPlanPending: true, startPlanJwtRequest: true, startPlanQuotaUpdated: true, startPlanNoFallback: true, zcodeGuiUsed: false, productionAccountAuthorization: false };
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
