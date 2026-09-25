// 渲染层：终端表格 + 每日趋势条。
//
// 三条硬性要求（不是审美问题，是诚实性问题）：
//   1. **摊平值必须与实测值视觉可区分** —— 手工录入按时间段摊到每天后是估算，
//      混进趋势图而不加区分就是在撒谎。
//   2. **解析未完成必须显示成"未完成"，不能显示成 0** —— 否则用户以为用量丢了。
//   3. **无价格模型必须列出** —— 它们按 $0 计，不列出来总额就悄悄少了一块。
//
// 无 TTY 时自动降级为纯文本（无颜色、无宽度探测），方便重定向到文件或管道。

import { fmtUSD } from '../pricing/cost.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

const BAR_FULL = '█';
const BAR_SPREAD = '▓'; // 摊平值用不同字符，一眼可辨
const BAR_EMPTY = '░';

function fmtTokens(n) {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

/** 截断到显示宽度，超出用 … 收尾。用于 project 名这种可能很长的字段。 */
function ellipsize(s, width) {
  const str = String(s);
  if (str.length <= width) return str;
  if (width <= 1) return str.slice(0, width);
  return str.slice(0, width - 1) + '…';
}

function bar(fraction, width, spread = false) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return (spread ? BAR_SPREAD : BAR_FULL).repeat(filled) + BAR_EMPTY.repeat(width - filled);
}

/**
 * @param {ReturnType<import('./aggregate.js').buildReport>} r
 * @param {{days:number, width?:number, showProjects?:boolean}} opts
 */
export function render(r, { days, width = process.stdout.columns || 80, showProjects = true } = {}) {
  const w = Math.max(60, Math.min(width, 120));
  const out = [];
  const line = (s = '') => out.push(s);

  // 日期范围取自报告实际的 days，而不是重新按"今天"推算——否则一旦调用方
  // 传入了不同的 now（测试、或指定历史窗口），表头会和下面的趋势图对不上。
  const fmtDay = (k) => {
    const [, m, d] = k.split('-');
    return `${Number(m)}/${Number(d)}`;
  };
  const firstDay = r.days[0] ?? '';
  const lastDay = r.days[r.days.length - 1] ?? '';

  line();
  line(bold(`  Vibe Local`) + dim(`  ·  ${fmtDay(firstDay)} – ${fmtDay(lastDay)}  (${r.days.length} 天)`));
  line();

  // ── 总计 ────────────────────────────────────────────────────────────────
  // cache read 单独一行：它在总量里常常占大头（重度用户的 cache read 可达
  // input 的 20 倍），混在一起会让 token 数字看起来对不上成本。
  line(`  ${dim('总花费')}   ${bold(fmtUSD(r.totalCost))}`);
  line(`  ${dim('tokens')}   ${fmtTokens(r.totalTokens)}  ${dim('（不含 cache read）')}`);
  if (r.totalCacheRead > 0) {
    line(`  ${dim('cache read')} ${fmtTokens(r.totalCacheRead)}  ${dim('（另计，未包含在上行）')}`);
  }
  line();

  // ── 每日趋势 ────────────────────────────────────────────────────────────
  const dayVals = r.days.map((d) => r.byDay.get(d) ?? { cost: 0, tokens: 0, measuredCost: 0, spreadCost: 0 });
  const maxCost = Math.max(...dayVals.map((v) => v.cost), 1e-9);
  const hasSpread = dayVals.some((v) => v.spreadCost > 0);

  if (maxCost > 1e-9) {
    line(`  ${dim('每日趋势')}`);
    for (let i = 0; i < r.days.length; i++) {
      const k = r.days[i];
      const v = dayVals[i];
      const label = k.slice(5); // MM-DD
      const measured = v.measuredCost ?? 0;
      const spread = v.spreadCost ?? 0;
      // 三种状态，分别对应三种数据可信度：
      //   纯实测   → █ 实心，无标记
      //   实测+摊平 → █ 实心（柱子长度仍如实反映总额），行尾挂 ▓ 标记
      //   纯摊平   → ▓ 整条（这天没有任何实测数据）
      // 早期版本把所有"含摊平的天"整条染成 ▓，结果把实测数据也标成了估算——
      // 那是反方向的误导，同样要避免。
      let b;
      if (measured === 0 && spread > 0) b = bar(v.cost / maxCost, 22, true);
      else b = bar(v.cost / maxCost, 22, false);
      const marker = spread > 0 && measured > 0 ? ` ${cyan('▓')}` : '';
      line(`  ${dim(label)}  ${b}  ${fmtUSD(v.cost).padStart(9)}${marker}`);
    }
    if (hasSpread) {
      line(dim(`  ${BAR_SPREAD} 标记 = 该日含按时间段摊平的手工录入（估算值）；整条 ${BAR_SPREAD} = 该日全部为估算`));
    }
    line();
  }

  // ── 按模型 ──────────────────────────────────────────────────────────────
  const models = [...r.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  if (models.length > 0) {
    line(`  ${dim('按模型')}`);
    const nameW = Math.min(40, Math.max(...models.map(([m]) => m.length)) + 1);
    const costW = Math.max(...models.map(([, v]) => fmtUSD(v.cost).length));
    // 柱状条按**最大值**归一化（占比最大的模型满格），百分比另列。
    // 按总额归一化会让"占比 40%"只画出 4 格，分辨不出模型之间的相对大小。
    const maxModelCost = Math.max(...models.map(([, v]) => v.cost), 1e-9);
    // 成本为 0 的模型（免费档、非模型占位）单独收成一行。它们是用量，但逐行
    // 铺开 $0.00 会把有成本的模型淹掉。token 数仍然报出来，信息不丢。
    const paid = models.filter(([, v]) => v.cost > 0);
    const zero = models.filter(([, v]) => v.cost <= 0);
    for (const [model, v] of paid) {
      const pct = r.totalCost > 0 ? (v.cost / r.totalCost) : 0;
      const b = bar(v.cost / maxModelCost, 14);
      line(
        `  ${ellipsize(model, nameW).padEnd(nameW)} ` +
        `${fmtUSD(v.cost).padStart(costW)}  ` +
        `${dim((pct * 100).toFixed(1).padStart(5) + '%')}  ${b}`,
      );
    }
    if (zero.length > 0) {
      const zt = zero.reduce((a, [, v]) => a + v.tokens + v.cacheRead, 0);
      const names = zero.map(([m]) => m).join(', ');
      line(`  ${dim(`免计费 ${zero.length} 个模型（$0，共 ${fmtTokens(zt)} tokens）：${ellipsize(names, w - 30)}`)}`);
    }
    line();
  }

  // ── 按项目 ──────────────────────────────────────────────────────────────
  if (showProjects) {
    const projects = [...r.byProject.entries()].sort((a, b) => b[1].cost - a[1].cost);
    if (projects.length > 1) {
      line(`  ${dim('按项目')}`);
      const nameW = Math.min(40, Math.max(...projects.map(([p]) => p.length)) + 1);
      const shown = projects.slice(0, 10);
      for (const [proj, v] of shown) {
        line(`  ${ellipsize(proj, nameW).padEnd(nameW)} ${fmtUSD(v.cost).padStart(9)}  ${dim(fmtTokens(v.tokens))}`);
      }
      if (projects.length > shown.length) {
        line(`  ${dim(`…另有 ${projects.length - shown.length} 个项目`)}`);
      }
      line();
    }
  }

  // ── 护栏区 ──────────────────────────────────────────────────────────────
  // 下面三块不是装饰。缺了它们，报告会用"看起来正常"的数字掩盖三种不同的问题。

  if (r.unpriced.length > 0) {
    const totalMissed = r.unpriced.reduce((a, u) => a + u.tokens + u.cacheRead, 0);
    line(yellow(`  ⚠ ${r.unpriced.length} 个模型无价格，按 $0 计（合计 ${fmtTokens(totalMissed)} tokens，未计入总额）`));
    for (const u of r.unpriced) {
      line(yellow(`      ${ellipsize(u.model, 36).padEnd(36)} ${fmtTokens(u.tokens + u.cacheRead).padStart(8)}`));
    }
    line(dim(`    补齐价格：vibe-local prices edit`));
    line();
  }

  if (r.partial.length > 0) {
    line(yellow(`  ⚠ ${r.partial.length} 个来源本轮结果不完整（下方数字可能偏低，非 0 用量）`));
    for (const p of r.partial) {
      line(yellow(`      ${p.source.padEnd(14)} ${p.reason}`));
    }
    line();
  }

  if (r.manualCount > 0 && hasSpread) {
    line(cyan(`  ${BAR_SPREAD} 含 ${r.manualCount} 条手工录入，按时间段摊平（估算值，非逐日实测）`));
    line();
  }
  if (r.manualCount > 0) {
    line(dim(`  手工录入不含会话统计：下方"会话数/活跃时长"之类数字只反映本地日志。`));
    line();
  }

  if (r.totalCost === 0 && r.totalTokens === 0) {
    line(dim('  该窗口内没有数据。'));
    line();
  }

  return out.join('\n') + '\n';
}

/** 会话维度的补充统计。手工录入没有 session，所以这里只反映本地日志。 */
export function renderSessions(sessions, { days = 7, now = new Date() } = {}) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));

  const inWin = sessions.filter((s) => {
    const t = new Date(s.firstMessageAt ?? s.lastMessageAt ?? 0);
    return !Number.isNaN(t.getTime()) && t >= start;
  });
  if (inWin.length === 0) return '';

  let activeSeconds = 0;
  let messages = 0;
  for (const s of inWin) {
    activeSeconds += Number(s.activeSeconds ?? 0);
    messages += Number(s.messageCount ?? 0);
  }
  const hours = activeSeconds / 3600;
  return dim(
    `  会话 ${inWin.length} 个 · 活跃 ${hours.toFixed(1)} 小时 · 消息 ${fmtTokens(messages)} 条` +
    `  （仅本地日志，不含手工录入）`,
  ) + '\n';
}
