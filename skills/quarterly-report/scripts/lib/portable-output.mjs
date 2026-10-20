import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { osAliasPath, validateOutput } from './portable-binding.mjs';
import { inputSnapshot } from './input-view.mjs';

// Explicit non-sensitive hook output; no fallback if it is missing or malformed.
export async function captureHookOutput(path, token) {
  let entries, original;
  const take = async () => {
    const actual = await realpath(path), snapshot = await inputSnapshot(actual);
    if ((resolve(path) !== actual && osAliasPath(path) !== actual) || !snapshot || (snapshot.stat.mode & 0o777n) !== 0o600n
      || (process.getuid && snapshot.stat.uid !== BigInt(process.getuid()))) throw new Error('unsafe');
    return snapshot;
  };
  try {
    original = await take();
    const content = original.bytes.toString('utf8');
    if (token && content.includes(token)) throw new Error('secret');
    entries = content.split('\n').filter(Boolean).map((line) => {
      const at = line.indexOf('='); if (at < 1) throw new Error('format');
      return [line.slice(0, at), line.slice(at + 1)];
    });
    if (entries.length !== 3 || new Set(entries.map(([key]) => key)).size !== 3 || entries.some(([key]) => !['feishu', 'lark_cli', 'report_dir'].includes(key))) throw new Error('keys');
  } catch { throw new Error('显式输出配置须为本人 0600 普通文件，且仅含 feishu/lark_cli/report_dir'); }
  const value = Object.fromEntries(entries);
  if (!['0', '1'].includes(value.feishu) || !isAbsolute(value.report_dir) || value.report_dir.trim() !== value.report_dir
    || /[\x00-\x1f\x7f]/u.test(value.report_dir + value.lark_cli) || (value.lark_cli && (!isAbsolute(value.lark_cli) || value.lark_cli.trim() !== value.lark_cli)))
    throw new Error('显式冻结输出偏好格式或路径无效');
  const output = Object.freeze({ report_dir: resolve(value.report_dir), lark_cli: value.lark_cli ? resolve(value.lark_cli) : '', feishu_output: value.feishu === '1' });
  await validateOutput(output, { ...process.env, STRATEGIC_MCP_TOKEN: token });
  return { output,
    async assertUnchanged() {
      const current = await take();
      if (current.sha256 !== original.sha256 || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => current.stat[key] !== original.stat[key]))
        throw new Error('导入输出配置在冻结前发生变化，请重试 verify');
    },
  };
}
