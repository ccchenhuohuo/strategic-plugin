---
name: strategic-setup
description: 设置战略大盘插件的 Codex 本地报告目录和飞书同步偏好，核对 MCP 连接、环境认证及季报准备状态。用户安装后要求验证连接、调整报告收录位置或打开/关闭飞书同步时使用。
---

<!-- 由 methodology/CODEX.md 生成，请勿手改。 -->

# 战略大盘插件的 Codex 设置

先从本次已加载 SKILL.md 的真实绝对路径取包根：该文件位于 `<包根>/codex/skills/strategic-setup/SKILL.md`，包根是其父目录的上三级。解析实际文件位置（包括符号链接），不要猜安装版本、缓存目录或当前 cwd，也不依赖 shell 里的插件根变量。将 `<包根>/skills/quarterly-report/scripts/codex.mjs` 的绝对路径记为 `CODEX_HELPER`；下面命令中的变量必须先用该真实路径赋值，所有路径参数单独引用。

1. 运行 `node "$CODEX_HELPER" show`。它只准备 Codex 数据目录、runs、chart-env 和偏好输出，发现 lark-cli 可执行路径，不运行 lark-cli、不联网。用 JSON 回报报告目录、同步开关和 CLI 是否发现；show/configure 只处理偏好，不能证明 MCP 绑定或服务连通。
2. 每次生成报告前运行 `node "$CODEX_HELPER" verify`。它依赖本机可执行的 Codex CLI，只在本地执行 `codex mcp get strategic --json`，在进程内白名单解析默认本地 CLI 的 MCP 声明，不调用 MCP 或模型，不回显原始配置、headers 或凭据。仅接受已启用的 HTTP 服务和 `bearer_token_env_var=STRATEGIC_MCP_TOKEN`；缺 CLI、配置损坏、不同认证方式或 URL 含认证/可疑秘密均失败关闭。`STRATEGIC_MCP_URL` 如已设置，须与实际端点一致；不一致时发送请求前拒绝，旧 FLYWHEEL 族不影响原生流程。成功返回非敏感 codex_binding 收据及本次冻结的 output_env、runs_dir、chart_env、config。随后通过已安装插件的 `strategic_data_status` 验证服务；verify 成功仅证明默认本地 CLI 绑定；父会话临时 profile/-c 不会自动继承，须显式使本地声明与当前会话一致后才接入，不宣称已验证当前宿主配置。实际工具调用失败就停止取数。
3. Codex MCP 和脚本认证都来自客户端进程继承的 `STRATEGIC_MCP_TOKEN`。让用户在其终端/启动环境自行设置秘密；不要求在对话里提供令牌，不把值放进命令示例、偏好或报告。CLI 应从已设置变量的终端启动；桌面/IDE 进程可能没有继承，改环境后需完全退出再启动并新建会话。Claude 配置和连接文件不参与。
4. 仅用户要求变更时运行 configure，例如 `node "$CODEX_HELPER" configure --report-dir "~/Documents/战略季报" --feishu-output false`；开启同步用 `--feishu-output true`。只修改用户指定的键，遗漏键保留。同步默认关闭。绝对路径和 `~`/`~/` 可用，支持中文空格；相对路径、换行、空值会报错而不修改偏好。报告目录在 collect 时才创建。
5. 默认数据目录是 `${CODEX_HOME:-~/.codex}/plugins/data/strategic-analytics-strategic`；偏好为 preferences.json（非敏感设置），`show` 返回现行 report_dir、feishu_output、feishu、lark_cli、runs_dir、chart_env、output_env、report_script、config。verify 在独立绑定目录冻结本次同步开关、收录目录及 CLI 路径；prepare 必须显式消费返回的 codex_binding，本次发布/收录只使用冻结 output_env。另一个会话 configure 只影响后续报告，不能改变进行中的报告。续跑保留原收据与参数；绑定或冻结输出被修改就停止，不复用旧证据。不执行 Claude 配置命令。
6. 飞书同步需要本机已安装并登录 lark-cli；仅“发现 CLI”不代表已登录或权限足够。持久化开关代表用户生成报告时额外同步的意图，configure 本身不会立即发布；后续报告在冻结开关开启且最终机械校验通过时同步，无需每次重复审批。用户明确取消或要求本次不发布时尊重该要求；失败仍收录 Markdown。

验收或隔离运行可给每次命令传相同的 `--data-dir "<临时绝对目录>"`，同时使用临时 HOME/CODEX_HOME；不会读取另一资料的偏好。helper 不联网、不调用模型、不发布、不改变客户端设置或钥匙串；verify 仅以 Codex CLI 读取本地配置。连接地址与令牌复用已有 resolveConnection 配对解析，端点来自已核对的默认本地 CLI 声明，不借用 Claude 配置或猜默认服务。收据只存 endpoint/auth-env 等非敏感声明，令牌只从 STRATEGIC_MCP_TOKEN 取，不写文件或参数。桌面入口与环境继承需实际 UI 验证，不以 CLI 测试宣称桌面支持已通过。
