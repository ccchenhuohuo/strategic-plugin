import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSecret, asArray, json, readJson, redact, unique } from './common.mjs';
import { evidenceReferences, readViewTable, renderReport, reportContext } from './artifacts.mjs';
import { reportTableNotes, TABLE_READING_NOTES } from './tables.mjs';
import { mcpTokens, withoutMcpTokens } from './environment.mjs';
import { boundOutput } from './portable-binding.mjs';
import { outputBinding } from './output-binding.mjs';
import { checkBinding, reportSnapshot } from './check-binding.mjs';
import { assertInputCopy, captureInputs, inputParents } from './input-view.mjs';

// Personal-space publication only. These commands never set parents, share,
// change permissions or ownership, delete resources, or add --yes.
export const REQUIRED_SCOPES = ['docx:document:create', 'docx:document', 'docs:document.media:upload', 'sheets:spreadsheet:create', 'sheets:spreadsheet:write_only'];
export const GENERATING = '生成状态：生成中（如长时间停留在此状态，说明发布中断，请以本地 report.md 为准）';
const SCRIPT = fileURLToPath(new URL('../report.mjs', import.meta.url));
const MAX_BLOCKS = 600, MAX_CHARS = 80000;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const inline = (text) => String(text).split(/(\*\*[^*]+\*\*)/u).map((part) => part.startsWith('**') && part.endsWith('**') ? `<b>${esc(part.slice(2, -2))}</b>` : esc(part)).join('').replaceAll('\n', '<br/>');
const gray = (text) => `<p><span text-color="gray">${esc(text).replaceAll('\n', '<br/>')}</span></p>`;
const item = (xml, blocks = 1) => ({ xml, blocks });
const relative = (path) => {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/u).some((part) => part === '..' || part === '') || path.includes('\0')) throw new Error(`不安全的运行目录相对路径：${path}`);
  return path;
};
const optionalJson = async (path) => { try { return await readJson(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const command = (options, resume = false) => `node ${quote(SCRIPT)} publish --run-dir ${quote(resolve(options.runDir))} --output-env ${quote(resolve(options.outputEnv))}${options.unverified.length ? ` --unverified ${quote(options.unverified.join(','))}` : ''}${resume ? ' --resume' : ''}`;

/** Supported Markdown is deliberately narrow: raw HTML/XML, links, ordered
 * lists, fences and every other syntax remain escaped ordinary text. */
export function markdownXml(markdown) {
  const output = [], lines = String(markdown).replaceAll('\r\n', '\n').split('\n');
  let paragraph = [];
  const flush = () => { if (paragraph.length) output.push(item(`<p>${inline(paragraph.join('\n'))}</p>`)); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{2,4})\s+(.+)$/u);
    if (heading) { flush(); output.push(item(`<h${heading[1].length - 1}>${inline(heading[2])}</h${heading[1].length - 1}>`)); continue; }
    if (/^[-*] /u.test(line)) {
      flush();
      const roots = [], stack = [{ children: roots }];
      let count = 0;
      while (i < lines.length) {
        const entry = lines[i].match(/^((?:  )*)[-*] (.*)$/u);
        if (!entry) break;
        const depth = entry[1].length / 2;
        if (depth >= stack.length) {
          // A valid nested list must have a parent at the preceding level.
          if (depth !== stack.length || !stack.at(-1).children.length) break;
          stack.push(stack.at(-1).children.at(-1));
        } else stack.length = depth + 1;
        stack.at(-1).children.push({ text: entry[2], children: [] });
        count++; i++;
      }
      i--;
      const list = (nodes) => `<ul>${nodes.map((node) => `<li>${inline(node.text)}${node.children.length ? list(node.children) : ''}</li>`).join('')}</ul>`;
      output.push(item(list(roots), count));
    } else paragraph.push(line);
  }
  flush();
  return output;
}

const isProduct = (id) => /^\d+\.3\..+\.(?:[A-E]|company)$/u.test(id);
const isBrand = (id) => /^\d+\.3\..+\.brand$/u.test(id);
const cellXml = (value) => /^https?:\/\/[^\s]+$/u.test(String(value)) ? `<a href="${esc(value)}">链接</a>` : esc(value).replaceAll('\n', '<br/>');
function tableItems(table) {
  const columns = table.columns;
  if (!Array.isArray(columns) || !columns.length || !Array.isArray(table.rows) || table.rows.some((row) => !Array.isArray(row) || row.length !== columns.length)) throw new Error(`表 ${table.id} 的列与行结构损坏`);
  // Column widths and chunk sizes are layout geometry, never business arithmetic.
  const widths = columns.map((column, n) => {
    const texts = [column, ...table.rows.map((row) => row[n])].map((value) => /^https?:\/\//u.test(String(value)) ? '链接' : String(value ?? ''));
    const length = Math.max(...texts.map((text) => [...text].reduce((sum, char) => sum + (/[^\x00-\x7f]/u.test(char) ? 1 : 0.55), 0)));
    return Math.max(60, Math.min(360, Math.ceil(length * 8 + 24)));
  });
  const rows = table.rows.length ? table.rows : [[table.reason ?? '无观察', ...columns.slice(1).map(() => '—')]];
  const batchSize = Math.max(1, Math.min(50, Math.floor((MAX_BLOCKS - 1) / (columns.length * 2)) - 1));
  const output = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    output.push(item(`<p><b>${esc(table.title)}${offset ? '（续）' : ''}</b></p>`));
    const xml = `<table><colgroup>${widths.map((width) => `<col width="${width}"/>`).join('')}</colgroup><thead><tr>${columns.map((column) => `<th background-color="light-gray">${esc(column)}</th>`).join('')}</tr></thead><tbody>${batch.map((row) => `<tr>${row.map((cell) => `<td>${cellXml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    output.push(item(xml, (batch.length + 1) * columns.length * 2 + 1));
  }
  for (const footer of asArray(table.footer)) output.push(item(gray(footer)));
  for (const note of reportTableNotes(table)) output.push(item(gray(`表注：${note}`)));
  if (table.reason && table.rows.length && !asArray(table.notes).includes(table.reason)) output.push(item(gray(`表注：${table.reason}`)));
  return output;
}

const PRODUCT_COLUMNS = ['站点', '代号', '品牌', '名次', '标题', '本币销售额', 'CNY 销售额', '品牌内占比', '范围内份额', '同比', '单位价值（本币）', '状态', '链接', '证据'];
const cellAt = (table, row, column) => { const index = table.columns.indexOf(column); return index < 0 ? '—' : String(row[index] ?? '—'); };
function sheetName(name, used) {
  const fullwidth = { '/': '／', '\\': '＼', '?': '？', '*': '＊', '[': '［', ']': '］', ':': '：' };
  const base = String(name).replace(/[\/\\?*\[\]:]/gu, (char) => fullwidth[char]);
  // Count Unicode characters, keeping a unique suffix when truncation collides.
  let output = [...base].slice(0, 31).join(''), n = 2;
  while (used.has(output)) { const suffix = ` ${n++}`; output = [...base].slice(0, 31 - suffix.length).join('') + suffix; }
  used.add(output); return output;
}

function buildPlan(view, unverified, reportSha256) {
  const manifest = view.json('manifest.json');
  if (!manifest.report_name || !manifest.label || !manifest.release_id || !Array.isArray(manifest.chapters)) throw new Error('运行目录 manifest.json 损坏');
  const { intro, ledger, caveats } = reportContext(view);
  const allIds = unique(manifest.chapters.flatMap((chapter) => asArray(chapter.tables).map((table) => table.table_id)));
  const tables = new Map(manifest.chapters.flatMap((chapter) => asArray(chapter.tables)).map((metadata) => [metadata.table_id, readViewTable(view, metadata)]));
  let chartIndex;
  try { if (view.snapshot('charts/index.json')) chartIndex = view.json('charts/index.json'); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; /* Optional charts never block report publication. */ }
  const charts = asArray(chartIndex?.charts ?? (Array.isArray(chartIndex) ? chartIndex : []));
  const passed = charts.filter((chart) => chart.status === 'ok');
  const chartHashes = [];
  for (const chart of passed) {
    if (!chart.file || chart.file.includes('/') || chart.file.includes('\\')) throw new Error(`图 ${chart.id} 的文件名损坏`);
    const image = view.snapshot(relative(`charts/${chart.file}`));
    if (!image) throw new Error(`报告引用的图文件不存在：charts/${chart.file}`);
    chartHashes.push([chart.id, image.sha256]);
  }
  const byAnchor = new Map();
  for (const chart of passed) { const list = byAnchor.get(chart.before_table) ?? []; list.push(chart); byAnchor.set(chart.before_table, list); }
  const usedNames = new Set(), groups = [], byBase = new Map(), siteLabels = new Map();
  for (const chapter of manifest.chapters) {
    let heading;
    for (const block of asArray(chapter.blocks)) {
      if (block.type === 'heading') heading = block.text;
      if (block.type === 'table' && isBrand(block.id)) siteLabels.set(block.id.slice(0, -6), heading);
    }
    for (const drill of asArray(chapter.drilldowns)) {
      const n = String(drill.id).match(/^(\d+)\.3\./u)?.[1];
      if (!n || !drill.segment || !drill.site || !Array.isArray(drill.table_ids)) throw new Error(`商品下钻位置损坏：${drill.id}`);
      let group = groups.find((entry) => entry.chapter === chapter.id && entry.segment === drill.segment);
      if (!group) { const index = groups.filter((entry) => entry.chapter === chapter.id).length + 1; group = { key: `group${groups.length}`, chapter: chapter.id, segment: drill.segment, name: sheetName(`${n}.3.${index} ${drill.segment}`, usedNames), data: [] }; groups.push(group); }
      byBase.set(drill.id, group.key);
      const headingText = siteLabels.get(drill.id), prefix = `${drill.segment}-`;
      const site = headingText?.startsWith(prefix) ? headingText.slice(prefix.length) : drill.site;
      for (const id of drill.table_ids.filter(isProduct)) {
        const table = tables.get(id);
        if (!table) throw new Error(`缺少商品表 ${id}`);
        const code = id.split('.').at(-1);
        const brand = code === 'company' ? asArray(drill.company_brands).join('、') || '—' : asArray(drill.competitors)[code.charCodeAt(0) - 65] ?? '—';
        const evidence = asArray(table.evidence).join('、') || '缺失';
        if (!table.rows.length || table.status !== 'ok' || !table.columns.includes('标题')) {
          const row = PRODUCT_COLUMNS.map(() => '—'); row[0] = site; row[1] = code === 'company' ? '公司品牌' : code; row[2] = brand; row[11] = table.reason || table.rows[0]?.[0] || table.status || '无观察'; row[13] = evidence;
          group.data.push(row.map(String)); continue;
        }
        for (const row of table.rows) group.data.push([site, code === 'company' ? '公司品牌' : code, code === 'company' ? cellAt(table, row, '品牌') : brand, ...PRODUCT_COLUMNS.slice(3, 13).map((column) => cellAt(table, row, column)), evidence].map(String));
      }
    }
  }
  const references = evidenceReferences(manifest, passed), ledgerColumns = ['证据', '对应图表', '工具', 'query_id', 'release_id', '状态'];
  const workbook = { sheets: [...groups.map((group) => ({ name: group.name, columns: PRODUCT_COLUMNS, data: group.data, dtypes: Object.fromEntries(PRODUCT_COLUMNS.map((column) => [column, 'object'])) })), { name: '证据账本', columns: ledgerColumns, data: ledger.map((record) => [record.id, (references.get(record.id) ?? []).join('；') || '—', record.tool, record.query_id ?? '—', record.release_id ?? '—', record.ok ? 'ok' : record.error?.message ?? 'failed'].map(String)), dtypes: Object.fromEntries(ledgerColumns.map((column) => [column, 'object'])) }] };
  const links = { ledger: '证据账本', ...Object.fromEntries(groups.map((group) => [group.key, group.name])) };
  const link = (key, text) => `<a href="__FW_WORKBOOK_${key}__">${esc(text)}</a>`;
  const content = [...markdownXml(intro)];
  for (const chapter of manifest.chapters) {
    content.push(item(`<h1>${esc(chapter.title)}</h1>`));
    for (const block of asArray(chapter.blocks)) {
      if (block.type === 'heading') {
        const level = (block.level ?? 4) - 1;
        content.push(item(`<h${level}>${inline(block.text)}</h${level}>`));
      } else if (block.type === 'slot') {
        const slot = asArray(chapter.slots).find((entry) => entry.slot === block.id);
        if (!slot) throw new Error(`缺少叙述位 ${block.id}`);
        const body = [...(slot.heading === false ? [] : [item(`<h2>${inline(slot.title)}</h2>`)]), ...markdownXml(view.text(slot.draft))];
        content.push(block.id === 'exec.global' ? item(`<callout emoji="📝">${body.map((entry) => entry.xml).join('\n')}</callout>`, 1 + body.reduce((sum, entry) => sum + entry.blocks, 0)) : body);
      } else if (block.type === 'table') {
        if (isProduct(block.id)) continue;
        for (const chart of byAnchor.get(block.id) ?? []) content.push({ chart });
        const table = tables.get(block.id);
        if (!table) throw new Error(`缺少表位 ${block.id}`);
        content.push(...tableItems(table));
        if (isBrand(block.id)) {
          const key = byBase.get(block.id.slice(0, -6));
          if (!key) throw new Error(`品牌表 ${block.id} 缺少对应商品附表`);
          content.push(item(`<p>商品下钻（A～E 竞品与公司品牌 Top 商品）：${link(key, links[key])}</p>`));
        }
      } else throw new Error(`未知 manifest 块类型：${block.type}`);
    }
  }
  const note = view.text(manifest.data_note);
  content.push(item('<h1>附录：数据说明与溯源</h1>'), ...markdownXml(note.replace(/^## /u, '### ')),
    ...TABLE_READING_NOTES.map((text) => item(gray(text))), item(`<p>${link('ledger', '证据账本（含对应图表）')}</p>`));
  for (const warning of caveats.filter((text) => !note.includes(text))) content.push(item(`<p>${inline(warning)}</p>`));
  const title = `${manifest.report_name} - ${manifest.label}`;
  content.push(item(gray(`生成记录：release ${manifest.release_id}｜机械校验通过｜图表 ${passed.length}/${charts.length}${unverified.length ? `｜未经语义核查：${unverified.join('、')}` : ''}`)));
  const complete = `生成状态：已完成（草稿，待人工审阅）${unverified.length ? '｜部分内容未经语义核查，详见附录' : ''}`;
  const files = {}, steps = [];
  const add = (step) => { steps.push({ number: steps.length + 1, ...step }); };
  add({ kind: 'workbook', write: true, argv: ['sheets', '+workbook-create', '--as', 'user', '--title', `${title} · 附表`, '--sheets', '@publish/workbook.json', '--format', 'json'], estimated_blocks: 0 });
  add({ kind: 'workbook_info', write: false, conditional: true, argv: ['sheets', '+workbook-info', '--as', 'user', '--spreadsheet-token', '__WORKBOOK_TOKEN__', '--format', 'json'], estimated_blocks: 0 });
  const addXml = (kind, xml, blocks) => {
    const path = `publish/${String(Object.keys(files).length).padStart(3, '0')}.xml`;
    files[path] = xml + '\n';
    const argv = kind === 'create' ? ['docs', '+create', '--as', 'user', '--content', `@${path}`, '--format', 'json'] : ['docs', '+update', '--as', 'user', '--doc', '__DOCUMENT_ID__', '--command', kind === 'complete' ? 'str_replace' : 'append', ...(kind === 'complete' ? ['--pattern', GENERATING] : []), '--content', `@${path}`, '--format', 'json'];
    add({ kind, write: true, argv, content_file: path, estimated_blocks: blocks, chars: xml.length });
  };
  addXml('create', `<title>${esc(title)}</title>\n${gray(GENERATING)}`, 2);
  let buffer = [], blocks = 0, chars = 0;
  const flush = () => { if (buffer.length) addXml('append', buffer.join('\n'), blocks); buffer = []; blocks = 0; chars = 0; };
  for (const entry of content.flat()) {
    if (entry.chart) {
      flush(); const chart = entry.chart;
      add({ kind: 'image', write: true, chart_id: chart.id, argv: ['docs', '+media-insert', '--as', 'user', '--doc', '__DOCUMENT_ID__', '--file', relative(`charts/${chart.file}`), '--caption', String(chart.caption), '--align', 'center', '--width', '800', '--format', 'json'], estimated_blocks: 1 });
    } else {
      if (entry.blocks > MAX_BLOCKS || entry.xml.length > MAX_CHARS) throw new Error('单个顶层正文块超过发布切块上限');
      if (blocks + entry.blocks > MAX_BLOCKS || chars + entry.xml.length + 1 > MAX_CHARS) flush();
      buffer.push(entry.xml); blocks += entry.blocks; chars += entry.xml.length + 1;
    }
  }
  flush();
  // Replacement is inline XML, preserving the existing grey status paragraph.
  addXml('complete', `<span text-color="gray">${esc(complete)}</span>`, 0);
  const payload = redact({ version: 1, title, release_id: manifest.release_id, report_sha256: reportSha256, input_binding: view.binding, unverified, links, workbook, files, steps, chart_hashes: chartHashes, stats: { charts_inserted: passed.length, charts_total: charts.length, tables_inline: allIds.filter((id) => !isProduct(id)).length, tables_in_workbook: allIds.filter(isProduct).length, estimated_blocks: steps.reduce((sum, step) => sum + step.estimated_blocks, 0) } });
  return { ...payload, digest: sha(JSON.stringify(payload)) };
}

async function atomicJson(path, object) { const temp = `${path}.tmp-${process.pid}`; await writeFile(temp, json(redact(object)), { mode: 0o600 }); await rename(temp, path); }
function envelope(stdout, stderr = '') {
  for (const source of [stdout, stderr]) {
    try { return JSON.parse(source.trim()); } catch {}
    for (const line of source.trim().split('\n').reverse()) { try { const value = JSON.parse(line); if (value && typeof value === 'object') return value; } catch {} }
  }
  return null;
}
async function call(lark, argv, runDir, env) {
  return await new Promise((done) => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    // lark-cli 用不到 访问令牌，不把它交给外部进程。
    const rest = withoutMcpTokens(env);
    const child = spawn(lark, argv, { cwd: runDir, env: { ...rest, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }, 180000);
    let killTimer;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); done(result); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2000000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000000); });
    child.on('error', (error) => finish({ code: null, error: error.message, stdout: '', json: null }));
    child.on('close', (code) => finish({ code, timedOut, stdout, json: envelope(stdout, stderr) }));
  });
}
async function executable(path) { try { await access(path, constants.X_OK); return await realpath(path); } catch { return null; } }
async function fromPath(name, env) {
  if (name.includes('/') || name.includes('\\')) return executable(resolve(name));
  for (const folder of String(env.PATH ?? '').split(delimiter).filter(Boolean)) { const path = await executable(join(folder, name)); if (path) return path; }
  return null;
}
const scopeList = (scope) => Array.isArray(scope) ? scope.map(String) : String(scope ?? '').split(/[\s,]+/u).filter(Boolean);
const login = (scopes) => `lark-cli auth login --scope "${scopes.join(' ')}"`;
function callError(result) {
  if (result.timedOut) return 'lark-cli 调用超过 180 秒，已中断；该步骤可能已部分写入';
  const error = result.json?.error;
  const scopes = asArray(error?.missing_scopes).filter((scope) => /^[A-Za-z0-9_:.\-]+$/u.test(scope));
  if (scopes.length || error?.type === 'authentication' || error?.type === 'authorization') return `${error?.message ?? '飞书用户授权不可用'}；请用户自行执行 ${login(scopes.length ? scopes : REQUIRED_SCOPES)}`;
  if (result.code === 10) return `lark-cli 要求高风险操作确认（退出码 10）；已停止，未追加 --yes：${error?.message ?? 'confirmation_required'}`;
  return String(error?.message ?? result.error ?? (result.json?.data?.result === 'partial_success' ? 'lark-cli 返回 partial_success' : `lark-cli 执行失败（退出码 ${result.code}）`));
}
function success(result, step) { return !result.timedOut && result.code === 0 && result.json?.ok === true && result.json.data?.result !== 'partial_success' && (step.argv?.[1] !== '+update' || result.json.data?.result === 'success'); }
function absorb(journal, result, step) {
  const data = result.json?.data ?? {};
  if (step.kind === 'workbook') {
    const workbook = data.spreadsheet ?? data.workbook ?? data;
    journal.workbook_token = workbook.spreadsheet_token ?? workbook.token ?? data.spreadsheet_token ?? data.token;
    journal.workbook_url = workbook.url ?? workbook.spreadsheet_url ?? data.url ?? data.spreadsheet_url;
    if (!journal.workbook_token || !journal.workbook_url) throw new Error('附表创建结果缺少 token 或 URL；资源可能已创建，请核对个人空间');
  }
  if (step.kind === 'workbook' || step.kind === 'workbook_info') {
    const sheets = asArray(data.sheets ?? data.spreadsheet?.sheets ?? data.workbook?.sheets);
    for (const sheet of sheets) {
      const name = sheet.title ?? sheet.sheet_name ?? sheet.name, id = sheet.sheet_id ?? sheet.sheetId;
      if (name && id) journal.sheet_ids[name] = id;
    }
  }
  if (step.kind === 'create') {
    const doc = data.document ?? data;
    journal.document_id = doc.document_id ?? doc.doc_id;
    journal.doc_url = doc.url ?? doc.doc_url;
    if (!journal.document_id || !journal.doc_url) throw new Error('文档创建结果缺少 document_id 或 URL；资源可能已创建，请核对个人空间');
  }
}
function materialize(plan, journal, xml) {
  for (const [key, name] of Object.entries(plan.links)) {
    if (!journal.sheet_ids[name]) throw new Error(`附表创建结果缺少子表 id：${name}`);
    const base = new URL(journal.workbook_url); base.searchParams.set('sheet', journal.sheet_ids[name]);
    xml = xml.replaceAll(`__FW_WORKBOOK_${key}__`, esc(base.toString()));
  }
  return xml;
}

async function writeCopy(runDir, path, bytes) {
  await inputParents(runDir, path);
  await mkdir(dirname(join(runDir, path)), { recursive: true });
  const handle = await open(join(runDir, path), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); }
  finally { await handle.close(); }
}

function planCopies(plan, view) {
  const copies = new Map([['publish/plan.json', Buffer.from(json(plan))], ['publish/workbook.json', Buffer.from(json(plan.workbook))],
    ...Object.entries(plan.files).map(([path, xml]) => [path, Buffer.from(xml)])]);
  const images = new Map();
  for (const step of plan.steps.filter((entry) => entry.kind === 'image')) {
    const source = step.argv[step.argv.indexOf('--file') + 1];
    // Keep source images in place. This dedicated, digest-named directory
    // contains only planned copies; CLI never opens the live reference image.
    const path = `charts/.publish-${plan.digest}/${source.slice('charts/'.length)}`;
    copies.set(path, view.snapshot(source).bytes);
    images.set(source, path);
  }
  return { copies, images };
}

async function publishImpl(input) {
  for (const token of mcpTokens(input.env ?? process.env)) addSecret(token);
  const options = { ...input, runDir: resolve(input.runDir), outputEnv: input.outputEnv ? resolve(input.outputEnv) : '', unverified: unique(Array.isArray(input.unverified) ? input.unverified : String(input.unverified ?? '').split(',')).map((id) => String(id).trim()).filter(Boolean) };
  // 完整季报约 120 步、十几分钟，超过 runner 单条命令 10 分钟时限。到预算就在两步之间停下交回续跑，
  // 400 秒预算 + 单次调用最长 181 秒 = 581 秒，留出外层 600 秒超时余量；调用中断后由 pending 阻止自动重放。
  const budgetSeconds = input.timeBudget === undefined || input.timeBudget === null || input.timeBudget === '' ? 400 : Number(input.timeBudget);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds < 0) return { ok: false, target: 'markdown', error: '--time-budget 须为非负秒数' };
  if (options.retryUncertain && options.skipUncertain) return { ok: false, target: 'markdown', error: '--retry-uncertain 与 --skip-uncertain 不能同用' };
  if ((options.retryUncertain || options.skipUncertain) && !options.resume) return { ok: false, target: 'markdown', error: '人工处理不确定步骤需要 --resume' };
  const startedAt = Date.now();
  const report = join(options.runDir, 'report.md');
  const frozen = await outputBinding(options.runDir, options.outputEnv, input.env ?? process.env);
  options.outputEnv = frozen.outputEnv;
  let output;
  try { output = await readFile(options.outputEnv, 'utf8'); } catch (error) { if (error.code === 'ENOENT' || !options.outputEnv) return { ok: true, target: 'markdown', feishu: 'disabled', report }; throw error; }
  const config = Object.fromEntries(output.split('\n').map((line) => { const at = line.indexOf('='); return at < 0 ? [] : [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }).filter((parts) => parts.length));
  if (config.feishu !== '1') return { ok: true, target: 'markdown', feishu: 'disabled', report };
  const frozenLark = frozen.mode !== 'unbound' && config.lark_cli ? await executable(config.lark_cli) : null;
  if (frozen.mode !== 'unbound' && !frozenLark) return { ok: false, target: 'markdown', report, failed_step: 'cli', error: '已开启飞书输出，但本次收据冻结的 lark_cli 路径缺失或不可执行；请重新 verify 并开始新运行' };
  let savedJournal;
  try { savedJournal = await optionalJson(join(options.runDir, 'publish/journal.json')); } catch { /* validated below if checks pass */ }
  const fail = (error, fields = {}) => redact({ ok: false, target: 'markdown', error, ...(savedJournal?.doc_url ? { doc_url: savedJournal.doc_url } : {}), ...(savedJournal?.workbook_url ? { workbook_url: savedJournal.workbook_url } : {}), ...fields });
  let checked;
  try { checked = await optionalJson(join(options.runDir, 'check.json')); }
  catch { return fail('机械校验未通过，不发布到飞书：check.json 无法读取或已损坏', { failed_step: 'check', resume: command(options, true) }); }
  let snapshot;
  try { snapshot = await reportSnapshot(report); }
  catch (error) { return fail(`机械校验未通过，不发布到飞书：正文无法读取；${error.message}`, { failed_step: 'check', resume: command(options, true) }); }
  let view;
  try { view = await captureInputs(options.runDir, { reportSnapshot: snapshot }); }
  catch (error) { return fail(`机械校验未通过，不发布到飞书：输入不可用；${error.message}`, { failed_step: 'check', resume: command(options, true) }); }
  const binding = checkBinding(checked, snapshot.sha256, view.binding);
  if (!binding.available || checked.ok !== true) return fail(`机械校验未通过，不发布到飞书${binding.available ? '' : `：${binding.reason}`}`, { failed_step: 'check', resume: command(options, true) });
  let plan;
  try {
    if (!snapshot.bytes.equals(Buffer.from(redact(renderReport(view)), 'utf8'))) throw new Error('正文与校验输入的组装结果不一致，请重新 assemble / check');
    plan = buildPlan(view, options.unverified, snapshot.sha256);
    await view.assertUnchanged();
  } catch (error) { return fail(error.message, { failed_step: 'plan', resume: command(options, true) }); }
  await mkdir(join(options.runDir, 'publish'), { recursive: true });
  const journalPath = join(options.runDir, 'publish/journal.json');
  let journal;
  try { journal = await optionalJson(journalPath); }
  catch { return fail('发布日志无法读取或已损坏，拒绝续跑', { failed_step: 'journal', resume: command(options, true) }); }
  savedJournal = journal;
  if (journal && journal.plan_digest !== plan.digest) return fail('发布计划摘要与上次不一致，拒绝续跑；请核对已有个人文档与附表', { failed_step: 'plan', doc_url: journal.doc_url, workbook_url: journal.workbook_url, resume: command(options, true) });
  if (journal && !options.resume && !options.dryRun) return fail('已有发布日志；为避免重复创建，请用 --resume 续跑', { doc_url: journal.doc_url, workbook_url: journal.workbook_url, failed_step: 'journal', resume: command(options, true) });
  const { copies, images } = planCopies(plan, view);
  const assertMaterials = async () => {
    await boundOutput(options.runDir, options.outputEnv, input.env ?? process.env);
    await view.assertUnchanged();
    for (const [path, bytes] of copies) await assertInputCopy(options.runDir, path, sha(bytes));
  };
  // A resumed operation verifies immutable plan copies rather than overwriting
  // possibly altered files and erasing the evidence of a version change.
  if (!journal) for (const [path, bytes] of copies) await writeCopy(options.runDir, path, bytes);
  await assertMaterials();
  if (options.dryRun) return { ok: true, target: 'feishu', dry_run: true, plan: join(options.runDir, 'publish/plan.json'), steps: plan.steps.map(({ number, kind, argv, estimated_blocks, chars, conditional }) => ({ number, kind, argv, estimated_blocks, ...(chars !== undefined ? { chars } : {}), ...(conditional ? { conditional } : {}) })), estimated_blocks: plan.stats.estimated_blocks, ...plan.stats };
  journal ??= { version: 1, plan_digest: plan.digest, document_id: null, doc_url: null, workbook_token: null, workbook_url: null, sheet_ids: {}, completed: [] };
  savedJournal = journal;
  if (!Array.isArray(journal.completed) || !journal.sheet_ids || journal.completed.some((number, index) => number !== index + 1 || !plan.steps.some((step) => step.number === number))) return fail('发布日志损坏，拒绝续跑', { failed_step: 'journal', resume: command(options, true) });
  if (journal.pending && (!plan.steps.some((step) => step.number === journal.pending.step && step.write) || typeof journal.pending.started_at !== 'string' || !Number.isFinite(Date.parse(journal.pending.started_at)) || (!journal.completed.includes(journal.pending.step) && journal.pending.step !== journal.completed.length + 1))) return fail('发布日志 pending 损坏，拒绝续跑', { failed_step: 'journal', resume: command(options, true) });
  if (journal.pending && journal.completed.includes(journal.pending.step)) delete journal.pending;
  const next = plan.steps[journal.completed.length];
  const hasResource = (step) => step?.kind === 'create' ? !!journal.document_id : step?.kind === 'workbook' ? !!journal.workbook_token : false;
  // Older journals may contain a returned resource id without a completed step.
  // Treat that as uncertain too, and never issue another create for that resource.
  if (!journal.pending && hasResource(next)) journal.pending = { step: next.number, started_at: new Date().toISOString() };
  if (journal.pending) {
    await atomicJson(journalPath, journal);
    const step = plan.steps[journal.pending.step - 1];
    const uncertain = (suffix = '') => fail(`第 ${step.number} 步结果不确定，可能已写入，请打开文档核对${suffix}`, { failed_step: String(step.number), resume: command(options, true) });
    if (!options.retryUncertain && !options.skipUncertain) return uncertain('；仅人工核对后可用 --retry-uncertain 重做或 --skip-uncertain 确认已写入后继续');
    if (options.retryUncertain && hasResource(step)) return uncertain('；日志已有资源 id，禁止再次创建，请人工核对后使用 --skip-uncertain');
    if (options.skipUncertain) {
      if ((step.kind === 'create' && (!journal.document_id || !journal.doc_url)) || (step.kind === 'workbook' && (!journal.workbook_token || !journal.workbook_url))) return uncertain('；日志缺少资源 id 或链接，无法跳过创建步骤，请人工补齐日志');
      journal.completed.push(step.number);
      delete journal.pending;
      await atomicJson(journalPath, journal);
    }
    // Explicit retry keeps pending until the retried call is durably completed.
  }
  const env = input.env ?? process.env;
  const lark = frozen.mode !== 'unbound' ? frozenLark : (env.LARK_CLI ? await fromPath(env.LARK_CLI, env) : null) ?? (config.lark_cli ? await executable(config.lark_cli) : null) ?? await fromPath('lark-cli', env);
  if (!lark) return fail(`已开启飞书输出，但找不到 lark-cli；请安装并登录 lark-cli 后重试：${command(options, !!journal)}`, { failed_step: 'cli', resume: command(options, true) });
  await assertMaterials();
  const version = await call(lark, ['--version'], options.runDir, env), match = version.stdout?.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (version.code !== 0 || !match) return fail('无法读取 lark-cli 版本；请运行 lark-cli update 后重试', { failed_step: 'version', resume: command(options, true) });
  const parts = match.slice(1).map(Number);
  if (parts[0] < 1 || (parts[0] === 1 && parts[1] === 0 && parts[2] < 81)) return fail('lark-cli 版本低于 1.0.81；请运行 lark-cli update 后重试', { failed_step: 'version', resume: command(options, true) });
  await assertMaterials();
  const auth = await call(lark, ['auth', 'status', '--json'], options.runDir, env);
  // lark-cli 1.0.81 的 auth status 不是 API 信封：顶层没有 ok 字段，只有显式 ok:false 才算失败（2026-09-30 真机核实）。
  // 用户访问令牌约两小时过期；刷新令牌仍有效时 status 与 tokenStatus 都报 needs_refresh（2026-09-30 真机核实），
  // 下一次调用会自动刷新，不能据此拦下发布。
  const user = auth.json?.identities?.user ?? auth.json?.data?.identities?.user;
  const ready = ['ready', 'needs_refresh'].includes(user?.status);
  const valid = ['valid', 'needs_refresh'].includes(user?.tokenStatus);
  if (auth.code !== 0 || !auth.json || auth.json.ok === false || !ready || !valid) return fail(`飞书用户身份未就绪或令牌失效且无法刷新；请用户自行执行 ${login(REQUIRED_SCOPES)}`, { failed_step: 'auth', resume: command(options, true) });
  const scopes = scopeList(user.scope), missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) return fail(`飞书权限不足；请用户自行执行 ${login(missing)}`, { failed_step: 'auth', resume: command(options, true) });
  await assertMaterials();
  await atomicJson(journalPath, journal);
  let lastWrite = Number.isFinite(journal.last_write_at) ? journal.last_write_at : 0;
  let executed = 0;
  for (const step of plan.steps) {
    if (journal.completed.includes(step.number)) continue;
    if (executed > 0 && Date.now() - startedAt >= budgetSeconds * 1000) {
      return redact({ ok: false, target: 'markdown', incomplete: true, error: `发布未完成：已完成 ${journal.completed.length}/${plan.steps.length} 步，达到本次运行的时间预算，请用 --resume 续跑`, doc_url: journal.doc_url ?? undefined, workbook_url: journal.workbook_url ?? undefined, completed: journal.completed.length, total: plan.steps.length, resume: command(options, true) });
    }
    process.stderr.write(`发布：${step.number}/${plan.steps.length} ${step.kind}${step.chart_id ? ` ${step.chart_id}` : ''}\n`);
    try {
      if (hasResource(step)) {
        journal.pending = { step: step.number, started_at: new Date().toISOString() };
        await atomicJson(journalPath, journal);
        throw new Error(`第 ${step.number} 步结果不确定，可能已写入，请打开文档核对；日志已有资源 id，禁止再次创建，请人工核对后使用 --skip-uncertain`);
      }
      if (step.kind === 'workbook_info' && Object.values(plan.links).every((name) => journal.sheet_ids[name])) { journal.completed.push(step.number); await atomicJson(journalPath, journal); continue; }
      const argv = step.argv.map((arg) => arg === '__DOCUMENT_ID__' ? journal.document_id : arg === '__WORKBOOK_TOKEN__' ? journal.workbook_token : images.get(arg) ?? arg);
      if (argv.some((arg) => arg === null || arg === undefined)) throw new Error('发布日志缺少当前步骤需要的资源 id');
      let execution;
      if (step.content_file) {
        const path = `publish/execute/${step.content_file.slice('publish/'.length)}`;
        const bytes = Buffer.from(redact(materialize(plan, journal, plan.files[step.content_file])));
        await writeCopy(options.runDir, path, bytes);
        argv[argv.indexOf(`@${step.content_file}`)] = `@${path}`;
        execution = { path, sha256: sha(bytes) };
      }
      if (step.write) {
        const delay = 400 - (Date.now() - lastWrite);
        if (delay > 0) await new Promise((done) => setTimeout(done, delay));
        await assertMaterials();
        journal.pending = { step: step.number, started_at: new Date().toISOString() };
        await atomicJson(journalPath, journal);
      }
      await assertMaterials();
      if (execution) await assertInputCopy(options.runDir, execution.path, execution.sha256);
      const result = await call(lark, argv, options.runDir, env);
      if (step.write) {
        lastWrite = Date.now(); journal.last_write_at = lastWrite;
      }
      // Preserve returned resource identity even on partial failures; do not
      // persist stdout, auth state or credentials in the journal.
      let identityError;
      try { absorb(journal, result, step); } catch (error) { identityError = error; }
      if (!success(result, step) || identityError) {
        await atomicJson(journalPath, journal);
        throw success(result, step) ? identityError : new Error(callError(result));
      }
      if (step.kind === 'workbook_info' && !Object.values(plan.links).every((name) => journal.sheet_ids[name])) throw new Error('附表子表 id 查询不完整，请核对附表');
      const completed = { ...journal, completed: [...journal.completed, step.number] };
      if (step.write) delete completed.pending;
      await atomicJson(journalPath, completed);
      savedJournal = journal = completed;
      executed++;
    } catch (error) {
      // Keep pending and known identities if committing the completed step failed.
      await atomicJson(journalPath, journal).catch(() => {});
      return fail(error.message, { doc_url: journal.doc_url ?? undefined, workbook_url: journal.workbook_url ?? undefined, failed_step: String(step.number), resume: command(options, true) });
    }
  }
  const result = { ok: true, target: 'feishu', report_sha256: plan.report_sha256, input_binding: plan.input_binding, plan_digest: plan.digest,
    doc_url: journal.doc_url, workbook_url: journal.workbook_url, charts_inserted: plan.stats.charts_inserted, tables_inline: plan.stats.tables_inline, tables_in_workbook: plan.stats.tables_in_workbook };
  await atomicJson(join(options.runDir, 'publish.json'), result);
  return redact(result);
}

// A local filesystem interruption must still preserve the Markdown fallback
// contract. Raw CLI output and authentication envelopes never reach this path.
export async function publish(input) {
  try { return await publishImpl(input); }
  catch (error) {
    const options = { ...input, runDir: String(input.runDir ?? ''), outputEnv: String(input.outputEnv ?? ''), unverified: unique(Array.isArray(input.unverified) ? input.unverified : String(input.unverified ?? '').split(',')).map(String) };
    let journal;
    try { journal = await optionalJson(join(resolve(options.runDir), 'publish/journal.json')); } catch {}
    return redact({ ok: false, target: 'markdown', failed_step: 'local', error: error.message, ...(journal?.doc_url ? { doc_url: journal.doc_url } : {}), ...(journal?.workbook_url ? { workbook_url: journal.workbook_url } : {}), resume: command(options, true) });
  }
}
