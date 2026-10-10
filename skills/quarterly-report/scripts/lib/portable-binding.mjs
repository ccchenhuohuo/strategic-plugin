// Explicit source pairing and local snapshots only; never reads a host's config.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { addSecret } from './common.mjs';
import { mcpTokens } from './environment.mjs';
import { nativeEndpoint } from './codex-binding.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const absolute = (value) => typeof value === 'string' && value.trim() === value && isAbsolute(value) && !/[\x00-\x1f\x7f]/u.test(value) && resolve(value) === value;
export function portableHost(value) {
  if (value === 'codebuddy') return 'workbuddy';
  if (!['claude', 'workbuddy', 'manual'].includes(value)) throw new Error('--host 仅接受 claude、workbuddy、codebuddy（接入别名）或 manual；Codex 请使用 codex.mjs verify');
  return value;
}

export function portableEndpoint(value, env = process.env) {
  let endpoint;
  try {
    endpoint = nativeEndpoint(value, env);
    let decoded = value;
    for (let depth = 0; depth < 5; depth++) {
      const next = decodeURIComponent(decoded);
      if (/[\x00-\x20\x7f?#]/u.test(next) || mcpTokens(env).some((token) => next.includes(token))
        || /(?:token|secret|password|api[-_]?key|authorization|bearer)[=:/_-]/iu.test(new URL(next).pathname)) throw new Error('unsafe');
      if (next === decoded) break;
      decoded = next;
      if (depth === 4) throw new Error('over-encoded');
    }
  }
  catch { throw new Error('配对连接地址须为无认证、查询参数、片段或可疑秘密的安全 URL'); }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('配对连接须用 HTTPS；HTTP 仅允许本机回环测试');
  return endpoint;
}

// Report targets may be absent, but existing ancestors must be ordinary dirs.
// Only the two standard macOS OS aliases are accepted.
export async function validatePortableDirectory(path) {
  if (!absolute(path)) throw new Error('输出路径须为无控制字符的规范绝对目录');
  let current = parse(path).root;
  for (const part of relative(current, path).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) {
      const alias = { '/tmp': '/private/tmp', '/var': '/private/var' }[current];
      if (!alias || await realpath(current) !== alias) throw new Error('输出目录或祖先不得为用户符号链接');
      current = alias; info = await lstat(current);
    }
    if (!info.isDirectory()) throw new Error('输出路径或祖先已存在且不是目录');
  }
}
async function regular(path, privateFile = false) {
  if (!absolute(path) || await realpath(path) !== path) throw new Error('绑定/连接文件或祖先不得为符号链接');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (privateFile && ((info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()))))
    throw new Error('连接文件须为当前用户所有的 0600 普通文件');
}
export const osAliasPath = (path) => resolve(path).replace(/^\/tmp(?=\/)/u, '/private/tmp').replace(/^\/var(?=\/)/u, '/private/var');
export async function pairedConnection({ connectionPath = null, env = process.env } = {}) {
  let token, url, source;
  if (connectionPath) {
    // A source is explicit. Environment variables cannot override a file.
    let content;
    try {
      const path = await realpath(connectionPath);
      if (osAliasPath(connectionPath) !== path) throw new Error('alias');
      await regular(path, true);
      content = await readFile(path, 'utf8');
      const entries = content.split(/\r?\n/u).filter(Boolean).map((line) => {
        const at = line.indexOf('=');
        if (at < 1) throw new Error('format');
        return [line.slice(0, at), line.slice(at + 1)];
      });
      if (entries.length !== 2 || new Set(entries.map(([key]) => key)).size !== 2 || entries.some(([key]) => !['url', 'token'].includes(key))) throw new Error('format');
      ({ url, token } = Object.fromEntries(entries));
      source = { type: 'connection_file', path, sha256: sha(content) };
    } catch { throw new Error('显式 connection.env 缺失、不安全或损坏；须为仅含 url/token 配对的本人 0600 普通文件'); }
  } else {
    url = env.STRATEGIC_MCP_URL; token = env.STRATEGIC_MCP_TOKEN;
    source = { type: 'environment', url_env: 'STRATEGIC_MCP_URL', auth_env: 'STRATEGIC_MCP_TOKEN' };
  }
  if (typeof token === 'string' && token) addSecret(token);
  if (typeof token !== 'string' || !token || token.trim() !== token || /[\x00-\x20\x7f]/u.test(token) || !url)
    throw new Error('缺少显式成对的服务地址与令牌；不使用默认地址、旧变量或其他客户端配置');
  url = portableEndpoint(url, { ...env, STRATEGIC_MCP_TOKEN: token });
  return { url, token, source };
}
const outputText = (output) => `feishu=${output.feishu_output ? 1 : 0}\nlark_cli=${output.lark_cli}\nreport_dir=${output.report_dir}\n`;
export async function validateOutput(output, env) {
  if (!keys(output, ['report_dir', 'feishu_output', 'lark_cli']) || !absolute(output.report_dir) || typeof output.feishu_output !== 'boolean'
    || !(output.lark_cli === '' || absolute(output.lark_cli)) || mcpTokens(env).some((token) => JSON.stringify(output).includes(token)))
    throw new Error('通用绑定收据的冻结输出偏好无效');
  await validatePortableDirectory(output.report_dir);
}

export async function savePortableBinding(dataDir, host, connection, output, env = process.env) {
  host = portableHost(host);
  const secretEnv = { ...env, STRATEGIC_MCP_TOKEN: connection.token };
  const endpoint = portableEndpoint(connection.url, secretEnv);
  if (mcpTokens(secretEnv).some((token) => JSON.stringify(connection.source).includes(token))) throw new Error('配对连接来源路径不得包含服务令牌');
  await validateOutput(output, secretEnv);
  const root = await realpath(dataDir), bindings = join(root, '.bindings');
  await validatePortableDirectory(root);
  try { const info = await lstat(bindings); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('通用绑定目录须为普通目录'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(bindings, { mode: 0o700 }); }
  const id = randomUUID(), dir = join(bindings, id), content = outputText(output);
  const receipt = { schema_version: 1, kind: 'portable', id, host, verification_scope: 'paired_connection', endpoint,
    source: connection.source, credential_sha256: sha(id + '\0' + connection.token), output, output_sha256: sha(content) };
  receipt.integrity_sha256 = sha(JSON.stringify(receipt));
  const bindingPath = join(dir, 'binding.json'), outputEnv = join(dir, 'output.env');
  await mkdir(dir, { mode: 0o700 });
  try {
    await writeFile(outputEnv, content, { flag: 'wx', mode: 0o600 });
    await writeFile(bindingPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { portable_binding: bindingPath, output_env: outputEnv };
}

export async function readPortableBinding(path, env = process.env) {
  let receipt;
  try { await regular(path); receipt = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('通用绑定收据缺失、损坏或不是安全普通文件；请先运行 setup verify'); }
  if (!keys(receipt, ['schema_version', 'kind', 'id', 'host', 'verification_scope', 'endpoint', 'source', 'credential_sha256', 'output', 'output_sha256', 'integrity_sha256'])
    || receipt.schema_version !== 1 || receipt.kind !== 'portable' || !uuid(receipt.id) || portableHost(receipt.host) !== receipt.host
    || receipt.verification_scope !== 'paired_connection' || basename(path) !== 'binding.json' || basename(dirname(path)) !== receipt.id
    || basename(dirname(dirname(path))) !== '.bindings' || !hex(receipt.credential_sha256) || !hex(receipt.output_sha256)) throw new Error('通用绑定收据格式无效');
  const { integrity_sha256, ...payload } = receipt;
  if (!hex(integrity_sha256) || sha(JSON.stringify(payload)) !== integrity_sha256) throw new Error('通用绑定收据已被修改');
  const source = receipt.source;
  if (!(keys(source, ['type', 'url_env', 'auth_env']) && source.type === 'environment' && source.url_env === 'STRATEGIC_MCP_URL' && source.auth_env === 'STRATEGIC_MCP_TOKEN')
    && !(keys(source, ['type', 'path', 'sha256']) && source.type === 'connection_file' && absolute(source.path) && hex(source.sha256))) throw new Error('通用绑定来源记录无效');
  if (portableEndpoint(receipt.endpoint, env) !== receipt.endpoint) throw new Error('通用绑定端点非规范形式');
  await validateOutput(receipt.output, env);
  const outputEnv = join(dirname(path), 'output.env');
  let content;
  try { await regular(outputEnv); content = await readFile(outputEnv, 'utf8'); }
  catch { throw new Error('通用冻结输出偏好缺失或不是安全普通文件'); }
  if (content !== outputText(receipt.output) || sha(content) !== receipt.output_sha256) throw new Error('通用冻结输出偏好已被修改');
  return { receipt, outputEnv, identity: { receipt: path, sha256: sha(JSON.stringify(receipt)), output_sha256: receipt.output_sha256 } };
}

export async function verifyPortableBinding(path, env = process.env) {
  const binding = await readPortableBinding(path, env), receipt = binding.receipt;
  const connection = await pairedConnection({ connectionPath: receipt.source.type === 'connection_file' ? receipt.source.path : null, env });
  if (connection.url !== receipt.endpoint || JSON.stringify(connection.source) !== JSON.stringify(receipt.source)
    || sha(receipt.id + '\0' + connection.token) !== receipt.credential_sha256) throw new Error('本次配对连接或来源已改变；请重新 verify 并开始新运行');
  return { ...binding, connection };
}

// Output is deliberately offline: a lost token/config must not prevent recovery
// of a saved draft. Only the receipt, run identity and frozen output are needed.
export { boundOutput } from './output-binding.mjs';
