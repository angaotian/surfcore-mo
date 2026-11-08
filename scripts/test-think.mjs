import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThinkBlock,
  normalizeThinkConfig,
  thinkSnapshot,
  thinkStyleOf,
} from '../src/think.js';

test('默认开、风格 auto、要点上限 3', () => {
  const c = normalizeThinkConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.style, 'auto');
  assert.equal(c.maxPoints, 3);
});

test('enabled=false 能关掉；非法风格回落到 auto；要点数钳在 2..5', () => {
  assert.equal(normalizeThinkConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeThinkConfig({ style: 'FANCY' }).style, 'auto');
  assert.equal(normalizeThinkConfig({ maxPoints: 99 }).maxPoints, 5);
  assert.equal(normalizeThinkConfig({ maxPoints: 0 }).maxPoints, 2);
  assert.equal(normalizeThinkConfig({ maxPoints: '4' }).maxPoints, 4);
  assert.equal(normalizeThinkConfig({ maxPoints: 'x' }).maxPoints, 3);
});

test('按人格卡判断风格：冷/毒舌 → dry，活泼/可爱 → chatty，其余 brief', () => {
  assert.equal(thinkStyleOf('她说话毒舌，惜字如金', 'auto'), 'dry');
  assert.equal(thinkStyleOf('活泼开朗，话多到停不下来', 'auto'), 'chatty');
  assert.equal(thinkStyleOf('一个普通的群友', 'auto'), 'brief');
  // 传空/未传 style 等于 auto：仍然按人格卡判断
  assert.equal(thinkStyleOf('活泼开朗', ''), 'chatty');
  assert.equal(thinkStyleOf('活泼开朗', undefined), 'chatty');
  // 显式配置优先于人格卡判断
  assert.equal(thinkStyleOf('活泼开朗', 'dry'), 'dry');
});

test('没有未读消息时不注入（主动搭话/收尾不白塞指令）', () => {
  assert.equal(buildThinkBlock({ cfg: undefined, unreadCount: 0 }), '');
  assert.equal(buildThinkBlock({ cfg: {}, unreadCount: -3 }), '');
});

test('关掉开关后不注入', () => {
  assert.equal(buildThinkBlock({ cfg: { enabled: false }, unreadCount: 4 }), '');
});

test('正常场景：带条数、三步、以空行结尾', () => {
  const s = buildThinkBlock({ cfg: {}, unreadCount: 5 });
  assert.ok(s.startsWith('【读法】这轮有 5 条新消息'));
  assert.ok(s.includes('① 逐条要点'));
  assert.ok(s.includes('② 总体判断'));
  assert.ok(s.includes('③ 未决问题'));
  assert.ok(s.includes('不要写进回复'));
  assert.ok(s.endsWith('\n\n'));
  // brief 风格只有三步
  assert.equal((s.match(/[①②③④]/g) || []).length, 3);
});

test('要点上限取 min(maxPoints, 实际条数)，且至少 1 条', () => {
  assert.ok(buildThinkBlock({ cfg: {}, unreadCount: 2 }).includes('最多记 2 条'));
  assert.ok(buildThinkBlock({ cfg: {}, unreadCount: 99 }).includes('最多记 3 条'));
  assert.ok(buildThinkBlock({ cfg: { maxPoints: 5 }, unreadCount: 1 }).includes('最多记 1 条'));
});

test('chatty / dry 各多一条第四条，风格句跟着变', () => {
  const chatty = buildThinkBlock({ cfg: { style: 'chatty' }, unreadCount: 3 });
  assert.ok(chatty.includes('④ 有没有现成的梗'));
  assert.ok(chatty.includes('接错人的梗'));
  const dry = buildThinkBlock({ cfg: { style: 'dry' }, unreadCount: 3 });
  assert.ok(dry.includes('④ 哪句最省字'));
  assert.ok(dry.includes('只说那句'));
});

test('人格卡传进来时自动选风格', () => {
  const s = buildThinkBlock({ cfg: {}, unreadCount: 2, personaText: '活泼可爱的小鲸鱼' });
  assert.ok(s.includes('④ 有没有现成的梗'));
});

test('快照给出配置值与解析后的风格', () => {
  const snap = thinkSnapshot({ style: 'auto' }, '毒舌但心软');
  assert.deepEqual(snap, { enabled: true, style: 'auto', resolvedStyle: 'dry', maxPoints: 3 });
});
