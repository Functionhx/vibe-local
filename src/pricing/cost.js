// 定价层：查表 + 计费。
//
// 设计要点（都来自对上游的观察与官方文档）：
//
//  1. **只用 model 字符串查表，source 不参与定价。** 上游注释
//     (`codebuddy.js:59-64`) 原文 "server-side pricing matches the model string
//     alone"；`qoder.js:46-51` 是反证——Qoder 的 `auto` 档会撞上 Cursor 的
//     `auto` 条目，只能靠改名 `qoder-auto` 规避。
//
//  2. **存显式数字，不推倍率。** 官方页对 cache read/write 都给了显式价。
//     这里唯一的例外是后缀推导（见 deriveFromSuffix），且会标注来源。
//
//  3. **查不到价 → $0，但要报告。** token 数照常计，成本贡献 0。**除显式标注
//     `free: true` 的条目外，所有 $0 计费的模型都会进入提醒列表**——否则漏一个
//     模型就会静默吞掉一块花费，而总额看起来依然正常。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PER_MILLION = 1e6;
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PRICES_PATH = join(HERE, 'prices.json');

export function loadPrices(path = DEFAULT_PRICES_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { models: raw.models ?? {}, unpricedKnown: raw.unpriced_known ?? {}, meta: raw._meta ?? {} };
}

// 模型名里那些"不是模型身份"的装饰后缀。查表失败时逐个剥掉再试。
// 顺序：先剥 tier，再剥日期——`gpt-5.6-sol-priority-2026-07-09` 要两步都走到。
const TIER_SUFFIXES = ['-priority', '-fast', '-flex', '-batch'];
const DATE_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{6,8})$/;

/**
 * 判定模型是否"显式免费"。
 *
 * 这一条把两种 $0 区分开：
 *   - 模型名自带 `-free`，或表里标了 `free: true` → 是真的不要钱，不报警
 *   - 表里根本没有 → 是"我们不知道价格"，必须报警
 *
 * 混在一起会让提醒列表被免费模型淹没，从而失去意义。
 */
function isExplicitlyFree(model, entry) {
  if (entry?.free === true) return true;
  return /-free$/.test(model);
}

/**
 * 后缀推导：`-priority` / `-fast` 官方定价就是基础价的 2x。
 *
 * 有官方依据，不是猜的：
 *   - Anthropic 官方页 Fast mode 表：Opus 5 = $10/$50（基础 $5/$25）
 *   - OpenAI 官方页 Fast mode 节原文 "Double the Standard rates"，
 *     且注明 "Priority processing was renamed Fast mode on July 30, 2026"
 *
 * 只在表里没有显式条目时才用，返回值带 `derived` 标记以便报告层标注来源。
 */
function deriveFromSuffix(model, models) {
  for (const suffix of TIER_SUFFIXES) {
    if (!model.endsWith(suffix)) continue;
    const base = model.slice(0, -suffix.length);
    const b = models[base];
    if (!b || b.input == null) continue;
    const dbl = (v) => (v == null ? null : v * 2);
    return {
      entry: {
        input: dbl(b.input),
        output: dbl(b.output),
        cache_read: dbl(b.cache_read),
        cache_write_5m: dbl(b.cache_write_5m),
        cache_write_1h: dbl(b.cache_write_1h),
        as_of: b.as_of,
        source_url: b.source_url,
        derived_from: base,
        rule: `${suffix} = 2x 基础价（官方 fast/priority tier 定价规则）`,
      },
      matchedBy: `derived:${suffix}`,
    };
  }
  return null;
}

/**
 * 查表。返回 `{ entry, matchedBy }` 或 `null`。
 *
 * matchedBy 取值：`exact` / `strip-date` / `derived:<suffix>` / `null`，
 * 报告层用它说明价格的来源可信度。
 */
export function lookupPrice(prices, model) {
  const models = prices.models;

  // 1. 精确匹配。**必须检查价格字段存在**，不能只看键在不在——空壳条目
  //    （只有说明文字没有数字）会让下游算出 NaN。
  const exact = models[model];
  if (exact && exact.input != null) return { entry: exact, matchedBy: 'exact' };
  if (exact?.free === true) return { entry: exact, matchedBy: 'exact' };

  // 2. 剥日期后缀
  const stripped = model.replace(DATE_SUFFIX, '');
  if (stripped !== model) {
    const e = models[stripped];
    if (e && e.input != null) return { entry: e, matchedBy: 'strip-date' };
    if (e?.free === true) return { entry: e, matchedBy: 'strip-date' };
  }

  // 3. 后缀推导（fast/priority = 2x）
  const derived = deriveFromSuffix(model, models);
  if (derived) return derived;

  // 4. 剥掉 tier 后缀后再查一次，兜住"基础模型有价但 tier 变体没价"的情况，
  //    此时**不**推导 2x，而是按基础价计并标注——宁可少报也不能编。
  for (const suffix of TIER_SUFFIXES) {
    if (!model.endsWith(suffix)) continue;
    const base = models[model.slice(0, -suffix.length)];
    if (base && base.input != null) {
      return { entry: base, matchedBy: `base-of:${suffix}` };
    }
  }

  return null;
}

/**
 * 判断某个 30 分钟桶落在 peak 还是 off-peak。
 *
 * DeepSeek 官方按 UTC 时段计价（工作日 01:00-04:00 与 06:00-10:00 为 peak，
 * 其余时段半价）。`bucketStart` 就是 UTC ISO 串，所以能精确判定。
 *
 * **已知近似**：官方说"中国法定节假日"也算 off-peak，但我们没有节假日表，
 * 只按"周末 = off-peak"处理。节假日当天会按 peak 计，即**高估**——方向上
 * 是保守的（不会少报花费）。
 */
export function isPeak(bucketStart, schedule) {
  const d = new Date(bucketStart);
  if (Number.isNaN(d.getTime())) return true; // 判定不了就按贵的算
  const day = d.getUTCDay(); // 0=周日 6=周六
  if (schedule.weekdays_only && (day === 0 || day === 6)) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const [from, to] of schedule.peak_windows_utc) {
    const [fh, fm] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    if (minutes >= fh * 60 + fm && minutes < th * 60 + tm) return true;
  }
  return false;
}

/**
 * 单个 bucket 的成本（美元）。
 *
 * 六个 token 列互不重叠（见 UPSTREAM.md 与上游 `codex.js:761-762`），所以直接
 * 各自乘以对应单价相加即可 —— 不要做任何"包含关系"的减法。
 *
 * reasoning 按 **output** 速率计：它本就是 completion token 的一个划分。
 */
export function costOfBucket(bucket, prices) {
  const hit = lookupPrice(prices, bucket.model);

  // 查不到 → $0，但标记出来让报告层提醒。
  if (!hit) {
    return { cost: 0, priced: false, reason: 'not-found', model: bucket.model };
  }

  const { entry, matchedBy } = hit;
  if (isExplicitlyFree(bucket.model, entry)) {
    // 真·免费。不是"不知道价格"，所以不算 unpriced。
    return { cost: 0, priced: true, free: true, matchedBy, model: bucket.model };
  }
  if (entry.input == null) {
    return { cost: 0, priced: false, reason: 'no-price-fields', model: bucket.model };
  }

  // peak / off-peak
  let scale = 1;
  let peak = null;
  if (entry.peak_schedule) {
    peak = isPeak(bucket.bucketStart, entry.peak_schedule);
    if (!peak) scale = entry.peak_schedule.off_peak_multiplier ?? 1;
  }

  // 缺失的单价的兜底：cache write 没标价时按 input 价计（官方页上以 "–" 表示
  // 不单独计费，即并入 input）。这是**有意的近似**，报告层会标注。
  const pIn = entry.input ?? 0;
  const pOut = entry.output ?? pIn;
  const pRead = entry.cache_read ?? pIn;
  const pW5 = entry.cache_write_5m ?? pIn;
  const pW1 = entry.cache_write_1h ?? pIn;

  const tokens =
    (bucket.inputTokens ?? 0) * pIn +
    ((bucket.outputTokens ?? 0) + (bucket.reasoningOutputTokens ?? 0)) * pOut +
    (bucket.cachedInputTokens ?? 0) * pRead +
    (bucket.cacheCreation5mTokens ?? 0) * pW5 +
    (bucket.cacheCreation1hTokens ?? 0) * pW1;

  const cost = (tokens / PER_MILLION) * scale;
  return {
    cost: Number.isFinite(cost) ? cost : 0,
    priced: true,
    matchedBy,
    peak,
    derived: entry.derived_from ? { from: entry.derived_from, rule: entry.rule } : undefined,
    model: bucket.model,
  };
}

/**
 * 对一组 bucket 汇总：总额、按模型、按 source、按项目，以及**无价模型清单**。
 *
 * 返回的 `unpriced` 是报告层必须展示的东西——它是"$0 计费"这个设计的唯一护栏。
 */
export function summarize(buckets, prices) {
  let totalCost = 0;
  let totalTokens = 0;
  const byModel = new Map();
  const bySource = new Map();
  const byProject = new Map();
  const unpriced = new Map();
  let freeTokens = 0;

  for (const b of buckets) {
    const r = costOfBucket(b, prices);
    const tokens = b.totalTokens ?? 0;
    const cacheRead = b.cachedInputTokens ?? 0;

    // 无价模型的 token 仍计入总量（只是不产生成本），否则用户会以为用量丢了。
    totalCost += r.cost;
    totalTokens += tokens;

    if (!r.priced) {
      const cur = unpriced.get(b.model) ?? { model: b.model, tokens: 0, cacheRead: 0, reason: r.reason };
      cur.tokens += tokens;
      cur.cacheRead += cacheRead;
      unpriced.set(b.model, cur);
    } else if (r.free) {
      freeTokens += tokens;
    }

    const add = (map, key) => {
      const cur = map.get(key) ?? { cost: 0, tokens: 0 };
      cur.cost += r.cost;
      cur.tokens += tokens;
      map.set(key, cur);
    };
    add(byModel, b.model);
    add(bySource, b.source);
    add(byProject, b.project ?? 'unknown');
  }

  return {
    totalCost,
    totalTokens,
    freeTokens,
    byModel,
    bySource,
    byProject,
    unpriced: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

/** 把美元格式化成人读的字符串。 */
export function fmtUSD(v) {
  if (!Number.isFinite(v)) return '$0.00';
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}
