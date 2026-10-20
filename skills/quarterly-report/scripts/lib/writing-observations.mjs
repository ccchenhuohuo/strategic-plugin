import { asArray, unique } from './common.mjs';
import { TABLE_READING_NOTES } from './tables.mjs';

export const OBSERVATION_RULE = 'observations按相同窗口事实分组；members为完整表ID→observation_context零起索引，保留成员身份与原说明；partial_window=true为不完整观察；0、null与越界不互换；商品状态单元格不变，逐商品结论先读对应完整表。';
const windows = { current: '当期', yoy: '同比期', prior_period: '环比期' };
const exceptional = (item) => item.partial_window === true || item.note || item.months_observed === 0 || ![null, 'ok', 'comparable', 'observed'].includes(item.status);

// 全篇级口径警示：REPORT.md「正文呈现」规定全篇共同的估算、固定汇率、缺失符号、数据陈旧/时效等
// 由开头阅读提示与附录集中说明一次，不逐摘要重复。它们没有被删除：prepare 仍把全部 caveats 原样写入
// data-note.md 的「响应级口径警示」，report.md 附录与开头阅读提示继续携带；摘要只保留随本节数字
// 逐条转述的操作性口径警示（份额口径、站点本币、HHI/OTHERS、榜单截断、身份数/新进等）。
export const GLOBAL_CAVEAT_PATTERNS = [
  /^服务商宽表已于/u, /^指标为市场估算数据/u, /^月度数据，次月 16 日/u,
  /^CNY 为本 release 冻结的单一汇率快照/u, /^缺失\/未观察不等于零/u,
  /^std_l3_empty_ratio@/u, /^跨自然年比较/u,
];
export const sectionCaveats = (caveats) => caveats.filter((note) => !GLOBAL_CAVEAT_PATTERNS.some((pattern) => pattern.test(note)));

// 与 tables.mjs 的 displayLike 同一口径（tables.mjs 未导出，勿改其一不改其二）。
const displayLike = (text) => typeof text === 'string' && /^[+\-−]?\d[\d,]*(?:\.\d+)?(?:亿件|万件|亿|万|件|pp|%)?$/u.test(text);
// 与 check.mjs 的 normalized 同口径：NFKC、−/，归一与空白去除。
const normalizeDisplay = (text) => String(text).normalize('NFKC').replaceAll('−', '-').replaceAll(',', '').replace(/[ \t]/gu, '');
/** 摘要表格自身可见的服务端展示数字（rows+footer）；check 侧用并集恢复完整白名单。 */
export function digestVisibleNumbers(tables) {
  const visible = new Set();
  for (const table of asArray(tables)) for (const cell of [...asArray(table.rows).flat(), ...asArray(table.footer)]) {
    if (displayLike(cell)) visible.add(normalizeDisplay(cell));
  }
  return visible;
}

function generatedNote(item) {
  if (item.partial_window !== true || typeof item.member !== 'string' || !Object.hasOwn(windows, item.window)) return false;
  return item.note === `${item.member} ${windows[item.window]}${item.months_observed === 0 ? '无观察' : '仅部分月份有观察'}${typeof item.months_observed_display === 'string' ? `（${item.months_observed_display}个月）` : ''}。`;
}

export function projectObservations(related, listedIds, caveats) {
  const listed = new Set(listedIds), groups = new Map(), notes = [];
  for (const table of related) {
    const contexts = table.observation_context ?? [];
    if (!Array.isArray(contexts)) throw new Error(`观察上下文损坏：${table.id}`);
    const generated = new Set();
    contexts.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`观察上下文损坏：${table.id}`);
      const fromNote = generatedNote(item) && table.notes.includes(item.note);
      if (fromNote) generated.add(item.note);
      if (!(listed.has(table.id) && exceptional(item)) && !fromNote) return;
      const facts = Object.fromEntries(Object.entries(item).filter(([key]) => !['evidence', 'identity', 'member'].includes(key) && !(fromNote && key === 'note')));
      const key = JSON.stringify(facts);
      if (!groups.has(key)) groups.set(key, { ...facts, members: {} });
      const members = groups.get(key).members;
      if (!Object.hasOwn(members, table.id)) Object.defineProperty(members, table.id, { value: [], enumerable: true });
      members[table.id].push(index);
    });
    // 同文 caveat、reason 或其他表的自由说明不能随生成说明一起消失；全局读表说明由附录集中一次，不再逐摘要重复。
    notes.push(...table.notes.filter((note) => !generated.has(note) && !TABLE_READING_NOTES.includes(note)));
  }
  notes.push(...related.map((table) => table.reason).filter(Boolean), ...sectionCaveats(caveats));
  return { notes: unique(notes), observations: [...groups.values()] };
}

export function evidenceCaveats(related, evidenceById) {
  return unique(related.flatMap((table) => table.evidence)).flatMap((id) => {
    const envelope = evidenceById.get(id)?.envelope;
    return [...asArray(envelope?.caveats), ...asArray(envelope?.coverage_notes)];
  });
}
