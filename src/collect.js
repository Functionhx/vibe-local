// 本地采集层：运行 parser，产出 buckets / sessions。
//
// 这是上游 `sync.js:163-228` 的等价物，但**只有那一段纯本地逻辑**。上游那 53 行
// 之所以不能直接复用，是因为包着它的 `runSync()` 有两道我们不要的前置：
//   - `sync.js:104-108` 没有 apiKey 直接 process.exit(1)
//   - `sync.js:131` 在任何解析之前先发 `fetchSettings` 网络请求
// 两者都是"上传"语义的一部分，与本地工具无关。
//
// 保留的核心语义（这些是上游踩过坑的，不能省）：
//   1. per-parser 隔离：一个 parser 抛异常 ≠ 该工具用量为零
//   2. `skipped` 是"本次结果不可信"，不是"数据为空"
//   3. `normalizeParserResult` 校验 source，防某个 parser 写错 source 污染统计
//   4. 有界并发，一个慢 parser 不能拖住其余

import { hostname as osHostname } from 'node:os';
import { parsers } from './upstream/parsers/index.js';
import { normalizeParserResult } from './upstream/parsers/contract.js';

// 与上游 sync.js:79 一致（上游取 4 是为了避开 Cursor 的网络抓取；我们没这个
// 顾虑，但 4 对 I/O 密集的日志解析依然是个合理上限，且能压住内存峰值）。
export const PARSER_CONCURRENCY = 4;

/**
 * 跑 `fn` 处理 items，最多 `limit` 个在飞，结果按原顺序返回。
 * 逐字照搬上游 sync.js:82-95 —— 顺序确定性对报告稳定性有影响。
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 本机默认 hostname。去掉 macOS mDNS 的 `.local` 后缀，与上游 sync.js:274 一致
 * （否则同一台机器在不同时刻可能算出两个不同的 hostname，把 bucket 键劈开）。
 */
export function localHostname() {
  return osHostname().replace(/\.local$/, '');
}

/**
 * 运行全部 parser，返回合并后的 buckets / sessions。
 *
 * @param {object} [opts]
 * @param {string} [opts.hostname]  打到每个 bucket 上的 hostname。
 *   本机传 `localHostname()`，远程镜像传镜像名（如 `dwan`）——**这是本机与远程
 *   数据不互相污染的关键**：bucket 的分组键含 hostname，两台机器上同名的
 *   project 若不区分就会被合并统计。
 * @param {Record<string, string[]>} [opts.extraRoots]  按 source 追加扫描根
 * @param {string} [opts.codexExtraHome]  额外的 CODEX_HOME
 * @param {number} [opts.concurrency]
 * @returns {Promise<{
 *   buckets: object[], sessions: object[],
 *   reports: Array<{source:string, ok:boolean, skipped:boolean, buckets:number,
 *                   sessions:number, warnings:string[], indexing?:object, error?:string}>,
 *   hostname: string,
 * }>}
 */
export async function collect({
  hostname = localHostname(),
  extraRoots = {},
  codexExtraHome,
  env = null,
  concurrency = PARSER_CONCURRENCY,
} = {}) {
  const entries = Object.entries(parsers);

  // `env` 给某些 source 指定**替换语义**的根目录（如把 claude 指向镜像）。
  // 为什么需要它而不是只用 extraRoots：`extraRoots` 是**追加**——它会和默认根
  // 一起被扫描。实测过这个坑：本机 255 buckets + 镜像 369 buckets = 624，
  // 而用 extraRoots 得到的结果正是 624，也就是两份数据被混在一起、还被统一
  // 贴上了远程的 hostname。那种错误在报表上完全看不出来。
  //
  // 环境变量是**替换**语义，所以能干净分离。代价是它是进程级的，因此一旦用到
  // env 就**强制串行**（concurrency=1）——并发时几个 parser 会互相覆盖对方的
  // 环境变量，产出会随调度顺序漂移，比数据混在一起更难查。
  const usesEnv = env && Object.keys(env).length > 0;
  const effectiveConcurrency = usesEnv ? 1 : concurrency;

  const runOne = async (source, parse) => {
    const saved = new Map();
    const vars = env?.[source];
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        process.env[k] = v;
      }
    }
    try {
      const result = await parse({
        extraRoots: Array.isArray(extraRoots[source]) ? extraRoots[source].filter(Boolean) : [],
        ...(source === 'codex' && codexExtraHome ? { codexExtraHome } : {}),
      });
      return { source, result };
    } catch (err) {
      // 一个 parser 崩了不代表这个工具没用量。记录下来，继续跑其余的。
      return { source, error: err };
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const outcomes = await mapWithConcurrency(entries, effectiveConcurrency, ([source, parse]) => runOne(source, parse));

  const buckets = [];
  const sessions = [];
  const reports = [];

  for (const { source, result, error } of outcomes) {
    if (error) {
      reports.push({
        source, ok: false, skipped: true, buckets: 0, sessions: 0,
        warnings: [], error: error.message,
      });
      continue;
    }

    let normalized;
    try {
      normalized = normalizeParserResult(source, result);
    } catch (err) {
      // source 与注册键不符 —— 宁可漏掉这个工具，也不能让它污染别人的统计。
      reports.push({
        source, ok: false, skipped: true, buckets: 0, sessions: 0,
        warnings: [], error: err.message,
      });
      continue;
    }

    const { warnings, skipped, indexing } = normalized;

    // 打 hostname。这里**只赋值不重新聚合**：同一次运行产出的 bucket 全部打上
    // 同一个值，分组键 (source|model|project|hostname|bucketStart) 不可能因此
    // 合并或分裂，重新聚合是纯浪费。
    //
    // （上游有个 `reaggregateHiddenProjectBuckets()` 要重新聚合，是因为它会把
    // project 改写成 'unknown' —— 那**确实**会让多个 bucket 落到同一个键上。
    // 我们保留真实 project 名，所以没这个问题。也正因如此，若将来要掩码
    // project，必须连带把 bucketStart → timestamp 转换后再喂回
    // aggregateToBuckets，否则它会读到 undefined 而炸。）
    for (const bucket of normalized.buckets) {
      buckets.push({ ...bucket, hostname });
    }
    for (const session of normalized.sessions) {
      // session 也要打，且必须在打完之后才算它的 hash —— 上游
      // sync.js:317-324 的注释专门强调过这个顺序。
      sessions.push({ ...session, hostname });
    }

    reports.push({
      source,
      ok: !skipped,
      skipped,
      buckets: normalized.buckets.length,
      sessions: normalized.sessions.length,
      warnings,
      ...(indexing ? { indexing } : {}),
    });
  }

  return { buckets, sessions, reports, hostname };
}
