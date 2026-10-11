#!/usr/bin/env node
// Local preferences and explicit native configuration verification; no MCP/model calls.
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addSecret, redact, validatePortableDirectory } from './lib/common.mjs';
import { mcpTokens } from './lib/environment.mjs';
import { readNativeDeclaration, saveNativeBinding } from './lib/codex-binding.mjs';

const ENTRY = fileURLToPath(import.meta.url);
const HELP = `用法：
  node codex.mjs show [--data-dir DIR]
  node codex.mjs configure [--report-dir DIR] [--feishu-output true|false] [--data-dir DIR]
  node codex.mjs verify [--data-dir DIR]
  node codex.mjs --help
默认数据目录：<CODEX_HOME 或 ~/.codex>/plugins/data/strategic-analytics-strategic
非敏感偏好：preferences.json；只保存 report_dir、feishu_output（默认 false）。
report_dir 默认 ~/Documents/战略季报，支持 ~、~/ 和绝对路径（含中文空格）。
空值、相对路径、控制字符、首尾空白与非法布尔值失败关闭；遗漏键保留现值。
show/configure 准备 runs、chart-env、output.env（feishu=0/1、lark_cli、report_dir）。
报告目录仅 report.mjs collect 时创建；helper 只发现 lark-cli，不运行它。
verify 通过本地 codex mcp get strategic --json 读取当前启用的 HTTP/bearer 声明，
只接受 STRATEGIC_MCP_TOKEN。它不调用 MCP；保存无凭据的绑定收据与本次冻结输出偏好。
prepare --codex 须显式消费 codex_binding，输出步骤使用冻结 output_env。
STRATEGIC_MCP_URL 若存在须与当前 MCP 地址一致。show/configure 不验证连接或立即发布。
不读取 Claude 配置，不保存/显示令牌。输出稳定 JSON；错误退出非零。无网络或模型操作。`;

for (const token of mcpTokens(process.env)) addSecret(token);

function absolutePath(value, home, name) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`${name} 须为无控制字符、无首尾空白的非空绝对路径`);
  if (mcpTokens(process.env).some((token) => value.includes(token))) throw new Error(`${name} 不得包含服务令牌`);
  const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error(`${name} 须为绝对路径或 ~/ 路径`);
  return resolve(expanded);
}

async function optionalFile(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('本地偏好/输出路径必须是普通文件');
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function discoverLark(home, env) {
  const candidates = [
    ...String(env.PATH ?? '').split(delimiter).filter(isAbsolute).map((dir) => join(dir, 'lark-cli')),
    join(home, '.npm-global/bin/lark-cli'), join(home, '.local/bin/lark-cli'),
    '/opt/homebrew/bin/lark-cli', '/usr/local/bin/lark-cli',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      const path = await realpath(candidate);
      if (path.trim() === path && !/[\x00-\x1f\x7f]/u.test(path) && !mcpTokens(env).some((token) => path.includes(token))) return path;
    } catch { /* Discovery never executes a candidate. */ }
  }
  return '';
}

// Stage both files before committing; reject symlinks/directories without changing
// preferences. A failed preference commit restores the previous output snapshot.
async function save(dataDir, prefsPath, outputPath, preferences, output, configure, previousOutput) {
  const staging = await mkdtemp(join(dataDir, '.preferences-'));
  const stagedPrefs = join(staging, 'preferences.json'), stagedOutput = join(staging, 'output.env');
  let outputCommitted = false;
  try {
    await writeFile(stagedOutput, output, { flag: 'wx', mode: 0o600 });
    if (configure) await writeFile(stagedPrefs, JSON.stringify(preferences, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(stagedOutput, outputPath);
    outputCommitted = true;
    if (configure) await rename(stagedPrefs, prefsPath);
  } catch (error) {
    if (outputCommitted && configure) {
      if (previousOutput === null) await rm(outputPath, { force: true });
      else {
        await writeFile(stagedOutput, previousOutput, { flag: 'wx', mode: 0o600 });
        await rename(stagedOutput, outputPath);
      }
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runLocalSetup(adapter = {}) {
  const { values, positionals } = parseArgs({ args: adapter.argv ?? process.argv.slice(2), strict: true, allowPositionals: true, options: {
    help: { type: 'boolean' }, 'data-dir': { type: 'string' }, 'report-dir': { type: 'string' }, 'feishu-output': { type: 'string' }, ...adapter.options,
  } });
  if (values.help) { console.log(adapter.help ?? HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['show', 'configure', 'verify'].includes(command)) throw new Error('只接受 show、configure 或 verify 子命令；用 --help 查看用法');
  if (command !== 'configure' && (values['report-dir'] !== undefined || values['feishu-output'] !== undefined)) throw new Error('show/verify 不接受偏好变更；请使用 configure');
  if (command === 'configure' && values['report-dir'] === undefined && values['feishu-output'] === undefined) throw new Error('configure 须指定 --report-dir 或 --feishu-output');
  if (values['feishu-output'] !== undefined && !['true', 'false'].includes(values['feishu-output'])) throw new Error('--feishu-output 仅接受 true 或 false');
  await adapter.validateArgs?.(command, values);
  const home = absolutePath(homedir(), homedir(), 'HOME');
  const dataDir = values['data-dir'] !== undefined ? absolutePath(values['data-dir'], home, 'data-dir')
    : adapter.defaultDataDir?.(values, home) ?? join(absolutePath(process.env.CODEX_HOME ?? join(home, '.codex'), home, 'CODEX_HOME'), 'plugins/data/strategic-analytics-strategic');
  const prefsPath = join(dataDir, 'preferences.json'), outputEnv = join(dataDir, 'output.env');
  const previousPrefs = await optionalFile(prefsPath), previousOutput = await optionalFile(outputEnv);
  let saved = {};
  if (previousPrefs !== null) {
    try { saved = JSON.parse(previousPrefs); } catch { throw new Error('preferences.json 损坏，拒绝更改'); }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some((key) => !['report_dir', 'feishu_output'].includes(key))
      || typeof saved.report_dir !== 'string' || typeof saved.feishu_output !== 'boolean') throw new Error('preferences.json 格式非法，拒绝更改');
  }
  const preferences = {
    report_dir: absolutePath(values['report-dir'] ?? saved.report_dir ?? join(home, 'Documents/战略季报'), home, 'report_dir'),
    feishu_output: values['feishu-output'] === undefined ? saved.feishu_output ?? false : values['feishu-output'] === 'true',
  };
  await validatePortableDirectory(preferences.report_dir);
  await adapter.validatePreferences?.(preferences, dataDir);
  // Configuration stdout stays in-process; only whitelisted declarations survive.
  const declaration = command === 'verify' ? await (adapter.declaration ? adapter.declaration(values) : readNativeDeclaration()) : null;
  // Capture and validate an explicit hook import before creating any files. It
  // may be this helper's own output.env; import never updates live preferences.
  const imported = declaration ? await adapter.captureOutput?.(values, declaration) : null;
  const output = imported?.output ?? { ...preferences, lark_cli: await discoverLark(home, process.env) };
  await imported?.assertUnchanged();
  const runsDir = join(dataDir, 'runs'), chartEnv = join(dataDir, 'chart-env');
  await mkdir(dataDir, { recursive: true });
  // Serialize local updates so a failed commit cannot roll back another process.
  const lock = join(dataDir, '.preferences.lock');
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('本地偏好正在更新或上次中断留下 .preferences.lock；确认没有 helper 进程后清理再重试'); throw error; }
  let binding = {};
  try {
    if (await optionalFile(prefsPath) !== previousPrefs || await optionalFile(outputEnv) !== previousOutput) throw new Error('本地偏好已被其他进程更改，请重试');
    await imported?.assertUnchanged();
    await mkdir(runsDir, { recursive: true });
    await mkdir(chartEnv, { recursive: true });
    if (!imported) await save(dataDir, prefsPath, outputEnv, preferences,
      `feishu=${output.feishu_output ? 1 : 0}\nlark_cli=${output.lark_cli}\nreport_dir=${output.report_dir}\n`, command === 'configure', previousOutput);
    if (declaration) binding = await (adapter.saveBinding ? adapter.saveBinding(dataDir, declaration, output, values) : saveNativeBinding(dataDir, declaration, output));
  } finally { await rm(lock, { recursive: true, force: true }); }
  console.log(JSON.stringify(redact({ ok: true, ...output, feishu: output.feishu_output ? 1 : 0,
    data_dir: dataDir, preferences: prefsPath, runs_dir: runsDir, chart_env: chartEnv, output_env: outputEnv,
    ...binding,
    report_script: join(dirname(ENTRY), 'report.mjs'), config: join(dirname(dirname(ENTRY)), 'config/vijim-default.json'),
    connection: adapter.connection ? adapter.connection(declaration, values) : { verified: Boolean(declaration), verification_scope: declaration ? 'host_mcp_config' : null, host_mcp_config_verified: Boolean(declaration), ...(declaration ? { url: declaration.endpoint, auth_env: declaration.auth_env } : {}), token_present: Boolean(process.env.STRATEGIC_MCP_TOKEN) },
  })));
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === ENTRY) {
  try { await runLocalSetup(); }
  catch (error) {
    // parseArgs may quote an invalid value: redact before returning any diagnostic.
    console.log(JSON.stringify({ ok: false, error: redact(error.message ?? String(error)) }));
    process.exitCode = 1;
  }
}
