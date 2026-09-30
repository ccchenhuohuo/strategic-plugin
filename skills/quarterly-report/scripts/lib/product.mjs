import { shown, value } from './common.mjs';

// All product_rank field access lives here. Task C is implemented independently.
export const productRows = (data, brand) => (data?.rows ?? []).filter((row) => row.brand === brand);
export const productCell = (row, field) => {
  const fields = {
    rank: ['rank'], amount_local: ['current', 'amount'], amount_cny: ['current', 'amount_cny'], share_brand: ['current', 'share_of_brand_pct'],
    share_scope: ['current', 'share_of_scope_pct'], growth: ['yoy', 'growth_pct'], unit_value: ['current', 'unit_value'],
  };
  const path = fields[field];
  if (!path) return null;
  return shown(row, path);
};
export const productStatus = (row) => row.yoy?.status ?? row.current?.status ?? '—';
export const productSummary = (data) => data?.summary?.yoy ?? null;
export const summaryCell = (data, path) => shown(productSummary(data), path);
export const identityCell = (data, key) => shown(productSummary(data), ['pool', key]);
