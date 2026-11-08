// 关系系统（src/favor.js）的离线单测。
// v2 覆盖：配置归一化 / 好感分档 / 打分信号 / 每小时限额 / 上下限 / 衰减（好感回归 + 亲密软顶）/
//         亲密信号（深度才涨、每轮 +2、每天 +8、冲突负向）/ 阶段（阈值 + 亲密门槛 + 迟滞 + 7 天降档）/
//         v1→v2 迁移与基线自愈 / prompt 块 / 手动调整 / 文件名安全。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyDelta, decay, emptyStore, favorFileName, levelOf, normalizeFavorConfig, normalizeStore,
  observeMessage, promptBlock, resolveStage, snapshot, stageOf,
} from '../src/favor.js';

const CFG = normalizeFavorConfig({});
const AT = Date.parse('2026-11-02T10:00:00+08:00');
const DAY = 86400000;

function person(over = {}) {
  return {
    userId: '10001', name: '小明', score: 50, intimacy: 0, stage: 'stranger', stageSince: AT,
    stagePeak: 'stranger', stageLowSince: 0, composite: 0, deepStreak: 0,
    deepDays: { last: '', streak: 0 }, dayBudget: { date: '', intimacy: 0 },
    firstAt: AT, lastAt: AT, lastDeltaAt: 0, hourBucket: { at: 0, n: 0 }, events: [],
    ...over,
  };
}

test('配置归一化：缺省值可用，越界值被钳住', () => {
  assert.equal(CFG.enabled, true);
  assert.equal(CFG.start, 50);
  assert.equal(CFG.perMessage, 0.15);
  assert.equal(CFG.intimacy, true);
  assert.equal(CFG.intimacyDayCap, 8);
  assert.equal(CFG.intimacySoftCap, 60);
  assert.equal(CFG.intimacyDecayPerDay, 0.2);
  assert.equal(CFG.downHysteresis, 5);
  assert.equal(CFG.downgradeDays, 7);
  const wild = normalizeFavorConfig({
    start: 999, perMessage: -3, maxPerHour: 0, promptTop: 99, decayPerDay: -1,
    intimacyDayCap: 999, downHysteresis: -2, downgradeDays: 0,
  });
  assert.equal(wild.start, 100);
  assert.equal(wild.perMessage, 0);
  assert.equal(wild.maxPerHour, 1);
  assert.equal(wild.promptTop, 20);
  assert.equal(wild.decayPerDay, 0);
  assert.equal(wild.intimacyDayCap, 100);
  assert.equal(wild.downHysteresis, 0);
  assert.equal(wild.downgradeDays, 1);
  assert.equal(normalizeFavorConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeFavorConfig({ intimacy: false }).intimacy, false);
});

test('分档：边界值落在正确档位上', () => {
  assert.equal(levelOf(100).label, '很亲近');
  assert.equal(levelOf(85).label, '很亲近');
  assert.equal(levelOf(84.9).label, '亲近');
  assert.equal(levelOf(75).label, '亲近');
  assert.equal(levelOf(60).label, '熟悉');
  assert.equal(levelOf(40).label, '普通');
  assert.equal(levelOf(25).label, '生疏');
  assert.equal(levelOf(10).label, '冷淡');
  assert.equal(levelOf(9.9).label, '敌意');
  assert.equal(levelOf(-50).label, '敌意');
});

test('打分：普通消息小涨，示好/冲突/直接找你的权重大', () => {
  const store = emptyStore('鲸鱼');
  const plain = observeMessage(store, { userId: '10001', name: '小明', text: '今天天气不错', at: AT, cfg: CFG });
  assert.equal(plain.delta, 0.2); // 0.15 在场，四舍五入到 0.2
  const before = store.people['10001'].score;
  const warm = observeMessage(store, { userId: '10001', name: '小明', text: '谢谢你，真靠谱', at: AT + 1000, cfg: CFG });
  assert.ok(warm.delta >= 1.5);
  assert.ok(store.people['10001'].score > before);
  const mid = store.people['10001'].score;
  const cold = observeMessage(store, { userId: '10001', name: '小明', text: '滚，闭嘴', at: AT + 2000, cfg: CFG });
  assert.ok(cold.delta < 0, '骂人时净变化必须是负的');
  assert.ok(cold.delta <= -2.5, `冲突要压过「在场」的 +0.15，实际 ${cold.delta}`);
  assert.ok(store.people['10001'].score < mid);
  const direct = observeMessage(store, { userId: '10002', name: '阿伟', text: '在吗', at: AT, direct: true, cfg: CFG });
  assert.ok(direct.delta >= 0.5 + 0.15);
});

test('打分：同一人每小时最多计 maxPerHour 条「在场」，防刷屏', () => {
  const store = emptyStore();
  const conf = normalizeFavorConfig({ maxPerHour: 3, warmDelta: 0, coldDelta: 0 });
  for (let i = 0; i < 10; i += 1) {
    observeMessage(store, { userId: '20001', name: '刷屏哥', text: '水', at: AT + i * 1000, cfg: conf });
  }
  assert.ok(Math.abs(store.people['20001'].score - 50.45) <= 0.2, `实际 ${store.people['20001'].score}`);
  const afterReset = store.people['20001'].score;
  observeMessage(store, { userId: '20001', name: '刷屏哥', text: '水', at: AT + 3600000 + 1000, cfg: conf });
  assert.ok(store.people['20001'].score > afterReset, '新的一小时应该重新计分');
});

test('打分：分数被钳在 0–100，敌意不会变负数', () => {
  const store = emptyStore();
  for (let i = 0; i < 40; i += 1) {
    observeMessage(store, { userId: '30001', name: '黑子', text: '去死', at: AT + i * 60000, cfg: CFG });
  }
  assert.equal(store.people['30001'].score, 0);
  for (let i = 0; i < 60; i += 1) {
    applyDelta(store, { userId: '30001', delta: 10, at: AT });
  }
  assert.equal(store.people['30001'].score, 100);
});

test('衰减：好感朝 50 回归，且每天最多一次', () => {
  const store = emptyStore();
  store.people['40001'] = person({ userId: '40001', name: 'A', score: 80 });
  store.people['40002'] = person({ userId: '40002', name: 'B', score: 20 });
  const changed = decay(store, { now: AT + 3600000, cfg: normalizeFavorConfig({ decayPerDay: 2 }) });
  assert.equal(changed, 0, '不满一天不该衰减');
  decay(store, { now: AT + DAY, cfg: normalizeFavorConfig({ decayPerDay: 2 }) });
  assert.equal(store.people['40001'].score, 78);
  assert.equal(store.people['40002'].score, 22);
  decay(store, { now: AT + 3600000, cfg: normalizeFavorConfig({ decayPerDay: 2 }) });
  assert.equal(store.people['40001'].score, 78);
});

test('衰减：亲密过软顶才回落，没过就不动（不是失忆）', () => {
  const store = emptyStore();
  store.people['41001'] = person({ userId: '41001', score: 60, intimacy: 80 });
  store.people['41002'] = person({ userId: '41002', score: 60, intimacy: 55 });
  decay(store, { now: AT + 10 * DAY, cfg: normalizeFavorConfig({ decayPerDay: 0 }) });
  // 80 → 只回落到软顶 60（每天 0.2 × 10 天 = 2，但上限是"降到软顶"）
  assert.equal(store.people['41001'].intimacy, 78);
  assert.equal(store.people['41002'].intimacy, 55, '没过软顶亲密不衰减');
});

test('亲密：只在深度互动时涨，每轮 +2 封顶', () => {
  const store = emptyStore();
  // 一条消息里同时有共同约定 + 道歉 + 长文本，也最多 +2
  const r = observeMessage(store, {
    userId: '42001', name: 'A', text: '对不起，是我不好，以后下次一起见面我请你吃饭，别生气了，真的', at: AT, cfg: CFG,
  });
  assert.equal(r.intimacyDelta, 2, `实际 ${r.intimacyDelta}`);
  assert.equal(store.people['42001'].intimacy, 2);
  // 单纯刷屏不涨亲密
  const store2 = emptyStore();
  for (let i = 0; i < 5; i += 1) {
    observeMessage(store2, { userId: '42002', name: 'B', text: '在吗', at: AT + i * 60000, cfg: CFG });
  }
  assert.equal(store2.people['42002'].intimacy, 1, '连续 3 条只算一次「聊得连续」');
});

test('亲密：每天最多 intimacyDayCap，冲突是负向且不受额度限制', () => {
  const store = emptyStore();
  for (let i = 0; i < 20; i += 1) {
    observeMessage(store, {
      userId: '43001', name: 'C', text: '今天真的谢谢你，我特别特别开心，真的特别开心，谢谢你陪我这么久，以后也要一直这样好不好呀', at: AT + i * 20000, cfg: CFG,
    });
  }
  assert.equal(store.people['43001'].intimacy, 8, `日上限 8，实际 ${store.people['43001'].intimacy}`);
  const r = observeMessage(store, { userId: '43001', text: '滚，闭嘴', at: AT + 1000 * 1000, cfg: CFG });
  assert.ok(r.intimacyDelta < 0);
  assert.ok(store.people['43001'].intimacy < 8);
});

test('亲密：关掉 intimacy 就退回 v1（只记好感）', () => {
  const store = emptyStore();
  const conf = normalizeFavorConfig({ intimacy: false });
  observeMessage(store, { userId: '44001', text: '对不起，以后一起吃饭', at: AT, cfg: conf });
  assert.equal(store.people['44001'].intimacy, 0);
});

test('阶段：探针定带、按档称重，高好感低亲密升不上去（亲密门槛）', () => {
  const high = person({ score: 90, intimacy: 10 });
  const info = resolveStage(high, { cfg: CFG, now: AT });
  assert.equal(info.index, 2, '探针 0.6*90+0.4*10 = 58，落在亲近带');
  assert.equal(info.bandKey, 'close', '探针所在的带是「想去的地方」');
  assert.equal(info.key, 'stranger', '实际结算的档位还是生疏');
  assert.notEqual(info.label, '亲近', '标签不许把没到的档位写出来');
  assert.ok(info.composite < 55, `称重后 composite ${info.composite} 不该过 55`);
  const store = emptyStore();
  store.people['45001'] = high;
  const result = observeMessage(store, { userId: '45001', text: '嗯', at: AT + 1000, cfg: CFG });
  assert.equal(store.people['45001'].stage, 'stranger', '亲密只有 10，过不了门槛，阶段不动');
  assert.equal(result.gated, true);
  assert.equal(store.people['45001'].stagePeak, 'stranger');
});

test('阶段：阈值和亲密同时够了才升级，stagePeak 记住到过哪里', () => {
  const store = emptyStore();
  store.people['46001'] = person({ userId: '46001', score: 80, intimacy: 45 });
  observeMessage(store, { userId: '46001', text: '嗯', at: AT + 1000, cfg: CFG });
  assert.equal(store.people['46001'].stage, 'close');
  assert.equal(store.people['46001'].stagePeak, 'close');
  const info = resolveStage(store.people['46001'], { cfg: CFG, now: AT });
  assert.equal(info.label, '亲近');
  assert.equal(stageOf('close').gate, 40);
});

test('阶段：掉档要连续 7 天低于「阈值−迟滞」，且只降一档、stagePeak 不回退', () => {
  const store = emptyStore();
  store.people['47001'] = person({
    userId: '47001', score: 32, intimacy: 12, stage: 'close', stagePeak: 'close',
  });
  const conf = normalizeFavorConfig({ decayPerDay: 0 });
  let r = observeMessage(store, { userId: '47001', text: '嗯', at: AT + 1000, cfg: conf });
  assert.equal(store.people['47001'].stage, 'close', '第一天只挂起，不降');
  assert.ok(store.people['47001'].stageLowSince > 0);
  observeMessage(store, { userId: '47001', text: '嗯', at: AT + 6 * DAY, cfg: conf });
  assert.equal(store.people['47001'].stage, 'close', '第 6 天还不够 7 天');
  r = observeMessage(store, { userId: '47001', text: '嗯', at: AT + 8 * DAY, cfg: conf });
  assert.equal(store.people['47001'].stage, 'familiar', '满 7 天降一档');
  assert.equal(store.people['47001'].stagePeak, 'close', '到过的档位不丢');
  assert.equal(r.gated, false);
});

test('迁移：v1 只有 score/events 的库，估出亲密、补出阶段，版本升到 2', () => {
  const store = normalizeStore({
    version: 1,
    role: '鲸鱼',
    people: {
      48001: { score: 72, name: '老用户', firstAt: AT - 30 * DAY, lastAt: AT, events: [{ at: AT, delta: 2, why: '示好' }] },
    },
  }, { now: AT });
  assert.equal(store.version, 2);
  const p = store.people['48001'];
  assert.ok(p.intimacy > 0, '老用户按聊天量估出一个正数，不凭空给 0');
  assert.ok(p.intimacy <= 40);
  assert.ok(['stranger', 'familiar', 'close', 'bond'].includes(p.stage));
  assert.ok(Number.isFinite(p.composite));
});

test('自愈：存档说"亲近"但分数早就掉了，也按存档信任，不把人打回刚认识', () => {
  const store = normalizeStore({
    people: { 49001: { score: 10, intimacy: 5, stage: 'close', stagePeak: 'close' } },
  }, { now: AT });
  const p = store.people['49001'];
  assert.equal(p.stage, 'close');
  assert.equal(p.stagePeak, 'close');
  // 乱码阶段不算数，回落到合法档
  const store2 = normalizeStore({ people: { 49002: { score: 60, stage: '<script>', stagePeak: '??' } } }, { now: AT });
  assert.ok(['stranger', 'familiar', 'close', 'bond'].includes(store2.people['49002'].stage));
});

test('prompt 块：跳过刚认识的人，按 composite 排序，带阶段与认识时长', () => {
  const store = emptyStore();
  store.people['50001'] = person({ userId: '50001', name: '小明', score: 88, intimacy: 55, stage: 'close', stagePeak: 'close', firstAt: AT - 90 * DAY });
  store.people['50002'] = person({ userId: '50002', name: '路人', score: 50, intimacy: 0 });
  store.people['50003'] = person({ userId: '50003', name: '阿伟', score: 12, intimacy: 3 });
  const block = promptBlock(store, {
    people: [{ userId: '50001', name: '小明' }, { userId: '50002', name: '路人' }, { userId: '50003', name: '阿伟' }],
    cfg: CFG,
    now: AT,
  });
  assert.match(block, /【关系】/);
  assert.match(block, /小明 88\/55（亲近 · 认识很久）/);
  assert.match(block, /阿伟 12\/3（生疏/);
  assert.ok(!block.includes('路人'), '50 分（刚认识）不该出现在 prompt 里');
  assert.ok(block.indexOf('小明') < block.indexOf('阿伟'), 'composite 高的排前面');
  assert.match(block, /记得对方说过的细节/);
  assert.equal(promptBlock(store, { people: [{ userId: '50001', name: '小明' }], cfg: normalizeFavorConfig({ enabled: false }) }), '');
  assert.equal(promptBlock(emptyStore(), { people: [{ userId: '99999', name: 'x' }], cfg: CFG }), '');
});

test('手动调整：合法 id 生效并留痕，非法 id 报可行动的错误', () => {
  const store = emptyStore();
  const ok = applyDelta(store, { userId: '60001', name: '小明', delta: 12.5, at: AT });
  assert.equal(ok.ok, true);
  assert.equal(ok.after, 62.5);
  assert.equal(store.people['60001'].events.at(-1).why, '手动调整');
  const bad = applyDelta(store, { userId: 'not-a-qq', delta: 5, at: AT });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'FAVOR_USER_ID');
  assert.ok(bad.error);
  assert.ok(bad.hint);
});

test('存盘归一化：坏数据救得回来，非法 id 丢弃', () => {
  const store = normalizeStore({
    version: 1,
    role: '鲸鱼',
    people: {
      70001: { score: 999, name: 'A', events: [{ at: AT, delta: 3, why: '示好' }, { at: 'bad' }] },
      abc: { score: 10 },
      70002: { score: -5 },
    },
  }, { now: AT });
  assert.equal(store.people['70001'].score, 100);
  assert.equal(store.people['70001'].events.length, 1);
  assert.equal(store.people['70001'].events[0].axis, 'favor', 'v1 事件补上轴标记');
  assert.equal(store.people['70002'].score, 0);
  assert.equal(store.people.abc, undefined);
  assert.equal(Object.keys(normalizeStore(null, { now: AT }).people).length, 0);
});

test('快照：按 composite 降序，带亲密/阶段/最近事件', () => {
  const store = emptyStore();
  for (let i = 0; i < 5; i += 1) {
    applyDelta(store, { userId: `8000${i}`, name: `P${i}`, delta: i * 5, at: AT });
  }
  const snap = snapshot(store, { cfg: CFG, now: AT });
  assert.equal(snap.ok, true);
  assert.equal(snap.count, 5);
  assert.equal(snap.people[0].userId, '80004');
  assert.ok(Number.isFinite(snap.people[0].intimacy));
  assert.ok(snap.people[0].stageLabel);
  assert.ok(Array.isArray(snap.people[0].events));
});

test('文件名：角色名里的路径字符被替换，空名回落到 default', () => {
  assert.equal(favorFileName('鲸鱼'), '鲸鱼.json');
  assert.equal(favorFileName('a/b\\c:d'), 'a_b_c_d.json');
  assert.equal(favorFileName(''), 'default.json');
  assert.equal(favorFileName('...'), 'default.json');
});
