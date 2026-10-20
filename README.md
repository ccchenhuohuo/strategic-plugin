# Strategic Analytics

Strategic Analytics 是由战略组开发，面向公司内部有外部市场调研需求的同事使用的插件。
通过自然语言查询市场、品牌和商品数据，生成带图表与数据引用的季度市场洞察报告。

可通过 Codex、Claude Code 和 WorkBuddy 接入，共用同一套分析方法与季报流程。

当前版本：[0.3.5](https://github.com/ccchenhuohuo/strategic-plugin/releases/tag/v0.3.5)。

生产 Bearer 入口已迁到 `/strategy/mcp`，旧 `/flywheel/mcp` 已停用且不重定向。升级插件后，请同步检查曾保存或手工配置的服务地址，原访问令牌不变。此版在保持分析能力、季报规则与安全门禁的前提下收敛重复实现，不重新发布数据。迁移步骤见[安装指南](docs/INSTALL.md#从-034-及以前迁移到-035)，实际验证及未覆盖项见 [0.3.5 验收说明](docs/ACCEPTANCE-0.3.5.md)和[更新记录](CHANGELOG.md)。

## 可以做什么

- **市场分析**：查看市场规模、增长、平台与类目结构，比较不同时间窗口。
- **竞争研究**：分析品牌份额、竞争格局、价格带与重点商品表现。
- **行业背景**：查询相机、手机出货数据，为电商市场分析提供外部参照。
- **季度洞察报告**：生成执行摘要、市场扫描和重点类目分析，附图表及数据引用。
- **报告收录与同步**：保存本地 Markdown、图表和历史版本，也可同步为飞书云文档及附表。

电商数据范围包括中国淘天及美国、德国、日本 Amazon 的已纳入类目；具体覆盖与可用月份以查询结果为准。

## 安装

安装前先向战略组申请数据访问令牌。生成季报需要本机安装 Node.js ≥ 18。
完整配置步骤见[安装指南](docs/INSTALL.md)。

### Codex

在终端执行：

```bash
codex plugin marketplace add ccchenhuohuo/strategic-plugin
codex plugin add strategic-analytics@strategic
```

通过安全启动环境向 Codex 提供 `STRATEGIC_MCP_TOKEN`，然后重启并新建会话。
首次设置可调用 `$strategic-analytics:strategic-setup`；[认证配置说明](docs/INSTALL.md#codex)。

### Claude Code

在 Claude Code 中执行：

```text
/plugin marketplace add ccchenhuohuo/strategic-plugin
/plugin install strategic-analytics@strategic
/plugin configure strategic-analytics@strategic
```

在配置框填写访问令牌，服务地址保持默认，然后新开会话。

### WorkBuddy

1. 进入左侧「插件」，点击「+」添加第三方市场。
2. 填入 `https://github.com/ccchenhuohuo/strategic-plugin`。
3. 安装并启用 `strategic-analytics`，通过客户端配置入口填写访问令牌，然后新开会话。

入口按 [WorkBuddy 官方插件说明](https://www.workbuddy.cn/docs/workbuddy/Plugins)；
不同版本的配置入口及备用接入方式见[安装指南](docs/INSTALL.md#workbuddy)。

安装后先说：

> 检查战略大盘插件的连接，告诉我数据覆盖范围和可用月份。

仅支持 OAuth 的 ChatGPT / Dot 网页连接器不在当前接入范围；MCP OAuth 开发已停止，继续使用上述 Bearer 接入。季报的飞书云文档同步不受影响。

## 开始使用

直接用自然语言描述你的调研问题，并说明平台、类目和时间范围，例如：

> 分析美国 Amazon 相机脚架最近三个完整月的市场规模、品牌份额和价格带变化。

> 生成 26Q2 市场洞察季报，报告期为 2026 年 4 月至 6 月。

> 打开季报的飞书同步，同时保留本地 Markdown。

需要显式调用季报入口时，Codex 使用 `$strategic-analytics:quarterly-report`，
Claude Code 使用 `/strategic-analytics:quarterly-report`；WorkBuddy 用自然语言触发。

季报默认收录到 `~/Documents/战略季报`，可通过设置调整。
飞书同步默认关闭，需本机安装并登录 lark-cli；配置方法见[报告输出](docs/INSTALL.md#报告输出)。

## 使用说明

- 市场金额和销量为估算，分析范围限于已纳入的平台与类目；具体时效与口径随结果披露。
- 缺失或未观察不按零处理；行业出货数据与电商销售数据分别解读。
- 季报提供战略洞察，供同事人工审阅；产品、定价、预算等经营决策由业务团队制定。

<details>
<summary>查看完整查询范围与口径边界</summary>

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

</details>

## 进一步了解

- [安装、配置、更新与故障处理](docs/INSTALL.md)
- [版本发布说明](https://github.com/ccchenhuohuo/strategic-plugin/releases) · [更新记录](CHANGELOG.md)
- [插件架构](docs/ARCHITECTURE.md)
- [0.3.5 验收范围](docs/ACCEPTANCE-0.3.5.md) · [0.3.4 数据切源验收](docs/ACCEPTANCE-0.3.4.md) · [0.3.3 历史验收](docs/ACCEPTANCE-0.3.3.md)
