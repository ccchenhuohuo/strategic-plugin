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

## 怎么运行

```
/strategic-analytics:quarterly-report current_start=2026-01 current_end=2026-04 label=26Q1
```

| 参数 | 说明 |
|---|---|
| `current_start` / `current_end` | 当期窗口，连续完整月，最长 12 个月，不得超过水位月（先看 `strategic_data_status`） |
| `label` | 报告期标签（字母数字，如 `26Q1`）。正文一律写成「标签（实际月份）」，如「26Q1（1-4月）」，月份按窗口实际生成 |
| `config` | 报告配置，缺省为本 Skill 的 `config/vijim-default.json`（站点、公司品牌、重点类目与分段路径） |
| `out` | 输出目录，缺省为 `/tmp/flywheel-report/<label>-<release 短码>`；报告草稿属于待审产物，不直接写进文档库 |
| `release_id` | 可选。缺省绑定当前 head；复现旧报告时传入当时的 release |
| `sections` | 可选，试跑用，如 `sections=2,3` 只生成第二、三章 |

前置条件：插件配置里已填访问令牌（安装时的配置框，或在交互式 `claude` 中执行
`/plugin configure strategic-analytics@strategic`）。脚本直连服务，读不到插件配置，所以会话启动时由插件把地址与令牌
写进仅本人可读的连接文件 `${CLAUDE_PLUGIN_DATA}/connection.env`，脚本经 `--connection` 读取；改了配置要新开会话才生效。
也可以用环境变量：设置了 `STRATEGIC_MCP_URL` 时，只配对 `STRATEGIC_MCP_TOKEN`；否则若设置了
`FLYWHEEL_MCP_URL`（已弃用），只配对 `FLYWHEEL_MCP_TOKEN`，新旧两族不得混用。
没有显式环境地址时先取带令牌的连接文件；再否则取插件默认地址与环境令牌（新名优先、旧名已弃用）。
脚本也可以单独运行：`node "${CLAUDE_PLUGIN_ROOT}/skills/quarterly-report/scripts/report.mjs" prepare|charts|assemble|check|publish --help`，取数时带 `--connection "${CLAUDE_PLUGIN_DATA}/connection.env"`。

飞书输出默认关闭，只生成 Markdown。需要飞书云文档时，在交互式 `claude` 终端执行
`/plugin configure strategic-analytics@strategic`，开启「用飞书云文档输出季报」，新开会话后生效；开关与本机 lark-cli 路径记录在
`${CLAUDE_PLUGIN_DATA}/output.env`。需要本机安装 lark-cli ≥ 1.0.81 并以用户身份登录，授权 `docx:document:create`、`docx:document`、
`docs:document.media:upload`、`sheets:spreadsheet:create`、`sheets:spreadsheet:write_only`；实际缺失权限以脚本报错为准，由用户自己执行
报错中的 `lark-cli auth login --scope "…"`。开启后仅在机械校验通过时发布；lark-cli 不可用、登录失效、权限不足或发布中断时明确报错，
保留 Markdown。文档与同名附表只建在运行者的个人空间根目录，不共享；分享前人工审阅。

图表从本次证据生成，取数成功后立即与分章写作并行，组装前等待。托管环境为 `${CLAUDE_PLUGIN_DATA}/chart-env`，需要 Python 3.12/3.13；
首次创建环境会自动下载约 25 MB 的固定版本依赖，可用 `STRATEGIC_PIP_INDEX_URL` 指定包源。
也可用 `STRATEGIC_CHART_PYTHON` 指向满足锁定版本的现有解释器。环境不可用、缺中文字体或版面检测不过时跳过相应图，不阻断报告。

无头运行（`claude -p`，如日后在服务器上定时出草稿）：Workflow 在后台执行，`-p` 默认只等后台任务 600 秒，需设
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`；并预先放行 `Bash(node:*)`、`Read`、`Write`、`Grep`、`Glob`、`Workflow`
（`--allowedTools`）。

产物：`report.md`（报告）、`evidence/`（逐次原始响应）、`ledger.jsonl`（证据账本）、`tables/`（Markdown 与结构化表格）、
`digests/`（写手摘要）、`check.json`（机械校验结果）、`charts/`（规格、图片、版面检测与索引）、
`publish/`（飞书发布计划、XML、附表内容与续跑日志）、`publish.json`（发布结果）。

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
- 机械校验（`node ${CLAUDE_PLUGIN_ROOT}/skills/quarterly-report/scripts/report.mjs check`）：
  1. 骨架完整：manifest 里每张表、每个叙述位、每个下钻位都已填充；
  2. 数字溯源：叙述里的每个数字都必须等于该叙述位摘要里某个 `*_display` 值（带符号的要同号），期标签、月份与名次除外；
  3. 禁用词：经营建议与因果词（见洞察纪律 1、3、4）；
  4. 一致性：全部证据同一 `release_id`；数据说明包含全部必需警示。
- 语义核查（核查 Agent）：方向词与数字符号一致、比较关系成立、没有把新进当增长、份额口径写明、均价解读符合纪律 4、
  缺失与状态没有被说成 0。
- 图表版面检测是出图门禁：实际绘制的文字不得压气泡、互压、被参考线或其他标签引线穿过、越出坐标区或图片边界；
  气泡上的名次编号按约定豁免压球检测。布局策略全部失败的图被拒绝，不进入报告。
- **图表不阻断报告**：拒绝、跳过与绘制失败写入校验警告；报告已引用的图片文件缺失才是机械校验阻断项。
- 校验不过的叙述位退回写手重写一次；仍不过就在报告里保留标记，交人工处理，不静默放行。
