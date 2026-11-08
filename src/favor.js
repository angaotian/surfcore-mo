/**
 * 关系系统（v2：好感 + 亲密 + 阶段），0–100 两个轴。
 *
 * 来源：小黑盒帖子《安装插件给"小鲸鱼"deepseek完整的一生》里的 EmotionAI Pro 4.2.9
 * （"给角色装一套会成长的情感与关系：好感度越高，越会记住并主动提起与你相处的细节；
 *   好感度低时只记得冲突"）。SurfCore 这边不装那个插件，只借它的设计，自己实现。
 * 设计稿与取舍见 docs/guides/RELATIONSHIP.md。
 *
 * 设计约束（为什么是现在这个样子）：
 *   · **单写者**：只有桥接进程写 `state/favor/<角色>.json`；插件（设置页）只读，
 *     两个进程同时写 JSON 是 PITFALLS #14 的老坑。
 *   · **按角色分文件**：换人格卡不能继承上一个角色的关系值（PITFALLS #29 同款事故）。
 *   · **确定性**：不让模型自己打分（模型每轮写一个数字既贵又漂移），
 *     只用可解释的信号（道谢 / 情绪 / 冲突 / 私聊 / 深度互动 / 刷屏限额）加减，
 *     全部记进 events，设置页能看见「为什么变成这个分」。模型只负责读（prompt 里那几行）。
 *   · **两条轴分工**：`score`（好感）是"喜不喜欢"，`intimacy`（亲密）是"有多熟"。
 *     常聊天能刷好感，但刷不出亲密——亲密只认深度互动，且每轮 +2 / 每天 +8 封顶。
 *     升阶段要同时过 composite 阈值和亲密门槛（见 STAGES），这是"聊得多 ≠ 关系深"的落点。
 *   · **回归中性**：好感衰减是往 50 回归，不是往 0 掉 —— 久不联系是「变淡」，不是「恨上」。
 *     亲密不这样衰减（掉了像失忆），只在过 60 之后每天软降 0.2，逼着关系维持。
 *   · **降档很慢**：低于阈值先挂 7 天（downgradeDays），到点才降一档；`stagePeak` 永不回退，
 *     读盘时用它兜底，防止一次吵架把档案打回"刚认识"。
 */

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const NEUTRAL = 50;
const MIN_INTIMACY = 0;
const MAX_INTIMACY = 100;
const DAY_MS = 86400000;

/** 好感分档：只用于展示（设置页颜色/标签），v2 的关系判断改看 stage。 */
const LEVELS = [
  { min: 85, key: 'intimate', label: '很亲近' },
  { min: 75, key: 'close', label: '亲近' },
  { min: 60, key: 'familiar', label: '熟悉' },
  { min: 40, key: 'normal', label: '普通' },
  { min: 25, key: 'distant', label: '生疏' },
  { min: 10, key: 'cold', label: '冷淡' },
  { min: -Infinity, key: 'hostile', label: '敌意' },
];

/**
 * 关系阶段。权重随阶段变：生疏期看"喜不喜欢"，亲近之后看"有多熟"。
 * `threshold` 是升到这一档的 composite 门槛，`gate` 是同时要过的亲密门槛。
 */
const STAGES = [
  { key: 'stranger', label: '生疏', threshold: 0, gate: 0, favorW: 0.7, intimacyW: 0.3 },
  { key: 'familiar', label: '熟识', threshold: 25, gate: 20, favorW: 0.5, intimacyW: 0.5 },
  { key: 'close', label: '亲近', threshold: 55, gate: 40, favorW: 0.35, intimacyW: 0.65 },
  { key: 'bond', label: '默契', threshold: 80, gate: 60, favorW: 0.4, intimacyW: 0.6 },
];

/** 判档探针：先定带再称重，避免权重本身把分数推过阈值（自激）。 */
const PROBE_FAVOR = 0.6;
const PROBE_INTIMACY = 0.4;

/** 信号词表。宁可少收录也不要误伤：「烦」单独出现太常见，只收明确的攻击/示好。 */
const WARM_RE = /(谢谢|謝谢|感谢|谢啦|多谢|辛苦了|爱你|喜欢你|好可爱|可爱|厉害|好棒|真棒|牛啊|太牛|好听|好玩|有意思|靠谱|相信你)/;
const COLD_RE = /(滚(?!动)|傻逼|沙比|煞笔|去死|恶心|烦死|闭嘴|蠢|废物|垃圾玩意|讨厌你|骗子|骗人|别烦我|无语死)/;
/** 亲密信号：共同约定 / 道歉和好。情绪浓度复用 memory-card 的 detectEmotionScore。 */
const FUTURE_RE = /(以后|下次|改天|回头|一起|约好|见面|打电话|等你|明天见|下周|过年|生日)/;
const SORRY_RE = /(对不起|抱歉|是我不好|原谅|和好|别生气)/;
/** 两条消息间隔在这之内才算「同一段对话」，用来判断「聊得连续」。 */
const DEEP_GAP_MS = 10 * 60000;

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期键（YYYY-MM-DD）。用本地时区而不是 UTC：深夜/跨天的判断按她所在时区。 */
function localDayKey(at) {
  const d = new Date(Number(at) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isPrevDay(prevKey, nextKey) {
  const prev = Date.parse(`${prevKey}T00:00:00`);
  const next = Date.parse(`${nextKey}T00:00:00`);
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
  return Math.round((next - prev) / DAY_MS) === 1;
}

function daysBetween(from, to) {
  const a = Number(from) || 0;
  const b = Number(to) || 0;
  if (!a || !b || b <= a) return 0;
  return Math.floor((b - a) / DAY_MS);
}

/** 配置归一化：缺省值都写在这里，设置页只管展示，不再各处 if。 */
export function normalizeFavorConfig(input = {}) {
  const src = asObject(input);
  return {
    enabled: src.enabled !== false,
    start: clamp(src.start ?? NEUTRAL, MIN_SCORE, MAX_SCORE),
    // 每条普通消息的增量（同一人每小时最多计 maxPerHour 条，防刷屏刷分）
    perMessage: clamp(src.perMessage ?? 0.15, 0, 2),
    maxPerHour: clamp(src.maxPerHour ?? 10, 1, 200),
    // 私聊 / 被 @ / 被引用：权重比普通消息高
    directBonus: clamp(src.directBonus ?? 0.5, 0, 5),
    warmDelta: clamp(src.warmDelta ?? 1.5, 0, 10),
    coldDelta: clamp(src.coldDelta ?? 3, 0, 20),
    // 每天朝中性回归多少（久不联系变淡，但不会变恨）
    decayPerDay: clamp(src.decayPerDay ?? 0.5, 0, 10),
    // 亲密轴（v2）。关掉等于退回 v1：不记亲密、不带阶段。
    intimacy: src.intimacy !== false,
    intimacyDayCap: clamp(src.intimacyDayCap ?? 8, 0, 100),
    intimacyColdDelta: clamp(src.intimacyColdDelta ?? 3, 0, 20),
    // 软顶：亲密过 intimacySoftCap 之后每天回落这么多（不衰减到底，是不让它随随便便满 100）
    intimacySoftCap: clamp(src.intimacySoftCap ?? 60, 0, 100),
    intimacyDecayPerDay: clamp(src.intimacyDecayPerDay ?? 0.2, 0, 5),
    // 降档迟滞：阈值往下让 downHysteresis 分；连续 downgradeDays 天在下面才真降
    downHysteresis: clamp(src.downHysteresis ?? 5, 0, 20),
    downgradeDays: clamp(src.downgradeDays ?? 7, 1, 90),
    // prompt 里最多列几个人 / 分数在该区间外才写「备注语气」
    promptTop: Math.round(clamp(src.promptTop ?? 6, 1, 20)),
    keepEvents: Math.round(clamp(src.keepEvents ?? 30, 0, 200)),
    maxPeople: Math.round(clamp(src.maxPeople ?? 500, 10, 5000)),
  };
}

export function levelOf(score) {
  const s = clamp(score, MIN_SCORE, MAX_SCORE);
  return LEVELS.find((item) => s >= item.min);
}

export function stageIndex(key) {
  const idx = STAGES.findIndex((s) => s.key === String(key ?? ''));
  return idx >= 0 ? idx : 0;
}

export function stageOf(key) {
  return STAGES[stageIndex(key)];
}

/** 角色名 → 文件名：只留安全字符，避免路径穿越/Windows 保留名。 */
export function favorFileName(role) {
  const raw = String(role ?? '').trim() || 'default';
  const safe = raw.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 60);
  return `${safe || 'default'}.json`;
}

export function emptyStore(role = '') {
  return { version: 2, role: String(role ?? ''), updatedAt: 0, people: {} };
}

/** 老库估算亲密：v1 只记了事件条数，按条数保守折算，不凭空给 0 也不给满。 */
function estimateIntimacy(events, firstAt, now) {
  const n = Array.isArray(events) ? events.length : 0;
  const days = daysBetween(firstAt, now);
  return round1(clamp(n * 0.1 + days * 0.2, 0, 40));
}

function normalizePerson(userId, value, { now } = {}) {
  const item = asObject(value);
  const firstAt = Number(item.firstAt) || 0;
  const lastAt = Number(item.lastAt) || 0;
  const events = (Array.isArray(item.events) ? item.events : [])
    .map((e) => asObject(e))
    .filter((e) => Number.isFinite(Number(e.at)))
    .map((e) => ({
      at: Number(e.at),
      delta: round1(Number(e.delta) || 0),
      why: String(e.why ?? '').slice(0, 40),
      note: String(e.note ?? '').slice(0, 80),
      axis: e.axis === 'intimacy' ? 'intimacy' : 'favor',
    }))
    .slice(-200);
  const score = round1(clamp(item.score ?? NEUTRAL, MIN_SCORE, MAX_SCORE));
  // v1 → v2 迁移：老文件没有 intimacy/stage，用聊天量估亲密，阶段按分数反推（不信任何字符串）。
  const hasIntimacy = item.intimacy !== undefined && item.intimacy !== null && Number.isFinite(Number(item.intimacy));
  const intimacy = hasIntimacy
    ? round1(clamp(item.intimacy, MIN_INTIMACY, MAX_INTIMACY))
    : estimateIntimacy(events, firstAt, now);
  const person = {
    userId: String(userId),
    name: String(item.name ?? '').slice(0, 40),
    score,
    intimacy,
    stage: 'stranger',
    stageSince: Number(item.stageSince) || lastAt || firstAt || now,
    stagePeak: 'stranger',
    stageLowSince: Number(item.stageLowSince) || 0,
    composite: 0,
    deepStreak: Math.max(0, Math.round(Number(item.deepStreak) || 0)),
    deepDays: {
      last: String(asObject(item.deepDays).last ?? '').slice(0, 10),
      streak: Math.max(0, Math.round(Number(asObject(item.deepDays).streak) || 0)),
    },
    dayBudget: {
      date: String(asObject(item.dayBudget).date ?? '').slice(0, 10),
      intimacy: round1(Math.max(0, Number(asObject(item.dayBudget).intimacy) || 0)),
    },
    firstAt,
    lastAt,
    lastDeltaAt: Number(item.lastDeltaAt) || 0,
    hourBucket: {
      at: Number(asObject(item.hourBucket).at) || 0,
      n: Number(asObject(item.hourBucket).n) || 0,
    },
    events,
  };
  // 阶段自愈：只认 STAGES 里的字符串；能认就以它为准（并至少信任到上一档），
  // 认不出来就用分数反推。绝不因为存档脏了就把人打回"刚认识"。
  const saved = String(item.stage ?? '');
  const peak = String(item.stagePeak ?? '');
  const savedIdx = STAGES.findIndex((s) => s.key === saved);
  const peakIdx = STAGES.findIndex((s) => s.key === peak);
  if (savedIdx >= 0) {
    person.stage = saved;
    person.stagePeak = STAGES[Math.max(savedIdx, peakIdx >= 0 ? peakIdx : 0)].key;
  }
  return person;
}

/** 归一化一份存盘（旧版本/手改坏了的文件都能救回来，救不回来就返回空库）。 */
export function normalizeStore(raw, { role = '', now = Date.now() } = {}) {
  const src = asObject(raw);
  const store = emptyStore(src.role ?? role);
  store.version = 2;
  store.updatedAt = Number(src.updatedAt) || 0;
  for (const [userId, value] of Object.entries(asObject(src.people))) {
    const item = asObject(value);
    if (!/^\d{1,20}$/.test(String(userId))) continue;
    store.people[userId] = normalizePerson(userId, item, { now });
  }
  // 迁完立刻把 composite 补上，设置页/桥接读到的第一眼就是一致的
  for (const person of Object.values(store.people)) settleStage(person, { cfg: {}, now });
  return store;
}

function ensurePerson(store, userId, name, at) {
  const id = String(userId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) return null;
  let person = store.people[id];
  if (!person) {
    person = {
      userId: id,
      name: String(name ?? '').slice(0, 40),
      score: NEUTRAL,
      intimacy: MIN_INTIMACY,
      stage: 'stranger',
      stageSince: at,
      stagePeak: 'stranger',
      stageLowSince: 0,
      composite: 0,
      deepStreak: 0,
      deepDays: { last: '', streak: 0 },
      dayBudget: { date: '', intimacy: 0 },
      firstAt: at,
      lastAt: at,
      lastDeltaAt: 0,
      hourBucket: { at: 0, n: 0 },
      events: [],
    };
    store.people[id] = person;
    if (store.version !== 2) store.version = 2;
  }
  if (name) person.name = String(name).slice(0, 40);
  return person;
}

/**
 * 亲密增量（纯函数，就地改 person）。只认"深度"，不认"在场"：
 * 聊得连续 / 说了很多 / 情绪很浓 / 共同约定 / 道歉和好 / 深夜私聊 / 连着好几天。
 * 每轮 +2 封顶，每天 intimacyDayCap 封顶；冲突是负向，不受日额度限制。
 */
export function noteIntimacy(person, {
  text = '',
  at = Date.now(),
  isGroup = false,
  emotionScore = 0,
  cfg,
  prevAt = 0,
} = {}) {
  const conf = normalizeFavorConfig(cfg);
  if (!conf.intimacy) return { delta: 0, why: '' };
  const s = String(text ?? '');
  const dayKey = localDayKey(at);
  if (!person.dayBudget || person.dayBudget.date !== dayKey) person.dayBudget = { date: dayKey, intimacy: 0 };
  const used = Number(person.dayBudget.intimacy) || 0;
  const left = Math.max(0, conf.intimacyDayCap - used);
  const reasons = [];
  let delta = 0;

  if (COLD_RE.test(s)) {
    delta -= conf.intimacyColdDelta;
    reasons.push('冲突');
  }

  let deep = 0;
  const gap = Number(at) - (Number(prevAt) || 0);
  person.deepStreak = gap > 0 && gap <= DEEP_GAP_MS ? (Number(person.deepStreak) || 1) + 1 : 1;
  // 连续聊天只给一次：从第 3 条起算「聊得连续」，之后不再重复加分
  if (person.deepStreak === 3) { deep += 1; reasons.push('聊得连续'); }
  if (s.length >= 40) { deep += 1; reasons.push('说了很多'); }
  if (Number(emotionScore) >= 16) { deep += 1; reasons.push('情绪很浓'); }
  if (FUTURE_RE.test(s)) { deep += 2; reasons.push('共同约定'); }
  if (SORRY_RE.test(s)) { deep += 2; reasons.push('道歉和好'); }
  const hour = new Date(Number(at) || Date.now()).getHours();
  if (!isGroup && (hour >= 23 || hour < 3)) { deep += 1; reasons.push('深夜私聊'); }
  if (deep > 0) {
    // 连续天数只在"确实有深度信号"的日子推进，避免每天一句「水」也能攒出 streak
    const streak = person.deepDays && typeof person.deepDays === 'object' ? person.deepDays : { last: '', streak: 0 };
    if (streak.last !== dayKey) {
      streak.streak = streak.last && isPrevDay(streak.last, dayKey) ? (Number(streak.streak) || 0) + 1 : 1;
      streak.last = dayKey;
      person.deepDays = streak;
    }
    if (Number(streak.streak) >= 3) { deep += 1; reasons.push('连着好几天'); }
    delta += Math.min(2, deep);
  }

  if (delta > 0) delta = Math.min(delta, left);
  if (delta === 0) return { delta: 0, why: reasons.join('/') };
  person.intimacy = round1(clamp((Number(person.intimacy) || 0) + delta, MIN_INTIMACY, MAX_INTIMACY));
  if (delta > 0) person.dayBudget.intimacy = round1(used + delta);
  return { delta: round1(delta), why: reasons.join('/') };
}

/**
 * 解析阶段（纯查询，不改 person）。带迟滞：已经在这一档的人，往下让 downHysteresis 分才掉带；
 * 从没到过的档，必须实打实过阈值。返回的 composite 按所在档的权重算。
 */
export function resolveStage(person, { cfg, now = Date.now() } = {}) {
  const conf = normalizeFavorConfig(cfg);
  const favor = round1(clamp(person?.score ?? NEUTRAL, MIN_SCORE, MAX_SCORE));
  const intimacy = round1(clamp(person?.intimacy ?? MIN_INTIMACY, MIN_INTIMACY, MAX_INTIMACY));
  const curIdx = stageIndex(person?.stage);
  const probe = PROBE_FAVOR * favor + PROBE_INTIMACY * intimacy;
  let band = 0;
  for (let i = 1; i < STAGES.length; i += 1) {
    const thr = STAGES[i].threshold - (i <= curIdx ? conf.downHysteresis : 0);
    if (probe >= thr) band = i;
  }
  const w = STAGES[band];
  const composite = round1(w.favorW * favor + w.intimacyW * intimacy);
  // 「她实际处在哪一档」看已经结算的 stage；探针只决定这次能用哪套权重、以及要不要试着升档。
  // 两者分开，才能表达「好感很高但还不熟」：能升档的势能有了，门槛没到就先卡着（不是标签写亲近、实际还是生疏）。
  const settledIdx = Math.max(0, Math.min(curIdx, STAGES.length - 1));
  const settled = STAGES[settledIdx];
  return {
    index: band,
    bandIndex: band,
    bandKey: w.key,
    bandLabel: w.label,
    key: settled.key,
    label: settled.label,
    threshold: settled.threshold,
    gate: settled.gate,
    favor,
    intimacy,
    probe: round1(probe),
    composite,
    days: daysBetween(person?.firstAt, now),
  };
}

/**
 * 结算阶段（写 person）。升级要同时过 composite 阈值和亲密门槛；没过就卡住（阶段不动、好感照常记）。
 * 降档必须连续 downgradeDays 天低于「阈值 − 迟滞」；降也只降一档，stagePeak 不回退。
 */
export function settleStage(person, { cfg, now = Date.now() } = {}) {
  const conf = normalizeFavorConfig(cfg);
  const info = resolveStage(person, { cfg: conf, now });
  const curIdx = stageIndex(person?.stage);
  const peakIdx = Math.max(stageIndex(person?.stagePeak), curIdx);
  person.composite = info.composite;

  if (info.index > curIdx) {
    const target = STAGES[info.index];
    const gated = info.intimacy >= target.gate && info.composite >= target.threshold;
    if (gated) {
      person.stage = target.key;
      person.stageSince = now;
      person.stageLowSince = 0;
      person.stagePeak = STAGES[Math.max(peakIdx, info.index)].key;
      return { ...info, changed: true, blocked: false, downgraded: false };
    }
    return { ...info, changed: false, blocked: true, downgraded: false };
  }

  if (info.index < curIdx) {
    const downThr = STAGES[curIdx].threshold - conf.downHysteresis;
    if (info.composite < downThr) {
      if (!person.stageLowSince) person.stageLowSince = now;
      const waited = Number(now) - Number(person.stageLowSince);
      if (waited >= conf.downgradeDays * DAY_MS) {
        person.stage = STAGES[Math.max(0, curIdx - 1)].key;
        person.stageSince = now;
        person.stageLowSince = 0;
        return { ...info, changed: true, blocked: false, downgraded: true };
      }
      return { ...info, changed: false, blocked: false, downgraded: false, pendingDowngrade: true };
    }
  }

  person.stageLowSince = 0;
  return { ...info, changed: false, blocked: false, downgraded: false };
}

/** 打分并记录。返回 { delta, why, intimacyDelta, stage }，纯函数（store 原地改，调用方负责落盘）。 */
export function observeMessage(store, {
  userId,
  name = '',
  text = '',
  at = Date.now(),
  direct = false,
  isGroup = false,
  isOwner = false,
  emotionScore = 0,
  cfg,
} = {}) {
  const conf = normalizeFavorConfig(cfg);
  const person = ensurePerson(store, userId, name, at);
  if (!person) return { delta: 0, why: 'skip', intimacyDelta: 0 };
  const prevAt = Number(person.lastAt) || 0;
  person.lastAt = at;
  if (!person.firstAt) person.firstAt = at;
  const s = String(text ?? '');
  let delta = 0;
  const reasons = [];

  // 1) 基础：说话本身算「在场」，但每人每小时最多计 maxPerHour 条，避免刷屏刷分。
  const hour = Math.floor(at / 3600000);
  if (person.hourBucket.at !== hour) person.hourBucket = { at: hour, n: 0 };
  if (person.hourBucket.n < conf.maxPerHour) {
    person.hourBucket.n += 1;
    delta += conf.perMessage;
    reasons.push('在场');
  }
  // 2) 私聊 / @ / 引用自己
  if (direct) { delta += conf.directBonus; reasons.push('直接找你'); }
  // 3) 情绪浓度（memory-card 的 EMOTION_* 词表）：情绪越强越容易被记住
  if (emotionScore > 0) { delta += Math.min(1, emotionScore / 8); reasons.push('有情绪'); }
  // 4) 示好 / 冲突：一次就够重，别把一句「谢谢」放大成半条命
  if (WARM_RE.test(s)) { delta += conf.warmDelta; reasons.push('示好'); }
  if (COLD_RE.test(s)) { delta -= conf.coldDelta; reasons.push('冲突'); }
  // 主人身份不额外加成分（避免「管理员一说话就满好感」的假亲近），只记一条备注
  if (isOwner) reasons.push('主人');

  if (delta !== 0) {
    person.score = round1(clamp(person.score + delta, MIN_SCORE, MAX_SCORE));
    person.lastDeltaAt = at;
    person.events.push({ at, delta: round1(delta), why: reasons.join('/') || '变化', note: s.replace(/\s+/g, ' ').slice(0, 60), axis: 'favor' });
    if (person.events.length > conf.keepEvents) person.events.splice(0, person.events.length - conf.keepEvents);
  }

  // 5) 亲密轴：只认深度互动，跟"说了几句话"无关
  const intimacy = noteIntimacy(person, { text: s, at, isGroup, emotionScore, cfg: conf, prevAt });
  if (intimacy.delta !== 0) {
    person.events.push({ at, delta: intimacy.delta, why: intimacy.why || '亲密变化', note: s.replace(/\s+/g, ' ').slice(0, 60), axis: 'intimacy' });
    if (person.events.length > conf.keepEvents) person.events.splice(0, person.events.length - conf.keepEvents);
  }

  const stage = settleStage(person, { cfg: conf, now: at });
  store.updatedAt = at;
  return {
    delta: round1(delta),
    why: reasons.join('/') || '无变化',
    intimacyDelta: intimacy.delta,
    stage: stage.key,
    gated: Boolean(stage.blocked),
  };
}

/** 手动调整（设置页 / 控制台）：delta 可以是负数。 */
export function applyDelta(store, { userId, name = '', delta = 0, why = '手动调整', at = Date.now() } = {}) {
  const person = ensurePerson(store, userId, name, at);
  if (!person) return { ok: false, code: 'FAVOR_USER_ID', error: `用户 id 不合法：${userId}`, hint: '好感度只认 QQ 号（纯数字）' };
  const before = person.score;
  person.score = round1(clamp(person.score + Number(delta || 0), MIN_SCORE, MAX_SCORE));
  person.lastDeltaAt = at;
  person.events.push({ at, delta: round1(person.score - before), why: String(why).slice(0, 40), note: '', axis: 'favor' });
  if (person.events.length > 30) person.events.splice(0, person.events.length - 30);
  settleStage(person, { now: at });
  store.updatedAt = at;
  return { ok: true, before, after: person.score };
}

/**
 * 衰减（每天最多跑一次）：
 *   · 好感朝 50 回归 —— 久不联系是「变淡」；
 *   · 亲密过 softCap 后每天软降 —— 关系要维持，但不会掉到陌生人。
 */
export function decay(store, { now = Date.now(), cfg } = {}) {
  const conf = normalizeFavorConfig(cfg);
  if (!conf.decayPerDay && !conf.intimacyDecayPerDay) return 0;
  let changed = 0;
  for (const person of Object.values(store.people)) {
    const last = Number(person.lastDeltaAt || person.lastAt || 0);
    if (!last) continue;
    const days = Math.floor((now - last) / DAY_MS);
    if (days < 1) continue;
    let touched = false;

    if (conf.decayPerDay) {
      const step = Math.min(Math.abs(person.score - NEUTRAL), conf.decayPerDay * days);
      if (step > 0.05) {
        const dir = person.score > NEUTRAL ? -1 : 1;
        person.score = round1(clamp(person.score + dir * step, MIN_SCORE, MAX_SCORE));
        touched = true;
      }
    }

    const intimacy = Number(person.intimacy) || 0;
    if (conf.intimacyDecayPerDay && intimacy > conf.intimacySoftCap) {
      const step = Math.min(intimacy - conf.intimacySoftCap, conf.intimacyDecayPerDay * days);
      if (step > 0.05) {
        person.intimacy = round1(clamp(intimacy - step, MIN_INTIMACY, MAX_INTIMACY));
        touched = true;
      }
    }

    // 衰减不写 events（否则安静三天的人会被一堆「变淡」刷屏），只挪 lastDeltaAt 的参考点
    person.lastDeltaAt = now;
    settleStage(person, { cfg: conf, now });
    if (touched) changed += 1;
  }
  if (changed) store.updatedAt = now;
  return changed;
}

/** 阶段的一句话语气指导（prompt 用，也复用给设置页）。 */
export function stageHint(stageKey, { favor = NEUTRAL } = {}) {
  const idx = stageIndex(stageKey);
  if (favor <= 25 && idx <= 1) return '只记得冲突和别扭，语气可以淡一点，不用装热络。';
  if (idx >= 2) return '会主动接话、记得对方说过的细节，可以自然提起（不必解释为什么记得）。';
  if (idx === 1) return '可以开玩笑、接梗，但还不到无话不谈。';
  return '客气点，别装熟。';
}

/**
 * prompt 里的关系块。只列「这个会话里的人」，按 composite 从高到低取 top N；
 * 50 分（刚认识）的人不写，避免每次唤醒都塞一串没意义的数字。
 */
export function promptBlock(store, { people = [], cfg, now = Date.now() } = {}) {
  const conf = normalizeFavorConfig(cfg);
  if (!conf.enabled) return '';
  const rows = [];
  for (const { userId, name } of people) {
    const person = store?.people?.[String(userId ?? '')];
    if (!person) continue;
    if (Math.abs(Number(person.score) - NEUTRAL) < 3) continue; // 和刚认识没区别
    const info = resolveStage(person, { cfg: conf, now });
    rows.push({ name: person.name || name || String(userId), info });
  }
  if (!rows.length) return '';
  rows.sort((a, b) => b.info.composite - a.info.composite);
  const top = rows.slice(0, conf.promptTop);
  const lines = top.map((r) => {
    const age = r.info.days >= 60 ? '认识很久'
      : r.info.days >= 14 ? `认识 ${Math.floor(r.info.days / 7)} 周`
        : r.info.days > 0 ? `认识 ${r.info.days} 天` : '刚认识';
    return `· ${r.name} ${r.info.favor}/${r.info.intimacy}（${r.info.label} · ${age}）`;
  });
  const hints = [];
  if (top.some((r) => stageIndex(r.info.key) >= 2)) hints.push(stageHint('close'));
  else if (top.some((r) => stageIndex(r.info.key) === 1)) hints.push(stageHint('familiar'));
  if (top.some((r) => r.info.favor <= 25)) hints.push('对 25 分以下的人：' + stageHint('stranger', { favor: 20 }));
  return `【关系】你此刻对这些人的感觉（好感/亲密 0-100，50/0 = 刚认识，数字不用说出来）：\n${lines.join('\n')}\n${hints.map((h) => `${h}\n`).join('')}`;
}

/** 设置页用的快照（只读，按 composite 排序）。 */
export function snapshot(store, { cfg, now = Date.now() } = {}) {
  const conf = normalizeFavorConfig(cfg);
  const rows = Object.values(store?.people ?? {})
    .map((p) => {
      const info = resolveStage(p, { cfg: conf, now });
      return {
        userId: p.userId,
        name: p.name,
        score: p.score,
        intimacy: info.intimacy,
        composite: info.composite,
        stage: info.key,
        stageLabel: info.label,
        stagePeak: p.stagePeak || info.key,
        days: info.days,
        level: levelOf(p.score),
        lastAt: p.lastAt,
        events: (p.events ?? []).slice(-5).reverse(),
      };
    })
    .sort((a, b) => b.composite - a.composite);
  return {
    ok: true,
    enabled: conf.enabled,
    start: conf.start,
    count: rows.length,
    people: rows.slice(0, conf.maxPeople),
  };
}
