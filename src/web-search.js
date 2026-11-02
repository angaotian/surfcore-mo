// 联网搜索（MCP `web_search` 的实现）。三家后端，统一返回 `{title,url,snippet?,publishedAt?}`：
//
//   1. **Anysearch**（`https://api.anysearch.com/mcp`，JSON-RPC，2026-11-02 接入）：
//      实时网页检索，匿名可用（有 key 走 key）、单次约 1s、不消耗模型 token。
//      代价：搜索词会发给这家第三方（README 明说）；返回的是**整页正文**，
//      本模块只取前 400 字当 snippet，否则一条结果就能吃掉几千 token。
//      上游工具描述里写着「MANDATORY: call score ...」，那是**服务端的自述**，
//      不是我们的指令：本模块不代任何一方提交打分/反馈（绝不把群里的问题回传）。
//   2. **DeepSeek**（与 DSH 同源的 `web_search_20250305` 服务端工具）：搜索词只发给
//      本来就在处理这段对话的同一家；要消耗模型 token，没有 key 就用不了。
//   3. **Bing**（`cn.bing.com` 的 RSS，失败退回 HTML）：不依赖任何 key 的最后兜底。
//
// `provider: "auto"` 的顺序是 **Anysearch → DeepSeek → Bing**（见 webSearch()）：
// 前一路报错或返回空结果才继续往后走，全部为空才返回空结果 + note。
//
// DeepSeek 这一路的实现参照 `@deepseek-ai/dsh-web-search-deepseek`：向 Anthropic 兼容
// Messages 端点发一次带 `web_search_20250305` 服务端工具的请求，从
// `web_search_tool_result` 里取结构化结果，于是 QQ 里的 AI 和 DSH 里的 AI 拿到的是
// **同一路搜索结果**。
//
// 凭据解析顺序（DeepSeek 与 Anysearch 各自独立，都是这条顺序）：
//   1. config.json 的 `webSearch.apiKey` / `webSearch.anysearch.apiKey`（不推荐，明文）
//   2. 环境变量 `DEEPSEEK_API_KEY` / `ANYSEARCH_API_KEY`（可用对应的 `apiKeyEnv` 改）
//   3. DSH 的 `$DSH_HOME/.credentials.yaml` → `refs.<ref>`（DSH 的 Models 页写入的 key）
// 都没有时：Anysearch 匿名仍可用；DeepSeek 报 `NO_KEY` 后继续往下走；最后是 Bing，
// 保证"永远有一个能用的搜索"。
//
// 安全边界：
// - API key 只发往**校验过**的 HTTPS 端点：必须是 https、必须解析到公网地址
//   （防止把 key 发到 localhost/内网），且禁止跟随重定向（`redirect: error`）。
// - key 永远不写日志、不进错误信息、不进返回结果。
// - 响应体有大小上限；请求有总超时；查询词在 MCP 层已清洗。
// - Bing 走 safe-fetch（SSRF 防护 + 多地址故障切换）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { URL } from 'node:url';
import YAML from 'js-yaml';
import { resolveSafeAddresses, safeFetch } from './safe-fetch.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_TIMEOUT_MS = 35000;
const DEFAULT_ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp';
const DEFAULT_ANYSEARCH_TIMEOUT_MS = 20000;
const DEFAULT_ANYSEARCH_API_KEY_ENV = 'ANYSEARCH_API_KEY';
// 上游返回的是整页正文（一条可以几千字）。snippet 只留开头这么多字：
// 既够模型判断「这条是不是我要的」，又不会一条结果就顶满上下文。
const ANYSEARCH_SNIPPET_CHARS = 400;
// 上游 `freshness` / `content_types` 的取值白名单（多传会被服务端忽略或报错，这里先过滤）。
const ANYSEARCH_FRESHNESS = Object.freeze(['day', 'week', 'month', 'year']);
const ANYSEARCH_CONTENT_TYPES = Object.freeze(['web', 'news', 'code', 'doc', 'academic', 'data', 'image', 'video', 'audio']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// Anthropic 兼容响应里文本块/结果块都可能有；这里只要结构化结果。
const SEARCH_TOOL_TYPE = 'web_search_20250305';

const defaultConfig = Object.freeze({
  provider: 'auto',
  apiKey: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  baseURL: '',
  model: DEFAULT_MODEL,
  maxUses: 5,
  maxTokens: 4096,
  maxResults: 8,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  anysearch: Object.freeze({
    // 默认开：`auto` 的第一跳。想在群里彻底不发第三方就把它关掉（provider 仍可显式指定）。
    enabled: true,
    endpoint: DEFAULT_ANYSEARCH_ENDPOINT,
    apiKey: '',
    apiKeyEnv: DEFAULT_ANYSEARCH_API_KEY_ENV,
    timeoutMs: DEFAULT_ANYSEARCH_TIMEOUT_MS,
    freshness: '',
    contentTypes: Object.freeze([])
  })
});

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** `freshness` 只认 day|week|month|year；空串表示不限定时间（由服务端默认）。 */
export function normalizeFreshness(value) {
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    const s = String(item ?? '').trim().toLowerCase();
    if (!s) continue;
    if (ANYSEARCH_FRESHNESS.includes(s)) return s;
  }
  return '';
}

/** `content_types` 白名单过滤 + 去重（接受数组或逗号分隔字符串）。 */
export function normalizeContentTypes(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const out = [];
  for (const item of list) {
    const s = String(item ?? '').trim().toLowerCase();
    if (!s || !ANYSEARCH_CONTENT_TYPES.includes(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= ANYSEARCH_CONTENT_TYPES.length) break;
  }
  return out;
}

/** 读取 config.json 里的 webSearch 段（不存在就用默认值）。 */
export function loadSearchConfig(root) {
  let file = {};
  try {
    const text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {}
  const raw = file?.webSearch && typeof file.webSearch === 'object' && !Array.isArray(file.webSearch) ? file.webSearch : {};
  const rawAny = raw.anysearch && typeof raw.anysearch === 'object' && !Array.isArray(raw.anysearch) ? raw.anysearch : {};
  const provider = ['deepseek', 'bing', 'anysearch'].includes(raw.provider) ? raw.provider : 'auto';
  return {
    ...defaultConfig,
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    maxUses: num(raw.maxUses, defaultConfig.maxUses, 1, 5),
    maxTokens: num(raw.maxTokens, defaultConfig.maxTokens, 256, 8192),
    maxResults: num(raw.maxResults, defaultConfig.maxResults, 1, 20),
    timeoutMs: num(raw.timeoutMs, defaultConfig.timeoutMs, 5000, 120000),
    anysearch: {
      ...defaultConfig.anysearch,
      enabled: rawAny.enabled !== false,
      endpoint: typeof rawAny.endpoint === 'string' && rawAny.endpoint.trim()
        ? rawAny.endpoint.trim()
        : DEFAULT_ANYSEARCH_ENDPOINT,
      apiKey: typeof rawAny.apiKey === 'string' ? rawAny.apiKey.trim() : '',
      apiKeyEnv: typeof rawAny.apiKeyEnv === 'string' && rawAny.apiKeyEnv.trim()
        ? rawAny.apiKeyEnv.trim()
        : DEFAULT_ANYSEARCH_API_KEY_ENV,
      timeoutMs: num(rawAny.timeoutMs, DEFAULT_ANYSEARCH_TIMEOUT_MS, 3000, 60000),
      freshness: normalizeFreshness(rawAny.freshness),
      contentTypes: normalizeContentTypes(rawAny.contentTypes)
    }
  };
}

/** DSH home：与 dsh-client 的判定保持一致（`DSH_HOME` 优先）。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 从 DSH 的凭据文件里取 key。
 * 结构：`refs: { <名称>: <明文值> }`（实测；不是记录 id）。只看指定 ref，绝不遍历其它凭据。
 */
export function readDshCredential(ref) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const value = doc?.refs?.[name];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** 解析搜索用的 DeepSeek key；返回 { key, source } —— key 只在这里出现，不落日志。 */
export function resolveSearchApiKey(config) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

/**
 * 解析 Anysearch 的 key（同一条三级顺序）。
 * 与 DeepSeek 不同，**没有 key 不算失败**：上游允许匿名调用（额度更小），
 * 所以这里返回 `source: 'anonymous'` 而不是抛错。
 */
export function resolveAnysearchApiKey(config) {
  const anyConfig = config?.anysearch && typeof config.anysearch === 'object' ? config.anysearch : config ?? {};
  const literal = String(anyConfig?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(anyConfig?.apiKeyEnv || DEFAULT_ANYSEARCH_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'anonymous' };
}

function normalizeSearchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  // DeepSeek 的结果 URL 会带 `#1` 这类"第几条"的锚点（不是页面真实片段），去掉更干净；
  // 但真实的 `#section` 也可能有意义，所以只去纯数字锚点。
  const cleaned = s.replace(/#\d+$/, '');
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 把 Anthropic Messages 响应映射成统一结果（参照 dsh-web-search-deepseek 的实现）。 */
export function mapDeepSeekResponse(response, maxResults = 8) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (!resultBlocks.length) {
    throw Object.assign(new Error('DeepSeek 没有返回 web_search_tool_result（可能未触发联网搜索）'), { code: 'NO_RESULT_BLOCK' });
  }
  const snippets = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      const url = normalizeSearchUrl(cite?.url);
      if (!url || snippets.has(url)) continue;
      const text = String(cite?.cited_text ?? '').trim();
      if (text) snippets.set(url, text);
    }
  }
  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    for (const item of block?.content ?? []) {
      if (item?.type !== 'web_search_result') continue;
      const url = normalizeSearchUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.title ?? '').trim().slice(0, 200);
      const snippet = String(snippets.get(url) ?? '').trim().slice(0, 500);
      results.push({
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: String(item.page_age).slice(0, 40) } : {})
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/** 校验搜索端点：https + 公网地址。返回 { url, addresses }。 */
async function validateSearchEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw new Error('webSearch.baseURL 无效');
  }
  if (url.protocol !== 'https:') throw new Error('webSearch.baseURL 必须是 https（API key 只能发给加密端点）');
  if (url.username || url.password) throw new Error('webSearch.baseURL 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, addresses };
}

/**
 * 向搜索端点 POST JSON（单个已校验地址）。
 * 不复用 safeFetch（它只做 GET）：这里需要 POST、禁止重定向，并把 key 只交给校验过的地址。
 * 网络层失败（连接/超时/中断）由 postJson() 换地址重试；HTTP 状态是结果，不在这里重试。
 */
function postJsonOnce(url, address, { headers, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    try {
      req = https.request({
        hostname: address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          host: url.host,
          'content-length': Buffer.byteLength(body)
        },
        // 证书校验用真实域名（SNI/Host 与站点一致），连接目标才是固定 IP。
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs
      }, (res) => {
        response = res;
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          finish(new Error(`联网搜索端点返回重定向（HTTP ${status}），已拒绝跟随`));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('联网搜索响应体过大，已中止'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('联网搜索响应中断')));
        res.on('close', () => { if (!res.complete) finish(new Error('联网搜索响应中断')); });
        res.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, { status, text });
        });
      });
      req.on('timeout', () => {
        const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

/** 依次尝试前两个已校验地址（同一失败形态：DNS 先给 IPv6、本机没有 IPv6 出口）。 */
async function postJson(url, addresses, options) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error('没有任何可用地址');
  const deadline = Date.now() + options.timeoutMs;
  const attempts = Math.min(list.length, 2);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const budget = attempts === 1 ? options.timeoutMs : Math.min(remaining, Math.ceil(options.timeoutMs / 2));
    try {
      return await postJsonOnce(url, list[i], { ...options, timeoutMs: budget });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('联网搜索请求失败');
}

/** DeepSeek 原生联网搜索。失败时抛出带稳定 code 的错误，由调用方决定是否回退。 */
export async function deepseekSearch(query, config = defaultConfig) {
  const { key } = resolveSearchApiKey(config);
  if (!key) {
    throw Object.assign(new Error('没有可用的 DeepSeek API key'), { code: 'NO_KEY' });
  }
  const baseURL = config.baseURL || process.env.DEEPSEEK_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const { url, addresses } = await validateSearchEndpoint(baseURL);
  const endpoint = new URL(`${url.toString().replace(/\/+$/, '')}/messages`);
  const body = JSON.stringify({
    model: config.model || DEFAULT_MODEL,
    max_tokens: config.maxTokens || defaultConfig.maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }]
    }],
    tools: [{
      type: SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: config.maxUses || defaultConfig.maxUses
    }]
  });
  const response = await postJson(endpoint, addresses, {
    headers: {
      'x-api-key': key,
      authorization: `Bearer ${key}`,
      'anthropic-version': DEFAULT_API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'qq-bridge-web-search/0.2.0'
    },
    body,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (response.status < 200 || response.status >= 300) {
    // 只回显 HTTP 状态与主体里的简短错误，绝不拼接请求头（里面是 key）。
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    throw Object.assign(
      new Error(`DeepSeek 搜索接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`),
      { code: 'HTTP_ERROR', status: response.status }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw Object.assign(new Error('DeepSeek 搜索接口返回了无法解析的响应'), { code: 'BAD_BODY' });
  }
  return mapDeepSeekResponse(parsed, config.maxResults || defaultConfig.maxResults);
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? decodeEntities(match[1]) : '';
}

/** Bing 的 RSS 结果（比 HTML 页面稳定：没有 JS、结构固定）。 */
export function parseBingRss(xml, maxResults = 8) {
  const results = [];
  const seen = new Set();
  for (const match of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const url = normalizeSearchUrl(pickTag(block, 'link'));
    if (!url || seen.has(url)) continue;
    const title = pickTag(block, 'title').slice(0, 200);
    const snippet = pickTag(block, 'description').slice(0, 500);
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 的 HTML 结果页（RSS 不可用时的兜底，保持旧实现的解析口径）。 */
export function parseBingHtml(html, maxResults = 8) {
  const results = [];
  const seen = new Set();
  const blocks = String(html ?? '').split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const url = normalizeSearchUrl(decodeEntities(hrefMatch[1]));
    if (!url || seen.has(url)) continue;
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).slice(0, 200) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1]).slice(0, 500) : '';
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 搜索（RSS 优先，HTML 兜底）。 */
export async function bingSearch(query, config = defaultConfig) {
  const maxResults = config.maxResults || defaultConfig.maxResults;
  const rss = new URL('https://cn.bing.com/search');
  rss.searchParams.set('q', query);
  rss.searchParams.set('format', 'rss');
  rss.searchParams.set('count', String(Math.min(20, maxResults)));
  rss.searchParams.set('setlang', 'zh-hans');
  rss.searchParams.set('cc', 'CN');
  try {
    const res = await safeFetch(rss.toString(), 512000);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const results = parseBingRss(res.body, maxResults);
      if (results.length) return results;
    }
  } catch {}
  const html = new URL('https://cn.bing.com/search');
  html.searchParams.set('q', query);
  html.searchParams.set('count', String(Math.min(20, maxResults)));
  html.searchParams.set('setlang', 'zh-hans');
  html.searchParams.set('cc', 'CN');
  const res = await safeFetch(html.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Bing 搜索 HTTP ${res.statusCode}`);
  return parseBingHtml(res.body, maxResults);
}

/**
 * 把上游返回的行内文本压成一行：去掉末尾的 ```yaml request_id``` 元数据块、
 * 正文里夹带的 Markdown 标题符号，并把所有空白折叠成一个空格。
 * 上游正文里常有多级标题（`# 标题 # 副标题`），原样塞给模型既占 token 又干扰阅读。
 */
function collapseText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*$/g, ' ')
    .replace(/^#{1,6}\s+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 Anysearch 的 Markdown 结果。
 *
 * 实测格式（2026-11-02，`tools/call` → `search`）：
 * ```
 * ## Search Results (2 results, 896ms)
 *
 * ### 1. 标题
 * - **URL**: https://example.com/a
 * - 正文字段（可能是整页正文，几千字，含 `#` 标题）
 *
 * ### 2. ...
 * ```yaml
 * request_id: ...
 * ```
 * ```
 * 只取「标题 / URL / 正文前 400 字」，其余一律丢弃（token 预算）。
 */
export function parseAnysearchMarkdown(text, maxResults = 8) {
  const results = [];
  const seen = new Set();
  // 用行首的 `### ` 切分结果块；第一个块是 `## Search Results` 抬头，丢掉。
  const blocks = String(text ?? '').split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    // `### 1. 标题` —— 序号是上游的排名，不是标题的一部分。
    const title = collapseText(lines[0] ?? '').replace(/^\d+\s*[.、)]\s*/, '').slice(0, 200);
    const urlLine = lines.find((line) => /\*\*URL\*\*/i.test(line)) ?? '';
    const urlMatch = /(https?:\/\/[^\s)）]+)/i.exec(urlLine);
    const url = normalizeSearchUrl(urlMatch ? urlMatch[1].replace(/[.,;]+$/, '') : '');
    if (!url || seen.has(url)) continue;
    const urlIndex = lines.indexOf(urlLine);
    // 正文常以 `- ` 列表符开头、内部夹着 `# 标题 #` 的重复标题：都清掉，只留能读的正文。
    let body = collapseText(lines.slice(urlIndex + 1).join('\n'))
      .replace(/^(?:[-*+]\s+)+/, '')
      .replace(/^#\s*/, '')
      .replace(/\s#\s/g, ' ');
    // 正文开头往往是标题的重复（`# 标题 # 标题 正文…`），重复的标题不占 token。
    if (title) {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = body.replace(new RegExp(`^(?:${escaped}\\s*)+`), '');
    }
    body = body.slice(0, ANYSEARCH_SNIPPET_CHARS);
    seen.add(url);
    results.push({ title: title || url, url, ...(body ? { snippet: body } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * Anysearch 的失败统一带上 `code` + `hint`（AGENTS §1.7：新增失败路径必须可操作）。
 * `hint` 是给调用方/人看的下一步，不是给模型猜的。
 */
const ANYSEARCH_HINT = '本机网络或 api.anysearch.com 不可用时可设 webSearch.anysearch.enabled=false，搜索会自动退回 DeepSeek/Bing';
function anysearchError(code, message, hint = ANYSEARCH_HINT, extra = {}) {
  return Object.assign(new Error(message), { code, hint, ...extra });
}

/**
 * Anysearch 实时检索（JSON-RPC 2.0 `tools/call` → `search`）。
 *
 * 为什么不复用 MCP SDK 直连上游：那会把整个上游的工具表（含它自己的长描述与
 * 「MANDATORY 提交打分」要求）暴露给模型。这里只借它的**一条数据通道**：
 * 一次 POST、只取 `result.content[].text`，然后把 Markdown 解析成统一结构。
 *
 * `options`: `{ maxResults, freshness, contentTypes }`（MCP 层的可选参数落到这里）。
 */
export async function anysearchSearch(query, config = defaultConfig, options = {}) {
  const anyConfig = config?.anysearch && typeof config.anysearch === 'object'
    ? { ...defaultConfig.anysearch, ...config.anysearch }
    : defaultConfig.anysearch;
  const maxResults = num(options.maxResults ?? config.maxResults, defaultConfig.maxResults, 1, 20);
  const freshness = normalizeFreshness(options.freshness ?? anyConfig.freshness);
  const contentTypes = normalizeContentTypes(options.contentTypes ?? anyConfig.contentTypes);
  // 端点校验失败（非 https / 内网 / 带凭据）在发请求之前就停下：不要把查询词发给不合格的地址。
  let url;
  let addresses;
  try {
    ({ url, addresses } = await validateSearchEndpoint(anyConfig.endpoint || DEFAULT_ANYSEARCH_ENDPOINT));
  } catch (error) {
    throw anysearchError(
      'BAD_ENDPOINT',
      `Anysearch 端点不可用：${error?.message ?? error}`,
      'webSearch.anysearch.endpoint 必须是解析到公网的 https 地址（默认 https://api.anysearch.com/mcp）'
    );
  }
  const args = { query: String(query ?? '').slice(0, 200), max_results: maxResults };
  if (freshness) args.freshness = freshness;
  if (contentTypes.length) args.content_types = contentTypes;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search', arguments: args }
  });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    // 上游对无 UA 的客户端会拒，显式给一个（不含任何本机信息）。
    'user-agent': 'qq-bridge-web-search/0.3.0'
  };
  const { key } = resolveAnysearchApiKey(anyConfig);
  if (key) headers.authorization = `Bearer ${key}`;
  let response;
  try {
    response = await postJson(url, addresses, {
      headers,
      body,
      timeoutMs: anyConfig.timeoutMs || DEFAULT_ANYSEARCH_TIMEOUT_MS
    });
  } catch (error) {
    // 连接/超时/重定向被拒：给个稳定的 code，别让调用方去解析中文文案。
    throw anysearchError('NETWORK_ERROR', `Anysearch 请求失败：${error?.message ?? error}`);
  }
  if (response.status < 200 || response.status >= 300) {
    // 只回显状态与主体里的简短原因，绝不回显请求头（可能带 key）。
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    throw anysearchError(
      'HTTP_ERROR',
      `Anysearch 接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      undefined,
      { status: response.status }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw anysearchError('BAD_BODY', 'Anysearch 返回了无法解析的响应');
  }
  if (parsed?.error) {
    const message = String(parsed.error?.message ?? parsed.error?.code ?? '未知错误').slice(0, 200);
    throw anysearchError('RPC_ERROR', `Anysearch 返回错误：${message}`);
  }
  const content = Array.isArray(parsed?.result?.content) ? parsed.result.content : [];
  const text = content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  if (parsed?.result?.isError) {
    // 上游把「额度用完 / 查询被拒」这类情况也放在 isError 里，属于**可回退**的失败。
    throw anysearchError(
      'UPSTREAM_ERROR',
      `Anysearch 上游报错：${collapseText(text).slice(0, 200) || '未给出原因'}`,
      'Anysearch 拒绝了这次查询（额度或内容限制）；auto 模式会自动回退，显式 provider=anysearch 时请改用 auto'
    );
  }
  if (!text) throw anysearchError('BAD_BODY', 'Anysearch 没有返回文本结果');
  return parseAnysearchMarkdown(text, maxResults);
}

const cache = new Map(); // `${provider}|${query}|...` -> { at, value }

export function clearSearchCache() {
  cache.clear();
}

/** 回退链里每家失败原因的文案（`auto` 最后把这几条拼起来，别让调用方只看到最后一家的错）。 */
function describeSearchFailure(provider, error) {
  if (provider === 'deepseek' && error?.code === 'NO_KEY') return '未配置 DeepSeek 搜索凭据';
  const label = provider === 'anysearch'
    ? 'Anysearch 搜索不可用'
    : provider === 'deepseek'
      ? 'DeepSeek 搜索不可用'
      : 'Bing 搜索不可用';
  return `${label}：${error?.message ?? error}`;
}

/**
 * 统一入口：按配置选择 provider。
 *
 * `auto` 顺序 = **Anysearch → DeepSeek → Bing**：
 * - 前一路**报错**就换下一路；前一路**返回空结果**也继续换（空结果往往只是这家没收录），
 *   但会把第一个空结果留着，全部为空时返回它 + note。
 * - `webSearch.anysearch.enabled: false` 时跳过第一路（担心数据外发就关这里）。
 * - 显式 `provider: "deepseek" | "bing" | "anysearch"` 时**不回退**：错就错，
 *   免得「以为在用 A，其实悄悄换成了 B」（旧行为，测试钉着）。
 *
 * @returns {{query:string, provider:'anysearch'|'deepseek'|'bing', results:object[], fallbackFrom?:string, note?:string}}
 */
export async function webSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('查询词为空');
  const config = { ...loadSearchConfig(options.root ?? process.cwd()), ...(options.config ?? {}) };
  const wanted = options.provider ?? config.provider;
  const maxResults = num(options.maxResults ?? config.maxResults, defaultConfig.maxResults, 1, 20);
  const freshness = normalizeFreshness(options.freshness ?? config.anysearch?.freshness);
  const contentTypes = normalizeContentTypes(options.contentTypes ?? config.anysearch?.contentTypes);
  const cacheKey = [wanted, q, maxResults, freshness || '-', contentTypes.join(',') || '-'].join('|');
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const scopedConfig = { ...config, maxResults };
  const attempts = {
    anysearch: async () => ({
      query: q,
      provider: 'anysearch',
      results: await anysearchSearch(q, scopedConfig, { maxResults, freshness, contentTypes })
    }),
    deepseek: async () => ({ query: q, provider: 'deepseek', results: await deepseekSearch(q, scopedConfig) }),
    bing: async () => ({ query: q, provider: 'bing', results: await bingSearch(q, scopedConfig) })
  };

  let value;
  if (Object.hasOwn(attempts, wanted)) {
    // 显式指定：只走这一家，失败就抛（调用方要能看出「是哪一家不行」）。
    value = await attempts[wanted]();
  } else {
    const order = [];
    if (scopedConfig.anysearch?.enabled !== false) order.push('anysearch');
    order.push('deepseek', 'bing');
    const reasons = [];
    let emptyValue = null;
    let firstFailed = '';
    for (const name of order) {
      try {
        const attempt = await attempts[name]();
        if (attempt.results.length) {
          value = attempt;
          break;
        }
        emptyValue = emptyValue ?? attempt;
      } catch (error) {
        reasons.push(describeSearchFailure(name, error));
        if (!firstFailed) firstFailed = name;
      }
    }
    if (value && firstFailed && value.provider !== firstFailed) {
      // 回退成功：把「上一路为什么不行」带上，否则日志里只看得到成功，查不出退化。
      value = { ...value, fallbackFrom: firstFailed, note: `${reasons.join('；')}，已回退 ${value.provider}` };
    } else if (!value) {
      if (emptyValue) {
        value = emptyValue;
      } else {
        // 三家全挂：把每一路的原因都带上（只报最后一家会让排查者以为是 Bing 的问题）。
        throw Object.assign(new Error(reasons.join('；') || '没有可用的搜索后端'), {
          code: 'ALL_FAILED',
          hint: '检查本机网络；DeepSeek 一路需要 webSearch.apiKey 或 DSH 凭据里的 DEEPSEEK_API_KEY，不需要就在配置里关掉 provider 之外的依赖'
        });
      }
    }
  }
  // 空结果必须显式说明：以前直接返回 `results: []`，模型分不清「真没搜到」和
  // 「搜索接口静默失效」，会一直换关键词重试（issue #17）。现在给出可操作的下一步。
  // ⚠️ 这段必须在 `cache.set` **之前**：note 走的是「新建对象」而不是原地改，
  // 而缓存里存的是**引用**。反过来写（先缓存、后加 note）时，5 分钟内的重复查询会命中
  // 那个没有 note 的旧对象 —— 恰好是模型最容易开始重试的场景（同一句 query 连着问）。
  if (Array.isArray(value.results) && value.results.length === 0) {
    value = { ...value, note: [value.note, '没有搜到结果（可换个说法/加限定词；仍为空就不要再重复搜索）'].filter(Boolean).join('；') };
  }
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const key of [...cache.keys()].slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
  }
  return value;
}
