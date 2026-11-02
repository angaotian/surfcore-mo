// 图片/表情链路 + 联网搜索的离线回归。
//
// 背景（真实故障，见 2026-10-17 的会话日志）：
//   1. QQ 表情包的 CDN（gxh.vip.qq.com / p.qpic.cn / multimedia.nt.qq.com.cn）同时有
//      AAAA/A 记录，而本机只有 IPv4 出口 —— 抢到 AAAA 的那次请求会一直等到 20s 超时，
//      于是「部分表情包发不出去 / 图片时好时坏」。修复在 safe-fetch 的地址故障切换。
//   2. 表情包字段（emoji_id/url/summary）以前被丢弃，get_image 对市场表情必然失败后
//      就没有任何兜底；现在保留字段、表情优先走 CDN、并支持用 emoji_id 推 CDN 地址。
//   3. 搜索以前是抓 Bing HTML（结果空/噪声大、部分 query 直接退化）；现在优先复用
//      DSH 同一路 DeepSeek 联网搜索，Bing RSS 仅作兜底。
//
// 本文件不访问网络：CDN 下载用注入的 safeFetchBuffer 桩，搜索只测纯函数与参数校验。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  anysearchSearch,
  bingSearch,
  clearSearchCache,
  deepseekSearch,
  loadSearchConfig,
  mapDeepSeekResponse,
  normalizeContentTypes,
  normalizeFreshness,
  parseAnysearchMarkdown,
  parseBingHtml,
  parseBingRss,
  readDshCredential,
  resolveAnysearchApiKey,
  resolveSearchApiKey,
  webSearch
} from '../src/web-search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 1×1 GIF / PNG / WebP（足够通过签名与尺寸解析）
const GIF = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
const WEBP_VP8X = (() => {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  // width-1 = 1919 (0x77f), height-1 = 1079 (0x437)，24 位小端
  buf[24] = 0x7f; buf[25] = 0x07; buf[26] = 0x00;
  buf[27] = 0x37; buf[28] = 0x04; buf[29] = 0x00;
  return buf;
})();

// ── 消息段 → 媒体元数据 ─────────────────────────────────────────────────────
await test('extractMediaFromSegments 保留表情包字段（image / mface / face）', async () => {
  const h = await bridgeHarness();
  try {
    const media = h.extractMediaFromSegments([
      {
        type: 'image',
        data: {
          file: 'f9-f96bf2d2d93c3530d5eb148f55206fb1.gif',
          url: 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif',
          summary: '[给你糖吃]',
          sub_type: 0,
          emoji_id: 'f96bf2d2d93c3530d5eb148f55206fb1',
          emoji_package_id: 242139,
          key: 'a39bbb09c7d85d41'
        }
      },
      {
        type: 'mface',
        data: { emoji_id: 'abcdef0123456789abcdef0123456789', url: 'https://gxh.vip.qq.com/x.gif', summary: '[动画表情]' }
      },
      { type: 'face', data: { id: '178', url: 'https://example.invalid/f.png', summary: 'doge' } },
      { type: 'text', data: { text: '普通文字' } }
    ]);
    assert.equal(media.length, 3);
    assert.equal(media[0].kind, 'image');
    assert.equal(media[0].emojiId, 'f96bf2d2d93c3530d5eb148f55206fb1', 'emoji_id 必须保留（否则失去 CDN 兜底）');
    assert.equal(media[0].emojiPackageId, '242139');
    assert.equal(media[0].emojiKey, 'a39bbb09c7d85d41');
    assert.equal(media[0].subType, '0');
    assert.equal(media[0].summary, '[给你糖吃]');
    assert.equal(media[1].kind, 'sticker', 'mface 必须被识别为表情包');
    assert.equal(media[1].emojiId, 'abcdef0123456789abcdef0123456789');
    assert.equal(media[1].subType, '1');
    assert.equal(media[2].kind, 'face');
    assert.equal(media[2].faceId, '178');
    assert.equal(media[2].url, 'https://example.invalid/f.png');

    assert.equal(await h.segmentsToText([{ type: 'mface', data: { summary: '给你糖吃' } }]), '[表情:给你糖吃]');
  } finally { await h.close(); }
});

// ── 表情包下载：CDN 优先、emoji_id 兜底、普通图片仍走 get_image ──────────────
await test('fetchOneBotImage 表情优先 CDN，普通图片优先 get_image', async () => {
  const fetched = [];
  const h = await bridgeHarness({
    globals: {
      safeFetchBuffer: async (url) => { fetched.push(String(url)); return { buffer: GIF, mimeType: 'image/gif' }; }
    }
  });
  try {
    // ① 表情（有 url）：不调用 get_image，直接抓 CDN
    const sticker = await h.fetchOneBotImage({
      kind: 'sticker',
      url: 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif'
    });
    assert.ok(sticker?.buffer?.length, '表情必须取到字节');
    assert.equal(sticker.mimeType, 'image/gif');
    assert.equal(fetched.at(-1), 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif');
    assert.equal(h.calls.images.length, 0, '表情有 URL 时不应先问网关 get_image（市场表情必然 not found）');

    // ② 表情（没有 url，只有 emoji_id）：按 emoji_id 推 CDN 地址兜底
    const byId = await h.fetchOneBotImage({
      kind: 'image',
      subType: '0',
      emojiId: 'f96bf2d2d93c3530d5eb148f55206fb1',
      file: 'f9-f96bf2d2d93c3530d5eb148f55206fb1.gif'
    });
    assert.ok(byId?.buffer?.length, '只有 emoji_id 时也要能取到');
    assert.equal(
      fetched.at(-1),
      'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif',
      '必须按 emoji_id 推出 CDN 地址'
    );

    // ②b 连 emoji_id 都没有、只有文件名：从 `<前两位>-<32 位 hex>.gif` 还原
    const byFile = await h.fetchOneBotImage({
      kind: 'image',
      subType: '0',
      file: 'f9-f96bf2d2d93c3530d5eb148f55206fb1.gif'
    });
    assert.ok(byFile?.buffer?.length, '只有文件名时也要能推出 CDN 地址');
    assert.equal(
      fetched.at(-1),
      'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif',
      '必须能从文件名还原 emoji_id'
    );

    // ③ 普通图片（有 file）：get_image 优先，不走 CDN
    const before = fetched.length;
    const image = await h.fetchOneBotImage({ kind: 'image', file: 'abc.jpg' });
    assert.ok(image?.buffer?.length);
    assert.deepEqual(h.calls.images, ['abc.jpg']);
    assert.equal(fetched.length, before, '普通图片不应额外抓 URL');
  } finally { await h.close(); }
});

await test('emojiCdnCandidates 只接受十六进制 id（防任意 URL 拼接）', async () => {
  const h = await bridgeHarness();
  try {
    const valid = h.emojiCdnCandidates('f96bf2d2d93c3530d5eb148f55206fb1');
    assert.equal(valid.length, 1);
    assert.equal(valid[0], 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif');
    for (const bad of ['', 'abc', '../../etc/passwd', 'f96bf2d2d93c3530d5eb148f55206fb1/../../x', '中文', null]) {
      assert.equal(h.emojiCdnCandidates(bad).length, 0, `非法 emoji_id 不得拼 URL：${bad}`);
    }
  } finally { await h.close(); }
});

await test('fetchMediaData 标注表情/图片，并保留 summary 与 emojiId', async () => {
  const h = await bridgeHarness({
    globals: {
      safeFetchBuffer: async (url) => {
        if (String(url).includes('gxh.vip.qq.com')) return { buffer: GIF, mimeType: 'image/gif' };
        throw new Error('网络不可用');
      }
    }
  });
  try {
    const out = await h.fetchMediaData([
      { kind: 'sticker', emojiId: 'f96bf2d2d93c3530d5eb148f55206fb1', summary: '[给你糖吃]' }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'sticker');
    assert.equal(out[0].summary, '[给你糖吃]');
    assert.equal(out[0].emojiId, 'f96bf2d2d93c3530d5eb148f55206fb1');
    assert.ok(out[0].data?.length, '应带 base64 图片数据');
    assert.equal(out[0].text, '');

    h.bot.getImage = async () => { throw new Error('image not found in cache'); };
    const failed = await h.fetchMediaData([{ kind: 'image', file: 'abc.jpg', url: 'https://multimedia.nt.qq.com.cn/x' }]);
    assert.equal(failed[0].kind, 'image');
    assert.match(String(failed[0].text), /图片获取失败/, '失败必须明确标注为图片');
  } finally { await h.close(); }
});

await test('getImageDimensions / acceptImageBuffer 覆盖 GIF 与 WebP，并拦截非图片', async () => {
  const h = await bridgeHarness();
  try {
    const gif = h.getImageDimensions(GIF);
    assert.equal(gif?.width, 1);
    assert.equal(gif?.height, 1);
    const webp = h.getImageDimensions(WEBP_VP8X);
    assert.equal(webp?.width, 1920);
    assert.equal(webp?.height, 1080);
    assert.ok(h.acceptImageBuffer(GIF, 'gif'), 'GIF 必须通过');
    assert.ok(h.acceptImageBuffer(WEBP_VP8X, 'webp'), 'WebP 必须通过');
    assert.equal(h.acceptImageBuffer(Buffer.from('not an image at all')), null, '非图片必须拒绝');
  } finally { await h.close(); }
});

// ── 搜索：配置 / 凭据 / 结果映射 / 解析 ─────────────────────────────────────
await test('loadSearchConfig 默认值与越界收敛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      webSearch: { provider: 'bing', maxResults: 99, maxUses: 9, timeoutMs: 1, apiKeyEnv: ' MY_KEY ' }
    }));
    const cfg = loadSearchConfig(dir);
    assert.equal(cfg.provider, 'bing');
    assert.equal(cfg.maxResults, 20, 'maxResults 上限 20');
    assert.equal(cfg.maxUses, 5, 'maxUses 上限 5');
    assert.equal(cfg.timeoutMs, 5000, 'timeoutMs 下限 5s');
    assert.equal(cfg.apiKeyEnv, 'MY_KEY');
    assert.equal(cfg.model, 'deepseek-v4-flash');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'nonsense' } }));
    assert.equal(loadSearchConfig(dir).provider, 'auto', '未知 provider 回退 auto');
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken json');
    assert.equal(loadSearchConfig(dir).provider, 'auto', '坏配置不得让搜索崩溃');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('resolveSearchApiKey 的优先级：config > env > DSH 凭据', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.QQ_TEST_SEARCH_KEY;
  try {
    fs.writeFileSync(path.join(home, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  QQ_TEST_SEARCH_KEY: sk-from-dsh-credentials',
      'records: {}',
      ''
    ].join('\n'));
    process.env.DSH_HOME = home;
    delete process.env.QQ_TEST_SEARCH_KEY;

    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }).source, 'dsh-credentials');
    assert.equal(readDshCredential('QQ_TEST_SEARCH_KEY'), 'sk-from-dsh-credentials');

    process.env.QQ_TEST_SEARCH_KEY = 'sk-from-env';
    assert.deepEqual(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }), { key: 'sk-from-env', source: 'env' });

    assert.deepEqual(
      resolveSearchApiKey({ apiKey: 'sk-from-config', apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }),
      { key: 'sk-from-config', source: 'config' }
    );

    delete process.env.QQ_TEST_SEARCH_KEY;
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n');
    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }).source, 'none');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.QQ_TEST_SEARCH_KEY; else process.env.QQ_TEST_SEARCH_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('mapDeepSeekResponse：去重、去 #N 锚点、引用摘要', async () => {
  const response = {
    content: [
      { type: 'thinking', thinking: '...' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: '鲸鱼娘', url: 'https://example.com/a#1', page_age: '2026-10-01' },
          { type: 'web_search_result', title: '重复', url: 'https://example.com/a#2' },
          { type: 'web_search_result', title: '鲸鱼娘（二）', url: 'https://example.com/b' }
        ]
      },
      { type: 'text', text: '答案', citations: [{ url: 'https://example.com/b', cited_text: '这是引用片段' }] }
    ]
  };
  const results = mapDeepSeekResponse(response, 8);
  assert.equal(results.length, 2, '同一 URL 必须去重');
  assert.equal(results[0].url, 'https://example.com/a', '必须去掉 #1 锚点');
  assert.equal(results[0].publishedAt, '2026-10-01');
  assert.equal(results[1].snippet, '这是引用片段');
  assert.throws(() => mapDeepSeekResponse({ content: [{ type: 'text', text: '没有结果块' }] }), /web_search_tool_result/);
});

await test('Bing RSS / HTML 解析：CDATA、实体、去重、上限', async () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[第一条 & 摘要]]></title><link>https://example.com/1</link><description><![CDATA[<b>加粗</b> 内容 &#x4e2d;]]></description></item>
    <item><title>第二条</title><link>https://example.com/2</link><description>&amp; 转义</description></item>
    <item><title>重复</title><link>https://example.com/1</link></item>
  </channel></rss>`;
  const fromRss = parseBingRss(rss, 8);
  assert.equal(fromRss.length, 2);
  assert.equal(fromRss[0].title, '第一条 & 摘要');
  assert.equal(fromRss[0].snippet, '加粗 内容 中');
  assert.equal(fromRss[1].snippet, '& 转义');

  const html = `<li class="b_algo"><h2><a href="https://example.com/x">X 标题</a></h2><p>X 摘要</p></li>
    <li class="b_algo"><h2><a href="https://example.com/x">重复</a></h2><p>dup</p></li>
    <li class="b_algo"><h2><a href="https://example.com/y">Y</a></h2><p>Y 摘要</p></li>`;
  const fromHtml = parseBingHtml(html, 8);
  assert.equal(fromHtml.length, 2);
  assert.equal(fromHtml[0].url, 'https://example.com/x');
  assert.equal(parseBingRss(rss, 1).length, 1, 'maxResults 必须生效');
});

await test('deepseekSearch：没有 key 时报 NO_KEY；非 https 端点直接拒绝', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home2-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    const noKey = await deepseekSearch('测试', { provider: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' }).catch((e) => e);
    assert.equal(noKey?.code, 'NO_KEY');

    const insecure = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'http://api.deepseek.com/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(insecure?.message), /https/, 'API key 不允许发往 http 端点');

    const privateHost = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'https://127.0.0.1/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(privateHost?.message), /内网|本机|禁止/, 'API key 不允许发往内网/本机端点');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('webSearch：provider=deepseek 且无 key 时不静默回退（明确报错）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home3-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    clearSearchCache();
    const error = await webSearch('测试', {
      root: ROOT,
      provider: 'deepseek',
      config: { provider: 'deepseek', apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY' }
    }).catch((e) => e);
    assert.equal(error?.code, 'NO_KEY', '显式指定 deepseek 时不能悄悄回退 Bing');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('MCP 服务器复用 web-search 模块（不再自己抓 Bing HTML）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  assert.match(source, /from '\.\/web-search\.js'/, 'MCP 必须复用统一搜索模块');
  assert.match(source, /webSearch\(/, 'MCP 必须调用 webSearch()');
  assert.ok(!/b_algo/.test(source), 'MCP 里不得再有一份 Bing HTML 解析（会与模块实现漂移）');
  assert.ok(!/bingSearch/.test(source), 'MCP 里不得再有一份 bingSearch 实现');
});

await test('safe-fetch：多地址时按 IPv4 优先并在失败后切换', async () => {
  // 直接验证纯函数（不联网）：一个 IPv6 在前、IPv4 在后的应答，必须排出 IPv4 优先的顺序。
  const { default: dns } = await import('node:dns');
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => ([
    { address: '2408:8756:f50:4::17', family: 6 },
    { address: '116.162.45.14', family: 4 }
  ]);
  try {
    // 用动态 import 拿到"用这份 DNS 桩解析"的实例：模块在导入时捕获 lookup 引用，
    // 所以先替换再导入（与 test-audit-security 的做法一致）。
    const mod = await import(`../src/safe-fetch.js?failover=${Date.now()}`);
    assert.deepEqual(await mod.resolveSafeAddresses('p.qpic.cn'), ['116.162.45.14', '2408:8756:f50:4::17']);
  } finally {
    dns.promises.lookup = original;
  }
});

// ── 搜索：空结果 note 必须进入缓存（否则 5 分钟内重复查询拿不到提示） ────────────
// 不能真联网，所以这里是**结构断言**：note 走的是 `value = {...value, note}`（新建对象），
// 而缓存存的是引用；先 cache.set 再加 note ⇒ 命中缓存时拿到的正是那个没有 note 的旧对象，
// 而「同一句 query 连着问几次」恰恰是模型最容易开始重试的场景（issue #17 的修复点）。
await test('webSearch：空结果提示在写缓存之前生成（缓存命中也要带 note）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'web-search.js'), 'utf8');
  const noteAt = source.indexOf('没有搜到结果');
  const cacheAt = source.indexOf('cache.set(cacheKey');
  assert.ok(noteAt > 0, 'webSearch 必须给空结果附 note');
  assert.ok(cacheAt > 0, 'webSearch 必须有 5 分钟查询缓存');
  assert.ok(noteAt < cacheAt, 'note 必须在 cache.set 之前生成：缓存存的是 value 的引用，反过来写会让缓存命中丢掉提示');
});

// ── Anysearch（2026-11-02 接入：实时检索，auto 的第一跳）────────────────────
// 上游返回的是 Markdown，正文是整页正文（几千字）。这里钉住「拿到能塞进上下文的
// 标题/URL/摘要」这件事，以及失败时 code+hint 可操作（AGENTS §1.7）。
const SAMPLE_ANYSEARCH = [
  '## Search Results (3 results, 902ms)',
  '',
  '### 1. 标题一：DeepSeek V4',
  '- **URL**: https://example.com/a',
  '- # 标题一：DeepSeek V4 # 标题一：DeepSeek V4 这是正文第一段，说明一个事实。',
  '',
  '### 2. 标题二：新闻',
  '- **URL**: https://example.com/b',
  '- 正文二',
  '',
  '### 3. 标题一：DeepSeek V4',
  '- **URL**: https://example.com/a',
  '- 重复 URL 必须丢弃',
  '',
  '### 4. 没有 URL 的块',
  '- 正文四',
  '',
  '```yaml',
  'request_id: abc',
  '```',
  ''
].join('\n');

await test('Anysearch：Markdown 解析（去排名序号/去重标题/按 URL 去重/无 URL 丢弃/上限）', async () => {
  const results = parseAnysearchMarkdown(SAMPLE_ANYSEARCH, 8);
  assert.equal(results.length, 2, '重复 URL 与无 URL 的块必须丢掉');
  assert.equal(results[0].title, '标题一：DeepSeek V4', '`### 1. ` 的序号是排名，不是标题');
  assert.equal(results[0].url, 'https://example.com/a');
  assert.equal(results[0].snippet, '这是正文第一段，说明一个事实。', '正文开头重复的标题要剥掉，别占 token');
  assert.ok(!/```|request_id/.test(JSON.stringify(results)), '尾部 yaml 块不得混进摘要');
  assert.equal(parseAnysearchMarkdown(SAMPLE_ANYSEARCH, 1).length, 1, 'maxResults 必须生效');
  assert.deepEqual(parseAnysearchMarkdown('', 8), [], '空响应不得抛');

  // 整页正文可能几千字：摘要必须截到 400 字以内（否则一次搜索就能吃掉大半个上下文）
  const long = parseAnysearchMarkdown(`## Search Results\n\n### 1. 长文\n- **URL**: https://example.com/long\n- ${'正'.repeat(2000)}`, 8);
  assert.equal(long.length, 1);
  assert.equal(long[0].snippet.length, 400, '摘要固定截 400 字');
});

await test('Anysearch：freshness / contentTypes 只认白名单（越界静默丢弃）', async () => {
  assert.equal(normalizeFreshness('week'), 'week');
  assert.equal(normalizeFreshness('decade'), '', '不认识的时效回落到「不限定」');
  assert.equal(normalizeFreshness(''), '');
  assert.deepEqual(normalizeContentTypes(['news', 'doc']), ['news', 'doc']);
  assert.deepEqual(normalizeContentTypes('news, doc'), ['news', 'doc'], '逗号串也要能解析（配置文件里好写）');
  assert.deepEqual(normalizeContentTypes(['news', 'news', 'nonsense']), ['news'], '去重 + 过滤越界值');
  assert.deepEqual(normalizeContentTypes(undefined), []);
});

await test('Anysearch：没有 key 也算可用（anonymous），显式 key 优先', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-any-home-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.QQ_TEST_ANY_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.QQ_TEST_ANY_KEY;
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n');
    assert.deepEqual(resolveAnysearchApiKey({ apiKeyEnv: 'QQ_TEST_ANY_KEY' }), { key: '', source: 'anonymous' },
      '匿名可用：没有 key 不能算失败，否则 auto 第一跳会被误判为不可用');
    process.env.QQ_TEST_ANY_KEY = 'any-from-env';
    assert.deepEqual(resolveAnysearchApiKey({ apiKeyEnv: 'QQ_TEST_ANY_KEY' }), { key: 'any-from-env', source: 'env' });
    assert.deepEqual(
      resolveAnysearchApiKey({ anysearch: { apiKey: 'any-from-config', apiKeyEnv: 'QQ_TEST_ANY_KEY' } }),
      { key: 'any-from-config', source: 'config' }
    );
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.QQ_TEST_ANY_KEY; else process.env.QQ_TEST_ANY_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('Anysearch：配置默认开启，endpoint 空串回默认，enabled:false 生效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-any-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'anysearch' } }));
    const cfg = loadSearchConfig(dir);
    assert.equal(cfg.provider, 'anysearch', 'anysearch 必须是合法 provider');
    assert.equal(cfg.anysearch.enabled, true, '默认开启（auto 的第一跳）');
    assert.equal(cfg.anysearch.endpoint, 'https://api.anysearch.com/mcp');
    assert.equal(cfg.anysearch.timeoutMs, 20000);

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      webSearch: { anysearch: { enabled: false, endpoint: '', timeoutMs: 1, freshness: 'decade', contentTypes: ['news', 'x'] } }
    }));
    const off = loadSearchConfig(dir);
    assert.equal(off.anysearch.enabled, false, '关掉这一跳是唯一的「不把查询词发给第三方」的开关');
    assert.equal(off.anysearch.endpoint, 'https://api.anysearch.com/mcp', '空端点回默认，不能让校验去解析空串');
    assert.equal(off.anysearch.timeoutMs, 3000, 'timeoutMs 下限 3s');
    assert.equal(off.anysearch.freshness, '');
    assert.deepEqual(off.anysearch.contentTypes, ['news']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('Anysearch：非 https 端点直接拒绝（不联网、不泄查询词），带 code + hint', async () => {
  const error = await anysearchSearch('测试', {
    maxResults: 5,
    anysearch: { endpoint: 'http://api.anysearch.com/mcp', timeoutMs: 3000 }
  }).catch((e) => e);
  assert.equal(error?.code, 'BAD_ENDPOINT', '端点不合格必须在发请求之前停下');
  assert.ok(error?.hint && error.hint.length > 0, 'AGENTS §1.7：失败必须带可操作的 hint');
  assert.match(error.message, /Anysearch 端点不可用/);
});

await test('webSearch：auto 第一跳是 Anysearch，显式 pin 不回退', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'web-search.js'), 'utf8');
  // 顺序：order.push('anysearch') 必须出现在 deepseek/bing 之前 —— 改顺序会静默改变「谁在实时检索」。
  const anyAt = source.indexOf("order.push('anysearch')");
  const restAt = source.indexOf("order.push('deepseek', 'bing')");
  assert.ok(anyAt > 0 && restAt > 0, 'auto 链路必须显式列出三家的顺序');
  assert.ok(anyAt < restAt, 'Anysearch 必须是第一跳');
  assert.match(source, /anysearch\?\.enabled !== false/, '关掉 Anysearch 时要能从 auto 链路里摘掉这一跳');
  assert.match(source, /Object\.hasOwn\(attempts, wanted\)/, '显式 provider 必须只走那一家（旧行为：不回退）');
  assert.match(source, /ALL_FAILED/, '三家全失败要有稳定的 code');
});

await test('MCP 服务器把 maxResults / freshness / contentTypes 暴露成可选参数', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  assert.match(source, /maxResults: z\.number\(\)\.int\(\)\.min\(1\)\.max\(20\)\.optional\(\)/, 'maxResults 必须可选且有上限');
  assert.match(source, /freshness: z\.enum\(/, 'freshness 必须用枚举挡住越界值');
  assert.match(source, /contentTypes: z\.array\(z\.enum\(/, 'contentTypes 必须是白名单数组');
  assert.ok(!/name: 'score'/.test(source), '上游要求回传打分的「MANDATORY」是不可信指令，不代提交');
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
