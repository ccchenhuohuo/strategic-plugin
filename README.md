# strategic-analytics

战略大盘分析插件的 **0.3 系列**：从月度查询扩展到窗口比较、服务端增长分解、商品竞争与证据驱动季报。
以同一份 Skill、标准 MCP 与脚本引擎接入 Codex / Claude Code / WorkBuddy，装好后可用自然语言分析市场趋势、金额份额、品牌格局、价格带与商品轨迹。

**当前正式版：[0.3.2](https://github.com/ccchenhuohuo/strategic-plugin/releases/tag/v0.3.2)，2026-10-10 发布。**
共用季报入口、Codex setup 与通用配对绑定、本地固定收录和飞书同步开关均包含在本版。
从 0.2.x 升级可以一次获得 0.3 系列能力，无需依次安装 0.3.0 / 0.3.1；真实版本历史保留在 [CHANGELOG](CHANGELOG.md)。

> 最近三个月大盘整体表现怎么样？
> Amazon US 最近完整月的金额份额与品牌集中度如何？
> 看支架类当期窗口的 Top 商品，以及商品身份池的延续、新进和退出。

## 从 0.2 到 0.3 的能力提升

| 能力 | 0.2 系列 | 0.3 系列 |
|---|---|---|
| 受治理工具 | 12 个只读工具 | 14 个，新增 `strategic_product_rank`、`strategic_industry`；统一 `strategic_` 前缀 |
| 时间比较 | 单月、月度趋势、两期比较 | 最长 12 个连续完整月的窗口；整窗同比、相邻等长环比，至多两个对照；先汇总再计算 |
| 增长与均价 | 增长、增量与贡献 | 服务端 Shapley 销量/结构/均价分解，以及均价的价格/结构拆分；贡献与分解不写成因果 |
| 类目与分段 | 品牌/价格带已有完整父路径 | SKU 明细也支持完整 L1/L2/L3；路径并集与不重叠分段比较，旧代次缺粒度明确拒绝 |
| 品牌竞争 | 单月格局、集中度、单品牌序列 | 窗口排名、金额份额 pp、名次变化与公司品牌保留行；逐月 × 全品牌面板仍不提供 |
| 商品 | 单 SKU 搜索与逐月轨迹 | 细分范围/品牌 Top 商品及链接，商品身份池变化、同商品单位价值指数；身份不是 SPU，榜单是截断集合 |
| 外部行业背景 | 电商匹配子集估算 | CIPA 相机出货、信通院国内手机出货独立链；只并列看方向，不与电商相除、混算或解释因果 |
| 季报 | 自由组织分析 | 固定骨架、证据账本、分章洞察、后写执行摘要、图表版面门禁、数字溯源与语义核查；只写洞察 |
| 报告产物 | 查询结果与分析叙述 | 本地 Markdown 与可选飞书文档/附表；0.3.2 固定收录、索引与历史版本 |
| 宿主执行方式 | 分析 Skill + MCP | 0.3.2 共用季报 Skill 与角色参考，顺序执行或委派；Claude Workflow 是可选优化，WorkBuddy 按官方规范提供引导 |

全部数字由受治理服务计算；电商金额/件数为估算，保留响应口径、缺失状态与复现戳。
NULL、无观察、未分类、越过水位、检疫与切片归档各有各的含义，不能补零或互相替代。

## 安装：Codex

需支持插件的 Codex CLI；本地适配以 **0.159.2** 实测原生安装、skills discovery 与 hooks 隔离。
Node.js ≥ 18 用于季报脚本；原生季报绑定另需本机可执行的 Codex CLI（读取本地 MCP 配置）。访问令牌向维护者申请，客户端进程需继承 `STRATEGIC_MCP_TOKEN`。
不要把令牌发到对话里、写进插件、本地偏好或 config.toml，也不要打印它。

CLI 从已配置环境的终端启动。在 zsh 中可交互输入而不回显（当前终端有效）：

```zsh
read -rs 'STRATEGIC_MCP_TOKEN?访问令牌（输入不回显）：'
export STRATEGIC_MCP_TOKEN
```

可用 `test -n "$STRATEGIC_MCP_TOKEN" && echo "令牌变量已设置"` 检查设置状态。
这不证明认证成功；以实际 `strategic_data_status` 调用为准。
桌面/IDE 启动的进程可能不继承终端环境；只改 shell 配置、重启窗口也未必生效。
通过你管理的安全启动环境向客户端进程提供同名变量，再完全退出并启动、新建会话；setup Skill 可帮助检查当前进程的状态。
本地偏好只管报告目录与同步，不能替代认证；Codex 不执行 Claude userConfig，也不使用 Claude 钥匙串或连接钩子。

安装 **0.3.2**：

```bash
codex plugin marketplace add ccchenhuohuo/strategic-plugin
codex plugin add strategic-analytics@strategic
codex mcp get strategic --json
```

应看到唯一 `strategic` MCP、`transport.bearer_token_env_var` 为 `STRATEGIC_MCP_TOKEN`，默认地址
`https://voc.ulanzi.com:28081/flywheel/mcp`。不要额外添加同名用户级 MCP；已有手工覆盖时先
`codex mcp remove strategic`，再核对插件连接。

### 原生季报与设置

需要从本地完整包安装时，可以在独立 CODEX_HOME 下登记该目录，再安装：

```bash
codex plugin marketplace add "/绝对路径/strategic-plugin"
codex plugin add strategic-analytics@strategic
```

新会话用 `$strategic-analytics:strategic-setup` 验证连接、调整报告目录或同步偏好。
CLI 实测会发现 `strategic-analytics:strategic-analytics`、`strategic-analytics:quarterly-report`、
`strategic-analytics:strategic-setup` 三个 Skill，setup 已被识别为 onboardingSkill；桌面安装后 setup 按钮及交互仍待独立 UI 验收。

生成时用 `$strategic-analytics:quarterly-report` 并说明实际月份，例如“生成 26Q1 季报，当期 2026-01 至 2026-03”。
三端共用 `skills/quarterly-report/SKILL.md`，从实际加载路径找到同一脚本和角色参考，按固定骨架取数、分章写作、语义核查与有限修订，最后写执行摘要，再组装和机械校验。图表在取数后执行，组装前结束。
有协作能力可委派，没有则按相同角色指导顺序执行。写手只读服务端摘要，正文数字原样引用 `*_display`，不计算业务数字。

本地 helper 可单独使用；下例路径从已加载 setup Skill 解析获得，不要猜安装版本，也不要把项目 cwd 当成包根：

```bash
node "/实际包根/skills/quarterly-report/scripts/codex.mjs" show
node "/实际包根/skills/quarterly-report/scripts/codex.mjs" configure --report-dir "~/Documents/战略季报" --feishu-output false
node "/实际包根/skills/quarterly-report/scripts/codex.mjs" verify
```

只变更指定键，遗漏键保留；中文空格、~ 与绝对路径均可，相对路径/非法值报错且保留旧偏好。
默认同步关闭。偏好位于 `<CODEX_HOME 或 ~/.codex>/plugins/data/strategic-analytics-strategic/preferences.json`，
只存 `report_dir`、`feishu_output`；show/configure 准备 `runs/`、`chart-env/` 和偏好输出，
只发现 lark-cli，不运行它、不联网、不存令牌。报告目录仅收录时创建。验证可用 `--data-dir` 指向临时目录。

每次报告先 verify：它只执行本地 `codex mcp get strategic --json`，捕获并白名单解析当前实际选择的端点与认证声明，
不调用 MCP/模型，也不回显原始配置、headers 或凭据。仅接受已启用 HTTP 服务和 `STRATEGIC_MCP_TOKEN` bearer 认证；
缺 CLI、配置损坏或认证方式不符就停止。URL 含认证或可疑秘密拒绝保存；已设 `STRATEGIC_MCP_URL` 必须与实际端点一致，
不一致在任何请求前拒绝。旧 FLYWHEEL 族和 Claude 配置不参与，也不猜默认服务。

verify 返回非敏感 `codex_binding` 收据及冻结的 `output_env`，prepare 必须传 `--codex --codex-binding <收据路径>`，
再核对当前配置。后续发布/收录只使用本次冻结输出；另一会话 configure 只影响后续报告。绑定或冻结输出被修改时拒绝续跑，
不复用旧证据。verify 通过仅证明本地配置，服务连接仍以原生 `strategic_data_status` 调用为准。
持久化同步开关表示用户生成报告时额外同步的意图，配置本身不会发布，无需每次重复审批；用户取消或要求本次不发布时停止同步。

Codex 清单逐目录明确选取共同 `skills/strategic-analytics/`、`skills/quarterly-report/` 与薄设置入口 `codex/skills/strategic-setup/`，通过显式空 hooks 文件关闭 Claude hooks 的默认发现。
CLI 0.159.2 中 `hooks: []` 未能关闭默认发现，因此使用 `hooks: "./codex/hooks.json"`，真实 app-server 检查 hooks 为空。
不要求 Codex 用户执行 Claude 配置命令或 Workflow。

## 安装：Claude Code

```text
/plugin marketplace add ccchenhuohuo/strategic-plugin
/plugin install strategic-analytics@strategic
```

安装配置框填入访问令牌，服务地址保持默认；令牌存系统安全存储，不需要环境变量。
没有配置框或需换令牌时，在交互式 claude 中执行 `/plugin configure strategic-analytics@strategic`，然后新开会话。
本轮使用真实 **Claude Code 2.1.293** 验证临时安装、会话配置和钩子；没有修改真实设置或钥匙串。
本轮验收未执行 Claude 模型季报；安装和配置检查不代表模型执行通过。

Claude 季报入口：

```text
/strategic-analytics:quarterly-report current_start=2026-01 current_end=2026-03 label=26Q1
```

默认遵循共同 Skill 的脚本流程；宿主实际提供 Workflow API 时，现有 Workflow 与四个同源兼容 Agent 可作为取数、写作、核查和收尾的优化入口。
0.3.1 保留其当时的输出配置；0.3.2 使用默认关闭的「同步飞书云文档报告」与「本地报告目录」，
在交互式 claude 的 `/config` 调整后新开会话。使用者安装最终 0.3 包时一次配置即可；内部迭代细节保留在 CHANGELOG。
`hooks/connection.sh` 把配对的地址与令牌写到 Claude 插件数据目录的 connection.env（0600）；
`hooks/output.sh` 写 feishu、lark_cli、report_dir 到 output.env（0600），只检测 CLI。

## 安装：WorkBuddy 与普通 MCP + Skill 接入

WorkBuddy 首选导入同一个插件地址 **ccchenhuohuo/strategic-plugin**（或其本地完整包），使用既有
`.claude-plugin/`、`.mcp.json` 和根目录 `skills/`，不增加第三份 manifest。宿主支持的插件管理入口、配置框和
安全凭据存储以实际版本为准；安装后新会话用“生成 26Q1 季报，当期 2026-01 至 2026-03”触发共同 Skill。
[CodeBuddy 插件参考](https://www.codebuddy.cn/docs/cli/plugins-reference)说明 .claude-plugin、userConfig 与插件路径变量兼容，
没有说明本项目 Workflow API。[WorkBuddy 连接器市场](https://open.workbuddy.cn/en/docs/connector)是另一种格式，不能据此判定插件目录支持。
本轮 WorkBuddy 验收范围为官方规范核对与接入引导，未安装或实际执行其桌面客户端；CodeBuddy CLI 或合成测试不等于桌面实测。
WorkBuddy 的插件管理与添加第三方市场入口参见[官方插件介绍](https://www.workbuddy.cn/docs/workbuddy/Plugins)。

按官方界面路径操作：

1. 左侧进入「插件」，点击「+」添加第三方市场，地址填 `https://github.com/ccchenhuohuo/strategic-plugin`。
2. 在该市场选择 `strategic-analytics` 安装、启用；通过宿主配置入口填写维护者提供的访问令牌、服务地址和输出偏好。
3. 新开会话，先检查共同分析 Skill 与 strategic MCP 可用，再用自然语言请求带实际月份的季报。若该版本无法加载整包，按下面的 MCP + Skill 路径接入。

宿主没有插件入口时：保留完整安装包（含 Skill、references、scripts、config），用客户端原生方式配置一个名为 strategic 的
HTTP MCP，地址取实际授权端点，Bearer 凭据用该客户端支持的安全配置或环境引用；不要在配置示例或对话里粘贴令牌。
显式加载包内 `skills/strategic-analytics/SKILL.md` 和 `skills/quarterly-report/SKILL.md`。
自由战略分析由宿主主 Agent 按分析 Skill 选择 MCP；季报才依次使用 writer/summary/verifier 角色。
支持会话钩子时，启动提示 `STRATEGIC_PLUGIN_DATA_DIR=...` 给出连接文件所在的真实资料目录；同一钩子兼容 CodeBuddy 的原生命名别名。
提示不包含令牌或服务地址，没有该提示时按下面的显式资料目录与成对启动环境接入，不猜安装缓存或借用其他客户端配置。
有协作者可以委派，没有就按相同角色参考顺序完成，并注明是同会话自查。无需新的 Agent runtime 或服务器。

通用 setup 只管偏好、路径、成对连接和冻结输出。下面路径必须从实际加载的 Skill 定位，data-dir 显式选本宿主目录：

```bash
node "/实际包根/skills/quarterly-report/scripts/setup.mjs" configure --host workbuddy --data-dir "/本宿主数据目录" --report-dir "~/Documents/战略季报" --feishu-output false
node "/实际包根/skills/quarterly-report/scripts/setup.mjs" verify --host workbuddy --data-dir "/本宿主数据目录" --connection "/本宿主数据目录/connection.env" --output-env "/本宿主数据目录/output.env"
```

有钩子时直接运行上述 verify 即可，不必先运行 configure；配置框写出的 output.env 是本次输出偏好的来源。
connection.env/output.env 必须来自本宿主本次会话，均为本人 0600 普通文件；前者只含 url/token，后者只含
feishu/lark_cli/report_dir。脚本不打印或再持久化明文令牌，通用收据只记来源、摘要和输出偏好。
没有钩子时，不传上述两文件；由安全启动环境成对提供 STRATEGIC_MCP_URL + STRATEGIC_MCP_TOKEN，helper 不猜默认地址、
不混配新旧变量、不读另一客户端配置。HTTPS 端点拒绝认证信息、查询、片段及可疑秘密；HTTP 仅限本机回环测试。
CodeBuddy 仅在 helper 的 `--host codebuddy` 作为 workbuddy 别名；Codex 继续用 codex.mjs 的严格实际 CLI/bearer 校验。

通用 verify 的结果只能称**配对连接已验证**（host_mcp_config_verified=false），不能称宿主当前 MCP 配置已验证或服务已连通。
Codex verify 才核对其实际当前配置。两者都需通过本宿主实际 strategic_data_status 验证服务、水位和认证。
verify 返回 portable_binding 与冻结 output_env、runs_dir、chart_env、config；通用 prepare 显式传
`--portable-binding <返回收据>` 和 `--runs-dir <返回目录>`，以后只用本次冻结 output_env 发布/收录。
另一会话改偏好不影响进行中的报告；续跑核对原成对连接、来源、凭据摘要、收据与原运行身份，变化就停止。
冻结输出损坏或指定其他路径拒绝发布/收录；失去网络或令牌仍可用完好的冻结收据离线收录已有草稿。
同路径导入不会重写钩子的现行 output.env；本次冻结值直接来自已验证的导入快照。

运行依赖统一：季报需 Node.js ≥ 18 和读写文件/执行脚本的宿主能力；图表 Python 与飞书 lark-cli 都可选。
未绘图、未独立核查、未同步各自披露，固定阶段只约束控制顺序，洞察正文由模型写作与语义核查完成。
项目指引使用工作台识别的 AGENTS.md 或 CLAUDE.md 文件名，加入相同加载指令即可：市场分析先读取实际安装包的 `skills/strategic-analytics/SKILL.md`；季报再读取 `skills/quarterly-report/SKILL.md` 并依其引用找到角色和脚本。
安装路径从当前已加载 Skill 的真实位置取得；宿主不自动加载时显式读取。完整规则仍共用 Skill，不复制成几套项目规则，也不宣称单数 agent.md 在各客户端自动加载。

## 季报产物与收录

本地 Markdown 始终生成。图表来自同一份证据，Python 3.12/3.13 与中文字体可用时执行，
首次托管环境会下载约 25 MB 锁定依赖；可设 `STRATEGIC_PIP_INDEX_URL` 或 `STRATEGIC_CHART_PYTHON`。
版面门禁不过或环境不可用时跳过相应图并记录警告，已引用图片缺失会阻断机械校验。

报告与实际引用图表收录到 report_dir，缺省 `~/Documents/战略季报`：

```text
战略季报/
  索引.md
  .index.json
  26Q1/
    CMI 全球市场洞察 - 26Q1.md
    charts/
    .report.json
    历史/2026-10-08 09-30/
```

校验阻断、飞书关闭/跳过/失败时也收录，索引标注结果。相同 run_dir 幂等覆盖，同一标签新运行归档上一版，
机械校验的组装比对、数字和表达检查消费同一次捕获的草稿、摘要、表格、证据等输入；表格 JSON 与 Markdown 必须同源一致，直接修改正文也会阻断。校验不改写正文。
check.json 的正文 SHA-256 和逐文件输入版本绑定必须匹配实际收录材料；缺绑定、错版本、摘要不符或结构损坏时仍保留草稿，索引明确标为「未验证（校验不可用）」。
飞书成功记录也绑定正文、输入和计划；只有当前稿匹配才标为已同步。改稿后旧云端链接保留并注明本稿未同步，缺绑定的旧记录标为同步归属未验证；收录过渡时也不沿用旧同步标记。
用户自放文件保留。证据、摘要、草稿、校验、图表规格与发布日志留在各客户端数据目录的 runs 下；
显式 out 只改变工作目录。收录失败指出原稿位置，不删除原报告。所有报告均为草稿，分享前人工审阅。
移动/替换前先写本地恢复记录，普通 I/O 错误后重试先恢复上一笔操作，确保旧索引仍对应旧正文；
归档后先把两份索引的旧行转到历史路径，再安装新版，失败等待重试时可暂缺链接，但可读链接不会错指另一代正文。
同 run 更新也在替换正文前先撤销两份索引的旧通过与旧摘要，标为「未验证（收录进行中）」；恢复后提交新稿状态，最终不新增历史。
记录的阶段、目标清单、索引期望或路径无法验证时返回失败，不扫描目录猜当前版本，不自动清除不明锁。
从第一次组装开始，check/修订/发布异常也尝试收录已有草稿；原异常与收录结果分别回报，收录成功不能把校验失败改为成功。
只释放本进程持有、inode/device 相同的空锁。短暂 EIO 最多尝试三次；持续失败返回 ok=false、锁位置、
collection_completed 与人工恢复说明。确认没有收录进程后，仅对确认遗留的空锁目录手动 rmdir，再重试；其他锁或含文件的目录先人工核对。

飞书是额外同步，需本机已安装并以用户身份登录 **lark-cli ≥ 1.0.81**。
所需权限为 `docx:document:create`、`docx:document`、`docs:document.media:upload`、
`sheets:spreadsheet:create`、`sheets:spreadsheet:write_only`，实际缺权以发布脚本报错为准。
只有最终机械校验通过且本次同步开启时才发布；持久化开关表达额外同步意图，用户取消后不继续发布。图文与同名附表建在个人空间，不共享。
正文或必需输入不存在、不可读、版本变化或与通过结果不匹配时，在调用 CLI 前拒绝发布；修改或重新组装后须重新 check。
发布从同一输入视图生成计划和登记副本，XML、附表与上传图片核对副本摘要；写入前或续跑发现源输入/副本变化就停止，保留 pending 与已有链接。
关闭同步不调用 CLI。发布失败保留 Markdown，已有链接如实回报。
每段默认 400 秒，正常 incomplete 分段可有限续跑；pending 结果不确定时停止，不能自动重放。
仅人工核对后可用 --resume --skip-uncertain 或 --retry-uncertain，已有资源 id 禁止再次创建。
本轮假 CLI 测试验证的是跳过/失败收录与防重放，不代表真实飞书发布成功。

## 从 0.3.0 / 0.3.1 更新到 0.3.2

更新同一市场和插件，重启客户端并新开会话即可加载 0.3.2 的共同 Skill；Codex 更新命令见下文。
旧 Codex Skill 路径保留同内容兼容投影，清单改为直接加载根目录共同 Skill；旧脚本参数和原 Codex 收据继续可用，
没有自动把旧直接脚本运行标成已绑定。新报告按共同 Skill 先 verify，已开始的运行保留原包、收据和参数续跑。
完整旧 Codex 身份续跑升级时记录已知旧版本与待提交版本，磁盘错误后可按原参数重试；原有效草稿仍可用冻结输出离线收录。
升级记录丢失、损坏或偏离已知版本时停止，不删除它来强行放行。
同一运行目录只启动一名执行者；收到升级竞争提示时，等另一进程结束后用原参数续跑。
Claude 0.3.1 的 report_output 下拉不迁成自动同步；要同步须打开 feishu_output 一次，新会话生效。
WorkBuddy 与手工接入使用本宿主偏好/成对连接，不能拷另一客户端含凭据的连接文件来“完成迁移”。

## 从 0.2.x 迁移

插件/市场改为 `strategic-analytics@strategic`，工具改为 `strategic_` 前缀（旧名不设别名）。
GitHub 新仓库 `ccchenhuohuo/strategic-plugin`，旧地址自动跳转；网关仍为 `/flywheel/mcp`。
旧安装需卸载重装；无需依次经历 0.3 内部迭代。

Codex：

```bash
codex plugin remove flywheel-analytics@flywheel
codex plugin marketplace remove flywheel
codex mcp remove flywheel
codex plugin marketplace add ccchenhuohuo/strategic-plugin
codex plugin add strategic-analytics@strategic
codex mcp get strategic --json
```

未配置过用户级 flywheel 时 remove 的“未配置”提示可继续。先将启动环境中的认证变量改为
`STRATEGIC_MCP_TOKEN`，重启客户端并新建会话；旧变量无法认证新 Codex MCP。
0.3.2 已包含原生季报和 setup。

Claude Code：

```text
/plugin uninstall flywheel-analytics@flywheel
/plugin marketplace remove flywheel
/plugin marketplace add ccchenhuohuo/strategic-plugin
/plugin install strategic-analytics@strategic
/plugin configure strategic-analytics@strategic
```

在配置框重新填访问令牌并新开会话；新版 Claude 配置无需环境变量。

## 连接验证与更新

查看客户端 MCP 状态（可用 `/mcp`），然后要求调用 `strategic_data_status` 查看当前数据范围和水位。
`codex mcp get` 仅验证配置，auth_status 的 Unknown/unsupported 不单独证明令牌失效。
若失败，核对 MCP 是否唯一、Codex 进程是否继承同名环境令牌、Claude 配置是否已填写，以及实际网络连通。
MCP 不可用时停止取数，不用缓存、记忆或其他源替代。

Codex 更新/卸载：

```bash
codex plugin marketplace upgrade strategic
codex plugin add strategic-analytics@strategic
```

```bash
codex plugin remove strategic-analytics@strategic
codex plugin marketplace remove strategic
```

Git 市场用 upgrade；本地市场自行更新源码。不同 CODEX_HOME 资料各自安装，更新后重启并新建会话。
卸载不会清掉手工用户级 MCP；需要时另执行 `codex mcp remove strategic`。

Claude 更新：`/plugin marketplace update strategic`、`/plugin update strategic-analytics@strategic`；
卸载：`/plugin uninstall strategic-analytics@strategic`、`/plugin marketplace remove strategic`。

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

- 电商为月度匹配子集估算，不是 GMV/实付/订单数；实际水位与代次以 data_status 为准。
- 跨站点金额用 release 冻结的 CNY 汇率快照；本币不跨站点相加。
- 不预测，不写进入/退出、定价、预算类经营建议；数学贡献不是因果。
- 商品身份不是 SKU 总数、在售链接数或 SPU；出货不是电商销量，行业链不混算。
- 固定价格带，不支持自定义 SQL、周/日粒度或未纳入站点；缺失、检疫、归档不得补零。
- 同参数可复现仍可绑定的 release；SKU 明细还要求在线切片，归档会明确披露。

## 架构与分发

本仓库是插件分发树，包含安装所需的共同 Skill、角色参考、脚本、配置、清单和用户文档。受治理服务、数据构建、方法论生成器和开发测试在维护仓库中；安装插件不会部署数据库或赋予直接查询 Doris 的权限。

架构见 [ARCHITECTURE](docs/ARCHITECTURE.md)，验证事实与限制见 [0.3.2 验收范围](docs/ACCEPTANCE-0.3.2.md)。通用分析规则和季报角色分别由维护仓库的 CORE/REPORT 单一正本生成，设置入口也同源；各工作台共用同一套执行契约。

| 客户端 | 分发入口 | 执行方式 |
| --- | --- | --- |
| Codex | .codex-plugin/plugin.json，明确选择共同 Skill 和薄 setup；空 hooks 文件 | 本地 CLI/bearer 声明核对，三个命名空间 Skill，统一脚本 |
| Claude Code | .claude-plugin/plugin.json、.mcp.json 与 SessionStart hooks | userConfig 成对交接，共同 Skill；现有 Workflow 为可选优化 |
| WorkBuddy | 官方兼容的同一 .claude-plugin 包，或 MCP + 显式 Skill | 本宿主配对连接、共同角色参考和脚本；本轮未实机验证 |

每个完整包保留 .claude-plugin/、.codex-plugin/、.mcp.json、codex/、skills/、agents/、hooks/、workflows/ 和 docs/。不要漏隐藏目录或只复制 SKILL.md；references/scripts/config 是执行依赖。

```bash
node "/实际包根/skills/quarterly-report/scripts/report.mjs" --help
```

两份清单的名称、版本及服务端点保持一致。发布标签绑定实际分发提交；GitHub Release、README、CHANGELOG 同步更新。运行偏好和凭据在本宿主资料中，不随代码分发。0.3.2 不更新远程 MCP 或数据管线。

依据：[OpenAI 插件打包与 onboarding](https://developers.openai.com/plugins/build/plugins)、[兼容插件说明](https://developers.openai.com/plugins/guides/submit-claude-plugin)、[WorkBuddy/CodeBuddy 插件参考](https://www.codebuddy.cn/docs/cli/plugins-reference)。客户端兼容范围以本版验收记录为准。
