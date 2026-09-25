// CLI 入口。零依赖的手写参数解析（参数很少，引一个库不划算）。
//
// 所有操作都是**手动触发**的：没有 daemon、没有定时任务、没有后台进程。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// ESM 里没有 require，但检测 node:sqlite 是否可用需要同步 try/catch 一个内建模块。
const require = createRequire(import.meta.url);
import { collect, localHostname } from './collect.js';
import { loadPrices, summarize, fmtUSD, DEFAULT_PRICES_PATH } from './pricing/cost.js';
import { buildReport } from './report/aggregate.js';
import { render, renderSessions } from './report/render.js';
import { loadManual, addManual, removeManual, validate, MANUAL_PATH, STATE_DIR } from './manual.js';
import { publish, defaultOutPath } from './publish.js';
import { parsers } from './upstream/parsers/index.js';
import {
  isReachable, probe, sync as syncMirror, mirrorRoots, mirrorStatus,
  hasMirror, fmtBytes, mirrorBase,
} from './mirror.js';

const dim = (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[1m${s}\x1b[0m` : s);
const yellow = (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[33m${s}\x1b[0m` : s);

const HELP = `
vibe-local — 本地 AI 编程工具用量与花费统计

用法
  vibe-local [--days N] [--no-projects]     采集并出报告（默认最近 7 天）
  vibe-local sync                           只采集，不出报告（预热 codex 索引缓存）
  vibe-local doctor                         环境自检

远程（把服务器上的日志增量镜像到本地，再用同一套 parser 解析）
  vibe-local mirror                         探测规模并同步全部
  vibe-local mirror --status                只看镜像状态，不传输
  vibe-local mirror --only claude-code      只同步指定来源（逗号分隔）
  vibe-local mirror --host <ssh别名>        指定主机（或用 VIBE_LOCAL_REMOTE）
  报告默认会尝试远程；--no-remote 跳过。服务器不可达只提示、不报错。

定价
  vibe-local prices                         列出价格表及来源
  vibe-local prices update                  报告过期条目与该核对的官方 URL（不自动改数字）
  vibe-local prices edit                    打开 prices.json

手工录入（补本地日志抓不到的用量）
  vibe-local add --start YYYY-MM-DD --end YYYY-MM-DD --model M [token 选项]
  vibe-local manual                         列出全部手工录入
  vibe-local manual --remove <id>           删除一条
  vibe-local manual --edit                  打开 manual.jsonl

add 的选项
  --label <名>        标签，会成为统计里的 source（默认 manual）
  --input / --output / --cache-read / --cache-write-5m / --cache-write-1h / --reasoning
  --cost <美元>       直接指定总额（优先级最高）
  --price-in / --price-out <每百万美元>   指定单价，由工具算总额
  --note <备注>

环境变量
  VIBE_LOCAL_DIR     状态目录（默认 ~/.vibe-local）
  VIBE_LOCAL_CACHE_DIR   codex 索引缓存目录
  NO_COLOR           关闭彩色输出
`;

function parseArgs(argv) {
  const flags = new Map();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

const num = (v) => {
  if (v === undefined || v === true) return undefined;
  const n = Number(String(v).replace(/[,_]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

export async function run(argv) {
  const { flags, rest } = parseArgs(argv);
  const cmd = rest[0];
  const sub = rest[1];

  if (flags.has('help') || flags.has('h') || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'prices') return pricesCommand(sub, flags);
  if (cmd === 'add') return addCommand(flags);
  if (cmd === 'manual') return manualCommand(flags);
  if (cmd === 'doctor') return doctorCommand();
  if (cmd === 'mirror') return mirrorCommand(flags);
  if (cmd === 'sync') return syncCommand(flags);
  if (cmd === 'publish') return await publishCommand(flags);
  return reportCommand(flags);
}

// ── 发布 ────────────────────────────────────────────────────────────────────
async function publishCommand(flags) {
  const repoRoot = flags.get('repo') || process.cwd();
  const host = flags.get('host') || localHostname();
  const outPath = flags.get('out') || defaultOutPath(repoRoot, host);

  const res = await publish({ outPath, host });

  const days = res.payload.days;
  const total = days.reduce((a, d) => a + d.cost, 0);
  process.stdout.write(bold('\n  发布\n'));
  process.stdout.write(`  主机      ${res.payload.host}\n`);
  process.stdout.write(`  输出      ${res.path}\n`);
  process.stdout.write(`  天数      ${days.length}${days.length ? `  (${days[0].date} → ${days[days.length - 1].date})` : ''}\n`);
  process.stdout.write(`  合计      ${fmtUSD(total)}\n`);
  process.stdout.write(res.unchanged
    ? dim('  内容无变化，未写盘\n\n')
    : `  ${dim('已写入')} ${res.written ? '' : dim('（内容未变）')}\n\n`);
  return 0;
}

// ── 远程镜像 ────────────────────────────────────────────────────────────────
function mirrorCommand(flags) {
  const host = flags.get('host') || REMOTE_HOST;
  if (!host) {
    process.stderr.write(yellow('\n  未指定主机。用 --host <ssh别名>，或设 VIBE_LOCAL_REMOTE。\n\n'));
    return 1;
  }

  if (flags.has('status')) {
    const st = mirrorStatus(host);
    process.stdout.write(bold(`\n  镜像状态  ${mirrorBase(host)}\n\n`));
    process.stdout.write(`  可达: ${isReachable(host) ? '✓' : yellow('✗')}\n`);
    for (const p of st.present) process.stdout.write(`  ✓ ${p}\n`);
    for (const m of st.missing) process.stdout.write(`  ${yellow('·')} ${m}  ${dim('未同步')}\n`);
    process.stdout.write('\n');
    return 0;
  }

  if (!isReachable(host)) {
    process.stderr.write(yellow(`\n  无法连接 ${host}。\n`));
    process.stderr.write(dim(`  检查：机器是否开机、隧道/Tailscale 是否在、ssh ${host} 能否手动连上。\n\n`));
    return 1;
  }

  // 先报规模。共享服务器上的 IO 纪律：让用户知道要传多少、传多久，再动手。
  process.stdout.write(bold(`\n  探测 ${host} 上的数据规模…\n\n`));
  const rows = probe(host);
  let totalKb = 0;
  for (const r of rows) {
    totalKb += r.kb;
    process.stdout.write(`  ${r.path.padEnd(34)} ${fmtBytes(r.kb).padStart(9)}  ${String(r.files).padStart(6)} 文件\n`);
  }
  process.stdout.write(`  ${'─'.repeat(58)}\n`);
  process.stdout.write(`  ${'合计'.padEnd(34)} ${fmtBytes(totalKb).padStart(9)}\n\n`);

  const only = flags.get('only');
  const t0 = Date.now();
  const res = syncMirror({
    host,
    only: typeof only === 'string' ? only.split(',') : undefined,
    onProgress: (s) => process.stdout.write(s + '\n'),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(res.ok ? `\n  ✓ 同步完成 ${secs}s\n\n` : yellow(`\n  ✗ ${res.reason}\n\n`));

  const st = mirrorStatus(host);
  if (st.missing.length > 0) {
    process.stdout.write(yellow(`  未同步：${st.missing.join(', ')}\n`));
    process.stdout.write(dim(`  这些工具在报告里会缺服务器部分（且会显式标注，不会静默当 0）。\n\n`));
  }
  return res.ok ? 0 : 1;
}

// ── 采集（本地 + 远程镜像）────────────────────────────────────────────────────

// 远程镜像的主机名**没有默认值** —— 那属于各人的私有基础设施，不该硬编码进
// 公开仓库。未设置时直接跳过远程，只出本地结果（远程不可达本就是常态）。
const REMOTE_HOST = process.env.VIBE_LOCAL_REMOTE?.trim() || null;

/**
 * 两遍采集：先本地，再远程镜像。**必须分开跑**——远程那遍用替换语义的环境
 * 变量把根指向镜像，会与本地根互斥；合成一遍会让本机数据被贴上远程 hostname。
 *
 * 远程不可达是常态（隧道没起、机器没开），所以只提示、不报错、不阻塞本地结果。
 */
async function collectAll(flags) {
  const local = await collect({
    extraRoots: {},
    codexExtraHome: flags.get('codex-extra-home'),
  });

  if (flags.has('no-remote') || !REMOTE_HOST) return local;

  const mr = mirrorRoots(REMOTE_HOST);
  if (!hasMirror(REMOTE_HOST)) {
    process.stderr.write(dim(`  远程镜像尚未建立，跑 \`vibe-local mirror\` 拉取（或 --no-remote 跳过此提示）\n`));
    return local;
  }
  if (!isReachable(REMOTE_HOST)) {
    process.stderr.write(dim(`  远程 ${REMOTE_HOST} 不可达，本次只统计本机\n`));
    return local;
  }

  // 检查镜像各来源是否真的有内容。上游 parser 对"根目录不存在"是静默返回 0 的，
  // 不在这里拦一道，用户会看到"远程某工具零用量"而真相是数据没拉下来。
  const status = mirrorStatus(REMOTE_HOST);

  let remote;
  try {
    remote = await collect({ hostname: REMOTE_HOST.toLowerCase(), env: mr.env });
  } catch (err) {
    process.stderr.write(yellow(`  远程采集失败（已跳过）：${err.message}\n`));
    return local;
  }

  // 按工具归并：codex 有 sessions/ 与 archived_sessions/ 两条路径，报两次是噪音。
  const missingBySource = new Map();
  for (const m of status.missing) {
    const id = m.split('/')[0];
    missingBySource.set(id, (missingBySource.get(id) ?? 0) + 1);
  }
  const missingNote = [...missingBySource].map(([id, paths]) => ({
    source: `remote:${id}`,
    reason: `镜像未同步${paths > 1 ? `（${paths} 条路径）` : ''}，跑 \`vibe-local mirror\`；本次不含服务器上的该工具用量`,
  }));

  return {
    ...local,
    buckets: [...local.buckets, ...remote.buckets],
    sessions: [...local.sessions, ...remote.sessions],
    reports: [...local.reports, ...remote.reports, ...missingNote],
  };
}

// ── 报告 ────────────────────────────────────────────────────────────────────
async function reportCommand(flags) {
  const days = clampDays(num(flags.get('days')));
  const prices = loadPrices();
  const manual = loadManual();

  const t0 = Date.now();
  process.stderr.write(dim('  采集中…\n'));
  const { buckets, sessions, reports } = await collectAll(flags);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const report = buildReport(buckets, prices, {
    days,
    reports,
    manual,
  });

  process.stdout.write(render(report, { days, showProjects: !flags.has('no-projects') }));
  const sess = renderSessions(sessions, { days });
  if (sess) process.stdout.write(sess);
  process.stderr.write(dim(`  采集耗时 ${elapsed}s · 价格表 ${Object.keys(prices.models).length} 条\n`));
  return 0;
}

async function syncCommand(flags) {
  const t0 = Date.now();
  const { buckets, sessions, reports } = await collect({
    codexExtraHome: flags.get('codex-extra-home'),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`  采集完成 ${elapsed}s · ${buckets.length} buckets · ${sessions.length} sessions\n`);
  for (const r of reports) {
    const mark = r.ok ? '✓' : r.skipped ? '⚠' : '✗';
    process.stdout.write(`  ${mark} ${r.source.padEnd(12)} buckets=${String(r.buckets).padStart(4)} sessions=${String(r.sessions).padStart(4)}\n`);
    for (const w of r.warnings ?? []) process.stderr.write(dim(`      ${w}\n`));
    if (r.error) process.stderr.write(yellow(`      ${r.error}\n`));
  }
  return 0;
}

// ── 定价 ────────────────────────────────────────────────────────────────────
function pricesCommand(sub, flags) {
  const prices = loadPrices();

  if (sub === 'edit') {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    spawnSync(editor, [DEFAULT_PRICES_PATH], { stdio: 'inherit' });
    return 0;
  }

  if (sub === 'update') return pricesUpdate(prices);

  // 默认：列出表
  const rows = Object.entries(prices.models);
  process.stdout.write(bold(`\n  价格表（${rows.length} 条）  ${DEFAULT_PRICES_PATH}\n\n`));
  for (const [model, e] of rows.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (e.free) {
      process.stdout.write(`  ${model.padEnd(38)} ${dim('免费 / 不计费'.padEnd(28))} ${dim(e.note ?? '')}\n`);
      continue;
    }
    const p = e.input != null
      ? `in ${e.input}  out ${e.output}  read ${e.cache_read ?? '—'}  w5m ${e.cache_write_5m ?? '—'}  w1h ${e.cache_write_1h ?? '—'}`
      : '(无价格字段)';
    process.stdout.write(`  ${model.padEnd(38)} ${p}\n`);
    if (e.note) process.stdout.write(`      ${dim(e.note)}\n`);
    if (e.derived_from) process.stdout.write(`      ${dim(`推导自 ${e.derived_from}：${e.rule}`)}\n`);
  }
  for (const [model, e] of Object.entries(prices.unpricedKnown)) {
    if (model.startsWith('_')) continue;
    process.stdout.write(`  ${model.padEnd(38)} ${yellow('已确认官方无价 → $0（会出现在报告提醒里）')}\n`);
    if (e.note) process.stdout.write(`      ${dim(e.note)}\n`);
  }
  process.stdout.write(`\n  ${dim('来源 URL 见 prices.json 每个条目的 source_url 字段')}\n\n`);
  return 0;
}

/**
 * `prices update` —— **不抓取、不改数字**。
 *
 * 职责是告诉用户：哪些条目该重新核对了、去哪个官方 URL 核对、以及哪些实际用到的
 * 模型还没有价格。实际数字由人核对官方页后写入。
 */
function pricesUpdate(prices) {
  const now = new Date();
  const STALE_DAYS = 30;
  const stale = [];
  for (const [model, e] of Object.entries(prices.models)) {
    if (e.free || !e.as_of) continue;
    const age = Math.round((now - new Date(e.as_of)) / 86400000);
    if (age > STALE_DAYS) stale.push({ model, as_of: e.as_of, age, url: e.source_url });
  }

  process.stdout.write(bold(`\n  价格表状态（今天 ${now.toISOString().slice(0, 10)}）\n\n`));

  if (stale.length === 0) {
    process.stdout.write(`  ✓ 没有超过 ${STALE_DAYS} 天未核对的条目\n`);
  } else {
    process.stdout.write(`  ${yellow(`过期（as_of 超过 ${STALE_DAYS} 天）`)}\n`);
    for (const s of stale) {
      process.stdout.write(`    ${s.model.padEnd(34)} ${s.as_of}  (${s.age} 天)  ${dim(s.url ?? '')}\n`);
    }
  }

  const unpriced = Object.entries(prices.unpricedKnown).filter(([k]) => !k.startsWith('_'));
  if (unpriced.length > 0) {
    process.stdout.write(`\n  ${yellow('已确认官方无价（按 $0 计）')}\n`);
    for (const [model, e] of unpriced) {
      process.stdout.write(`    ${model.padEnd(34)} ${dim(`核对于 ${e.searched}`)}\n`);
    }
  }

  process.stdout.write(`\n  ${dim('要更新：核对上面的官方 URL，改 prices.json，或让我（Claude）核对后提 diff 给你确认。')}\n\n`);
  return 0;
}

// ── 手工录入 ────────────────────────────────────────────────────────────────
function addCommand(flags) {
  const entry = {
    label: flags.get('label'),
    project: flags.get('project'),
    model: flags.get('model'),
    start: flags.get('start'),
    end: flags.get('end'),
    note: flags.get('note'),
    cost: num(flags.get('cost')),
    price_in: num(flags.get('price-in')),
    price_out: num(flags.get('price-out')),
    tokens: {
      input: num(flags.get('input')),
      output: num(flags.get('output')),
      cache_read: num(flags.get('cache-read')),
      cache_write_5m: num(flags.get('cache-write-5m')),
      cache_write_1h: num(flags.get('cache-write-1h')),
      reasoning: num(flags.get('reasoning')),
    },
  };

  const errs = validate(entry);
  if (errs.length > 0) {
    process.stderr.write(yellow('  无法添加：\n'));
    for (const e of errs) process.stderr.write(`    ${e}\n`);
    return 1;
  }

  const res = addManual(entry);
  if (!res.added) {
    process.stdout.write(`  已存在（id ${res.id}），未重复添加。\n`);
    return 0;
  }
  const t = res.record.tokens;
  const days = Math.round((new Date(entry.end) - new Date(entry.start)) / 86400000) + 1;
  process.stdout.write(`\n  ✓ 已记录  id=${res.id}\n`);
  process.stdout.write(`    ${entry.start} → ${entry.end}（${days} 天）  ${res.record.label}  ${entry.model}\n`);
  const parts = [];
  if (t.input) parts.push(`in ${t.input.toLocaleString()}`);
  if (t.output) parts.push(`out ${t.output.toLocaleString()}`);
  if (t.cache_read) parts.push(`cache-read ${t.cache_read.toLocaleString()}`);
  if (parts.length) process.stdout.write(`    ${parts.join(' · ')}\n`);
  if (res.record.cost != null) process.stdout.write(`    金额 $${res.record.cost}\n`);
  if (res.record.price_in != null) process.stdout.write(`    单价 in $${res.record.price_in}/M\n`);
  process.stdout.write(dim(`    （趋势图上按天摊平显示，与实测值用不同字符区分）\n\n`));
  return 0;
}

function manualCommand(flags) {
  if (flags.has('edit')) {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    spawnSync(editor, [MANUAL_PATH], { stdio: 'inherit' });
    return 0;
  }
  if (flags.get('remove')) {
    const id = String(flags.get('remove'));
    const ok = removeManual(id);
    process.stdout.write(ok ? `  已删除 ${id}\n` : yellow(`  没找到 id=${id}\n`));
    return ok ? 0 : 1;
  }

  const m = loadManual();
  if (m.entries.length === 0) {
    process.stdout.write(`\n  还没有手工录入。\n  ${dim('用 `vibe-local add --help` 看怎么加。')}\n\n`);
    return 0;
  }
  process.stdout.write(bold(`\n  手工录入（${m.entries.length} 条）  ${m.path}\n\n`));
  for (const e of m.entries) {
    const t = e.tokens ?? {};
    const days = Math.round((new Date(e.end) - new Date(e.start)) / 86400000) + 1;
    process.stdout.write(`  ${e.id}  ${e.start} → ${e.end} (${days}d)  ${String(e.label).padEnd(14)} ${e.model}\n`);
    const parts = [];
    if (t.input) parts.push(`in ${t.input.toLocaleString()}`);
    if (t.output) parts.push(`out ${t.output.toLocaleString()}`);
    if (t.cache_read) parts.push(`cache-read ${t.cache_read.toLocaleString()}`);
    if (e.cost != null) parts.push(`$${e.cost}`);
    if (e.price_in != null) parts.push(`in $${e.price_in}/M`);
    if (parts.length) process.stdout.write(`        ${dim(parts.join(' · '))}\n`);
    if (e.note) process.stdout.write(`        ${dim(e.note)}\n`);
  }
  if (m.malformed) process.stdout.write(yellow(`\n  ⚠ ${m.malformed} 行无法解析，已跳过\n`));
  process.stdout.write('\n');
  return 0;
}

// ── 自检 ────────────────────────────────────────────────────────────────────
function doctorCommand() {
  const out = [];
  const line = (s) => out.push(s);

  line(bold('\n  环境自检\n'));
  line(`  Node            ${process.version}  ${process.versions.node.split('.')[0] >= 22 ? dim('✓') : yellow('✗ 需要 >= 22（node:sqlite）')}`);

  let hasSqlite = false;
  try {
    require('node:sqlite');
    hasSqlite = true;
  } catch { /* 下面按结果输出 */ }
  line(`  node:sqlite     ${hasSqlite ? '可用' : yellow('不可用 —— opencode 解析会失败')}`);

  const host = localHostname();
  line(`  hostname        ${host}`);
  line(`  状态目录        ${STATE_DIR}  ${existsSync(STATE_DIR) ? '' : dim('(尚未创建)')}`);

  line(bold('\n  数据源\n'));
  for (const source of Object.keys(parsers)) {
    line(`  ${source.padEnd(14)} ${dim('已注册')}`);
  }

  const manual = loadManual();
  line(bold('\n  手工录入\n'));
  line(`  ${manual.entries.length} 条  ${dim(manual.path)}${manual.malformed ? yellow(`  (${manual.malformed} 行解析失败)`) : ''}`);

  const prices = loadPrices();
  line(bold('\n  定价\n'));
  line(`  ${Object.keys(prices.models).length} 条  ${dim(DEFAULT_PRICES_PATH)}`);
  const stale = Object.values(prices.models).filter((e) => !e.free && e.as_of
    && (Date.now() - new Date(e.as_of)) / 86400000 > 30).length;
  line(`  超过 30 天未核对：${stale === 0 ? dim('无') : yellow(`${stale} 条 —— 跑 \`vibe-local prices update\``)}`);

  line(bold('\n  远程镜像\n'));
  if (!REMOTE_HOST) {
    line(dim('  未配置。设 VIBE_LOCAL_REMOTE=<ssh别名> 后可用 `vibe-local mirror` 拉取远程机器的日志。'));
  } else {
    line(`  主机            ${REMOTE_HOST}`);
  }
  if (!REMOTE_HOST) {
    // 未配置就到此为止，下面的检查都依赖主机名
  } else if (!hasMirror(REMOTE_HOST)) {
    line(dim('  镜像尚未建立 —— 跑 `vibe-local mirror` 拉取'));
  } else {
    const reach = isReachable(REMOTE_HOST);
    line(`  可达            ${reach ? '✓' : yellow('✗')}${reach ? '' : dim('（不可达属常态，报告会自动跳过远程）')}`);
    const st = mirrorStatus(REMOTE_HOST);
    for (const p of st.present) line(`  ✓ ${p}`);
    for (const m of st.missing) line(`  ${yellow('·')} ${m}  ${dim('未同步 —— 报告里会显式标注，不会静默当 0')}`);
  }

  line('');
  process.stdout.write(out.join('\n'));
  return 0;
}

function clampDays(v) {
  if (!v || v < 1) return 7;
  return Math.min(v, 365);
}
