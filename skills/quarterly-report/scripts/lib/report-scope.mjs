// Local report identity, not a second source of country/business policy. The
// governed platform/site/currency/start contract comes only from this release.
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { asArray, digest, inputParents, readJson, safeName, unique } from './common.mjs';

export const RESOLVED_CONFIG = 'resolved-config.json';
export const DEFAULT_CONFIG = new URL('../../config/vijim-default-v1.7.json', import.meta.url);
const legacyConfig = new URL('../../config/vijim-default.json', import.meta.url);
// Registered historical JSON-object digest; never migrate a custom config or
// rewrite the original config_digest/ledger to make an upgrade appear compatible.
export const LEGACY_DEFAULT_DIGEST = '080599d4508b5e11';
const fields = ['release_id', 'build_id', 'table_spec_version', 'pipeline_version', 'scope_version', 'currency_mapping_version', 'currency_mapping_content_hash', 'fx_snapshot_id', 'band_policy_version', 'band_content_hash', 'mapping_version', 'mapping_content_hash'];
const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const text = (value) => typeof value === 'string' && value.length > 0 && value === value.trim();
const equal = (a, b, message) => { if (!isDeepStrictEqual(a, b)) throw new Error(message); };
const pair = ({ platform, site }) => `${platform}/${site}`;
const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
const monthAt = (index) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
const monthsOf = ({ start, end }) => Array.from({ length: monthIndex(end) - monthIndex(start) + 1 }, (_, i) => monthAt(monthIndex(start) + i));

export function reportWindows(start, end) {
  if (!monthPattern.test(start) || !monthPattern.test(end) || end < start || monthIndex(end) - monthIndex(start) >= 12) throw new Error('报告窗口须为最长 12 个连续完整月');
  const first = monthIndex(start), last = monthIndex(end), length = last - first + 1;
  return { current: { start, end }, yoy: { start: monthAt(first - 12), end: monthAt(last - 12) }, prior_period: { start: monthAt(first - length), end: monthAt(first - 1) } };
}

function frozenSites(rows, version) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('冻结站点合同缺失');
  const seen = new Set(), currencies = new Map();
  const sites = rows.map((row) => {
    if (!row || !['platform', 'site', 'currency_code', 'valid_from', 'currency_mapping_version'].every((key) => text(row[key]))
      || !/^[A-Za-z]+$/u.test(row.site) || !/^[A-Z]{3}$/u.test(row.currency_code) || !/^\d{4}-(?:0[1-9]|1[0-2])-01$/u.test(row.valid_from)
      || row.currency_mapping_version !== version) throw new Error('冻结站点合同的组合、币种、月首起点或版本非法');
    if (seen.has(pair(row))) throw new Error(`冻结站点合同组合重复：${pair(row)}`);
    seen.add(pair(row));
    if (currencies.has(row.site) && currencies.get(row.site) !== row.currency_code) throw new Error(`展示组 ${row.site} 包含多个币种，不能自动合并`);
    currencies.set(row.site, row.currency_code);
    return Object.fromEntries(['platform', 'site', 'currency_code', 'valid_from', 'currency_mapping_version'].map((key) => [key, row[key]]));
  });
  return sites.sort((a, b) => pair(a) < pair(b) ? -1 : pair(a) > pair(b) ? 1 : 0);
}

export function reportBinding(stamp) {
  if (!stamp || !fields.every((field) => text(stamp[field]))) throw new Error('报告完整绑定身份缺失（release/build/scope/币种映射/FX/政策/类目映射）');
  if (stamp.scope?.version !== stamp.scope_version) throw new Error('stamp.scope 版本与冻结 scope_version 不一致');
  return { ...Object.fromEntries(fields.map((field) => [field, stamp[field]])), sites: frozenSites(stamp.scope.sites, stamp.currency_mapping_version) };
}

export function assertReportBinding(envelope, binding) {
  equal(reportBinding(envelope?.stamp), binding, '报告完整绑定身份不一致（含 build、站点起点、币种/FX/政策/映射身份），拒绝混用证据');
}

export function resolveReportConfig(source, status, window) {
  const binding = reportBinding(status?.stamp);
  equal(frozenSites(status?.data?.site_coverage, binding.currency_mapping_version), binding.sites, 'data_status.site_coverage 与 stamp.scope.sites 的冻结合同不一致');
  const available = status?.data?.available_months;
  if (!available || !monthPattern.test(available.start) || !monthPattern.test(available.end) || available.start > available.end) throw new Error('data_status 完整月水位缺失或非法');
  const windows = reportWindows(window.current_start, window.current_end);
  const included = unique(binding.sites.map((row) => row.site));
  let sites;
  if (source.sites === 'bound_release') {
    const order = asArray(source.site_order);
    if (new Set(order).size !== order.length || order.some((site) => !text(site))) throw new Error('配置 site_order 非法');
    sites = [...order.filter((site) => included.includes(site)), ...included.filter((site) => !order.includes(site)).sort()];
  } else {
    if (!Array.isArray(source.sites) || !source.sites.length || new Set(source.sites).size !== source.sites.length) throw new Error('配置 sites 须为 bound_release 或不重复站点数组');
    equal([...source.sites].sort(), [...included].sort(), '配置站点与冻结纳入全集不符；全球分母不得改用共同国家子集');
    sites = [...source.sites];
  }
  const config = { ...source, sites, site_labels: Object.fromEntries(sites.map((site) => [site, source.site_labels?.[site] ?? site])) };
  const site_eligibility = binding.sites.map((row) => ({ platform: row.platform, site: row.site, valid_from: row.valid_from,
    windows: Object.fromEntries(Object.entries(windows).map(([name, interval]) => {
      const missing_months = monthsOf(interval).filter((month) => month < row.valid_from.slice(0, 7) || month > available.end);
      return [name, { status: missing_months.some((month) => month > available.end) ? 'out_of_range' : missing_months.length ? 'not_tracked' : 'complete', missing_months }];
    })) }));
  const invalid = site_eligibility.filter((row) => row.windows.current.status !== 'complete');
  if (invalid.length) throw new Error(`当期窗口不在全部冻结站点受治理区间内，不能裁短或删国：${invalid.map((row) => `${pair(row)} ${row.windows.current.missing_months.join(',')}`).join('；')}`);
  return { version: 1, source_config: source, source_digest: digest(source), config, binding, available_months: { start: available.start, end: available.end }, windows, site_eligibility };
}

const coverageKey = (row) => JSON.stringify([row?.platform, row?.site, row?.from_month, row?.to_month, row?.reason]);
const normalizeCoverage = (coverage) => coverage && { status: coverage.status, missing: [...asArray(coverage.missing)].sort((a, b) => coverageKey(a).localeCompare(coverageKey(b))) };

// Market responses expose a top-level map; brand/price/product expose coverage
// on each window. Read both actual contracts, never invent a missing top level.
export function reportSourceCoverage(envelope) {
  const data = envelope?.data ?? {}, top = data.source_coverage ?? {}, windows = data.windows ?? {};
  const names = unique([...Object.keys(top), ...Object.keys(windows).filter((name) => windows[name]?.source_coverage !== undefined)]);
  return Object.fromEntries(names.map((name) => {
    const outer = top[name], inner = windows[name]?.source_coverage;
    if (outer !== undefined && inner !== undefined) equal(normalizeCoverage(outer), normalizeCoverage(inner), `响应 ${name} 的两处 source_coverage 不一致`);
    return [name, outer !== undefined ? outer : inner];
  }));
}

export function assertReportRecord(record, snapshot) {
  assertReportBinding(record.envelope, snapshot.binding);
  if (record.tool === 'strategic_data_status') {
    equal(resolveReportConfig(snapshot.source_config, record.envelope, { current_start: snapshot.windows.current.start, current_end: snapshot.windows.current.end }), snapshot, 'STATUS 与 resolved 冻结配置不一致');
    return;
  }
  const args = record.arguments ?? {}, data = record.envelope.data, coverage = reportSourceCoverage(record.envelope);
  equal({ start: args.current_start, end: args.current_end }, snapshot.windows.current, '证据请求窗口与 resolved 配置不一致');
  const site = args.site ?? args.filters?.site, platform = args.platform ?? args.filters?.platform;
  const included = snapshot.site_eligibility.filter((row) => (!site || row.site === site) && (!platform || row.platform === platform));
  if (!included.length) throw new Error('证据请求不在冻结站点范围内');
  for (const name of ['current', ...asArray(args.compare)]) {
    const interval = snapshot.windows[name];
    equal({ start: data?.windows?.[name]?.start, end: data?.windows?.[name]?.end }, interval, '响应比较窗口与 resolved 配置不一致');
    const missing = included.flatMap((row) => ['before_tracking', 'after_watermark'].flatMap((reason) => {
      const months = row.windows[name].missing_months.filter((month) => reason === 'before_tracking' ? month < row.valid_from.slice(0, 7) : month > snapshot.available_months.end);
      return months.length ? [{ platform: row.platform, site: row.site, from_month: months[0], to_month: months.at(-1), reason }] : [];
    }));
    const expected = { status: missing.some((row) => row.reason === 'after_watermark') ? 'out_of_range' : missing.length ? 'not_tracked' : 'complete', missing };
    const provided = coverage[name];
    // Old releases may predate source_coverage, but an ineligible comparison can
    // never rely on that omission. This checks metadata, not business arithmetic.
    if (provided !== undefined || missing.length) equal(normalizeCoverage(provided), normalizeCoverage(expected), '响应源覆盖与冻结站点起点/比较资格不一致');
  }
}

export const scopeMarker = (snapshot) => ({ version: 1, sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') });

function validateSnapshot(snapshot, args, manifest) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.binding || !snapshot.source_config) throw new Error('resolved 配置快照缺失或损坏');
  const binding = snapshot.binding;
  const expected = resolveReportConfig(snapshot.source_config, { stamp: { ...binding, scope: { version: binding.scope_version, sites: binding.sites } }, data: { site_coverage: binding.sites, available_months: snapshot.available_months } }, { current_start: args?.current_start, current_end: args?.current_end });
  equal(snapshot, expected, 'resolved 配置、站点起点或比较资格与冻结身份不一致');
  equal(args?.scope_binding, scopeMarker(snapshot), 'run-args 的 resolved 配置绑定缺失或不一致');
  if (args.config_digest !== snapshot.source_digest || args.release_id !== binding.release_id) throw new Error('run-args 配置 digest 或 release 与 resolved 快照不一致');
  if (manifest) {
    equal(manifest.scope_binding, args.scope_binding, 'manifest 的 resolved 配置绑定缺失或不一致');
    if (manifest.release_id !== binding.release_id || manifest.label !== args.label) throw new Error('manifest 与 resolved 运行身份不一致');
    for (const [name, interval] of Object.entries(snapshot.windows)) if (manifest.windows?.[name]) equal({ start: manifest.windows[name].start, end: manifest.windows[name].end }, interval, 'manifest 比较窗口与冻结配置不一致');
  }
  return snapshot;
}

export async function readConfigSource(path, expectedDigest) {
  let config;
  try { config = await readJson(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || basename(path) !== 'vijim-default.json' || expectedDigest !== LEGACY_DEFAULT_DIGEST) throw error;
    config = await readJson(legacyConfig);
    if (digest(config) !== LEGACY_DEFAULT_DIGEST) throw new Error('已登记历史默认配置兼容副本的 digest 不一致');
  }
  if (expectedDigest && digest(config) !== expectedDigest) throw new Error('配置摘要与 run-args.json 的 config_digest 不一致，配置自取数后已变更');
  return config;
}

async function readLocalJson(runDir, name) {
  await inputParents(runDir, name);
  const path = join(runDir, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} 不是普通文件`);
  return readJson(path);
}

function materialPaths(manifest) {
  const tables = [...asArray(manifest.writing_tables), ...asArray(manifest.chapters).flatMap((chapter) => asArray(chapter.tables))];
  return unique([...tables.map((table) => `tables/${safeName(table.table_id)}.json`), ...asArray(manifest.chapters).flatMap((chapter) => asArray(chapter.slots).map((slot) => slot.digest))]);
}

export async function assertResumeMaterials(runDir, snapshot, manifest) {
  // The manifest is committed last. Before that commit a genuine interrupted
  // prepare has no material inventory yet; it may safely resume its evidence.
  if (!manifest) return;
  const marker = scopeMarker(snapshot);
  equal(manifest.scope_binding, marker, 'manifest 的 resolved 配置绑定缺失或不一致');
  for (const path of materialPaths(manifest)) {
    const material = await readLocalJson(runDir, path);
    equal(material?.scope_binding, marker, `表格/摘要 ${path} 的 resolved 配置绑定缺失或不一致`);
  }
}

export async function assertResumeEvidence(runDir, snapshot) {
  let names;
  try { names = await readdir(join(runDir, 'evidence')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names.filter((name) => /^E\d+\.json$/u.test(name))) {
    let record;
    try { record = await readLocalJson(runDir, `evidence/${name}`); }
    catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') continue; throw error; }
    // A missing/truncated response can be re-requested under the exact frozen
    // identity. A readable but different identity must never be silently fixed.
    if (record.ok) assertReportRecord(record, snapshot);
  }
}

export async function readReportConfig(runDir, supplied = {}) {
  const args = supplied.args ?? await readJson(join(runDir, 'run-args.json'));
  const manifest = Object.hasOwn(supplied, 'manifest') ? supplied.manifest : await readJson(join(runDir, 'manifest.json'));
  let snapshot = null;
  try { snapshot = await readLocalJson(runDir, RESOLVED_CONFIG); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (args.scope_binding || manifest?.scope_binding || snapshot) {
    validateSnapshot(snapshot, args, manifest);
    return { config: snapshot.config, source: snapshot.source_config, snapshot };
  }
  if (typeof args.config !== 'string' || !args.config_digest) throw new Error('run-args.json 缺少配置路径或 config_digest');
  const config = await readConfigSource(resolve(runDir, args.config), args.config_digest);
  if (config.sites === 'bound_release') throw new Error('按绑定解析的配置缺少 resolved 身份，拒绝降级为旧运行');
  return { config, source: config, snapshot: null };
}

/** Same captured inputs for assemble/check/publish/collect. Old unmarked runs
 * keep their original contract; a partial deletion of new markers cannot opt out. */
export function assertViewScope(view) {
  const manifest = view.json('manifest.json');
  const args = view.snapshot('run-args.json') ? view.json('run-args.json') : null;
  const snapshot = view.snapshot(RESOLVED_CONFIG) ? view.json(RESOLVED_CONFIG) : null;
  const paths = materialPaths(manifest);
  const materials = paths.flatMap((path) => view.snapshot(path) ? [{ path, data: view.json(path) }] : []);
  if (!args?.scope_binding && !manifest.scope_binding && !snapshot && !materials.some(({ data }) => data.scope_binding)) return null;
  validateSnapshot(snapshot, args, manifest);
  for (const path of paths) {
    const material = materials.find((item) => item.path === path);
    equal(material?.data.scope_binding, args.scope_binding, `表格/摘要 ${path} 的 resolved 配置绑定缺失或不一致`);
  }
  for (const entry of view.text('ledger.jsonl').split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.ok)) {
    const record = view.json(`evidence/${entry.id}.json`);
    assertReportRecord(record, snapshot);
  }
  return snapshot;
}

/** G1 is an observed set, not the inclusion contract. Missing members are legal
 * only when every included platform/month is independently explained as fully
 * excluded; no subset test, no empty-market zero, no unknown evidence waiver. */
export function validateG1(envelope, config, snapshot) {
  const rows = asArray(envelope?.data?.rows), expected = [...config.sites].sort();
  const observed = unique(rows.filter((row) => row.values?.amt_discount?.current?.value != null).map((row) => row.site)).sort();
  if (!snapshot) {
    equal(observed, expected, `G1 当期有观察站点与配置不符：观察到 ${observed.join(',') || '无'}；配置 ${expected.join(',')}`);
    return;
  }
  assertReportBinding(envelope, snapshot.binding);
  if (rows.some((row) => !expected.includes(row.site)) || new Set(rows.map((row) => row.site)).size !== rows.length) throw new Error('G1 出现未知额外站点或重复展示组');
  const months = monthsOf(snapshot.windows.current), contract = snapshot.binding.sites, evidence = new Map();
  for (const record of asArray(envelope.data.source_observations)) {
    const key = `${pair(record)}/${record.month}`;
    if (!contract.some((row) => pair(row) === pair(record)) || !months.includes(record.month) || evidence.has(key)) throw new Error('G1 源观察证据含未知站点、月份或重复组合');
    if (!['participating', 'fully_excluded', 'unknown'].includes(record.status)) throw new Error('G1 源观察状态无法解释');
    evidence.set(key, record);
  }
  for (const site of expected.filter((site) => !observed.includes(site))) {
    for (const row of contract.filter((row) => row.site === site)) for (const month of months) {
      const record = evidence.get(`${pair(row)}/${month}`), counts = record && ['source_rows', 'excluded_conflict_rows', 'excluded_unclassified_rows', 'participating_rows'].map((key) => record[key]);
      // Integrity arithmetic on source coverage counts only, never a report metric.
      if (!record || record.status !== 'fully_excluded' || !counts.every((n) => Number.isSafeInteger(n) && n >= 0) || counts[0] <= 0 || counts[3] !== 0 || BigInt(counts[0]) !== BigInt(counts[1]) + BigInt(counts[2]))
        throw new Error(`G1 当期有观察站点与配置不符：站点 ${site} 当期无观察但缺口无法完整解释：${pair(row)}/${month}；需要全部平台×月份的已闭合全排除证据`);
    }
  }
}

const windowLabel = { current: '当期', yoy: '同比期', prior_period: '环比期' };
export function sourceCoverageNotes(envelope, config = {}) {
  const notes = [];
  for (const [window, coverage] of Object.entries(reportSourceCoverage(envelope))) {
    if (coverage?.status === 'complete') continue;
    const missing = asArray(coverage?.missing).map((item) => `${config.site_labels?.[item.site] ?? item.site}（${pair(item)}，${item.from_month}～${item.to_month}，${({ before_tracking: '早于受治理起点', after_watermark: '超过完整月水位' })[item.reason] ?? item.reason ?? '原因未知'}）`);
    notes.push(`${windowLabel[window] ?? window}站点源覆盖不足（${coverage?.status ?? 'unknown'}）：${missing.join('；') || '缺少可核验的覆盖说明'}；相关比较、份额变化、贡献与分解不可用，不按零或新进增长解释。`);
  }
  const excluded = asArray(envelope?.data?.source_observations).filter((item) => item.status === 'fully_excluded');
  for (const site of unique(excluded.map((item) => item.site))) {
    const rows = excluded.filter((item) => item.site === site);
    notes.push(`${config.site_labels?.[site] ?? site}当期存在源行全排除：${rows.map((item) => `${pair(item)}/${item.month}`).join('、')}；分类范围排除或冲突检疫，不是市场为零。`);
  }
  return unique(notes);
}
