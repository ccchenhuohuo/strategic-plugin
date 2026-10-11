import { asArray, shown } from './common.mjs';

// All product_rank field access lives here. Task C is implemented independently.
export const productRows = (data, brand) => productAvailability(data) ? [] : asArray(data?.rows).filter((row) => row.brand === brand);
export function productAvailability(data, scope = '商品明细') {
  const status = data?.slice_status && data.slice_status !== 'online' ? data.slice_status : data?.status;
  if (!status || ['ok', 'online', 'observed'].includes(status)) return null;
  const meaning = status === 'archived' ? 'SKU 月明细已归档，不能查询商品明细' : `${scope}状态：${status}`;
  return { status, reason: [meaning, data.note, data.reason].filter(Boolean).join('；') };
}
export function productRankAvailability(data, brands) {
  const unavailable = productAvailability(data);
  if (unavailable) return unavailable;
  if (asArray(data?.rows).some((row) => brands.includes(row.brand)) || !asArray(data?.brands_summary).some((item) => brands.includes(item.brand) && item.status === 'observed')) return null;
  return { status: 'no_rankable_products', reason: '该品牌当期有观察，但无符合排名资格的商品' + (Number(data?.ambiguous_excluded?.identities) > 0 ? '；本次请求存在商品身份歧义排除' : '') };
}
export const productRankGaps = (data, brands) => brands.flatMap((brand) => {
  const state = productRankAvailability(data, [brand]);
  return state?.status === 'no_rankable_products' ? [{ brand, ...state }] : [];
});
export const productCell = (row, field) => {
  const fields = {
    rank: ['rank'], amount_local: ['current', 'amount'], amount_cny: ['current', 'amount_cny'], share_brand: ['current', 'share_of_brand_pct'],
    share_scope: ['current', 'share_of_scope_pct'], growth: ['yoy', 'growth_pct'], unit_value: ['current', 'unit_value'],
  };
  const path = fields[field];
  if (!path) return null;
  return shown(row, path);
};
export const productStatus = (row, notes = []) => [row.yoy?.status ?? row.current?.status ?? '—', ...notes].join('；');
export const productSummary = (data) => data?.summary?.yoy ?? null;
export const poolAvailability = (data) => productAvailability(data) ?? productAvailability(productSummary(data), '商品身份池');
export const summaryCell = (data, path) => shown(productSummary(data), path);
export const identityCell = (data, key) => shown(productSummary(data), ['pool', key]);
