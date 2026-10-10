#!/usr/bin/env node
// Portable setup reuses the local preference helper, never a host config reader.
import { runLocalSetup } from './codex.mjs';
import { redact } from './lib/common.mjs';
import { pairedConnection, portableHost, savePortableBinding, validatePortableDirectory } from './lib/portable-binding.mjs';
import { captureHookOutput } from './lib/portable-output.mjs';

const HELP = `用法：
  node setup.mjs show --host claude|workbuddy|manual --data-dir DIR
  node setup.mjs configure --host HOST --data-dir DIR [--report-dir DIR] [--feishu-output true|false]
  node setup.mjs verify --host HOST --data-dir DIR [--connection FILE] [--output-env FILE]
路径从已加载 Skill 定位；data-dir 必须显式给出，不能借用另一宿主的配置。
verify 仅验证显式 connection.env（本人 0600 普通文件）或成对 STRATEGIC_MCP_URL + STRATEGIC_MCP_TOKEN。
不猜默认地址、不读客户端配置、不联网、不调用模型/飞书。结果只声明“配对连接已验证”，服务认证另用实际工具核对。
--output-env 可导入本宿主钩子写出的输出偏好；verify 冻结副本，不改变现行偏好。
返回 portable_binding 与冻结 output_env，prepare 显式传 --portable-binding；续跑核对同源连接和原身份。
Codex 请用 codex.mjs verify，保留本地 CLI/bearer 的严格校验。
show/configure 只存报告目录/同步偏好，不持久化令牌。codebuddy 仅作为 workbuddy 的接入别名。
Node >=18；图表 Python、飞书 lark-cli 为可选依赖。`;

try {
  await runLocalSetup({
    help: HELP,
    options: { host: { type: 'string' }, connection: { type: 'string' }, 'output-env': { type: 'string' } },
    validateArgs(command, values) {
      portableHost(values.host);
      if (!values['data-dir']) throw new Error('通用 setup 须显式提供本宿主的 --data-dir');
      if (command !== 'verify' && (values.connection || values['output-env'])) throw new Error('--connection/--output-env 仅用于 verify');
    },
    async validatePreferences(preferences, dataDir) {
      await validatePortableDirectory(dataDir);
      await validatePortableDirectory(preferences.report_dir);
    },
    declaration: (values) => pairedConnection({ connectionPath: values.connection }),
    captureOutput: (values, connection) => values['output-env'] ? captureHookOutput(values['output-env'], connection.token) : null,
    async saveBinding(dataDir, connection, output, values) {
      return { ...await savePortableBinding(dataDir, values.host, connection, output), ...output, feishu: output.feishu_output ? 1 : 0 };
    },
    connection: (declaration, values) => ({ verified: Boolean(declaration), verification_scope: declaration ? 'paired_connection' : null,
      host: portableHost(values.host), host_mcp_config_verified: false, ...(declaration ? { url: declaration.url, source: declaration.source.type, token_present: true } : {}) }),
  });
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: redact(error.message ?? String(error)) }));
  process.exitCode = 1;
}
