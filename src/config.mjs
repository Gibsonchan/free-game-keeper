import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(process.env.FGK_DATA_DIR || path.join(ROOT, 'data'));
export async function getConfig() {
  let user = {};
  try { user = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const c = { intervalHours: 6, retryMinutes: 30, country: null, includeDlc: true,
    enabledStores: ['epic', 'steam'], port: 18769,
    browserChannel: process.platform === 'win32' ? 'msedge' : null, browserProxy: null,
    epicWebMode: process.platform === 'win32' ? 'extension' : 'headless', ...user };
  if (!(c.intervalHours >= 1 && c.intervalHours <= 24)) throw new Error('检查间隔须在 1–24 小时之间');
  if (!(c.retryMinutes >= 10 && c.retryMinutes <= 360)) throw new Error('重试间隔须在 10–360 分钟之间');
  if (c.country && !/^[A-Z]{2}$/.test(c.country)) throw new Error('国家代码必须为两个大写字母');
  if (c.browserProxy !== null && c.browserProxy !== 'direct' && !/^https?:\/\//.test(c.browserProxy)) throw new Error('无效的浏览器代理配置');
  if (!['extension', 'headless'].includes(c.epicWebMode)) throw new Error('无效的 Epic 网页领取方式');
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw new Error('无效端口');
  if (!Array.isArray(c.enabledStores) || c.enabledStores.some(s => !['epic', 'steam'].includes(s))) throw new Error('无效商店');
  return c;
}
export async function initData() { await mkdir(DATA, { recursive: true, mode: 0o700 }); }
