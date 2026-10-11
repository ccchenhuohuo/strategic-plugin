// Native Codex connection receipts contain declarations and output preferences only.
// The CLI invocation reads local configuration; it never initializes an MCP client.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mcpTokens } from './environment.mjs';
import { validatePortableDirectory } from './common.mjs';

const exec = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const absolute = (value) => typeof value === 'string' && value.trim() === value && isAbsolute(value) && !/[\x00-\x1f\x7f]/u.test(value);

export function nativeEndpoint(value, env = process.env) {
  let parsed;
  try {
    parsed = typeof value === 'string' && value.trim() === value && !/[\x00-\x20\x7f]/u.test(value) ? new URL(value) : null;
    let decoded = value;
    for (let depth = 0; depth < 5; depth++) {
      const next = decodeURIComponent(decoded), pathname = new URL(next).pathname;
      if (/[\x00-\x20\x7f?#]/u.test(next) || mcpTokens(env).some((token) => next.includes(token))
        || /(?:token|secret|password|api[-_]?key|authorization|bearer)[=:/_-]|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/iu.test(pathname)) throw new Error('unsafe');
      if (next === decoded) break;
      decoded = next;
      if (depth === 4) throw new Error('over-encoded');
    }
  } catch { parsed = null; }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
    || /[?#]/u.test(value) || mcpTokens(env).some((token) => value.includes(token)))
    throw new Error('Codex MCP 地址须为无认证、查询参数、片段或可疑秘密的 http(s) URL');
  return parsed.href;
}

export function matchNativeEnvironment(endpoint, env = process.env) {
  if (env.STRATEGIC_MCP_URL !== undefined && nativeEndpoint(env.STRATEGIC_MCP_URL, env) !== endpoint)
    throw new Error('STRATEGIC_MCP_URL 与 Codex 当前 strategic MCP 地址不一致；已拒绝取数');
}

export async function readNativeDeclaration(env = process.env) {
  // This process needs local configuration paths, never either MCP token family.
  const cliEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|HOME|CODEX_HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA)$/iu.test(key)));
  let stdout;
  try { ({ stdout } = await exec('codex', ['mcp', 'get', 'strategic', '--json'], { env: cliEnv, timeout: 15_000, maxBuffer: 1024 * 1024 })); }
  catch { throw new Error('无法通过本地 Codex CLI 读取 strategic MCP 配置；请安装 CLI 并启用插件后重试'); }
  let config;
  try { config = JSON.parse(stdout); } catch { throw new Error('本地 Codex CLI 返回的 strategic MCP 配置不是有效 JSON'); }
  if (!plain(config) || config.name !== 'strategic' || config.enabled !== true || config.disabled_reason)
    throw new Error('Codex 当前 strategic MCP 未启用或配置无效');
  const transport = config.transport;
  const accepted = ['type', 'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'http_headers_helper'];
  if (!plain(transport) || Object.keys(transport).some((key) => !accepted.includes(key))
    || !['streamable_http', 'http'].includes(transport.type) || transport.bearer_token_env_var !== 'STRATEGIC_MCP_TOKEN'
    || ['http_headers', 'env_http_headers', 'http_headers_helper'].some((key) => transport[key] !== undefined && transport[key] !== null))
    throw new Error('Codex strategic MCP 仅支持 HTTP 与 STRATEGIC_MCP_TOKEN bearer 声明，禁止其他认证或 headers');
  const endpoint = nativeEndpoint(transport.url, env);
  matchNativeEnvironment(endpoint, env);
  return { endpoint, auth_env: 'STRATEGIC_MCP_TOKEN' };
}

const outputText = (output) => `feishu=${output.feishu_output ? 1 : 0}\nlark_cli=${output.lark_cli}\nreport_dir=${output.report_dir}\n`;
async function validateOutput(output, env) {
  if (!keys(output, ['report_dir', 'feishu_output', 'lark_cli']) || !absolute(output.report_dir) || typeof output.feishu_output !== 'boolean'
    || !(output.lark_cli === '' || absolute(output.lark_cli)) || mcpTokens(env).some((token) => JSON.stringify(output).includes(token)))
    throw new Error('Codex 绑定收据的输出偏好无效');
  await validatePortableDirectory(output.report_dir);
}
// Resolve a receipt's full parent chain. No symlink may redirect its declarations or
// output snapshot; helper returns canonical paths, including macOS /private/tmp.
async function regular(path) {
  const absolutePath = resolve(path);
  if (await realpath(absolutePath) !== absolutePath) throw new Error('Codex 绑定文件或祖先不得为符号链接');
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Codex 绑定文件须为普通文件');
  return absolutePath;
}

export async function saveNativeBinding(dataDir, declaration, output, env = process.env) {
  if (!keys(declaration, ['endpoint', 'auth_env']) || declaration.auth_env !== 'STRATEGIC_MCP_TOKEN'
    || nativeEndpoint(declaration.endpoint, env) !== declaration.endpoint) throw new Error('Codex MCP 绑定声明无效');
  await validateOutput(output, env);
  const bindings = join(await realpath(dataDir), '.bindings');
  try { const info = await lstat(bindings); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Codex 绑定目录须为普通目录'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(bindings, { mode: 0o700 }); }
  const id = randomUUID(), dir = join(bindings, id);
  await mkdir(dir, { mode: 0o700 });
  const outputEnv = join(dir, 'output.env'), bindingPath = join(dir, 'binding.json');
  const content = outputText(output);
  const receipt = { schema_version: 1, id, ...declaration, output, output_sha256: hash(content) };
  try {
    await writeFile(outputEnv, content, { flag: 'wx', mode: 0o600 });
    // Receipt is the commit marker. No previous files are overwritten.
    await writeFile(bindingPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { codex_binding: bindingPath, output_env: outputEnv };
}

export async function readNativeBinding(path, env = process.env) {
  let receipt;
  try {
    await regular(path);
    receipt = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new Error('Codex 绑定收据缺失、损坏或不是安全普通文件；请先运行 helper verify'); }
  if (!keys(receipt, ['schema_version', 'id', 'endpoint', 'auth_env', 'output', 'output_sha256']) || receipt.schema_version !== 1
    || !UUID.test(receipt.id) || basename(dirname(resolve(path))) !== receipt.id || basename(dirname(dirname(resolve(path)))) !== '.bindings' || basename(path) !== 'binding.json'
    || receipt.auth_env !== 'STRATEGIC_MCP_TOKEN' || !HEX.test(receipt.output_sha256)) throw new Error('Codex 绑定收据格式无效');
  const endpoint = nativeEndpoint(receipt.endpoint, env);
  if (endpoint !== receipt.endpoint) throw new Error('Codex 绑定收据地址非规范形式');
  await validateOutput(receipt.output, env);
  const outputEnv = join(dirname(resolve(path)), 'output.env');
  let content;
  try { await regular(outputEnv); content = await readFile(outputEnv, 'utf8'); }
  catch { throw new Error('Codex 冻结输出偏好缺失或不是安全普通文件'); }
  if (content !== outputText(receipt.output) || hash(content) !== receipt.output_sha256) throw new Error('Codex 冻结输出偏好已被修改；已拒绝运行');
  return { receipt, outputEnv, identity: { receipt: resolve(path), sha256: hash(JSON.stringify(receipt)), output_sha256: receipt.output_sha256 } };
}

export async function verifyNativeBinding(path, env = process.env) {
  const binding = await readNativeBinding(path, env);
  matchNativeEnvironment(binding.receipt.endpoint, env);
  const current = await readNativeDeclaration(env);
  if (current.endpoint !== binding.receipt.endpoint || current.auth_env !== binding.receipt.auth_env)
    throw new Error('Codex 当前 MCP 绑定与本次收据不一致；请重新 verify 并开始新运行');
  return binding;
}

export { boundOutput } from './output-binding.mjs';
