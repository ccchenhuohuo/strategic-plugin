import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asArray, cell, safeName, shown, unique, value } from './common.mjs';
import { competitionSegments } from './plan.mjs';
import { identityCell, productCell, productRows, productStatus, summaryCell } from './product.mjs';

const metric = (row, name, window, field) => shown(row, ['values', name, window, field]);

/** Stable publishing projection. Display cells are copied verbatim: no business arithmetic. */
export function tableJson(table) {
  return { id: table.id, title: table.title, columns: table.columns, rows: table.rows,
    footer: table.footer ?? [], notes: table.notes ?? [], evidence: table.evidence ?? [],
    status: table.status, reason: table.reason ?? null };
}

// renderTable escapes every pipe, including pipes preceded by a literal backslash.
// Consume exactly the added backslash rather than splitting on a regular expression.
function markdownCells(line) {
  const body = line.trim().slice(1, -1), cells = [];
  let text = '';
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '\\' && body[index + 1] === '|') { text += '|'; index++; }
    else if (body[index] === '|') { cells.push(text.trim()); text = ''; }
    else text += body[index];
  }
  cells.push(text.trim());
  return cells;
}

/** Compatibility reader for reports prepared before the JSON projection existed. */
export function parseMarkdownTable(text, metadata) {
  const lines = text.split(/\r?\n/u), header = lines.findIndex((line) => line.trim().startsWith('|'));
  if (header < 0 || !/^\|(?:\s*:?-+:?\s*\|)+\s*$/u.test(lines[header + 1] ?? '')) throw new Error(`表格 Markdown 格式损坏：${metadata.id}`);
  const columns = markdownCells(lines[header]), rows = [];
  let after = header + 2;
  while (after < lines.length && lines[after].trim().startsWith('|')) {
    const row = markdownCells(lines[after++]);
    if (row.length !== columns.length) throw new Error(`表格列数不一致：${metadata.id}`);
    rows.push(row);
  }
  const footer = [], notes = [];
  let evidence = [];
  for (const line of lines.slice(after).filter((item) => item.trim())) {
    if (line.startsWith('表注：')) notes.push(line.slice(3));
    else if (line.startsWith('证据：')) evidence = line.slice(3) === '缺失' ? [] : line.slice(3).split('、');
    else footer.push(line);
  }
  const reason = metadata.reason ?? null;
  // The old Markdown format renders an empty table as one explanatory row.
  if (metadata.status !== 'failed' && rows.length === 1 && rows[0][0] === reason && rows[0].slice(1).every((item) => item === '—')) rows.length = 0;
  if (reason && rows.length && notes.at(-1) === reason) notes.pop();
  return { id: metadata.id, title: lines[0]?.replace(/^\*\*|\*\*$/gu, '') ?? metadata.title,
    columns, rows, footer, notes, evidence, status: metadata.status ?? 'ok', reason };
}

/** JSON wins; malformed JSON must fail closed rather than silently using Markdown. */
export async function readTable(runDir, id) {
  let table;
  try { table = JSON.parse(await readFile(join(runDir, `tables/${safeName(id)}.json`), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
    const metadata = manifest.chapters.flatMap((chapter) => chapter.tables).find((item) => item.table_id === id);
    if (!metadata) throw new Error(`manifest 缺少表位：${id}`);
    return parseMarkdownTable(await readFile(join(runDir, metadata.path), 'utf8'), { ...metadata, id });
  }
  if (table.id !== id || typeof table.title !== 'string' || typeof table.status !== 'string'
      || !['columns', 'rows', 'footer', 'notes', 'evidence'].every((key) => Array.isArray(table[key]))
      || !['columns', 'footer', 'notes', 'evidence'].every((key) => table[key].every((item) => typeof item === 'string'))
      || !(table.reason === null || typeof table.reason === 'string')
      || !table.rows.every((row) => Array.isArray(row) && row.length === table.columns.length && row.every((item) => typeof item === 'string')))
    throw new Error(`表格 JSON 格式损坏：${id}`);
  return table;
}
const raw = (row, name, window, field) => value(row, ['values', name, window, field]);
const total = (data, name, window, field) => shown(data, ['scope_total', name, window, field]);
const noteNull = '— 表示服务端未提供展示值、该范围无观察、不可比或对照窗口越界；不按 0 解释。';
const displayLike = (text) => typeof text === 'string' && /^[+\-−]?\d[\d,]*(?:\.\d+)?(?:亿件|万件|亿|万|件|pp|%)?$/.test(text);
const allowed = (table) => unique([...table.rows.flat(), ...(table.footer ?? [])].filter(displayLike).map((text) => text.replaceAll('−', '-').replaceAll(',', '')));
const textError = (records) => records.filter((record) => !record?.ok).map((record) => `${record?.error?.message ?? '缺少响应'}，证据 ${record?.id ?? '缺失'}`).join('；');
const comparable = (row) => row?.current?.value !== null && row?.current?.value !== undefined;
const siteLabel = (config, site) => config.site_labels?.[site] ?? site;
const exactAbs = (value) => String(value ?? '').replace(/^-/, '');
/** 服务端原值是十进制字符串：只能按定标整数比较，字符串比较会得出「24.20亿 < 7.34亿」。 */
function scaled(value) {
  const text = String(value).trim();
  if (!/^[+-]?\d+(\.\d+)?$/u.test(text)) throw new Error(`不是十进制原值：${text}`);
  const negative = text.startsWith('-');
  const [integer, fraction = ''] = text.replace(/^[+-]/u, '').split('.');
  const magnitude = BigInt(integer + (fraction + '0'.repeat(12)).slice(0, 12));
  return negative ? -magnitude : magnitude;
}
export const compareDecimal = (left, right) => { const a = scaled(left), b = scaled(right); return a === b ? 0 : a > b ? 1 : -1; };
function greaterAbsolute(left, right) {
  const a = exactAbs(left).split('.'), b = exactAbs(right).split('.');
  if (a[0].length !== b[0].length) return a[0].length > b[0].length;
  if (a[0] !== b[0]) return a[0] > b[0];
  return (a[1] ?? '').padEnd(12, '0') > (b[1] ?? '').padEnd(12, '0');
}

export function buildTables(config, focuses, results, unlabelled, selected) {
  const tables = new Map();
  const get = (key) => results.get(key);
  const data = (key) => get(key)?.envelope?.data;
  const add = (id, title, columns, rows, keys, options = {}) => {
    const records = keys.map(get);
    const failed = records.some((record) => !record?.ok);
    const hasDisplay = rows.some((row) => row.some(displayLike)) || (options.footerDisplays ?? []).some(displayLike);
    const status = failed ? 'failed' : options.status ?? (!rows.length ? 'no_observation' : !hasDisplay ? 'display_unavailable' : 'ok');
    const reason = failed ? `取数失败：${textError(records)}` : options.reason ?? (!rows.length ? '该范围当期无观察或服务端未返回成员' : !hasDisplay && !options.status ? '服务端未提供可用于该表的展示值' : null);
    const table = { id, title, columns, rows: failed ? [[reason, ...columns.slice(1).map(() => '—')]] : rows.map((row) => row.map(cell)), evidence: unique(records.map((record) => record?.id)), status, ...(reason ? { reason } : {}), notes: unique([noteNull, ...(options.notes ?? [])]), ...(options.footer ? { footer: options.footer.map(cell) } : {}) };
    table.allowed_numbers = unique([...allowed(table), ...(options.footerDisplays ?? []).filter(displayLike).map((text) => text.replaceAll('−', '-').replaceAll(',', ''))]);
    tables.set(id, table);
    return table;
  };

  // Chapter 2.1
  const g1 = data('G1');
  const growRow = (row, label) => [label, metric(row, 'amt_discount', 'current', 'value'), metric(row, 'amt_discount', 'current', 'share_pct'), metric(row, 'amt_discount', 'yoy', 'growth_pct'), metric(row, 'amt_discount', 'prior_period', 'growth_pct'), metric(row, 'units_est', 'current', 'value'), metric(row, 'units_est', 'yoy', 'growth_pct'), metric(row, 'weighted_discount_price', 'current', 'value'), metric(row, 'weighted_discount_price', 'yoy', 'growth_pct')];
  const globalRow = ['合计', total(g1, 'amt_discount', 'current', 'value'), '全部', total(g1, 'amt_discount', 'yoy', 'growth_pct'), total(g1, 'amt_discount', 'prior_period', 'growth_pct'), total(g1, 'units_est', 'current', 'value'), total(g1, 'units_est', 'yoy', 'growth_pct'), total(g1, 'weighted_discount_price', 'current', 'value'), total(g1, 'weighted_discount_price', 'yoy', 'growth_pct')];
  add('2.1a', '全球市场规模分布（CNY）', ['站点', '销售额', '占比', '同比', '环比', '销量', '销量同比', '均价', '均价同比'], [globalRow, ...config.sites.map((site) => growRow(g1?.rows?.find((row) => row.site === site), siteLabel(config, site)))], ['G1']);

  const scopes = (key) => asArray(data(key)?.decomposition).find((entry) => entry.compare === 'yoy')?.scopes ?? [];
  const shapleyRow = (scope, label) => [label, shown(scope, ['growth_pct']), shown(scope, ['volume', 'pct_of_S0']), shown(scope, ['mix', 'pct_of_S0']), shown(scope, ['price', 'pct_of_S0']), shown(scope, ['entered', 'pct_of_S0']), shown(scope, ['exited', 'pct_of_S0']), shown(scope, ['closure_residual'])];
  add('2.1b', '增长因子（Shapley，同比）', ['范围', '同比', '销量因子（占基期）', '结构因子（占基期）', '均价因子（占基期）', '新进单元（占基期）', '退出单元（占基期）', '闭合残差'], [shapleyRow(scopes('G3')[0], '全球'), ...config.sites.map((site) => shapleyRow(scopes('G2').find((scope) => scope.site === site), siteLabel(config, site)))], ['G3', 'G2'], { notes: ['因子列直接使用服务端 pct_of_S0_display（%）；该百分比数值对应同比增长百分点，不改写展示字符串。新进和退出单元单列。'] });

  const g4 = data('G4');
  const median = g4?.reference?.median_current_value;
  const globalGrowth = g4?.reference?.scope_growth_pct?.yoy;
  const quadrant = (row) => {
    const amount = raw(row, 'amt_discount', 'current', 'value');
    const growth = raw(row, 'amt_discount', 'yoy', 'growth_pct');
    if (amount === null || amount === undefined || growth === null || growth === undefined || median === null || median === undefined || globalGrowth === null || globalGrowth === undefined) return '无同比';
    return `${compareDecimal(amount, median) >= 0 ? '高规模' : '低规模'}·${compareDecimal(growth, globalGrowth) >= 0 ? '跑赢大盘' : '跑输大盘'}`;
  };
  const g4Rows = asArray(g4?.rows).map((row) => [row.std_l1, metric(row, 'amt_discount', 'current', 'value'), metric(row, 'amt_discount', 'current', 'share_pct'), metric(row, 'amt_discount', 'yoy', 'growth_pct'), metric(row, 'amt_discount', 'yoy', 'contribution_pct'), metric(row, 'units_est', 'yoy', 'growth_pct'), metric(row, 'weighted_discount_price', 'yoy', 'growth_pct'), quadrant(row)]);
  const referenceDisplays = [shown(g4, ['reference', 'median_current_value']), shown(g4, ['reference', 'member_count']), g4?.reference?.scope_growth_pct_display?.yoy];
  add('2.2', '一级类目规模与增速（CNY）', ['类目', '销售额', '占比', '同比', '贡献', '销量同比', '均价同比', '象限'], g4Rows, ['G4'], { footer: [`参考线：中位数 ${referenceDisplays[0] ?? '—'}；成员数 ${referenceDisplays[1] ?? '—'}；全球同比 ${referenceDisplays[2] ?? '—'}`], footerDisplays: referenceDisplays });

  for (const focus of focuses) {
    const n = focus.section_no, p = `F${n}`, f1 = data(`${p}:1`), f2 = data(`${p}:2`), f3 = data(`${p}:3`), f4 = data(`${p}:4`);
    const prefix = `${n}.1`;
    add(`${prefix}a`, '分站点趋势（CNY）', ['站点', '销售额', '占比', '同比', '环比', '销量', '销量同比', '均价', '均价同比'], [['合计', total(f1, 'amt_discount', 'current', 'value'), '全部', total(f1, 'amt_discount', 'yoy', 'growth_pct'), total(f1, 'amt_discount', 'prior_period', 'growth_pct'), total(f1, 'units_est', 'current', 'value'), total(f1, 'units_est', 'yoy', 'growth_pct'), total(f1, 'weighted_discount_price', 'current', 'value'), total(f1, 'weighted_discount_price', 'yoy', 'growth_pct')], ...config.sites.map((site) => growRow(f1?.rows?.find((row) => row.site === site), siteLabel(config, site)))], [`${p}:1`]);
    const segments = [...focus.trend_segments, { label: '（范围内未归入分段）', paths: [] }];
    const missingNotes = [];
    const segRows = segments.map((segment) => {
      const global = f2?.rows?.find((row) => row.segment === segment.label);
      const cells = [segment.label, metric(global, 'amt_discount', 'current', 'value'), metric(global, 'amt_discount', 'yoy', 'growth_pct')];
      for (const site of config.sites) {
        const missing = segment.paths.some((path) => path.std_l3 !== undefined && unlabelled.has(`P:${site}:${path.std_l1}:${path.std_l2}`));
        if (missing) { cells.push('三级未标注', '三级未标注'); missingNotes.push(`${siteLabel(config, site)}的${segment.label}三级未标注，观察行落入「（范围内未归入分段）」。`); }
        else {
          const row = f3?.rows?.find((item) => item.segment === segment.label && item.site === site);
          cells.push(metric(row, 'amt_discount', 'current', 'value'), metric(row, 'amt_discount', 'yoy', 'growth_pct'));
        }
      }
      return cells;
    });
    add(`${prefix}b`, '分段 × 站点销售额与同比（CNY）', ['分段', '全球销售额', '全球同比', ...config.sites.flatMap((site) => [`${siteLabel(config, site)}销售额`, `${siteLabel(config, site)}同比`])], segRows, [`${p}:2`, `${p}:3`], { notes: unique(missingNotes) });
    add(`${prefix}c`, '全球分段结构（CNY）', ['分段', '销售额', '占比', 'pp', '同比', '贡献', '销量同比', '均价同比'], segments.map((segment) => {
      const row = f2?.rows?.find((item) => item.segment === segment.label);
      return [segment.label, metric(row, 'amt_discount', 'current', 'value'), metric(row, 'amt_discount', 'current', 'share_pct'), metric(row, 'amt_discount', 'yoy', 'share_delta_pp'), metric(row, 'amt_discount', 'yoy', 'growth_pct'), metric(row, 'amt_discount', 'yoy', 'contribution_pct'), metric(row, 'units_est', 'yoy', 'growth_pct'), metric(row, 'weighted_discount_price', 'yoy', 'growth_pct')];
    }), [`${p}:2`]);
    const priceScopes = scopes(`${p}:4`);
    const priceRows = config.sites.map((site) => {
      const scope = priceScopes.find((entry) => entry.site === site);
      let largest = null;
      for (const member of asArray(scope?.members)) if (member.mix_effect !== null && member.mix_effect !== undefined && (!largest || greaterAbsolute(member.mix_effect, largest.mix_effect))) largest = member;
      return [siteLabel(config, site), shown(scope, ['P0']), shown(scope, ['P1']), shown(scope, ['delta']), shown(scope, ['price_effect']), shown(scope, ['mix_effect']), largest?.[focus.price_mix_by] ?? '—'];
    });
    add(`${prefix}d`, '分站点均价拆分（CNY，同比）', ['站点', '对照均价', '当期均价', '变化', '价格效应', '结构效应', '结构效应绝对值最大成员'], priceRows, [`${p}:4`]);
    const poolRows = config.sites.map((site) => {
      const item = data(`${p}:5:${site}`);
      return [siteLabel(config, site), identityCell(item, 'current_identities'), identityCell(item, 'compare_identities'), summaryCell(item, ['pool', 'continuing', 'amount_share_current_pct']), summaryCell(item, ['pool', 'entered', 'amount_share_current_pct']), summaryCell(item, ['pool', 'exited', 'amount_share_compare_pct']), summaryCell(item, ['like_for_like', 'paasche_index']), summaryCell(item, ['like_for_like', 'unit_value_change_pct', 'p50'])];
    });
    add(`${prefix}e`, '商品身份池与同商品单位价值', ['站点', '当期身份数', '同比期身份数', '延续金额占比', '新进金额占比', '退出金额占比', 'Paasche 指数', '单位价值变化中位数'], poolRows, config.sites.map((site) => `${p}:5:${site}`), { notes: ['身份数仅指匹配子集内有观察的商品身份数；服务商截断极低销量长尾。'] });

    const globalBands = asArray(data(`${p}:6`)?.bands);
    const siteBands = Object.fromEntries(config.sites.map((site) => [site, asArray(data(`${p}:7:${site}`)?.bands)]));
    const bandIds = unique([...globalBands.map((band) => band.band_id), ...config.sites.flatMap((site) => siteBands[site].map((band) => band.band_id))]);
    const bandRows = bandIds.map((bandId) => {
      const global = globalBands.find((band) => band.band_id === bandId);
      const cells = [global?.band_label ?? config.sites.map((site) => siteBands[site].find((band) => band.band_id === bandId)?.band_label).find(Boolean) ?? bandId, shown(global, ['current', 'amount_share_pct']), shown(global, ['yoy', 'share_delta_pp'])];
      for (const site of config.sites) {
        const band = siteBands[site].find((item) => item.band_id === bandId);
        cells.push(shown(band, ['current', 'amount_share_pct']), shown(band, ['yoy', 'share_delta_pp']));
      }
      return cells;
    });
    add(`${n}.2a`, '价格带金额份额', ['档位', '全球当期份额', '全球 pp', ...config.sites.flatMap((site) => [`${siteLabel(config, site)}当期份额`, `${siteLabel(config, site)}pp`])], bandRows, [`${p}:6`, ...config.sites.map((site) => `${p}:7:${site}`)]);

    for (const segment of competitionSegments(focus)) for (const site of config.sites) {
      const key = `B1:${n}:${segment.label}:${site}`, call = get(key), b = data(key), pick = selected[key] ?? { competitors: [], company: [], failed: true };
      const idBase = `${n}.3.${segment.label}.${site}`;
      const brandRows = asArray(b?.rows).filter((row) => !['OTHERS/其他', '其他', '未分类'].includes(row.brand)).map((row) => [shown(row, ['current', 'rank']), `${config.company_brands.includes(row.brand) ? '★ ' : ''}${row.brand}`, shown(row, ['current', 'amt_discount']), shown(row, ['current', 'amt_cny']), shown(row, ['current', 'share_pct']), shown(row, ['yoy', 'share_delta_pp']), shown(row, ['yoy', 'rank_change']), shown(row, ['current', 'asp']), row.yoy?.status ?? '—']);
      const partition = b?.partitions?.current ?? {};
      const concentration = b?.concentration?.current ?? {};
      const partitionDisplays = [shown(partition, ['named_top_n']), shown(partition, ['named_remainder']), shown(partition, ['others_bucket']), shown(partition, ['unclassified']), shown(concentration, ['cr5_pct']), shown(concentration, ['cr10_pct']), shown(concentration, ['hhi_named_lower_bound']), b?.named_brand_count_display?.current];
      const footer = `分区：具名前 N ${partitionDisplays[0] ?? '—'}；其余具名 ${partitionDisplays[1] ?? '—'}；非品牌桶 ${partitionDisplays[2] ?? '—'}；未分类 ${partitionDisplays[3] ?? '—'}；CR5 ${partitionDisplays[4] ?? '—'}；CR10 ${partitionDisplays[5] ?? '—'}；HHI 下界 ${partitionDisplays[6] ?? '—'}；具名品牌数 ${partitionDisplays[7] ?? '—'}`;
      const fallback = call?.fallback ? '该站点三级未标注，按父级二级类目展示。' : null;
      const brandTable = add(`${idBase}.brand`, `${segment.label} · ${siteLabel(config, site)}品牌格局`, ['名次', '品牌', '本币销售额', 'CNY 销售额', '份额', 'pp', '名次变化', '均价', '状态'], brandRows, [key], { footer: [footer], footerDisplays: partitionDisplays, notes: ['★ 为公司品牌', ...(fallback ? [fallback] : [])] });
      const b2Key = key.replace('B1:', 'B2:'), b3Key = key.replace('B1:', 'B3:');
      for (const [index, brand] of pick.competitors.entries()) {
        const pData = data(b2Key);
        const rows = productRows(pData, brand).map((row) => [productCell(row, 'rank'), row.title ?? '—', productCell(row, 'amount_local'), productCell(row, 'amount_cny'), productCell(row, 'share_brand'), productCell(row, 'share_scope'), productCell(row, 'growth'), productCell(row, 'unit_value'), productStatus(row), row.link ?? '—']);
        add(`${idBase}.${String.fromCharCode(65 + index)}`, `${String.fromCharCode(65 + index)}：${brand} Top 商品`, ['名次', '标题', '本币销售额', 'CNY 销售额', '品牌内占比', '范围内份额', '同比', '单位价值（本币）', '状态', '链接'], rows, [b2Key], { status: rows.length ? 'ok' : 'no_observation', reason: rows.length ? null : '该品牌商品当期无观察', notes: fallback ? [fallback] : [] });
      }
      const companyRows = asArray(data(b3Key)?.rows).filter((row) => pick.company.includes(row.brand)).map((row) => [row.brand, productCell(row, 'rank'), row.title ?? '—', productCell(row, 'amount_local'), productCell(row, 'amount_cny'), productCell(row, 'share_brand'), productCell(row, 'share_scope'), productCell(row, 'growth'), productCell(row, 'unit_value'), productStatus(row), row.link ?? '—']);
      if (pick.failed) add(`${idBase}.company`, '公司品牌 Top 商品', ['说明'], [['取数失败']], [key], { status: 'failed', reason: brandTable.reason, notes: fallback ? [fallback] : [] });
      else if (pick.company.length) add(`${idBase}.company`, '公司品牌 Top 商品', ['品牌', '名次', '标题', '本币销售额', 'CNY 销售额', '品牌内占比', '范围内份额', '同比', '单位价值（本币）', '状态', '链接'], companyRows, [b3Key], { status: companyRows.length ? 'ok' : 'no_observation', reason: companyRows.length ? null : '公司品牌商品当期无观察', notes: fallback ? [fallback] : [] });
      else add(`${idBase}.company`, '公司品牌 Top 商品', ['说明'], [['公司品牌在该切片当期无观察']], [key], { status: 'no_observation', reason: '公司品牌在该切片当期无观察', notes: fallback ? [fallback] : [] });
      const shortfall = !pick.failed && pick.competitors.length < config.drilldown.competitor_brands ? `具名竞品不足 ${config.drilldown.competitor_brands} 个；仅列 ${pick.competitors.length} 个。` : null;
      if (shortfall) brandTable.notes.push(shortfall);
    }
  }
  return tables;
}
