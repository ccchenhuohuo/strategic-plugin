# 安装与配置

本指南适用于公司内部使用 Strategic Analytics 的同事。数据访问令牌向战略组申请。
令牌通过客户端的安全配置或启动环境提供，不写入仓库、报告或普通偏好文件。

## 安装前准备

| 项目 | 要求 |
| --- | --- |
| AI 工作台 | Codex、Claude Code 或 WorkBuddy，具备插件或 MCP + Skill 接入能力 |
| 数据权限 | 战略组提供的访问令牌，以及访问数据服务的网络连接 |
| 季报运行 | Node.js ≥ 18，客户端能执行本地脚本、读写报告文件 |
| 图表 | Python 3.12/3.13 和中文字体；季报脚本会准备绘图环境，首次运行需要下载依赖 |
| 飞书同步（可选） | 本机安装 lark-cli ≥ 1.0.81，并以本人飞书账号登录 |

默认数据服务地址为 `https://voc.ulanzi.com:28081/flywheel/mcp`。无特殊通知时保持默认。
图表与飞书为可选功能；不可用时仍保留本地 Markdown，报告会注明未完成的部分。

## Codex

### 安装插件

在支持插件的 Codex CLI 环境执行：

```bash
codex plugin marketplace add ccchenhuohuo/strategic-plugin
codex plugin add strategic-analytics@strategic
```

### 配置认证

Codex 从客户端进程的 `STRATEGIC_MCP_TOKEN` 环境变量读取访问令牌。
如果从 zsh 终端启动 Codex，可在同一终端交互输入，输入不会回显：

```zsh
read -rs 'STRATEGIC_MCP_TOKEN?访问令牌（输入不回显）：'
export STRATEGIC_MCP_TOKEN
codex
```

该设置仅对当前终端及其启动的进程有效。桌面或 IDE 启动的 Codex，需通过系统安全存储与受管理的启动环境提供同名变量，
再完全退出、重新打开客户端并新建会话。只在终端设置变量不会自动更新已启动的桌面进程；初次配置可请战略组协助。
不要把令牌直接写入 `config.toml` 或插件偏好。

新会话调用 `$strategic-analytics:strategic-setup`，检查连接、调整报告目录或飞书同步偏好。
设置入口使用已安装的本机 Codex CLI 核对连接，因此桌面使用者也需要可执行的 Codex CLI。

需要核对连接声明时运行：

```bash
codex mcp get strategic --json
```

应为已启用的 HTTP MCP，认证引用 `STRATEGIC_MCP_TOKEN`。通常无需再手动添加同名 MCP。
如果曾配置过同名用户级服务，确认它属于旧配置后移除覆盖，再核对插件提供的连接。

### 开始使用

自由分析可直接提问；生成季报可调用 `$strategic-analytics:quarterly-report`，并说明报告期的实际月份。

## Claude Code

在交互式 Claude Code 中执行：

```text
/plugin marketplace add ccchenhuohuo/strategic-plugin
/plugin install strategic-analytics@strategic
/plugin configure strategic-analytics@strategic
```

在配置框填写访问令牌，服务地址保持默认。令牌使用客户端的安全存储，不要求额外设置环境变量。
配置后新开会话；后续更换令牌或调整输出设置，也通过插件配置入口完成。

生成季报时可输入：

```text
/strategic-analytics:quarterly-report current_start=2026-04 current_end=2026-06 label=26Q2
```

## WorkBuddy

按照 [WorkBuddy 官方插件说明](https://www.workbuddy.cn/docs/workbuddy/Plugins)操作：

1. 左侧进入「插件」，点击「+」添加第三方市场。
2. 市场地址填写 `https://github.com/ccchenhuohuo/strategic-plugin`。
3. 安装并启用 `strategic-analytics`，通过客户端配置入口填写令牌、服务地址和输出偏好。
4. 新开会话，先检查连接，再用自然语言请求分析或带实际月份的季报。

配置界面以使用中的 WorkBuddy 版本为准。本项目按官方规范提供接入引导，尚未完成 WorkBuddy 桌面实机季报验收。
如果当前版本无法加载完整插件或没有所需配置入口，可使用下面的 MCP + Skill 接入方式，或联系战略组协助。

## MCP + Skill 接入

适用于没有完整插件入口、但支持 HTTP MCP 和本地 Skill 的工作台。

1. 保留完整插件包，包含 `skills/` 下的 references、scripts 和 config；只复制 `SKILL.md` 不足以生成季报。
2. 用工作台原生配置方式添加名为 `strategic` 的 HTTP MCP；地址使用实际授权端点，Bearer 令牌用客户端支持的安全存储或环境引用。
3. 加载包内 `skills/strategic-analytics/SKILL.md`；生成季报时再加载 `skills/quarterly-report/SKILL.md`。
4. 如需项目指引，在工作台识别的 `AGENTS.md` 或 `CLAUDE.md` 中添加相同的 Skill 加载说明，安装路径取实际位置。

分析方法和报告流程均使用包内共同 Skill。宿主没有协作者时按相同流程顺序执行，并说明核查方式。
季报脚本的连接必须来自本工作台配置；不要借用另一工作台的连接文件。
无会话钩子的接入需通过安全启动环境成对提供 `STRATEGIC_MCP_URL` 和 `STRATEGIC_MCP_TOKEN`，再遵循季报 Skill 的设置流程。

## 连接验证

安装并新开会话后，向工作台提问：

> 检查战略大盘插件的连接，告诉我数据覆盖范围和可用月份。

以实际 `strategic_data_status` 调用成功为准。配置命令成功、CLI 路径存在或客户端显示已安装，都不能单独证明数据服务可用。
服务提示上游陈旧时，报告会保留说明；需要更新数据应联系战略组，重新安装插件不会刷新上游数据。

## 报告输出

季报默认保存到 `~/Documents/战略季报`，包含 Markdown、实际引用的图表、索引和历史版本。
可直接要求工作台修改报告目录；Codex 也可使用 `$strategic-analytics:strategic-setup`。

飞书同步默认关闭。开启步骤：

1. 安装 lark-cli，并以本人用户身份完成飞书登录。
2. 确认具备文档创建、文档编辑、素材上传及电子表格创建/写入权限。
3. 要求工作台「打开季报的飞书同步，同时保留本地 Markdown」，或在客户端插件设置中开启同步。

报告校验通过后同步为个人空间中的云文档和附表。正文包含分析、图表及市场/品牌表，商品明细和证据账本放入附表。
同步不会自动共享资源；分享前请人工审阅。同步失败仍保留本地报告和已有云端链接。

输出偏好在每次生成时固定，修改开关影响后续报告。已有季报需要补同步时，请明确指定那份报告，不要修改其原生成记录。
发布中断可按脚本提示续跑；如果提示某一步结果不确定，先核对已有云端资源，再由人工决定如何继续。

## 更新与卸载

### Codex

已从 Git 市场安装的用户更新：

```bash
codex plugin marketplace upgrade strategic
codex plugin add strategic-analytics@strategic
```

本地目录来源需先更新该目录。更新后重启客户端并新建会话。

卸载：

```bash
codex plugin remove strategic-analytics@strategic
codex plugin marketplace remove strategic
```

卸载插件不会删除手动添加的用户级 MCP；如需清理，先确认其用途再单独移除。

### Claude Code

更新：

```text
/plugin marketplace update strategic
/plugin update strategic-analytics@strategic
```

卸载：

```text
/plugin uninstall strategic-analytics@strategic
/plugin marketplace remove strategic
```

### WorkBuddy

在插件管理页面更新或卸载，操作入口以当前客户端版本为准。

### 从旧名称迁移

旧插件名为 `flywheel-analytics@flywheel`。先卸载旧插件与旧市场，再按本指南安装 `strategic-analytics@strategic` 并重新配置认证。
Codex 的令牌变量使用 `STRATEGIC_MCP_TOKEN`；旧变量不能认证新的原生插件连接。
具体版本差异见 [Release](https://github.com/ccchenhuohuo/strategic-plugin/releases/tag/v0.3.2)。

## 常见问题

| 问题 | 检查方法 |
| --- | --- |
| 已安装但无法取数 | 核对令牌及客户端进程是否已加载；配置后重启并新建会话，再实际调用数据状态工具 |
| Codex 终端能用，桌面不能用 | 检查桌面进程是否继承 `STRATEGIC_MCP_TOKEN`；请战略组协助配置安全启动环境 |
| 找不到季报入口 | 确认完整包已安装并启用、新会话已加载共同 Skill，且 Node.js 可执行 |
| 图表没有生成 | 查看报告中的警告，核对 Python、中文字体与首次依赖下载；部分图也可能被版面门禁排除 |
| 飞书没有同步 | 检查同步开关、lark-cli 登录身份与权限；查看报告索引及运行记录中的已有链接和错误 |
| 数据尚未更新 | 核对数据状态中的月份与上游时效，联系战略组处理数据更新 |

更完整的客户端验证事实见[验收范围](ACCEPTANCE-0.3.2.md)，组件分工见[插件架构](ARCHITECTURE.md)。
