import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrices, lookupPrice, costOfBucket, isPeak } from '../src/pricing/cost.js';

const prices = loadPrices();

const bucket = (over = {}) => ({
  source: 'claude-code', model: 'claude-opus-5-5', project: 'p',
  bucketStart: '2026-09-24T12:00:00.000Z',
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
  reasoningOutputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
  ...over,
});

test('精确匹配官方价', () => {
  const h = lookupPrice(prices, 'claude-opus-5-5');
  assert.equal(h.matchedBy, 'exact');
  assert.equal(h.entry.input, 4.00);
  // 官方页脚注：Opus 5.5 的 cache read 是 0.05x，不是通用的 0.1x。
  // 这条断言守住那个例外——照抄 0.1x 规则会算错一倍。
  assert.equal(h.entry.cache_read, 0.20);
});

test('查表必须检查价格字段存在，不能只看键在不在', () => {
  // 空壳条目（只有 free 标记或说明文字）不应被当成有价
  const fake = { models: { 'x': { note: '只有说明' } }, unpricedKnown: {} };
  assert.equal(lookupPrice(fake, 'x'), null);
});

test('cost = 各分项按各自单价相加，reasoning 按 output 计', () => {
  const b = bucket({
    inputTokens: 1_000_000, outputTokens: 500_000, reasoningOutputTokens: 100_000,
    cachedInputTokens: 2_000_000, cacheCreation5mTokens: 1_000_000, cacheCreation1hTokens: 1_000_000,
  });
  // 1M×4 + 0.6M×20 + 2M×0.2 + 1M×5 + 1M×8 = 4 + 12 + 0.4 + 5 + 8 = 29.4
  const r = costOfBucket(b, prices);
  assert.ok(Math.abs(r.cost - 29.4) < 1e-9, `期望 29.4，得到 ${r.cost}`);
  assert.equal(r.priced, true);
});

test('五维齐全的 bucket 手算一致（回归：曾用错模型价格手算）', () => {
  const b = bucket({
    model: 'claude-opus-5', inputTokens: 144, outputTokens: 58106,
    cachedInputTokens: 14_582_229, cacheCreation5mTokens: 147_905, cacheCreation1hTokens: 57_301,
  });
  const p = prices.models['claude-opus-5'];
  const expect = (144 * p.input + 58106 * p.output + 14_582_229 * p.cache_read
    + 147_905 * p.cache_write_5m + 57_301 * p.cache_write_1h) / 1e6;
  const r = costOfBucket(b, prices);
  assert.ok(Math.abs(r.cost - expect) < 1e-9);
});

test('无价格的模型计入 unpriced 且成本为 0', () => {
  const r = costOfBucket(bucket({ model: 'gpt-5.3-codex-spark', inputTokens: 1e6 }), prices);
  assert.equal(r.cost, 0);
  assert.equal(r.priced, false);
  assert.equal(r.reason, 'not-found');
});

test('显式免费的模型不算 unpriced（否则提醒列表会被免费模型淹没）', () => {
  for (const m of ['mimo-v2.6-flash-free', 'nemotron-3-ultra-free']) {
    const r = costOfBucket(bucket({ model: m, inputTokens: 1e6 }), prices);
    assert.equal(r.cost, 0);
    assert.equal(r.priced, true, `${m} 应视为已定价（免费）`);
    assert.equal(r.free, true);
  }
});

test('fast/priority 后缀回退到基础价并标注推导来源', () => {
  // gpt-5.6-terra-priority 不在表里，但官方 fast tier = 2x
  const r = costOfBucket(bucket({ model: 'gpt-5.6-terra-priority', inputTokens: 1_000_000 }), prices);
  // terra 基础 input $2 → priority $4 → 1M = $4
  assert.ok(Math.abs(r.cost - 4) < 1e-9, `期望 4，得到 ${r.cost}`);
  assert.ok(r.derived, '应标记为推导值');
});

test('日期后缀剥离', () => {
  const h = lookupPrice(prices, 'gpt-5.6-sol-2026-07-09');
  assert.ok(h, '应能剥离日期后缀命中');
  assert.equal(h.matchedBy, 'strip-date');
});

test('DeepSeek 分时段：peak 窗口内为全价，窗口外半价', () => {
  const sched = prices.models['deepseek-flash'].peak_schedule;
  // 2026-09-24 是周四。02:00 UTC 在 peak 窗口 01:00-04:00 内
  assert.equal(isPeak('2026-09-24T02:00:00.000Z', sched), true);
  // 15:00 UTC 不在任何 peak 窗口内
  assert.equal(isPeak('2026-09-24T15:00:00.000Z', sched), false);
  // 周末一律 off-peak：2026-09-26 是周六，01:30 UTC 本该在 peak 窗口内
  assert.equal(isPeak('2026-09-26T01:30:00.000Z', sched), false);

  const peakCost = costOfBucket(bucket({
    model: 'deepseek-flash', bucketStart: '2026-09-24T02:00:00.000Z', inputTokens: 1_000_000,
  }), prices).cost;
  const offCost = costOfBucket(bucket({
    model: 'deepseek-flash', bucketStart: '2026-09-24T15:00:00.000Z', inputTokens: 1_000_000,
  }), prices).cost;
  assert.ok(Math.abs(peakCost - 0.30) < 1e-9, `peak 期望 0.30，得到 ${peakCost}`);
  assert.ok(Math.abs(offCost - 0.15) < 1e-9, `off-peak 期望 0.15，得到 ${offCost}`);
});

test('cache write 单价缺失时回落到 input 价，不产生 NaN', () => {
  // gpt-5.5 的 cache_write 在官方页是 "–"
  const r = costOfBucket(bucket({
    model: 'gpt-5.5', cacheCreation5mTokens: 1_000_000,
  }), prices);
  assert.equal(r.priced, true);
  assert.ok(Number.isFinite(r.cost));
  assert.ok(Math.abs(r.cost - 5.00) < 1e-9, `应回落 input 价 $5，得到 ${r.cost}`);
});

test('每个有价条目都带 as_of 与官方来源 URL（可追溯性）', () => {
  for (const [model, e] of Object.entries(prices.models)) {
    if (e.free) continue;
    assert.ok(e.as_of, `${model} 缺少 as_of`);
    assert.ok(e.source_url, `${model} 缺少 source_url`);
    assert.match(e.source_url, /^https:\/\//, `${model} 的来源应为 https`);
  }
});
