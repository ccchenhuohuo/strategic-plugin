import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestVisibleNumbers, evidenceCaveats, OBSERVATION_RULE, projectObservations } from './writing-observations.mjs';
import { asArray, redact, safeName, writeJson } from './common.mjs';
import { ADVICE, CAUSAL, PRICE_CLAIMS } from './lexicon.mjs';
import { readViewTable, renderReport, WRITING_TITLE_LENGTH } from './artifacts.mjs';
import { reportSnapshot } from './check-binding.mjs';
import { captureInputs, chartReferences } from './input-view.mjs';

const tokenPattern = /([+\-−]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[ \t]*(亿件|万件|亿|万|件|pp|%))?/gu;
const normalized = (text) => String(text).normalize('NFKC').replaceAll('−', '-').replaceAll(',', '').replace(/[ \t]/gu, '');
const excerpt = (line) => line.trim().slice(0, 160);

function numberTokensWithLine(text, window, labels = []) {
  const found = [];
  for (const line of String(text).split(/\r?\n/u)) for (const token of lineTokens(line, window, labels)) found.push({ token, line });
  return found;
}
function lineTokens(text, window, labels) {
  let scrubbed = String(text).normalize('NFKC');
  for (const label of labels) {
    const escaped = label.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    scrubbed = scrubbed.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gu'), ' ');
  }
  if (window?.label) scrubbed = scrubbed.replaceAll(String(window.label).normalize('NFKC'), ' ');
  // 先剔完整日期与时刻（如上游陈旧警示里的 2026-08-27 10:45:55），否则只剔年月会剩下「-27」
  scrubbed = scrubbed.replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b/gu, ' ');
  scrubbed = scrubbed.replace(/\b\d{4}-\d{2}\b/gu, ' ');
  // 章节/表号引用：「见 3.1」「第 3.2 节」「表 3.1a」不是数据
  scrubbed = scrubbed.replace(/(?:见|参见|第|表|图)\s*\d+(?:\.\d+){1,2}[a-z]?/gu, ' ').replace(/\d+(?:\.\d+){1,2}\s*(?:节|章)/gu, ' ');
  scrubbed = scrubbed.replace(/\b\d{2}Q[1-4]\b/giu, ' ');
  const found = [];
  for (const match of scrubbed.matchAll(tokenPattern)) {
    const before = scrubbed.slice(0, match.index);
    const after = scrubbed.slice(match.index + match[0].length);
    if (/^(?:个月|年|月|季|日|名|位)/u.test(after)) continue;
    if (/(?:Top|前)$/iu.test(before)) continue;
    if (!match[3] && !match[2].includes('.') && Number(match[2].replaceAll(',', '')) <= 20) continue;
    found.push(normalized(match[0]));
  }
  return found;
}

// 只豁免完整标签片段，标签里的数字不能挪作该叙述位的其他数据主张。
const displayCell = /^[+\-−]?\d[\d,]*(?:\.\d+)?(?:亿件|万件|亿|万|件|pp|%)?$/u;
function completeLabels(digest, view) {
  const labels = new Set();
  for (const table of asArray(digest.tables)) {
    const full = digest.format === 'writing.v2' ? view.json(table.canonical.json) : null;
    for (const cell of [table.title, ...asArray(table.rows).flat(), ...asArray(full?.rows).flat()]) {
      const text = String(cell ?? '').normalize('NFKC');
      if (!text || displayCell.test(text.trim())) continue;
      if (/\d/u.test(text)) labels.add(text.replace(/^★ /u, ''));
    }
  }
  return [...labels].sort((a, b) => b.length - a.length);
}
function traceAllowed(token, allowed) {
  if (allowed.has(token)) return true;
  if (token.startsWith('+') || token.startsWith('-')) return false;
  return [...allowed].some((item) => item.replace(/^[+-]/u, '') === token);
}

function checkObservations(view, manifest, chapter, slot, digest, evidence) {
  const marked = Object.hasOwn(manifest, 'writing_observations') || manifest.chapters.some((item) => item.slots.some((entry) => Object.hasOwn(entry, 'observation_tables') || /^s\d+\.3\.\d+\.[A-Za-z]+$/u.test(entry.slot))) || Object.hasOwn(digest, 'observations') || Object.hasOwn(digest.projection_rules ?? {}, 'observations');
  if (!marked) return;
  if (manifest.writing_observations !== true || digest.format !== 'writing.v2' || digest.projection_rules?.observations !== OBSERVATION_RULE || !Array.isArray(digest.observations)) throw new Error('摘要观察投影标记缺失或不一致');
  const start = chapter.blocks.findIndex((block) => block.type === 'slot' && block.id === slot.slot);
  if (start < 0) throw new Error('叙述位未登记在正文骨架');
  const following = [];
  for (const block of chapter.blocks.slice(start + 1)) {
    if (block.type !== 'table') break;
    following.push(block.id);
  }
  let listed = following, related = following;
  if (slot.slot === 'exec.global') listed = related = ['2.1a', '2.1b', '2.2'];
  else if (slot.slot.startsWith('exec.focus.')) {
    const match = following.length === 1 && following[0].match(/^summary\.focus\.(\d+)$/u);
    const focus = match && manifest.chapters.find((item) => item.id === `sec${match[1]}`);
    if (!focus) throw new Error('执行摘要缺少对应重点章节');
    listed = [`${match[1]}.1a`, `${match[1]}.1c`, `${match[1]}.2a`];
    related = focus.tables.map((table) => table.table_id);
  }
  if (!related.length || new Set(related).size !== related.length || !isDeepStrictEqual(slot.observation_tables, related) || !isDeepStrictEqual(digest.tables.map((table) => table.id), listed)) throw new Error('摘要观察范围与正文骨架不一致');
  const registered = [...manifest.chapters.flatMap((item) => item.tables), ...asArray(manifest.writing_tables)];
  const canonical = related.map((id) => {
    const metadata = registered.find((table) => table.table_id === id);
    if (!metadata || !view.snapshot(`tables/${safeName(id)}.json`)) throw new Error(`观察投影缺少完整 JSON 表：${id}`);
    return readViewTable(view, metadata);
  });
  const expected = projectObservations(canonical, listed, evidenceCaveats(canonical, evidence));
  const statuses = canonical.map((table) => ({ table: table.id, status: table.status, ...(table.reason ? { reason: table.reason } : {}) }));
  if (!isDeepStrictEqual(digest.observations, expected.observations) || !isDeepStrictEqual(digest.notes, expected.notes) || !isDeepStrictEqual(digest.statuses, statuses)) throw new Error('摘要观察限制、说明或状态与完整来源不一致');
  if (digest.tables.some((table) => Object.hasOwn(table, 'observation_context'))) throw new Error('摘要观察投影混用旧格式');
}

export async function check(runDir) {
  const blocking = [], warnings = [];
  const reportPath = join(runDir, 'report.md');
  let snapshot;
  try { snapshot = await reportSnapshot(reportPath); }
  catch (error) { blocking.push({ type: 'report_unavailable', detail: `正文不存在或不可读：${error.message}`, excerpt: 'report.md' }); }
  const view = await captureInputs(runDir, { reportSnapshot: snapshot ?? null });
  const manifest = view.json('manifest.json');
  let ledger = [];
  try { ledger = view.text('ledger.jsonl', true).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { blocking.push({ type: 'consistency', detail: '证据账本不可读', excerpt: 'ledger.jsonl' }); }
  if (!ledger.length) blocking.push({ type: 'consistency', detail: '证据账本为空', excerpt: 'ledger.jsonl' });
  const releases = new Set(), byEvidence = new Map();
  for (const item of ledger.filter((entry) => entry.ok)) {
    try {
      const evidence = view.json(`evidence/${item.id}.json`);
      byEvidence.set(item.id, evidence);
      const release = evidence.envelope?.stamp?.release_id;
      if (!release || release !== item.release_id) blocking.push({ type: 'consistency', detail: `证据 ${item.id} 的 release_id 缺失或与账本不一致`, excerpt: item.id });
      else releases.add(release);
    } catch { blocking.push({ type: 'consistency', detail: `证据 ${item.id} 缺失或不可读`, excerpt: item.id }); }
  }
  if (releases.size !== 1 || !releases.has(manifest.release_id)) blocking.push({ type: 'consistency', detail: '成功证据的 release_id 不一致或与 manifest 不符', excerpt: [...releases].join('、') });
  for (const item of ledger.filter((entry) => !entry.ok)) warnings.push({ evidence: item.id, detail: item.error?.message ?? '取数失败' });
  if (snapshot) {
    try {
      const expected = Buffer.from(redact(renderReport(view)), 'utf8');
      if (!snapshot.bytes.equals(expected)) blocking.push({ type: 'report_content', detail: '正文与当前草稿、表格和证据的组装结果不一致，请重新 assemble 后 check', excerpt: 'report.md' });
    } catch (error) {
      blocking.push({ type: 'report_content', detail: `无法核对正文的组装结果：${error.message}`, excerpt: 'report.md' });
    }
  }
  let tables = 0, slots = 0, numbersChecked = 0;
  for (const table of asArray(manifest.writing_tables)) {
    tables++;
    try { readViewTable(view, table); }
    catch (error) { blocking.push({ table: table.table_id, type: 'table_content', detail: error.message, excerpt: table.path }); }
  }
  for (const chapter of manifest.chapters) {
    for (const table of chapter.tables) {
      tables++;
      if (table.status !== 'ok' && !table.reason) blocking.push({ table: table.table_id, type: 'skeleton', detail: '非 ok 表位没有明确状态说明', excerpt: table.title });
      if (!view.text(table.path, true)) blocking.push({ table: table.table_id, type: 'skeleton', detail: '表格文件缺失或为空', excerpt: table.path });
      try { readViewTable(view, table); }
      catch (error) { blocking.push({ table: table.table_id, type: 'table_content', detail: error.message, excerpt: table.path }); }
    }
    for (const drill of chapter.drilldowns) {
      if (!drill.table_ids?.length && !drill.explanation) blocking.push({ table: drill.id, type: 'drilldown', detail: '下钻位缺少表与说明', excerpt: drill.id });
      if (drill.status !== 'ok' && !drill.explanation) blocking.push({ table: drill.id, type: 'drilldown', detail: '下钻位状态没有说明', excerpt: drill.id });
      for (const id of drill.table_ids ?? []) if (!chapter.tables.some((table) => table.table_id === id)) blocking.push({ table: drill.id, type: 'drilldown', detail: `缺少下钻表 ${id}`, excerpt: drill.id });
    }
    for (const slot of chapter.slots) {
      slots++;
      const draft = view.text(slot.draft, true).trim();
      if (!draft) { blocking.push({ slot: slot.slot, type: 'skeleton', detail: '叙述草稿缺失或为空', excerpt: slot.draft }); continue; }
      let digest;
      try {
        digest = view.json(slot.digest);
        if (!digest || !Array.isArray(digest.allowed_numbers) || digest.allowed_numbers.some((item) => typeof item !== 'string') || !Array.isArray(digest.tables)) throw new Error('摘要格式损坏');
        if (digest.format !== undefined && digest.format !== 'writing.v2') throw new Error('未知摘要格式');
        checkObservations(view, manifest, chapter, slot, digest, byEvidence);
        if (digest.format === 'writing.v2') for (const projected of digest.tables) {
          const columns = digest.column_sets?.[projected.columns_ref];
          if (!Array.isArray(columns) || columns.some((item) => typeof item !== 'string')) throw new Error('摘要共享列引用损坏');
          const metadata = [...manifest.chapters.flatMap((item) => item.tables), ...asArray(manifest.writing_tables)].find((item) => item.table_id === projected.id);
          if (!metadata || projected.canonical?.json !== `tables/${safeName(projected.id)}.json`) throw new Error('摘要完整表引用损坏');
          const canonical = readViewTable(view, metadata), p = projected.projection;
          if (!p || p.total_rows !== canonical.rows.length || p.omitted_rows !== p.total_rows - projected.rows.length || !Array.isArray(p.row_indexes) || new Set(p.row_indexes).size !== projected.rows.length || p.row_indexes.length !== projected.rows.length || !Array.isArray(p.column_indexes) || p.column_indexes.length !== columns.length) throw new Error('摘要投影范围损坏');
          if (columns.some((col, index) => col !== canonical.columns[p.column_indexes[index]]) || projected.rows.some((row, index) => row.length !== columns.length || row.some((cell, col) => {
            const original = canonical.rows[p.row_indexes[index]]?.[p.column_indexes[col]];
            const abbreviated = columns[col] === '标题' && Array.from(String(original)).length > WRITING_TITLE_LENGTH ? `${Array.from(String(original)).slice(0, WRITING_TITLE_LENGTH).join('')}…〔标题摘要〕` : original;
            return cell !== abbreviated;
          }))) throw new Error('摘要数字/标签与完整表不一致');
          // summaryTables() 仅对重点执行摘要的趋势合计和全球价格带清空页脚；
          // 不能按裁剪列数或 projection.rule 推断，其他表仍须原样保留 canonical 页脚。
          const omitFooter = slot.slot.startsWith('exec.focus.') && /^\d+\.(?:1a|2a)$/u.test(projected.id);
          if (!isDeepStrictEqual(projected.footer, omitFooter ? [] : canonical.footer)) throw new Error('摘要页脚与完整表不一致');
        }
      }
      catch { blocking.push({ slot: slot.slot, type: 'digest', detail: '摘要缺失或不可读', excerpt: slot.digest }); continue; }
      const allowed = new Set(asArray(digest.allowed_numbers).map(normalized));
      // 新摘要把行/页脚已可见的服务端展示数字从白名单字段剔除以避免重复存储；
      // 仅在全部投影（含页脚）通过 canonical 校验后恢复并集，旧摘要与既有条目不受影响。
      if (digest.format === 'writing.v2') for (const number of digestVisibleNumbers(digest.tables)) allowed.add(number);
      const labels = completeLabels(digest, view);
      for (const line of draft.split(/\r?\n/u)) {
        const verifyQuestion = line.trimStart().startsWith('待验证：');
        for (const rule of ADVICE) {
          const matched = line.match(rule);
          if (matched) blocking.push({ slot: slot.slot, type: 'forbidden', detail: `禁用经营词：${matched[0]}`, excerpt: excerpt(line) });
        }
        if (!verifyQuestion) for (const rule of [...CAUSAL, ...PRICE_CLAIMS]) {
          const matched = line.match(rule);
          if (matched) blocking.push({ slot: slot.slot, type: 'forbidden', detail: `禁用因果或价格措辞：${matched[0]}`, excerpt: excerpt(line) });
        }
      }
      for (const { token, line } of numberTokensWithLine(draft, digest.window, labels)) {
        numbersChecked++;
        if (!traceAllowed(token, allowed)) blocking.push({ slot: slot.slot, type: 'number_provenance', detail: `数字无摘要展示值来源：${token}`, excerpt: excerpt(line) });
      }
    }
  }
  const note = view.text(manifest.data_note, true);
  for (const word of ['估算', '缺失≠零', '固定汇率', '截断']) if (!note.includes(word)) blocking.push({ type: 'consistency', detail: `数据说明缺少必需警示：${word}`, excerpt: manifest.data_note });
  let charts = [];
  try { if (view.snapshot('charts/index.json')) charts = asArray(view.json('charts/index.json').charts); }
  catch (error) {
    if (error.code !== 'ENOENT') warnings.push({ type: 'chart', detail: '图表索引不可读', excerpt: 'charts/index.json' });
  }
  for (const chart of charts.filter((item) => item.status !== 'ok')) warnings.push({ type: 'chart', chart: chart.id, detail: chart.reason ?? `图表 ${chart.status}`, excerpt: chart.title });
  const reportText = snapshot?.bytes.toString('utf8') ?? '';
  for (const path of chartReferences(reportText)) {
    if (!view.snapshot(path)) blocking.push({ type: 'chart_missing', detail: `报告引用的图文件不存在：${path}`, excerpt: path });
  }
  let stable = true;
  try { await view.assertUnchanged(); }
  catch (error) {
    stable = false;
    snapshot = null;
    blocking.push({ type: 'report_changed', detail: `输入校验期间变化或不可读：${error.message}`, excerpt: 'report.md' });
  }
  const result = { ok: blocking.length === 0, report_sha256: snapshot?.sha256 ?? null, input_binding: stable ? view.binding : null, blocking, warnings, stats: { tables, slots, numbers_checked: numbersChecked, charts: charts.length } };
  await writeJson(join(runDir, 'check.json'), result);
  try { await view.assertUnchanged(); }
  catch (error) {
    result.ok = false;
    result.report_sha256 = null;
    result.input_binding = null;
    blocking.push({ type: 'report_changed', detail: `写出校验结果期间输入变化或不可读：${error.message}`, excerpt: 'report.md' });
    await writeJson(join(runDir, 'check.json'), result);
  }
  return result;
}
