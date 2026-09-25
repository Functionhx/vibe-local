// 报告层测试，**必须喂真实的 bucket 对象**。
//
// 存在理由：时区改造时我漏改了一个 `localDayKey` 调用点，而当时所有
// `buildReport` 测试都传的是空数组 `[]` —— 桶处理路径从未被执行，测试全绿
// 但代码是坏的。这个文件专门守住那条路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, dayKey, daysBetween, dayKeysInWindow } from '../src/report/aggregate.js';
import { loadPrices } from '../src/pricing/cost.js';

const prices = loadPrices();

const bucket = (over = {}) => ({
  source: 'claude-code',
  model: 'claude-opus-5',
  project: 'some-project',
  hostname: 'test-host',
  bucketStart: '2026-09-24T12:00:00.000Z',
  inputTokens: 1_000_000,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  totalTokens: 1_000_000,
  ...over,
});

// UTC+8 的"今天" = 2026-09-25
const NOW = new Date('2026-09-24T19:00:00Z');

test('真实 bucket 会被计入日聚合（不是空数组路径）', () => {
  const r = buildReport([bucket()], prices, { days: 7, now: NOW, reports: [], manual: { entries: [] } });
  // 2026-09-24T12:00Z = UTC+8 20:00 当天 → 日键 2026-09-24
  const d = r.byDay.get('2026-09-24');
  assert.ok(d.cost > 0, '该日应有成本');
  assert.ok(d.measuredCost > 0, '且应记在 measured 侧，不是 spread');
  assert.equal(d.spreadCost, 0);
  assert.equal(r.totalCost, d.cost);
});

test('bucket 落在窗口外时不贡献', () => {
  const old = bucket({ bucketStart: '2026-01-01T12:00:00.000Z' });
  const r = buildReport([old], prices, { days: 7, now: NOW, reports: [], manual: { entries: [] } });
  assert.equal(r.totalCost, 0);
});

test('跨 UTC+8 日界的两个 bucket 落到不同的日', () => {
  const before = bucket({ bucketStart: '2026-09-24T15:59:00.000Z' }); // UTC+8 23:59
  const after = bucket({ bucketStart: '2026-09-24T16:01:00.000Z' });  // UTC+8 次日 00:01
  const r = buildReport([before, after], prices, { days: 7, now: NOW, reports: [], manual: { entries: [] } });
  assert.ok(r.byDay.get('2026-09-24').cost > 0, '日界前的应落在 09-24');
  assert.ok(r.byDay.get('2026-09-25').cost > 0, '日界后的应落在 09-25');
  assert.equal(r.byDay.get('2026-09-24').measuredCost, r.byDay.get('2026-09-25').measuredCost);
});

test('byModel / bySource / byProject 都被填充', () => {
  const r = buildReport([bucket()], prices, { days: 7, now: NOW, reports: [], manual: { entries: [] } });
  assert.ok(r.byModel.get('claude-opus-5').cost > 0);
  assert.ok(r.bySource.get('claude-code').cost > 0);
  assert.ok(r.byProject.get('some-project').cost > 0);
});

test('无价格模型的 token 仍计入总量，只是成本为 0', () => {
  const b = bucket({ model: 'gpt-5.3-codex-spark' });
  const r = buildReport([b], prices, { days: 7, now: NOW, reports: [], manual: { entries: [] } });
  assert.equal(r.totalCost, 0, '无价 → 成本 0');
  assert.ok(r.totalTokens > 0, '但 token 必须计入，否则用户以为用量丢了');
  assert.equal(r.unpriced.length, 1);
  assert.equal(r.unpriced[0].model, 'gpt-5.3-codex-spark');
});

test('cache read 单列，不混进 tokens', () => {
  const b = bucket({ cachedInputTokens: 5_000_000, totalTokens: 1_000_000 });
  const r = buildReport([b], prices, { days: 7, now: NOW, reports: [], manual: { entries: [] } });
  assert.equal(r.totalCacheRead, 5_000_000);
  assert.equal(r.totalTokens, 1_000_000, 'tokens 不含 cache read');
});

test('dayKeysInWindow 在 UTC+8 日界上算，且连续', () => {
  const keys = dayKeysInWindow(7, NOW);
  assert.equal(keys.length, 7);
  assert.equal(keys[6], '2026-09-25', '最后一天是 UTC+8 的今天');
  assert.equal(keys[0], '2026-09-19');
  // 连续性：相邻两天相差 1
  for (let i = 1; i < keys.length; i++) {
    assert.equal(daysBetween(keys[i - 1], keys[i]), 2, `${keys[i - 1]} → ${keys[i]} 应相邻`);
  }
});

test('daysBetween 是纯日历运算（含首尾）', () => {
  assert.equal(daysBetween('2026-09-24', '2026-09-24'), 1);
  assert.equal(daysBetween('2026-08-01', '2026-08-31'), 31);
  assert.equal(daysBetween('2026-02-01', '2026-03-01'), 29); // 2026 非闰年：2月28天
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 2);  // 跨年
});
