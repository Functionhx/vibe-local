# vibe-local

本地的 AI 编程工具用量与花费统计。**不上传、不装后台服务、不读其它工具的凭证。**

支持 Claude Code、Codex、OpenCode，可另加一台远程服务器（日志增量镜像到本地后用同一套解析器处理），并支持手工补录网页版/API 直调等本地日志抓不到的用量。

```
$ vibe-local --days 7

  Vibe Local  ·  9/18 – 9/24  (7 天)

  总花费   $1,726
  tokens   79.2M  （不含 cache read）
  cache read 4.16B  （另计，未包含在上行）

  每日趋势
  09-18  ██████████████████████    $645.85
  09-19  ██████████░░░░░░░░░░░░    $285.40 ▓
  09-20  ███████░░░░░░░░░░░░░░░     $90.91
  ...

  按模型
  claude-opus-5        $750.28  42.3%  ██████████████
  gpt-6-astra-priority $708.36  39.9%  █████████████░
  gpt-6-astra          $215.39  12.1%  ████░░░░░░░░░░
  ...

  ⚠ 1 个模型无价格，按 $0 计（合计 9.0M tokens，未计入总额）
      gpt-5.3-codex-spark
```

## 为什么有这个项目

[`@vibe-cafe/vibe-usage`](https://github.com/vibe-cafe/vibe-usage) 功能很好，但审计其源码后有几处让人不放心：

1. **daemon 自更新** —— `daemon-service.js` 装的 launchd 服务执行 `npx --yes @vibe-cafe/vibe-usage@latest daemon`，**每次登录自动拉最新版执行**。同意一次即永久授权，而该包几天内能发上百个版本，供应链被投毒时没有拦截机会。
2. **读其它工具的 OAuth 凭证** —— `quotas/providers/` 会读本地凭证文件并用 refresh_token 刷新，请求发往 auth.kimi.com、api.z.ai 等第三方。
3. **`project` 字段默认上传** —— 从 cwd 派生的项目名。

但同时，它的 **parser 层是真正有价值的资产**：近万行代码、覆盖 60+ 工具，处理各工具日志格式的历史变迁、session fork/copy 去重、subagent 归属、30 分钟桶边界——这些是长期踩坑积累的，重写不现实。

所以这个项目的做法是：**提取 parser 层，砍掉全部网络/daemon/凭证逻辑，自己实现定价与展示。**

## 安装

需要 **Node ≥ 22.5**（依赖内置的 `node:sqlite`）。零第三方依赖。

```bash
git clone <this-repo> && cd vibe-local
node bin/vibe-local.js            # 直接跑
npm link                          # 或者装成全局命令 vibe-local
```

## 隐私保证

代码里**没有任何上传路径**。具体地说：

- 只有 `src/mirror.js` 会发起网络请求，且**只在你显式跑 `vibe-local mirror` 或报告时**才连你自己的服务器，走 `rsync` 拉取日志到本地
- 不装 daemon、不写 launchd/systemd 服务、无定时任务——**所有操作都是你手动触发的**
- 不读任何工具的 OAuth 凭证
- 解析出的数据只落在 `~/.vibe-local/`
- `prices.json` 是静态文件，运行时**不联网取价**

这一点可以自己验证：

```bash
grep -rn "fetch(\|https\.request\|http\.request\|net\.connect\|WebSocket" src/
```

自研代码（`src/*.js`、`src/pricing/`、`src/report/`）里**零命中**；上游 parser 目录里唯一的命中是 `UPSTREAM.md` 中说明"为什么排除 Cursor"的那段文档，不是代码。

## 支持的来源

| 工具 | 数据源 | 增量机制 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 无（每次重扫，但很快：611MB 约 1.8s） |
| Codex | `~/.codex/sessions/**/*.jsonl` | **签名缓存**（size/mtime/dev/ino），热启动近乎免费 |
| OpenCode | `~/.local/share/opencode/opencode.db`（SQLite） | 无（每次全表扫 message 表） |

上游支持 60+ 工具，本项目只取这 3 个。两个被**明确排除**的：

- **Cursor** —— 用量只能通过 `cursor.com` 的云 API 获取（本地没有 token 日志），与"纯本地"前提冲突。它是上游唯一无法离线工作的 parser。
- **Gemini CLI** —— 实测在每台被统计的机器上都是零 session，且其数据路径硬编码（`~/.gemini/tmp`）**既无环境变量也无参数入口**，无法用于远程镜像。留着它就意味着"镜像方案里有个工具永远只能是本机的"。

## 定价

价格表是**手工策展**的 `src/pricing/prices.json`，每个条目带 `as_of` 日期和**官方来源 URL**。不使用 LiteLLM 等社区聚合表——二手源的数字会互相矛盾，实测中就遇到过第三方把某模型价格报错。

### 更新价格

```bash
vibe-local prices          # 列出全部条目及来源
vibe-local prices update   # 报告过期条目 + 该去核对的官方 URL（不自动改数字）
vibe-local prices edit     # 直接编辑
```

`prices update` **不抓取、不改数字**，只告诉你哪些条目该重新核对、去哪个官方页核对。因为 Anthropic / OpenAI / DeepSeek 都**没有机器可读的官方定价 API**，数字只能从网页搬——与其写一个会悄悄抓错或抓空的爬虫，不如让人核对一次。

### 无价格的模型按 $0 计

查不到价的模型，token 照常累计，但成本贡献 0。**并且报告底部会列出它们：**

```
⚠ 2 个模型无价格，按 $0 计（合计 3.4M tokens，未计入总额）
    claude-opus-5-5-fast    2.1M tokens
    gpt-5.3-codex-spark     1.3M tokens
  补齐价格：vibe-local prices edit
```

这条提示是这个设计的必需品，不是可选装饰。没有它，一个漏配的模型就会**静默吞掉一块花费，而总额看起来依然正常**。

模型名自带 `-free` 或表里标了 `free: true` 的（免费档、路由标签占位）不算"无价格"，不会进这个列表——否则提醒会被噪音淹没。

### 计费口径

- **只用模型名查表**，来源（source）不参与定价
- 六个 token 列**互不重叠**：非缓存 input / 不含推理的 output / cache read / cache write 5m / cache write 1h / 推理 token
- 推理 token 按 **output** 单价计
- 缺某个单价时回落到 input 价（如 OpenAI 部分模型不单列 cache write，官方页以 `–` 表示并入 input）
- **DeepSeek 分时段计价**已实现：官方按 UTC（工作日 01:00–04:00 与 06:00–10:00 为 peak，其余半价），桶里带 UTC 时间戳所以能精确判定

## 手工录入

用于补录本地日志抓不到的用量：开始用这个工具之前的历史、网页版、API 直调、工具读不到的软件。

```bash
# 按时间段录入（起止日期 + 总数）
vibe-local add --start 2026-08-01 --end 2026-08-31 \
               --label claude-web --model claude-opus-5 \
               --input 1200000 --output 85000 --cache-read 4000000

# 只知道花了多少钱
vibe-local add --start 2026-07-01 --end 2026-07-31 \
               --label api --model some-internal-model --cost 42.50

# 只知道单价
vibe-local add --price-in 3 --price-out 15 ...

vibe-local manual              # 列出
vibe-local manual --remove <id>
```

**成本优先级**：`--cost` > `--price-in/--price-out` > 查表 > `$0`

存在 `~/.vibe-local/manual.jsonl`（一行一条，可手工编辑）。每条有稳定 id，**重复执行同一条命令不会重复计数**。

### 摊平是估算，图上会标出来

按时间段录入的是一次总数，趋势图按天显示，所以要摊平。摊平**窗口感知**——一条"8月1日–8月31日"的记录，看"最近 7 天"时只计入重叠的那几天，不会整个漏进来也不会整个消失。

趋势图用字符区分数据来源：

- `█` 纯实测
- `█` 行尾带 `▓` 标记 —— 该日含摊平值
- `▓` 整条 —— 该日**全部**为估算

手工录入**只产生用量，不产生会话**，所以"会话数/活跃时长"这类统计不包含它们，报告里会注明。

## 远程服务器

把服务器上的日志增量镜像到本地，再用**同一套解析器**处理。好处：服务器不需要装 Node、只有一份解析代码、首次同步后只传新增字节、服务器离线也能看历史。

```bash
vibe-local mirror                 # 探测规模并同步（传输前先报要传多少）
vibe-local mirror --status        # 只看状态
vibe-local mirror --only codex    # 只同步某个来源
vibe-local mirror --host <ssh别名>
```

主机通过 `VIBE_LOCAL_REMOTE=<ssh别名>` 或 `--host` 指定，**没有默认值**——那属于各人的私有基础设施。**服务器不可达是常态**（没开机、隧道没起），此时只提示、不报错，报告正常出本地结果。

报告默认会尝试远程；`--no-remote` 跳过。

### 两个实现细节

**镜像同步只拉 parser 真正需要的目录。** 服务器的 `~/.codex` 可能有十几 GB，但其中 `packages/`（沙箱用的 npm 包）parser 完全不读——跳过它能把传输量砍掉一半以上。

**本机与服务器数据严格分开。** bucket 的分组键含 hostname，两台机器上同名的项目若不加区分就会被合并。实现上先跑本地一遍（hostname = 本机名），再跑远程一遍（hostname = 主机名），两者用**替换语义**的根目录配置隔离。

这里踩过一个坑值得记下：上游 parser 的 `extraRoots` 参数是**追加**语义，会把默认根一起扫进来。用它做隔离会把本机数据混入远程结果并统一贴上远程 hostname——实测中 255 + 369 正好得到 624，确认无误。而**报表上完全看不出异常**。所以改用替换语义的环境变量，并让那一遍串行执行。

另外，上游 parser 对"根目录不存在"是**静默返回 0** 的（对上游而言合理：用户没装那个工具）。但对我们不是——我们明知配置了镜像根，它不存在只能说明没同步好。所以 `mirrorStatus()` 会检查镜像是否真的有内容，缺了就明确标注，而不是让你以为"服务器上那个工具没用量"。

## 命令一览

```
vibe-local [--days N] [--no-projects]      采集并出报告（默认 7 天）
vibe-local --no-remote                     跳过远程
vibe-local sync                            只采集，不出报告（预热 codex 缓存）
vibe-local doctor                          环境自检

vibe-local mirror [--status|--only|--host] 远程镜像

vibe-local prices                          列出价格表及来源
vibe-local prices update                   报告过期条目与官方 URL
vibe-local prices edit                     打开 prices.json

vibe-local add ...                         手工录入
vibe-local manual [--remove <id>|--edit]   管理手工录入
```

环境变量：`VIBE_LOCAL_DIR`（状态目录，默认 `~/.vibe-local`）、`VIBE_LOCAL_CACHE_DIR`（codex 索引缓存）、`VIBE_LOCAL_REMOTE`、`NO_COLOR`。

## 项目结构

```
src/
├── upstream/          提取自 @vibe-cafe/vibe-usage 的 parser 层
│   ├── UPSTREAM.md    来源、指纹、提取清单、每一处修改及原因
│   └── parsers/       aggregate / claude-code / codex* / gemini-cli / opencode / sqlite ...
├── collect.js         并发跑 parser + 错误隔离 + hostname 打标
├── manual.js          手工录入的读写与去重
├── mirror.js          rsync 增量镜像
├── pricing/           prices.json + 查表计费
├── report/            按天/模型/项目聚合 + 终端渲染
└── cli.js
```

`src/upstream/` 与自研代码刻意分开：parser 保持与上游接近字节级一致（只有 3 处必要修改，全部记录在 `UPSTREAM.md`），便于日后把上游的 parser 修复合进来。

## 已知限制

- **长上下文档位未区分**：OpenAI 对超过 272K input 的请求按长上下文价（约 2x）计费，但 30 分钟聚合桶无法还原单次请求是否超限，故统一按短上下文价计，**可能低估**
- **节假日**：DeepSeek 官方规定中国法定节假日算 off-peak，本工具没有节假日表，只按周末处理，节假日当天按 peak 计（方向上偏保守，不会少报）
- **OpenCode 无增量**：每次全表扫描 `message` 表（该表体积远小于整个 db，实测 633MB 而非 7GB）
- **Cursor / Gemini CLI 不支持**：原因见上文

## 署名

parser 层提取自 [`@vibe-cafe/vibe-usage`](https://github.com/vibe-cafe/vibe-usage)（MIT，其 `package.json` 声明）。上游仓库没有独立的 LICENSE 文件、源文件也无版权头，故无法复现具名版权人——署名归于该上游项目及其 npm 维护者。

提取的文件清单、对它们做的每一处修改、以及修改原因，见 [`src/upstream/UPSTREAM.md`](src/upstream/UPSTREAM.md)。

## License

MIT，见 [LICENSE](LICENSE)。
