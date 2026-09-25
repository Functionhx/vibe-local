# 上游来源与差异记录

本目录下的代码提取自 `@vibe-cafe/vibe-usage`，**不是我们自己写的**。这份文件记录来源、指纹、以及我们对它做的每一处改动。目的：日后能低成本地把上游的 parser 修复合进来。

## 来源

| 项 | 值 |
|---|---|
| 包名 | `@vibe-cafe/vibe-usage` |
| 版本 | `0.12.0` |
| tarball | `https://registry.npmjs.org/@vibe-cafe/vibe-usage/-/vibe-usage-0.12.0.tgz` |
| tarball sha256 | `65e5daabb3b72f4da642cbb660934553c028f22f94d3320f3cad56d3859a8fc4` |
| 仓库 | https://github.com/vibe-cafe/vibe-usage |
| 提取日期 | 2026-09-24 |

## 为什么提取而不是重写

上游的 parser 层有 9765 行、覆盖 60+ 工具，处理各工具日志格式的历史变迁、session fork/copy 去重、subagent thread 归属、30 分钟 bucketing 边界。这些是长期踩坑积累的，重写不现实。

我们只要其中 4 个工具，且要去掉它的全部网络/daemon/凭证逻辑——那些逻辑集中在 `sync.js` / `api.js` / `state.js` / `quotas/` / `daemon*.js`，**与 parser 层完全解耦**（没有任何 parser import 它们）。所以提取是干净的。

## 提取的文件（16 个）

从 `src/parsers/` 取 12 个：

```
aggregate.js       所有 parser 全依赖：聚合、session 累加器、半小时取整
fs-utils.js        claude-code.js 依赖
sqlite.js          opencode.js 依赖（优先 node:sqlite，Node<22.5 回退 sqlite3 CLI）
contract.js        normalizeParserResult：校验 bucket.source === 注册键
index.js           注册表（**已修改**，见差异 2）
claude-code.js     425 行
codex.js           1175 行
codex-segments.js  108 行，只依赖 node:crypto
codex-cache.js     138 行（**已修改**，见差异 1）
cindy-ledger.js    codex.js 静态 import，闭包必需
opencode.js        84 行
```

从 `src/` 取 5 个：

```
claude-roots.js    claude-code 的根目录发现
codex-roots.js     codex 的根目录发现
opencode-roots.js  opencode 的根目录发现
extra-roots.js     claude-roots.js 与 codex.js 共同依赖
cindy-roots.js     cindy-ledger.js 依赖
```

**零第三方依赖**——全部只用 node 内置模块。

### 闭包验证

在提取后的目录上跑过一次 import 闭包分析（从 `parsers/index.js` 出发）：

- 可达文件 **15 个**，所有相对 import 都能解析
- 外部包依赖 **0 个**
- `contract.js` 不在闭包内是**预期的**：上游由 `sync.js` 使用，本项目中由我们自己的 `src/collect.js` 使用

> 注：`extra-roots.js` 里有 `.gemini/antigravity*/conversations` 的路径，那是
> **Antigravity** 的路由，与我们移除的 Gemini CLI 无关。我们不用 Antigravity
> 那个 parser，这段代码不会被走到。留着不动是为了少一处上游改动。

> 提取时踩过一个坑：最初按"用户用到的工具"列了 14 个文件，漏掉了 `cindy-ledger.js` 和 `cindy-roots.js`。**即使用户不用 Cindy 也必须带上**——`codex.js:15` 是静态 import，ESM 会在加载时就要求文件存在，缺了直接起不来。故保留而非删 import：让 `codex.js` 保持字节级不变，上游 merge 时零冲突。

## 差异清单（共 3 处）

### 差异 1 — codex 缓存目录改到 `~/.vibe-local/cache`

**文件**：`parsers/codex-cache.js` → `codexCacheDir()`

**上游行为**：默认 `${VIBE_USAGE_CACHE_DIR || ~/.vibe-usage/cache}/codex/root-<hash>/`

**改为**：默认 `${VIBE_LOCAL_CACHE_DIR || ~/.vibe-local/cache}/codex/root-<hash>/`

**原因**：两个理由，缺一不可。

1. 路径撞车——用户机器上装着真的 vibe-usage 时，两者会读写同一个缓存目录。
2. 环境变量撞车——只改路径而沿用 `VIBE_USAGE_CACHE_DIR` 是治标不治本：用户一旦为上游工具设过这个变量，我们又会指回同一个目录。所以改用我们自己的变量名。

### 差异 2 — 注册表裁到 3 个 parser

**文件**：`parsers/index.js`

**上游**：注册 34 个 parser。

**改为**：只注册 `claude-code`、`codex`、`opencode`。

**原因**：本项目只支持这 3 个工具。要恢复某个工具：补回 `import` 行、加进 `parsers`、以及把它的 parser 文件与 roots 文件一并复制进来。

### 差异 3 — 不提取 cursor

**文件**：无（只是没取 `parsers/cursor.js`）

**原因**：**cursor 是唯一无法离线工作的 parser**。它的流程是：从本地 `state.vscdb` 里读出 access token（`cursor.js:44-56`），然后 `fetch('https://cursor.com/api/dashboard/export-usage-events-csv')`（`cursor.js:156`），解析返回的 CSV。它统计的是**云端账号级用量**，本地根本没有 token 日志。

这跟本项目"纯本地、不联网"的前提直接冲突，故明确排除，而不是"暂时没做"。

> 将来若有人想加回来：它需要一次对 cursor.com 的网络请求。请让它默认关闭、显式开启，并在开启时打印一行说明连的是哪里、为什么。

### 差异 4 — 不提取 gemini-cli

**文件**：无（`parsers/gemini-cli.js` 已从本仓库删除）

**原因**：两条，任一条单独成立就够。

1. **实测零数据**：本机与远程服务器上 `~/.gemini/tmp` 的 `chats/` 目录都是空的（目录建出来了但从未写入过 session）。它在这个项目里不产生任何数字。
2. **无法重定向**：路径硬编码在 `gemini-cli.js:6` 的模块级常量 `join(homedir(), '.gemini', 'tmp')`，**既无环境变量也无参数入口**。远程镜像的核心机制是把 parser 指向镜像目录，而它做不到——留着它就意味着"镜像方案里有个工具永远只能是本机的"。

**影响**：`mirrorRoots()` 现在覆盖全部 3 个受支持的 parser，不存在无法镜像的例外。

> 顺带一提：即便将来要支持 Gemini CLI，也应该先去看上游是否已给它加上路径覆盖入口，而不是在这里改源码——改了就跟上游分叉了。

## 已知的上游行为（未修改，但在我们的层做了处理）

以下不是我们的改动，但仍需知道——它们在本项目里被别处兜住了，改动上游代码反而会破坏同步。

### 1. 根目录不存在时 parser 静默返回 0

实测：把 `CODEX_HOME` 指向一个不存在的路径，`parse()` 返回

```js
{ buckets: [], sessions: [], skipped: false, warnings: [] }
```

**没有任何 error、没有 warning、`skipped` 还是 false。** 调用方无法区分"这个工具没用量"和"我配的根目录根本不存在"。

对上游而言这是合理语义（缺 `CODEX_HOME` 通常意味着用户没装 codex）。但本项目的远程镜像必须区分这两种情况——我们**明知**自己配置了一个镜像根。

**处理位置**：`src/mirror.js` 的 `mirrorStatus()` 会先检查镜像目录是否存在且非空，缺失的会在报告里显式标注。**不要去改 parser** —— 改了就跟上游分叉了，而这个语义对上游是对的。

### 2. `extraRoots` 是追加语义，不是替换

`getClaudeRoots()` / `getOpenCodeStores()` 里的 `extraRoots` 参数会把额外的根**追加**在默认根之后，两者都会被扫描。

用作"把解析指向另一份数据"的隔离手段时，这会造成静默的数据混合：实测本机 255 buckets + 镜像 369 buckets，用 `extraRoots` 得到 624，即两份被合并，之后还会被统一贴上远程 hostname，**报表上完全看不出异常**。

**处理位置**：`src/mirror.js` 改用替换语义的环境变量（`VIBE_USAGE_CLAUDE_DIRS` / `CODEX_HOME` / `VIBE_USAGE_OPENCODE_DIRS`），并让那一遍串行执行（环境变量是进程级的，并发时会互相覆盖）。

### 3. `codex` 的缓存目录随 `CODEX_HOME` 走

`codex-cache.js` 的缓存路径含 `root-<hash(codexHome)>`，所以镜像的 codex home 会自动得到独立的缓存目录，不会和本机的互相污染。这一点上游设计得对，无需处理。

## 与上游保持同步

parser 层是这个项目唯一需要长期跟上游的东西。建议做法：

1. `npm pack @vibe-cafe/vibe-usage@<新版本>` 下载新 tarball
2. 解包到临时目录，对每个提取的文件跑 `diff`
3. **只挑 parser 修复**合进来，不引入新的网络/daemon/凭证代码
4. 若上游改了 `aggregate.js` 的字段或语义，注意同步更新：
   - `src/pricing/cost.js`（字段名对应价格）
   - `src/report/`（分组与展示）
5. 改动 `codex-cache.js` 的解析逻辑时，**必须 bump `CODEX_PARSER_ALGORITHM_VERSION`**（`codex-cache.js:17`），否则旧缓存会被当成有效结果复用
6. 更新本文件的版本号、sha256 和差异清单

## License

上游 `package.json` 声明 `"license": "MIT"`，但**仓库中没有 LICENSE 文件**（`gh api repos/vibe-cafe/vibe-usage/license` 返回 404）。

本目录的代码版权归上游作者所有，按 MIT 使用。详见项目根目录的 `LICENSE` 与 `README.md` 的署名章节。
