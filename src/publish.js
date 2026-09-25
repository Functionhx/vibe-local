// `publish` —— 产出给个人网站用的聚合 JSON。
//
// 这是**整个项目里唯一会把数据写出去的地方**，所以几条约束是硬的：
//
//  1. **只发聚合数字**：每日总额 + 按模型。**不含项目名、路径、prompt。**
//     不是"过滤掉"，而是输出结构里根本没有这些字段——没有的东西泄不出去。
//     项目维度在这里是刻意不取的，即使 `buildReport()` 能算出来。
//
//  2. **整份重写，不做增量 upsert**。重新聚合本机全部日志得到所有 UTC+8 日，
//     整文件覆盖。好处是**回填天然发生**：机器关机三天后开机补跑，那三天的
//     数据自动就在结果里，不需要单独的补漏逻辑。
//
//  3. **与系统时区无关**（见 report/aggregate.js 的时区说明）。
//
//  4. **今天是部分的**。发布时当天还没过完，所以那一条的数字还会长。这是正确的
//     ——网站上"今日"本就该是实时值。次日跑时它会自动变成完整值。

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { collect, localHostname } from './collect.js';
import { loadPrices, costOfBucket, lookupPrice } from './pricing/cost.js';
import { dayKey, daysBetween, todayKey } from './report/aggregate.js';

export const SCHEMA_VERSION = 1;
/** 保留天数上限。超出会裁剪，否则文件随使用年限无限增长。 */
export const RETENTION_DAYS = Number(process.env.VIBE_LOCAL_RETENTION_DAYS ?? 400);

/** 成本保留 4 位小数，避免浮点尾数让输出在两次运行间抖动。 */
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * 把 buckets 聚合成发布用的结构。**纯函数**，便于测试。
 *
 * @param {object[]} buckets
 * @param {object} prices
 * @param {{host:string, now?:Date, retentionDays?:number}} opts
 */
export function buildPayload(buckets, prices, { host, now = new Date(), retentionDays = RETENTION_DAYS } = {}) {
  const today = todayKey(now);
  const cutoff = cutoffKey(today, retentionDays);
  const byDay = new Map();

  for (const b of buckets) {
    const d = dayKey(b.bucketStart);
    if (!d) continue;
    const r = costOfBucket(b, prices);

    let entry = byDay.get(d);
    if (!entry) {
      entry = { date: d, cost: 0, tokens: 0, cacheRead: 0, _models: new Map() };
      byDay.set(d, entry);
    }

    const tokens = b.totalTokens ?? 0;
    const cacheRead = b.cachedInputTokens ?? 0;
    entry.cost += r.cost;
    entry.tokens += tokens;
    entry.cacheRead += cacheRead;

    const m = entry._models.get(b.model) ?? { model: b.model, cost: 0, tokens: 0, cacheRead: 0 };
    m.cost += r.cost;
    m.tokens += tokens;
    m.cacheRead += cacheRead;
    entry._models.set(b.model, m);
  }

  // 裁剪 + 排序 + 定型。顺序全部固定，保证同样的输入产出同样的字节。
  const days = [...byDay.values()]
    .filter((e) => e.date >= cutoff)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => ({
      date: e.date,
      cost: round4(e.cost),
      // tokens 沿用上游 bucket 的 totalTokens 口径：**不含 cache read**。
      // 保留它是因为它与 parser 的字段一一对应，便于核对。
      tokens: e.tokens,
      cacheRead: e.cacheRead,
      // 实际消耗总量。cache read 也是真实处理过的 token，只是单价不同——
      // 只报"不含 cache"的数会让人以为自己用少了（实际差一个数量级）。
      // 这个字段就是给人和账户页面对账用的。
      tokensInclCache: e.tokens + e.cacheRead,
      // 按成本降序、同成本按模型名升序 —— 让输出可复现
      byModel: [...e._models.values()]
        .filter((m) => m.tokens > 0 || m.cost > 0)
        .sort((a, b) => (b.cost - a.cost) || (a.model < b.model ? -1 : 1))
        .map((m) => ({
          model: m.model,
          cost: round4(m.cost),
          tokens: m.tokens,
          cacheRead: m.cacheRead ?? 0,
          tokensInclCache: m.tokens + (m.cacheRead ?? 0),
        })),
    }));

  // 顶层汇总。让页面直接读，不用自己遍历累加 —— 也保证"总量"的定义只有一处。
  const totals = days.reduce(
    (acc, d) => ({
      cost: acc.cost + d.cost,
      tokens: acc.tokens + d.tokens,
      cacheRead: acc.cacheRead + d.cacheRead,
      tokensInclCache: acc.tokensInclCache + d.tokensInclCache,
    }),
    { cost: 0, tokens: 0, cacheRead: 0, tokensInclCache: 0 },
  );

  return {
    host,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date(now.getTime()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    totals: {
      cost: round4(totals.cost),
      tokens: totals.tokens,
      cacheRead: totals.cacheRead,
      tokensInclCache: totals.tokensInclCache,
      days: days.length,
      // 没有数据时**省略**而不是写 null —— 校验器的隐私守卫明确拒绝 null
      //（"未知就省略，不要写 null"），写 null 会让发布在校验那一步失败。
      ...(days.length > 0 ? { firstDate: days[0].date, lastDate: days[days.length - 1].date } : {}),
    },
    days,
  };
}

/** 保留窗口的左边界日键。 */
function cutoffKey(today, retentionDays) {
  const [y, m, d] = today.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d - (retentionDays - 1)));
  return back.toISOString().slice(0, 10);
}

/** 稳定序列化：2 空格缩进 + 末尾换行。字节可复现。 */
export function serialize(payload) {
  return JSON.stringify(payload, null, 2) + '\n';
}

/**
 * 内容没变就不写盘。
 *
 * 抽成独立函数是为了能被测试覆盖——它嵌在 `publish()` 里时，要触发这个分支就得
 * 跑一次完整的日志解析（数秒），而日志又在持续变化，测试既慢又脆。
 *
 * 不写的好处不只是省一次磁盘写：**文件的 mtime 就成了"数据有没有变"的信号**，
 * 从而能用 `git diff --quiet` 判断该不该产生一次提交。
 *
 * @returns {boolean} 是否真的写了
 */
export function writeIfChanged(outPath, text) {
  if (existsSync(outPath)) {
    try {
      if (readFileSync(outPath, 'utf8') === text) return false;
    } catch {
      // 读不了就当作有变化，正常写一遍
    }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, { encoding: 'utf8' });
  return true;
}

/**
 * 采集本机日志并写出发布文件。
 *
 * @returns {{path:string, payload:object, written:boolean, unchanged:boolean}}
 */
export async function publish({
  outPath,
  host = localHostname(),
  now = new Date(),
  extraRoots = {},
  codexExtraHome,
} = {}) {
  const prices = loadPrices();
  const { buckets } = await collect({ hostname: host, extraRoots, codexExtraHome });
  const payload = buildPayload(buckets, prices, { host, now });
  const written = writeIfChanged(outPath, serialize(payload));
  return { path: outPath, payload, written, unchanged: !written };
}

/** 默认输出路径：`<repo>/data/<host>.json`。 */
export function defaultOutPath(repoRoot, host = localHostname()) {
  return join(repoRoot, 'data', `${host}.json`);
}
