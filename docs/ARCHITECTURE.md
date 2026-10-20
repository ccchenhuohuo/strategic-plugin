# Strategic Analytics 的共同核心

本文描述 0.3.4 的组件与契约；部署代码、绑定数据和客户端发行是三个独立状态。具体实测与未覆盖项见 [0.3.4 验收范围](ACCEPTANCE-0.3.4.md)；[0.3.3](ACCEPTANCE-0.3.3.md) 与 [0.3.2](ACCEPTANCE-0.3.2.md) 记录各自当时的事实，不自动继承为本版结果。

**发布状态：0.3.4 已正式发布。**

生产已完成 pipeline **0.16.1** / table_spec **1.6.0** 与 MCP **0.3.4** 的部署及新数据验收。2026-10-20 的生产构建发布后，经只读独立验收、库外金额复算和实际 MCP 账号测试，解除维护绑定；公网 54 项检查全部通过。当前响应采用 `direct_wide`，完整数据范围为 **2024-01～2026-09**，上游状态为 `current`，维护绑定已解除，临时生产构建开关已撤。Bearer 原地址与独立行业链保持，九个 OAuth 停用入口均返回 HTTP 410。

## 一份 package 的实际关系

```mermaid
flowchart TD
  User[用户提出分析或季报请求] --> Host[工作台主 Agent\n意图识别与调度]
  Host --> Analysis[共同分析 Skill\n自由查询与解释]
  Host --> Report[共同季报 Skill\n固定阶段和角色契约]
  Analysis --> MCP[受治理 HTTP MCP\n计算数字并返回复现戳]
  Report --> Engine[同一 report.mjs 引擎\n取数、证据、表格、门禁与恢复]
  Engine --> MCP
  Engine --> Digests[服务端展示值与观察事实生成的写作摘要]
  Digests --> Roles[写手、核查员、摘要角色\n由工作台模型执行]
  Roles --> Draft[洞察草稿]
  Draft --> Engine
  Engine --> Library[本地 Markdown、图表、索引和历史]
  Engine --> Sync[开启时额外同步飞书]
  Data[独立数据构建与发布] --> MCP
```

插件是能力分发包。它不新建常驻分析 Agent，也不在安装后后台生成季报。用户请求触发宿主主 Agent，主 Agent 加载相应 Skill；后台数据构建属于独立服务。
共同标准落在 `SKILL.md + 包内 references/scripts/config + HTTP MCP + 显式输入输出`。
各平台的原生插件清单仍有格式差异，因此保留两份小型清单；方法论、角色、业务查询计划、校验和恢复算法只有一套。

## 仓库、安装包与远程服务

| 边界 | 实际文件 | 职责 |
| --- | --- | --- |
| 开发仓库 | methodology/、tests/、docs/，根 CLAUDE.md/AGENTS.md | 维护正本、生成投影、开发和验收；根指引不是分析工作区运行指南 |
| 安装包 | .claude-plugin/、.codex-plugin/、.mcp.json、skills/、codex/、agents/、workflows/、hooks/ | 分发共同 Skill、角色参考、可执行引擎与薄客户端接入 |
| 远程工具服务 | server/ | 标准只读 HTTP MCP，14 个工具；业务计算、复现戳、代次绑定与响应级警示由服务端承担。0.3.4 仅保留 Bearer 接入（MCP OAuth 开发已停止）；响应预算为 compact catalog 16 KiB、其余工具 64 KiB，超限返回小型明确错误；品牌窗口分页每页 512 行、最多 128 页、120 秒预算 |
| 远程数据构建 | pipeline/、dagster/ | 数据层语义、断言与发布；不进入客户端季报引擎。v1.6 实现采用权威直供宽表与新版三级类目（97 条路径、7 个一级类目），来源合同按绑定代次解释、构建按显式截止月冻结；具体生效数据与生产验证见本版验收记录 |

安装插件不会把远程服务部署到用户机器，也不授予直接访问 Doris 的能力。客户端脚本只调用受治理 MCP，不重算业务数字。

## 自由战略分析

宿主主 Agent 读取 `skills/strategic-analytics/SKILL.md`，按用户问题选择标准 MCP 工具，解释响应的展示值、状态与口径。
通用分析 Skill 是自由问答指导，不是另一个常驻 Agent，也不把所有问答塞进季报骨架。
分析文本以 `methodology/CORE.md` 为正本，季报规则以 `methodology/REPORT.md` 为正本。本版两份正本及其 Skill、角色、工作区指引和 `server/src/instructions.generated.ts` 均有更新，覆盖新来源合同、参数边界、响应预算和写作纪律；投影由同一构建生成，不另维护一份手写规则。

## 季报控制与写作

季报入口统一为 `skills/quarterly-report/SKILL.md`，正本是 `methodology/REPORT.md`。固定阶段依次为：
本宿主绑定核对与取数、可选图表、分章写作与语义核查、执行摘要最后写、组装/机械校验、可选同步、始终尝试本地收录。

| 组件 | 实际文件 | 承担的工作 |
| --- | --- | --- |
| 控制契约 | quarterly-report/SKILL.md | 固定阶段、输入/输出路径、有限修订与续跑、异常收尾；宿主按能力调度 |
| 非确定性角色 | references/writer.md、summary.md、verifier.md | 写章节、后写摘要、对照摘要核查；数字原样引用服务端 *_display，不计算、不生成表格 |
| 确定性引擎 | scripts/report.mjs、lib/plan.mjs、tables.mjs、artifacts.mjs、check.mjs、source-contract.mjs、writing-observations.mjs | 固定查询计划、证据账本、骨架、摘要、表格、组装、机械门禁；source-contract 按绑定代次判定来源合同，writing-observations 生成写作摘要的 observations 投影与摘要数字白名单。0.3.4 默认重点章为支撑类、灯光类、音视频类三章，全球市场分母仍覆盖全部受治理范围；每份写作摘要预算 32 KiB，超限失败关闭 |
| 身份、输入与发布绑定 | lib/run-binding.mjs、output-binding.mjs、input-view.mjs、check-binding.mjs、publish.mjs | 原运行身份、冻结输出、一次材料视图、正文/输入版本、发布计划与副本；变更后旧通过及旧链接不能归给新稿 |
| 收录与恢复 | lib/collect.mjs | 报告/图表、索引、历史、journal 与 EIO 恢复；保留原运行与用户文件 |
| 可选输出 | lib/charts.mjs、scripts/charts/、lib/publish.mjs | 锁定 Python 绘图与版面门禁；已登录 lark-cli 的个人空间同步 |

这里的 Workflow 是“固定控制流程 + 模型角色”，不是一个全确定性的 Agent。
`report.mjs` 的计划、服务端数字搬运、文件组装和机械校验是确定性部分；洞察选择、措辞与语义核查依赖模型，机械门禁也不能代替语义审阅。
没有协作能力时同会话按相同角色参考顺序完成，注明自查；有协作能力才委派实际独立角色，并报告未核查组。
没有增加 Agent runtime、服务器或客户端算术。

自由分析与季报角色的边界如下：

| 执行者 | 触发与输入 | 工具权限和产物 |
| --- | --- | --- |
| 宿主主 Agent：自由分析 | 用户临时问题 + 分析 Skill | 选择受治理 MCP，解释已有数字；可沿问题追查，不必生成季报 |
| 宿主主 Agent：季报控制者 | 季报意图 + 共同季报 Skill | 调用脚本、安排角色、有限修订和异常收尾，不自己重算业务数字 |
| report-runner 兼容 Agent | Claude 可选 Workflow 中的脚本阶段 | 执行同一引擎，保存证据；通用路径由主 Agent 直接做这项工作 |
| 章节写手 | 引擎产出的分章摘要、角色参考 | 写洞察文本，不调业务工具、不生成表格、不计算数字 |
| 语义核查员 | 相同摘要 + 写手草稿 | 审口径、来源和推断，返回问题；独立执行能力由宿主提供 |
| 摘要写手 | 先读对应 exec digest，再读已核查的章节成稿以把握重点 | 最后写执行摘要；数字只取对应 exec digest 的服务端展示值，不从正文抄取或重算 |

`agents/report-*.md` 是这些角色在 Claude 插件中的同源表示，不是四套业务引擎。其他宿主使用 references 的相同约束，不需要识别 Claude 的 Agent frontmatter 或模型别名。

## 小型接入与冻结

`scripts/codex.mjs` 保留严格路径：通过本地 `codex mcp get strategic --json` 白名单核对实际选择的 HTTP/bearer 声明，
`lib/codex-binding.mjs` 保存原 schema 的无明文凭据收据与本次输出。缺 CLI、绑定不符等情况失败关闭。

`scripts/setup.mjs` 复用 codex.mjs 的本地偏好实现，`lib/portable-binding.mjs` 只核对显式宿主数据路径和配对连接；
`portable-output.mjs` 可导入本宿主钩子的非敏感输出。它不读取客户端配置、不联网、不调用模型或飞书。
显式安全 connection.env 优先且不被环境覆盖；否则必须成对提供 STRATEGIC_MCP_URL/TOKEN，不猜默认地址或借用配置。
收据只保存端点、来源、凭据摘要、输出与完整性摘要，令牌只从原环境或原连接文件在进程内读取。

通用结果是 `paired_connection`、`host_mcp_config_verified=false`，只证明配对声明安全有效；Codex 结果才证明实际宿主配置被读取核对。
两者都不能代替实际工具认证与服务连通测试。摘要保证本地材料一致性，不是抵御同用户恶意进程重写全部记录的信任根。

prepare 显式消费 codex_binding 或 portable_binding。续跑核对原窗口/配置/收据身份以及原连接来源；
保留既有 status 的钉住代次合法性复查，其余已完成证据复用，只补缺失/失败调用。
Codex 与通用运行的 manifest 都保留与 run-args 相同的绑定标记；共享 run-binding 门禁在请求和输出前交叉核对，原身份缺失时拒绝降级为旧未绑定输出。
collect/publish（含直接 API）核对本次冻结 output_env，离线收录无需仍持有令牌。
两种绑定运行的同步都只使用冻结 lark-cli 路径；改变现行偏好只影响后续报告。
旧脚本 CLI、旧 Codex 收据和完整旧运行身份保留兼容；不能因为身份文件缺失就推断是旧未绑定运行，也不会把旧直接脚本运行冒称已验证。
导入钩子输出先捕获并验证，verify 只创建本次独立副本，不覆盖源 output.env。
旧绑定记录升级有先写恢复记录的有限协议：只接受准确的旧、待提交、已提交身份摘要与对应镜像；报告镜像原子写入，输出读取不改写原稿。
升级中断后仍可离线收录已有草稿或续跑，恢复记录偏离已知状态则失败关闭，不能把不一致视为普通旧记录。
升级记录以完整暂存文件原子创建且不覆盖现有目标，竞争写入者在 pending 身份写入前停止，避免不同升级 id 相互覆盖。同一运行的取数与写作仍由一名执行者完成。
升级摘要完成后作为不可变出处保留，迟到的已知 pending 版本仍可恢复；没有额外锁清理或凭据持久化。

## 三个客户端的入口

| 客户端 | 包入口 | 季报入口与差异 |
| --- | --- | --- |
| Codex | .codex-plugin/plugin.json 逐目录选择共同分析/季报 Skill 和 codex 下薄 setup | 严格 CLI/bearer；显式空 codex/hooks.json；同一 Skill 顺序执行或协作 |
| Claude Code | 既有 .claude-plugin、.mcp.json、skills/ 与 SessionStart hooks | userConfig 钩子交接 connection/output；Workflow 实际可用时为可选优化 |
| WorkBuddy | 官方兼容路径使用同一 .claude-plugin 包和共同 Skill；无插件入口时标准 MCP + 显式 Skill | 通用显式配对；不新增 manifest、不推断本项目 Workflow API；本轮按用户要求只交付引导 |

`codex/skills/quarterly-report/` 只保留同内容旧路径兼容投影，当前清单直接加载根目录共同文件；角色也来自同一 REPORT 正本。
`agents/report-*.md` 为 Claude 同源兼容投影，`workflows/quarterly-report.js` 保留原有限恢复、防重放与 finally 门禁。
CodeBuddy 是 setup 的小型接入别名，CLI 结果不能冒充 WorkBuddy GUI。

给分析工作区的运行指引为生成的 `methodology/dist/AGENTS.md` / `CLAUDE.md`，从 CORE 与 REPORT 共同生成。
宿主不自动加载时显式读取；不宣称小写单数 agent.md 在三个客户端自动生效。
手工接入必须保留完整 Skill 所在包的 references/scripts/config，脚本从实际已加载 Skill 文件定位，不猜安装缓存。

## 验收界限

本轮已完成真实开发库构建、独立验收、确认丢失恢复演练、金额库外复算及完整季报；生产首轮接线验证与新数据生产验收分开记录，具体结果见[本版验收范围](ACCEPTANCE-0.3.4.md)。开发环境成功不证明生产数据已放行，代码版本也不能代替数据绑定状态。

Codex 实际安装、真人模型会话、原生宿主绑定、合成 HTTP 认证、真实服务查询、图表、故障注入和本地收录分别记录。本轮真实季报通过 unbound 兼容入口验证引擎与角色，不冒称新入口的原生宿主或 Workflow 实机验收；三项真实 Codex CLI 用例按名称排除，WorkBuddy 桌面实机及真实钥匙串不在本轮通过范围。

图表未生成、同会话自查、未核查组、同步关闭或失败均需披露；本轮报告只临时本地收录，未新建或共享真实飞书业务文档。
