// 主动开口闸门（P0）单测：安静时段 / 冷场退避 / 当日封口。
// 跑法：node scripts/test-outreach-gate.mjs
import assert from 'node:assert/strict';
import {
  effectiveUnanswered, markProactiveFired, outreachGate, proactiveBackoff, outreachWindow,
} from '../src/outreach-gate.js';

const HOUR = 60 * 60 * 1000;
const at = (h, m = 0) => new Date(2026, 10, 2, h, m, 0, 0).getTime();
const CONFIG = { quietStart: '00:30', quietEnd: '08:00', unansweredSoftLimit: 3, unansweredStopLimit: 5 };

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
function fresh(extra = {}) {
  return {
    lastProactiveAt: 0,
    lastIncomingAt: 0,
    lastAiReplyAt: 0,
    proactiveUnanswered: 0,
    proactiveDayKey: '',
    proactiveDayCount: 0,
    ...extra,
  };
}
// 模拟「她真的开口了」：唤醒之后她发了一条消息。
function fire(st, now) {
  const n = markProactiveFired(st, now);
  st.lastAiReplyAt = now;
  return n;
}

test('窗口缺省值', () => {
  assert.deepEqual(outreachWindow({}), { quietStart: '00:30', quietEnd: '08:00' });
  assert.deepEqual(outreachWindow({ quietStart: '23:00', quietEnd: '07:00' }), { quietStart: '23:00', quietEnd: '07:00' });
});

test('安静时段内不出声，retryAt 落在 08:00~08:20', () => {
  const st = fresh();
  const now = at(3, 0);
  const gate = outreachGate(st, { now, config: CONFIG });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'quiet');
  assert.ok(gate.retryAt >= at(8, 0) && gate.retryAt <= at(8, 20) + 60 * 1000, `retryAt=${new Date(gate.retryAt).toTimeString()}`);
});

test('干净状态放行，系数 1', () => {
  const gate = outreachGate(fresh(), { now: at(15, 0), config: CONFIG });
  assert.equal(gate.ok, true);
  assert.equal(gate.mult, 1);
  assert.equal(gate.n, 0);
});

test('第一次没人接：下次系数 ×0.6', () => {
  const st = fresh();
  fire(st, at(15, 0));
  assert.equal(effectiveUnanswered(st), 1);
  const gate = outreachGate(st, { now: at(16, 0), config: CONFIG });
  assert.equal(gate.ok, true);
  assert.equal(gate.mult, 0.6);
});

test('有人说话 → 冷场链条断掉', () => {
  const st = fresh();
  fire(st, at(15, 0));
  st.lastIncomingAt = at(15, 5); // 群里有人接话了
  assert.equal(effectiveUnanswered(st), 0);
  const gate = outreachGate(st, { now: at(16, 0), config: CONFIG });
  assert.equal(gate.ok, true);
  assert.equal(gate.mult, 1);
  assert.equal(gate.n, 0);
});

test('唤醒了但她自己没开口 → 不算主动过', () => {
  const st = fresh({ lastProactiveAt: at(15, 0), proactiveUnanswered: 2, lastAiReplyAt: at(14, 0) });
  assert.equal(effectiveUnanswered(st), 0);
});

test('第三次之后当天只剩一次（dailyCap 1）', () => {
  const st = fresh();
  fire(st, at(9, 0));
  fire(st, at(10, 0));
  fire(st, at(11, 0));
  assert.equal(effectiveUnanswered(st), 3);
  const gate = outreachGate(st, { now: at(12, 0), config: CONFIG });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'unanswered-daily');
  assert.equal(gate.retryAt, at(8, 0) + 24 * HOUR);
});

test('第二天重置当日额度，但冷场次数继续累计；到 5 次当天封口', () => {
  const st = fresh();
  for (const h of [9, 10, 11]) fire(st, at(h, 0));
  // 次日：额度重置
  const day2 = at(9, 0) + 24 * HOUR;
  const g2 = outreachGate(st, { now: day2, config: CONFIG });
  assert.equal(g2.ok, true, `expected ok, got ${g2.reason}`);
  assert.equal(g2.mult, 0.5);
  fire(st, day2);            // n=4
  assert.equal(effectiveUnanswered(st), 4);
  // 同一天再判：dailyCap 1 已用完
  assert.equal(outreachGate(st, { now: day2 + HOUR, config: CONFIG }).reason, 'unanswered-daily');
  // 模拟又一次开口到 5 次（跨到下一天绕开 dailyCap）
  const day3 = day2 + 24 * HOUR;
  assert.equal(outreachGate(st, { now: day3, config: CONFIG }).ok, true);
  fire(st, day3);            // n=5
  assert.equal(effectiveUnanswered(st), 5);
  const g = outreachGate(st, { now: day3 + 2 * HOUR, config: CONFIG });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'unanswered-stop');
  assert.equal(g.retryAt, at(8, 0) + 3 * 24 * HOUR);
});

test('退避可关闭（两个上限都设 0）', () => {
  const st = fresh({ lastProactiveAt: at(9, 0), proactiveUnanswered: 9, lastAiReplyAt: at(9, 0) });
  const cfg = { ...CONFIG, unansweredSoftLimit: 0, unansweredStopLimit: 0 };
  assert.deepEqual(proactiveBackoff(st, cfg).mult, 1);
  assert.equal(outreachGate(st, { now: at(10, 0), config: cfg }).ok, true);
});

test('非法的 quietStart=quietEnd 视为不启用安静时段', () => {
  const cfg = { ...CONFIG, quietStart: '08:00', quietEnd: '08:00' };
  assert.equal(outreachGate(fresh(), { now: at(3, 0), config: cfg }).ok, true);
});

console.log(`\n${passed} 项全部通过`);
