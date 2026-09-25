// 报告层聚合：把 buckets 按天 / 模型 / 项目分组，并按时间窗口过滤。
//
// 与 `src/upstream/parsers/aggregate.js` 的区别：那一层是**存储聚合**（30 分钟
// 桶、固定字段、用于去重上传）；这一层是**展示聚合**（按天/维度分组、按窗口裁
// 剪）。两者不要混。

import { costOfBucket, lookupPrice } from '../pricing/cost.js';

// ── 时区口径 ────────────────────────────────────────────────────────────────
//
// **一律按 UTC+8 统计，且与系统时区无关。**
//
// 为什么不用系统时区：两台被统计的机器系统时区都是 America/Los_Angeles
// （PDT/PST，且会因夏令时切换），而用户要的口径是固定的 UTC+8。用 `getFullYear()`
// 这类本地时间 API，同一份日志在不同 TZ 环境下会算出不同的日键——统计就不可复现了。
//
// 做法：把 UTC 时刻**平移** offset 小时，再用 UTC 字段读。全程不碰系统时区。
const HOUR_MS = 3600_000;
export const TZ_OFFSET_HOURS = Number(process.env.VIBE_LOCAL_TZ_OFFSET ?? 8);

/** 把真实 UTC 时刻平移到目标时区的"墙上时间"（一个可读的 Date，但用 UTC 字段取值）。 */
function shifted(instant) {
  return new Date(new Date(instant).getTime() + TZ_OFFSET_HOURS * HOUR_MS);
}

/** 目标时区的墙上时间 → 真实 UTC 时刻（shifted 的逆运算）。 */
function unshifted(wallClock) {
  return new Date(wallClock.getTime() - TZ_OFFSET_HOURS * HOUR_MS);
}

/** 某个 UTC 瞬间落在目标时区的哪一天（`YYYY-MM-DD`）。 */
export function dayKey(bucketStart) {
  const d = new Date(bucketStart);
  if (Number.isNaN(d.getTime())) return null;
  return shifted(d).toISOString().slice(0, 10);
}

/** 目标时区里"今天"的日键。 */
export function todayKey(now = new Date()) {
  return shifted(now).toISOString().slice(0, 10);
}

/**
 * 窗口起点（真实 UTC 瞬间）：目标时区今天 00:00 往前推 (days-1) 天。
 * 含今天，共 days 天。
 */
export function windowStart(days, now = new Date()) {
  const today = shifted(now);
  const startWall = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() - (days - 1),
  ));
  return unshifted(startWall);
}

/** 窗口内每一天的日键，升序。全部在**目标时区**的日界上算。 */
export function dayKeysInWindow(days, now = new Date()) {
  const today = shifted(now);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - i,
    ));
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

export function inWindow(bucketStart, start) {
  const d = new Date(bucketStart);
  return !Number.isNaN(d.getTime()) && d >= start;
}

/**
 * 按窗口过滤并聚合。
 *
 * @returns {{
 *   days: string[],                    // 升序的本地日期键
 *   byDay: Map<string, {cost,tokens,cacheRead,spread}>,
 *   byModel: Map, bySource: Map, byProject: Map,
 *   totalCost, totalTokens, totalCacheRead,
 *   unpriced: Array, freeTokens: number,
 *   partial: Array,                    // 解析未完成的来源，报告层必须显示
 * }}
 */
export function buildReport(buckets, prices, { days = 7, now = new Date(), reports = [], manual = [] } = {}) {
  const start = windowStart(days, now);
  const byDay = new Map();
  const byModel = new Map();
  const bySource = new Map();
  const byProject = new Map();
  const unpriced = new Map();

  let totalCost = 0;
  let totalTokens = 0;
  let totalCacheRead = 0;
  let freeTokens = 0;

  // 窗口内每一天都要在 byDay 里出现（哪怕为 0），趋势图才能画满，不会因为
  // 某天没数据就整行消失。日键全部在**目标时区**的日界上算。
  const dayKeys = dayKeysInWindow(days, now);
  for (const k of dayKeys) {
    // measured / spread 分开记账。合成一个数字就没法区分"这天全是实测"和
    // "这天全是摊平估算"了——而趋势图必须让这两者一眼可辨。
    byDay.set(k, { cost: 0, tokens: 0, cacheRead: 0, measuredCost: 0, spreadCost: 0, spread: false });
  }

  const addTo = (map, key, cost, tokens, cacheRead) => {
    const cur = map.get(key) ?? { cost: 0, tokens: 0, cacheRead: 0 };
    cur.cost += cost;
    cur.tokens += tokens;
    cur.cacheRead += cacheRead;
    map.set(key, cur);
  };

  for (const b of buckets) {
    if (!inWindow(b.bucketStart, start)) continue;
    const day = dayKey(b.bucketStart);
    const r = costOfBucket(b, prices);
    const tokens = b.totalTokens ?? 0;
    const cacheRead = b.cachedInputTokens ?? 0;

    totalCost += r.cost;
    totalTokens += tokens;
    totalCacheRead += cacheRead;

    if (!r.priced) {
      const cur = unpriced.get(b.model) ?? { model: b.model, tokens: 0, cacheRead: 0, reason: r.reason };
      cur.tokens += tokens;
      cur.cacheRead += cacheRead;
      unpriced.set(b.model, cur);
    } else if (r.free) {
      freeTokens += tokens;
    }

    const dayBucket = byDay.get(day);
    if (dayBucket) {
      dayBucket.cost += r.cost;
      dayBucket.tokens += tokens;
      dayBucket.cacheRead += cacheRead;
      dayBucket.measuredCost += r.cost;
    }
    addTo(byModel, b.model, r.cost, tokens, cacheRead);
    addTo(bySource, b.source, r.cost, tokens, cacheRead);
    addTo(byProject, b.project ?? 'unknown', r.cost, tokens, cacheRead);
  }

  // 手工录入：按时间段摊平，且**窗口感知**——只计入落在窗口内的那部分。
  const manualDays = spreadManual(manual, dayKeys, byDay);
  for (const m of manual.entries ?? []) {
    // 手工条目的总计同样只计窗口内部分
    const share = manualShare(m, dayKeys);
    if (share <= 0) continue;
    const { cost, tokens, cacheRead, unpriced: u } = manualCost(m, prices, share);
    totalCost += cost;
    totalTokens += tokens;
    totalCacheRead += cacheRead;
    if (u) {
      const cur = unpriced.get(m.model) ?? { model: m.model, tokens: 0, cacheRead: 0, reason: u };
      cur.tokens += tokens;
      cur.cacheRead += cacheRead;
      unpriced.set(m.model, cur);
    }
    addTo(byModel, m.model, cost, tokens, cacheRead);
    addTo(bySource, m.label ?? 'manual', cost, tokens, cacheRead);
    addTo(byProject, m.project ?? '(手工录入)', cost, tokens, cacheRead);
  }

  // 解析未完成的来源要单独列出——**不能用 0 表示"没解析成功"**。上游代码库
  // 反复出现这个 bug 模式（`claude-roots.js:106-119` 专门讲把它当成空子树导致
  // 静默归零）。
  const partial = reports
    .filter(r => r.skipped || r.indexing || !r.ok)
    .map(r => ({
      source: r.source,
      // 调用方给了 reason 就用它（如 CLI 注入的"镜像未同步"），否则按 parser
      // 的三种状态翻译。之前这里无条件覆盖，把调用方的说明吃掉了。
      reason: r.reason ?? (r.error ? `解析失败：${r.error}`
        : r.indexing ? `索引未完成（${r.indexing.phase} ${r.indexing.completed}/${r.indexing.total}）`
        : '本轮结果不完整'),
    }));

  return {
    days: dayKeys,
    byDay,
    byModel,
    bySource,
    byProject,
    totalCost,
    totalTokens,
    totalCacheRead,
    unpriced: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens),
    freeTokens,
    partial,
    manualCount: (manual.entries ?? []).length,
    spreadDays: manualDays,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 两个日键之间的天数（含首尾）。
 * 用 `Date.UTC` 算——纯日历运算，不涉及任何时区偏移。
 */
export function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
}

/**
 * 一条手工录入落在窗口内的天数占比。
 *
 * 全程用 **ISO 日键字符串比较**，不构造 Date。日键是 `YYYY-MM-DD`，字典序即时间序，
 * 而且这样天然与系统时区无关——`new Date('2026-09-20T00:00:00')` 会按**本地时区**
 * 解析，那正是要避免的。
 */
function manualShare(entry, dayKeys) {
  if (!DATE_RE.test(entry.start ?? '') || !DATE_RE.test(entry.end ?? '')) return 0;
  if (entry.end < entry.start) return 0;
  const totalDays = daysBetween(entry.start, entry.end);
  const overlap = dayKeys.filter((k) => k >= entry.start && k <= entry.end).length;
  return overlap / totalDays;
}

/**
 * 把手工录入摊到每一天。
 *
 * **摊出来的是估算，不是实测**：它假设用量在时间段内均匀分布。报告层必须把
 * 它和实测值视觉上区分开（`spread: true` 标记），否则趋势图会撒谎。
 */
function spreadManual(manual, dayKeys, byDay) {
  let touched = 0;
  for (const entry of manual.entries ?? []) {
    if (!DATE_RE.test(entry.start ?? '') || !DATE_RE.test(entry.end ?? '')) continue;
    if (entry.end < entry.start) continue;
    const totalDays = daysBetween(entry.start, entry.end);
    // 同样用日键字符串比较，不构造 Date（见 manualShare 的说明）
    const hitDays = dayKeys.filter((k) => k >= entry.start && k <= entry.end);
    if (hitDays.length === 0) continue;
    // 每天分到的量 = 总数 / 时间段总天数（**不是** / 窗口内天数）
    const perDayTokens = (entry.tokens?.total ?? 0) / totalDays;
    const perDayCost = (entry.cost ?? 0) / totalDays;
    for (const k of hitDays) {
      const b = byDay.get(k);
      if (!b) continue;
      b.tokens += perDayTokens;
      b.cost += perDayCost;
      b.spreadCost += perDayCost;
      b.spread = true;
      touched++;
    }
  }
  return touched;
}

/** 单条手工录入在窗口内那部分对应的成本。成本优先级：cost > 单价 > 查表 > $0。 */
function manualCost(entry, prices, share) {
  const t = entry.tokens ?? {};
  const tokens = t.total ?? 0;
  const cacheRead = t.cache_read ?? 0;

  if (entry.cost != null) {
    return { cost: entry.cost * share, tokens: tokens * share, cacheRead: cacheRead * share, unpriced: null };
  }
  if (entry.price_in != null) {
    // 只给了 input/output 单价时，cache 系列按**官方倍率规则**推导并标注——
    // 这是有官方依据的推导（cache read 0.1x、write 5m 1.25x / 1h 2x）。
    const pIn = entry.price_in;
    const pOut = entry.price_out ?? pIn;
    const pRead = entry.price_cache_read ?? pIn * 0.1;
    const pW5 = entry.price_cache_write_5m ?? pIn * 1.25;
    const pW1 = entry.price_cache_write_1h ?? pIn * 2;
    const raw = (t.input ?? 0) * pIn + ((t.output ?? 0) + (t.reasoning ?? 0)) * pOut
      + cacheRead * pRead + (t.cache_write_5m ?? 0) * pW5 + (t.cache_write_1h ?? 0) * pW1;
    return { cost: (raw / 1e6) * share, tokens: tokens * share, cacheRead: cacheRead * share, unpriced: null };
  }
  // 回落到查表
  const hit = lookupPrice(prices, entry.model);
  if (!hit || hit.entry.input == null) {
    return { cost: 0, tokens: tokens * share, cacheRead: cacheRead * share, unpriced: 'not-found' };
  }
  const p = hit.entry;
  const raw = (t.input ?? 0) * p.input + ((t.output ?? 0) + (t.reasoning ?? 0)) * (p.output ?? p.input)
    + cacheRead * (p.cache_read ?? p.input)
    + (t.cache_write_5m ?? 0) * (p.cache_write_5m ?? p.input)
    + (t.cache_write_1h ?? 0) * (p.cache_write_1h ?? p.input);
  return { cost: (raw / 1e6) * share, tokens: tokens * share, cacheRead: cacheRead * share, unpriced: null };
}
