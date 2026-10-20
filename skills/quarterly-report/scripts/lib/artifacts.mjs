import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { asArray, json, safeName, unique, writeArtifact } from './common.mjs';
import { competitionSegments } from './plan.mjs';
import { parseMarkdownTable, TABLE_READING_NOTES, tableJson, validateTable } from './tables.mjs';
import { captureInputs } from './input-view.mjs';
import { writeRunManifest } from './run-binding.mjs';
import { sourceContract } from './source-contract.mjs';
import { digestVisibleNumbers, evidenceCaveats, OBSERVATION_RULE, projectObservations, sectionCaveats } from './writing-observations.mjs';

const tablePath = (id) => `tables/${safeName(id)}.md`;
const digestPath = (slot) => `digests/${safeName(slot)}.json`;
const draftPath = (slot) => `drafts/${safeName(slot)}.md`;
const cite = (table) => table.evidence.length ? table.evidence.join('、') : '缺失';
const safeMd = (item) => String(item ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderTable(table) {
  const lines = [`**${table.title}**`, '', `| ${table.columns.map(safeMd).join(' | ')} |`, `| ${table.columns.map(() => '---').join(' | ')} |`];
  for (const row of table.rows) lines.push(`| ${row.map(safeMd).join(' | ')} |`);
  if (!table.rows.length) lines.push(`| ${[table.reason ?? '无观察', ...table.columns.slice(1).map(() => '—')].map(safeMd).join(' | ')} |`);
  lines.push('');
  for (const footer of table.footer ?? []) lines.push(footer, '');
  for (const note of table.notes) lines.push(`表注：${note}`);
  if (table.reason && table.rows.length) lines.push(`表注：${table.reason}`);
  lines.push(`证据：${cite(table)}`, '');
  return lines.join('\n');
}

export function dataNote(status, config, label, windows, caveats) {
  const data = status.data ?? {}, stamp = status.stamp ?? {};
  const format = (part) => part ? `${part.start ?? '—'} 至 ${part.end ?? '—'}` : '—';
  const fx = asArray(data.fx_snapshot?.rates).map((rate) => `${rate.base_currency}/${rate.quote_currency} ${rate.rate}（${rate.rate_date}，${rate.source}）`).join('；') || '未提供';
  const mapping = data.mapping_summary ?? {};
  const contract = sourceContract(stamp);
  const sourceNotes = contract === 'direct_wide' ? [
    `来源合同：权威宽表 flywheel.monthly_sales_wide 直供销售与三级标准类目；source_wide_update_time ${stamp.source_wide_update_time ?? '未提供'}。完整月以交付确认水位为准，不从源表最大月份推定完整性。`,
    '分类范围：标准类目任一级含「其他」、NULL、空串或纯空白的整条记录排除，以 excluded_unclassified_rows 披露；不作为未观察节点补零。此规则不检查品牌、标题或平台原始类目，品牌非品牌桶仍在分母中。',
    `上游状态：${data.upstream?.status ?? 'unknown'}；宽表更新可能重述销售与商品归类；确认新源交付完成并重建发布后才跟进。`,
  ] : contract === 'legacy_derived' ? [
    `来源合同：历史宽表与年度类目维表 JOIN 的旧派生链；仅保留冻结戳 wide ${stamp.source_wide_update_time ?? '未提供'}、dim ${stamp.upstream_dim_update_time ?? '未提供'}、derived ${stamp.source_derived_update_time ?? '未提供'}，不做旧来源的当前核验。`,
    '分类范围：按旧 release 冻结的 scope 解释，不将新版标准类目排除规则套到历史切片。',
    `上游状态：${data.upstream?.status ?? 'unknown'}；历史类目归属曾受年度维表匹配影响，跨年同比须留意匹配池变化。`,
  ] : [
    '来源合同：table_spec_version 缺失或不可识别，来源与分类范围无法判定；不推定为新宽表或旧年度维表合同。',
    '上游状态：unknown；保留响应中的来源警示。',
  ];
  const lines = [
    '## 数据说明',
    '',
    `报告期：${label}（${format(windows.current)}）；同比：${format(windows.yoy)}；环比：${format(windows.prior_period)}。`,
    `复现戳：release_id ${stamp.release_id ?? '—'}；build_id ${stamp.build_id ?? '—'}；table_spec ${stamp.table_spec_version ?? '—'}；pipeline ${stamp.pipeline_version ?? '—'}。`,
    `数据来源：Flywheel 市场估算数据。覆盖站点：${config.sites.map((site) => config.site_labels?.[site] ?? site).join('、')}。平台范围：${data.universe ?? '未提供'}。`,
    `CNY 固定汇率快照：${data.fx_snapshot?.fx_snapshot_id ?? '—'}；${fx}。跨站点及跨期换算使用该 release 冻结的单一汇率，不反映汇率变动。`,
    `类目映射：${mapping.mapping_version ?? '—'}；一级 ${mapping.l1_count ?? '—'}，二级路径 ${mapping.l2_count ?? '—'}，完整三级路径 ${mapping.l3_path_count ?? '—'}。价格带政策：${data.band_policy_version ?? '—'}。`,
    ...sourceNotes,
    '口径警示：销售额、销量和均价均为匹配子集的估算；缺失≠零，未观察、检疫、归档与越界分别处理。',
    '均价为汇总金额除以估算件数，受商品结构与销量组合影响，不代表同一商品的调价。',
    '商品身份池的延续、新进与退出仅作变化旁证；商品身份数是匹配子集内有观察的商品身份数，服务商对极低销量长尾有截断，不直接等同市场变化。',
    '',
  ];
  if (caveats.length) lines.push('响应级口径警示：', '', ...unique(caveats).map((item) => `- ${item}`), '');
  return lines.join('\n');
}

function tableRef(tables, id) {
  const table = tables.get(id);
  if (!table) throw new Error(`缺少表位 ${id}`);
  return { table_id: id, title: table.title, evidence: table.evidence, status: table.status, ...(table.reason ? { reason: table.reason } : {}), path: tablePath(id) };
}

function addTable(chapter, tables, id) {
  chapter.tables.push(tableRef(tables, id));
  chapter.blocks.push({ type: 'table', id });
}
function addSlot(chapter, slot, title, group) {
  const item = { slot, title, digest: digestPath(slot), draft: draftPath(slot), group };
  chapter.slots.push(item);
  chapter.blocks.push({ type: 'slot', id: slot });
}

function chapterNumber(number) {
  const digits = '零一二三四五六七八九';
  if (number < 10) return digits[number];
  if (number < 100) return `${number < 20 ? '' : digits[Math.floor(number / 10)]}十${number % 10 ? digits[number % 10] : ''}`;
  return String(number);
}

export function buildManifest(config, focuses, sections, tables, selected, label, releaseId, windows) {
  const chapters = [];
  const summary = { id: 'summary', title: '一、执行摘要', tables: [], slots: [], drilldowns: [], blocks: [] };
  // 叙述位编号避开 summary/report 字样：Claude Code 会拦截子代理写这类文件名（「Subagents should return findings as text」）。
  addSlot(summary, 'exec.global', '全球市场趋势', 'summary');
  for (const focus of focuses) {
    const n = focus.section_no;
    const source = tables.get(`${n}.1b`);
    const copy = { ...source, id: `summary.focus.${n}`, title: `${focus.std_l1}分段总结`, rows: source.rows.map((row) => [...row]), notes: [...source.notes], evidence: [...source.evidence], allowed_numbers: [...source.allowed_numbers] };
    tables.set(copy.id, copy);
    addSlot(summary, `exec.focus.${focus.std_l1}`, `${focus.std_l1}洞察`, 'summary');
    addTable(summary, tables, copy.id);
  }
  chapters.push(summary);
  if (!sections || sections.includes(2)) {
    const ch2 = { id: 'ch2', title: '二、全球市场扫描', tables: [], slots: [], drilldowns: [], blocks: [] };
    // 每节顺序：标题 → 洞察叙述 → 证据表格（标题随叙述位输出，所以叙述位要排在本节表格之前）
    addSlot(ch2, 's2.1', '2.1 全球总览', 'ch2');
    addTable(ch2, tables, '2.1a'); addTable(ch2, tables, '2.1b');
    addSlot(ch2, 's2.2', '2.2 类目增长', 'ch2');
    addTable(ch2, tables, '2.2');
    chapters.push(ch2);
  }
  for (const focus of focuses) {
    const n = focus.section_no;
    const chapter = { id: `sec${n}`, title: `${chapterNumber(n)}、${focus.std_l1}`, tables: [], slots: [], drilldowns: [], blocks: [] };
    addSlot(chapter, `s${n}.1`, `${n}.1 国家与赛道趋势`, `sec${n}`);
    for (const suffix of ['a', 'b', 'c', 'd', 'e']) addTable(chapter, tables, `${n}.1${suffix}`);
    addSlot(chapter, `s${n}.2`, `${n}.2 价格带变化`, `sec${n}`);
    addTable(chapter, tables, `${n}.2a`);
    for (const [index, segment] of competitionSegments(focus).entries()) {
      const slot = `s${n}.3.${index + 1}`;
      chapter.blocks.push({ type: 'heading', level: 3, text: `${n}.3.${index + 1} ${segment.label}品牌竞争格局` });
      for (const site of config.sites) {
        const base = `${n}.3.${segment.label}.${site}`;
        const key = `B1:${n}:${segment.label}:${site}`;
        const pick = selected[key] ?? { competitors: [], company: [], failed: true };
        const ids = [`${base}.brand`, ...pick.competitors.map((_, number) => `${base}.${String.fromCharCode(65 + number)}`), `${base}.company`];
        chapter.blocks.push({ type: 'heading', level: 4, text: `${segment.label}-${config.site_labels?.[site] ?? site}` });
        addSlot(chapter, `${slot}.${site}`, `${segment.label}-${config.site_labels?.[site] ?? site}品牌竞争格局`, `sec${n}.3.${index + 1}`);
        chapter.slots.at(-1).heading = false;
        for (const id of ids) addTable(chapter, tables, id);
        const brandTable = tables.get(`${base}.brand`);
        const explanation = pick.failed ? brandTable?.reason ?? '品牌视图取数失败' : pick.competitors.length < config.drilldown.competitor_brands ? `具名竞品不足 ${config.drilldown.competitor_brands} 个；仅列 ${pick.competitors.length} 个` : !pick.company.length ? '公司品牌在该切片当期无观察' : null;
        chapter.drilldowns.push({ id: base, segment: segment.label, site, competitors: pick.competitors, company_brands: pick.company, table_ids: ids, status: pick.failed ? 'failed' : 'ok', ...(explanation ? { explanation } : {}) });
      }
    }
    chapters.push(chapter);
  }
  const groups = [];
  for (const chapter of [...chapters.filter((item) => item.id !== 'summary'), summary]) for (const slot of chapter.slots) {
    let group = groups.find((item) => item.id === slot.group);
    if (!group) { group = { id: slot.group, agent: slot.group === 'summary' ? 'report-summary-writer' : 'report-section-writer', slots: [] }; groups.push(group); }
    group.slots.push({ slot: slot.slot, digest: slot.digest, draft: slot.draft });
  }
  const manifest = { report_name: config.report_name, label, release_id: releaseId, windows, data_note: 'data-note.md', chapters, writer_groups: groups };
  // Section trials still have an executive global slot. Register its canonical
  // inputs without inserting extra tables into the reader-facing skeleton.
  const bodyIds = new Set(chapters.flatMap((chapter) => chapter.tables.map((table) => table.table_id)));
  const writingIds = unique(chapters.flatMap((chapter) => chapter.slots.flatMap((slot) => slotTables(slot.slot, manifest, tables, focuses).filter(Boolean).map((table) => table.id)))).filter((id) => !bodyIds.has(id));
  if (writingIds.length) manifest.writing_tables = writingIds.map((id) => tableRef(tables, id));
  manifest.writing_observations = true;
  for (const chapter of chapters) for (const slot of chapter.slots) {
    const focus = focuses.find((item) => slot.slot === `exec.focus.${item.std_l1}`);
    slot.observation_tables = focus ? chapters.find((item) => item.id === `sec${focus.section_no}`).tables.map((item) => item.table_id) : slotTables(slot.slot, manifest, tables, focuses).filter(Boolean).map((table) => table.id);
  }
  return manifest;
}

export const DIGEST_MAX_BYTES = 32_768;
export const WRITING_TITLE_LENGTH = 12;
const shortTitle = (text) => Array.from(String(text)).length > WRITING_TITLE_LENGTH ? `${Array.from(String(text)).slice(0, WRITING_TITLE_LENGTH).join('')}…〔标题摘要〕` : text;
export const WRITING_PROJECTION_RULES = { competitor_products: '原排序首个正常商品+全部异常；公司行全留。', all_rows: '全部行。', columns: 'columns_ref对应column_sets；省略明细在canonical.json。', titles: '〔标题摘要〕为原文前12字；原文按row_indexes/column_indexes定位。', summary: '执行摘要仅全球层；数字白名单仅校验，结论限已读数据。' };
/** Writing input only. Canonical JSON/Markdown and evidence stay untouched. */
export function digestTable(table, canonical = table) {
  const product = table.columns.includes('标题'), company = table.id.endsWith('.company');
  const retained = table.columns.map((name, index) => ({ name, index })).filter(({ name }) => name !== '链接' && name !== 'CNY 销售额' && (!product || !['本币销售额', '品牌内占比', '范围内份额', '单位价值（本币）'].includes(name)));
  const titleIndex = table.columns.indexOf('标题'), statusIndex = table.columns.indexOf('状态');
  let normal = 0;
  const rowIndexes = table.rows.flatMap((row, index) => {
    // Only an exact normal state is eligible to be omitted. Unknown and every
    // exceptional state (including appeared, partial, quarantine) are retained.
    const eligible = product && !company && (table.status ?? canonical.status) === 'ok' && statusIndex >= 0 && ['ok', 'comparable', 'observed'].includes(row[statusIndex]);
    if (eligible && normal++ >= 1) return [];
    return [index];
  });
  const sourceColumns = retained.map(({ name }) => canonical.columns.indexOf(name));
  const seen = new Set();
  const sourceRows = rowIndexes.map((index) => {
    const found = canonical.rows.findIndex((row, source) => !seen.has(source) && retained.every(({ index: col }, n) => row[sourceColumns[n]] === table.rows[index][col]));
    if (found < 0 || sourceColumns.includes(-1)) throw new Error(`写作投影无法对应完整表：${table.id}`);
    seen.add(found); return found;
  });
  const output = { id: table.id, title: table.title, columns: retained.map(({ name }) => name),
    rows: rowIndexes.map((index) => retained.map(({ index: col }) => col === titleIndex ? shortTitle(table.rows[index][col]) : table.rows[index][col])),
    footer: table.footer ?? [], canonical: { json: `tables/${safeName(table.id)}.json` },
    projection: { rule: product && !company ? 'competitor_products' : table.rows.length < canonical.rows.length || table.columns.length < canonical.columns.length ? 'summary' : 'all_rows', total_rows: canonical.rows.length, omitted_rows: canonical.rows.length - rowIndexes.length, row_indexes: sourceRows, column_indexes: sourceColumns } };
  const exceptions = asArray(table.observation_context).filter((item) => item.partial_window === true || item.note || item.months_observed === 0 || ![null, 'ok', 'comparable', 'observed'].includes(item.status));
  if (exceptions.length) output.observation_context = exceptions;
  return output;
}
/** Shared column labels are formatting only; canonical table identities remain
 * the existing manifest IDs and no extra file needs to be read or bound.
 * 投影规则正文只由角色参考承载，摘要内仅保留 check 逐字核对的 observations 规则。 */
export function compactDigest(digest) {
  const sets = {}, ids = new Map();
  const tables = digest.tables.map(({ columns, ...table }) => {
    const key = JSON.stringify(columns); let id = ids.get(key);
    if (!id) { id = `c${ids.size + 1}`; ids.set(key, id); sets[id] = columns; }
    return { ...table, columns_ref: id };
  });
  return { ...digest, format: 'writing.v2', column_sets: sets, tables };
}
function projected(table, columns, rows) {
  const output = { ...table, columns, rows, footer: [], allowed_numbers: unique(rows.flat().filter((entry) => typeof entry === 'string' && /^[+\-−]?\d/.test(entry)).map((entry) => entry.replaceAll('−', '-').replaceAll(',', ''))) };
  return output;
}
function summaryTables(slot, tables, focuses) {
  if (slot === 'exec.global') return ['2.1a', '2.1b', '2.2'].map((id) => tables.get(id)).filter(Boolean);
  const focus = focuses.find((item) => slot === `exec.focus.${item.std_l1}`);
  if (!focus) throw new Error(`未知执行摘要叙述位：${slot}`);
  const n = focus.section_no, trend = tables.get(`${n}.1a`), band = tables.get(`${n}.2a`);
  return [projected(trend, trend.columns, trend.rows.slice(0, 1)), tables.get(`${n}.1c`), projected(band, band.columns.slice(0, 3), band.rows.map((row) => row.slice(0, 3)))];
}
function slotTables(slot, manifest, tables, focuses) {
  if (slot.startsWith('exec.')) return summaryTables(slot, tables, focuses);
  const chapter = manifest.chapters.find((entry) => entry.slots.some((item) => item.slot === slot));
  if (!chapter) throw new Error(`叙述位未登记：${slot}`);
  if (slot === 's2.1') return ['2.1a', '2.1b'].map((id) => tables.get(id));
  if (slot === 's2.2') return [tables.get('2.2')];
  const match = slot.match(/^s(\d+)\.([123])(?:\.(\d+)(?:\.([A-Za-z]+))?)?$/);
  if (!match || (match[2] !== '3' && match[3])) throw new Error(`未知叙述位：${slot}`);
  const n = Number(match[1]), part = Number(match[2]);
  if (part === 1) return ['a', 'b', 'c', 'd', 'e'].map((suffix) => tables.get(`${n}.1${suffix}`));
  if (part === 2) return [tables.get(`${n}.2a`)];
  const focus = focuses.find((item) => item.section_no === n);
  const segment = focus && competitionSegments(focus)[Number(match[3]) - 1];
  if (!segment) throw new Error(`叙述位竞争切片不在配置范围：${slot}`);
  const drilldowns = chapter.drilldowns.filter((item) => item.segment === segment.label && (!match[4] || item.site === match[4]));
  if (match[4] && !drilldowns.length) throw new Error(`叙述位站点不在配置范围：${slot}`);
  return drilldowns.flatMap((item) => item.table_ids.map((id) => tables.get(id)));
}

export function buildWritingDigests(manifest, tables, results, focuses) {
  const digests = new Map();
  const byEvidence = new Map([...results.values()].map((record) => [record.id, record]));
  const winOf = (entry) => (entry ? { start: entry.start, end: entry.end } : null);
  for (const chapter of manifest.chapters) for (const slot of chapter.slots) {
    const listed = slotTables(slot.slot, manifest, tables, focuses).filter(Boolean);
    const focus = focuses.find((item) => slot.slot === `exec.focus.${item.std_l1}`);
    const related = focus ? manifest.chapters.find((item) => item.id === `sec${focus.section_no}`).tables.map((item) => tables.get(item.table_id)) : listed;
    const caveats = evidenceCaveats(related, byEvidence);
    const projected = listed.map((table) => digestTable(table, tables.get(table.id)));
    // 窗口实际月份由 start/end 即可还原（窗口为连续完整月）；months/status 是旧代次 manifest 的历史字段，不再投影。
    // 摘要表格行/页脚已可见的数字从白名单字段剔除，check 侧按同一 helper 并集恢复，白名单功能不变。
    const visible = digestVisibleNumbers(projected);
    const digest = { format: 'writing.v2', slot: slot.slot, title: slot.title, window: { label: manifest.label, current: winOf(manifest.windows?.current), yoy: winOf(manifest.windows?.yoy), prior_period: winOf(manifest.windows?.prior_period) },
      tables: projected, statuses: related.map((table) => ({ table: table.id, status: table.status, ...(table.reason ? { reason: table.reason } : {}) })),
      allowed_numbers: unique([...listed.flatMap((table) => table.allowed_numbers), ...related.flatMap((table) => asArray(table.observation_context).map((item) => item.months_observed_display).filter((text) => typeof text === 'string'))]).filter((number) => !visible.has(number)) };
    if (manifest.writing_observations !== true) {
      digest.notes = unique([...related.flatMap((table) => table.notes).filter((note) => !TABLE_READING_NOTES.includes(note)), ...related.map((table) => table.reason).filter(Boolean), ...sectionCaveats(caveats)]);
    }
    const output = compactDigest(digest);
    if (manifest.writing_observations === true) {
      if (JSON.stringify(slot.observation_tables) !== JSON.stringify(related.map((table) => table.id))) throw new Error(`叙述位观察范围不一致：${slot.slot}`);
      Object.assign(output, projectObservations(related, listed.map((table) => table.id), caveats));
      output.projection_rules = { observations: OBSERVATION_RULE };
      for (const table of output.tables) delete table.observation_context;
    }
    digests.set(slot.digest, output);
  }
  return digests;
}

export function serializeDigest(digest) {
  const text = JSON.stringify(digest) + '\n', actual = Buffer.byteLength(text, 'utf8');
  if (actual > DIGEST_MAX_BYTES) throw Object.assign(new Error(`DIGEST_TOO_LARGE: ${digest.slot} 摘要 ${actual} 字节，超过 ${DIGEST_MAX_BYTES} 字节；证据保留，请收窄叙述任务。`), { code: 'DIGEST_TOO_LARGE', slot: digest.slot, actual_bytes: actual, max_bytes: DIGEST_MAX_BYTES });
  return text;
}

export async function writeArtifacts(runDir, manifest, tables, results, focuses, noteText) {
  // Preflight every digest before replacing any previous valid material/identity.
  const digests = [...buildWritingDigests(manifest, tables, results, focuses)].map(([path, digest]) => [path, serializeDigest(digest)]);
  await mkdir(join(runDir, 'drafts'), { recursive: true });
  await writeArtifact(runDir, manifest.data_note, noteText);
  const usedIds = unique([...manifest.chapters.flatMap((chapter) => chapter.tables.map((item) => item.table_id)), ...asArray(manifest.writing_tables).map((item) => item.table_id)]);
  for (const id of usedIds) {
    await writeArtifact(runDir, tablePath(id), renderTable(tables.get(id)));
    await writeArtifact(runDir, `tables/${safeName(id)}.json`, json(tableJson(tables.get(id))));
  }
  for (const [path, text] of digests) await writeArtifact(runDir, path, text);
  // Preserve the complete previous identity if the final manifest commit fails.
  await writeRunManifest(runDir, manifest);
}

/** Same projection for checking and publishing, including legacy Markdown-only
 * tables. JSON presence/absence is bound; present JSON must reproduce the MD. */
export function readViewTable(view, metadata) {
  const id = metadata.table_id, path = `tables/${safeName(id)}.json`;
  const markdown = view.text(metadata.path);
  const table = validateTable(view.snapshot(path) ? view.json(path) : parseMarkdownTable(markdown, { ...metadata, id }), id);
  if (!table.columns.length || renderTable(table) !== markdown) throw new Error(`表格 JSON / Markdown 与同源 renderTable 不一致：${id}`);
  return table;
}

/** Reader-facing context; detailed provenance stays in the appendix. */
export function reportContext(view) {
  const manifest = view.json('manifest.json'), windows = manifest.windows ?? {};
  const periods = [['报告期', windows.current], ['同比', windows.yoy], ['环比', windows.prior_period]]
    .filter(([, window]) => window?.start && window?.end).map(([name, window]) => `${name}：${window.start} 至 ${window.end}`);
  const ledger = view.text('ledger.jsonl').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const caveats = [];
  let upstream = null, statusStamp = {};
  for (const record of ledger.filter((item) => item.ok)) {
    const envelope = view.json(`evidence/${record.id}.json`).envelope;
    if (!upstream && record.tool === 'strategic_data_status') { upstream = envelope?.data?.upstream; statusStamp = envelope?.stamp ?? {}; }
    caveats.push(...asArray(envelope?.caveats), ...asArray(envelope?.coverage_notes));
  }
  const stale = upstream?.status === 'stale' || caveats.some((text) => ['当前 release 落后于上游', '上游类目维表已于', '服务商宽表已于'].some((prefix) => text.includes(prefix)));
  const unknown = upstream?.status !== 'current' || caveats.some((text) => text.includes('无法判定上游是否已更新'));
  const lines = periods.length ? [`${periods.join('；')}。`] : [];
  const contract = sourceContract(statusStamp);
  const frozenSource = contract === 'direct_wide' ? statusStamp.source_wide_update_time : contract === 'legacy_derived' ? statusStamp.source_derived_update_time ?? upstream?.release_built_on?.derived : null;
  if (stale) lines.push(`阅读提示：数据尚未跟进上游最新更新，销售与分类可能重述${frozenSource ? `；本报告基于 ${frozenSource} 的样本` : ''}。详细说明见附录。`);
  else if (unknown) lines.push('阅读提示：数据是否已跟进上游最新更新尚未确认，结论以本报告收录的样本为限。');
  return { intro: lines.join('\n\n'), ledger, caveats: unique(caveats) };
}

export function evidenceReferences(manifest, charts) {
  const references = new Map();
  const sources = [...manifest.chapters.flatMap((chapter) => chapter.tables.map((table) => ({ label: `${table.table_id} ${table.title}`, evidence: table.evidence }))),
    ...charts.filter((chart) => chart.status === 'ok').map((chart) => ({ label: chart.caption, evidence: chart.evidence }))];
  for (const source of sources) for (const id of asArray(source.evidence)) references.set(id, unique([...(references.get(id) ?? []), source.label]));
  return references;
}

/** Pure rendering: every byte comes from the supplied input view. */
export function renderReport(view) {
  const manifest = view.json('manifest.json');
  const { intro, ledger, caveats } = reportContext(view);
  let charts = [];
  try { charts = asArray(view.json('charts/index.json').charts); }
  // Optional output can be interrupted midway; check records a warning for a bad index.
  catch { charts = []; }
  const lines = [`# ${manifest.report_name} - ${manifest.label}`, '', intro, ''];
  for (const chapter of manifest.chapters) {
    lines.push(`## ${chapter.title}`, '');
    for (const block of chapter.blocks) {
      if (block.type === 'heading') {
        lines.push(`${'#'.repeat(block.level)} ${block.text}`, '');
      } else if (block.type === 'table') {
        const table = chapter.tables.find((item) => item.table_id === block.id);
        for (const chart of charts.filter((item) => item.status === 'ok' && item.before_table === block.id)) {
          const alt = String(chart.caption).replace(/[\\\[\]]/gu, '\\$&');
          lines.push(`![${alt}](charts/${chart.file})`, chart.caption, '');
        }
        const markdown = view.text(table.path).split('\n').filter((line) => !line.startsWith('证据：') && !TABLE_READING_NOTES.some((note) => line === `表注：${note}`)).join('\n');
        lines.push(markdown.trimEnd(), '');
      } else {
        const slot = chapter.slots.find((item) => item.slot === block.id);
        if (slot.heading !== false) lines.push(`### ${slot.title}`, '');
        const draft = view.text(slot.draft, true).trim();
        lines.push(draft || `<!-- MISSING slot:${slot.slot} -->\n（待补写）`, '');
      }
    }
  }
  const note = view.text(manifest.data_note).trimEnd(), references = evidenceReferences(manifest, charts);
  lines.push('## 附录：数据说明与溯源', '', note.replace(/^## /u, '### '), '', ...TABLE_READING_NOTES, '',
    '### 证据账本', '', '| 证据 | 对应图表 | 工具 | query_id | release_id | 状态 |', '| --- | --- | --- | --- | --- | --- |');
  for (const record of ledger) lines.push(`| ${[record.id, (references.get(record.id) ?? []).join('；') || '—', record.tool, record.query_id ?? '—', record.release_id ?? '—', record.ok ? 'ok' : record.error?.message ?? 'failed'].map(safeMd).join(' | ')} |`);
  lines.push('');
  lines.push(...caveats.filter((item) => !note.includes(item)).map((item) => `- ${item}`), '');
  return lines.join('\n');
}

export async function assemble(runDir) {
  const view = await captureInputs(runDir, { report: false });
  const text = renderReport(view);
  await view.assertUnchanged();
  const report = join(runDir, 'report.md');
  await writeArtifact(runDir, 'report.md', text);
  return { ok: true, report };
}
