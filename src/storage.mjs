import { readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA, ROOT, initData } from './config.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw e; }
}
export function redact(value) {
  return String(value).split(/\r?\nCall log:/)[0].replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^\s*(?:-\s*)?(?:cookie|set-cookie|authorization|proxy-authorization)\s*:.*$/gmi, '[请求凭证头已隐藏]')
    .replace(/https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[^\s"'<>]+/gi, '[企业微信地址已隐藏]')
    .replace(/([?&](?:code|authorizationCode|exchangeCode|key|token)=)[^&\s]+/gi, '$1[已隐藏]')
    .replace(/((?:access_token|refresh_token|authorizationCode|authorization|continuation|sessionid|steamLoginSecure)["'\s:=]+)[^,\s"']+/gi, '$1[已隐藏]');
}
export function userError(value) {
  const message = redact(value);
  if (message.includes('ERR_NETWORK_ACCESS_DENIED')) return '登录浏览器的网络访问被运行环境阻止，账号尚未连接。请从正常后台启动助手后重试。';
  if (message.includes('ERR_PROXY_CONNECTION_FAILED')) return '登录浏览器无法连接代理，账号尚未连接。请检查助手的浏览器代理设置。';
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(message)) return '连接游戏平台时网络中断，本轮未能完成。程序会自动重试，现有账号授权已保留。';
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET/.test(message)) return '暂时无法连接游戏平台，请稍后重试。';
  if (/page\.goto.*Timeout|Navigation timeout/i.test(message)) return '游戏平台登录页加载超时，请稍后重试。';
  return message.split('Call log:')[0].replace(/^(?:page\.\w+|locator\.\w+):\s*/, '').trim().slice(0, 800);
}
export async function log(event, detail = {}) {
  await initData();
  // No raw API responses, credentials, cookies or request URLs enter the log.
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail }, (_, v) => typeof v === 'string' ? redact(v).slice(0, 1500) : v);
  const handle = await open(path.join(DATA, 'activity.jsonl'), 'a', 0o600);
  try { await handle.write(line + '\n'); } finally { await handle.close(); }
}
async function dpapi(mode, text) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'dpapi.ps1'), '-Mode', mode],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`本机凭证保护失败 (${code})`)));
    p.stdin.on('error', () => {}); p.stdin.end(text);
  });
}
async function linuxKey() {
  const file = path.join(DATA, 'master.key');
  try { return await readFile(file); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { await writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    return readFile(file);
  }
}
export async function saveSecret(name, value) {
  await initData(); const plain = JSON.stringify(value);
  let record;
  if (process.platform === 'win32') record = { algorithm: 'dpapi-current-user', blob: await dpapi('Protect', Buffer.from(plain).toString('base64')) };
  else {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await linuxKey(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    record = { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), blob: data.toString('base64') };
  }
  await atomicJson(path.join(DATA, `${name}.secret.json`), record);
}
export async function loadSecret(name) {
  const record = await readJson(path.join(DATA, `${name}.secret.json`), null);
  if (!record) return null;
  if (record.algorithm === 'dpapi-current-user') return JSON.parse(Buffer.from(await dpapi('Unprotect', record.blob), 'base64').toString('utf8'));
  const decipher = createDecipheriv('aes-256-gcm', await linuxKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.blob, 'base64')), decipher.final()]).toString('utf8'));
}
export async function hasSecret(name) {
  return (await readJson(path.join(DATA, `${name}.secret.json`), null)) !== null;
}
export async function withLock(name, action) {
  await initData(); const file = path.join(DATA, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let lock;
      try { lock = await readJson(file, {}); }
      catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        const age = Date.now() - (await stat(file)).mtimeMs;
        if (age < 30_000) throw new Error(`BUSY: ${name} 正在初始化`);
        await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); continue;
      }
      let alive = true;
      if (Number.isInteger(lock.pid)) {
        try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error(`BUSY: ${name} 正在运行`);
      await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return await action();
    } finally { await handle.close(); await unlink(file).catch(() => {}); }
  }
  throw new Error('无法取得运行锁');
}
