// 来源说明及旧探针按绑定代次判定，
// 不按当前默认类目或时间戳存在性推断。
export function retainsCategoryOthers(stamp = {}) {
  const match = typeof stamp.table_spec_version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/u.exec(stamp.table_spec_version);
  if (!match || match.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || major === 1 && (minor > 6 || minor === 6 && patch >= 1);
}

export function sourceContract(stamp = {}) {
  const version = typeof stamp.table_spec_version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/u.exec(stamp.table_spec_version);
  if (!version || version.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) return 'unknown';
  const [major, minor] = version.slice(1).map(Number);
  return major > 1 || (major === 1 && minor >= 6) ? 'direct_wide' : 'legacy_derived';
}
