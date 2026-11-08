// 表情包资源包（AstroBot「表情包管理器 meme_manager」格式）兼容层——纯函数。
//
// 为什么要这一层（2026-11-02）：
//   用户从 AstroBot 那边拿到 meme_manager 插件（meme_manager-5.3.0）与它的社区资源包索引。
//   SurfCore 是 DSH 插件、跑的是 node，没法直接加载 AstrBot 的 Python 插件；
//   能兼容的是它定义得最好的那一半——**表情包目录格式**：
//
//     <pack>/manifest.json          { id, name, version, categories: { 分类: {description} }, source? }
//     <pack>/memes_data.json        { 分类: 描述 }
//     <pack>/memes/<分类>/<图片>      jpg / png / gif / webp
//     <pack>/semantic_metadata.json { images: { "<分类>/<文件>": { caption, tags[] } } }   ← 可选
//
//   于是「在 AstroBot 装好的包」可以直接搬进 SurfCore 的表情库：图片复制进
//   state/sticker-files/<packId>/，caption/tags 变成 SurfCore 的 content/keywords，
//   情绪用本仓库自己的 detectEmotions() 从文字里推（不引入它的 faiss 索引）。
//
// 设计原则：
// - 这里只做**格式解析与映射**，不碰网络、不写文件；落盘/去重由桥接（唯一写者）负责。
// - 对脏数据一律宽容：缺 manifest 字段、缺 memes_data、语义文件是 v1 结构，都不抛异常，
//   降级成「分类名当描述」的条目（宁可标签糙一点，也不要整包导不进来）。

import { emotionLabel, normalizeEmotionKey } from './sticker-semantics.js';

export const PACK_FORMAT = 'astrbot-meme-pack';
export const PACK_MANIFEST_FILE = 'manifest.json';
export const PACK_MEMES_DIR = 'memes';
export const PACK_MEMES_DATA_FILE = 'memes_data.json';
export const PACK_SEMANTIC_FILE = 'semantic_metadata.json';
export const PACK_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

const ID_ALLOWED = /^[a-z0-9._-]+$/;

/**
 * 校验资源包 id：要能直接当目录名用，所以只认小写字母/数字/._-。
 *
 * 与 AstroBot 侧 protocol.py 的规则保持一致（2~64 位、不能以点结尾），
 * 这样同一个包在两边是同一个 id，用户不会看到「装了两次两份」。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, id: string } | { ok: false, code: string, error: string, hint: string }}
 */
export function validatePackId(raw) {
  const id = String(raw ?? '').trim().toLowerCase();
  if (!id) {
    return { ok: false, code: 'PACK_ID_EMPTY', error: '资源包 id 不能为空', hint: '包目录里应该有 manifest.json，其中的 id 字段不能为空' };
  }
  if (id.length < 2 || id.length > 64) {
    return { ok: false, code: 'PACK_ID_LENGTH', error: `资源包 id 长度非法（${id.length}）`, hint: 'id 需要 2~64 个字符' };
  }
  if (id.endsWith('.')) {
    return { ok: false, code: 'PACK_ID_TRAILING_DOT', error: '资源包 id 不能以点结尾', hint: '去掉结尾的点再试' };
  }
  if (!ID_ALLOWED.test(id)) {
    return { ok: false, code: 'PACK_ID_CHARS', error: `资源包 id 含非法字符：${id}`, hint: '只允许小写字母、数字、点、下划线、连字符' };
  }
  return { ok: true, id };
}

/**
 * 归一化 manifest.json（缺字段就补，不从磁盘读）。
 *
 * @param {object} raw manifest.json 解析后的对象
 * @param {{ fallbackId?: string }} [opts] 包目录名，manifest 缺 id 时兜底
 * @returns {{ ok: true, manifest: object } | { ok: false, code: string, error: string, hint: string }}
 */
export function normalizePackManifest(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'PACK_MANIFEST_SHAPE', error: 'manifest.json 不是一个对象', hint: '检查文件是否损坏、或是否用了别的格式' };
  }
  const check = validatePackId(raw.id ?? opts.fallbackId);
  if (!check.ok) return check;
  const name = String(raw.name ?? '').trim() || check.id;
  const version = String(raw.version ?? '').trim() || '0.0.0';
  const categories = {};
  const rawCats = raw.categories && typeof raw.categories === 'object' && !Array.isArray(raw.categories) ? raw.categories : {};
  for (const [key, value] of Object.entries(rawCats)) {
    const category = String(key ?? '').trim();
    if (!category) continue;
    const description = value && typeof value === 'object' ? String(value.description ?? '').trim() : String(value ?? '').trim();
    categories[category] = { description };
  }
  const source = raw.source && typeof raw.source === 'object' ? {
    type: String(raw.source.type ?? '').trim(),
    repo: String(raw.source.repo ?? '').trim(),
    ref: String(raw.source.ref ?? '').trim(),
    subpath: String(raw.source.subpath ?? '').trim()
  } : null;
  return { ok: true, manifest: { id: check.id, name, version, categories, source } };
}

/**
 * 从 memes/ 下的相对路径拿分类名（第一段目录）。
 *
 * @param {string} rel `memes/<分类>/<文件>` 去掉 `memes/` 之后的部分，用 / 分隔
 * @returns {string} 分类名；直接躺在 memes/ 根下的图归入「默认分类」
 */
export function packCategoryOf(rel) {
  const parts = String(rel ?? '').split('/').filter(Boolean);
  return parts.length >= 2 ? parts[0] : '默认分类';
}

/**
 * 解析 semantic_metadata.json 的 images 表（v1/v2 都认）。
 *
 * v2：{ schema_version, images: { "<分类>/<文件>": { caption, tags: [...] } } }
 * v1：{ images: { ... } } 或直接就是 { "<路径>": {...} }（老包）
 *
 * @param {object} raw 解析后的 JSON
 * @returns {Record<string, { caption: string, tags: string[] }>}
 */
export function parseSemanticMeta(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const table = raw.images && typeof raw.images === 'object' && !Array.isArray(raw.images) ? raw.images : raw;
  for (const [rel, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const key = String(rel ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
    if (!key) continue;
    const caption = String(value.caption ?? value.manual_caption ?? value.auto_caption ?? '').trim();
    const rawTags = Array.isArray(value.tags) ? value.tags : Array.isArray(value.manual_tags) ? value.manual_tags : Array.isArray(value.auto_tags) ? value.auto_tags : [];
    const tags = rawTags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8);
    if (!caption && !tags.length) continue;
    out[key] = { caption, tags };
  }
  return out;
}

/**
 * 表情包分类目录名 → SurfCore 的 20 类情绪。
 *
 * 桌面端 dsh-meme 的图库（大肥鱼 2.0、DeepSeek娘 等）用的是一套自己的分类词：
 * `angry / confused / happy / shy / sad / daily / sleep / surprised / like / sigh /
 * givemoney / work / morning / see / baka / color / cpu / fool / meow / reply / speechless`。
 * 其中一部分和 SurfCore 同名，另一部分只有这层映射能对上——不映射的话 239 张图全落进
 * neutral，聊天时「按情绪配图」就挑不中它们（2026-11-02 实测：1145 条里 1079 条是 neutral）。
 *
 * 映射原则：宁可粗，也不要散。选**最接近的 SurfCore 情绪**，找不到就用 neutral；
 * 另外给非情绪分类留一句中文标签，让 content 不至于显示一个 `daily`。
 */
const CATEGORY_ALIASES = {
  confused: 'speechless',
  sleep: 'tired',
  surprised: 'surprise',
  like: 'cute',
  sigh: 'speechless',
  work: 'tired',
  morning: 'happy',
  baka: 'tease',
  fool: 'tease',
  meow: 'cute',
  cpu: 'speechless',
  givemoney: 'neutral',
  daily: 'neutral',
  see: 'neutral',
  color: 'neutral',
  reply: 'neutral'
};

const CATEGORY_LABELS = {
  daily: '日常',
  givemoney: '要钱',
  work: '上班',
  morning: '早安',
  see: '看看',
  color: '颜文字',
  cpu: '烧脑',
  reply: '回复',
  fool: '笨蛋',
  baka: '笨蛋',
  meow: '喵',
  confused: '疑惑',
  sleep: '困了',
  surprised: '惊讶',
  like: '喜欢',
  sigh: '叹气'
};

/**
 * 分类目录名 → { key, label }。
 *
 * @param {string} category 目录名（如 `angry` / `生气` / `daily`）
 * @returns {{ key: string, label: string }} key 为 SurfCore 情绪键（可能为空串）
 */
export function categoryEmotionOf(category) {
  const raw = String(category ?? '').trim();
  if (!raw) return { key: '', label: '' };
  const lower = raw.toLowerCase();
  const direct = normalizeEmotionKey(raw);
  if (direct) return { key: direct, label: emotionLabel(direct) };
  const alias = CATEGORY_ALIASES[lower] || '';
  const key = alias && normalizeEmotionKey(alias) ? normalizeEmotionKey(alias) : '';
  return { key, label: CATEGORY_LABELS[lower] || raw };
}

/**
 * 把「包 + 一张图 + 语义标注」映射成 SurfCore 表情条目的**草稿**（不含 id/no/url）。
 *
 * 情绪怎么来：优先用标注文字（caption + tags + 分类名）过一遍本仓库的
 * `detectEmotions()`；一个字都没命中就落到 neutral，让桥接后续按使用情况再修正。
 *
 * @param {object} args
 * @param {{ id: string, name: string }} args.pack
 * @param {string} args.rel       `memes/` 之下的相对路径（/ 分隔）
 * @param {{ caption?: string, tags?: string[] }} [args.meta]
 * @param {string} [args.categoryDescription]
 * @param {(text: string) => Array<{ key: string }>} [args.detectEmotions]
 * @returns {{ content: string, keywords: string[], emotion: string, tags: string[], desc: string }}
 */
export function stickerDraftFromMeme(args = {}) {
  const rel = String(args.rel ?? '').replace(/\\/g, '/');
  const category = packCategoryOf(rel);
  const packName = String(args.pack?.name ?? args.pack?.id ?? '表情包').trim();
  const caption = String(args.meta?.caption ?? '').trim();
  const metaTags = Array.isArray(args.meta?.tags) ? args.meta.tags.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
  const catDesc = String(args.categoryDescription ?? '').trim();
  // 描述优先级：AI 标注的 caption > 分类描述 > 分类名。
  // 分类描述通常是一句「什么时候用」（如「早安问候专用（UTC+8 06:00-10:00）」），
  // 比光秃秃的分类名更像一条能挑图的说明。
  //
  // 分类目录名常常直接就是情绪（dsh-meme 的包用 `angry/`、`happy/`、`daily/` 这种英文目录，
  // 社区的 AstrBot 包也有用中文 `生气/` 的）。这种情况优先把它归一化成 SurfCore 的 20 类情绪，
  // 描述用中文标签，而不是把 `angry` 原样塞进 content——否则聊天时按情绪挑图永远匹配不上。
  const catKey = categoryEmotionOf(category);
  const content = (caption || catDesc || catKey.label || category).slice(0, 120);
  const keywords = [...new Set([...metaTags, category, catKey.label].filter(Boolean))].slice(0, 8);
  let emotion = catKey.key || 'neutral';
  if (typeof args.detectEmotions === 'function') {
    try {
      const hits = args.detectEmotions([caption, ...metaTags, category, catDesc].filter(Boolean).join(' '));
      if (Array.isArray(hits) && hits.length && hits[0]?.key) emotion = String(hits[0].key);
    } catch {
      // 情绪推断失败不影响导入：落到分类目录的情绪（没有就 neutral），后面还能用 qq_sticker_note 补。
    }
  }
  const tags = [...new Set([packName, category, 'meme-pack'].filter(Boolean))].slice(0, 20);
  return { content, keywords, emotion, tags, desc: content };
}

/**
 * 生成 SurfCore 表情条目的稳定 id：`local-pack-<packId>-<slug>`。
 *
 * slug 取相对路径（去掉扩展名），非字母数字压成 `-`，这样同一张图重复导入会撞同一个 id，
 * 桥接就能按 id 去重（而不是靠 md5 再算一遍）。
 *
 * @param {string} packId
 * @param {string} rel
 * @returns {string}
 */
export function packStickerId(packId, rel) {
  const base = String(rel ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `local-pack-${String(packId ?? 'pack').toLowerCase()}-${base || 'item'}`;
}

/**
 * 校验并整理一个「待导入清单」：桥接扫描完目录后调用，保证写库前字段干净。
 *
 * @param {Array<object>} items 每项 { id, rel, category, content, keywords, emotion, tags }
 * @param {{ limit?: number }} [opts]
 * @returns {{ ok: true, items: object[] } | { ok: false, code: string, error: string, hint: string }}
 */
export function normalizeImportItems(items, opts = {}) {
  if (!Array.isArray(items)) {
    return { ok: false, code: 'PACK_IMPORT_SHAPE', error: '导入清单必须是数组', hint: '这是内部错误：桥接应该传入扫包结果' };
  }
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    const content = String(raw.content ?? '').trim().slice(0, 120);
    if (!content) continue;
    seen.add(id);
    out.push({
      id,
      rel: String(raw.rel ?? '').replace(/\\/g, '/'),
      category: String(raw.category ?? '').trim().slice(0, 40) || '默认分类',
      content,
      keywords: (Array.isArray(raw.keywords) ? raw.keywords : []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8),
      emotion: String(raw.emotion ?? 'neutral').trim() || 'neutral',
      tags: (Array.isArray(raw.tags) ? raw.tags : []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20),
    });
    if (out.length >= limit) break;
  }
  return { ok: true, items: out };
}
