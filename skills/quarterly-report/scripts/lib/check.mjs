import { access, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { asArray, readJson, unique, writeJson } from './common.mjs';
import { ADVICE, CAUSAL, PRICE_CLAIMS } from './lexicon.mjs';

const tokenPattern = /([+\-−]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(亿件|万件|亿|万|件|pp|%)?/gu;
const normalized = (text) => String(text).replaceAll('−', '-').replaceAll(',', '');
const excerpt = (line) => line.trim().slice(0, 160);

function numberTokens(text, window) {
  return numberTokensWithLine(text, window).map((item) => item.token);
}
function numberTokensWithLine(text, window) {
  const found = [];
  for (const line of String(text).split(/\r?\n/u)) for (const token of lineTokens(line, window)) found.push({ token, line });
  return found;
}
function lineTokens(text, window) {
  let scrubbed = String(text);
  if (window?.label) scrubbed = scrubbed.replaceAll(window.label, ' ');
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

// 标签里的数字（价格档边界「[200, 500)」、品牌名「INSTA360」、标题里的「66英寸」）不是数据主张：
// 只对不带单位、不带符号的裸数字放行；带 %/pp/亿/万/件 或正负号的记号仍须逐字匹配展示值。
const displayCell = /^[+\-−]?\d[\d,]*(?:\.\d+)?(?:亿件|万件|亿|万|件|pp|%)?$/u;
function labelNumbers(digest) {
  const numbers = new Set();
  for (const table of asArray(digest.tables)) {
    for (const cell of [table.title, ...asArray(table.rows).flat()]) {
      const text = String(cell ?? '');
      if (!text || displayCell.test(text.trim())) continue;
      for (const match of text.matchAll(/\d+(?:\.\d+)?/gu)) numbers.add(match[0]);
    }
  }
  return numbers;
}
function traceAllowed(token, allowed, labels) {
  if (allowed.has(token)) return true;
  if (token.startsWith('+') || token.startsWith('-')) return false;
  if (/^\d+(?:\.\d+)?$/u.test(token) && labels.has(token)) return true;
  return [...allowed].some((item) => item.replace(/^[+-]/u, '') === token);
}

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function check(runDir) {
  const manifest = await readJson(join(runDir, 'manifest.json'));
  const blocking = [], warnings = [];
  let tables = 0, slots = 0, numbersChecked = 0;
  for (const chapter of manifest.chapters) {
    for (const table of chapter.tables) {
      tables++;
      if (table.status !== 'ok' && !table.reason) blocking.push({ table: table.table_id, type: 'skeleton', detail: '非 ok 表位没有明确状态说明', excerpt: table.title });
      if (!await optionalText(join(runDir, table.path))) blocking.push({ table: table.table_id, type: 'skeleton', detail: '表格文件缺失或为空', excerpt: table.path });
    }
    for (const drill of chapter.drilldowns) {
      if (!drill.table_ids?.length && !drill.explanation) blocking.push({ table: drill.id, type: 'drilldown', detail: '下钻位缺少表与说明', excerpt: drill.id });
      if (drill.status !== 'ok' && !drill.explanation) blocking.push({ table: drill.id, type: 'drilldown', detail: '下钻位状态没有说明', excerpt: drill.id });
      for (const id of drill.table_ids ?? []) if (!chapter.tables.some((table) => table.table_id === id)) blocking.push({ table: drill.id, type: 'drilldown', detail: `缺少下钻表 ${id}`, excerpt: drill.id });
    }
    for (const slot of chapter.slots) {
      slots++;
      const draft = (await optionalText(join(runDir, slot.draft))).trim();
      if (!draft) { blocking.push({ slot: slot.slot, type: 'skeleton', detail: '叙述草稿缺失或为空', excerpt: slot.draft }); continue; }
      let digest;
      try { digest = await readJson(join(runDir, slot.digest)); }
      catch { blocking.push({ slot: slot.slot, type: 'digest', detail: '摘要缺失或不可读', excerpt: slot.digest }); continue; }
      const allowed = new Set(asArray(digest.allowed_numbers).map(normalized));
      const labels = labelNumbers(digest);
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
      for (const { token, line } of numberTokensWithLine(draft, digest.window)) {
        numbersChecked++;
        if (!traceAllowed(token, allowed, labels)) blocking.push({ slot: slot.slot, type: 'number_provenance', detail: `数字无摘要展示值来源：${token}`, excerpt: excerpt(line) });
      }
    }
  }
  const note = await optionalText(join(runDir, manifest.data_note));
  for (const word of ['估算', '缺失≠零', '固定汇率', '截断']) if (!note.includes(word)) blocking.push({ type: 'consistency', detail: `数据说明缺少必需警示：${word}`, excerpt: manifest.data_note });
  let ledger = [];
  try { ledger = (await optionalText(join(runDir, 'ledger.jsonl'))).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { blocking.push({ type: 'consistency', detail: '证据账本不可读', excerpt: 'ledger.jsonl' }); }
  if (!ledger.length) blocking.push({ type: 'consistency', detail: '证据账本为空', excerpt: 'ledger.jsonl' });
  const releases = new Set();
  for (const item of ledger.filter((entry) => entry.ok)) {
    try {
      const evidence = await readJson(join(runDir, `evidence/${item.id}.json`));
      const release = evidence.envelope?.stamp?.release_id;
      if (!release || release !== item.release_id) blocking.push({ type: 'consistency', detail: `证据 ${item.id} 的 release_id 缺失或与账本不一致`, excerpt: item.id });
      else releases.add(release);
    } catch { blocking.push({ type: 'consistency', detail: `证据 ${item.id} 缺失或不可读`, excerpt: item.id }); }
  }
  if (releases.size !== 1 || !releases.has(manifest.release_id)) blocking.push({ type: 'consistency', detail: '成功证据的 release_id 不一致或与 manifest 不符', excerpt: [...releases].join('、') });
  for (const item of ledger.filter((entry) => !entry.ok)) warnings.push({ evidence: item.id, detail: item.error?.message ?? '取数失败' });
  let charts = [];
  try { charts = asArray((await readJson(join(runDir, 'charts/index.json'))).charts); }
  catch (error) {
    if (error.code !== 'ENOENT') warnings.push({ type: 'chart', detail: '图表索引不可读', excerpt: 'charts/index.json' });
  }
  for (const chart of charts.filter((item) => item.status !== 'ok')) warnings.push({ type: 'chart', chart: chart.id, detail: chart.reason ?? `图表 ${chart.status}`, excerpt: chart.title });
  const reportText = await optionalText(join(runDir, 'report.md'));
  for (const match of reportText.matchAll(/!\[[^\n]*?\]\((charts\/[^\n)]+)\)/gu)) {
    const image = resolve(runDir, match[1]), inside = relative(resolve(runDir), image);
    let exists = !inside.startsWith('..') && !inside.startsWith('/');
    if (exists) try { await access(image); } catch { exists = false; }
    if (!exists) blocking.push({ type: 'chart_missing', detail: `报告引用的图文件不存在：${match[1]}`, excerpt: match[0] });
  }
  const result = { ok: blocking.length === 0, blocking, warnings, stats: { tables, slots, numbers_checked: numbersChecked, charts: charts.length } };
  await writeJson(join(runDir, 'check.json'), result);
  return result;
}
