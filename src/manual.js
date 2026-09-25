// 手工录入：补录本地日志抓不到的用量。
//
// 典型用途：
//   - 开始用这个工具**之前**的历史用量
//   - 网页版 / API 直调（本地没有任何日志）
//   - 工具读不到的软件
//
// 存储用 JSONL（一行一条）而不是单个 JSON：追加友好、可手工编辑、git diff 干净。
//
// **幂等性**：每条有稳定 id，追加前按 id 去重。重复执行同一条命令、或重复导入
// 同一个文件，不会重复计数。上游在这一点上反复踩坑（`kimi-code.js:438` 未重聚合
// 的数组拼接），我们在入口就杜绝。

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const STATE_DIR = process.env.VIBE_LOCAL_DIR?.trim() || join(homedir(), '.vibe-local');
export const MANUAL_PATH = join(STATE_DIR, 'manual.jsonl');

export function loadManual(path = MANUAL_PATH) {
  if (!existsSync(path)) return { entries: [], path };
  const entries = [];
  const seen = new Set();
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      malformed++; // 手工编辑出错时不要整个文件失效
      continue;
    }
    if (!e?.id) continue;
    if (seen.has(e.id)) continue; // 文件里若有重复 id，只认第一条
    seen.add(e.id);
    entries.push(e);
  }
  return { entries, path, malformed };
}

/** 由内容生成稳定 id。同样的内容反复录入 → 同一个 id → 不会重复计数。 */
export function manualId(entry) {
  const key = [entry.label ?? '', entry.model ?? '', entry.start ?? '', entry.end ?? '',
    JSON.stringify(entry.tokens ?? {}), entry.cost ?? '', entry.price_in ?? ''].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** 归一化 token 计数，并算出 total。total 的口径与 bucket 的 totalTokens 一致：
 *  input + output + reasoning + cache_write_5m + cache_write_1h，**不含 cache read**。 */
export function normalizeTokens(t = {}) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
  };
  const out = {
    input: n(t.input),
    output: n(t.output),
    cache_read: n(t.cache_read),
    cache_write_5m: n(t.cache_write_5m),
    cache_write_1h: n(t.cache_write_1h),
    reasoning: n(t.reasoning),
  };
  out.total = out.input + out.output + out.reasoning + out.cache_write_5m + out.cache_write_1h;
  return out;
}

export function validate(entry) {
  const errs = [];
  if (!entry.model) errs.push('必须指定 --model');
  if (!entry.start) errs.push('必须指定 --start（起止日期，格式 YYYY-MM-DD）');
  if (!entry.end) errs.push('必须指定 --end（起止日期，格式 YYYY-MM-DD）');
  for (const k of ['start', 'end']) {
    if (entry[k] && !/^\d{4}-\d{2}-\d{2}$/.test(entry[k])) errs.push(`${k} 格式应为 YYYY-MM-DD，收到 ${entry[k]}`);
  }
  if (entry.start && entry.end && entry.end < entry.start) errs.push('--end 不能早于 --start');
  const t = entry.tokens ?? {};
  const hasTokens = Object.values(t).some((v) => Number(v) > 0);
  if (!hasTokens && entry.cost == null && entry.price_in == null) {
    errs.push('至少要给出 token 数、--cost 或 --price-in 之一');
  }
  if (entry.cost != null && !(Number(entry.cost) >= 0)) errs.push('--cost 必须是非负数');
  return errs;
}

/**
 * 追加一条。已存在同 id 时**不写入**，返回 `{added:false}`。
 * @returns {{added:boolean, id:string, path:string}}
 */
export function addManual(entry, path = MANUAL_PATH) {
  mkdirSync(join(path, '..'), { recursive: true });
  const existing = loadManual(path);
  const id = entry.id || manualId(entry);
  if (existing.entries.some((e) => e.id === id)) {
    return { added: false, id, path };
  }
  const record = {
    id,
    label: entry.label || 'manual',
    model: entry.model,
    start: entry.start,
    end: entry.end,
    tokens: normalizeTokens(entry.tokens),
    cost: entry.cost ?? null,
    price_in: entry.price_in ?? null,
    price_out: entry.price_out ?? null,
    note: entry.note ?? null,
    project: entry.project ?? null,
    added_at: new Date().toISOString(),
  };
  appendFileSync(path, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  return { added: true, id, path, record };
}

/** 删除。返回是否真的删掉了。重写整个文件（条目数不会大到需要别的方案）。 */
export function removeManual(id, path = MANUAL_PATH) {
  const { entries } = loadManual(path);
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  writeFileSync(path, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return true;
}
