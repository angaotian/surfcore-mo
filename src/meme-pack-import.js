// 资源包导入的**落盘**部分（扫描目录、复制图片、产出待入库条目）。
//
// 为什么单独一个文件：桥接里的 importMemePackDir 得能单测。
// 桥接是长驻服务、stickerEntries 是它的内存副本，把 IO 直接写死在 16k 行的 bridge.js 里
// 就只能起进程做集成测试。这里把「文件系统」与「表情库」都做成注入的依赖，
// 测试里传临时目录 + 内存数组，桥接里传 STATE_DIR + 真 findSticker/save 即可。
//
// 单写者不变：本模块**不自己保存**，只把新增条目交回去，由调用方（桥接）调 onSave()。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  normalizePackManifest,
  parseSemanticMeta,
  stickerDraftFromMeme,
  packStickerId,
  packCategoryOf,
  PACK_MANIFEST_FILE,
  PACK_MEMES_DIR,
  PACK_MEMES_DATA_FILE,
  PACK_SEMANTIC_FILE,
  PACK_IMAGE_EXTS
} from './meme-pack.js';

const MAX_FILES = 400;
const MAX_BYTES = 4 * 1024 * 1024;

function readJsonIfAny(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectImages(root) {
  const relPaths = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(childAbs, childRel); continue; }
      if (!ent.isFile()) continue;
      if (!PACK_IMAGE_EXTS.includes(path.extname(ent.name).toLowerCase())) continue;
      relPaths.push(childRel);
    }
  };
  walk(root, '');
  return relPaths;
}

/**
 * 扫描一个 AstroBot 资源包目录，复制图片并产出待入库条目。
 *
 * @param {string} dirInput 资源包根目录（含 manifest.json）
 * @param {object} deps
 * @param {string} deps.stateDir  SurfCore 的 state 目录（图片复制到 <state>/sticker-files/<packId>/）
 * @param {Array<object>} deps.entries 现有表情条目（用于 id/md5 去重与编号递增）
 * @param {(entries: Array<object>, id: string) => object|null} deps.findSticker
 * @param {(entries: Array<object>, added: Array<object>) => void} deps.onSave 有新条目时调用（落盘）
 * @param {(text: string) => Array<{key: string}>} deps.detectEmotions
 * @param {(msg: string, ...rest: unknown[]) => void} [deps.log]
 * @returns {object} `{ ok:true, pack, dir, added, skipped, skippedDetail, total, entries }` 或 `{ ok:false, code, error, hint }`
 */
export function importMemePackDir(dirInput, deps = {}) {
  const raw = String(dirInput ?? '').trim();
  if (!raw) return { ok: false, code: 'PACK_DIR_EMPTY', error: '没给资源包目录', hint: '传一个包含 manifest.json 的目录绝对路径' };
  const dir = path.resolve(raw);
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return { ok: false, code: 'PACK_DIR_NOT_DIR', error: `不是目录：${dir}`, hint: '指向资源包根目录（里面有 manifest.json 和 memes/）' };
    }
  } catch {
    return { ok: false, code: 'PACK_DIR_MISSING', error: `目录不存在：${dir}`, hint: '先确认这个包已经下载/解压到本机' };
  }

  let manifestRaw;
  try {
    manifestRaw = readJsonIfAny(path.join(dir, PACK_MANIFEST_FILE));
    if (manifestRaw === null) throw new Error('文件不存在或不是 JSON');
  } catch (error) {
    return { ok: false, code: 'PACK_MANIFEST_UNREADABLE', error: `读不到 manifest.json：${error?.message ?? error}`, hint: '确认这是 meme_manager 的资源包，且没有被压缩工具改坏' };
  }
  const normalized = normalizePackManifest(manifestRaw, { fallbackId: path.basename(dir) });
  if (!normalized.ok) return normalized;
  const pack = normalized.manifest;

  const memesData = readJsonIfAny(path.join(dir, PACK_MEMES_DATA_FILE)) || {};
  const semantic = parseSemanticMeta(readJsonIfAny(path.join(dir, PACK_SEMANTIC_FILE)));
  const memesRoot = path.join(dir, PACK_MEMES_DIR);
  const relPaths = collectImages(memesRoot);
  if (!relPaths.length) {
    return { ok: false, code: 'PACK_EMPTY', error: 'memes/ 里没有找到图片', hint: '资源包应有 memes/<分类>/<图片>；空包不用导' };
  }

  const entries = Array.isArray(deps.entries) ? deps.entries : [];
  const stateDir = String(deps.stateDir ?? '');
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const detectEmotions = typeof deps.detectEmotions === 'function' ? deps.detectEmotions : null;
  // 老条目（手工塞进来的大肥鱼等）只有 file:// 路径、md5 是空串，
  // 不补 hash 的话同一个图换个包 id 导进来就会重复入库。这里顺手补一次，
  // 补过的条目由调用方随 onSave/save 一起落盘（repaired 计数告诉它要不要存）。
  const known = new Set();
  let repaired = 0;
  for (const entry of entries) {
    const hashed = String(entry?.md5 ?? '').toLowerCase();
    if (hashed) { known.add(hashed); continue; }
    const url = String(entry?.url ?? '');
    if (!url.startsWith('file://')) continue;
    try {
      const file = fileURLToPath(url);
      const digest = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
      entry.md5 = digest;
      known.add(digest);
      repaired += 1;
    } catch {
      // 文件被删了就跳过：不阻断导入，只是这张图不参与去重
    }
  }
  let nextNo = entries.reduce((max, e) => Math.max(max, Number(e?.no) || 0), 0) + 1;
  const added = [];
  const skipped = [];

  for (const rel of relPaths.slice(0, MAX_FILES)) {
    const id = packStickerId(pack.id, rel);
    if (typeof deps.findSticker === 'function' && deps.findSticker(entries, id)) { skipped.push({ rel, reason: 'exists' }); continue; }
    const srcAbs = path.join(memesRoot, rel.split('/').join(path.sep));
    let buf;
    try {
      const stat = fs.statSync(srcAbs);
      if (stat.size > MAX_BYTES) { skipped.push({ rel, reason: 'too-large' }); continue; }
      buf = fs.readFileSync(srcAbs);
    } catch {
      skipped.push({ rel, reason: 'unreadable' });
      continue;
    }
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (known.has(md5)) { skipped.push({ rel, reason: 'duplicate' }); continue; }
    // 复制进自己的表情目录：包被删/被搬走也不影响她继续发（file:// 外链会失效）。
    const destAbs = path.join(stateDir, 'sticker-files', pack.id, rel.split('/').join(path.sep));
    try {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.writeFileSync(destAbs, buf);
    } catch (error) {
      skipped.push({ rel, reason: 'write-failed' });
      log('导入表情包写文件失败:', rel, error?.message ?? error);
      continue;
    }
    known.add(md5);
    const category = packCategoryOf(rel);
    const draft = stickerDraftFromMeme({
      pack,
      rel,
      meta: semantic[rel] || semantic[`${PACK_MEMES_DIR}/${rel}`] || {},
      categoryDescription: typeof memesData[category] === 'string' ? memesData[category] : '',
      detectEmotions
    });
    const now = new Date().toISOString();
    added.push({
      id,
      no: nextNo++,
      resId: id,
      url: `file:///${destAbs.replace(/\\/g, '/')}`,
      md5,
      desc: draft.desc,
      localNote: '',
      emotion: draft.emotion,
      emotionAlt: [],
      content: draft.content,
      keywords: draft.keywords,
      tags: draft.tags,
      usage: '',
      source: 'pack',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: now,
      updatedAt: now
    });
  }

  const nextEntries = [...entries, ...added];
  if (added.length && typeof deps.onSave === 'function') deps.onSave(nextEntries);
  return {
    ok: true,
    pack: { id: pack.id, name: pack.name, version: pack.version },
    dir,
    added: added.length,
    skipped: skipped.length,
    skippedDetail: skipped.slice(0, 20),
    repaired,
    total: nextEntries.length,
    entries: nextEntries
  };
}
