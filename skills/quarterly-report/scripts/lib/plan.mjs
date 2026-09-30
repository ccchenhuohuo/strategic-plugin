import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clean, digest, eid, json, unique, writeArtifact } from './common.mjs';

const GROWTH = 'strategic_market_growth';
const PRICE = 'strategic_price_band_distribution';
const BRAND = 'strategic_brand_view';
const PRODUCT = 'strategic_product_rank';
const METRICS = ['amt_discount', 'units_est', 'weighted_discount_price'];

export function selectedFocus(config, sections) {
  if (!sections) return config.focus;
  return config.focus.filter((focus) => sections.includes(focus.section_no));
}

export function competitionSegments(focus) {
  return focus.competition_segments.map((entry) => typeof entry === 'string'
    ? focus.trend_segments.find((segment) => segment.label === entry) ?? (() => { throw new Error(`未找到竞争分段：${entry}`); })()
    : entry);
}

export function probes(config, window) {
  const parents = [];
  for (const focus of config.focus) {
    for (const segment of [...focus.trend_segments, ...competitionSegments(focus)]) {
      for (const path of segment.paths) if (path.std_l3 !== undefined) {
        const parent = { std_l1: path.std_l1, std_l2: path.std_l2 };
        if (!parents.some((item) => item.std_l1 === parent.std_l1 && item.std_l2 === parent.std_l2)) parents.push(parent);
      }
    }
  }
  return parents.flatMap((parent) => config.sites.map((site) => ({
    key: `P:${site}:${parent.std_l1}:${parent.std_l2}`, tool: GROWTH,
    arguments: { ...window, metrics: ['amt_discount'], group_by: ['std_l3'], filters: { site, ...parent }, compare: ['yoy'], currency: 'cny', display: true },
    parent, site,
  })));
}

export function isL3Unlabelled(response) {
  const rows = response?.data?.rows ?? [];
  const observed = rows.filter((row) => row.values?.amt_discount?.current?.value !== null && row.values?.amt_discount?.current?.value !== undefined);
  return observed.length > 0 && observed.every((row) => row.std_l3 === '未分类');
}

function resolvedPaths(paths, site, unlabelled) {
  const output = [];
  let fallback = false;
  for (const path of paths) {
    const key = `P:${site}:${path.std_l1}:${path.std_l2}`;
    if (path.std_l3 !== undefined && unlabelled.has(key)) {
      fallback = true;
      const parent = { std_l1: path.std_l1, std_l2: path.std_l2 };
      if (!output.some((item) => item.std_l1 === parent.std_l1 && item.std_l2 === parent.std_l2)) output.push(parent);
    } else if (!output.some((item) => JSON.stringify(item) === JSON.stringify(path))) output.push(path);
  }
  return { paths: output, fallback };
}

export function mainCalls(config, focuses, sections, window, unlabelled) {
  const calls = [];
  const add = (key, tool, args, meta = {}) => calls.push({ key, tool, arguments: { ...window, ...args, display: true }, ...meta });
  // G1 is mandatory even in a section trial: it defines the site's complete observed universe.
  add('G1', GROWTH, { metrics: METRICS, group_by: ['site'], currency: 'cny', compare: config.compare });
  if (!sections || sections.includes(2)) {
    add('G2', GROWTH, { metrics: ['amt_discount'], group_by: ['site'], currency: 'cny', decompose: 'shapley_volume_mix_price', mix_by: ['std_l1'], compare: ['yoy'] });
    add('G3', GROWTH, { metrics: ['amt_discount'], group_by: [], currency: 'cny', decompose: 'shapley_volume_mix_price', mix_by: ['site', 'std_l1'], compare: ['yoy'] });
    add('G4', GROWTH, { metrics: METRICS, group_by: ['std_l1'], currency: 'cny', compare: config.compare });
  }
  for (const focus of focuses) {
    const prefix = `F${focus.section_no}`;
    const base = { filters: { std_l1: focus.std_l1 }, currency: 'cny' };
    add(`${prefix}:1`, GROWTH, { ...base, metrics: METRICS, group_by: ['site'], compare: config.compare });
    add(`${prefix}:2`, GROWTH, { ...base, metrics: METRICS, segments: focus.trend_segments, include_remainder: true, group_by: ['segment'], compare: ['yoy'] });
    add(`${prefix}:3`, GROWTH, { ...base, metrics: METRICS, segments: focus.trend_segments, include_remainder: true, group_by: ['segment', 'site'], compare: ['yoy'] });
    add(`${prefix}:4`, GROWTH, { ...base, metrics: ['weighted_discount_price'], group_by: ['site'], decompose: 'price_mix', mix_by: [focus.price_mix_by], compare: ['yoy'] });
    for (const site of config.sites) add(`${prefix}:5:${site}`, PRODUCT, { site, paths: [{ std_l1: focus.std_l1 }], top_n: 5, summary: true, compare: ['yoy'] });
    add(`${prefix}:6`, PRICE, { scope: 'cross_site_cny', profile: 'cny', std_l1: focus.std_l1, compare: ['yoy'] });
    for (const site of config.sites) add(`${prefix}:7:${site}`, PRICE, { scope: 'single_site', site, profile: 'cny', std_l1: focus.std_l1, compare: ['yoy'] });
    for (const segment of competitionSegments(focus)) for (const site of config.sites) {
      const resolved = resolvedPaths(segment.paths, site, unlabelled);
      add(`B1:${focus.section_no}:${segment.label}:${site}`, BRAND, { site, paths: resolved.paths, metric: 'amt_discount', top_n: 10, include_brands: config.company_brands, currency: 'cny', compare: ['yoy'] }, { focus: focus.section_no, segment: segment.label, site, fallback: resolved.fallback, paths: resolved.paths });
    }
  }
  return calls;
}

export function pickBrands(data, companyBrands, limit) {
  const company = new Set(companyBrands);
  const observed = (data?.rows ?? []).filter((row) => row.current?.rank !== null && row.current?.rank !== undefined && row.current?.amt_discount !== null && row.current?.amt_discount !== undefined);
  const named = observed.filter((row) => row.brand && !company.has(row.brand) && !['OTHERS/其他', '其他', '未分类'].includes(row.brand) && row.brand_kind !== 'others_bucket' && row.brand_kind !== 'unclassified');
  named.sort((left, right) => left.current.rank - right.current.rank || String(left.brand).localeCompare(String(right.brand), 'zh'));
  return { competitors: unique(named.map((row) => row.brand)).slice(0, limit), company: companyBrands.filter((brand) => observed.some((row) => row.brand === brand)) };
}

export function dependentCalls(config, b1Calls, results, window) {
  const calls = [];
  const selected = {};
  for (const call of b1Calls) {
    const envelope = results.get(call.key)?.envelope;
    if (!envelope) { selected[call.key] = { competitors: [], company: [], failed: true }; continue; }
    const brands = pickBrands(envelope.data, config.company_brands, config.drilldown.competitor_brands);
    selected[call.key] = brands;
    const base = { ...window, site: call.site, paths: call.paths, top_n: config.drilldown.products_per_brand, compare: ['yoy'], currency: 'cny', display: true };
    if (brands.competitors.length) calls.push({ key: call.key.replace('B1:', 'B2:'), tool: PRODUCT, arguments: { ...base, brands: brands.competitors }, source: call.key });
    if (brands.company.length) calls.push({ key: call.key.replace('B1:', 'B3:'), tool: PRODUCT, arguments: { ...base, brands: brands.company, top_n: config.drilldown.company_products_per_brand }, source: call.key });
  }
  return { calls, selected };
}

export async function executeStage(client, stage, context) {
  const { results, runDir, secret, concurrency, releaseId } = context;
  const numbered = stage.map((call) => ({ ...call, id: eid(++context.nextEvidence) }));
  let next = 0;
  async function worker() {
    while (next < numbered.length) {
      const call = numbered[next++];
      const args = { ...call.arguments, ...(releaseId ? { release_id: releaseId } : {}) };
      const reused = context.resume && runDir ? await reusableEvidence(runDir, call, args) : null;
      if (reused) {
        results.set(call.key, { ...call, ...reused });
        console.error(clean(`${call.id} ${call.key}: reused`, secret));
        continue;
      }
      const calledAt = new Date().toISOString();
      let record;
      try {
        const envelope = clean(await client.call(call.tool, args), secret);
        const observedRelease = envelope.stamp?.release_id;
        if (releaseId && observedRelease !== releaseId) throw new Error(`release_id 不一致：预期 ${releaseId}，返回 ${observedRelease ?? '缺失'}`);
        record = { id: call.id, tool: call.tool, arguments: args, ok: true, envelope, called_at: calledAt };
      } catch (error) {
        record = { id: call.id, tool: call.tool, arguments: args, ok: false, error: { message: clean(error.message ?? String(error), secret), ...(error.code ? { code: error.code } : {}) }, called_at: calledAt };
      }
      results.set(call.key, { ...call, ...record });
      // 逐次落盘：进程被超时或中断杀掉时，已完成的调用可由 --resume 复用
      if (runDir) await writeEvidence(runDir, record, secret);
      console.error(clean(`${call.id} ${call.key}: ${record.ok ? 'ok' : 'failed'}`, secret));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, numbered.length) }, () => worker()));
  if (runDir) await persistStage(numbered, results, runDir, secret);
  return numbered;
}

const evidenceText = (record, secret) => json(clean({ id: record.id, tool: record.tool, arguments: record.arguments, ok: record.ok, ...(record.ok ? { envelope: record.envelope } : { error: record.error }), called_at: record.called_at }, secret));
async function writeEvidence(runDir, record, secret) {
  await writeArtifact(runDir, `evidence/${record.id}.json`, evidenceText(record, secret));
}
/** 只复用「同一证据号、同一工具、同一参数（含 release_id）且成功」的证据；其余一律重取。 */
async function reusableEvidence(runDir, call, args) {
  let saved;
  try { saved = JSON.parse(await readFile(join(runDir, `evidence/${call.id}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!saved.ok || saved.tool !== call.tool || digest(saved.arguments) !== digest(args)) return null;
  return { id: saved.id, tool: saved.tool, arguments: saved.arguments, ok: true, envelope: saved.envelope, called_at: saved.called_at };
}

export async function persistStage(numbered, results, runDir, secret) {
  for (const call of numbered) {
    const record = results.get(call.key);
    await writeEvidence(runDir, record, secret);
    const line = { id: record.id, tool: record.tool, arguments_digest: digest(record.arguments), ok: record.ok, query_id: record.envelope?.stamp?.query_id ?? null, release_id: record.envelope?.stamp?.release_id ?? null, error: record.error ?? null };
    await appendFile(join(runDir, 'ledger.jsonl'), JSON.stringify(clean(line, secret)) + '\n');
  }
}

export function observedSites(g1) {
  return unique((g1?.data?.rows ?? []).filter((row) => row.values?.amt_discount?.current?.value !== null && row.values?.amt_discount?.current?.value !== undefined).map((row) => row.site));
}
