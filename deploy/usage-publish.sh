#!/bin/bash
# 每日用量发布：解析本机日志 → 产出聚合数据 → 校验 → 提交推送。
#
# 由 systemd timer 调用（见 usage-publish.timer）。也可以手动跑。
#
# 设计要点：
#
#  1. **校验不通过就绝不推送**。`scripts/validate_usage.py` 里含隐私守卫
#     （递归检查 null、敏感键名、绝对路径），它是"数据不会泄露不该有的东西"
#     这道保证的**执行点**。放在 push 之前，失败即中止。
#
#  2. **有变化才提交**。先 `git add` 再查暂存区——不能用 `git diff`，它看不见
#     新建文件（踩过这个坑，见 usage-agent 的提交历史）。
#
#  3. **先 pull --rebase**。CI 会往同一个仓库提交 hosts.json 清单，不先拉会被拒。
#     每台机器只写自己那个 data/<host>.json，所以 rebase 不会冲突。
#
#  4. **失败要留下痕迹**。`set -e` 让任何一步失败都中止且非零退出，
#     journalctl --user -u usage-publish 能查到。

set -euo pipefail

# 路径解析：环境变量优先，否则在常见位置里找。
# 不用 bash 的间接展开（${!var}）——macOS 自带的是 bash 3.2，不支持。
# 写成这样是为了让两台机器共用同一份脚本，两边都不必先 export 什么。
locate_dir() {
  for candidate in "$@"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

VIBE_LOCAL="$(locate_dir "${VIBE_LOCAL_DIR:-}" "$HOME/vibe-local" "$HOME/Downloads/vibe-local")" || {
  echo "错误：找不到 vibe-local 目录。请设置 VIBE_LOCAL_DIR。" >&2
  exit 1
}
REPO="$(locate_dir "${USAGE_REPO_DIR:-}" "$HOME/usage-agent" "$HOME/Downloads/usage-agent")" || {
  echo "错误：找不到 usage-agent 仓库。请设置 USAGE_REPO_DIR。" >&2
  exit 1
}
HOST="${USAGE_HOST:-$(hostname -s)}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "开始：host=$HOST"
cd "$REPO"

# ── 1. 同步远端 ──────────────────────────────────────────────────────────────
if ! git pull --rebase --quiet; then
  log "错误：git pull --rebase 失败。检查网络与代理（本仓库的 http.proxy 配置）。"
  exit 1
fi

# ── 2. 产出数据 ──────────────────────────────────────────────────────────────
# publish 是整份重写：重新聚合本机全部日志得到所有 UTC+8 日。
# 所以机器关机几天后补跑，那几天的数据会自动出现在结果里，不需要单独补漏。
if ! node "$VIBE_LOCAL/bin/vibe-local.js" publish --repo "$REPO" --host "$HOST"; then
  log "错误：publish 失败。"
  exit 1
fi

# ── 3. 校验（含隐私守卫）—— 不过就不推 ───────────────────────────────────────
if ! python3 "$REPO/scripts/validate_usage.py" >/dev/null; then
  log "错误：数据校验未通过，拒绝推送。详情："
  python3 "$REPO/scripts/validate_usage.py" || true
  exit 1
fi
log "校验通过。"

# ── 4. 有变化才提交 ──────────────────────────────────────────────────────────
# 先 add 再查暂存区：`git diff` 只看已跟踪文件，看不见新建的 data/<host>.json。
git add data/
if git diff --cached --quiet; then
  log "数据无变化，跳过提交。"
  exit 0
fi

git commit --quiet -m "data: $HOST $(date -u +%Y-%m-%dT%H:%MZ)"
if ! git push --quiet; then
  log "错误：git push 失败。数据已提交到本地，下次运行会重试推送。"
  exit 1
fi

log "已推送。"
