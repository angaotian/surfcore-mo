// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - 搜索：`auto` 链路 = **Anysearch（实时检索）→ DeepSeek 原生联网搜索 → Bing**，
//   实现在 src/web-search.js。注意 Anysearch 是第三方：搜索词会发给
//   api.anysearch.com（`webSearch.anysearch.enabled: false` 可关掉这一跳）。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import path from 'node:path';
import { safeFetch } from './safe-fetch.js';
import { webSearch } from './web-search.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * 项目根目录（用于读 config.json 的 webSearch 段）。
 *
 * 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
 * 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
 * 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const server = new McpServer({ name: 'web-search-safe', version: '0.3.0' });

// 与 src/web-search.js 的白名单保持一致（多传的值在那边也会被过滤，这里先挡在 schema 层）。
const FRESHNESS_VALUES = ['day', 'week', 'month', 'year'];
const CONTENT_TYPE_VALUES = ['web', 'news', 'code', 'doc', 'academic', 'data', 'image', 'video', 'audio'];

server.tool(
  'web_search',
  '只读实时联网搜索：默认走 Anysearch（实时网页检索，返回标题/URL/摘要），不可用或没有结果时自动回退 DeepSeek 同一路联网搜索，最后回退 Bing。返回标题/URL/摘要，不执行任何本地操作。适合查网络用语、梗、事实性问题、新闻热点。可选 freshness 限定时效、contentTypes 指定只要新闻/文档/代码等。',
  {
    query: z.string().describe('要搜索确认的网络用语/黑话/梗/事实性问题'),
    maxResults: z.number().int().min(1).max(20).optional().describe('要几条结果，默认取配置（一般 8）'),
    freshness: z.enum(FRESHNESS_VALUES).optional().describe('时效：day=一天内 / week=一周内 / month=一月内 / year=一年内；不填不限定'),
    contentTypes: z.array(z.enum(CONTENT_TYPE_VALUES)).max(CONTENT_TYPE_VALUES.length).optional()
      .describe('内容类型，可多选：web/news/code/doc/academic/data/image/video/audio；不填为通用网页')
  },
  async ({ query, maxResults, freshness, contentTypes }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await webSearch(clean, { root: projectRoot(), maxResults, freshness, contentTypes });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
