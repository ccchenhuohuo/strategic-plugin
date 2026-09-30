# strategic-analytics

当前正式版：**0.3.0**（Strategic 改名与战略季报能力） · [正式发行版](https://github.com/ccchenhuohuo/strategic-plugin/releases/tag/v0.3.0) · [更新记录](CHANGELOG.md)

Codex / Claude Code 插件：用受治理的只读 MCP 做大盘市场分析——趋势、份额、增长与贡献、排名与变化榜、
价格带、品牌集中度与单品牌多月序列、标准类目与平台原始类目导航、单 SKU 搜索与逐月轨迹。

装好之后直接用自然语言提问即可，例如：

> 最近三个月大盘整体表现怎么样？
> 2026-05 Amazon US 的品牌集中度如何，CR5 是多少？
> 搜一下 Amazon US 卖得最好的三脚架，看它今年以来的价格走势。

战略组季报（0.3.0 起，仅 Claude Code）：`/strategic-analytics:quarterly-report current_start=2026-01 current_end=2026-04 label=26Q1`，
按固定骨架取数、分章写市场洞察并做数字溯源校验；只写战略洞察，不写经营建议。

季报默认输出 Markdown。需要飞书云文档时，在交互式 `claude` 终端执行
`/plugin configure strategic-analytics@strategic`，开启「用飞书云文档输出季报」，新开会话后生效。
机械校验通过后会在运行者的飞书个人空间根目录生成文档与同名附表，不共享；分享前请人工审阅。
正文包含叙述、图表、分析表与品牌表，商品下钻明细和证据账本放附表，正文链接到对应子表。

飞书输出需要本机已安装并登录 **lark-cli ≥ 1.0.81**，使用用户身份；所需权限包括
`docx:document:create`、`docx:document`、`docs:document.media:upload`、`sheets:spreadsheet:create`、
`sheets:spreadsheet:write_only`。未登录、令牌失效或缺权限时脚本报错并给出用户自行执行的登录授权命令；
lark-cli 被卸载、找不到或发布失败时保留 Markdown。关闭开关时不会调用 lark-cli。

图表需要 **Python 3.12/3.13** 与中文字体。首次出图自动在插件数据目录创建环境，下载约 25 MB 的固定版本依赖；
可以设置 `STRATEGIC_PIP_INDEX_URL` 指定包源，也可以用 `STRATEGIC_CHART_PYTHON` 指向符合锁定版本的解释器。
版面检测检查文字与气泡、文字与文字、参考线与引线等碰撞；没有可用环境或全部布局策略未通过时跳过相应图，报告继续生成。
Markdown 与飞书使用同一批 PNG；报告引用的图片缺失会阻断机械校验。

所有可见数字由服务端计算并携带复现戳（`release_id` + 参数回显）。当前合法发布链上的 release 可按相同参数复现聚合结果；可绑定列表见 `strategic_data_status`。
晚到兄弟节点、冲突或失活可能使旧 release 不再可绑定。SKU 明细只保留发布链最近 3 个 release 的在线切片，归档后明确披露。

## 安装前准备

| 依赖 | 说明 |
|---|---|
| 客户端 | Codex 或 Claude Code，需支持插件；0.3.0 源码的兼容性验证使用 Codex CLI 0.155.0-alpha.9.2、Claude Code 2.1.281 |
| 访问令牌 | 向插件维护者申请。Claude Code 在插件配置框里填写（存系统钥匙串）；Codex 读环境变量 `STRATEGIC_MCP_TOKEN` |
| 网络 | 能访问 MCP 端点（默认 `https://voc.ulanzi.com:28081`） |

**Claude Code 用户不需要设置环境变量**，令牌在安装时填写，见下文「安装：Claude Code」。

以下环境变量只用于 **Codex**（以及不经插件配置、直接运行季报脚本的场景）。
在 shell 配置（如 `~/.zshrc`）中加入下面一行，替换令牌占位符，**新开一个终端**后从该终端启动客户端：

```bash
export STRATEGIC_MCP_TOKEN="你的令牌"
```

令牌只放在本机环境变量中，不写进插件、仓库或 `config.toml`。可以用
`test -n "$STRATEGIC_MCP_TOKEN" && echo "令牌已设置"` 检查当前终端是否设置了变量，不打印令牌。

**桌面端 / IDE 注意**：从 Dock、开始菜单或 IDE 启动的进程不一定继承终端环境；只改 `.zshrc`
并重启应用未必生效。macOS 可在已加载令牌的终端中执行以下命令，再完全退出并重新打开客户端：

```bash
launchctl setenv STRATEGIC_MCP_TOKEN "$STRATEGIC_MCP_TOKEN"
```

该设置需在注销或重启系统后重新执行。Windows 请把 `STRATEGIC_MCP_TOKEN` 配为用户环境变量，
并重启客户端及启动它的 IDE。CLI 用户直接从已设置变量的终端运行 `codex` 或 `claude`。

## 安装：Claude Code

在 Claude Code 会话里依次执行两条命令：

```
/plugin marketplace add ccchenhuohuo/strategic-plugin
```

```
/plugin install strategic-analytics@strategic
```

安装时会弹出配置框：填入访问令牌，服务地址保持默认。按提示确认后重启 Claude Code。

- 令牌存进系统安全存储（macOS 钥匙串），不写进 `settings.json`，也不需要环境变量。
- 配置框没有弹出（例如从 shell 用 `claude plugin install` 安装），或以后要换令牌：在交互式 `claude` 会话里执行
  `/plugin configure strategic-analytics@strategic`，然后新开会话。桌面端没有配置入口时，在终端运行一次 `claude` 做这一步即可，
  配置与桌面端共用。
- 季报脚本经 Bash 直连服务、读不到插件配置，所以每次会话启动时插件会把服务地址与令牌写进
  `~/.claude/plugins/data/strategic-analytics-strategic/connection.env`（仅本人可读；卸载插件时随数据目录删除），脚本从这里取用。
- 同一会话钩子还把飞书开关和本机 lark-cli 路径写进数据目录的 `output.env`（0600）；不调用 lark-cli、不联网。
  检测到 CLI 而开关未开启时只提示一次；更改开关或安装 CLI 后新开会话。

## 安装：Codex

在已设置 `STRATEGIC_MCP_TOKEN` 的终端执行：

```bash
codex plugin marketplace add ccchenhuohuo/strategic-plugin
codex plugin add strategic-analytics@strategic
codex mcp get strategic --json
```

输出的 `transport.bearer_token_env_var` 应为 `STRATEGIC_MCP_TOKEN`，然后完全重启 Codex 并新建会话。
Codex 清单只能指定一个令牌变量，**必须改设新变量**；旧变量回退只适用于季报脚本，不适用于 Codex 插件 MCP。
插件内已声明认证，不需要另外添加同名的用户级 MCP。两端共享 Skill 和同一个服务端。

仅直接接入 MCP 时，也可以使用用户级配置：

```bash
codex mcp add strategic \
  --url https://voc.ulanzi.com:28081/flywheel/mcp \
  --bearer-token-env-var STRATEGIC_MCP_TOKEN
```

改用插件接入后执行 `codex mcp remove strategic` 移除用户级覆盖，再用 `codex mcp get strategic --json` 验证插件清单。

## 从 0.2.x（flywheel-analytics）迁移

0.3.0 将插件改为 `strategic-analytics`、市场和 MCP 登记名改为 `strategic`，14 个工具统一使用 `strategic_` 前缀。
旧工具名不提供别名，插件和服务端须同时更新。GitHub 新仓库为 `ccchenhuohuo/strategic-plugin`，旧地址由 GitHub 自动跳转；
服务网关地址仍为 `https://voc.ulanzi.com:28081/flywheel/mcp`。旧安装不靠普通更新跨名迁移，需卸载并重装。

Claude Code：在交互式 `claude` 会话里依次执行以下命令。0.3.0 的访问令牌改存插件配置，需要重新填写。

```
/plugin uninstall flywheel-analytics@flywheel
/plugin marketplace remove flywheel
/plugin marketplace add ccchenhuohuo/strategic-plugin
/plugin install strategic-analytics@strategic
/plugin configure strategic-analytics@strategic
```

在配置框填写访问令牌，服务地址保持默认；需要飞书季报时重新开启对应开关，然后新开会话。
连接文件改在 `~/.claude/plugins/data/strategic-analytics-strategic/connection.env`，旧插件数据随卸载删除。

Codex：在终端先卸载旧插件、删除旧市场，并清理可能残留的用户级 `flywheel` MCP 临时配置，再添加新市场、安装并配置令牌。

```bash
codex plugin remove flywheel-analytics@flywheel
codex plugin marketplace remove flywheel
codex mcp remove flywheel
codex plugin marketplace add ccchenhuohuo/strategic-plugin
codex plugin add strategic-analytics@strategic
export STRATEGIC_MCP_TOKEN="你的令牌"
codex mcp get strategic --json
```

若没有添加过用户级临时 MCP，`codex mcp remove flywheel` 提示未配置即可继续。
把 shell 配置里的令牌变量改为 `STRATEGIC_MCP_TOKEN`；桌面端 / IDE 还需按「安装前准备」更新进程环境，
然后完全退出并重新打开 Codex、新建会话。只设置 `FLYWHEEL_MCP_TOKEN` 无法认证新 Codex 插件。

### 环境变量过渡兼容（直接运行脚本）

季报脚本先读 `STRATEGIC_MCP_URL` / `STRATEGIC_MCP_TOKEN`、`STRATEGIC_PIP_INDEX_URL`、`STRATEGIC_CHART_PYTHON`；
新变量未设置时可回退同后缀的 `FLYWHEEL_*`，旧名均已弃用。
地址与令牌按变量族成对选择：有 `STRATEGIC_MCP_URL` 就只取 `STRATEGIC_MCP_TOKEN`；否则有
`FLYWHEEL_MCP_URL` 就只取 `FLYWHEEL_MCP_TOKEN`。缺少对应族令牌时也不借用另一族或插件令牌。
没有显式环境地址时，先取带令牌的连接文件；再取插件默认地址与环境令牌（新名优先，旧名回退）。

## 验证（两端相同）

```
/mcp
```

看到 strategic 服务器处于 connected（Claude 插件可能显示为 `plugin:strategic-analytics:strategic`）。
再问一句"数据是什么时候的？多久更新一次？"，
能返回当前数据范围与水位月份就说明端到端通了。

如果连接失败，依次检查：

1. Claude Code：是否已在插件配置里填了令牌（`/plugin configure strategic-analytics@strategic`），填完是否新开了会话。
2. Codex 的 `codex mcp get strategic --json` 是否包含 `bearer_token_env_var = STRATEGIC_MCP_TOKEN`；不符时重新安装新插件。
3. Codex：**客户端进程**是否能读取 `STRATEGIC_MCP_TOKEN`；当前终端有变量，不代表已启动的桌面应用也有。
4. 令牌是否正确、能否访问上表里的端点。

`codex mcp get` 只验证配置；`auth_status` 的 `Unknown` / `unsupported` 也不能单独证明令牌失效。
以实际连接和 `strategic_data_status` 调用成功为准。
**插件不会用缓存或记忆中的数字兜底**——MCP 不可用时它会如实说明并停止。

## 更新与卸载

已迁移到 Strategic 的 Claude Code 用户更新：

```
/plugin marketplace update strategic
/plugin update strategic-analytics@strategic
```

Claude Code 卸载插件、删除市场：

```
/plugin uninstall strategic-analytics@strategic
/plugin marketplace remove strategic
```

Codex 更新：

```bash
codex plugin marketplace upgrade strategic
codex plugin add strategic-analytics@strategic
```

`marketplace upgrade` 要求当前 CLI 已登记 Git 市场。用 `codex plugin marketplace list --json` 核对当前配置；
如果来源是本地目录，需自行更新该目录。其他客户端、机器或其他 `CODEX_HOME` 的安装不会登记到当前配置。
更新后完全重启客户端并新建会话。

Codex 卸载插件、删除市场：

```bash
codex plugin remove strategic-analytics@strategic
codex plugin marketplace remove strategic
```

卸载插件不会删除手动添加的用户级 MCP；如果配置过同名临时覆盖，另执行 `codex mcp remove strategic`。
0.2.x 的旧安装请先按上面的迁移节处理。

## 能力边界

<!-- BEGIN GENERATED CAPABILITIES -->

| 用户问题 | 当前支持与处理路径 |
|---|---|
| 市场趋势、份额、增长、品牌、价格带、类目、SKU | 已支持，选择对应的受治理分析工具。 |
| 主机市场（相机出货、中国手机出货） | `strategic_industry`：CIPA 数码相机月报（全球与出货目的地、机型结构）与信通院国内手机月报；先用 `view:"catalog"` 看时效与口径。只作外部背景，与电商数字并列比较方向，不相除、不混算。 |
| 更新到哪月、发布是否陈旧、历史结果能否复现 | `strategic_data_status`：可用月份、上游状态、可绑定 release 与 SKU 切片在线状态。 |
| 字段覆盖、未分类、检疫情况 | 使用分析响应的 `coverage_notes`、`caveats`；`data_status` 披露最新月部分字段空值率。仅限响应实际披露的月份与范围，全站点披露不能定位某类目或品牌，也不能证明采集完整。 |
| SPU 数量或变化 | 当前分析 MCP 未提供 SPU 去重数量；销量、源行数、SKU 搜索候选数都不能替代。`strategic_product_rank` 的 `summary` 给出「匹配子集内有观察的商品身份数」（Amazon 按子 ASIN、淘系按商品 ID），它不是 SPU、也不是在售链接数，且受服务商截断长尾影响，只能作池变化的旁证。 |
| 季报、季度市场洞察报告 | quarterly-report Skill（Claude Code 中运行 `/strategic-analytics:quarterly-report`）：固定骨架取数、分章写洞察、数字溯源校验；只写洞察，不写经营建议。 |
| 漏采、采集完整性、异常验收 | 当前分析 MCP 不提供验收结论；字段覆盖与已有查询结果不足以判定漏采。 |

SPU／验收问题先说明上述边界。仅当当前环境确有相关项目验收 Skill 且其声明支持该问题时，
按其入口与前置条件处理；否则说明缺少可用验收入口，不编造安装路径。
项目验收不是普通市场分析的前置条件。
已有字段覆盖披露只能回答对应字段与范围，不能据此断言“没有漏采”或“验收通过”。
项目验收按其自身口径输出，不作为本插件市场分析的替代数据源。

<!-- END GENERATED CAPABILITIES -->

- **月度粒度**，没有周/日；数据起点 2024-01，上界为当前水位（最大完整月，按次月 16 日交付边界判断），实际范围以 `strategic_data_status` 返回为准。
- 指标是**市场估算**：销量为估算件数、金额为价×量推导值，不是 GMV、实付或订单数。
- 贡献与结构变化是**数学分解，不是因果**；插件不做预测，也不给进入/退出、定价、预算类经营建议。
- **缺失不等于零**：'未分类' 是独立桶，映射存在但当月无观察表述为"无观察"，超出水位表述为"尚无完整数据"。
- 跨站点本币金额不可相加，需按站点分别展示或改用人民币口径（服务端按 release 冻结的汇率快照换算）。
- 价格带为政策固定分桶，不支持自定义；平台原始类目只到 L3；不接受任意 SQL。

这些不是 bug，是治理约束。插件遇到越界请求会拒绝并给出合规的替代路径。

## 给维护者

本仓库是**插件分发子集**，只包含使用者安装所需的内容。三层架构（Doris 治理表 + 薄 MCP + 方法论文本层）、构建管线、断言与验收手册在内部仓库，
不随插件分发。Skill 承载完整规则与能力路由；MCP instructions 保持简短，完整规则也可经 `strategic_describe_semantics` 按需读取，具体查询附带响应警示。

### 双客户端打包约定

| 消费端 | 插件清单 | MCP 认证来源 |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | 清单 `userConfig`：`strategic_token`（sensitive，存钥匙串）与 `strategic_url`（默认生产）；根目录 `.mcp.json` 引用 `${user_config.strategic_url}` 与 `Bearer ${user_config.strategic_token}` |
| Codex | `.codex-plugin/plugin.json` | 原生清单内联 `mcpServers.strategic.bearer_token_env_var = "STRATEGIC_MCP_TOKEN"` |

Codex 清单内联声明完整的同名服务器，覆盖默认发现的 Claude MCP 条目，避免依赖 Claude `headers`
字段的自动转换。根目录 `.mcp.json` 保留 Claude 格式；Skill 共用 `skills/strategic-analytics/`。
现有 `.claude-plugin/marketplace.json` 已用两个 CLI 实测可安装，无需维护第二套市场目录。

季报脚本经 Bash 直连服务，Bash 的环境里没有插件配置：`hooks/connection.sh`（SessionStart）把地址与令牌写进
`${CLAUDE_PLUGIN_DATA}/connection.env`（0600），runner Agent 以 `--connection` 交给脚本。地址与令牌总是成对取自
同一来源：先按新旧变量族成对取环境连接，否则取带令牌的连接文件，再否则取默认地址与环境令牌（新名优先，旧名已弃用）。
随后 `hooks/output.sh` 记录 `feishu_output` 与 CLI 路径到 `${CLAUDE_PLUGIN_DATA}/output.env`；图表托管环境放在
`${CLAUDE_PLUGIN_DATA}/chart-env`。Python 绘图器及锁定依赖文件位于 `skills/quarterly-report/scripts/charts/`，随 `skills/` 分发。

发布制品必须同时包含 `.claude-plugin/`、`.codex-plugin/`、`.mcp.json`、`skills/`（含季报脚本与配置）、`agents/`、`workflows/`、`hooks/` 与本 README，
注意打包时不要漏掉隐藏目录。两份 `plugin.json` 的名称和版本必须一致，Codex 清单里的 URL 必须等于 `strategic_url` 的默认值。
当前源码版本为 0.3.0；发布时同步更新两份清单，旧版缓存不会因只修改源码而自动刷新。
服务端优先读取 `STRATEGIC_PORT` / `STRATEGIC_TOKEN` / `STRATEGIC_AUTH`，未设置时回退已弃用的 `FLYWHEEL_*`；
生产 `/etc/flywheel-mcp.env`、systemd 服务名与部署目录本次保持不变。插件和服务端要在同一发布窗口切换，旧工具名不提供别名。

每次发布同时更新 README 与 CHANGELOG，将版本标签绑定到实际分发提交，并创建同版本 GitHub Release。
发布后核对默认分支、两份插件清单、标签和 Releases 的最新版本一致；本机重新安装后核对 Skill 与分发文件一致。

配置依据：[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、
[Codex 插件构建](https://learn.chatgpt.com/docs/build-plugins)、
[Claude Code 插件参考](https://code.claude.com/docs/en/plugins-reference)。
OpenAI 的 [Claude 插件提交转换说明](https://developers.openai.com/plugins/guides/submit-claude-plugin)
讲的是提交门户流程；本仓库的客户端兼容性以原生清单和实际 CLI 加载结果验证。
