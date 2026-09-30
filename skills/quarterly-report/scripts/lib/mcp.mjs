import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clientEnv } from './environment.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BUSY = new Set(['SERVICE_BUSY', 'DB_QUERY_TIMEOUT', 'DB_CONNECTION_FAILED']);

/** 缺省服务地址 = 插件配置项 strategic_url 的默认值（.mcp.json 只引用该配置项，不再写死地址）。 */
export async function defaultUrl(entry) {
  const root = dirname(dirname(dirname(dirname(entry))));
  const manifest = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const url = manifest.userConfig?.strategic_url?.default;
  if (typeof url !== 'string' || !url) throw new Error('插件清单缺少 userConfig.strategic_url.default');
  return url;
}

/** 读会话启动钩子写入的连接文件（url=… 与 token=… 两行）。文件不存在返回 null，其他读错误照常抛出。 */
export async function readConnection(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { url: values.url ?? '', token: values.token ?? '' };
}

/**
 * 服务地址与令牌总是成对取自同一来源，不把插件令牌发往别处：
 * 1. 设置了 STRATEGIC_MCP_URL：只取 STRATEGIC_MCP_TOKEN，缺令牌也不跨族回退；
 * 2. 否则设置了 FLYWHEEL_MCP_URL（已弃用）：只取 FLYWHEEL_MCP_TOKEN；
 * 3. 否则连接文件里有令牌：取插件配置（与插件 MCP 连接用的是同一份）；
 * 4. 否则：插件默认地址 + 环境令牌（新名优先，旧名已弃用），用于无头运行。
 */
export async function resolveConnection(entry, connectionPath, env = process.env) {
  let result;
  if (env.STRATEGIC_MCP_URL) result = { url: env.STRATEGIC_MCP_URL, token: env.STRATEGIC_MCP_TOKEN ?? '', source: 'env' };
  else if (env.FLYWHEEL_MCP_URL) result = { url: env.FLYWHEEL_MCP_URL, token: env.FLYWHEEL_MCP_TOKEN ?? '', source: 'env' };
  else {
    const saved = connectionPath ? await readConnection(connectionPath) : null;
    if (saved?.token) result = { url: saved.url || await defaultUrl(entry), token: saved.token, source: 'plugin' };
    else {
      const token = clientEnv(env, 'MCP_TOKEN') ?? '';
      result = { url: await defaultUrl(entry), token, source: token ? 'env' : 'none' };
    }
  }
  let parsed;
  try { parsed = new URL(result.url); } catch { parsed = null; }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new Error(`服务地址不是 http(s) URL（来源 ${result.source}）`);
  return result;
}

function decodeRpc(body, contentType, id) {
  if (!body.trim()) return null;
  if (!contentType.includes('text/event-stream')) return JSON.parse(body);
  const messages = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') messages.push(JSON.parse(data));
  }
  return messages.find((message) => message?.id === id) ?? messages.at(-1) ?? null;
}

export class McpClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.session = null;
    this.nextId = 0;
  }

  async request(method, params = {}, notification = false, deadline = Date.now() + 180_000) {
    const id = notification ? undefined : ++this.nextId;
    const payload = { jsonrpc: '2.0', ...(notification ? {} : { id }), method, params };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (Date.now() >= deadline) throw Object.assign(new Error('MCP 调用超过 180 秒'), { retryable: false });
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        if (this.session) headers['mcp-session-id'] = this.session;
        const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        const session = response.headers.get('mcp-session-id');
        if (session) this.session = session;
        if (response.status >= 500 && attempt === 0) { await response.body?.cancel(); continue; }
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { retryable: false });
        const body = await response.text();
        if (notification) return null;
        let rpc;
        try { rpc = decodeRpc(body, response.headers.get('content-type') ?? '', id); }
        catch { throw Object.assign(new Error('MCP 响应不是有效 JSON/SSE'), { retryable: false }); }
        if (!rpc) throw Object.assign(new Error('MCP 响应为空'), { retryable: false });
        if (rpc.error) throw Object.assign(new Error(rpc.error.message ?? 'MCP RPC 错误'), { code: rpc.error.code, retryable: false });
        return rpc.result;
      } catch (error) {
        if (attempt === 0 && error.retryable !== false) continue;
        throw error;
      }
    }
  }

  async initialize() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'strategic-quarterly-report', version: '1.0.0' } });
    await this.request('notifications/initialized', {}, true);
  }

  async call(name, args) {
    const deadline = Date.now() + 180_000;
    for (let retry = 0; ; retry++) {
      const result = await this.request('tools/call', { name, arguments: args }, false, deadline);
      const content = result?.content?.find((entry) => entry.type === 'text')?.text;
      let parsed;
      try { parsed = JSON.parse(content ?? 'null'); }
      catch { parsed = { error: '工具响应不是 JSON' }; }
      if (!result?.isError) {
        if (!parsed || !Object.hasOwn(parsed, 'data') || !Object.hasOwn(parsed, 'stamp')) throw new Error('工具响应缺少 data/stamp 信封');
        return parsed;
      }
      const code = parsed?.code;
      if (BUSY.has(code) && retry < 3 && Date.now() + [5000, 15000, 30000][retry] < deadline) { await delay([5000, 15000, 30000][retry]); continue; }
      throw Object.assign(new Error(String(parsed?.error ?? '工具错误')), { code, toolError: true });
    }
  }
}
