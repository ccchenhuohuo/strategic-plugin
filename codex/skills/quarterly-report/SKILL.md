---
name: quarterly-report
description: 用受治理工具生成战略季报（CMI 全球市场洞察）：按固定骨架取数、分章写市场洞察、写执行摘要并做数字溯源与完整性校验。只写战略洞察，不写经营建议或战略规划。用户要求生成季报、季度市场洞察报告、刷新季报数据或核对季报数字时使用。
---

<!-- 本文件由方法论正本生成（内部仓库 methodology/REPORT.md），请勿手改。 -->

# 战略季报框架（战略洞察）

## 定位

战略组的分析工作分两段：

- **战略洞察**：市场发生了什么、结构怎么变、变化集中在哪里。由本流程在取数后产出。
- **战略规划**：做什么产品、投多少预算、进入或退出哪个市场、怎么定价。它依赖公司内部的产品开发能力与预算，
  **由战略组人工完成**，Agent 不写。

所以季报**只写洞察**：不设「动作建议」「行动对策」栏，也不在正文里夹带经营建议。

数据全部来自 受治理工具：脚本按固定骨架直接调用 MCP，把每次响应连同 `query_id`、`release_id` 落进证据账本；
写手只读脚本生成的摘要，不调工具、不算数。表格由脚本从响应确定性生成，写手只写叙述。

## 共同入口与绑定

用户可直接要求“生成 26Q1 季报，当期 2026-01 至 2026-04”。三端加载同一个 quarterly-report Skill；
Claude Code 可用 `/strategic-analytics:quarterly-report`，Codex 可用 `$strategic-analytics:quarterly-report`，WorkBuddy 用自然语言入口。
参数为 current_start/current_end（连续完整月、最长 12 月）、label，以及可选 config、out、release_id、sections（2..6）。
标签必须附实际月份；out 是工作目录，最终报告另行收录。没有明确窗口时先用 strategic_data_status 的水位定锚，再与用户确定窗口。
自由战略问答由宿主主 Agent 按 strategic-analytics Skill 选 MCP 工具；以下写作角色只在本次季报阶段使用，不是常驻分析 Agent。

先读取 strategic-analytics Skill 的通用纪律。从本次已加载 SKILL.md 的真实绝对位置（解析符号链接）定位文件：
共同入口 `<包根>/skills/quarterly-report/SKILL.md` 旁的 `scripts/report.mjs`、`scripts/setup.mjs`、`scripts/codex.mjs` 即实际脚本。
旧安装兼容投影 `<包根>/codex/skills/quarterly-report/SKILL.md` 的父目录上三级为包根，再读同一 scripts 目录。
只根据实际已加载文件及包内存在文件定位，不猜缓存版本、不依赖 cwd 或插件环境变量。
将三个脚本的真实绝对路径分别赋给 REPORT_SCRIPT、SETUP_HELPER、CODEX_HELPER；路径与参数单独引用。
默认配置在共同 Skill 的 `config/vijim-default.json`，由 helper 的 config 返回。

只按本宿主选一次小型绑定入口，后续执行同一流程：

- **Codex**：每次先运行 `node "$CODEX_HELPER" verify`。它只执行本地 `codex mcp get strategic --json`，
  白名单解析当前实际配置；只接受已启用 HTTP 和 bearer_token_env_var=STRATEGIC_MCP_TOKEN。
  不读其他宿主配置、连接文件或旧 FLYWHEEL 变量。缺 CLI、损坏配置、认证不符或 URL 含秘密则停止。
  已设 STRATEGIC_MCP_URL 须与实际端点一致；令牌由客户端进程安全继承，不要求用户粘贴进对话。
  此收据声明“宿主当前 MCP 配置已验证”，服务认证仍需实际 strategic_data_status。
  JSON 中 codex_binding 记为 CODEX_BINDING。prepare 使用 `--codex --codex-binding "$CODEX_BINDING"`。
- **Claude Code / WorkBuddy / 手工 MCP+Skill**：运行 `node "$SETUP_HELPER" verify --host workbuddy --data-dir "$DATA_DIR"`，
  host 按实际改为 claude/workbuddy/manual，codebuddy 仅是接入别名。
  DATA_DIR 必须显式指定本宿主数据目录；会话钩子的 `STRATEGIC_PLUGIN_DATA_DIR=...` 只交接非敏感真实目录，不交接令牌或地址。
  有这条会话提示时，逐字取其目录作为 DATA_DIR，并加
  `--connection "$CONNECTION_FILE" --output-env "$HOOK_OUTPUT"`（本宿主钩子产出的 connection.env/output.env）。
  没有钩子时，只能通过安全启动环境成对提供 STRATEGIC_MCP_URL 和 STRATEGIC_MCP_TOKEN；不猜默认地址、不借用另一客户端配置。
  显式连接文件优先且不被环境覆盖，须为本人 0600 普通文件、仅含 url/token 配对；文件缺失或损坏不会回退。
  URL 只接受无认证、查询参数、片段或可疑秘密的 HTTPS（HTTP 仅供回环测试）。
  此收据仅声明“配对连接已验证”，host_mcp_config_verified=false，不宣称宿主当前 MCP 配置验收或服务连通。
  再用本宿主实际 strategic_data_status 核对服务与水位；不显示、打印或回显连接文件、令牌。
  JSON 中 portable_binding 记为 PORTABLE_BINDING。prepare 使用 `--portable-binding "$PORTABLE_BINDING"`。

两种 helper 都返回 runs_dir、chart_env、output_env、config，分别记为 RUNS_DIR、CHART_ENV、OUTPUT_ENV、REPORT_CONFIG。
本次收据和 output.env 冻结同步开关、报告目录及 CLI 路径；通用收据仅保存非敏感来源声明与摘要，不保存明文凭据。
show/configure 只处理非敏感偏好，不能证明连接；另一会话 configure 不改变本次冻结输出。
通用 helper 的 configure 同样必须显式传 --host/--data-dir。导入钩子偏好时仅冻结本次副本，不改现行偏好。
图表与 lark-cli 为可选依赖，未绘图、未核查、未同步必须如实披露。
续跑和输出共同核对 run-args 与 manifest 的绑定身份；字段丢失、身份不一致、混用模式或遗漏原绑定参数时停止。
尚未生成 manifest 的初次中断可凭原 run-args 与收据续跑，已完成的绑定运行不得删除 manifest 后降级。
两种绑定的同步都只用收据冻结的 lark_cli，缺失或不可执行即停止；本地收录只需原身份与冻结文件，不需令牌或服务连通。
旧完整 Codex 身份与收据仍可继续；旧未绑定兼容须有完整历史 run-args，只有未标记的 manifest 或身份文件缺失不能证明未绑定。
同一 RUN_DIR 的取数和写作只由一名执行者完成，不并发启动多个 prepare/resume。升级记录竞争时停止，等待另一进程完成后按原参数续跑；不删除恢复记录来放行。
旧身份升级的摘要记录完成后保留为不可变出处，迟到的已知版本仍可恢复；它不包含令牌，不需手动清理。

## 固定执行流程

1. **绑定与取数**：完成上述本宿主 verify 和实际工具核对，再运行共同脚本：

   ```bash
   node "$REPORT_SCRIPT" prepare --portable-binding "$PORTABLE_BINDING" --current-start 2026-01 --current-end 2026-04 --label 26Q1 --config "$REPORT_CONFIG" --runs-dir "$RUNS_DIR"
   ```

   Codex 将绑定参数替换为 `prepare --codex --codex-binding "$CODEX_BINDING"`，其他阶段完全相同。
   日期/标签替换为用户输入，可追加 --out、--release-id、--sections；绑定参数必须保留（含续跑）。
   新共同入口没有收据不取数；旧脚本直接 --connection/环境/默认地址的 CLI 保持兼容，但不代表已验证绑定，不是新 Skill 的入口。
   请求前再次核对原连接来源、收据和冻结输出；通用来源或令牌变化、Codex 实际 MCP 声明变化时停止，不沿用旧证据。
   记录最后一行 JSON 的 run_dir（RUN_DIR）、output_env、release_id、writer_groups、errors。
   固定计划产出证据、表格与摘要；部分取数失败不得补数，没有 manifest 就停止并回报错误。
   被中断没有 JSON 时，只在 stderr 给出了 RUN_DIR 且有 run-args.json 时，以原参数加 --resume --out 原运行目录续跑，最多 5 次。
   续跑必须与原窗口、配置、绑定身份一致，复用已完成 evidence；不用 --force 清空证据。
   每条命令等待至完成，可分段轮询，不能后台启动后离开。
2. **图表与分章**：运行 `node "$REPORT_SCRIPT" charts --run-dir "$RUN_DIR" --env-dir "$CHART_ENV"`。
   有协作能力时可与分章并行；没有协作能力就顺序执行。首次环境安装会下载锁定依赖（Python 3.12/3.13），
   可指定 STRATEGIC_CHART_PYTHON 使用现有解释器。失败或版面门禁拒绝只记警告；assemble 前必须等待出图结束。
   按 writer_groups 中非 summary 的各组逐一读取 digests、写入对应 drafts，角色指导见本 Skill 的
   [references/writer.md](references/writer.md)。写手只读摘要、只写叙述，不调工具、不计算、不生成表格。
   可以委派可用协作者，每个委派明确本组输入/输出文件与同源角色指导；无法委派时本会话承担同一角色。
3. **语义核查和有限修订**：逐组按 [references/verifier.md](references/verifier.md) 对照摘要检查数字、方向、比较、状态和口径。
   保存核查问题到运行目录的 review.json，记录各组问题、修订与是否实际完成核查；不得把未核查写成通过。
   有问题的组只定向重写一次，再核查；持续问题保留标记并在交付里列出，不无限重试。
4. **执行摘要最后写**：所有章节完成后按 [references/summary.md](references/summary.md) 读取 summary 组 digests 和章节成稿，
   写 exec.* drafts。摘要数字只能取自己的摘要文件，不从章节成稿抄取；同样做语义核查、至多重写一次。
5. **组装和机械校验**：`node "$REPORT_SCRIPT" assemble --run-dir "$RUN_DIR"` 后运行
   `node "$REPORT_SCRIPT" check --run-dir "$RUN_DIR"`。以退出码和最后一行 JSON 为准，不能宣称语义核查能替代机械门禁。
   按 blocking 中具体叙述位定向修订（同一位合计只重写一次），有改动就再 assemble/check。
   持续阻断保留原草稿与标记，禁止同步到飞书。从第一次 assemble 开始用 finally 等效收尾包住组装、check、修订与发布；
   即使组装已写 report.md 但丢失响应、check/重写抛错或发布中断，只要有草稿就尝试收录。没有报告时保留原失败，不能冒称收录成功。
6. **可选同步**：本次冻结 output.env 中 feishu=1 且最终机械校验通过时，执行
   `node "$REPORT_SCRIPT" publish --run-dir "$RUN_DIR" --output-env "$OUTPUT_ENV"`；尚未实际完成语义核查的组传 --unverified 组 id。
   不直接运行 lark-cli，不共享、不改权限。单次默认预算 400 秒，外层总时限至少 600 秒。
   只对 incomplete=true 或外层中断且无最终 JSON，以同命令加 --resume 续跑，总计最多 7 次；
   其他错误停止同步。pending 表示结果不确定，禁止自动传 --retry-uncertain/--skip-uncertain，仅人工核对后处理。
   已有资源 id 禁止再次创建。持久化开关代表生成报告时额外同步的意图，configure 不会立即发布，也不增加每次重复审批。
   用户取消后停止，不再尝试真实发布或续跑；用户要求本次不发布时跳过并说明。
7. **始终收录**：同步完成、未开启、失败、续跑耗尽、校验阻断或上述异常后，均尝试执行
   `node "$REPORT_SCRIPT" collect --run-dir "$RUN_DIR" --output-env "$OUTPUT_ENV"`。用 finally 等效收尾确保发布异常不跳过收录。
   最终回报本地 report/index 路径、校验阻断/警告、语义遗留与未核查组、飞书结果及已有链接。
   原异常与 library 收录结果分别回报，收录成功不能把 check/Workflow 失败改为成功；两者失败也如实保留。
   collect 失败回报实际错误与原运行目录；未确认 report.md 存在时不冒称已有报告。所有产物均为待人工审阅的草稿，不冒称正式报告或已同步。

本地报告默认 `~/Documents/战略季报`，用 strategic-setup 或 helper configure 改非敏感偏好，支持中文空格和 ~。
报告目录仅 collect 时创建；同一运行重复收录幂等，同一标签新运行归档旧版，索引如实标记校验与飞书状态。
收录先记录 journal 再移动/替换登记文件，普通 I/O 错误后保留恢复记录；下一次取锁后先恢复上一笔，再处理当前运行。
归档后先把两份索引的旧行转到历史路径，再安装新版；失败当下可读链接也必须对应原 release/run。
同 run 更新在替换正文前先撤销两份索引的旧通过与摘要，过渡状态为「未验证（收录进行中）」；有旧飞书链接时同步归属也标为待核对。恢复后状态与新正文一致，最终不新增历史。
恢复严格验证阶段、目标清单和旧/新索引期望，失败返回 ok=false；不扫描目录猜 head，不覆盖用户文件或自动清除其他进程的锁。
Codex 偏好默认在 CODEX_HOME（缺省 ~/.codex）的插件数据目录；其他宿主必须显式给出 DATA_DIR。
共同流程无需 Workflow/Agent API：没有协作能力时本会话依次承担章节写手、核查、摘要角色，必须说明是同会话自查；
只有实际独立核查才标为独立核查。具有协作能力可按共同 references 委派，不新增 Agent runtime 或服务器。
Claude 的现有 `workflows/quarterly-report.js` 与四个兼容 agents 保留为可选优化；新共同入口调用它时用结构化参数传 portable_binding、output_env、runs_dir、chart_env 四个 verify 返回的绝对路径，后续输出仍用同一冻结值。旧未绑定参数兼容保留。仅在宿主实际提供 Workflow API 时使用，
沿用其续跑、校验与 finally 收录门禁。WorkBuddy 插件目录兼容不代表具备该 API，不据 CodeBuddy CLI 成功宣称 WorkBuddy GUI 通过。
脚本子命令及续跑参数详见 `node "$REPORT_SCRIPT" --help`；证据账本、摘要、草稿、图表和发布日志留在运行目录。

共同脚本需要 Node.js ≥ 18；图表托管环境需要 Python 3.12/3.13 与中文字体，首次安装下载锁定依赖，
可用 STRATEGIC_PIP_INDEX_URL 或 STRATEGIC_CHART_PYTHON 指定环境。飞书同步另需已安装并以用户身份登录 lark-cli ≥ 1.0.81，
授权 docx:document:create、docx:document、docs:document.media:upload、sheets:spreadsheet:create、sheets:spreadsheet:write_only；
实际缺权按脚本错误由用户自行处理。报告始终是待人工审阅草稿，云文档与附表只建个人空间、不共享。

产物：report.md、evidence/、ledger.jsonl、tables/、digests/、drafts/、check.json、charts/、publish/、publish.json。
普通 I/O 收录失败保留恢复 journal；仅移登记文件、原运行与用户文件保留。只释放自身 inode/device 相同的空锁；
锁清理 EIO 最多三次，持续失败回报 collection_completed 与 lock_cleanup，不自行删除未知锁。

## 报告骨架

骨架由配置与窗口确定性生成（`manifest.json`），机械校验逐项核对：每张表都有数、每个叙述位都有字、每个下钻位都有表。

1. **数据说明**（脚本生成）：release 与复现戳、平台站点、三个窗口的实际月份、CNY 汇率快照（日期与汇率）、类目映射版本与
   路径数、价格带政策版本、估算口径、匹配子集、缺失≠零、固定汇率与跨年匹配池警示、上游陈旧状态、身份数的截断警示。
2. **一、执行摘要**：全球市场趋势（大盘、国家格局、品类方向），以及每个重点一级类目一张总结表（分段 × 全球/各站点的
   金额与同比）加「全球增长结构」「价格带迁移」两组要点。
3. **二、全球市场扫描**
   - 2.1 全球总览：分站点规模、占比、同比、环比、量与均价；Shapley 三因子（销量/结构/均价）分站点与全球各一张。
   - 2.2 类目增长：一级类目规模、占比、同比、对全球同比的贡献、均价同比；按「中位数规模 × 全球同比」分四个象限。
4. **三至六章（每个重点一级类目一章）**
   - N.1 国家与赛道趋势：一级类目分站点总表；分段 × 站点的金额与同比；全球分段表（份额、贡献、量价）；
     分站点均价的价格/结构拆分；分站点的商品身份池与同商品单位价值指数。
   - N.2 价格带变化：CNY 价格带的全球与分站点金额份额及份额变化（pp）。
   - N.3 品牌竞争格局：每个竞争切片 × 站点一张品牌表（名次、份额、pp、名次变化、公司品牌保留行、集中度）；
     A～E 为当期份额前五的具名竞品（剔除公司品牌、非品牌桶与未分类），各列 Top 5 商品；公司品牌单列 Top 商品。
5. **附录**：证据账本摘要（每张表对应的 `query_id`）与全部口径警示。

图的位置按表位固定：类目气泡图在 2.2 表之前，赛道矩阵在 N.1a 表之前，价格带图在 N.2a 表之前。
这些节按「标题 → 叙述 → 图（含题注与证据）→ 表格」排列；品牌小节按「分段-站点 h3 标题 → 品牌气泡图 → 品牌表」排列。
Markdown 以相对路径引用同一批 PNG。飞书正文放叙述、图、分析表与品牌表；A～E 竞品与公司品牌 Top 商品表、证据账本放同名附表，
各品牌表之后链接到对应分段子表，附录链接到证据账本子表。

某站点三级类目未标注（如德国、日本部分二级类目下全为「未分类」）时：趋势分段在该站点不可用，归入
「（范围内未归入分段）」并注明；竞争切片在该站点退回父级二级类目并注明。这不是无观察。

## 取数计划

| 位置 | 工具 | 关键参数 |
|---|---|---|
| 第 0 步 | `strategic_data_status` | 取 release、水位、汇率快照、映射摘要；之后每次调用显式传同一个 `release_id` |
| 2.1 | `strategic_market_growth` | 窗口模式，`metrics=[amt_discount,units_est,weighted_discount_price]`，`group_by=[site]`，`currency=cny`，`compare=[yoy,prior_period]` |
| 2.1 因子 | `strategic_market_growth` | `decompose=shapley_volume_mix_price`：分站点 `group_by=[site], mix_by=[std_l1]`；全球 `group_by=[], mix_by=[site,std_l1]` |
| 2.2 | `strategic_market_growth` | `group_by=[std_l1]`，`currency=cny`；象限参考线取响应的 `reference` |
| N.1 | `strategic_market_growth` | `filters.std_l1` + `segments`（配置里的完整路径）+ `include_remainder`；`group_by` 为 `[site]`、`[segment]`、`[segment,site]` |
| N.1 均价 | `strategic_market_growth` | `decompose=price_mix`，`group_by=[site]`，`mix_by=[std_l2]` |
| N.1 池 | `strategic_product_rank` | 每站点一次，`paths=[{std_l1}]`，`summary=true` |
| N.2 | `strategic_price_band_distribution` | 窗口模式，`profile=cny`：跨站点一次、每站点一次 |
| N.3 品牌 | `strategic_brand_view` | 窗口模式，`paths`，`top_n=10`，`include_brands=公司品牌`，`currency=cny` |
| N.3 商品 | `strategic_product_rank` | 品牌模式：A～E 一次、公司品牌一次，`top_n=5` |

所有调用都带 `display=true`，正文只引用响应里的 `*_display` 字段。

## 洞察纪律（硬性）

通用纪律以 strategic-analytics Skill 的「表达纪律」为准（估算口径、贡献非因果、缺失≠零、份额先说口径、跨站点用 CNY、
加权均价受结构影响）。季报另加以下规则：

1. **只写洞察，不写建议**。禁止任何经营处方：不写「建议」「应当/应该」「可考虑」「需要（我们/公司）」「行动」「对策」
   「打法」「布局」「抢占」「发力」「加大投入」「预算」「上新」「定价」「清库存」「下架」，也不用「我们」「我司」「本品」
   做主语。战略规划由人完成。
2. **数字只能原样引用摘要里的 `*_display` 字段**：不重新舍入、不自行加减乘除、不把两个份额相加、不从表里推算差值。
   摘要里没有的数字就不写；需要某个数字而摘要没有，写「本期未提供该口径」，不要估。
3. **不写因果**：不用「因为」「由于」「导致」「带动」「驱动」「拉动」「得益于」「源于」。写成「增量中 X 占…」
   「同比 −x% 中销量因子 −y pp」「与……同时出现」。Shapley 与价格/结构拆分是数学分解。
4. **均价不是价格**：写「均价（Σ金额/Σ件数）上行/下行」，不写「涨价/降价/调价」。解读均价变化时，先看价格/结构拆分，
   再看商品身份池：池明显收缩、新进/退出占比高时，要写明均价变化与池变化同时出现，不能直接下「升级」结论。
   同一商品的单位价值变化只能引用 `like_for_like`（Paasche 指数与分位数）。
5. **身份数的说法固定**：「匹配子集内有观察的商品身份数」（Amazon 按子 ASIN，淘系按商品 ID）。不得称为 SKU 总数、
   在售链接数或 SPU 数；引用其同比时注明服务商会截断极低销量长尾。
6. **新进不是新品，消失不是停售**：`appeared`/`entered` 只表示对照窗口在本范围无观察；`disappeared`/`exited` 同理。
   新进品牌、新进商品没有同比，不得写成「增长」或「份额提升 x pp」。
7. **期标签**：写「{标签}（实际月份）」，同比、环比窗口按摘要给出的实际月份称呼；不写「Q1 三个月」这类与窗口不符的说法。
8. **汇率**：跨站点金额是 release 冻结的单一 ECB 快照换算的 CNY，跨期增长不含汇率变动；不与使用其他汇率的旧报告逐位比较。
9. **非品牌桶不是品牌**：`OTHERS/其他` 与 `未分类` 不参与名次、不当竞品；其份额变化会带动具名品牌的份额差，写品牌份额变化时要考虑。
10. **每条要点先给结论短语，再给数据**；结论必须能被同一条里的数字支撑。允许每节至多一条「待验证：」开头的问题，
    用来标出数据无法回答、需要战略组判断的地方；它不得包含建议，也不得当结论写。
11. **缺失与状态照实写**：无观察、超出窗口、检疫、切片归档、三级未标注，各用各的说法，不补 0，不略过。

## 证据与校验

- 证据账本：每次工具调用一条记录（证据号、工具、参数、`query_id`、`release_id`、响应文件）。整份报告只能绑定一个
  `release_id`；表格下方注明证据号，附录列出全部 `query_id`。
- 机械校验（`node $REPORT_SCRIPT check`）：
  1. 骨架完整：manifest 里每张表、每个叙述位、每个下钻位都已填充；
  2. 数字溯源：叙述里的每个数字都必须等于该叙述位摘要里某个 `*_display` 值（带符号的要同号），期标签、月份与名次除外；
  3. 禁用词：经营建议与因果词（见洞察纪律 1、3、4）；
  4. 一致性：全部证据同一 `release_id`；数据说明包含全部必需警示。
  5. 输入版本：组装、数字和表达检查消费同一次捕获的材料；正文须与视图的组装结果逐字节一致，JSON 表格须用同源 renderTable 核对 Markdown。结果携带 report.md 的 SHA-256 与逐文件版本绑定（含缺失状态）；必需输入非法、缺失、不可读或校验期间变化时失败关闭，不改写正文。旧 Markdown-only 表格仍按固定兼容投影核对，JSON 缺失状态也绑定；可选图表保持跳过/缺失语义。修改后重新 assemble 和 check，不能沿用旧绑定发布。
- 语义核查（核查 Agent）：方向词与数字符号一致、比较关系成立、没有把新进当增长、份额口径写明、均价解读符合纪律 4、
  缺失与状态没有被说成 0。
- 图表版面检测是出图门禁：实际绘制的文字不得压气泡、互压、被参考线或其他标签引线穿过、越出坐标区或图片边界；
  气泡上的名次编号按约定豁免压球检测。布局策略全部失败的图被拒绝，不进入报告。
- **图表不阻断报告**：拒绝、跳过与绘制失败写入校验警告；报告已引用的图片文件缺失才是机械校验阻断项。
- 校验不过的叙述位退回写手重写一次；仍不过就在报告里保留标记，交人工处理，不静默放行。
