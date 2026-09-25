import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addManual, loadManual, removeManual, manualId, normalizeTokens, validate } from '../src/manual.js';
import { buildReport, windowStart, dayKey, daysBetween } from '../src/report/aggregate.js';
import { loadPrices } from '../src/pricing/cost.js';

const prices = loadPrices();

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-local-test-'));
  try {
    return fn(join(dir, 'manual.jsonl'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('幂等：同样内容重复添加不会重复计数', () => withTempDir((path) => {
  const e = { label: 'web', model: 'claude-opus-5', start: '2026-08-01', end: '2026-08-31', tokens: { input: 100 } };
  assert.equal(addManual(e, path).added, true);
  assert.equal(addManual(e, path).added, false, '第二次应被去重');
  assert.equal(loadManual(path).entries.length, 1);
}));

test('同内容不同金额算不同条目（不会被误去重）', () => withTempDir((path) => {
  const base = { label: 'web', model: 'm', start: '2026-08-01', end: '2026-08-31' };
  addManual({ ...base, cost: 10 }, path);
  addManual({ ...base, cost: 20 }, path);
  assert.equal(loadManual(path).entries.length, 2);
}));

test('校验拒绝非法输入', () => {
  assert.ok(validate({ model: 'm', start: '2026-08-01', end: '2026-07-01', tokens: { input: 1 } }).length > 0,
    'end 早于 start 应被拒绝');
  assert.ok(validate({ model: 'm', start: '2026-8-1', end: '2026-08-31', tokens: { input: 1 } }).length > 0,
    '日期格式不严应被拒绝');
  assert.ok(validate({ model: 'm', start: '2026-08-01', end: '2026-08-31' }).length > 0,
    '没有任何数值应被拒绝');
  assert.equal(validate({ model: 'm', start: '2026-08-01', end: '2026-08-31', cost: 5 }).length, 0);
});

test('normalizeTokens 的 total 口径与 bucket 一致（不含 cache read）', () => {
  const t = normalizeTokens({ input: 1, output: 2, reasoning: 3, cache_write_5m: 4, cache_write_1h: 5, cache_read: 999 });
  assert.equal(t.total, 1 + 2 + 3 + 4 + 5);
  assert.equal(t.cache_read, 999);
});

test('删除', () => withTempDir((path) => {
  const { id } = addManual({ model: 'm', start: '2026-08-01', end: '2026-08-02', cost: 1 }, path);
  assert.equal(removeManual(id, path), true);
  assert.equal(removeManual(id, path), false, '重复删除应返回 false');
  assert.equal(loadManual(path).entries.length, 0);
}));

// 所有 buildReport 测试都用**带 Z 的显式 UTC 时刻**，不用无时区的字符串——
// `new Date('2026-09-24T12:00:00')` 会按机器本地时区解析，测试就不再可复现了。
//
// NOW 对应的 UTC+8 墙钟是 2026-09-25 03:00，所以"今天"= 2026-09-25。
const NOW = new Date('2026-09-24T19:00:00Z');

test('窗口感知摊平：只计入落在窗口内的那部分', () => {
  const entry = {
    id: 'x', label: 'web', model: 'claude-opus-5',
    start: '2026-09-20', end: '2026-09-30',  // 11 天
    tokens: normalizeTokens({ input: 0 }), cost: 110,
  };

  // 7 天窗口 = 09-19..09-25，与 09-20..09-30 重叠 6 天 → 6/11 × 110 = 60
  const r7 = buildReport([], prices, { days: 7, now: NOW, reports: [], manual: { entries: [entry] } });
  assert.ok(Math.abs(r7.totalCost - 60) < 1e-9, `7 天窗口期望 60，得到 ${r7.totalCost}`);
  assert.equal(r7.days[0], '2026-09-19');
  assert.equal(r7.days[6], '2026-09-25');
});

test('条目尾部超出今天时，未来那部分不计入（窗口以今天收口）', () => {
  // 窗口是 [今天-(days-1), 今天]，**不延伸到未来**。所以即便给 365 天窗口，
  // 一条 09-20..09-30 的记录在 09-25 这天也只能算出 6/11 —— 还没发生的用量
  // 不应该进报表。
  const entry = {
    id: 'x', label: 'web', model: 'claude-opus-5',
    start: '2026-09-20', end: '2026-09-30',
    tokens: normalizeTokens({ input: 0 }), cost: 110,
  };
  const r = buildReport([], prices, { days: 365, now: NOW, reports: [], manual: { entries: [entry] } });
  assert.ok(Math.abs(r.totalCost - 60) < 1e-9, `期望 60（未来 5 天不计），得到 ${r.totalCost}`);
});

test('完全位于过去的时间段在足够宽的窗口里全额计入', () => {
  const entry = {
    id: 'past', label: 'web', model: 'claude-opus-5',
    start: '2026-08-01', end: '2026-08-31',  // 31 天，全部在过去
    tokens: normalizeTokens({ input: 0 }), cost: 310,
  };
  const r = buildReport([], prices, { days: 60, now: NOW, reports: [], manual: { entries: [entry] } });
  assert.ok(Math.abs(r.totalCost - 310) < 1e-9, `期望全额 310，得到 ${r.totalCost}`);
});

test('窗口外的手工录入完全不贡献', () => {
  const entry = {
    id: 'y', label: 'web', model: 'claude-opus-5',
    start: '2026-01-01', end: '2026-01-31',
    tokens: normalizeTokens({ input: 0 }), cost: 500,
  };
  const r = buildReport([], prices, { days: 7, now: NOW, reports: [], manual: { entries: [entry] } });
  assert.equal(r.totalCost, 0);
});

test('摊平的 measured/spread 分开记账（趋势图要区分实测与估算）', () => {
  const entry = {
    id: 'z', label: 'web', model: 'claude-opus-5',
    start: '2026-09-20', end: '2026-09-22', tokens: normalizeTokens({ input: 0 }), cost: 30,
  };
  const r = buildReport([], prices, { days: 7, now: NOW, reports: [], manual: { entries: [entry] } });
  const d = r.byDay.get('2026-09-21');
  assert.equal(d.measuredCost, 0, '没有实测数据');
  assert.ok(d.spreadCost > 0, '应记入 spread 侧');
  assert.equal(d.spread, true);
  const empty = r.byDay.get('2026-09-24');
  assert.equal(empty.spreadCost, 0);
  assert.equal(empty.measuredCost, 0);
});

test('dayKey 按 UTC+8 取日，且日界落在 UTC 16:00', () => {
  // UTC+8 的一天 = [UTC 16:00 前一天, UTC 16:00 当天)
  assert.equal(dayKey('2026-09-24T15:59:59.999Z'), '2026-09-24', '日界前一毫秒仍属当天');
  assert.equal(dayKey('2026-09-24T16:00:00.000Z'), '2026-09-25', '日界整点进入次日');
  assert.equal(dayKey('2026-09-24T12:00:00.000Z'), '2026-09-24', 'UTC+8 20:00');
  assert.equal(dayKey('2026-09-24T00:00:00.000Z'), '2026-09-24', 'UTC+8 08:00');
  assert.equal(dayKey('2026-09-23T20:00:00.000Z'), '2026-09-24', 'UTC+8 04:00 当天');
});

test('dayKey 对非法输入返回 null 而不是抛错', () => {
  assert.equal(dayKey('not-a-date'), null);
  assert.equal(dayKey(undefined), null);
});

test('日键与系统时区无关（子进程实测）', () => {
  // 这是整个 UTC+8 口径的根基：同一份日志在不同 TZ 环境下必须算出相同的日键。
  // 进程内改 TZ 无效（启动时已固定），所以起子进程。
  const code = `
    import { dayKey, daysBetween } from '${process.cwd()}/src/report/aggregate.js';
    console.log(JSON.stringify({
      a: dayKey('2026-09-24T16:00:00.000Z'),
      b: dayKey('2026-09-24T15:59:59.999Z'),
      c: daysBetween('2026-08-01', '2026-08-31'),
    }));
  `;
  const results = ['America/Los_Angeles', 'Asia/Shanghai', 'UTC', 'Pacific/Kiritimati']
    .map((tz) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
        { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      return { tz, out: r.stdout.trim(), err: r.stderr.trim() };
    });
  for (const { tz, out, err } of results) {
    assert.equal(err, '', `${tz} 下执行出错：${err}`);
  }
  const uniq = new Set(results.map((r) => r.out));
  assert.equal(uniq.size, 1, `不同 TZ 结果不一致：${JSON.stringify(results)}`);
  assert.equal(JSON.parse(results[0].out).a, '2026-09-25');
  assert.equal(JSON.parse(results[0].out).c, 31);
});

test('解析未完成的来源进入 partial，不会被当成 0 用量', () => {
  const reports = [
    { source: 'codex', ok: false, skipped: true, buckets: 0, sessions: 0, warnings: [], indexing: { phase: 'usage', completed: 1, total: 9 } },
    { source: 'opencode', ok: false, skipped: true, buckets: 0, sessions: 0, warnings: [], error: 'database is locked' },
    { source: 'claude-code', ok: true, skipped: false, buckets: 5, sessions: 2, warnings: [] },
  ];
  const r = buildReport([], prices, { days: 7, reports, manual: { entries: [] } });
  assert.equal(r.partial.length, 2);
  assert.ok(r.partial.some((p) => /索引未完成/.test(p.reason)));
  assert.ok(r.partial.some((p) => /database is locked/.test(p.reason)));
  assert.ok(!r.partial.some((p) => p.source === 'claude-code'), '成功的不该进 partial');
});
