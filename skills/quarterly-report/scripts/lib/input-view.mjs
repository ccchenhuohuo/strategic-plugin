import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inputParents, inputPath, safeName } from './common.mjs';
export { inputParents, inputPath } from './common.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export async function assertInputCopy(runDir, path, sha256) {
  await inputParents(runDir, path);
  const copy = await inputSnapshot(join(runDir, inputPath(path)));
  if (copy?.sha256 !== sha256) throw new Error(`发布计划副本哈希不符或缺失：${path}`);
}

/** 每份输入只消费一次原始字节；后续读取仅用于稳定性检查。 */
export async function inputSnapshot(path, { required = false, label = path } = {}) {
  let before;
  try { before = await fs.lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' && !required) return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} 不是普通文件`);
  const bytes = await fs.readFile(path);
  const after = await fs.lstat(path, { bigint: true });
  if (!sameStat(before, after)) throw new Error(`${label} 在读取期间发生变化`);
  return { bytes, stat: after, sha256: sha(bytes) };
}

export function validInputBinding(binding) {
  if (!object(binding) || Object.keys(binding).length !== 3 || binding.version !== 1 || !hash(binding.sha256) || !Array.isArray(binding.files) || !binding.files.length) return false;
  let previous = '';
  for (const file of binding.files) {
    if (!object(file) || Object.keys(file).length !== 2 || !('path' in file) || !('sha256' in file) || !(file.sha256 === null || hash(file.sha256))) return false;
    try { inputPath(file.path); } catch { return false; }
    if (ordered(previous, file.path) >= 0) return false;
    previous = file.path;
  }
  return ['manifest.json', 'ledger.jsonl', 'report.md', 'charts/index.json'].every((path) => binding.files.some((file) => file.path === path)) &&
    binding.sha256 === sha(JSON.stringify(binding.files));
}

export function chartReferences(text) {
  return [...new Set([...String(text).matchAll(/!\[(?:\\[^\n]|[^\\\[\]\n]|\[[^\]\n]*\])*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/gu)]
    .map((match) => match[1] ?? match[2]).filter((path) => path.startsWith('charts/')).map(inputPath))];
}

/** A narrow local input inventory, not a directory scan or an analysis cache.
 * Missing files have a null hash. Consumers decide which absences are blocking.
 * Accessors return copies, so rendering cannot mutate another consumer's input. */
export async function captureInputs(runDir, options = {}) {
  runDir = resolve(runDir);
  const files = new Map();
  const take = async (path, supplied) => {
    inputPath(path);
    if (!files.has(path)) {
      await inputParents(runDir, path);
      files.set(path, supplied === undefined ? await inputSnapshot(join(runDir, path)) : supplied);
    }
  };
  if (options.report !== false) await take('report.md', options.reportSnapshot);
  await take('manifest.json', options.manifestSnapshot);
  const text = (path, optional = false) => {
    if (!files.has(inputPath(path))) throw new Error(`输入未登记：${path}`);
    const entry = files.get(path);
    if (!entry && !optional) throw new Error(`输入缺失：${path}`);
    return entry?.bytes.toString('utf8') ?? '';
  };
  const readJson = (path) => JSON.parse(text(path));
  const manifest = readJson('manifest.json');
  await take('ledger.jsonl');
  if (manifest.data_note !== undefined) await take(manifest.data_note);
  for (const chapter of Array.isArray(manifest.chapters) ? manifest.chapters : []) {
    for (const table of Array.isArray(chapter.tables) ? chapter.tables : []) {
      await take(table.path);
      await take(`tables/${safeName(table.table_id)}.json`);
    }
    for (const slot of Array.isArray(chapter.slots) ? chapter.slots : []) {
      await take(slot.draft);
      if (slot.digest !== undefined) await take(slot.digest);
    }
  }
  for (const table of Array.isArray(manifest.writing_tables) ? manifest.writing_tables : []) {
    await take(table.path);
    await take(`tables/${safeName(table.table_id)}.json`);
  }
  // A bad ledger remains captured; render/check will report its parse failure.
  let ledger = [];
  try { ledger = text('ledger.jsonl', true).split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line)); } catch {}
  for (const record of ledger.filter((entry) => entry?.ok)) await take(`evidence/${inputPath(record.id)}.json`);
  await take('charts/index.json');
  let charts = [];
  try { const index = readJson('charts/index.json'); if (Array.isArray(index?.charts)) charts = index.charts; } catch {}
  for (const chart of charts.filter((entry) => entry?.status === 'ok')) {
    if (typeof chart.file !== 'string' || chart.file.includes('/') || chart.file.includes('\\')) throw new Error(`图 ${chart.id} 的文件名损坏`);
    await take(`charts/${chart.file}`);
  }
  if (options.report !== false) for (const path of chartReferences(text('report.md', true))) await take(path);
  const binding = { version: 1, files: [...files].sort(([a], [b]) => ordered(a, b)).map(([path, entry]) => ({ path, sha256: entry?.sha256 ?? null })) };
  binding.sha256 = sha(JSON.stringify(binding.files));
  const snapshot = (path) => {
    if (!files.has(inputPath(path))) throw new Error(`输入未登记：${path}`);
    const entry = files.get(path);
    return entry ? { ...entry, bytes: Buffer.from(entry.bytes) } : null;
  };
  return Object.freeze({ runDir, text, json: readJson, snapshot,
    // Fresh objects prevent callers from modifying the recorded version.
    get binding() { return JSON.parse(JSON.stringify(binding)); },
    async assertUnchanged() {
      for (const [path, original] of files) {
        await inputParents(runDir, path);
        const current = await inputSnapshot(join(runDir, path));
        if ((!original !== !current) || (original && (!sameStat(original.stat, current.stat) || original.sha256 !== current.sha256)))
          throw new Error(`${path} 在校验或发布期间发生变化，请重新 assemble / check`);
      }
    },
  });
}
