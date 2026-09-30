import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asArray, digest, readJson, redact, safeName, unique, writeJson } from './common.mjs';
import { readTable } from './tables.mjs';
import { clientEnv, withoutMcpTokens } from './environment.mjs';

const chartDir = fileURLToPath(new URL('../charts/', import.meta.url));
const GROWTH = 'strategic_market_growth', PRICE = 'strategic_price_band_distribution', BRAND = 'strategic_brand_view';
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const finiteRaw = (item) => item !== null && item !== undefined && numberPattern.test(String(item)) && Number.isFinite(Number(item));
const raw = (item, field) => {
  if (!finiteRaw(item)) throw new Error(`缺少可绘制的服务端原值：${field}`);
  return String(item);
};
const display = (item, field) => {
  if (typeof item !== 'string' || !item.length) throw new Error(`缺少服务端展示字段：${field}`);
  return item;
};
const statusReason = (status) => ({ appeared: '新进（同比期无观察）', disappeared: '退出（当期无观察）', unobserved_current: '当期无观察', unobserved_both: '两期无观察', compare_out_of_range: '同比期超出水位', unlabelled_l3: '三级未标注', others_bucket: '非品牌桶', unclassified: '未分类', quarantined: '检疫', incomparable: '不可比', growth_missing: '同比增速缺失', share_missing: '份额或同比份额变化缺失', amount_missing: 'CNY 销售额缺失', current_amount_missing: '当期销售额缺失', rank_missing: '当期名次缺失' })[status] ?? `不可比（${status ?? '坐标缺失'}）`;
const exclusion = (name, status, reason = statusReason(status)) => ({ name: display(name, '排除成员标签'), status: status ?? 'incomparable', reason });
const missingState = (provided, fallback) => provided && provided !== 'comparable' ? provided : fallback;
const sameGroup = (record, group) => record.tool === GROWTH && JSON.stringify(record.arguments?.group_by) === JSON.stringify(group);
const windowCall = (record) => typeof record.arguments?.current_start === 'string' && typeof record.arguments?.current_end === 'string';
const failure = (record) => `${record.id}：${record.error?.message ?? record.error?.error ?? '取数失败'}`;
async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  try { await writeJson(temporary, value); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

// 数据红线：所有数据文字逐字来自 *_display 或标签；原值只供几何定位，不舍入、换单位或做业务算术。
// 参考线只使用服务端 reference 或常数 0；不计算客户端均值/中位数，尤其不把整体 reference 放进站点面板。
// 缺失≠零：无坐标/新进/退出/不可比/三级未标注/检疫成员只列排除说明，绝不补 0。
// 非品牌桶 OTHERS/其他、未分类及 brand_kind 标记永远不画为品牌。
// 任一来源证据失败整图 skipped，不画残缺数据；价格带顺序来自响应政策，缺价不参与堆叠。
export async function buildChartSpecs(runDir) {
  const manifest = await readJson(join(runDir, 'manifest.json'));
  if (!Array.isArray(manifest.chapters) || !manifest.windows?.current || typeof manifest.label !== 'string' || !manifest.release_id) throw new Error('运行目录损坏：manifest 缺少 chapters/windows/label/release_id');
  const references = manifest.chapters.flatMap((chapter) => asArray(chapter.tables));
  const byTable = new Map(references.map((table) => [table.table_id, table]));
  const planned = [];
  for (const chapter of manifest.chapters) for (const block of asArray(chapter.blocks)) {
    if (block.type !== 'table') continue;
    if (block.id === '2.2') planned.push({ id: 'chart.2.2', kind: 'category_bubble', anchor: block.id, source: block.id });
    else if (/^\d+\.1a$/u.test(block.id) && Number(block.id.split('.')[0]) >= 3) planned.push({ id: `chart.${block.id.split('.')[0]}.1`, kind: 'segment_matrix', anchor: block.id, source: block.id.replace(/a$/u, 'b'), section: Number(block.id.split('.')[0]) });
    else if (/^\d+\.2a$/u.test(block.id)) planned.push({ id: `chart.${block.id.split('.')[0]}.2`, kind: 'price_band', anchor: block.id, source: block.id, section: Number(block.id.split('.')[0]) });
    else if (/^\d+\.3\..+\.brand$/u.test(block.id)) {
      const base = block.id.slice(0, -6), last = base.lastIndexOf('.');
      planned.push({ id: `chart.${base}`, kind: 'brand_bubble', anchor: block.id, source: block.id, section: Number(base.split('.')[0]), segment: base.slice(base.indexOf('.3.') + 3, last), site: base.slice(last + 1) });
    }
  }
  if (new Set(planned.map((chart) => chart.id)).size !== planned.length) throw new Error('运行目录损坏：manifest 中图表锚点重复');
  let config = null, configError = null;
  try {
    const args = await readJson(join(runDir, 'run-args.json'));
    if (typeof args.config !== 'string' || !args.config_digest) throw new Error('run-args.json 缺少配置路径或 config_digest');
    config = await readJson(resolve(runDir, args.config));
    if (digest(config) !== args.config_digest) throw new Error('配置摘要与 run-args.json 的 config_digest 不一致，配置自取数后已变更');
    if (!Array.isArray(config.sites) || !config.site_labels || !Array.isArray(config.focus)) throw new Error('配置缺少 sites/site_labels/focus');
    if (config.sites.some((site) => typeof site !== 'string' || typeof config.site_labels[site] !== 'string')) throw new Error('配置中的站点与 site_labels 不完整');
  } catch (error) { configError = `无法核验运行配置：${error.message}`; }
  const allEvidence = [];
  if (!configError) {
    const names = (await readdir(join(runDir, 'evidence'))).filter((name) => /^E\d+\.json$/u.test(name)).sort();
    for (const name of names) allEvidence.push(await readJson(join(runDir, 'evidence', name)));
  }
  const siteName = (site) => config?.site_labels?.[site] ?? site;
  const charts = [];
  for (const plan of planned) {
    const tableRef = byTable.get(plan.source);
    if (!tableRef) throw new Error(`运行目录损坏：缺少表位 ${plan.source}`);
    const focus = config?.focus.find((item) => item.section_no === plan.section);
    const titles = {
      category_bubble: `${manifest.label}（${manifest.windows.current.start}～${manifest.windows.current.end}）一级类目规模 × 同比（CNY）`,
      segment_matrix: `${manifest.label} ${focus?.std_l1 ?? tableRef.title}赛道规模 × 同比（CNY）`,
      price_band: `${manifest.label} ${focus?.std_l1 ?? tableRef.title}价格带结构迁移（CNY，金额份额）`,
      brand_bubble: `${siteName(plan.site)} · ${plan.segment}`,
    };
    const chart = { id: plan.id, kind: plan.kind, file: `${safeName(plan.id)}.png`, before_table: plan.anchor, evidence: asArray(tableRef.evidence), title: titles[plan.kind], subtitle: plan.kind === 'category_bubble' ? '气泡大小 = 当期销售额' : plan.kind === 'brand_bubble' ? '气泡直径按 CNY 销售额线性映射；名次变化为正表示名次上升；★ 为公司品牌' : '', caption: `图：${titles[plan.kind]}`, status: 'ready', excluded: [], notes: [] };
    charts.push(chart);
    if (configError) { chart.status = 'skipped'; chart.reason = configError; continue; }
    try {
      const table = await readTable(runDir, plan.source);
      // Matrix exclusions below already enumerate every affected site/segment.
      // Do not repeat each source-table sentence and then enumerate them again.
      if (plan.kind !== 'segment_matrix') chart.notes.push(...asArray(table.notes).filter((note) => /三级未标注|父级/u.test(note)));
      const records = chart.evidence.map((id) => allEvidence.find((record) => record.id === id));
      if (records.some((record) => !record)) throw new Error('表位引用的证据文件缺失');
      const select = (predicate, expected) => {
        const matches = records.filter(predicate);
        if (matches.length !== 1) throw new Error(`证据参数不能唯一确定${expected}（匹配 ${matches.length} 条）`);
        if (!matches[0].ok) throw new Error(failure(matches[0]));
        if (matches[0].envelope?.stamp?.release_id !== manifest.release_id) throw new Error(`${matches[0].id} release_id 与报告不一致`);
        if (matches[0].arguments?.current_start !== manifest.windows.current.start || matches[0].arguments?.current_end !== manifest.windows.current.end) throw new Error(`${matches[0].id} 取数窗口与报告不一致`);
        if (!asArray(matches[0].arguments?.compare).includes('yoy')) throw new Error(`${matches[0].id} 未取同比窗口`);
        return matches[0];
      };
      if (plan.kind === 'category_bubble') {
        const record = select((item) => sameGroup(item, ['std_l1']) && windowCall(item) && item.arguments?.currency === 'cny', '一级类目 CNY 证据');
        chart.evidence = [record.id]; chart.points = [];
        for (const row of asArray(record.envelope.data.rows)) {
          const amt = row.values?.amt_discount;
          if (!finiteRaw(amt?.current?.value) || amt?.yoy?.status !== 'comparable' || !finiteRaw(amt?.yoy?.growth_pct)) { chart.excluded.push(exclusion(row.std_l1, missingState(amt?.yoy?.status, !finiteRaw(amt?.current?.value) ? amt?.yoy?.status ? 'current_amount_missing' : 'unobserved_current' : 'growth_missing'))); continue; }
          chart.points.push({ name: display(row.std_l1, 'std_l1'), x: raw(amt.current.value, 'current.value'), y: raw(amt.yoy.growth_pct, 'yoy.growth_pct'), size: raw(amt.current.value, 'current.value'), label: `${row.std_l1}\n${display(amt.current.value_display, 'current.value_display')}（${display(amt.yoy.growth_pct_display, 'yoy.growth_pct_display')}）` });
        }
        const ref = record.envelope.data.reference;
        chart.reference = { median: { value: raw(ref?.median_current_value, 'reference.median_current_value'), label: `中位数 ${display(ref?.median_current_value_display, 'reference.median_current_value_display')}` }, growth: { value: raw(ref?.scope_growth_pct?.yoy, 'reference.scope_growth_pct.yoy'), label: `全球同比 ${display(ref?.scope_growth_pct_display?.yoy, 'reference.scope_growth_pct_display.yoy')}` } };
        if (!chart.points.length) throw new Error('没有可比且坐标齐全的一级类目');
      } else if (plan.kind === 'segment_matrix') {
        if (!focus) throw new Error('配置中找不到该章分段定义');
        const record = select((item) => sameGroup(item, ['segment', 'site']) && windowCall(item) && item.arguments?.currency === 'cny', '分段×站点 CNY 证据');
        chart.evidence = [record.id]; chart.segments = focus.trend_segments.map((segment) => display(segment.label, 'trend_segments.label')); chart.layout = chart.segments.length > 4 ? 'grid' : 'row'; chart.panels = [];
        for (const site of config.sites) {
          const panel = { site, name: siteName(site), points: [] };
          chart.panels.push(panel);
          for (const [index, segment] of focus.trend_segments.entries()) {
            const probes = segment.paths.flatMap((path) => {
              if (path.std_l3 === undefined) return [];
              const matching = allEvidence.filter((item) => sameGroup(item, ['std_l3']) && windowCall(item) && item.arguments?.filters?.site === site && item.arguments.filters.std_l1 === path.std_l1 && item.arguments.filters.std_l2 === path.std_l2);
              if (matching.length !== 1) throw new Error(`三级标注探针缺失或不唯一：${siteName(site)} ${path.std_l1}/${path.std_l2}`);
              return matching;
            });
            if (probes.some((probe) => !probe.ok)) throw new Error(`三级标注状态无法核验：${probes.filter((probe) => !probe.ok).map(failure).join('；')}`);
            if (probes.some((probe) => probe.envelope?.stamp?.release_id !== manifest.release_id)) throw new Error('三级标注探针 release_id 与报告不一致');
            if (probes.some((probe) => probe.arguments.current_start !== manifest.windows.current.start || probe.arguments.current_end !== manifest.windows.current.end)) throw new Error('三级标注探针窗口与报告不一致');
            const parentMissing = probes.some((probe) => isUnlabelled(probe.envelope?.data?.rows));
            // 排除项由探针证据确定，其证据号同时列入图注，不能只引用绘制点的数据来源。
            if (parentMissing) chart.evidence = unique([...chart.evidence, ...probes.filter((probe) => isUnlabelled(probe.envelope?.data?.rows)).map((probe) => probe.id)]);
            if (parentMissing) { chart.excluded.push(exclusion(`${siteName(site)} ${segment.label}`, 'unlabelled_l3', '三级未标注（观察行落入「（范围内未归入分段）」）')); continue; }
            const row = asArray(record.envelope.data.rows).find((item) => item.site === site && item.segment === segment.label), amt = row?.values?.amt_discount, asp = row?.values?.weighted_discount_price;
            if (!finiteRaw(amt?.current?.value) || amt?.yoy?.status !== 'comparable' || !finiteRaw(amt?.yoy?.growth_pct)) { chart.excluded.push(exclusion(`${siteName(site)} ${segment.label}`, missingState(amt?.yoy?.status, !finiteRaw(amt?.current?.value) ? amt?.yoy?.status ? 'current_amount_missing' : 'unobserved_current' : 'growth_missing'))); continue; }
            panel.points.push({ name: segment.label, x: raw(amt.current.value, 'current.value'), y: raw(amt.yoy.growth_pct, 'yoy.growth_pct'), label: `${segment.label}\n${display(amt.current.value_display, 'amt.current.value_display')}，同比 ${display(amt.yoy.growth_pct_display, 'amt.yoy.growth_pct_display')}\n均价 ${display(asp?.current?.value_display, 'weighted_discount_price.current.value_display')}，同比 ${display(asp?.yoy?.growth_pct_display, 'weighted_discount_price.yoy.growth_pct_display')}`, segment_index: index });
          }
        }
        if (!chart.panels.some((panel) => panel.points.length)) throw new Error('没有可比且坐标齐全的赛道');
      } else if (plan.kind === 'price_band') {
        const global = select((item) => item.tool === PRICE && windowCall(item) && item.arguments?.scope === 'cross_site_cny' && item.arguments?.profile === 'cny', '全球 CNY 价格带证据');
        const ranges = [{ record: global, site: 'global', name: '全球' }, ...config.sites.map((site) => ({ record: select((item) => item.tool === PRICE && windowCall(item) && item.arguments?.scope === 'single_site' && item.arguments?.profile === 'cny' && item.arguments?.site === site, `${site} CNY 价格带证据`), site, name: siteName(site) }))];
        chart.evidence = ranges.map((range) => range.record.id); chart.bands = asArray(global.envelope.data.bands).filter((band) => !band.is_missing_price).map((band) => ({ name: display(band.band_label, 'band_label') })); chart.ranges = [];
        for (const range of ranges) {
          const data = range.record.envelope.data, bands = [];
          const names = asArray(data.bands).filter((band) => !band.is_missing_price).map((band) => band.band_label);
          // 政策响应可因无观察而缺档；禁止补 0。存在档的相对顺序须仍等于全球政策顺序。
          if (names.some((name) => !chart.bands.some((band) => band.name === name)) || JSON.stringify(chart.bands.filter((band) => names.includes(band.name)).map((band) => band.name)) !== JSON.stringify(names)) throw new Error(`${range.name}价格档与全球政策顺序不一致`);
          for (const band of asArray(data.bands)) {
            if (band.is_missing_price) {
              chart.notes.push(`${range.name}缺价 当期 ${typeof band.current?.amount_share_pct_display === 'string' ? band.current.amount_share_pct_display : '无观察'}，对照期 ${typeof band.yoy?.amount_share_pct_display === 'string' ? band.yoy.amount_share_pct_display : '无观察'}`); continue;
            }
            if (!finiteRaw(band.current?.amount_share_pct) || !finiteRaw(band.yoy?.amount_share_pct)) { chart.excluded.push(exclusion(`${range.name} ${band.band_label}`, missingState(band.yoy?.status, 'share_missing'))); continue; }
            bands.push({ name: band.band_label, current: raw(band.current.amount_share_pct, 'current.amount_share_pct'), yoy: raw(band.yoy.amount_share_pct, 'yoy.amount_share_pct'), current_label: display(band.current.amount_share_pct_display, 'current.amount_share_pct_display'), yoy_label: display(band.yoy.amount_share_pct_display, 'yoy.amount_share_pct_display'), growth_label: typeof band.yoy?.amount_growth_pct_display === 'string' ? band.yoy.amount_growth_pct_display : statusReason(band.yoy?.status === 'comparable' ? 'incomparable' : band.yoy?.status) });
          }
          if (!bands.length) throw new Error(`${range.name}没有两期份额齐全的政策档`);
          chart.ranges.push({ site: range.site, name: range.name, bands, asp_label: `均价 当期 ${display(data.totals?.current?.asp_display, 'totals.current.asp_display')}，对照期 ${display(data.totals?.yoy?.asp_display, 'totals.yoy.asp_display')}（CNY）` });
        }
        chart.notes.push(`未标注的档位数值见表 ${plan.anchor}`);
      } else {
        const record = select((item) => item.tool === BRAND && windowCall(item) && item.arguments?.currency === 'cny' && item.arguments?.site === plan.site, '品牌 CNY 窗口证据');
        chart.evidence = [record.id]; chart.points = []; chart.currency = display(record.envelope.data.currency, 'data.currency');
        for (const row of asArray(record.envelope.data.rows)) {
          if (row.brand === 'OTHERS/其他' || row.brand === '未分类' || ['others_bucket', 'unclassified'].includes(row.brand_kind)) { chart.excluded.push(exclusion(row.brand, row.brand_kind ?? (row.brand === 'OTHERS/其他' ? 'others_bucket' : 'unclassified'))); continue; }
          const current = row.current, yoy = row.yoy;
          if (current?.rank === null || current?.rank === undefined || yoy?.status !== 'comparable' || !finiteRaw(current.share_pct) || !finiteRaw(yoy?.share_delta_pp) || !finiteRaw(current?.amt_cny)) { chart.excluded.push(exclusion(row.brand, missingState(yoy?.status, current?.rank === null || current?.rank === undefined ? 'rank_missing' : !finiteRaw(current?.amt_cny) ? 'amount_missing' : 'share_missing'))); continue; }
          const pinned = Boolean(row.pinned || config.company_brands?.includes(row.brand));
          chart.points.push({ name: display(row.brand, 'brand'), x: raw(current.share_pct, 'current.share_pct'), y: raw(yoy.share_delta_pp, 'yoy.share_delta_pp'), size: raw(current.amt_cny, 'current.amt_cny'), rank: raw(current.rank, 'current.rank'), rank_label: display(current.rank_display, 'current.rank_display'), pinned, label: `#${display(current.rank_display, 'current.rank_display')} ${pinned ? '★ ' : ''}${row.brand}（名次 ${display(yoy.rank_change_display, 'yoy.rank_change_display')}）\n份额 ${display(current.share_pct_display, 'current.share_pct_display')}，${display(yoy.share_delta_pp_display, 'yoy.share_delta_pp_display')}\n销售额 ${display(current.amt_cny_display, 'current.amt_cny_display')}（CNY），均价 ${display(current.asp_display, 'current.asp_display')} ${chart.currency}` });
        }
        if (!chart.points.length) throw new Error('没有可比且坐标齐全的具名品牌');
      }
    } catch (error) {
      chart.status = 'skipped'; chart.reason = error.message;
      // 已中途生成的数据不交给绘图器，防止画出部分成功的图。
      for (const key of ['points', 'reference', 'panels', 'segments', 'layout', 'ranges', 'bands', 'currency']) delete chart[key];
    }
    chart.notes = unique(chart.notes);
  }
  return { version: 1, label: manifest.label, release_id: manifest.release_id, windows: manifest.windows, charts };
}

function isUnlabelled(rows) {
  const observed = asArray(rows).filter((row) => finiteRaw(row.values?.amt_discount?.current?.value));
  return observed.length > 0 && observed.every((row) => row.std_l3 === '未分类');
}

export async function runChartProcess(command, args, { env = process.env, cwd, timeout = 180000, stderr = false } = {}) {
  return await new Promise((done) => {
    let stdout = '', errors = '', timedOut = false, settled = false;
    // 绘图器与 pip 用不到 访问令牌，不把它交给外部进程。
    const rest = withoutMcpTokens(env);
    const child = spawn(command, args, { env: { ...rest, PYTHONDONTWRITEBYTECODE: '1', MPLBACKEND: 'Agg' }, cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      // venv/ensurepip 会派生子进程；超时清理整个组，避免半成品被孤儿进程继续写入。
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, Math.max(1, timeout));
    const complete = (value) => { if (settled) return; settled = true; clearTimeout(timer); done(value); };
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1000000); });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-1000000); if (stderr) process.stderr.write(redact(String(chunk))); });
    child.once('error', (error) => complete({ code: null, stdout, stderr: errors, error: error.message, timedOut }));
    child.once('close', (code) => complete({ code, stdout, stderr: errors, timedOut }));
  });
}

const importNames = { pillow: 'PIL', 'python-dateutil': 'dateutil', fonttools: 'fontTools' };
async function lockRequirements(lockPath) {
  const lock = await readFile(lockPath, 'utf8');
  const entries = lock.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+)==([A-Za-z0-9._+-]+)$/u);
    if (!match) throw new Error(`依赖锁文件格式无效：${line}`);
    return { name: match[1], version: match[2], module: importNames[match[1]] ?? match[1] };
  });
  return { entries, hash: createHash('sha256').update(lock).digest('hex') };
}
async function probePython(python, lock, env, remaining) {
  const code = `import sys,json,importlib,importlib.metadata\nrequirements=json.loads(${JSON.stringify(JSON.stringify(lock.entries))})\nversions={}\nfor item in requirements:\n importlib.import_module(item['module'])\n versions[item['name']]=importlib.metadata.version(item['name'])\n if versions[item['name']]!=item['version']: raise RuntimeError(item['name']+' 版本 '+versions[item['name']]+' 不符合锁定 '+item['version'])\nif sys.version_info[:2] not in ((3,12),(3,13)): raise RuntimeError('Python 版本须为 3.12 或 3.13')\nprint(json.dumps({'python':sys.version.split()[0],'matplotlib':versions['matplotlib'],'packages':versions}))`;
  const result = await runChartProcess(python, ['-B', '-c', code], { env, timeout: Math.min(30000, remaining) });
  if (result.code !== 0) return { ok: false, reason: result.timedOut ? '图表环境校验超时' : `图表环境不可用：${result.error ?? result.stderr.trim().split('\n').at(-1) ?? '解释器无法运行'}` };
  try { return { ok: true, ...JSON.parse(result.stdout.trim().split('\n').at(-1)) }; } catch { return { ok: false, reason: '图表环境校验未返回有效 JSON' }; }
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function prepareChartEnvironment({ runDir, envDir, python, env = process.env, lockPath = join(chartDir, 'requirements.lock'), deadlineMs = 540000 } = {}) {
  const explicit = python ?? clientEnv(env, 'CHART_PYTHON');
  const source = explicit ? 'explicit' : envDir ? 'managed' : 'none';
  const unavailable = (reason, interpreter = explicit ?? null) => ({ source, python: interpreter, matplotlib: null, ok: false, reason: redact(reason) });
  if (source === 'none') return unavailable('未指定图表环境');
  const deadline = Date.now() + deadlineMs, remaining = () => deadline - Date.now();
  let lock;
  try { lock = await lockRequirements(lockPath); }
  catch (error) { return unavailable(`图表依赖锁不可用：${error.message}`); }
  const mplconfig = explicit ? join(runDir, 'charts', '.mplconfig') : join(resolve(envDir), 'mplconfig');
  const processEnv = { ...env, MPLCONFIGDIR: mplconfig };
  if (explicit) {
    try { await mkdir(mplconfig, { recursive: true }); }
    catch (error) { return unavailable(`图表字体缓存目录不可用：${error.message}`); }
    const checked = await probePython(explicit, lock, processEnv, remaining());
    return checked.ok ? { ok: true, source, python: explicit, matplotlib: checked.matplotlib, version: checked.python, mplconfig } : unavailable(checked.reason);
  }
  const target = resolve(envDir), interpreter = join(target, 'bin', 'python');
  const reuse = async () => {
    try {
      const metadata = await readJson(join(target, 'env.json'));
      if (metadata.lock_digest !== lock.hash) return null;
      const checked = await probePython(interpreter, lock, processEnv, remaining());
      if (!checked.ok || checked.python !== metadata.python) return null;
      return { ok: true, source, python: interpreter, matplotlib: checked.matplotlib, version: checked.python, mplconfig };
    } catch { return null; }
  };
  const reused = await reuse();
  if (reused) return reused;
  try { await mkdir(dirname(target), { recursive: true }); }
  catch (error) { return unavailable(`图表环境目录不可用：${error.message}`, interpreter); }
  const lockDir = `${target}.lock`, temporary = `${target}.tmp-${process.pid}`;
  let held = false;
  try {
    while (!held) {
      if (remaining() <= 0) return unavailable('等待图表环境锁超时', interpreter);
      try { await mkdir(lockDir); held = true; await writeJson(join(lockDir, 'owner.json'), { pid: process.pid }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // 仅清理超过建环境总时限的锁；并发构建者通常在下一次循环即可复用其结果。
        if (Date.now() - (await stat(lockDir)).mtimeMs > 540000) { await rm(lockDir, { recursive: true, force: true }); continue; }
        await delay(Math.min(1000, Math.max(1, remaining())));
        const concurrent = await reuse(); if (concurrent) return concurrent;
      }
    }
    const afterLock = await reuse(); if (afterLock) return afterLock;
    let base = null;
    for (const command of ['python3.13', 'python3.12', 'python3']) {
      if (remaining() <= 0) break;
      const result = await runChartProcess(command, ['-B', '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { env: processEnv, timeout: Math.min(10000, remaining()) });
      if (result.code === 0 && /^(3\.12|3\.13)$/u.test(result.stdout.trim())) { base = command; break; }
    }
    if (!base) return unavailable('找不到 Python 3.12/3.13 基础解释器', interpreter);
    process.stderr.write('图表环境：正在创建托管 Python 环境。\n');
    await rm(temporary, { recursive: true, force: true });
    const created = await runChartProcess(base, ['-B', '-m', 'venv', temporary], { env: processEnv, timeout: remaining(), stderr: true });
    if (created.code !== 0) return unavailable(created.timedOut ? '建立图表环境超时' : `建立图表环境失败：${created.error ?? created.stderr.trim().split('\n').at(-1)}`, interpreter);
    const indexes = unique([clientEnv(env, 'PIP_INDEX_URL'), 'https://mirrors.aliyun.com/pypi/simple/', 'https://pypi.org/simple']);
    let installed = false, installationError = '';
    for (const index of indexes) {
      if (remaining() <= 0) break;
      process.stderr.write('图表环境：正在安装锁定的绘图依赖。\n');
      const result = await runChartProcess(join(temporary, 'bin', 'python'), ['-B', '-m', 'pip', 'install', '--only-binary=:all:', '--no-input', '--disable-pip-version-check', '--timeout', '60', '-r', resolve(lockPath), '--index-url', index], { env: { ...processEnv, MPLCONFIGDIR: join(temporary, 'mplconfig') }, timeout: remaining(), stderr: true });
      if (result.code === 0) { installed = true; break; }
      installationError = result.timedOut ? '安装图表依赖超时' : `安装图表依赖失败：${result.error ?? result.stderr.trim().split('\n').at(-1)}`;
    }
    if (!installed) return unavailable(remaining() <= 0 ? '图表环境准备超过 9 分钟时限' : installationError || '安装图表依赖失败', interpreter);
    const checked = await probePython(join(temporary, 'bin', 'python'), lock, { ...processEnv, MPLCONFIGDIR: join(temporary, 'mplconfig') }, remaining());
    if (!checked.ok) return unavailable(checked.reason, interpreter);
    await writeJson(join(temporary, 'env.json'), { lock_digest: lock.hash, python: checked.python });
    const previous = `${target}.old-${process.pid}`;
    let replaced = false;
    try { await rename(target, previous); replaced = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(temporary, target); } catch (error) { if (replaced) await rename(previous, target); throw error; }
    if (replaced) await rm(previous, { recursive: true, force: true });
    return { ok: true, source, python: interpreter, matplotlib: checked.matplotlib, version: checked.python, mplconfig };
  } catch (error) { return unavailable(`图表环境准备失败：${error.message}`, interpreter); }
  finally { await rm(temporary, { recursive: true, force: true }); if (held) await rm(lockDir, { recursive: true, force: true }); }
}

export async function charts({ runDir, envDir, python, only } = {}) {
  if (!runDir) throw new Error('charts 必须提供 --run-dir');
  runDir = resolve(runDir);
  const fullSpecs = await buildChartSpecs(runDir);
  const specs = { ...fullSpecs, charts: fullSpecs.charts };
  if (only !== undefined) {
    const selected = typeof only === 'string' ? only.split(',') : only;
    if (!Array.isArray(selected) || !selected.length || selected.some((id) => !id || !specs.charts.some((chart) => chart.id === id))) throw new Error('--only 必须是已计划图 id 的逗号列表');
    specs.charts = specs.charts.filter((chart) => selected.includes(chart.id));
  }
  const output = join(runDir, 'charts');
  let previous = null;
  if (only !== undefined) {
    try {
      previous = await readJson(join(output, 'index.json'));
      if (previous.version !== 1 || !Array.isArray(previous.charts) || previous.label !== specs.label || previous.release_id !== specs.release_id || new Set(previous.charts.map((chart) => chart.id)).size !== previous.charts.length) throw new Error('index.json 格式或报告绑定不符');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(output, { recursive: true });
    // Single-chart rework invalidates only the selected images. All remaining
    // images, rejected previews and index entries retain their exact contents.
    for (const chart of specs.charts) {
      await rm(join(output, chart.file), { force: true });
      await rm(join(output, 'rejected', chart.file), { force: true });
    }
  } else {
    await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  }
  await atomicJson(join(output, 'specs.json'), fullSpecs);
  const renderSpecs = only === undefined ? join(output, 'specs.json') : join(output, `.selected-specs-${process.pid}.json`);
  if (only !== undefined) await atomicJson(renderSpecs, specs);
  const environment = await prepareChartEnvironment({ runDir, envDir, python });
  let renderResults = [], renderReason = null;
  if (environment.ok && specs.charts.some((chart) => chart.status === 'ready')) {
    const result = await runChartProcess(environment.python, ['-B', join(chartDir, 'render.py'), '--specs', renderSpecs, '--out-dir', output], { cwd: runDir, env: { ...process.env, MPLCONFIGDIR: environment.mplconfig }, timeout: 540000, stderr: true });
    if (result.code === 0) {
      try { const audit = await readJson(join(output, 'audit.json')); if (audit.version !== 1 || !Array.isArray(audit.charts)) throw new Error('audit.json 格式不符'); renderResults = audit.charts; }
      catch (error) { renderReason = `绘图器未返回有效结果：${error.message}`; }
    } else renderReason = result.code === 2 ? '缺少可用的中文字体' : result.timedOut ? '绘图超时' : `绘图器失败：${result.error ?? result.stderr.trim().split('\n').at(-1) ?? `退出码 ${result.code}`}`;
    if (result.code === 2) environment.fontMissing = true;
  }
  if (only !== undefined) await rm(renderSpecs, { force: true });
  const index = { version: 1, label: specs.label, release_id: specs.release_id, charts: [] };
  for (const chart of specs.charts) {
    const base = { id: chart.id, kind: chart.kind, title: chart.title, caption: chart.caption, before_table: chart.before_table, evidence: chart.evidence, file: chart.file };
    const rendered = renderResults.find((item) => item.id === chart.id);
    if (chart.status === 'skipped' || !environment.ok || renderReason) index.charts.push({ ...base, status: chart.status === 'skipped' || !environment.ok || environment.fontMissing ? 'skipped' : 'failed', reason: chart.reason ?? environment.reason ?? renderReason, audit: { issues: [], layout: 'none', attempts: 0 } });
    else if (!rendered || !['ok', 'rejected', 'skipped', 'failed'].includes(rendered.status) || !rendered.audit) index.charts.push({ ...base, status: 'failed', reason: '绘图器缺少该图的有效审计结果', audit: { issues: [], layout: 'none', attempts: 0 } });
    else {
      let exists = true;
      if (rendered.status === 'ok') try { await access(join(output, chart.file), constants.R_OK); } catch { exists = false; }
      index.charts.push({ ...base, status: exists ? rendered.status : 'failed', ...(exists && rendered.reason ? { reason: rendered.reason } : !exists ? { reason: '绘图器声明成功但图片文件缺失' } : {}), audit: rendered.audit });
    }
  }
  const replacements = new Map(index.charts.map((chart) => [chart.id, chart]));
  const merged = previous ? { ...index, charts: [...previous.charts.map((chart) => replacements.get(chart.id) ?? chart), ...index.charts.filter((chart) => !previous.charts.some((old) => old.id === chart.id))] } : index;
  // audit.json and index.json describe the same retained set, even when the
  // renderer/environment cannot run on this invocation.
  await atomicJson(join(output, 'audit.json'), { version: 1, charts: merged.charts.map(({ id, kind, file, status, reason, audit }) => ({ id, kind, file, status, ...(reason ? { reason } : {}), audit })) });
  await atomicJson(join(output, 'index.json'), merged);
  const count = (status) => index.charts.filter((chart) => chart.status === status).length;
  const reason = environment.reason ?? renderReason ?? (index.charts.every((chart) => chart.status === 'skipped') ? unique(index.charts.map((chart) => chart.reason)).join('；') : null);
  return redact({ ok: true, total: index.charts.length, passed: count('ok'), rejected: count('rejected'), skipped: count('skipped'), failed: count('failed'), env: { source: environment.source, python: environment.python, matplotlib: environment.matplotlib }, ...(reason ? { reason } : {}) });
}
