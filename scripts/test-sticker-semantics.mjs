// 表情语义层自检（纯函数，无网络/无文件写入）：
//   1. 编号分配：按 createdAt 稳定补号、保留已有号、不撞号；
//   2. 情绪识别：中文说法 → 情绪类别（含「别嘲笑」这种反向说法）；
//   3. 本地注意力编码：确定性、有区分度（相关 > 无关）、空文本为零向量；
//   4. 语境匹配：委屈/嘲讽/摸头/饿了 各能找到对的表情，无关话题不乱推；
//   5. 注入文本：编号 + 情绪 + 内容 + 发送工具名，且没有匹配时为空串；
//   6. 模块边界：没有网络/文件访问（聊天时同步调用，不能有 IO）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStickerMatchHint,
  clearStickerVectorCache,
  cosine,
  detectEmotions,
  encodeText,
  ensureStickerIndex,
  inferStickerMeta,
  normalizeEmotionKey,
  parseStickerNumber,
  rankStickers,
  tokenize
} from '../src/sticker-semantics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✅ ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.error(`  ❌ ${name}\n     ${error.message}`); }
}

// 与 state/stickers.json 对齐的 8 张（编号由 createdAt 顺序决定）
const FIXTURE = [
  { id: 'st-1', md5: 'AA6B', desc: '咪兔 me too', emotion: 'agree', emotionAlt: ['cute'], content: '猫和兔子贴在一起说 me too，软软地附和', keywords: ['me too', '附和', '贴贴'], createdAt: '2026-10-22T01:01:02.241Z' },
  { id: 'st-2', md5: '336E', desc: '无辜被抓包', emotion: 'surprise', emotionAlt: ['wronged'], content: '动漫女孩突然被抓包，一脸心虚又无辜', keywords: ['被抓包', '心虚'], createdAt: '2026-10-22T22:06:39.465Z' },
  { id: 'st-3', md5: '4727', desc: '杂鱼♡（小咪自己）', emotion: 'tease', emotionAlt: ['smug', 'cute'], content: '蓝发女仆半眯眼笑着喊杂鱼♡，欠揍又带点撒娇', keywords: ['杂鱼', '就这', '嘲讽'], createdAt: '2026-10-22T22:06:40.000Z' },
  { id: 'st-4', md5: '7CB9', desc: '办公室顶锅吃白饭（小咪自己）', emotion: 'tired', emotionAlt: ['hungry', 'speechless'], content: '顶着锅在办公室大口扒白饭，鼓着脸摆烂', keywords: ['顶锅', '干饭', '上班'], createdAt: '2026-10-22T22:06:41.000Z' },
  { id: 'st-5', md5: 'E2A6', desc: '小咪自己·抱着碗委屈', emotion: 'wronged', emotionAlt: ['hungry', 'sad'], content: '抱着空碗眼泪汪汪，委屈巴巴地要饭', keywords: ['委屈', '要饭', '饿了'], createdAt: '2026-10-22T22:06:42.000Z' },
  { id: 'st-6', md5: '4112', desc: '委屈鲸鱼娘·花token想的', emotion: 'wronged', emotionAlt: ['sad'], content: '哭着求你们别再嘲笑我的回复，这些是我花好多 token 想的', keywords: ['别嘲笑', 'token', '破防'], createdAt: '2026-10-22T22:06:43.000Z' },
  { id: 'st-7', md5: 'A27C', desc: '雪地抱着雪球的小咪', emotion: 'cute', emotionAlt: ['happy'], content: '雪地里抱着大雪球，脸红扑扑的软萌', keywords: ['雪球', '软萌'], createdAt: '2026-10-22T22:06:44.000Z' },
  { id: 'st-8', md5: '0DC1', desc: '被摸头的摸鱼小咪', emotion: 'happy', emotionAlt: ['cute', 'tired'], content: '被摸头舒服得眯眼笑，旁边写着摸鱼', keywords: ['摸头', '摸鱼'], createdAt: '2026-10-22T22:06:45.000Z' }
];

function fixture() {
  clearStickerVectorCache();
  return ensureStickerIndex(FIXTURE.map((e) => ({ ...e }))).entries;
}

console.log('## 编号');

test('按 createdAt 顺序补号，已有号保留，新号从最大号往后排', () => {
  const entries = [
    { id: 'b', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'a', createdAt: '2026-01-01T00:00:00Z', no: 9 },
    { id: 'c', createdAt: '2026-01-03T00:00:00Z' }
  ];
  const { entries: out, changed } = ensureStickerIndex(entries);
  const no = Object.fromEntries(out.map((e) => [e.id, e.no]));
  assert.equal(no.a, 9, '已有编号必须保留');
  assert.equal(no.b, 10, '不复用空号：从最大号 +1 开始');
  assert.equal(no.c, 11);
  assert.equal(changed, true);
});

test('空库从 1 开始连续编号', () => {
  const { entries: out } = ensureStickerIndex([
    { id: 'x', createdAt: '2026-02-02T00:00:00Z' },
    { id: 'y', createdAt: '2026-02-01T00:00:00Z' }
  ]);
  const no = Object.fromEntries(out.map((e) => [e.id, e.no]));
  assert.equal(no.y, 1);
  assert.equal(no.x, 2);
});

test('重复编号会重新分配，不撞号', () => {
  const entries = [
    { id: 'a', no: 3, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', no: 3, createdAt: '2026-01-02T00:00:00Z' }
  ];
  const { entries: out } = ensureStickerIndex(entries);
  assert.deepEqual(out.map((e) => e.no).sort(), [3, 4]);
});

test('二次调用不会再改任何东西（幂等）', () => {
  const first = ensureStickerIndex(FIXTURE.map((e) => ({ ...e }))).entries;
  const second = ensureStickerIndex(first);
  assert.equal(second.changed, false, '已经标注好的库不应再被改写');
});

test('系词「就是」不会被误判成赞同（曾经的 false positive）', () => {
  const meta = inferStickerMeta({ desc: '抱着碗的小女仆（就是 wo 自己），委屈巴巴' });
  assert.equal(meta.emotion, 'wronged');
  assert.ok(!meta.emotionAlt.includes('agree'), `实际 ${meta.emotionAlt.join(',')}`);
});

test('没有标注的表情会给安全的兜底值', () => {
  const meta = inferStickerMeta({ desc: '生气地摔笔' });
  assert.equal(meta.emotion, 'angry');
  assert.equal(meta.content, '生气地摔笔');
  assert.deepEqual(meta.keywords, [], '不自动编造关键词（双字噪声会污染匹配）');
  const empty = inferStickerMeta({});
  assert.equal(empty.emotion, 'neutral');
});

console.log('## 情绪识别');

test('「委屈/不是我干的」识别为委屈，权重最高', () => {
  const hits = detectEmotions('我好委屈啊，明明不是我干的，凭什么骂我');
  assert.equal(hits[0].key, 'wronged');
  assert.ok(hits[0].weight > 0.99);
});

test('「别嘲笑我的回复」按委屈算（长词优先于短词）', () => {
  const hits = detectEmotions('求求你们别再嘲笑我的回复了');
  assert.equal(hits[0].key, 'wronged');
  assert.ok(hits.some((h) => h.key === 'tease'), '嘲讽仍作为次级情绪保留');
});

test('「别再嘲笑」中间插字也要判委屈（只写「别嘲笑」会漏）', () => {
  for (const text of ['求求别再嘲笑我的回复了', '别去嘲笑人家了', '求你们别笑我了']) {
    const hits = detectEmotions(text);
    assert.equal(hits[0]?.key, 'wronged', text);
  }
});

test('「杂鱼就这」识别为嘲讽', () => {
  assert.equal(detectEmotions('杂鱼就这？')[0].key, 'tease');
});

test('普通问句不会被硬塞情绪', () => {
  const hits = detectEmotions('今天几号了');
  assert.equal(hits.length, 0);
});

test('中文标签可反向映射成 key', () => {
  assert.equal(normalizeEmotionKey('委屈'), 'wronged');
  assert.equal(normalizeEmotionKey('W R O N G'.toLowerCase()), '');
  assert.equal(normalizeEmotionKey('wronged'), 'wronged');
});

console.log('## 编码器');

test('同一句话两次编码完全一致（可复现）', () => {
  const a = encodeText('抱着碗委屈巴巴');
  const b = encodeText('抱着碗委屈巴巴');
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
});

test('相关文本的相似度高于无关文本', () => {
  const base = encodeText('抱着空碗眼泪汪汪委屈巴巴');
  const near = encodeText('委屈地抱着碗哭');
  const far = encodeText('在办公室大口吃白米饭');
  assert.ok(cosine(base, near) > cosine(base, far) + 0.1, `near=${cosine(base, near).toFixed(3)} far=${cosine(base, far).toFixed(3)}`);
});

test('空文本是零向量，不会匹配到任何东西', () => {
  const v = encodeText('');
  assert.equal(Math.hypot(...v), 0);
});

test('分词同时产出单字与双字（保住「饿」「累」这类短词）', () => {
  const tokens = tokenize('我饿了');
  assert.ok(tokens.includes('饿'));
  assert.ok(tokens.includes('饿了'));
});

console.log('## 语境匹配');

test('委屈语境优先推两张委屈表情', () => {
  const ranked = rankStickers(fixture(), '我好委屈啊，明明不是我干的，凭什么骂我', { topK: 3 });
  assert.ok(ranked.length >= 2, `实际 ${ranked.length} 条`);
  assert.deepEqual(ranked.slice(0, 2).map((r) => r.no).sort(), [5, 6]);
  assert.ok(ranked.every((r) => r.score <= 1 && r.score > 0));
});

test('嘲讽语境推杂鱼那张，且排第一', () => {
  const ranked = rankStickers(fixture(), '杂鱼你好菜啊，就这？', { topK: 3 });
  assert.equal(ranked[0]?.no, 3);
});

test('摸头语境推被摸头那张', () => {
  const ranked = rankStickers(fixture(), '被摸头了嘿嘿，好舒服', { topK: 3 });
  assert.equal(ranked[0]?.no, 8);
});

test('饿了语境推抱碗/顶锅（副情绪馋饿命中）', () => {
  const ranked = rankStickers(fixture(), '我饿了，有没有饭吃', { topK: 3 });
  const nos = ranked.map((r) => r.no);
  assert.ok(nos.includes(5) || nos.includes(4), `实际 ${nos.join(',')}`);
});

test('完全无关的话题不硬推（阈值生效）', () => {
  const ranked = rankStickers(fixture(), '今天基金又跌了三个点', { topK: 3 });
  assert.equal(ranked.length, 0);
});

test('刚发过的表情会被降权（避免每轮同一张）', () => {
  const entries = fixture();
  const now = Date.now();
  const before = rankStickers(entries, '我好委屈啊', { topK: 1, now })[0];
  assert.ok(before);
  const target = entries.find((e) => e.no === before.no);
  target.lastUsedAt = now - 1000;
  const after = rankStickers(entries, '我好委屈啊', { topK: 3, now });
  const punished = after.find((r) => r.no === before.no);
  assert.ok(!punished || punished.score < before.score, '刚发过的必须降分');
});

test('exclude 可以排除指定表情', () => {
  const entries = fixture();
  const ranked = rankStickers(entries, '我好委屈啊', { topK: 3, exclude: ['st-5', 'st-6'] });
  assert.ok(!ranked.some((r) => r.no === 5 || r.no === 6));
});

console.log('## 注入文本');

test('匹配提示包含编号、情绪、内容与发送工具', () => {
  const ranked = rankStickers(fixture(), '我好委屈啊，明明不是我干的', { topK: 2 });
  const hint = buildStickerMatchHint(ranked, { moods: ['委屈'] });
  assert.ok(hint.includes('#05') || hint.includes('#06'), hint);
  assert.ok(hint.includes('委屈'));
  assert.ok(hint.includes('qq_send_sticker'));
  assert.ok(hint.split('\n').length <= 5, '提示必须短，别占 token');
});

test('没有匹配时返回空串（不占 token）', () => {
  assert.equal(buildStickerMatchHint([], {}), '');
});

test('高分推荐用强措辞，低分保留保守措辞（模型会自我审查）', () => {
  const strong = buildStickerMatchHint([
    { no: 6, emotionLabel: '委屈', content: '哭着求你们别再嘲笑我的回复', score: 0.83 }
  ], {});
  assert.ok(strong.includes('0.83'), strong);
  assert.ok(strong.includes('很贴合'), '高分要说清「很贴合」');
  assert.ok(!strong.includes('真的贴合才发一张'), '高分不应再用「才发」这种保守话术');

  const weak = buildStickerMatchHint([
    { no: 5, emotionLabel: '委屈', content: '抱着空碗', score: 0.4 }
  ], {});
  // 2026-11-02：低分话术从「真的贴合才发一张」放宽成「情绪差不太多就可以发」
  // （用户反馈她发得太少，旧的保守措辞叠加模型自我审查，等于不发）。
  // 保留的约束是：低分不能出现「很贴合」这种强措辞。
  assert.ok(weak.includes('情绪差不太多就可以发一张'), weak);
  assert.ok(!weak.includes('很贴合'), '低分不能吹成「很贴合」');
});

console.log('## 编号引用');

test('#03 / 3 / 03号 都解析成 3', () => {
  for (const ref of ['#03', '3', '03号', ' #3 ']) assert.equal(parseStickerNumber(ref), 3, ref);
  assert.equal(parseStickerNumber('3760717363_0_0_0_AA6B'), 0, '长 id 不能被当成编号');
  assert.equal(parseStickerNumber('12345'), 0);
  assert.equal(parseStickerNumber(''), 0);
});

console.log('## 模块边界');

test('语义层没有网络/文件访问（聊天时同步调用）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'sticker-semantics.js'), 'utf8');
  for (const forbidden of ['fetch(', 'http.request', 'node:fs', "from 'fs'", 'readFileSync']) {
    assert.ok(!src.includes(forbidden), `sticker-semantics.js 不应包含 ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join('\n'));
  process.exit(1);
}
