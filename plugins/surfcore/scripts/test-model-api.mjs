/**
 * /model 代理的端到端回归（临时目录 + 假桥接，不碰真实配置）。
 *
 * 为什么需要它：设置页的「DSH 模型」卡不直接写 config.json，而是 POST 到插件的 /model，
 * 由插件转发给桥接的 /api/dsh/model —— 桥接那边才会写文件并热更新内存里的 cfg
 * （已经开着的 QQ 会话下一句消息重新绑定，不用重启桥接）。
 * 这里要盯住三件事：
 *   1) 转发的是同一个路径、带上 x-console-token、body 原样；
 *   2) 桥接的 400（模型/提供方不存在）要原样透出，前端才能显示「可选：…」；
 *   3) 桥接没在跑时给 200 + ok:false + 可操作提示，而不是 5xx —— 设置页要能说「先启动桥接」。
 *
 * 运行：node scripts/test-model-api.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ── 假桥接：只实现 /api/dsh/model，行为由 mode 控制 ────────────────────────
const seen = [];
let mode = 'ok';
const fakeBridge = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-console-token'], body: raw ? JSON.parse(raw) : null });
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url !== '/api/dsh/model') { reply(404, { ok: false, error: 'not found' }); return; }
    if (mode === '400') { reply(400, { ok: false, error: 'DSH 里没有「nope」这个提供方；可选：deepseek-account、fox-api-deepseek' }); return; }
    if (mode === '500') { reply(500, { ok: false, error: 'boom' }); return; }
    if (req.method === 'GET') {
      reply(200, {
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        reasoningEffort: 'high',
        options: ['low', 'high', 'max'],
        providers: [
          { id: 'deepseek-account', name: 'deepseek-account', models: [{ id: 'deepseek-flash', name: 'deepseek-flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }] },
          { id: 'fox-api-deepseek', name: 'fox-api-deepseek', models: [{ id: 'deepseek-v4.1-flash-1017', name: 'deepseek-v4.1-flash-1017', efforts: [], defaultEffort: '' }] },
        ],
        catalogAvailable: true,
        globalSideEffect: true,
      });
      return;
    }
    reply(200, { ok: true, provider: 'fox-api-deepseek', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high', effortAdjusted: false, catalogChecked: true });
  });
});
await new Promise((resolve) => fakeBridge.listen(0, '127.0.0.1', resolve));
const bridgePort = fakeBridge.address().port;

// ── 临时 SURFCORE_ROOT：consolePort 指向假桥接 ─────────────────────────────
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-model-root-'));
const tempDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-model-dsh-'));
const tempState = path.join(tempDsh, 'surfcore');
fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'roles'), { recursive: true });
fs.mkdirSync(tempState, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'src', 'bridge.js'), '// fixture bridge placeholder\n');
fs.writeFileSync(path.join(tempRoot, 'roles', '角色.md'), '# 角色卡\n\n测试用。\n');
fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({
  ownerQQ: '10001',
  allow: { private: ['10001'], groups: [] },
  consolePort: bridgePort,
  consoleToken: 'fixture-console-token',
  dsh: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
}, null, 2));
fs.writeFileSync(path.join(tempState, 'config.json'), JSON.stringify({ version: 1 }, null, 2));

process.env.SURFCORE_ROOT = tempRoot;
process.env.DSH_HOME = tempDsh;
process.env.USERPROFILE = tempDsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';

const { apply } = await import('../lib/index.js');

const routes = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? { requestRejection: () => false } : null; },
  effect() { return () => {}; },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({}),
    prompt: async () => ({ accepted: true }),
  },
  settings: null,
};
apply(ctx);

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(method, p, body) {
  const route = routes.find((r) => r.path === '/dsh-surfcore/api');
  const res = fakeRes();
  await route.handler(fakeReq(method, `/dsh-surfcore/api${p}`, body), res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

try {
  // 1) GET：把桥接的目录原样透出（前端要用 providers[].models[].efforts 填下拉）。
  const got = await invoke('GET', '/model');
  assert.equal(got.status, 200);
  assert.equal(got.data.ok, true);
  assert.equal(got.data.running, true);
  assert.equal(got.data.provider, 'deepseek-account');
  assert.equal(got.data.providers.length, 2);
  assert.deepEqual(got.data.providers[1].models[0].efforts, [], '中转站模型没公布档位也要原样透出');
  assert.equal(seen.at(-1).url, '/api/dsh/model', '插件必须代理到桥接的 /api/dsh/model');
  assert.equal(seen.at(-1).token, 'fixture-console-token', '必须带 x-console-token，否则桥接 401');

  // 2) POST：body 原样转发，成功时把桥接的回复透出。
  const saved = await invoke('POST', '/model', { provider: 'fox-api-deepseek', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.model, 'deepseek-v4.1-flash-1017');
  assert.deepEqual(seen.at(-1).body, { provider: 'fox-api-deepseek', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high' });
  assert.equal(seen.at(-1).method, 'POST');

  // 3) 桥接的校验失败要原样透出（设置页靠它显示「可选：deepseek-account、…」）。
  mode = '400';
  const rejected = await invoke('POST', '/model', { provider: 'nope', model: 'nope' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.error, /没有「nope」这个提供方；可选：deepseek-account、fox-api-deepseek/);

  // 4) 桥接 5xx：插件给 502 + 可操作提示，别让设置页只看到一句 HTTP 500。
  mode = '500';
  const broken = await invoke('POST', '/model', { provider: 'fox-api-deepseek', model: 'deepseek-v4.1-flash-1017' });
  assert.equal(broken.status, 502);
  assert.ok(broken.data.hint, '桥接 5xx 时要给出下一步提示');

  // 5) 桥接没在跑：200 + ok:false + hint（设置页要能显示「先启动桥接」）。
  await new Promise((resolve) => fakeBridge.close(resolve));
  const down = await invoke('GET', '/model');
  assert.equal(down.status, 200);
  assert.equal(down.data.ok, false);
  assert.equal(down.data.running, false);
  assert.equal(down.data.hint, '先启动 QQ 桥接，再回来切换模型。');

  // 6) 只支持 GET / POST（非 GET 必须带 JSON 头，否则先被写入守卫拦成 415）。
  const nope = await invoke('DELETE', '/model', {});
  assert.equal(nope.status, 405);

  console.log('model api tests OK');
} finally {
  try { fakeBridge.close(); } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(tempDsh, { recursive: true, force: true });
}
