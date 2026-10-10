// One local identity gate for resume and both output APIs. No credentials or I/O
// to a service: absence is never evidence that a historical run was unbound.
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { link, rename, rm, writeFile } from 'node:fs/promises';
import { inputParents, inputSnapshot } from './input-view.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const UPGRADE = '.binding-upgrade.json';
const sameIdentity = (a, b) => a.receipt === b.receipt && a.sha256 === b.sha256 && a.output_sha256 === b.output_sha256;
const validIdentity = (value) => object(value) && Object.keys(value).sort().join(',') === 'output_sha256,receipt,sha256'
  && typeof value.receipt === 'string' && isAbsolute(value.receipt) && resolve(value.receipt) === value.receipt
  && !/[\x00-\x1f\x7f]/u.test(value.receipt) && [value.sha256, value.output_sha256].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash));

function declaration(record) {
  const portable = has(record, 'portable_binding'), native = has(record, 'codex') || has(record, 'codex_binding');
  if (portable && native) throw new Error('运行身份混用通用与 Codex 绑定，拒绝运行');
  const mode = portable ? 'portable' : native ? 'codex' : 'unbound';
  if (has(record, 'binding_mode') && record.binding_mode !== mode) throw new Error('运行绑定模式或绑定字段缺失，拒绝降级');
  const identity = record[`${mode}_binding`];
  if (mode !== 'unbound' && (!validIdentity(identity) || (mode === 'codex' && record.codex !== true)))
    throw new Error('运行绑定身份字段缺失或无效，拒绝运行');
  return { mode, identity };
}

// This is the complete provenance written by the pre-binding prepare CLI.
// A bare manifest or an invented codex:false flag is not a historical record.
function historicalRecord(record) {
  return ['current_start', 'current_end'].every((key) => typeof record[key] === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/u.test(record[key]))
    && typeof record.label === 'string' && record.label.length > 0 && typeof record.release_id === 'string' && record.release_id.length > 0
    && typeof record.config === 'string' && isAbsolute(record.config) && typeof record.config_digest === 'string' && /^[a-f0-9]{16}$/u.test(record.config_digest)
    && (record.sections === 'all' || (Array.isArray(record.sections) && record.sections.length > 0 && record.sections.every((x) => Number.isInteger(x) && x >= 2 && x <= 6)));
}

function validUpgrade(record) {
  return object(record) && Object.keys(record).sort().join(',') === 'committed_args_sha256,id,identity,mode,old_args_sha256,old_manifest_sha256,pending_args_sha256,version'
    && record.version === 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(record.id)
    && ['codex', 'portable'].includes(record.mode) && validIdentity(record.identity)
    && ['old_args_sha256', 'old_manifest_sha256', 'pending_args_sha256', 'committed_args_sha256'].every((key) => hash(record[key]));
}

export async function readRunBinding(runDir) {
  runDir = resolve(runDir);
  const read = async (path) => {
    await inputParents(runDir, path);
    const snapshot = await inputSnapshot(join(runDir, path));
    if (!snapshot) return null;
    let value;
    try { value = JSON.parse(snapshot.bytes.toString('utf8')); } catch { throw new Error(`${path} 运行身份记录损坏，拒绝运行`); }
    if (!object(value)) throw new Error(`${path} 运行身份记录无效，拒绝运行`);
    return { value, snapshot };
  };
  const argsFile = await read('run-args.json'), manifestFile = await read('manifest.json'), upgradeFile = await read(UPGRADE);
  const args = argsFile?.value, manifest = manifestFile?.value, upgrade = upgradeFile?.value;
  const captured = manifest ? declaration(manifest) : null;
  if (!args) throw new Error('运行原身份缺失（run-args.json），拒绝降级为未绑定运行');
  const declared = declaration(args);
  if (!historicalRecord(args)) throw new Error('运行身份缺少完整取数记录，拒绝猜测历史未绑定状态');
  if (has(args, 'manifest_written') && !has(args, 'binding_mode')) throw new Error('运行绑定模式缺失，拒绝降级');
  if (declared.mode !== 'unbound' && has(args, 'binding_mode') && typeof args.manifest_written !== 'boolean')
    throw new Error('运行身份缺少 manifest 写入状态，拒绝降级');
  if (!manifest && args.manifest_written === true) throw new Error('已有 manifest 的绑定运行缺少报告身份，拒绝降级');
  let upgradeState = null, pendingOldMirror = false;
  if (upgrade) {
    if (!validUpgrade(upgrade) || upgrade.mode !== declared.mode || !sameIdentity(upgrade.identity, declared.identity) || !manifest)
      throw new Error('绑定身份升级记录缺失、损坏或与运行身份不一致');
    upgradeState = ['old', 'pending', 'committed'].find((state) => argsFile.snapshot.sha256 === upgrade[`${state}_args_sha256`]);
    if (!upgradeState || (upgradeState === 'old' ? has(args, 'binding_mode') || has(args, 'manifest_written') || has(args, 'binding_upgrade')
      : args.binding_mode !== declared.mode || args.manifest_written !== true || (upgradeState === 'pending' ? args.binding_upgrade !== upgrade.id : has(args, 'binding_upgrade'))))
      throw new Error('绑定身份偏离升级记录的已知版本，拒绝降级');
    const oldMirror = manifestFile.snapshot.sha256 === upgrade.old_manifest_sha256;
    if (upgradeState === 'old' && !oldMirror) throw new Error('绑定身份升级原始 manifest 已变化');
    pendingOldMirror = upgradeState === 'pending' && oldMirror;
  } else if (has(args, 'binding_upgrade')) throw new Error('绑定身份升级记录缺失，拒绝降级');
  if (manifest) {
    if (declared.mode !== 'unbound' && has(manifest, 'binding_mode') && !has(args, 'binding_mode'))
      throw new Error('运行原身份绑定模式缺失，拒绝降级');
    // Old Codex prepare did not mirror its identity. A complete old args record,
    // or the exact original manifest in its hash-bound upgrade, is required.
    const oldNative = declared.mode === 'codex' && (!has(args, 'binding_mode') || pendingOldMirror) && captured.mode === 'unbound' && !has(manifest, 'binding_mode');
    if (!oldNative && (captured.mode !== declared.mode || (declared.mode !== 'unbound' && !sameIdentity(captured.identity, declared.identity))))
      throw new Error('运行原身份缺失或与 manifest 报告绑定标记不一致，拒绝降级或复用证据');
    if (has(args, 'binding_mode') && !has(manifest, 'binding_mode') && declared.mode !== 'unbound' && !pendingOldMirror)
      throw new Error('manifest 报告绑定模式缺失，拒绝降级');
  }
  return { ...declared, args, manifest, upgrade, upgradeState,
    snapshots: { args: argsFile.snapshot, manifest: manifestFile?.snapshot, upgrade: upgradeFile?.snapshot } };
}

export function assertResumeBinding(saved, current) {
  if (saved.mode !== current.mode) throw new Error(`--resume 必须保留 ${saved.mode === 'codex' ? '--codex 与 --codex-binding' : saved.mode === 'portable' ? '--portable-binding' : '原未绑定参数与模式'}，拒绝复用证据`);
  if (saved.mode !== 'unbound' && !sameIdentity(saved.identity, current.identity))
    throw new Error(`--resume 的 ${saved.mode}_binding 与上次不一致；已拒绝复用证据`);
}

export function assertFrozenOutput(saved, binding, supplied) {
  if (!sameIdentity(saved.identity, binding.identity)) throw new Error('运行绑定收据已被修改，拒绝输出操作');
  if (typeof supplied !== 'string' || !supplied || resolve(supplied) !== binding.outputEnv)
    throw new Error('绑定运行须使用本次 verify/prepare 返回的冻结 output_env');
  return binding.outputEnv;
}

async function atomicRecord(runDir, name, record) {
  const path = join(runDir, `.${name}-${randomUUID()}.tmp`);
  try {
    await writeFile(path, json(record), { flag: 'wx', mode: 0o600 });
    // Publish a complete upgrade marker once. A competing writer must never
    // replace its id after both writers have passed the snapshot check.
    if (name === UPGRADE) {
      try { await link(path, join(runDir, name)); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('另一个进程已开始升级此运行；等待完成后按原参数续跑'); throw error; }
    } else await rename(path, join(runDir, name));
  } finally { await rm(path, { force: true }); }
}

export const writeRunArgs = (runDir, record) => atomicRecord(runDir, 'run-args.json', record);
export const writeRunManifest = (runDir, record) => atomicRecord(runDir, 'manifest.json', record);

/** Write-ahead identity upgrade, only for a complete historical bound run.
 * Exact old/pending/committed args and old manifest hashes delimit the exception;
 * offline readers never repair or rewrite the captured report inputs. */
export async function startRunArgs(runDir, record, saved) {
  if (saved) {
    const current = await readRunBinding(runDir);
    for (const key of ['args', 'manifest', 'upgrade']) if (current.snapshots[key]?.sha256 !== saved.snapshots[key]?.sha256)
      throw new Error('运行身份在续跑前发生变化，拒绝写入');
  }
  let upgrade = saved?.upgrade;
  if (!upgrade && saved?.manifest && saved.mode !== 'unbound' && !has(saved.args, 'binding_mode')) {
    const id = randomUUID();
    upgrade = { version: 1, id, mode: saved.mode, identity: saved.identity,
      old_args_sha256: saved.snapshots.args.sha256, old_manifest_sha256: saved.snapshots.manifest.sha256,
      pending_args_sha256: sha(json({ ...record, binding_upgrade: id })), committed_args_sha256: sha(json(record)) };
    await atomicRecord(runDir, UPGRADE, upgrade);
  }
  if (upgrade) {
    if (sha(json(record)) !== upgrade.committed_args_sha256) throw new Error('续跑身份与待恢复升级不一致');
    if (saved?.upgradeState !== 'committed') record = { ...record, binding_upgrade: upgrade.id };
  }
  await writeRunArgs(runDir, record);
  return record;
}

export async function finishRunArgs(runDir, record) {
  const saved = await readRunBinding(runDir);
  if (saved.manifest?.binding_mode !== saved.mode) throw new Error('绑定身份升级尚未提交报告镜像');
  const committed = { ...record, manifest_written: true };
  delete committed.binding_upgrade;
  if (saved.upgrade && sha(json(committed)) !== saved.upgrade.committed_args_sha256) throw new Error('绑定身份升级提交版本不一致');
  await writeRunArgs(runDir, committed);
  // Keep the immutable transition proof. A writer that was delayed after its
  // snapshot check can still install the known pending version after this
  // commit; removing its proof here would make that valid state unrecoverable.
}
