/**
 * 好感度设置页接口（/dsh-surfcore/api/favor）的端到端回归（临时目录，不碰真实配置）。
 *
 * 用户要的是「和小鲸鱼的关系会变」：帖子里的 EmotionAI Pro 那套好感度，
 * 在 SurfCore 里由桥接进程打分、设置页只读展示。这个测试盯三件事：
 *   1. GET /favor 真的读 state/favor/<角色>.json，按分数降序，档位标签对得上；
 *   2. 换角色读的是另一份文件（PITFALLS #29：不许继承上一个角色的关系值）；
 *   3. 文件不存在 / 开关关掉 / 想写 → 都要给出可行动的结果，而不是静默成功。
 *
 * 运行：node scripts/test-favor-api.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-favor-root-'));
const tempDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-favor-dsh-'));
const tempState = path.join(tempDsh, 'surfcore');
fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'roles'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'state', 'favor'), { recursive: true });
fs.mkdirSync(tempState, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'src', 'bridge.js'), '// fixture bridge placeholder\n');
fs.writeFileSync(path.join(tempRoot, 'roles', '角色.md'), '# 角色卡\n\n测试用。\n');
fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({
  ownerQQ: '10001',
  allow: { private: ['10001'], groups: ['767098733'] },
  consoleToken: 'fixture-console-token',
  favor: { enabled: true },
}, null, 2));
fs.writeFileSync(path.join(tempState, 'config.json'), JSON.stringify({ version: 1 }, null, 2));
fs.writeFileSync(path.join(tempRoot, 'state', 'current-role.json'), JSON.stringify({ role: '鲸鱼', mode: 'active' }, null, 2));
fs.writeFileSync(path.join(tempRoot, 'state', 'favor', '鲸鱼.json'), JSON.stringify({
  version: 1,
  role: '鲸鱼',
  updatedAt: Date.parse('2026-11-02T10:00:00+08:00'),
  people: {
    20001: { userId: '20001', name: '小明', score: 88, lastAt: Date.parse('2026-11-02T09:00:00+08:00'), events: [{ at: Date.parse('2026-11-02T09:00:00+08:00'), delta: 1.5, why: '示好', note: '谢谢你' }] },
    20002: { userId: '20002', name: '阿伟', score: 12, lastAt: Date.parse('2026-11-02T08:00:00+08:00'), events: [] },
    20003: { userId: '20003', name: '路人', score: 50, lastAt: 0, events: [] },
  },
}, null, 2));

process.env.SURFCORE_ROOT = tempRoot;
process.env.DSH_HOME = tempDsh;
process.env.USERPROFILE = tempDsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';

const { apply } = await import('../lib/index.js');

const routes = [];
const starts = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? { requestRejection: () => false } : null; },
  effect(fn) { starts.push(fn); return () => {}; },
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

const roleFile = path.join(tempRoot, 'state', 'current-role.json');
const favorDir = path.join(tempRoot, 'state', 'favor');

try {
  // 1) 正常读：按分数降序、档位对得上、带最近事件。
  const got = await invoke('GET', '/favor');
  assert.equal(got.status, 200);
  assert.equal(got.data.ok, true);
  assert.equal(got.data.enabled, true);
  assert.equal(got.data.role, '鲸鱼');
  assert.equal(got.data.exists, true);
  assert.equal(got.data.count, 3);
  assert.deepEqual(got.data.people.map((p) => p.userId), ['20001', '20003', '20002'], '必须按分数降序（88 / 50 / 12）');
  assert.equal(got.data.people[0].level, '很亲近');
  assert.equal(got.data.people[1].level, '普通');
  assert.equal(got.data.people[2].level, '冷淡');
  assert.equal(got.data.people[0].events[0].why, '示好');
  // v2：老文件没有 intimacy/composite 时也要给出一致的展示值（不写回文件）
  assert.equal(typeof got.data.intimacyEnabled, 'boolean');
  for (const p of got.data.people) {
    assert.equal(typeof p.intimacy, 'number', '每个人都要有亲密值（老文件补 0）');
    assert.ok(p.stageLabel, '每个人都要有阶段标签');
    assert.ok(Number.isFinite(p.composite) && p.composite >= 0 && p.composite <= 100, 'composite 必须是 0–100 的有限数');
  }
  assert.equal(got.data.people[0].nextGate, 20, '生疏的下一档是熟识（门槛 20）');
  assert.equal(got.data.people[0].events[0].axis, 'favor', 'v1 事件补上轴标记');

  // 2) 只读：POST 必须是明确的 405，不能假装成功。
  const post = await invoke('POST', '/favor', { action: 'add', delta: 5 });
  assert.equal(post.status, 405);
  assert.equal(post.data.code, 'FAVOR_READONLY');
  assert.ok(post.data.hint, '拒绝时要给可行动提示');

  // 3) 开关关掉：enabled=false，但数据仍然读得到（关掉不等于删数据）。
  const cfgFile = path.join(tempRoot, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.favor = { enabled: false };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const off = await invoke('GET', '/favor');
  assert.equal(off.data.enabled, false);
  assert.equal(off.data.count, 3);
  cfg.favor = { enabled: true };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

  // 4) 换角色：读另一份文件（空库），绝不继承鲸鱼的关系值。
  fs.writeFileSync(roleFile, JSON.stringify({ role: '另一个角色', mode: 'active' }, null, 2));
  const other = await invoke('GET', '/favor');
  assert.equal(other.data.role, '另一个角色');
  assert.equal(other.data.exists, false, '换角色后不该读到上一个角色的文件');
  assert.equal(other.data.count, 0);
  assert.equal(other.data.file, '另一个角色.json');

  // 5) 角色名里有路径字符：文件名被替换，不会跳出 favor 目录。
  fs.writeFileSync(roleFile, JSON.stringify({ role: '../evil/x', mode: 'active' }, null, 2));
  const weird = await invoke('GET', '/favor');
  assert.equal(weird.data.file, '_evil_x.json', '开头的点会被剥掉，保证落在 favor 目录内');
  assert.ok(fs.existsSync(favorDir), 'favor 目录仍在');

  // 6) 脏数据：坏 JSON 不该把设置页打挂。
  fs.writeFileSync(roleFile, JSON.stringify({ role: '鲸鱼', mode: 'active' }, null, 2));
  fs.writeFileSync(path.join(favorDir, '鲸鱼.json'), '{ this is not json');
  const broken = await invoke('GET', '/favor');
  assert.equal(broken.status, 200);
  assert.equal(broken.data.exists, false);
  assert.equal(broken.data.count, 0);

  console.log('✓ test-favor-api: 6 组断言全部通过');
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tempDsh, { recursive: true, force: true }); } catch {}
}
