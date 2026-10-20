import { inputSnapshot, validInputBinding } from './input-view.mjs';

export async function reportSnapshot(path) {
  return inputSnapshot(path, { required: true, label: 'report.md' });
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const issue = (value) => object(value) && typeof value.detail === 'string';

/** A matching digest alone cannot make a broken check envelope trustworthy. */
export function checkBinding(checked, reportSha256, inputBinding) {
  if (!object(checked) || typeof checked.ok !== 'boolean' || !Array.isArray(checked.blocking) ||
      !checked.blocking.every((entry) => issue(entry) && typeof entry.type === 'string') ||
      !Array.isArray(checked.warnings) || !checked.warnings.every(issue) || !object(checked.stats) ||
      !['tables', 'slots', 'numbers_checked', 'charts'].every((key) => Number.isSafeInteger(checked.stats[key]) && checked.stats[key] >= 0) ||
      checked.ok !== (checked.blocking.length === 0)) return { available: false, reason: 'check.json 缺失或结构损坏' };
  if (typeof checked.report_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(checked.report_sha256)) return { available: false, reason: 'check.json 正文 SHA-256 缺失或损坏' };
  if (checked.report_sha256 !== reportSha256) return { available: false, reason: 'check.json 正文 SHA-256 与本次正文不匹配，请重新 check' };
  if (!validInputBinding(checked.input_binding) || checked.input_binding.files.find((file) => file.path === 'report.md')?.sha256 !== reportSha256)
    return { available: false, reason: 'check.json 输入版本绑定缺失、损坏或版本不支持，请重新 check' };
  if (!validInputBinding(inputBinding) || JSON.stringify(checked.input_binding.files) !== JSON.stringify(inputBinding.files))
    return { available: false, reason: 'check.json 输入版本已变化或与本次材料不匹配，请重新 assemble / check' };
  return { available: true };
}
