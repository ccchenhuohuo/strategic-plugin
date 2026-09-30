export const meta = {
  name: 'quarterly-report',
  description: '生成战略季报（CMI 全球市场洞察）：取数与出图 → 分章写洞察 → 执行摘要 → 机械校验与对抗核查 → 修订 → 飞书输出',
  whenToUse: '用户要求生成季报或季度市场洞察报告时。参数：current_start、current_end、label（必填），config、out、release_id、sections（可选）',
  phases: [
    { title: '取数', detail: '脚本按骨架调用 受治理工具，落证据账本、表格与写手摘要' },
    { title: '出图', detail: '从证据生成图表并检测版面，与分章写作并行；图表失败不阻断报告' },
    { title: '分章写作', detail: '每个叙述位组一个写手，写完即核查，有问题重写一次' },
    { title: '执行摘要', detail: '各章完成后写全球趋势与重点类目要点' },
    { title: '校验', detail: '组装报告，机械校验骨架、数字溯源与禁用词' },
    { title: '修订', detail: '机械校验不过的叙述位重写一次，再校验' },
    { title: '发布', detail: '校验通过后按开关生成个人空间飞书文档与附表；失败保留 Markdown' },
  ],
}

// ── 参数：斜杠命令传来的是字符串（key=value），也接受对象 ─────────────────────
const KEYS = ['current_start', 'current_end', 'label', 'config', 'out', 'release_id', 'sections']
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
for (const [key, value] of Object.entries(input)) if (!/^[A-Za-z0-9_.,:\/\-]+$/.test(String(value))) throw new Error(`参数 ${key} 含不允许的字符`)

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
    exit_code: { type: 'number' },
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
    json_received: { type: 'boolean' }, timed_out: { type: 'boolean' },
  },
  required: ['ok', 'json_received', 'timed_out'],
}

// 写手只拿运行目录与叙述位编号，路径按固定规则拼：避免模型转抄长路径出错。
const paths = (runDir, slots) => slots.map((slot) => `- ${slot}：摘要 ${runDir}/digests/${slot}.json → 输出 ${runDir}/drafts/${slot}.md`).join('\n')
const issueText = (issues) => issues.map((issue, index) => `${index + 1}. [${issue.slot ?? '?'}] ${issue.type}：${issue.reason ?? issue.detail ?? ''}${issue.excerpt ? `（原文：「${issue.excerpt}」）` : ''}${issue.direction ? ` → ${issue.direction}` : ''}`).join('\n')

function writePrompt(runDir, slots, issues) {
  return [
    `报告运行目录：${runDir}`,
    '为下列叙述位写作（按你的工作方法：先读摘要，再写叙述；只写叙述，不写表格和标题）：',
    paths(runDir, slots),
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
    '',
    '只报告确有其事的问题；没有问题返回空列表。',
  ].join('\n')
}

// ── 1. 取数 ───────────────────────────────────────────────────────────────
phase('取数')
const prep = await agent([
  '运行季报取数。在 Bash 中执行（参数逐字使用，不要增删或改写）：',
  '',
  `node "<你的说明里给出的 report.mjs 路径>" prepare ${cli} --connection "<你的说明里给出的连接文件路径>"`,
  '',
  '命令可能较慢：Bash 超时设为最大值；若因超时或中断结束而没有最后一行 JSON，按你的说明用相同参数加 --resume 与 stderr 中 RUN_DIR 的目录续跑。',
  '命令结束后读取标准输出最后一行的 JSON，按结构化输出返回：ok、run_dir、release_id、calls、errors，',
  '以及 groups（取 JSON 里 writer_groups 的每一项的 id 与 slots 里的 slot 编号，保持顺序）。',
  '命令失败（非零退出或没有 JSON）时 ok=false，errors 放退出码与最后 20 行输出。',
].join('\n'), { label: 'prepare', phase: '取数', agentType: RUNNER, schema: PREP_SCHEMA })
if (!prep || !prep.ok) {
  return { ok: false, stage: 'prepare', errors: prep ? prep.errors : ['取数 Agent 未返回'] }
}
const runDir = prep.run_dir
// 出图立即启动，持有 promise 与分章写作并行；立即 catch，避免后台失败成为未处理拒绝。
phase('出图')
const chartTask = (async () => {
  try {
    const result = await agent([
      '从本次证据生成图表。在 Bash 中执行（逐字使用路径，timeout=600000 ms）：',
      '',
      `node "<你的说明里给出的 report.mjs 路径>" charts --run-dir ${runDir} --env-dir "<你的说明里给出的图表环境目录>"`,
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

// ── 2. 分章写作：写 → 核查 → 有问题重写一次（各组独立推进，不等其他组）───────
const sectionResults = await pipeline(
  sectionGroups,
  (group) => agent(writePrompt(runDir, group.slots), { label: `写:${group.id}`, phase: '分章写作', agentType: WRITER, schema: WRITE_SCHEMA }),
  (written, group) => agent(verifyPrompt(runDir, group.slots), { label: `核:${group.id}`, phase: '分章写作', agentType: VERIFIER, schema: ISSUES_SCHEMA })
    .then((review) => ({ group, written, issues: review ? review.issues : [], unverified: !review })),
  (state) => state.issues.length
    ? agent(writePrompt(runDir, state.group.slots, state.issues), { label: `改:${state.group.id}`, phase: '分章写作', agentType: WRITER, schema: WRITE_SCHEMA })
      .then(() => ({ ...state, revised: true }))
    : { ...state, revised: false },
)
const reviewed = sectionResults.filter(Boolean)
const missingGroups = sectionGroups.filter((group) => !reviewed.some((state) => state.group.id === group.id)).map((group) => group.id)
if (missingGroups.length) log(`以下写作组未完成（将在校验中显示为待补写）：${missingGroups.join('、')}`)
// 核查员未返回（中断或达到轮数上限）不等于没有问题：记下来随结果交人工，不当作核查通过。
const unverifiedGroups = reviewed.filter((state) => state.unverified).map((state) => state.group.id)
if (unverifiedGroups.length) log(`以下写作组的语义核查未返回，未经对抗核查：${unverifiedGroups.join('、')}`)

// ── 3. 执行摘要（依赖全部章节叙述）──────────────────────────────────────────
let summaryIssues = []
if (summaryGroup && summaryGroup.slots.length) {
  phase('执行摘要')
  // 写手只有 Read/Write、列不出目录，所以各章成稿逐个给出完整路径（2026-09-30 生产全量运行时只给目录，写手一篇没读）。
  const chapterDrafts = sectionGroups.flatMap((group) => group.slots).map((slot) => `- ${runDir}/drafts/${slot}.md`)
  await agent([
    writePrompt(runDir, summaryGroup.slots),
    '',
    '各章成稿如下，动笔前逐个用 Read 读取（不存在的跳过），只用来把握各章重点与结论方向；数字只取执行摘要自己的摘要文件，不从成稿里抄：',
    ...chapterDrafts,
  ].join('\n'), { label: '写:summary', phase: '执行摘要', agentType: SUMMARY, schema: WRITE_SCHEMA })
  const review = await agent(verifyPrompt(runDir, summaryGroup.slots), { label: '核:summary', phase: '执行摘要', agentType: VERIFIER, schema: ISSUES_SCHEMA })
  summaryIssues = review ? review.issues : []
  if (!review) {
    unverifiedGroups.push(summaryGroup.id)
    log('执行摘要的语义核查未返回，未经对抗核查')
  }
  if (summaryIssues.length) {
    await agent(writePrompt(runDir, summaryGroup.slots, summaryIssues), { label: '改:summary', phase: '执行摘要', agentType: SUMMARY, schema: WRITE_SCHEMA })
  }
}

// ── 4. 组装与机械校验 ────────────────────────────────────────────────────────
const runCheck = (label, phaseName) => agent([
  '在 Bash 中依次执行（逐字使用路径）：',
  '',
  `node "<你的说明里给出的 report.mjs 路径>" assemble --run-dir ${runDir}`,
  `node "<你的说明里给出的 report.mjs 路径>" check --run-dir ${runDir}`,
  '',
  '按 check 命令标准输出最后一行的 JSON 返回：ok、blocking（每项的 slot/table、type、detail、excerpt）、warnings（数量）、',
  'exit_code，report 取 assemble 最后一行 JSON 的 report 字段。不要修改任何文件。',
].join('\n'), { label, phase: phaseName, agentType: RUNNER, schema: CHECK_SCHEMA })

// 图表索引必须写完才能组装；其失败只记录结果，不阻断文字报告。
const charts = await chartTask
if (charts.reason) log(`图表：${charts.reason}`)
phase('校验')
let check = await runCheck('assemble+check', '校验')

// ── 5. 修订：机械校验阻断的叙述位重写一次，再校验 ───────────────────────────
const blockingSlots = (result) => [...new Set((result && result.blocking ? result.blocking : []).map((item) => item.slot).filter(Boolean))]
const toFix = blockingSlots(check).filter((slot) => !slot.startsWith('table'))
if (check && !check.ok && toFix.length) {
  phase('修订')
  const bySlot = (slot) => check.blocking.filter((item) => item.slot === slot).map((item) => ({ slot, type: item.type, reason: item.detail, excerpt: item.excerpt }))
  const isSummarySlot = (slot) => Boolean(summaryGroup && summaryGroup.slots.includes(slot))
  const summarySlots = toFix.filter(isSummarySlot)
  const sectionSlots = toFix.filter((slot) => !isSummarySlot(slot))
  await parallel([
    ...sectionSlots.map((slot) => () => agent(writePrompt(runDir, [slot], bySlot(slot)), { label: `修:${slot}`, phase: '修订', agentType: WRITER, schema: WRITE_SCHEMA })),
    ...(summarySlots.length ? [() => agent(writePrompt(runDir, summarySlots, summarySlots.flatMap(bySlot)), { label: '修:summary', phase: '修订', agentType: SUMMARY, schema: WRITE_SCHEMA })] : []),
  ])
  check = await runCheck('re-check', '修订')
}

const remaining = check ? check.blocking : [{ type: 'check_failed', detail: '校验 Agent 未返回' }]
if (remaining.length) log(`仍有 ${remaining.length} 个阻断问题，报告里保留标记，需人工处理`)

// 发布只在最终机械校验通过后进行；发布失败不改变报告本身的 ok。
let feishu = { status: 'skipped', error: '机械校验未通过，不发布到飞书' }
if (check && check.ok) {
  phase('发布')
  const publishCommand = `node "<你的说明里给出的 report.mjs 路径>" publish --run-dir ${runDir} --output-env "<你的说明里给出的输出配置路径>"${unverifiedGroups.length ? ` --unverified ${unverifiedGroups.join(',')}` : ''}`
  // 完整季报约 120 步、十几分钟：脚本每次运行约 8 分钟就在两步之间停下并返回 incomplete=true，这里按同一命令加 --resume 接着跑。
  // 命令被外层超时杀掉而没有 JSON 时同样续跑；两者合计最多续跑 7 次。
  const MAX_RESUMES = 7
  let published = null
  let previous = null
  for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
    // 分段续跑（上次在两步之间正常停下）与中断续跑（上次被外层超时杀掉）的提醒不同。
    const resumeNote = !attempt ? [] : previous && previous.incomplete === true
      ? ['这是分段发布的续跑：上一段已在两步之间正常停下，从下一步接着执行。']
      : ['这是因超时中断且未收到最后一行 JSON 的续跑。中断的那一步可能已部分写入，请核对文档末尾。']
    try {
      published = await agent([
        '按输出开关发布已通过机械校验的报告。在 Bash 中执行（逐字使用路径，timeout=600000 ms）：',
        '',
        publishCommand + (attempt ? ' --resume' : ''),
        '',
        ...resumeNote,
        '不要直接运行 lark-cli。读取最后一行 JSON，原样返回 ok、target、feishu、doc_url、workbook_url、error、failed_step、resume、incomplete、completed、total；有 JSON 时 json_received=true、timed_out=false。',
        '只有命令因超时中断且没有最后一行 JSON 时，返回 ok=false、json_received=false、timed_out=true，error 放退出码与最后 20 行输出。其他失败 timed_out=false。不要自行续跑。',
      ].join('\n'), { label: attempt ? `publish:resume:${attempt}` : 'publish', phase: '发布', agentType: RUNNER, schema: PUBLISH_SCHEMA })
    } catch (error) {
      published = { ok: false, error: error && error.message ? error.message : String(error), json_received: false, timed_out: false }
    }
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
return {
  ok: Boolean(check && check.ok),
  report: check ? check.report : null,
  run_dir: runDir,
  release_id: prep.release_id,
  calls: prep.calls,
  fetch_errors: prep.errors,
  groups: sectionGroups.length + (summaryGroup ? 1 : 0),
  revised_groups: reviewed.filter((state) => state.revised).map((state) => state.group.id),
  verifier_issues: reviewed.reduce((total, state) => total + state.issues.length, 0) + summaryIssues.length,
  unverified_groups: unverifiedGroups,
  blocking: remaining,
  warnings: check ? check.warnings : null,
  charts,
  feishu,
  note: '报告草稿待人工审阅；飞书文档只建在运行者个人空间、未共享，分享前请人工审阅。',
}
