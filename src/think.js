/**
 * 读法（思维链式消息防抖的 SurfCore 版）—— 2026-11-02
 *
 * 来源：小黑盒帖子《安装插件给"小鲸鱼"deepseek完整的一生》第 11 个插件
 * **思维链式消息防抖 1.3.1**：「收到消息后 LLM 会像真人读消息一样逐条思考
 * （逐条要点、总体判断、未决问题），并且会按照设定的人格改变思考风格」。
 *
 * SurfCore 已经有「防抖」的一半：`socialV2.wait` 的静默窗口 + 批量唤醒，
 * 消息不会一条一条地喂给她。缺的是另一半——**先读懂再开口**。
 * 群里常常一次涌进来 5 条、两个人同时说话、有人只说半句，直接回就容易
 * 答错人 / 漏掉问题 / 复读。所以这里给唤醒 prompt 加一段「读法」：
 * 让她在心里过三遍（逐条要点 → 总体判断 → 未决问题），想清楚再决定发不发。
 *
 * 设计约束：
 * - 纯函数、无 IO：风格判断只吃人格卡文本，不读文件；
 * - 不产生任何持久化：思考只活在这一次唤醒里，不写日记、不写状态；
 * - 这段文字必须**不鼓励把思考说出来**——真人不会在群里念自己的心理活动。
 */

/** 人格卡里出现这些词，说明说话更冲、更短，读法也压扁一点。 */
const DRY_RE = /(毒舌|高冷|冷淡|冷脸|腹黑|傲娇|寡言|话少|简洁|惜字|直男|直女|面瘫|不好惹)/;
/** 这些词说明跳脱、话多，读法可以多一条「有没有梗可接」。 */
const CHATTY_RE = /(活泼|开朗|元气|可爱|俏皮|话多|话痨|叽叽喳|跳脱|沙雕|乐子人|撒娇|黏人|萌)/;

const DEFAULT_MAX_POINTS = 3;

/**
 * 配置归一化。缺省即开——「先读懂再回」没人会想关掉，除非嫌费 token。
 * @param {object} [raw] config.json 里的 socialV2.think
 * @returns {{enabled: boolean, style: 'auto'|'brief'|'chatty'|'dry', maxPoints: number}}
 */
export function normalizeThinkConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const styleRaw = String(src.style ?? 'auto').trim().toLowerCase();
  const style = ['auto', 'brief', 'chatty', 'dry'].includes(styleRaw) ? styleRaw : 'auto';
  const points = Math.trunc(Number(src.maxPoints));
  return {
    enabled: src.enabled !== false,
    style,
    maxPoints: Number.isFinite(points) ? Math.min(5, Math.max(2, points)) : DEFAULT_MAX_POINTS,
  };
}

/**
 * 按人格卡决定思考风格。auto 时做关键词判断，判断不出来用 brief（中性、最短）。
 * @param {string} personaText 人格卡正文（可为空）
 * @param {string} [style] 配置里的 style
 * @returns {'brief'|'chatty'|'dry'}
 */
export function thinkStyleOf(personaText, style) {
  const picked = String(style ?? 'auto').toLowerCase();
  if (picked === 'brief' || picked === 'chatty' || picked === 'dry') return picked;
  const text = String(personaText ?? '');
  if (DRY_RE.test(text)) return 'dry';
  if (CHATTY_RE.test(text)) return 'chatty';
  return 'brief';
}

const STYLE_LINES = {
  brief: '你是那种想清楚了才开口的人：话不用多，但别说错人、别漏问。',
  chatty: '你脑子转得快、话也多，但先想清楚再说：可以接梗，别接错人的梗。',
  dry: '你话少、也不爱解释；想清楚哪句最有用，就只说那句。',
};

/**
 * 生成唤醒 prompt 里的「读法」段。
 * 没有未读消息时返回空串（主动搭话/潜水收尾不需要读别人的话）。
 * @param {{cfg: object, personaText?: string, unreadCount?: number, maxMsgs?: number}} opts
 * @returns {string} 以 "\n\n" 结尾的段落，或空串
 */
export function buildThinkBlock({ cfg, personaText = '', unreadCount = 0, maxMsgs = 8 }) {
  const c = normalizeThinkConfig(cfg);
  if (!c.enabled) return '';
  const count = Math.max(0, Math.trunc(Number(unreadCount) || 0));
  if (count === 0) return '';
  const style = thinkStyleOf(personaText, c.style);
  const cap = Math.min(c.maxPoints, Math.max(1, count), Math.max(1, Math.trunc(Number(maxMsgs) || count)));
  const points = [];
  points.push(`① 逐条要点：谁说了什么，各自想干什么（最多记 ${cap} 条，别复述原话）`);
  points.push('② 总体判断：合起来是什么事、要不要接、接哪一条、回几条');
  points.push('③ 未决问题：有没有没听懂、需要反问一句的地方');
  if (style === 'chatty') points.push('④ 有没有现成的梗/表情能接（有就顺手用，没有别硬凑）');
  if (style === 'dry') points.push('④ 哪句最省字又最到位');
  return `【读法】这轮有 ${count} 条新消息，别急着开口，先在心里过一遍（不要写进回复，也别在群里念出你的思考）：\n${points.join('\n')}\n${STYLE_LINES[style]}\n\n`;
}

/**
 * 设置页/诊断用的只读快照。
 * @param {object} cfg
 * @param {string} [personaText]
 */
export function thinkSnapshot(cfg, personaText = '') {
  const c = normalizeThinkConfig(cfg);
  return {
    enabled: c.enabled,
    style: c.style,
    resolvedStyle: thinkStyleOf(personaText, c.style),
    maxPoints: c.maxPoints,
  };
}
