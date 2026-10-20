export const meta = {
  name: 'quarterly-report',
  description: '生成战略季报（CMI 全球市场洞察）：取数与出图 → 分章写洞察 → 执行摘要 → 机械校验与对抗核查 → 修订 → 飞书同步 → 本地收录',
  whenToUse: '用户要求生成季报或季度市场洞察报告时。参数：current_start、current_end、label（必填），config、out、release_id、sections（可选）',
  phases: [
    { title: '取数', detail: '脚本按骨架调用 受治理工具，落证据账本、表格与写手摘要' },
    { title: '出图', detail: '从证据生成图表并检测版面，与分章写作并行；图表失败不阻断报告' },
    { title: '分章写作', detail: '每个叙述位组一个写手，写完即核查，有问题重写一次' },
    { title: '执行摘要', detail: '各章完成后写全球趋势与重点类目要点' },
    { title: '校验', detail: '组装报告，机械校验骨架、数字溯源与禁用词' },
    { title: '修订', detail: '机械校验不过的叙述位重写一次，再校验' },
    { title: '发布', detail: '校验通过且开启同步后生成个人空间飞书文档与附表；失败保留 Markdown' },
    { title: '收录', detail: '把报告与图表收录到本地报告目录，更新索引' },
  ],
}

// ── 参数：斜杠命令传来的是字符串（key=value），也接受对象 ─────────────────────
const BOUND_KEYS = ['portable_binding', 'output_env', 'runs_dir', 'chart_env']
const KEYS = ['current_start', 'current_end', 'label', 'config', 'out', 'release_id', 'sections', ...BOUND_KEYS]
function parseArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  const text = Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')
  const out = {}
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const at = token.indexOf('=')
    if (at > 0) out[token.slice(0, at).replace(/^--/, '').replace(/-/g, '_')] = token.slice(at + 1)
  }
  return out
}
const input = parseArgs(args)
for (const key of Object.keys(input)) if (!KEYS.includes(key)) throw new Error(`未知参数 ${key}；可用：${KEYS.join(', ')}`)
for (const key of ['current_start', 'current_end', 'label']) if (!input[key]) throw new Error(`缺少参数 ${key}，例如 current_start=2026-01 current_end=2026-04 label=26Q1`)
for (const key of ['current_start', 'current_end']) if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input[key])) throw new Error(`${key} 必须是 YYYY-MM`)
for (const [key, value] of Object.entries(input).filter(([key]) => !BOUND_KEYS.includes(key))) if (!/^[A-Za-z0-9_.,:\/\-]+$/.test(String(value))) throw new Error(`参数 ${key} 含不允许的字符`)

const bound = BOUND_KEYS.some((key) => input[key] !== undefined)
if (bound && BOUND_KEYS.some((key) => typeof input[key] !== 'string' || !input[key].startsWith('/') || /[\x00-\x1f\x7f]/u.test(input[key]))) throw new Error('绑定 Workflow 须提供 portable_binding/output_env/runs_dir/chart_env 四个安全绝对路径；含空格路径请用结构化参数')
const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'"
const bindingCli = bound ? `--portable-binding ${shellQuote(input.portable_binding)} --runs-dir ${shellQuote(input.runs_dir)}` : '--connection "<你的说明里给出的连接文件路径>" --runs-dir "<你的说明里给出的运行目录上级路径>"'
const outputArg = bound ? shellQuote(input.output_env) : '"<你的说明里给出的输出配置路径>"'
const chartArg = bound ? shellQuote(input.chart_env) : '"<你的说明里给出的图表环境目录>"'

const cli = [
  `--current-start ${input.current_start}`, `--current-end ${input.current_end}`, `--label ${input.label}`,
  ...(input.config ? [`--config ${input.config}`] : []), ...(input.out ? [`--out ${input.out}`] : []),
  ...(input.release_id ? [`--release-id ${input.release_id}`] : []), ...(input.sections ? [`--sections ${input.sections}`] : []),
].join(' ')

const RUNNER = 'strategic-analytics:report-runner'
const WRITER = 'strategic-analytics:report-section-writer'
const SUMMARY = 'strategic-analytics:report-summary-writer'
const VERIFIER = 'strategic-analytics:report-verifier'

const PREP_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    run_dir: { type: 'string' },
    output_env: { type: 'string' },
    release_id: { type: 'string' },
    groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, slots: { type: 'array', items: { type: 'string' } } }, required: ['id', 'slots'] } },
    calls: { type: 'number' },
    errors: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'run_dir', 'groups', 'errors'],
}
const WRITE_SCHEMA = {
  type: 'object',
  properties: { written: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
  required: ['written'],
}
const ISSUES_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { slot: { type: 'string' }, excerpt: { type: 'string' }, type: { type: 'string' }, reason: { type: 'string' }, direction: { type: 'string' } },
        required: ['slot', 'excerpt', 'type', 'reason'],
      },
    },
  },
  required: ['issues'],
}
const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    report: { type: 'string' },
    blocking: { type: 'array', items: { type: 'object', properties: { slot: { type: 'string' }, type: { type: 'string' }, detail: { type: 'string' }, excerpt: { type: 'string' } }, required: ['type', 'detail'] } },
    warnings: { type: 'number' },
    exit_code: { type: 'number' }, review_saved: { type: 'boolean' },
  },
  required: ['ok', 'blocking'],
}
const CHART_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' }, total: { type: 'number' }, passed: { type: 'number' },
    rejected: { type: 'number' }, skipped: { type: 'number' }, failed: { type: 'number' }, reason: { type: 'string' },
  },
  required: ['ok', 'total', 'passed', 'rejected', 'skipped', 'failed'],
}
const PUBLISH_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' }, target: { type: 'string' }, feishu: { type: 'string' },
    doc_url: { type: 'string' }, workbook_url: { type: 'string' }, error: { type: 'string' },
    failed_step: { type: 'string' }, resume: { type: 'string' },
    incomplete: { type: 'boolean' }, completed: { type: 'number' }, total: { type: 'number' },
    json_received: { type: 'boolean' }, timed_out: { type: 'boolean' }, cancelled: { type: 'boolean' },
  },
  required: ['ok', 'json_received', 'timed_out'],
}
const COLLECT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' }, dir: { type: ['string', 'null'] }, report: { type: ['string', 'null'] },
    index: { type: ['string', 'null'] }, error: { type: 'string' },
  },
  required: ['ok', 'dir', 'report', 'index'],
}

// 写手只拿运行目录与叙述位编号，路径按固定规则拼：避免模型转抄长路径出错。
const paths = (runDir, slots) => slots.map((slot) => `- ${slot}：摘要 ${runDir}/digests/${slot}.json → 输出 ${runDir}/drafts/${slot}.md`).join('\n')
const issueText = (issues) => issues.map((issue, index) => `${index + 1}. [${issue.slot ?? '?'}] ${issue.type}：${issue.reason ?? issue.detail ?? ''}${issue.excerpt ? `（原文：「${issue.excerpt}」）` : ''}${issue.direction ? ` → ${issue.direction}` : ''}`).join('\n')

function writePrompt(runDir, slots, issues) {
  return [
    `报告运行目录：${runDir}`,
    '为下列叙述位写作（按你的工作方法：先读摘要，再写叙述；只写叙述，不写表格和标题）：',
    paths(runDir, slots),
    '新摘要按 columns_ref/column_sets 解析；需要未投影明细时只读摘要指向的 canonical 表，结论只限已读证据。',
    ...(issues && issues.length ? ['', '这是修订：上一版有以下问题，逐条修正；没有问题的句子保持不动，不要新增摘要里没有的数字。', issueText(issues)] : []),
    '',
    '完成后返回你写入的叙述位编号。',
  ].join('\n')
}
function verifyPrompt(runDir, slots) {
  return [
    `报告运行目录：${runDir}`,
    '核查下列叙述位（草稿与其摘要）：',
    paths(runDir, slots),
    '新摘要的省略行与标题预览不能支撑未读明细的主张；必要时读取对应 canonical 表核对，缺证据如实报告。',
    '',
    '只报告确有其事的问题；没有问题返回空列表。',
  ].join('\n')
}

// ── 1. 取数 ───────────────────────────────────────────────────────────────
phase('取数')
const prep = await agent([
  '运行季报取数。在 Bash 中执行（参数逐字使用，不要增删或改写）：',
  '',
  `node "<你的说明里给出的 report.mjs 路径>" prepare ${cli} ${bindingCli}`,
  '',
  '命令可能较慢：Bash 超时设为最大值；若因超时或中断结束而没有最后一行 JSON，按你的说明用相同参数加 --resume 与 stderr 中 RUN_DIR 的目录续跑。',
  '命令结束后读取标准输出最后一行的 JSON，按结构化输出返回：ok、run_dir、output_env（若有）、release_id、calls、errors，',
  '以及 groups（取 JSON 里 writer_groups 的每一项的 id 与 slots 里的 slot 编号，保持顺序）。',
  '命令失败（非零退出或没有 JSON）时 ok=false，errors 放退出码与最后 20 行输出。',
].join('\n'), { label: 'prepare', phase: '取数', agentType: RUNNER, schema: PREP_SCHEMA })
if (!prep || !prep.ok) {
  return { ok: false, stage: 'prepare', errors: prep ? prep.errors : ['取数 Agent 未返回'] }
}
if (bound && prep.output_env !== input.output_env) return { ok: false, stage: 'prepare', errors: ['prepare 返回的冻结 output_env 与调用方不一致，停止流程'] }
const runDir = prep.run_dir
const runArg = bound ? shellQuote(runDir) : runDir
// 出图立即启动，持有 promise 与分章写作并行；立即 catch，避免后台失败成为未处理拒绝。
phase('出图')
const chartTask = (async () => {
  try {
    const result = await agent([
      '从本次证据生成图表。在 Bash 中执行（逐字使用路径，timeout=600000 ms）：',
      '',
      `node "<你的说明里给出的 report.mjs 路径>" charts --run-dir ${runArg} --env-dir ${chartArg}`,
      '',
      '读取标准输出最后一行 JSON，原样返回 ok、total、passed、rejected、skipped、failed、reason。',
      '图表是可选产物：失败、超时或没有最后一行 JSON 时返回 ok=false、各计数为 0，reason 放退出码与最后 20 行输出；不要重试或修改证据。',
    ].join('\n'), { label: 'charts', phase: '出图', agentType: RUNNER, schema: CHART_SCHEMA })
    if (!result || typeof result.passed !== 'number') return { passed: 0, rejected: 0, skipped: 0, reason: '出图 Agent 未返回有效结果' }
    if (!result.ok || result.failed || result.rejected || result.skipped) log(`图表结果：通过 ${result.passed}，拒绝 ${result.rejected}，跳过 ${result.skipped}，失败 ${result.failed}${result.reason ? `；${result.reason}` : ''}`)
    return { passed: result.passed, rejected: result.rejected, skipped: result.skipped, ...(result.reason ? { reason: result.reason } : {}), ...(!result.ok && !result.reason ? { reason: '出图命令失败' } : {}) }
  } catch (error) {
    const reason = `出图失败：${error && error.message ? error.message : String(error)}`
    log(reason)
    return { passed: 0, rejected: 0, skipped: 0, reason }
  }
})()
const sectionGroups = prep.groups.filter((group) => group.id !== 'summary' && group.slots.length)
const summaryGroup = prep.groups.find((group) => group.id === 'summary')
log(`release ${prep.release_id}：${prep.calls ?? '?'} 次调用，${prep.errors.length} 个取数错误；${sectionGroups.length} 个章节写作组`)
if (prep.errors.length) log(`取数错误（相关表位已标记，写作照常）：${prep.errors.slice(0, 5).join('；')}${prep.errors.length > 5 ? ' …' : ''}`)

// 每位合计只重写一次；任何写入先撤销上一稿的核查归属。
const rewritten = new Set()
const reviews = new Map(prep.groups.map((group) => [group.id, { group, issues: [], unverified: true }]))
const reviewGroup = async (group, final = false) => {
  const state = reviews.get(group.id)
  state.unverified = true
  const review = await agent(verifyPrompt(runDir, group.slots), { label: `核:${group.id}${final ? ':final' : ''}`, phase: group.id === 'summary' ? '执行摘要' : '分章写作', agentType: VERIFIER, schema: ISSUES_SCHEMA })
  state.issues = review && Array.isArray(review.issues) ? review.issues : []
  state.unverified = !review || !Array.isArray(review.issues)
  if (state.unverified) log(`${group.id === 'summary' ? '执行摘要的' : `以下写作组 ${group.id} 的`}语义核查未返回，未经对抗核查：${group.id}`)
}
const rewrite = async (group, slots, issues, label) => {
  const eligible = slots.filter((slot) => !rewritten.has(slot))
  if (!eligible.length) return false
  reviews.get(group.id).unverified = true
  eligible.forEach((slot) => rewritten.add(slot))
  await agent(writePrompt(runDir, eligible, issues.filter((issue) => eligible.includes(issue.slot))), { label, phase: '修订', agentType: group.id === 'summary' ? SUMMARY : WRITER, schema: WRITE_SCHEMA })
  await reviewGroup(group, true)
  return true
}
const semanticRevision = async (group) => {
  const issues = reviews.get(group.id).issues
  if (issues.length) await rewrite(group, [...new Set(issues.map((issue) => issue.slot))].filter((slot) => group.slots.includes(slot)), issues, `改:${group.id}`)
}
// 不同章节各写独立文件，保留原有并行推进；组内核查与修订按顺序执行。
await pipeline(sectionGroups,
  (group) => agent(writePrompt(runDir, group.slots), { label: `写:${group.id}`, phase: '分章写作', agentType: WRITER, schema: WRITE_SCHEMA }),
  async (_written, group) => {
    await reviewGroup(group)
    await semanticRevision(group)
    return reviews.get(group.id)
  },
)

// 复用 runner 的核查/收录步骤保存最终问题与草稿、摘要哈希，不新增脚本子命令。
const reviewCommand = () => `node -e ${shellQuote(`
const fs = require('node:fs'), crypto = require('node:crypto');
const path = require('node:path'), dir = ${JSON.stringify(runDir)};
const record = ${JSON.stringify({ groups: [...reviews.values()].map(({ group, issues, unverified }) => ({ id: group.id, slots: group.slots, issues, unverified, rewritten: group.slots.filter((slot) => rewritten.has(slot)) })) })};
for (const group of record.groups) group.inputs = group.unverified ? [] : group.slots.map(slot => {
  const hash = kind => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, kind, slot + (kind === 'drafts' ? '.md' : '.json')))).digest('hex');
  return { slot, draft_sha256: hash('drafts'), digest_sha256: hash('digests') };
});
const temporary = path.join(dir, '.' + crypto.randomUUID() + '.review.tmp');
try { fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\\n', {flag:'wx', mode:0o600}); fs.renameSync(temporary, path.join(dir, 'review.json')); }
finally { fs.rmSync(temporary, {force:true}); }
console.log(JSON.stringify({review_saved:true}));
`)}`
// ── 4. 组装与机械校验 ────────────────────────────────────────────────────────
const runCheck = async (label, phaseName) => {
  const result = await agent([
  '在 Bash 中依次执行（逐字使用路径）：',
  '',
  `node "<你的说明里给出的 report.mjs 路径>" assemble --run-dir ${runArg}`,
  `node "<你的说明里给出的 report.mjs 路径>" check --run-dir ${runArg}`,
  '',
  '按 check 命令标准输出最后一行的 JSON 返回：ok、blocking（每项的 slot/table、type、detail、excerpt）、warnings（数量）、',
  'exit_code，report 取 assemble 最后一行 JSON 的 report 字段。再执行以下单条 node 命令保存本轮语义核查记录（仅写 review.json），成功时 review_saved=true；失败如实返回 false，不改其他材料。',
  reviewCommand(),
  ].join('\n'), { label, phase: phaseName, agentType: RUNNER, schema: CHECK_SCHEMA })
  if (!result || !Array.isArray(result.blocking)) throw new TypeError('校验 Agent 未返回有效阻断列表')
  return result
}

// 图表索引必须写完才能组装；其失败只记录结果，不阻断文字报告。
const charts = await chartTask
if (charts.reason) log(`图表：${charts.reason}`)
let check = null
let stage = 'assemble+check'
let workflowError = null
let published = null
let feishu = { status: 'skipped', error: '机械校验未通过，不发布到飞书' }
let library = { ok: false, dir: null, report: null, index: null, error: '收录 Agent 未返回有效结果' }
const errorDetails = (error, failedStage) => ({
  stage: failedStage,
  name: error && error.name ? String(error.name) : 'Error',
  message: error && error.message ? String(error.message) : String(error),
  ...(error && ['string', 'number'].includes(typeof error.code) ? { code: error.code } : {}),
})
const cancelled = (error) => Boolean(error && (
  /^(AbortError|Cancel(?:led|ed)Error)$/u.test(error.name ?? '') ||
  /^(ABORT_ERR|ERR_CANCELED|USER_CANCEL(?:LED|ED))$/u.test(String(error.code ?? ''))
))

// 从第一次 assemble 可能写出 report.md 起保护收尾。Agent 没有返回，并不能证明文件没有生成。
try {
  phase('校验')
  check = await runCheck('assemble+check', '校验')

  // 章节先结束机械修订，再生成执行摘要。缺少摘要的阻断在此阶段保留。
  const mechanicalRevision = async (groups) => {
    let changed = false
    for (const group of groups) {
      const issues = (check?.blocking ?? []).filter((item) => group.slots.includes(item.slot))
        .map((item) => ({ slot: item.slot, type: item.type, reason: item.detail, excerpt: item.excerpt }))
      const slots = [...new Set(issues.map((item) => item.slot))]
      if (slots.some((slot) => !rewritten.has(slot))) {
        stage = 'rewrite'
        phase('修订')
        changed = await rewrite(group, slots, issues, group.id === 'summary' ? '修:summary' : `修:${slots[0]}`) || changed
      }
    }
    return changed
  }
  if (await mechanicalRevision(sectionGroups)) {
    stage = 're-check'
    check = await runCheck('re-check', '修订')
  }
  if (summaryGroup && summaryGroup.slots.length) {
    stage = 'summary'
    phase('执行摘要')
    const chapterDrafts = sectionGroups.flatMap((group) => group.slots).map((slot) => `- ${runDir}/drafts/${slot}.md`)
    await agent([
      writePrompt(runDir, summaryGroup.slots), '',
      '各章成稿如下，动笔前逐个用 Read 读取（不存在的跳过），只用来把握各章重点与结论方向；数字只取执行摘要自己的摘要文件，不从成稿里抄：',
      ...chapterDrafts,
    ].join('\n'), { label: '写:summary', phase: '执行摘要', agentType: SUMMARY, schema: WRITE_SCHEMA })
    await reviewGroup(summaryGroup)
    await semanticRevision(summaryGroup)
    stage = 'final-check'
    check = await runCheck('final-check', '校验')
    if (await mechanicalRevision([summaryGroup])) {
      stage = 're-check'
      check = await runCheck('re-check', '修订')
    }
  }
  const finalStates = [...reviews.values()]
  const unverifiedGroups = finalStates.filter((state) => state.unverified || state.issues.length || check?.review_saved !== true).map((state) => state.group.id)
  if (check?.review_saved !== true) log('最终核查记录未保存，核查归属未验证')
  for (const state of finalStates.filter((item) => item.issues.length)) log(`最终语义问题 ${state.group.id}：${issueText(state.issues)}`)

  const remaining = check ? check.blocking : [{ type: 'check_failed', detail: '校验 Agent 未返回' }]
  if (remaining.length) log(`仍有 ${remaining.length} 个阻断问题，报告里保留标记，需人工处理`)

  // 正常返回的发布失败不改变报告的校验 ok；Agent 异常单独标记整个 Workflow 未完成。
  if (check && check.ok) {
    stage = 'publish'
    phase('发布')
    const publishCommand = `node "<你的说明里给出的 report.mjs 路径>" publish --run-dir ${runArg} --output-env ${outputArg}${unverifiedGroups.length ? ` --unverified ${unverifiedGroups.join(',')}` : ''}`
    // 脚本明确返回 incomplete，或明确的命令超时无 JSON，合计最多续跑 7 次；用户取消和 Agent 抛错不续跑。
    const MAX_RESUMES = 7
    let previous = null
    for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
      const resumeNote = !attempt ? [] : previous && previous.incomplete === true
        ? ['这是分段发布的续跑：上一段已在两步之间正常停下，从下一步接着执行。']
        : ['这是因超时中断且未收到最后一行 JSON 的续跑。若日志有待确认写入，脚本会拒绝重放并返回链接，请人工核对。']
      published = await agent([
        '按同步开关发布已通过机械校验的报告。在 Bash 中执行（逐字使用路径，timeout=600000 ms）：',
        '',
        publishCommand + (attempt ? ' --resume' : ''),
        '',
        ...resumeNote,
        '不要直接运行 lark-cli。读取最后一行 JSON，原样返回 ok、target、feishu、doc_url、workbook_url、error、failed_step、resume、incomplete、completed、total；有 JSON 时 json_received=true、timed_out=false。',
        '只有命令因超时中断且没有最后一行 JSON 时，返回 ok=false、json_received=false、timed_out=true，error 放退出码与最后 20 行输出。用户取消时 cancelled=true、timed_out=false；其他失败 timed_out=false。不要自行续跑。',
      ].join('\n'), { label: attempt ? `publish:resume:${attempt}` : 'publish', phase: '发布', agentType: RUNNER, schema: PUBLISH_SCHEMA })
      if (published && published.cancelled === true) throw Object.assign(new Error(published.error || '用户取消了飞书发布'), { name: 'AbortError', code: 'USER_CANCELLED' })
      previous = published
      const interrupted = published && published.json_received === false && published.timed_out === true
      const unfinished = published && published.incomplete === true
      if (!interrupted && !unfinished) break
      if (attempt < MAX_RESUMES) log(unfinished
        ? `飞书发布分段进行：已完成 ${published.completed ?? '?'}/${published.total ?? '?'} 步，使用 --resume 续跑（${attempt + 1}/${MAX_RESUMES}）`
        : `飞书发布命令超时且未返回 JSON，使用 --resume 续跑（${attempt + 1}/${MAX_RESUMES}）`)
    }
    if (published && published.ok && published.target === 'feishu') {
      feishu = { status: 'published', doc_url: published.doc_url, workbook_url: published.workbook_url }
    } else if (published && published.ok && published.feishu === 'disabled') {
      feishu = { status: 'disabled' }
    } else {
      feishu = { status: 'failed', ...(published && published.doc_url ? { doc_url: published.doc_url } : {}), ...(published && published.workbook_url ? { workbook_url: published.workbook_url } : {}), error: published && published.error ? published.error : '发布 Agent 未返回有效结果' }
      log(`飞书发布失败，保留 Markdown：${feishu.error}`)
    }
  } else log(feishu.error)
} catch (error) {
  workflowError = errorDetails(error, stage)
  feishu = {
    status: cancelled(error) ? 'cancelled' : stage === 'publish' ? 'failed' : 'skipped',
    ...(published && published.doc_url ? { doc_url: published.doc_url } : {}),
    ...(published && published.workbook_url ? { workbook_url: published.workbook_url } : {}),
    error: workflowError.message,
  }
  log(`Workflow 在 ${stage} 阶段失败：${workflowError.message}`)
} finally {
  // collect 自己严格检查 report.md。组装写完但响应丢失时仍能收录，未生成时返回失败且不造稿。
  let collectionPhaseError = null
  try { phase('收录') }
  catch (error) { collectionPhaseError = errorDetails(error, 'collect-phase') }
  try {
    const collected = await agent([
      '把本次报告草稿与引用的图表收录到本地报告目录。在 Bash 中执行（逐字使用路径）：',
      '',
      `node "<你的说明里给出的 report.mjs 路径>" collect --run-dir ${runArg} --output-env ${outputArg}`,
      '',
      '收录后保存当前核查归属（含异常后失效的核查）：',
      reviewCommand(),
      '机械校验未通过、Agent 异常、用户取消、飞书未开启或同步失败时也执行本地收录，不再发布。以 collect 命令的最后一行 JSON 为准，原样返回 ok、dir、report、index、error；保存核查记录的 JSON 不替代 collect 的结果，保存失败也如实回报。',
      '命令失败或没有 JSON 时返回 ok=false，error 放退出码与最后 20 行输出。report.md 尚未生成时如实返回失败；不得生成报告或宣称已收录。',
    ].join('\n'), { label: 'collect', phase: '收录', agentType: RUNNER, schema: COLLECT_SCHEMA })
    if (collected && typeof collected.ok === 'boolean' && (!collected.ok || ['dir', 'report', 'index'].every((key) => typeof collected[key] === 'string' && collected[key]))) library = {
      ok: collected.ok, dir: collected.dir ?? null, report: collected.report ?? null, index: collected.index ?? null,
      ...(!collected.ok ? { error: collected.error ?? '收录失败，请检查运行目录中的 report.md' } : {}),
    }
  } catch (error) {
    library.exception = errorDetails(error, 'collect')
    library.error = library.exception.message
  }
  if (collectionPhaseError) library.phase_exception = collectionPhaseError
  if (!library.ok) log(`收录失败，请检查运行目录 ${runDir} 中的 report.md：${library.error}`)
}
const remaining = check && Array.isArray(check.blocking) ? check.blocking : [{ type: 'check_failed', detail: workflowError ? workflowError.message : '校验 Agent 未返回有效阻断列表' }]
const collectionFailure = check && check.report
  ? `本地收录失败，报告草稿仍在运行目录 ${runDir}：${library.error}`
  : `本地收录失败，尚未确认运行目录 ${runDir} 中的 report.md 已生成：${library.error}`
return {
  ok: Boolean(check && check.ok && !workflowError),
  report: check && check.report ? check.report : null,
  ...(workflowError ? { workflow_error: workflowError } : {}),
  run_dir: runDir,
  release_id: prep.release_id,
  calls: prep.calls,
  fetch_errors: prep.errors,
  groups: sectionGroups.length + (summaryGroup ? 1 : 0),
  revised_groups: [...reviews.values()].filter((state) => state.group.slots.some((slot) => rewritten.has(slot))).map((state) => state.group.id),
  verifier_issues: [...reviews.values()].reduce((total, state) => total + state.issues.length, 0),
  review_saved: check?.review_saved === true && !workflowError,
  semantic_issues: [...reviews.values()].flatMap((state) => state.issues.map((issue) => ({ group: state.group.id, ...issue }))),
  unverified_groups: [...reviews.values()].filter((state) => state.unverified || state.issues.length || check?.review_saved !== true).map((state) => state.group.id),
  blocking: remaining,
  warnings: check ? check.warnings : null,
  charts,
  feishu,
  library,
  note: library.ok
    ? '报告草稿已收录到本地报告目录，待人工审阅；飞书文档只建在运行者个人空间、未共享，分享前请人工审阅。'
    : `${collectionFailure}，待人工审阅；飞书文档只建在运行者个人空间、未共享，分享前请人工审阅。`,
}
