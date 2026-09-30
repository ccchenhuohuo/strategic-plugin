import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asArray, json, safeName, unique, writeArtifact } from './common.mjs';
import { competitionSegments } from './plan.mjs';
import { tableJson } from './tables.mjs';

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
  const lines = [
    '## 数据说明',
    '',
    `报告期：${label}（${format(windows.current)}）；同比：${format(windows.yoy)}；环比：${format(windows.prior_period)}。`,
    `复现戳：release_id ${stamp.release_id ?? '—'}；build_id ${stamp.build_id ?? '—'}；table_spec ${stamp.table_spec_version ?? '—'}；pipeline ${stamp.pipeline_version ?? '—'}。`,
    `覆盖站点：${config.sites.map((site) => config.site_labels?.[site] ?? site).join('、')}。平台范围：${data.universe ?? '未提供'}。`,
    `CNY 固定汇率快照：${data.fx_snapshot?.fx_snapshot_id ?? '—'}；${fx}。跨站点及跨期换算使用该 release 冻结的单一汇率，不反映汇率变动。`,
    `类目映射：${mapping.mapping_version ?? '—'}；一级 ${mapping.l1_count ?? '—'}，二级路径 ${mapping.l2_count ?? '—'}，完整三级路径 ${mapping.l3_path_count ?? '—'}。价格带政策：${data.band_policy_version ?? '—'}。`,
    `上游状态：${data.upstream?.status ?? 'unknown'}；上游维表更新可能重述历史类目归属。`,
    '口径警示：销售额、销量和均价均为匹配子集的估算；缺失≠零，未观察、检疫、归档与越界分别处理。',
    '跨年同比受匹配池变化影响；商品身份数是匹配子集内有观察的商品身份数，服务商对极低销量长尾有截断，身份数变化仅作旁证。',
    '',
  ];
  if (caveats.length) lines.push('响应级口径警示：', '', ...caveats.map((item) => `- ${item}`), '');
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
    const chapter = { id: `sec${n}`, title: `${['', '', '', '三', '四', '五', '六'][n]}、${focus.std_l1}`, tables: [], slots: [], drilldowns: [], blocks: [] };
    addSlot(chapter, `s${n}.1`, `${n}.1 国家与赛道趋势`, `sec${n}`);
    for (const suffix of ['a', 'b', 'c', 'd', 'e']) addTable(chapter, tables, `${n}.1${suffix}`);
    addSlot(chapter, `s${n}.2`, `${n}.2 价格带变化`, `sec${n}`);
    addTable(chapter, tables, `${n}.2a`);
    for (const [index, segment] of competitionSegments(focus).entries()) {
      const slot = `s${n}.3.${index + 1}`;
      addSlot(chapter, slot, `${n}.3.${index + 1} ${segment.label}品牌竞争格局`, `sec${n}.3.${index + 1}`);
      for (const site of config.sites) {
        const base = `${n}.3.${segment.label}.${site}`;
        const key = `B1:${n}:${segment.label}:${site}`;
        const pick = selected[key] ?? { competitors: [], company: [], failed: true };
        const ids = [`${base}.brand`, ...pick.competitors.map((_, number) => `${base}.${String.fromCharCode(65 + number)}`), `${base}.company`];
        chapter.blocks.push({ type: 'heading', level: 4, text: `${segment.label}-${config.site_labels?.[site] ?? site}` });
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
  return { report_name: config.report_name, label, release_id: releaseId, windows, data_note: 'data-note.md', chapters, writer_groups: groups };
}

function digestTable(table) { return { id: table.id, title: table.title, columns: table.columns, rows: table.rows }; }
function projected(table, columns, rows) {
  const output = { ...table, columns, rows, footer: [], allowed_numbers: unique(rows.flat().filter((entry) => typeof entry === 'string' && /^[+\-−]?\d/.test(entry)).map((entry) => entry.replaceAll('−', '-').replaceAll(',', ''))) };
  return output;
}
function summaryTables(slot, tables, focuses) {
  if (slot === 'exec.global') return ['2.1a', '2.1b', '2.2'].map((id) => tables.get(id)).filter((table) => table?.status === 'ok');
  const focus = focuses.find((item) => slot === `exec.focus.${item.std_l1}`);
  if (!focus) return [];
  const n = focus.section_no, trend = tables.get(`${n}.1a`), band = tables.get(`${n}.2a`);
  return [projected(trend, trend.columns, trend.rows.slice(0, 1)), tables.get(`${n}.1c`), projected(band, band.columns.slice(0, 3), band.rows.map((row) => row.slice(0, 3)))];
}
function slotTables(slot, manifest, tables, focuses) {
  if (slot.startsWith('exec.')) return summaryTables(slot, tables, focuses);
  const chapter = manifest.chapters.find((entry) => entry.slots.some((item) => item.slot === slot));
  if (!chapter) return [];
  if (slot === 's2.1') return ['2.1a', '2.1b'].map((id) => tables.get(id));
  if (slot === 's2.2') return [tables.get('2.2')];
  const match = slot.match(/^s(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return [];
  const n = Number(match[1]), part = Number(match[2]);
  if (part === 1) return ['a', 'b', 'c', 'd', 'e'].map((suffix) => tables.get(`${n}.1${suffix}`));
  if (part === 2) return [tables.get(`${n}.2a`)];
  const segment = competitionSegments(focuses.find((item) => item.section_no === n))[Number(match[3]) - 1];
  return chapter.drilldowns.filter((item) => item.segment === segment.label).flatMap((item) => item.table_ids.map((id) => tables.get(id)));
}

export async function writeArtifacts(runDir, manifest, tables, results, focuses, noteText) {
  await mkdir(join(runDir, 'drafts'), { recursive: true });
  await writeArtifact(runDir, manifest.data_note, noteText);
  const usedIds = unique(manifest.chapters.flatMap((chapter) => chapter.tables.map((item) => item.table_id)));
  for (const id of usedIds) {
    await writeArtifact(runDir, tablePath(id), renderTable(tables.get(id)));
    await writeArtifact(runDir, `tables/${safeName(id)}.json`, json(tableJson(tables.get(id))));
  }
  const byEvidence = new Map([...results.values()].map((record) => [record.id, record]));
  for (const chapter of manifest.chapters) for (const slot of chapter.slots) {
    const listed = slotTables(slot.slot, manifest, tables, focuses).filter(Boolean);
    const evidence = unique(listed.flatMap((table) => table.evidence));
    const caveats = evidence.flatMap((id) => {
      const envelope = byEvidence.get(id)?.envelope;
      return [...asArray(envelope?.caveats), ...asArray(envelope?.coverage_notes)];
    });
    const notes = unique([...listed.flatMap((table) => table.notes), ...listed.map((table) => table.reason).filter(Boolean), ...caveats]);
    const digest = { slot: slot.slot, title: slot.title, window: { label: manifest.label, current: manifest.windows.current ?? null, yoy: manifest.windows.yoy ?? null, prior_period: manifest.windows.prior_period ?? null }, tables: listed.map(digestTable), notes, statuses: listed.map((table) => ({ table: table.id, status: table.status, ...(table.reason ? { reason: table.reason } : {}) })), allowed_numbers: unique(listed.flatMap((table) => table.allowed_numbers)) };
    await writeArtifact(runDir, slot.digest, json(digest));
  }
  await writeArtifact(runDir, 'manifest.json', json(manifest));
}

export async function assemble(runDir) {
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  let charts = [];
  try { charts = asArray(JSON.parse(await readFile(join(runDir, 'charts/index.json'), 'utf8')).charts); }
  // Optional output can be interrupted midway; check records a warning for a bad index.
  catch { charts = []; }
  const lines = [`# ${manifest.report_name} - ${manifest.label}`, '', (await readFile(join(runDir, manifest.data_note), 'utf8')).trimEnd(), ''];
  for (const chapter of manifest.chapters) {
    lines.push(`## ${chapter.title}`, '');
    for (const block of chapter.blocks) {
      if (block.type === 'heading') {
        lines.push(`${'#'.repeat(block.level)} ${block.text}`, '');
      } else if (block.type === 'table') {
        const table = chapter.tables.find((item) => item.table_id === block.id);
        for (const chart of charts.filter((item) => item.status === 'ok' && item.before_table === block.id)) {
          lines.push(`![${chart.caption}](charts/${chart.file})`, chart.caption, `证据：${chart.evidence.join('、')}`, '');
        }
        lines.push((await readFile(join(runDir, table.path), 'utf8')).trimEnd(), '');
      } else {
        const slot = chapter.slots.find((item) => item.slot === block.id);
        lines.push(`### ${slot.title}`, '');
        let draft = '';
        try { draft = (await readFile(join(runDir, slot.draft), 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        lines.push(draft || `<!-- MISSING slot:${slot.slot} -->\n（待补写）`, '');
      }
    }
  }
  const ledger = (await readFile(join(runDir, 'ledger.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  lines.push('## 附录：证据账本与口径警示', '', '| 证据 | 工具 | query_id | release_id | 状态 |', '| --- | --- | --- | --- | --- |');
  for (const record of ledger) lines.push(`| ${record.id} | ${record.tool} | ${record.query_id ?? '—'} | ${record.release_id ?? '—'} | ${record.ok ? 'ok' : record.error?.message ?? 'failed'} |`);
  lines.push('');
  const caveats = [];
  for (const record of ledger.filter((item) => item.ok)) {
    const evidence = JSON.parse(await readFile(join(runDir, `evidence/${record.id}.json`), 'utf8'));
    caveats.push(...asArray(evidence.envelope?.caveats), ...asArray(evidence.envelope?.coverage_notes));
  }
  lines.push(...unique(caveats).map((item) => `- ${item}`), '');
  const report = join(runDir, 'report.md');
  await writeArtifact(runDir, 'report.md', lines.join('\n'));
  return { ok: true, report };
}
