# 每日自动发布

把本机的 AI 用量解析成聚合 JSON，提交到 [usage-agent](https://github.com/Functionhx/usage-agent) 仓库，
由 GitHub Pages 呈现。全流程自动，无需人工干预。

## 文件

| 文件 | 作用 |
|---|---|
| `usage-publish.sh` | 主脚本：pull → 解析 → 校验 → 提交推送 |
| `usage-publish.service` | systemd 服务单元（oneshot），**服务器用** |
| `usage-publish.timer` | systemd 定时器（`Persistent=true`），**服务器用** |

## 只在服务器上定时，Mac 手动跑

**服务器**：systemd timer 每日自动（见下文）。
**Mac**：**不设定时任务**，需要时手动跑：

```bash
VIBE_LOCAL_DIR=~/Downloads/vibe-local \
USAGE_REPO_DIR=~/Downloads/usage-agent \
  ~/Downloads/vibe-local/deploy/usage-publish.sh
```

Mac 不常关机、用量也不是每天都需要反映到站点上，手动跑反而更省事。

脚本本身不含任何硬编码路径——`VIBE_LOCAL_DIR` / `USAGE_REPO_DIR` / `USAGE_HOST`
都有带默认值的环境变量入口，两台机器共用同一份脚本。

## 服务器安装

```bash
# 1. 工具与数据仓库
rsync -a --exclude=.git --exclude=data ./ <你的服务器>:/home/YOU/vibe-local/
ssh <你的服务器> 'gh repo clone Functionhx/usage-agent'

# 2. systemd 单元
ssh <你的服务器>
mkdir -p ~/.config/systemd/user
cp ~/vibe-local/deploy/usage-publish.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now usage-publish.timer

# 3. 关键一步：允许用户服务在无登录会话时运行
sudo loginctl enable-linger as
```

**第 3 步不能省。** 服务器 `Linger=no` 时，用户级 systemd 服务只在你登录期间运行——
登出后定时器就停了。这台上已有的三个 `functionhx-*` 定时器受同样影响。

## 排期为什么写成本地 13:00

目标是 **UTC+8 04:00**，但服务器系统时区是 `America/Los_Angeles`，而 systemd v249
的 `OnCalendar` 不支持指定时区。所以：

| | 本地时刻 | 对应 UTC+8 |
|---|---|---|
| 夏令时 PDT (UTC-7) | 13:00 | 04:00 |
| 冬令时 PST (UTC-8) | 13:00 | 05:00 |

这 ±1 小时的漂移**无害**，因为：

1. 目标 UTC+8 日在本地 09:00 / 08:00 就已结束，任务在本地 13:00 跑，余量 4–5 小时
2. **"该报哪一天"由脚本按当前 UTC 时刻自己推算**，不看 timer 触发在几点

第 2 条是核心。它同时解决了补跑：即使 `Persistent=true` 在几天后才补上，
算出的目标日依然正确。

## 为什么用 systemd timer 而不是 cron

**服务器经常关机**。cron 不会补跑错过的任务，`Persistent=true` 会。

## 数据不会泄露不该有的东西

`usage-publish.sh` 在 `git push` **之前**跑 `scripts/validate_usage.py`，失败即中止。
那个校验器里有 `walk_public_values()`：递归遍历所有公开值，拒绝 `null`、敏感键名
（`project` / `cwd` / `session` / `prompt`…）和字符串里的绝对路径。

数据是自动发布的，没人会逐次人工审阅——把约束做成断言，它才会真的被执行。

## 环境坑（部署时踩过的）

### 网络：靠 TUN 模式，不需要 git 代理

服务器上跑着 Clash，**TUN 模式**（网卡 `utun1024`，网段 `198.18.0.0/30`）透明接管
全部流量，所以 git 直连 github 即可，**不要配任何 `http.proxy`**。

> 这里踩过一个坑：全局 git 配置里曾残留 `http.proxy = http://[::1]:7897`，
> 而那个端口根本没在监听，导致服务器上所有 git 操作报
> `Failed to connect to ::1 port 7897`。TUN 起来之后这些配置就是纯累赘，已清除。
>
> 判断当前是哪种模式：`ip -brief addr | grep utun`。有 utun 网卡 = TUN 模式，
> 不需要代理；没有 = 才需要指向 Clash 的 HTTP 端口（通常是 `127.0.0.1:7890`）。

### 首次运行慢

第一次要为数 GB 的 `~/.codex` 建索引缓存，实测约 1 分钟。之后靠签名缓存，
日常增量只需数秒。

## 手动运行与排查

```bash
# 手动跑一次
nice -n 10 ionice -c3 ~/vibe-local/deploy/usage-publish.sh

# 看定时器排期
systemctl --user list-timers usage-publish.timer

# 看日志
journalctl --user -u usage-publish.service -n 50

# 看上次运行的退出状态
systemctl --user status usage-publish.service
```

退出码 `75` 表示"上一次还在跑，本次跳过"——这是 `flock` 的正常行为，
已被 `SuccessExitStatus=75` 视为成功。

## 并发保护

单元里用 `flock -n -E 75`。上一次运行未结束时，本次直接跳过而不是排队——
排队会让补跑叠在一起，反而更慢。
