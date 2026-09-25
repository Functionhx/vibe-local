// 远程镜像：把服务器上的日志增量同步到本地，再用同一套 parser 解析。
//
// 为什么是 rsync 镜像而不是"在服务器上跑一遍"：
//   - 服务器不需要装 Node
//   - 只有一份解析代码（就是本机这份），不会出现两边算法漂移
//   - 首次同步后只传新增字节，服务器离线也能看历史
//
// ## 根目录通过**参数**传，不改环境变量
//
// parser 是并发跑的（`collect.js` 里 concurrency=4）。如果靠改
// `VIBE_USAGE_CLAUDE_DIRS` 这类环境变量来指向镜像，并发时几个 parser 会互相
// 覆盖对方的环境变量，结果串台。所以统一用 parser 的参数入口：
//   claude-code → extraRoots（追加）    codex → codexExtraHome（追加）
//   opencode    → extraRoots（追加）
//
// 3 个受支持的 parser 都有替换语义的入口，所以不存在"无法镜像"的例外。
//
// ## rsync 参数取舍
//
//   `-a` 必须 —— parser 的"同 session 跨根取最完整副本"（`claude-code.js:104-109`）
//         和 codex 缓存签名都依赖 mtime，丢了 mtime 会让这两者失准。
//   `--delete` 要 —— 否则服务器上删掉的日志会永远留在镜像里，数字只增不减。
//   不用 `--checksum` —— 它要读服务器上的**全部数据**来算校验和，正是共享服务器
//         上最该避免的高 IO。默认的 size+mtime 判定已经够用。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { STATE_DIR } from './manual.js';

const SSH_OPTS = ['-o', 'ConnectTimeout=6', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

/** 每个工具对应服务器上的路径，以及镜像到本地的相对位置。 */
export const MIRROR_SOURCES = [
  // claude：整个目录都要（projects/ 与 transcripts/ 是 parser 的两处数据源）
  { id: 'claude-code', remote: '.claude', local: 'claude', paths: [''] },

  // codex：**只要 sessions/ 与 archived_sessions/**。
  // 服务器上 ~/.codex 是 17G，其中 packages/ 占 7.1G（沙箱用的 npm 包），
  // parser 完全不读。只取这两个目录能把传输量砍掉一半以上。
  { id: 'codex', remote: '.codex', local: 'codex', paths: ['sessions', 'archived_sessions'] },

  // opencode：SQLite 库（parser 只读 message 表）
  { id: 'opencode', remote: '.local/share/opencode', local: 'opencode', paths: [''] },
];

export function mirrorBase(host = 'dwan') {
  return join(STATE_DIR, 'mirror', host);
}

/** 服务器是否可达。不可达是我们必须能优雅处理的状态——它是常态，不是错误。 */
export function isReachable(host) {
  const r = spawnSync('ssh', [...SSH_OPTS, host, 'true'], { stdio: 'pipe', timeout: 15000 });
  return r.status === 0;
}

function ssh(host, cmd) {
  return spawnSync('ssh', [...SSH_OPTS, host, cmd], { stdio: 'pipe', timeout: 30000, encoding: 'utf8' });
}

/**
 * 远端 home 的绝对路径。
 *
 * 不要用 `~` 拼路径再包进引号——`[ -e "~/.claude" ]` 里的 `~` 在双引号内由
 * 远端 shell 原样传给 `[`，测的是一个**字面量目录名**，永远为假。这个 bug 的
 * 表现是"服务器上明明有数据，却报告说不存在"，很能骗人。统一用绝对路径。
 */
export function remoteHome(host) {
  const r = ssh(host, 'printf %s "$HOME"');
  const home = String(r.stdout ?? '').trim();
  return r.status === 0 && home.startsWith('/') ? home : null;
}

/**
 * 探测服务器上的数据规模。**先报规模，再决定拉不拉** —— 共享服务器上的 IO
 * 纪律，也是为了让用户对"要传多久"有预期。
 */
export function probe(host, home = remoteHome(host)) {
  if (!home) return [];
  const out = [];
  for (const src of MIRROR_SOURCES) {
    for (const p of src.paths) {
      const remotePath = join(home, src.remote, p);
      // du 只走元数据，不读文件内容；find 计数同理。在共享服务器上这是可接受的。
      const r = ssh(host, `[ -e "${remotePath}" ] && { du -sk "${remotePath}" 2>/dev/null | cut -f1; find "${remotePath}" -type f 2>/dev/null | wc -l; } || echo "0 0"`);
      if (r.status !== 0) continue;
      const [kb, files] = String(r.stdout).trim().split(/\s+/).map(Number);
      if (!kb) continue;
      out.push({ source: src.id, path: remotePath, kb, files, local: join(mirrorBase(host), src.local, p) });
    }
  }
  return out;
}

export function fmtBytes(kb) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${kb} KB`;
}

/**
 * 增量同步。首次会传全量，之后只传新增字节。
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {(line:string)=>void} [opts.onProgress]
 * @param {string[]} [opts.only]  只同步这些 source id
 * @returns {{ok:boolean, reason?:string, synced:Array<{source:string,local:string}>}}
 */
export function sync({ host = 'dwan', onProgress = () => {}, only } = {}) {
  if (!isReachable(host)) {
    return { ok: false, reason: `无法连接 ${host}`, synced: [] };
  }
  const home = remoteHome(host);
  if (!home) {
    return { ok: false, reason: `无法确定 ${host} 的 home 目录`, synced: [] };
  }

  const synced = [];
  for (const src of MIRROR_SOURCES) {
    if (only && !only.includes(src.id)) continue;
    for (const p of src.paths) {
      const remotePath = join(home, src.remote, p);
      const localPath = join(mirrorBase(host), src.local, p);

      // 先确认远端存在，避免对着不存在的路径跑 --delete（那会清空本地镜像）
      const probeRes = ssh(host, `[ -e "${remotePath}" ] && echo yes || echo no`);
      if (String(probeRes.stdout).trim() !== 'yes') {
        onProgress(`  · ${src.id}${p ? '/' + p : ''}：服务器上不存在，跳过`);
        continue;
      }

      mkdirSync(localPath, { recursive: true });
      const args = [
        '-a', '--partial', '--delete', '--no-motd',
        '-e', `ssh ${SSH_OPTS.join(' ')}`,
        `${host}:${remotePath}/`, `${localPath}/`,
      ];
      const r = spawnSync('rsync', args, { stdio: 'pipe', encoding: 'utf8', timeout: 3600000 });
      if (r.status !== 0) {
        onProgress(`  ✗ ${src.id}${p ? '/' + p : ''}：rsync 退出码 ${r.status}`);
        if (r.stderr) onProgress(`    ${String(r.stderr).trim().split('\n').slice(-3).join('\n    ')}`);
        continue;
      }
      synced.push({ source: src.id, local: localPath });
      onProgress(`  ✓ ${src.id}${p ? '/' + p : ''} → ${localPath}`);
    }
  }
  return { ok: true, synced };
}

/**
 * 把镜像目录转成 parser 的**替换语义**环境变量。
 *
 * 为什么是环境变量而不是 `extraRoots` 参数：后者是**追加**，会把默认根一起
 * 扫进来。实测确认过后果——本机 255 buckets + 镜像 369 buckets 得到 624，即
 * 两份数据被混合并统一贴上了远程 hostname，而报表上完全看不出异常。
 * 环境变量是替换语义，能干净分离。
 *
 * 调用方必须让这一遍**串行**跑（`collect({env})` 会自动这么做）。
 *
 * 覆盖了全部 3 个受支持的parser：claude-code / codex / opencode 都有替换语义的
 * 入口。所以不存在"某个工具无法重定向"的情况。
 */
export function mirrorRoots(host = 'dwan') {
  const base = mirrorBase(host);
  const d = delimiter; // POSIX `:`；两个 parser 都按 path.delimiter 拆分
  return {
    env: {
      'claude-code': { VIBE_USAGE_CLAUDE_DIRS: join(base, 'claude') },
      codex: { CODEX_HOME: join(base, 'codex') },
      opencode: { VIBE_USAGE_OPENCODE_DIRS: join(base, 'opencode') + d },
    },
  };
}

/** 镜像是否已有内容（用于判断是否需要提示"首次同步"）。 */
export function hasMirror(host = 'dwan') {
  return existsSync(mirrorBase(host));
}

/**
 * 检查每个来源的镜像目录是否**真的有内容**。
 *
 * 为什么需要这个：上游 parser 对"根目录不存在"是**静默返回 0**的——实测过，
 * `CODEX_HOME` 指向不存在的路径时，结果是 `{buckets: 0, skipped: false,
 * warnings: []}`，没有任何信号。
 *
 * 对上游而言那是合理语义（用户没装那个工具 = 空）。但对我们不是：我们**明知**
 * 自己配置了一个镜像根，它不存在只能说明"镜像没同步好"。若照直报，用户会看到
 * "codex 零用量"，而事实是数据根本没拉下来。所以这层检查不能省。
 *
 * @returns {{present:string[], missing:string[]}}
 */
export function mirrorStatus(host = 'dwan') {
  const present = [];
  const missing = [];
  for (const src of MIRROR_SOURCES) {
    for (const p of src.paths) {
      const dir = join(mirrorBase(host), src.local, p);
      // 只看目录**存在且非空**：rsync 会先建出空目录，光判 existsSync 会把
      // "刚建好还没传数据"误判为已同步。
      let ok = false;
      try {
        ok = existsSync(dir) && statSync(dir).isDirectory();
        if (ok && src.id !== 'opencode') {
          ok = readdirSync(dir).length > 0;
        }
      } catch {
        ok = false;
      }
      const label = `${src.id}${p ? '/' + p : ''}`;
      if (ok) present.push(label);
      else missing.push(label);
    }
  }
  return { present, missing };
}
