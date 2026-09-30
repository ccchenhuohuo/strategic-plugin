import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mcpTokens } from './environment.mjs';

export const json = (value) => JSON.stringify(value, null, 2) + '\n';
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
export const eid = (number) => `E${String(number).padStart(3, '0')}`;
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const clean = (value, secret) => {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => clean(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, secret)]));
  return value;
};
// 输出、日志与落盘文件里一律抹掉的凭据：环境变量里的令牌，加上从连接文件读到的令牌（addSecret 登记）。
const secrets = new Set(mcpTokens(process.env));
export const addSecret = (secret) => { if (secret) secrets.add(String(secret)); };
export const redact = (value) => [...secrets].reduce((current, secret) => clean(current, secret), value);
export const writeJson = async (path, value) => writeFile(path, json(redact(value)));
export async function ensureEmpty(dir, force) {
  const absolute = resolve(dir);
  if (force && ['/', '/tmp', '/private/tmp'].includes(absolute)) throw new Error('拒绝清理根目录');
  try {
    const target = await lstat(dir);
    if (target.isSymbolicLink()) throw new Error(`输出目录不得是符号链接：${dir}`);
    if (target.isDirectory()) {
      const entries = await readdir(dir);
      if (entries.length && !force) throw new Error(`输出目录非空：${dir}；如需覆盖请传 --force`);
      if (entries.length && force) for (const entry of entries) await rm(join(dir, entry), { recursive: true, force: true });
    } else throw new Error(`输出路径不是目录：${dir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dir, { recursive: true });
}
export async function writeArtifact(dir, relative, value) {
  const path = join(dir, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, redact(String(value)));
}
export const safeName = (name) => String(name).replace(/[^\p{L}\p{N}._-]+/gu, '_');
export const asArray = (value) => Array.isArray(value) ? value : [];
export const unique = (items) => [...new Set(items.filter((item) => item !== null && item !== undefined && item !== ''))];
export const value = (object, path) => path.reduce((item, key) => item?.[key], object);
export const shown = (object, path) => {
  if (!object) return null;
  const parent = value(object, path.slice(0, -1));
  const field = path.at(-1);
  const result = parent?.[`${field}_display`];
  return typeof result === 'string' ? result : null;
};
export const cell = (item) => item === null || item === undefined || item === '' ? '—' : String(item);
export const statusCell = (item) => cell(item).replaceAll('|', '\\|').replaceAll('\n', ' ');
