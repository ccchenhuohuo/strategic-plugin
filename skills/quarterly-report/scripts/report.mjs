#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { McpClient, readConnection, resolveCodexConnection, resolveConnection } from './lib/mcp.mjs';
import { addSecret, digest, ensureEmpty, readJson, redact, safeName, unique } from './lib/common.mjs';
import { dependentCalls, executeStage, isL3Unlabelled, mainCalls, observedSites, persistStage, probes, selectedFocus } from './lib/plan.mjs';
import { buildTables } from './lib/tables.mjs';
import { assemble, buildManifest, dataNote, writeArtifacts } from './lib/artifacts.mjs';
import { check } from './lib/check.mjs';
import { verifyNativeBinding } from './lib/codex-binding.mjs';
import { boundOutput, verifyPortableBinding } from './lib/portable-binding.mjs';
import { assertResumeBinding, finishRunArgs, readRunBinding, startRunArgs } from './lib/run-binding.mjs';
import { mcpTokens } from './lib/environment.mjs';
import { sourceContract } from './lib/source-contract.mjs';

for (const token of mcpTokens(process.env)) addSecret(token);

const entry = decodeURIComponent(new URL(import.meta.url).pathname);
const scriptDir = dirname(entry);
const defaultConfig = join(dirname(scriptDir), 'config', 'vijim-default.json');
const help = `用法：
  node report.mjs prepare --current-start YYYY-MM --current-end YYYY-MM --label LABEL [--config PATH] [--out DIR] [--runs-dir DIR] [--release-id ID] [--sections 2,3] [--concurrency 1..4] [--force | --resume] [--connection FILE | --codex | --portable-binding FILE]
  （Codex 原生流程传 --codex --codex-binding <helper verify 返回的收据> 与 --runs-dir 或 --out；无绑定不联网）
  （通用入口传 --portable-binding <setup verify 返回的收据>，显式配对连接、无默认地址；输出步骤使用冻结 output_env）
  （进程被超时或中断时：用同样参数加 --resume --out <stderr 里 RUN_DIR= 的目录> 续跑，已成功的调用直接复用）
  node report.mjs assemble --run-dir DIR
  node report.mjs check --run-dir DIR
  node report.mjs collect --run-dir DIR --output-env FILE
  node report.mjs charts --run-dir DIR [--env-dir DIR] [--python PATH] [--only ID[,ID…]]
  node report.mjs publish --run-dir DIR --output-env FILE [--unverified id,id] [--resume] [--dry-run] [--time-budget 秒]
  （完整季报发布约十几分钟：单次运行到时间预算（默认 400 秒）就在两步之间停下，返回 incomplete=true，用 --resume 续跑）
  （不确定写入会拒绝自动重放；仅人工核对后用 --resume --retry-uncertain 重做，或 --resume --skip-uncertain 确认已写入后继续；两者不能同用）
  node report.mjs --help
服务地址与令牌：设置了 STRATEGIC_MCP_URL 时只配对 STRATEGIC_MCP_TOKEN；否则若设置了
FLYWHEEL_MCP_URL（已弃用）就只配对 FLYWHEEL_MCP_TOKEN，两族不得混用。
没有显式环境地址时先取 --connection 连接文件（插件会话启动时写入）的令牌与地址；
再否则插件默认地址 + 环境令牌（STRATEGIC_MCP_TOKEN 优先，FLYWHEEL_MCP_TOKEN 已弃用）。`;

function options(argv) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'current-start': { type: 'string' }, 'current-end': { type: 'string' }, label: { type: 'string' },
    config: { type: 'string' }, out: { type: 'string' }, 'runs-dir': { type: 'string' }, 'release-id': { type: 'string' },
    sections: { type: 'string' }, concurrency: { type: 'string' }, force: { type: 'boolean' }, resume: { type: 'boolean' },
    connection: { type: 'string' }, codex: { type: 'boolean' }, 'codex-binding': { type: 'string' }, 'portable-binding': { type: 'string' }, 'run-dir': { type: 'string' }, help: { type: 'boolean' },
    'env-dir': { type: 'string' }, python: { type: 'string' }, only: { type: 'string' },
    'output-env': { type: 'string' }, unverified: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'time-budget': { type: 'string' },
    'retry-uncertain': { type: 'boolean' }, 'skip-uncertain': { type: 'boolean' },
  } });
}

function validateWindow(start, end) {
  const pattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
  if (!pattern.test(start) || !pattern.test(end)) throw new Error('月份须为 YYYY-MM');
  const first = Number(start.slice(0, 4)) * 12 + Number(start.slice(5));
  const last = Number(end.slice(0, 4)) * 12 + Number(end.slice(5));
  if (last < first || last - first >= 12) throw new Error('当期窗口须连续且最长 12 个完整月');
}

async function prepare(args) {
  if (args['portable-binding'] && (args.codex || args['codex-binding'] || args.connection)) throw new Error('--portable-binding 不能与 Codex 绑定或 --connection 混用；连接源已在收据中冻结');
  if (args['portable-binding'] && !args['runs-dir'] && !args.out) throw new Error('--portable-binding 必须提供 helper 返回的 --runs-dir 或显式 --out');
  if (args.codex && args.connection) throw new Error('--codex 不能读取 --connection；认证仅用 STRATEGIC_MCP_TOKEN');
  if (args.codex && !args['runs-dir'] && !args.out) throw new Error('--codex 必须提供 helper 返回的 --runs-dir 或显式 --out');
  if (args.codex && !args['codex-binding']) throw new Error('--codex 必须提供 helper verify 返回的 --codex-binding；已拒绝取数');
  if (!args.codex && args['codex-binding']) throw new Error('--codex-binding 仅用于 --codex 原生流程');
  const start = args['current-start'], end = args['current-end'], label = args.label;
  if (!start || !end || !label) throw new Error('prepare 必须提供 --current-start、--current-end、--label');
  validateWindow(start, end);
  const count = args.concurrency === undefined ? 2 : Number(args.concurrency);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('--concurrency 须为 1..4');
  const sections = args.sections === undefined ? null : args.sections.split(',').map(Number);
  const config = await readJson(resolve(args.config ?? defaultConfig));
  if (!Array.isArray(config.sites) || !Array.isArray(config.focus) || !Array.isArray(config.company_brands)) throw new Error('配置缺少 sites/focus/company_brands');
  const focuses = selectedFocus(config, sections);
  const customDir = args.out ? resolve(args.out) : null;
  const runsDir = resolve(args['runs-dir'] ?? join(homedir(), '.claude/plugins/data/strategic-analytics-strategic/runs'));
  const dirFor = (release) => customDir ?? join(runsDir, `${safeName(label)}-${safeName(release).slice(0, 15)}`);
  let saved = null;
  if (args.resume) {
    if (args.force) throw new Error('--resume 与 --force 不能同用');
    if (!customDir) throw new Error('--resume 需要 --out 指向上次的运行目录（见上次 stderr 的 RUN_DIR=）');
    saved = await readRunBinding(customDir);
  }
  const native = args.codex ? await verifyNativeBinding(resolve(args['codex-binding'])) : null;
  const portable = args['portable-binding'] ? await verifyPortableBinding(resolve(args['portable-binding'])) : null;
  const mode = portable ? 'portable' : native ? 'codex' : 'unbound';
  if (saved) assertResumeBinding(saved, { mode, identity: (portable ?? native)?.identity });
  const identity = { current_start: start, current_end: end, label, config: resolve(args.config ?? defaultConfig), config_digest: digest(config), sections: sections ?? 'all', ...(native ? { codex: true, codex_binding: native.identity } : {}), ...(portable ? { portable_binding: portable.identity } : {}) };
  let previous = null;
  if (args.resume) {
    // 续跑：必须指回同一个运行目录，且取数口径（窗口、标签、配置、章节）逐项一致；release 钉住上次绑定的代次。
    previous = saved.args;
    for (const [key, value] of Object.entries(identity)) if (JSON.stringify(previous[key]) !== JSON.stringify(value)) {
      if (key === 'portable_binding') throw new Error('--resume 的 portable_binding 与上次不一致；已拒绝复用证据');
      if (key === 'codex_binding') throw new Error('--resume 的 codex_binding 与上次不一致；已拒绝复用证据');
      throw new Error(`--resume 的 ${key} 与上次不一致（上次 ${JSON.stringify(previous[key])}，本次 ${JSON.stringify(value)}）`);
    }
    if (args['release-id'] && args['release-id'] !== previous.release_id) throw new Error(`--resume 的 release_id 与上次不一致：${previous.release_id}`);
  } else if (customDir) await ensureEmpty(customDir, args.force);
  const pinnedRelease = args['release-id'] ?? previous?.release_id;
  const connection = portable ? portable.connection : args.codex ? await resolveCodexConnection(entry, native.receipt) : await resolveConnection(entry, args.connection ? resolve(args.connection) : null);
  const token = connection.token;
  addSecret(token);
  console.error(`CONNECTION=${typeof connection.source === 'string' ? connection.source : connection.source.type}`);
  const client = new McpClient(connection.url, token);
  try { await client.initialize(); }
  catch (error) {
    if (/^HTTP 401\b/.test(error.message ?? '')) {
      throw new Error(!token
        ? `服务要求访问令牌，但没有拿到：${args.connection ? '在插件配置里填写令牌（交互式 claude 中 /plugin configure strategic-analytics@strategic）后新开会话，或' : ''}设置 STRATEGIC_MCP_TOKEN 后从同一环境启动客户端`
        : `访问令牌被服务拒绝（来源 ${connection.source === 'plugin' ? '插件配置' : '环境变量'}）：核对令牌是否有效`);
    }
    throw error;
  }
  const results = new Map();
  const context = { results, runDir: null, secret: token, concurrency: count, releaseId: null, nextEvidence: 0, resume: Boolean(args.resume) };
  const statusCalls = await executeStage(client, [{ key: 'STATUS', tool: 'strategic_data_status', arguments: pinnedRelease ? { release_id: pinnedRelease } : {} }], context);
  const status = results.get('STATUS');
  if (!status.ok) {
    const failedDir = dirFor(args['release-id'] ?? 'unbound');
    if (!customDir) await ensureEmpty(failedDir, args.force);
    await persistStage(statusCalls, results, failedDir, token);
    throw new Error(`data_status 失败：${status.error.message}；证据 ${status.id}；目录 ${failedDir}`);
  }
  const releaseId = status.envelope.stamp?.release_id;
  if (!releaseId || (pinnedRelease && releaseId !== pinnedRelease)) {
    const failedDir = dirFor(args['release-id'] ?? releaseId ?? 'unbound');
    if (!customDir) await ensureEmpty(failedDir, args.force);
    await persistStage(statusCalls, results, failedDir, token);
    throw new Error(`data_status release_id 缺失或与指定值不一致；证据 ${status.id}；目录 ${failedDir}`);
  }
  const watermark = status.envelope.data?.available_months?.end;
  if (!watermark || end > watermark) throw new Error(`当期窗口 ${end} 越过完整月水位 ${watermark ?? '未知'}`);
  const runDir = dirFor(releaseId);
  if (!customDir) await ensureEmpty(runDir, args.force);
  context.runDir = runDir; context.releaseId = releaseId;
  console.error(`RUN_DIR=${runDir}`);
  // 续跑时账本按计划顺序整本重建；首跑记下取数口径供续跑核对
  const runArgs = await startRunArgs(runDir, { ...identity, release_id: releaseId, binding_mode: mode, ...(mode !== 'unbound' ? { manifest_written: Boolean(saved?.manifest) } : {}) }, saved);
  if (args.resume) await writeFile(join(runDir, 'ledger.jsonl'), '');
  await persistStage(statusCalls, results, runDir, token);
  const window = { current_start: start, current_end: end };
  // New scope excludes unclassified category rows. It cannot justify widening
  // an unobserved L3 slice to its parent; only the historical contract can.
  if (sourceContract(status.envelope.stamp) === 'legacy_derived') await executeStage(client, probes(config, window), context);
  const unlabelled = new Set([...results].filter(([key, record]) => key.startsWith('P:') && record.ok && isL3Unlabelled(record.envelope)).map(([key]) => key));
  const main = mainCalls(config, focuses, sections, window, unlabelled);
  await executeStage(client, main.slice(0, 1), context);
  const g1 = results.get('G1');
  if (!g1.ok) throw new Error(`G1 失败，无法核验站点全集：${g1.error.message}`);
  const observed = observedSites(g1.envelope).sort();
  const expected = [...config.sites].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`G1 当期有观察站点与配置不符：观察到 ${observed.join(',') || '无'}；配置 ${expected.join(',')}`);
  await executeStage(client, main.slice(1), context);
  const b1 = main.filter((call) => call.key.startsWith('B1:'));
  const dependent = dependentCalls(config, b1, results, window);
  await executeStage(client, dependent.calls, context);
  const tables = buildTables(config, focuses, results, unlabelled, dependent.selected);
  const windows = g1.envelope.data?.windows ?? {};
  const manifest = buildManifest(config, focuses, sections, tables, dependent.selected, label, releaseId, windows);
  // Preserve a second declaration in the captured report inputs. Losing the
  // resumable identity must not silently downgrade a bound run to legacy output.
  manifest.binding_mode = mode;
  if (native) { manifest.codex = true; manifest.codex_binding = native.identity; }
  if (portable) manifest.portable_binding = portable.identity;
  const caveats = unique([...results.values()].sort((left, right) => left.id.localeCompare(right.id)).flatMap((record) => record.envelope ? [...(record.envelope.caveats ?? []), ...(record.envelope.coverage_notes ?? [])] : []));
  await writeArtifacts(runDir, manifest, tables, results, focuses, dataNote(status.envelope, config, label, windows, caveats));
  if (mode !== 'unbound') await finishRunArgs(runDir, runArgs);
  const errors = [...results.values()].filter((record) => !record.ok).sort((left, right) => left.id.localeCompare(right.id)).map((record) => ({ id: record.id, tool: record.tool, key: record.key, error: record.error }));
  return { ok: errors.length === 0, run_dir: runDir, ...(native ? { output_env: native.outputEnv, codex_binding: native.identity.receipt } : {}), ...(portable ? { output_env: portable.outputEnv, portable_binding: portable.identity.receipt } : {}), release_id: releaseId, label, windows, writer_groups: manifest.writer_groups.map((group) => ({ ...group, slots: group.slots.map((slot) => ({ slot: slot.slot, digest: join(runDir, slot.digest), draft: join(runDir, slot.draft) })) })), calls: context.nextEvidence, errors };
}

async function main() {
  const parsed = options(process.argv.slice(2));
  if (parsed.values.help || parsed.positionals.length === 0) { console.log(help); return; }
  const command = parsed.positionals[0];
  if (parsed.positionals.length !== 1) throw new Error('只接受一个子命令');
  // assemble/check 不连服务；给了连接文件也登记其中的令牌，保证任何输出都不带出它。
  if (command !== 'prepare' && parsed.values.connection) addSecret((await readConnection(resolve(parsed.values.connection)))?.token);
  let output;
  if (command === 'prepare') output = await prepare(parsed.values);
  else if (command === 'assemble') {
    if (!parsed.values['run-dir']) throw new Error('assemble 必须提供 --run-dir');
    output = await assemble(resolve(parsed.values['run-dir']));
  } else if (command === 'check') {
    if (!parsed.values['run-dir']) throw new Error('check 必须提供 --run-dir');
    output = await check(resolve(parsed.values['run-dir']));
    if (!output.ok) process.exitCode = 1;
  } else if (command === 'charts') {
    if (!parsed.values['run-dir']) throw new Error('charts 必须提供 --run-dir');
    const { charts } = await import('./lib/charts.mjs');
    output = await charts({ runDir: resolve(parsed.values['run-dir']),
      envDir: parsed.values['env-dir'] ? resolve(parsed.values['env-dir']) : undefined,
      python: parsed.values.python, only: parsed.values.only });
  } else if (command === 'collect') {
    if (!parsed.values['run-dir'] || !parsed.values['output-env']) throw new Error('collect 必须提供 --run-dir、--output-env');
    const { collect } = await import('./lib/collect.mjs');
    output = await collect({ runDir: resolve(parsed.values['run-dir']), outputEnv: await boundOutput(resolve(parsed.values['run-dir']), resolve(parsed.values['output-env'])) });
    if (!output.ok) process.exitCode = 1;
  } else if (command === 'publish') {
    if (!parsed.values['run-dir'] || !parsed.values['output-env']) throw new Error('publish 必须提供 --run-dir、--output-env');
    const { publish } = await import('./lib/publish.mjs');
    output = await publish({ runDir: resolve(parsed.values['run-dir']), outputEnv: await boundOutput(resolve(parsed.values['run-dir']), resolve(parsed.values['output-env'])),
      unverified: parsed.values.unverified, resume: Boolean(parsed.values.resume), dryRun: Boolean(parsed.values['dry-run']),
      timeBudget: parsed.values['time-budget'], retryUncertain: Boolean(parsed.values['retry-uncertain']),
      skipUncertain: Boolean(parsed.values['skip-uncertain']) });
    if (!output.ok) process.exitCode = 1;
  } else throw new Error(`未知子命令：${command}`);
  console.log(JSON.stringify(redact(output)));
}

try { await main(); }
catch (error) {
  const message = redact(error.message ?? String(error));
  console.error(message);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
