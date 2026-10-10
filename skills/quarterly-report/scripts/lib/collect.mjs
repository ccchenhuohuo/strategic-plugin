import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { json, readJson, redact, safeName, unique } from './common.mjs';
import { boundOutput } from './portable-binding.mjs';
import { checkBinding, reportSnapshot } from './check-binding.mjs';
import { captureInputs, inputSnapshot, validInputBinding } from './input-view.mjs';

const optionalJson = async (path) => {
  await plainFile(path);
  try { return await readJson(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const exists = async (path) => {
  try { return await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function atomicWrite(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, path);
    await syncPath(dirname(path));
  }
  finally { await fs.rm(temp, { force: true }); }
}
async function syncPath(path) {
  const handle = await fs.open(path, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}
const localTime = (iso, archive = false) => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error(`无效的报告生成时间：${iso}`);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${archive ? '-' : ':'}${pad(date.getMinutes())}`;
};
const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]/gu, ' ');
// Angle brackets keep Chinese and spaces clickable; encode Markdown delimiters.
const link = (title, path) => {
  const reserved = /^https?:\/\//u.test(path) ? /[<>|\r\n]/gu : /[%#?<>|\r\n]/gu;
  return `[${cell(title).replace(/[\[\]]/gu, '\\$&')}](<${String(path).replace(reserved, (char) => encodeURIComponent(char))}>)`;
};
const feishuCell = (feishu) => [feishu.status,
  ...(feishu.doc_url ? [link('文档', feishu.doc_url)] : []),
  ...(feishu.workbook_url ? [link('附表', feishu.workbook_url)] : []),
].join(' · ');
function renderIndex(reports, timeZone) {
  return ['# 战略季报索引', '', '由插件维护，请勿手改；报告为草稿，分享前请人工审阅', '',
    '| 季度 | 生成时间 | 数据代次 | 机械校验 | 飞书 | 本地文件 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...reports.map((entry) => `| ${cell(entry.label)} | ${timeZone ? zonedTime(entry.generated_at, timeZone) : localTime(entry.generated_at)} | ${cell(entry.release_id)} | ${entry.check.ok ? '通过' : entry.check.blocking.some((issue) => issue.type === 'collection_pending') ? '未验证（收录进行中）' : entry.check.blocking.some((issue) => issue.type === 'check_unavailable') ? '未验证（校验不可用）' : `未通过 ${entry.check.blocking.length} 个阻断`} | ${feishuCell(entry.feishu)} | ${link('报告', entry.report)} |`), '',
  ].join('\n');
}
function zonedTime(iso, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function ownedPath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\0\r\n]/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !(path === '.report.json' || /^[^/]+\.md$/u.test(path) || /^charts\/[^/]+$/u.test(path))) throw new Error(`不安全的收录文件清单：${path}`);
  return path;
}
async function managedDirectory(path) {
  await directoryChain(path, true);
}
async function managedFile(base, path) {
  ownedPath(path);
  await directoryChain(base);
  if (path.startsWith('charts/')) {
    const charts = await exists(join(base, 'charts'));
    if (charts && (!charts.isDirectory() || charts.isSymbolicLink())) throw new Error(`图表目录不是普通目录：${join(base, 'charts')}`);
  }
  const entry = await exists(join(base, path));
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error(`收录文件不是普通文件：${join(base, path)}`);
  return entry;
}
async function outputConfig(path) {
  let content = '';
  await plainFile(path);
  try { content = await fs.readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Object.fromEntries(content.split('\n').filter((line) => line.includes('=')).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}
async function feishuStatus(runDir, config, view, reportSha256) {
  let published, journal, plan;
  // An interrupted/corrupt publish log must not prevent local collection.
  try { published = await optionalJson(join(runDir, 'publish.json')); } catch { /* unknown publication */ }
  try { journal = await optionalJson(join(runDir, 'publish/journal.json')); } catch { /* unknown publication */ }
  try { plan = await optionalJson(join(runDir, 'publish/plan.json')); } catch { /* unknown publication */ }
  const currentPlan = view && plan?.report_sha256 === reportSha256 && validInputBinding(plan.input_binding) &&
    same(plan.input_binding, view.binding) && /^[a-f0-9]{64}$/u.test(plan.digest ?? '') && journal?.plan_digest === plan.digest;
  if (published) {
    const current = currentPlan && published.ok === true && published.target === 'feishu' &&
      published.report_sha256 === reportSha256 && validInputBinding(published.input_binding) &&
      same(published.input_binding, view.binding) && published.plan_digest === plan.digest;
    return { status: current ? '已同步' : validInputBinding(published.input_binding) ? '本稿未同步（旧稿链接）' : '同步归属未验证（已有链接）',
      ...(published.doc_url ? { doc_url: published.doc_url } : {}), ...(published.workbook_url ? { workbook_url: published.workbook_url } : {}) };
  }
  if (journal?.doc_url || journal?.workbook_url) return { status: currentPlan ? '同步未完成' : '同步归属未验证（已有链接）',
    ...(journal.doc_url ? { doc_url: journal.doc_url } : {}), ...(journal.workbook_url ? { workbook_url: journal.workbook_url } : {}) };
  return { status: config.feishu === '0' || !config.feishu ? '未开启' : '未同步' };
}
function reportFilename(manifest) {
  // Retain readable titles, spaces and Chinese while excluding filesystem separators.
  const name = (value) => String(value).replace(/[\/\\\0<>:"|?*\r\n]/gu, '_');
  if (!manifest.report_name || !manifest.label) throw new Error('manifest 缺少 report_name / label');
  return `${name(manifest.report_name)} - ${name(manifest.label)}.md`;
}
function chartReferences(markdown) {
  // assemble emits only inline images with a charts/<file> destination.
  const paths = [...markdown.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/gu)].map((match) => match[1] ?? match[2]);
  return unique(paths.filter((path) => path.startsWith('charts/')).map(ownedPath));
}

const JOURNAL = '.collect-journal.json';
const PHASES = ['prepared', 'archiving', 'relocating_index', 'relocating_markdown', 'replacing', 'indexing', 'rendering', 'committed'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashValue = (value) => value === null || /^[a-f0-9]{64}$/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const withoutReport = ({ report, ...metadata }) => metadata;
const identity = (entry) => JSON.stringify([entry.label, entry.run_dir]);
const strictKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

// macOS exposes these two OS aliases. Other symlinks, including user-selected
// ancestors, are rejected rather than canonicalized into a different report root.
async function directoryChain(path, create = false) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split('/').filter(Boolean)) {
    current = join(current, part);
    let entry = await exists(current);
    if (entry?.isSymbolicLink()) {
      const osAlias = { '/tmp': '/private/tmp', '/var': '/private/var' }[current];
      if (!osAlias || await fs.realpath(current) !== osAlias) throw new Error(`收录目录不得经过符号链接：${current}`);
      current = osAlias;
      entry = await exists(current);
    }
    if (entry && !entry.isDirectory()) throw new Error(`收录目录不是普通目录：${current}`);
    if (!entry) {
      if (!create) return false;
      await fs.mkdir(current);
      await syncPath(dirname(current));
    }
  }
  return true;
}
async function plainFile(path) {
  await directoryChain(dirname(path));
  const entry = await exists(path);
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error(`收录文件不是普通文件：${path}`);
  return entry;
}
async function fileHash(path) {
  return await plainFile(path) ? sha(await fs.readFile(path)) : null;
}
function labelDirectory(label) {
  const name = safeName(label);
  if (!name || ['.', '..', '.index.json', '索引.md', '.collect.lock', JOURNAL].includes(name) || name.startsWith('.collect-')) throw new Error('报告标签不能用作目录名或与收录保留路径冲突');
  return name;
}
function metadataValid(metadata) {
  if (!Array.isArray(metadata?.files)) throw new Error('.report.json 损坏，拒绝覆盖');
  metadata.files.forEach(ownedPath);
  const filename = reportFilename(metadata);
  if (!strictKeys(metadata, ['version', 'label', 'report_name', 'run_dir', 'release_id', 'generated_at', 'check', 'feishu', 'files', 'missing_charts']) ||
      metadata.version !== 1 || typeof metadata.label !== 'string' || typeof metadata.report_name !== 'string' ||
      !isAbsolute(metadata.run_dir ?? '') || /[\0\r\n]/u.test(metadata.run_dir) || typeof metadata.release_id !== 'string' || typeof metadata.generated_at !== 'string' ||
      !metadata.check || typeof metadata.check.ok !== 'boolean' || !Array.isArray(metadata.check.blocking) ||
      !metadata.feishu || typeof metadata.feishu.status !== 'string' || unique(metadata.files).length !== metadata.files.length ||
      !metadata.files.includes(filename) || !metadata.files.includes('.report.json') ||
      metadata.files.some((path) => path !== filename && path !== '.report.json' && !path.startsWith('charts/')) ||
      (metadata.missing_charts && (!Array.isArray(metadata.missing_charts) || metadata.missing_charts.some((path) => !ownedPath(path).startsWith('charts/'))))) throw new Error('.report.json 损坏或文件清单不匹配，拒绝覆盖');
  labelDirectory(metadata.label);
  localTime(metadata.generated_at);
  return metadata;
}
function rowValid(entry) {
  if (!entry || typeof entry.report !== 'string') throw new Error('.index.json 报告行损坏');
  metadataValid(withoutReport(entry));
  const parts = entry.report.split('/'), label = labelDirectory(entry.label), filename = reportFilename(entry);
  const isArchive = parts.length === 4 && parts[1] === '历史' && archiveNameValid(parts[2]);
  if (parts[0] !== label || parts.at(-1) !== filename || !(parts.length === 2 || isArchive) ||
      parts.some((part) => !part || part === '.' || part === '..' || /[\\\0\r\n]/u.test(part))) throw new Error('索引中的报告路径不安全');
  return entry;
}
function archiveNameValid(name) {
  // Historical locations are registered facts: changing the runtime timezone
  // must not reinterpret a directory selected by an earlier collection.
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3])-([0-5]\d)(?: \((?:[2-9]|[1-9]\d+)\))?$/u.exec(name);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}
function indexValid(index) {
  if (!strictKeys(index, ['version', 'reports']) || index.version !== 1 || !Array.isArray(index.reports)) throw new Error('.index.json 损坏，拒绝覆盖');
  index.reports.forEach(rowValid);
  if (new Set(index.reports.map(identity)).size !== index.reports.length || new Set(index.reports.map((row) => row.report)).size !== index.reports.length) throw new Error('.index.json 存在重复运行或报告路径');
  return index;
}
async function verifyRows(dir, rows) {
  for (const row of rows) {
    const base = join(dir, dirname(row.report));
    await managedFile(base, '.report.json');
    const metadata = await optionalJson(join(base, '.report.json'));
    if (!metadata || !same(metadataValid(metadata), withoutReport(row)) || !await managedFile(base, reportFilename(row))) throw new Error('索引与 .report.json 的运行目录或登记内容不一致，拒绝覆盖');
    for (const path of metadata.files) await managedFile(base, path);
  }
}
function nextIndex(before, metadata, previous, target, archive) {
  let reports = [...before.reports];
  if (archive) {
    reports = reports.filter((entry) => identity(entry) !== identity(previous));
    reports.push({ ...previous, report: `${archive}/${reportFilename(previous)}` });
  }
  reports = reports.filter((entry) => identity(entry) !== identity(metadata));
  reports.push({ ...metadata, report: `${target}/${reportFilename(metadata)}` });
  reports.sort((left, right) => Date.parse(right.generated_at) - Date.parse(left.generated_at));
  return indexValid({ version: 1, reports });
}
function relocatedIndex(before, previous, archive) {
  if (!previous) return null;
  const reports = before.reports.filter((entry) => identity(entry) !== identity(previous));
  // Same-run replacement first revokes every old check detail/hash in both
  // indexes. A partially installed body can only be labelled unverified.
  reports.push(archive ? { ...previous, report: `${archive}/${reportFilename(previous)}` }
    : { ...previous, check: { ok: false, blocking: [{ type: 'collection_pending', detail: '收录进行中，正文与校验状态待提交' }] },
      feishu: previous.feishu.doc_url || previous.feishu.workbook_url || ['已同步', '同步未完成'].includes(previous.feishu.status)
        ? { ...previous.feishu, status: '同步归属未验证（收录进行中）' } : previous.feishu,
      report: before.reports.find((row) => identity(row) === identity(previous)).report });
  reports.sort((left, right) => Date.parse(right.generated_at) - Date.parse(left.generated_at));
  return indexValid({ version: 1, reports });
}
function expectedVersions(indexBefore, markdownBefore, relocated, after, timeZone) {
  return {
    expected_index: { before: indexBefore === null ? null : sha(indexBefore), relocated: relocated ? sha(json(relocated)) : null, after: sha(json(after)) },
    expected_markdown: { before: markdownBefore, relocated: relocated ? sha(renderIndex(relocated.reports, timeZone)) : null, after: sha(renderIndex(after.reports, timeZone)) },
  };
}
async function inventoryDirectory(base, inventory, allowMissing = false) {
  if (!await directoryChain(base)) {
    if (allowMissing) return;
    throw new Error('收录暂存目录缺失，无法恢复');
  }
  const expected = new Set(inventory.map((file) => file.path));
  for (const name of await fs.readdir(base)) {
    if (name === 'charts' && inventory.some((file) => file.path.startsWith('charts/'))) {
      await directoryChain(join(base, 'charts'));
      for (const file of await fs.readdir(join(base, 'charts'))) if (!expected.has(`charts/${file}`)) throw new Error('收录暂存/归档目录含未登记文件，拒绝操作');
    } else if (!expected.has(name)) throw new Error('收录暂存/归档目录含未登记文件，拒绝操作');
  }
  for (const file of inventory) {
    const actual = await fileHash(join(base, file.path));
    if (actual !== file.sha256 && !(allowMissing && actual === null)) throw new Error(`收录登记文件哈希不符或缺失：${file.path}`);
  }
}
async function cleanupStage(dir, journal) {
  const base = join(dir, journal.staging);
  await inventoryDirectory(base, journal.new_files, true);
  for (const file of journal.new_files) if (await exists(join(base, file.path))) await fs.unlink(join(base, file.path));
  if (await exists(join(base, 'charts'))) await fs.rmdir(join(base, 'charts'));
  if (await exists(base)) await fs.rmdir(base);
}
function journalValid(journal) {
  if (!strictKeys(journal, ['version', 'id', 'phase', 'staging', 'target', 'archive', 'metadata', 'previous', 'old_files', 'new_files', 'index_before', 'markdown_before', 'expected_index', 'expected_markdown', 'time_zone']) ||
      journal.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(journal.id ?? '') || !PHASES.includes(journal.phase) ||
      journal.staging !== `.collect-${journal.id}` || (journal.index_before !== null && typeof journal.index_before !== 'string') || !hashValue(journal.markdown_before) ||
      typeof journal.time_zone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/u.test(journal.time_zone)) throw new Error('收录恢复日志格式或阶段无效');
  try { new Intl.DateTimeFormat('en-US', { timeZone: journal.time_zone }); }
  catch { throw new Error('收录恢复日志时区无效'); }
  const metadata = metadataValid(journal.metadata), previous = journal.previous && metadataValid(journal.previous);
  const before = indexValid(journal.index_before === null ? { version: 1, reports: [] } : JSON.parse(journal.index_before));
  const indexed = before.reports.find((row) => identity(row) === identity(metadata));
  const target = indexed ? dirname(indexed.report) : labelDirectory(metadata.label);
  if (journal.target !== target || (previous && previous.label !== metadata.label)) throw new Error('收录恢复日志目标与索引不一致');
  const occupant = before.reports.find((row) => dirname(row.report) === target);
  if ((previous && (!occupant || !same(withoutReport(occupant), previous))) || (!previous && occupant)) throw new Error('收录恢复日志旧版本与索引不一致');
  if (before.reports.some((row) => row.run_dir === metadata.run_dir && row.release_id !== metadata.release_id)) throw new Error('同一运行不能改变已登记数据代次，拒绝恢复');
  const archiveRequired = previous && previous.run_dir !== metadata.run_dir;
  if (archiveRequired) {
    rowValid({ ...previous, report: `${journal.archive}/${reportFilename(previous)}` });
    if (target !== labelDirectory(metadata.label) || !journal.archive?.startsWith(`${target}/历史/`) || before.reports.some((row) => dirname(row.report) === journal.archive)) throw new Error('收录恢复日志归档目标无效');
  } else if (journal.archive !== null || (!previous && ['relocating_index', 'relocating_markdown'].includes(journal.phase))) throw new Error('收录恢复日志含多余归档目标或阶段');
  for (const [inventory, files, missing] of [[journal.old_files, previous?.files ?? [], true], [journal.new_files, metadata.files, false]]) {
    if (!Array.isArray(inventory) || inventory.length !== files.length || inventory.some((file, at) =>
      !strictKeys(file, ['path', 'sha256']) || file.path !== files[at] || !hashValue(file.sha256) || (!missing && file.sha256 === null))) throw new Error('收录恢复日志登记清单或哈希无效');
  }
  const stagedMetadata = journal.new_files.find((file) => file.path === '.report.json');
  if (stagedMetadata.sha256 !== sha(json(metadata))) throw new Error('收录恢复日志元数据哈希无效');
  const after = nextIndex(before, metadata, previous, target, journal.archive), relocated = relocatedIndex(before, previous, journal.archive);
  const expected = expectedVersions(journal.index_before, journal.markdown_before, relocated, after, journal.time_zone);
  if (!same(journal.expected_index, expected.expected_index) || !same(journal.expected_markdown, expected.expected_markdown)) throw new Error('收录恢复日志索引期望版本无效');
  return { before, after, relocated };
}
async function setPhase(dir, journal, phase) {
  if (PHASES.indexOf(journal.phase) >= PHASES.indexOf(phase)) return;
  journal.phase = phase;
  await atomicWrite(join(dir, JOURNAL), json(journal));
}
async function replay(dir, journal) {
  const { before, after, relocated } = journalValid(journal);
  const atLeast = (phase) => PHASES.indexOf(journal.phase) >= PHASES.indexOf(phase);
  const afterContent = json(after), indexVersion = journal.expected_index, markdownVersion = journal.expected_markdown;
  const indexPath = join(dir, '.index.json'), markdownPath = join(dir, '索引.md'), markdown = renderIndex(after.reports, journal.time_zone);
  const currentIndex = await fileHash(indexPath), currentMarkdown = await fileHash(markdownPath);
  const baseIndex = relocated ? indexVersion.relocated : indexVersion.before;
  const baseMarkdown = relocated ? markdownVersion.relocated : markdownVersion.before;
  const allowedIndex = {
    prepared: [indexVersion.before], archiving: [indexVersion.before],
    relocating_index: [indexVersion.before, indexVersion.relocated], relocating_markdown: [indexVersion.relocated],
    replacing: [baseIndex], indexing: [baseIndex, indexVersion.after], rendering: [indexVersion.after], committed: [indexVersion.after],
  }[journal.phase];
  const allowedMarkdown = {
    prepared: [markdownVersion.before], archiving: [markdownVersion.before], relocating_index: [markdownVersion.before],
    relocating_markdown: [markdownVersion.before, markdownVersion.relocated], replacing: [baseMarkdown], indexing: [baseMarkdown],
    rendering: [baseMarkdown, markdownVersion.after], committed: [markdownVersion.after],
  }[journal.phase];
  if (!allowedIndex.includes(currentIndex) || !allowedMarkdown.includes(currentMarkdown)) throw new Error('收录恢复失败：索引已偏离日志当前阶段的期望版本，拒绝覆盖');
  const changed = new Set([identity(journal.metadata), ...(journal.previous ? [identity(journal.previous)] : [])]);
  await verifyRows(dir, before.reports.filter((row) => !changed.has(identity(row))));
  if (!atLeast('committed')) await inventoryDirectory(join(dir, journal.staging), journal.new_files);
  // A previous rename may have completed while its parent-directory sync failed.
  // Make the validated write-ahead record durable before resuming any changes.
  await syncPath(join(dir, JOURNAL));
  await syncPath(dir);
  const target = join(dir, journal.target), archive = journal.archive && join(dir, journal.archive);
  await managedDirectory(target);
  for (const file of [...journal.old_files, ...journal.new_files]) await managedFile(target, file.path);
  await setPhase(dir, journal, 'archiving');
  if (archive) {
    await managedDirectory(archive);
    // Only the recorded archive's inventory is inspected, never the report root.
    await inventoryDirectory(archive, journal.old_files, true);
    for (const file of journal.old_files) {
      const source = join(target, file.path), destination = join(archive, file.path);
      const destinationHash = await fileHash(destination), sourceHash = await fileHash(source);
      if (destinationHash === file.sha256) {
        if (!atLeast('replacing') && sourceHash !== null) throw new Error('收录恢复失败：归档源和目标同时存在');
        if (destinationHash !== null) {
          await syncPath(dirname(source));
          await syncPath(dirname(destination));
        }
        continue;
      }
      if (atLeast('replacing') || destinationHash !== null || sourceHash !== file.sha256 || file.sha256 === null) throw new Error('收录恢复失败：归档文件状态与日志不一致');
      await managedDirectory(dirname(destination));
      await fs.rename(source, destination);
      await syncPath(dirname(source));
      await syncPath(dirname(destination));
    }
  }
  // Both indexes must relocate old links or revoke old validation before any
  // replacement bytes are installed, including an update of the same run.
  if (relocated && !atLeast('replacing')) {
    await setPhase(dir, journal, 'relocating_index');
    if (currentIndex !== indexVersion.relocated) await atomicWrite(indexPath, json(relocated));
    await setPhase(dir, journal, 'relocating_markdown');
    if (currentMarkdown !== markdownVersion.relocated) await atomicWrite(markdownPath, renderIndex(relocated.reports, journal.time_zone));
  }
  await setPhase(dir, journal, 'replacing');
  for (const file of journal.old_files.filter((old) => !journal.new_files.some((fresh) => fresh.path === old.path))) {
    const path = join(target, file.path), actual = await fileHash(path);
    if (actual !== null && (archive || actual !== file.sha256)) throw new Error('收录恢复失败：待移除登记文件已被修改');
    if (actual !== null) { await fs.unlink(path); await syncPath(dirname(path)); }
  }
  for (const file of journal.new_files) {
    const path = join(target, file.path), actual = await fileHash(path);
    if (actual === file.sha256) { await syncPath(dirname(path)); continue; }
    const oldHash = archive ? null : journal.old_files.find((old) => old.path === file.path)?.sha256 ?? null;
    if (atLeast('indexing') || actual !== oldHash) throw new Error('收录恢复失败：待替换文件已偏离登记版本');
    await managedDirectory(dirname(path));
    await atomicWrite(path, await fs.readFile(join(dir, journal.staging, file.path)));
  }
  await setPhase(dir, journal, 'indexing');
  if (await fileHash(indexPath) !== indexVersion.after) await atomicWrite(indexPath, afterContent);
  await setPhase(dir, journal, 'rendering');
  if (await fileHash(markdownPath) !== markdownVersion.after) await atomicWrite(markdownPath, markdown);
  await verifyRows(dir, after.reports);
  await setPhase(dir, journal, 'committed');
  await cleanupStage(dir, journal);
  await fs.unlink(join(dir, JOURNAL));
  await syncPath(dir);
  return { report: join(target, reportFilename(journal.metadata)), archived_previous: archive, feishu: journal.metadata.feishu };
}

async function releaseLock(path, held) {
  const owns = (actual) => actual?.isDirectory() && !actual.isSymbolicLink() && actual.ino === held.ino && actual.dev === held.dev;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const actual = await exists(path);
      if (!actual) return;
      if (!owns(actual)) throw new Error('锁已被替换，保留其他进程的锁');
      if ((await fs.readdir(path)).length) throw new Error('锁目录含文件，拒绝自动清理');
      if (!owns(await exists(path))) throw new Error('锁已被替换，保留其他进程的锁');
      await fs.rmdir(path);
      return;
    } catch (error) {
      // A lost rmdir response can be reconciled by absence. A replacement
      // never authorizes another removal attempt.
      let actual;
      try { actual = await exists(path); }
      catch { throw error; }
      if (!actual) return;
      if (!owns(actual)) throw new Error(`锁已被替换，保留其他进程的锁；${error.message}`);
      if (error.code !== 'EIO' || attempt === 3) throw error;
      await new Promise((done) => setTimeout(done, 10));
    }
  }
}

/** Local-only collection. A write-ahead journal rolls interrupted operations
 * forward before a new run is inspected. Original runs and user files stay put. */
export async function collect({ runDir, outputEnv }) {
  let dir = join(homedir(), 'Documents', '战略季报');
  let report = null, index = join(dir, '索引.md'), archivedPrevious = null, feishu = { status: '未同步' };
  let staging, stagedInventory = [], lock, journalWritten = false, recoveredArchive = null;
  let outcome, collectionCompleted = false;
  try {
    runDir = resolve(runDir);
    outputEnv = await boundOutput(runDir, outputEnv);
    const config = await outputConfig(outputEnv);
    if (config.report_dir) {
      if (!isAbsolute(config.report_dir) || /[\r\n\0]/u.test(config.report_dir)) throw new Error('report_dir 必须是无换行的绝对路径');
      dir = resolve(config.report_dir);
    }
    index = join(dir, '索引.md');
    await managedDirectory(dir);
    const lockPath = join(dir, '.collect.lock');
    try { await fs.mkdir(lockPath); lock = await fs.lstat(lockPath); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('本地报告目录正在收录，或上次中断留下 .collect.lock；确认没有收录进程后移除该目录再重试'); throw error; }
    for (const path of [index, join(dir, '.index.json'), join(dir, JOURNAL)]) await plainFile(path);
    const pending = await optionalJson(join(dir, JOURNAL));
    if (pending) {
      try {
        const recovered = await replay(dir, pending);
        if (pending.metadata.run_dir === runDir) recoveredArchive = recovered.archived_previous;
      }
      catch (error) { throw new Error(`收录恢复失败，保留日志与暂存文件：${error.message ?? error}`); }
    }
    // Recovery precedes even reading the requested run: an absent current draft
    // must not leave the previous operation's index pointing at replacement bytes.
    await directoryChain(runDir);
    await plainFile(join(runDir, 'manifest.json'));
    await plainFile(join(runDir, 'report.md'));
    const manifestSnapshot = await inputSnapshot(join(runDir, 'manifest.json'));
    if (!manifestSnapshot) throw Object.assign(new Error('ENOENT：manifest.json 不存在'), { code: 'ENOENT' });
    const manifest = JSON.parse(manifestSnapshot.bytes.toString('utf8'));
    const labelDir = labelDirectory(manifest.label), filename = reportFilename(manifest);
    const snapshot = await reportSnapshot(join(runDir, 'report.md'));
    const markdown = snapshot.bytes.toString('utf8');
    const generatedAt = new Date(Number(snapshot.stat.mtimeNs / 1000000n)).toISOString();
    let view, inputError;
    try {
      view = await captureInputs(runDir, { reportSnapshot: snapshot, manifestSnapshot });
      await view.assertUnchanged();
    } catch (error) { view = null; inputError = error.message; }
    let checked;
    try { checked = await optionalJson(join(runDir, 'check.json')); } catch { /* collect failed checks too */ }
    const binding = checkBinding(checked, snapshot.sha256, view?.binding);
    if (inputError) Object.assign(binding, { available: false, reason: `校验输入不可用：${inputError}` });
    const check = binding.available
      ? { ok: checked.ok, blocking: checked.blocking, report_sha256: snapshot.sha256 }
      : { ok: false, blocking: [{ type: 'check_unavailable', detail: binding.reason }] };
    feishu = await feishuStatus(runDir, config, view, snapshot.sha256);
    const indexBefore = await plainFile(join(dir, '.index.json')) ? await fs.readFile(join(dir, '.index.json'), 'utf8') : null;
    if (indexBefore === null && await plainFile(index)) throw new Error('拒绝覆盖未登记的用户索引文件：索引.md');
    const savedIndex = indexValid(indexBefore === null ? { version: 1, reports: [] } : JSON.parse(indexBefore));
    await verifyRows(dir, savedIndex.reports);
    if (savedIndex.reports.some((row) => row.run_dir === runDir && row.release_id !== manifest.release_id)) throw new Error('同一运行不能改变已登记数据代次，拒绝覆盖');
    const indexed = savedIndex.reports.find((entry) => entry.label === manifest.label && entry.run_dir === runDir);
    const targetRelative = indexed ? dirname(indexed.report) : labelDir;
    const target = join(dir, targetRelative);
    report = join(target, filename);
    await managedDirectory(target);
    await managedFile(target, '.report.json');
    const previous = await optionalJson(join(target, '.report.json'));
    if (previous) metadataValid(previous);
    if (previous?.label !== undefined && previous.label !== manifest.label) throw new Error('.report.json 标签目录冲突，拒绝覆盖');
    const occupant = savedIndex.reports.find((row) => dirname(row.report) === targetRelative);
    if ((previous && (!occupant || !same(previous, withoutReport(occupant)))) || (!previous && occupant)) throw new Error('索引与 .report.json 的运行目录或登记内容不一致，拒绝覆盖');
    const oldFiles = previous?.files ?? [];
    const oldInventory = [];
    for (const path of oldFiles) oldInventory.push({ path, sha256: await fileHash(join(target, path)) });
    const id = randomUUID();
    staging = join(dir, `.collect-${id}`);
    await fs.mkdir(staging);
    await fs.writeFile(join(staging, filename), snapshot.bytes, { flag: 'wx', mode: 0o600 });
    stagedInventory.push({ path: filename, sha256: snapshot.sha256 });
    const chartFiles = [], missingCharts = [];
    for (const path of chartReferences(markdown)) {
      await managedFile(runDir, path);
      const image = view ? view.snapshot(path) : await inputSnapshot(join(runDir, path));
      if (!image) { missingCharts.push(path); continue; }
      await managedDirectory(dirname(join(staging, path)));
      await fs.writeFile(join(staging, path), image.bytes, { flag: 'wx', mode: 0o600 });
      stagedInventory.push({ path, sha256: await fileHash(join(staging, path)) });
      chartFiles.push(path);
    }
    const files = [filename, ...chartFiles, '.report.json'];
    for (const path of files) if (await managedFile(target, path) && !oldFiles.includes(path)) throw new Error(`拒绝覆盖用户文件：${join(target, path)}`);
    const metadata = metadataValid(redact({ version: 1, label: manifest.label, report_name: manifest.report_name, run_dir: runDir,
      release_id: manifest.release_id, generated_at: generatedAt, check, feishu, files,
      ...(missingCharts.length ? { missing_charts: missingCharts } : {}) }));
    await atomicWrite(join(staging, '.report.json'), json(metadata));
    stagedInventory.push({ path: '.report.json', sha256: sha(json(metadata)) });
    let archive = null;
    if (previous && previous.run_dir !== runDir) {
      const base = `${targetRelative}/历史/${localTime(previous.generated_at, true)}`;
      archive = base;
      let suffix = 2;
      await directoryChain(join(target, '历史'));
      while (await exists(join(dir, archive))) archive = `${base} (${suffix++})`;
      archivedPrevious = join(dir, archive);
    }
    const journal = { version: 1, id, phase: 'prepared', staging: relative(dir, staging), target: targetRelative, archive,
      metadata, previous, old_files: oldInventory, new_files: stagedInventory, index_before: indexBefore,
      markdown_before: await fileHash(index), time_zone: new Intl.DateTimeFormat().resolvedOptions().timeZone };
    Object.assign(journal, expectedVersions(indexBefore, journal.markdown_before, relocatedIndex(savedIndex, previous, archive), nextIndex(savedIndex, metadata, previous, targetRelative, archive), journal.time_zone));
    journalValid(journal);
    for (const file of stagedInventory) await syncPath(join(staging, file.path));
    if (chartFiles.length) await syncPath(join(staging, 'charts'));
    await syncPath(staging);
    // Nothing registered has moved, been overwritten or been removed yet.
    await boundOutput(runDir, outputEnv);
    journalWritten = true;
    await atomicWrite(join(dir, JOURNAL), json(journal));
    const result = await replay(dir, journal);
    collectionCompleted = true;
    staging = null;
    return outcome = { ok: true, dir, report: result.report, index, archived_previous: result.archived_previous ?? recoveredArchive, feishu: result.feishu };
  } catch (error) {
    // A failed initial rename may have left no journal at all. Clean only this
    // process's known stage; if journal presence cannot be proven, preserve it.
    if (staging && journalWritten) {
      try { if (await fileHash(join(dir, JOURNAL)) === null) journalWritten = false; } catch { /* preserve uncertain state */ }
    }
    return outcome = redact({ ok: false, dir, report, index, archived_previous: archivedPrevious, feishu, error: error.message ?? String(error) });
  } finally {
    // Pending transactions keep their immutable staging bytes for recovery.
    if (staging && !journalWritten) await cleanupStage(dir, { staging: relative(dir, staging), new_files: stagedInventory }).catch(() => {});
    if (lock) {
      const lockPath = join(dir, '.collect.lock');
      try { await releaseLock(lockPath, lock); }
      catch (error) {
        const cleanup = redact({ ok: false, path: lockPath, error: error.message ?? String(error),
          recovery: '确认没有收录进程后，核对锁归属；仅对确认遗留的空锁目录手动 rmdir，含文件或其他进程的锁先人工处理，再重试 collect；原稿、已收录文件与恢复日志均保留' });
        Object.assign(outcome, { ok: false, collection_completed: collectionCompleted, lock_cleanup: cleanup });
        outcome.error ??= `收录${collectionCompleted ? '已完成，但' : '未完成且'}锁清理失败：${lockPath}；${cleanup.error}；${cleanup.recovery}`;
      }
    }
  }
}
