// 主动开口闸门：判断「现在能不能出声」，并记账「上一次出声有没有人接」。
//
// 为什么不放在 bridge.js 里：
//   这段逻辑只依赖 state 对象和配置，没有任何 IO —— 拆出来才能被
//   scripts/test-outreach-gate.mjs 直接测（bridge.js 是 1.6 万行的入口文件，
//   里面的函数只能在运行中的进程里验证，改错一个边界就是线上事故）。
//
// 和 AstrBot 主动消息插件的差别：
//   那边要求「用户回复」才算被接住；群里对方转头跟别人聊，对话其实还活着。
//   所以这里只要上一次开口之后**有任何入站消息**，冷场链条就算断掉。

import { inQuietHours, localDateKey, nextDayStartAfter, quietEndAfter } from './purpose-engine.js';

export const DEFAULT_QUIET_START = '00:30';
export const DEFAULT_QUIET_END = '08:00';
export const DEFAULT_SOFT_LIMIT = 3;
export const DEFAULT_STOP_LIMIT = 5;

/** 从 socialV2.proactive 配置里取安静时段（缺省值兜底，非法值不影响判定）。 */
export function outreachWindow(config = {}) {
  return {
    quietStart: String(config?.quietStart ?? DEFAULT_QUIET_START),
    quietEnd: String(config?.quietEnd ?? DEFAULT_QUIET_END),
  };
}

/**
 * 连续未接次数。
 * - 上一次主动之后有人说过话 → 0（被接住）；
 * - 上一次唤醒了但她自己没开口 → 0（那不算「主动过」，别拿它惩罚下一轮）；
 * - 否则返回累计值。
 */
export function effectiveUnanswered(st) {
  const lastP = Number(st?.lastProactiveAt) || 0;
  if (!lastP) return 0;
  if ((Number(st?.lastIncomingAt) || 0) > lastP) return 0;
  if ((Number(st?.lastAiReplyAt) || 0) < lastP) return 0;
  return Math.max(0, Math.round(Number(st?.proactiveUnanswered) || 0));
}

/** 把连续未接次数翻译成退避参数：概率系数 + 当日上限 + 是否封口。 */
export function proactiveBackoff(st, config = {}) {
  const soft = Math.max(0, Math.round(Number(config?.unansweredSoftLimit ?? DEFAULT_SOFT_LIMIT)));
  const stop = Math.max(0, Math.round(Number(config?.unansweredStopLimit ?? DEFAULT_STOP_LIMIT)));
  const n = effectiveUnanswered(st);
  if (!soft && !stop) return { n, mult: 1, dailyCap: 0, stop: false };
  if (stop && n >= stop) return { n, mult: 0, dailyCap: 0, stop: true };
  if (soft && n >= soft) return { n, mult: 0.5, dailyCap: 1, stop: false };
  if (n >= 2) return { n, mult: 0.35, dailyCap: 0, stop: false };
  if (n >= 1) return { n, mult: 0.6, dailyCap: 0, stop: false };
  return { n, mult: 1, dailyCap: 0, stop: false };
}

/**
 * 主动开口前的统一判定。
 * 返回 { ok, reason, retryAt, mult, n }：
 *   reason = ok | quiet | unanswered-stop | unanswered-daily
 *   retryAt = 建议的「再试时间」（毫秒时间戳，0 表示不用等）
 * 只读 + 最多重置「今日计数」；落盘交给调用方，避免在这里重复写文件。
 */
export function outreachGate(st, { now = Date.now(), config = {} } = {}) {
  const win = outreachWindow(config);
  if (inQuietHours(now, win)) {
    const retryAt = quietEndAfter(now, win) + Math.round(Math.random() * 20 * 60 * 1000);
    return { ok: false, reason: 'quiet', retryAt, mult: 0, n: effectiveUnanswered(st) };
  }
  const backoff = proactiveBackoff(st, config);
  if (backoff.stop) {
    return { ok: false, reason: 'unanswered-stop', retryAt: nextDayStartAfter(now, win), mult: 0, n: backoff.n };
  }
  if (backoff.dailyCap > 0) {
    const today = localDateKey(now);
    if (st.proactiveDayKey !== today) {
      st.proactiveDayKey = today;
      st.proactiveDayCount = 0;
    }
    if ((Number(st.proactiveDayCount) || 0) >= backoff.dailyCap) {
      return { ok: false, reason: 'unanswered-daily', retryAt: nextDayStartAfter(now, win), mult: 0, n: backoff.n };
    }
  }
  return { ok: true, reason: 'ok', retryAt: 0, mult: backoff.mult, n: backoff.n };
}

/** 真正开口前记一笔：连续未接 +1、当日计数 +1、记下这次的时间点。 */
export function markProactiveFired(st, now = Date.now()) {
  if (!st) return 0;
  st.proactiveUnanswered = effectiveUnanswered(st) + 1;
  st.lastProactiveAt = now;
  const today = localDateKey(now);
  if (st.proactiveDayKey !== today) {
    st.proactiveDayKey = today;
    st.proactiveDayCount = 0;
  }
  st.proactiveDayCount = (Number(st.proactiveDayCount) || 0) + 1;
  return st.proactiveUnanswered;
}
