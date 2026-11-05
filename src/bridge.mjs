import path from 'node:path';
import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA, ROOT } from './config.mjs';
import { loadSecret, saveSecret, withLock, userError } from './storage.mjs';
import { loadState, saveState, processOffer, drainOutbox, identity, alertOnce } from './engine.mjs';
import { epicSession, verifyEpic, discoverEpic } from './epic.mjs';

const REPORTS = new Set(['claimed', 'captcha', 'login_required', 'timeout', 'price_unconfirmed', 'failed']);
const REASONS = {
  captcha: 'Epic 要求人机验证，已暂停此游戏。请在 Chrome 中查看 Epic 页面，处理后点扩展里的“重试待领取”。',
  login_required: 'Chrome 中的 Epic 登录已失效。请在该浏览器登录 Epic 后，点扩展里的“重试待领取”。',
  timeout: 'Chrome 中的网页结账没有完成，已暂停此游戏。',
  price_unconfirmed: '网页无法确认结账总额为零，未提交订单。',
  failed: '网页领取未完成，账号库存尚未确认。',
  claimed: '网页显示已完成，但账号库存尚未确认；后续会再次核对。'
};
export function parseBridgeReport(input) {
  if (!input || typeof input.key !== 'string' || !/^[a-zA-Z0-9:_-]{1,240}$/.test(input.key) || !REPORTS.has(input.result))
    throw new Error('无效的浏览器领取报告');
  return { key: input.key, result: input.result };
}
export class BrowserBridge {
  constructor(port) { this.port = port; this.lastSeen = 0; this.clientVersion = null; this.leases = new Map(); this.output = path.join(DATA, 'epic-extension'); }
  async prepare() {
    let secret = await loadSecret('browser-bridge');
    if (!secret) { secret = { token: randomBytes(32).toString('hex') }; await saveSecret('browser-bridge', secret); }
    this.token = secret.token;
    await mkdir(this.output, { recursive: true, mode: 0o700 });
    for (const file of await readdir(path.join(ROOT, 'extension'))) await copyFile(path.join(ROOT, 'extension', file), path.join(this.output, file));
    await copyFile(path.join(ROOT, 'LICENSE'), path.join(this.output, 'LICENSE'));
    await writeFile(path.join(this.output, 'config.js'), `globalThis.FGK_CONFIG=${JSON.stringify({ base: `http://127.0.0.1:${this.port}`, token: this.token })};\n`, { mode: 0o600 });
  }
  async status() {
    const state = await loadState(); const games = Object.values(state.games);
    return { folder: this.output, online: Date.now() - this.lastSeen < 150_000,
      lastSeen: this.lastSeen ? new Date(this.lastSeen).toISOString() : null, version: this.clientVersion,
      updateRequired: this.lastSeen > 0 && this.clientVersion !== '0.1.1',
      pending: games.filter(g => g.status === 'pending_browser').length,
      blocked: games.filter(g => g.status === 'blocked_browser').length };
  }
  openFolder() {
    const p = spawn(process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [this.output], { windowsHide: true, detached: true, stdio: 'ignore' });
    p.on('error', () => {}); p.unref();
  }
  authorized(req) {
    const provided = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(this.token || '');
    return provided.length === expected.length && expected.length > 0 && timingSafeEqual(provided, expected);
  }
  async next(version) {
    this.lastSeen = Date.now();
    this.clientVersion = version || null;
    // Older connectors cannot carry the fresh-price proof; let them stay idle until reloaded.
    if (this.clientVersion !== '0.1.1') return null;
    const state = await loadState();
    for (const [key, game] of Object.entries(state.games)) {
      if (game.offer?.store !== 'epic' || game.status !== 'pending_browser' || !game.offer.url || Date.parse(game.offer.end) <= Date.now()) continue;
      if ((this.leases.get(key) || 0) > Date.now()) continue;
      this.leases.set(key, Date.now() + 180_000);
      try {
        const session = await loadSecret('epic-oauth');
        if (!session?.country || !key.startsWith(`epic:${identity(session.account_id)}:`)) throw new Error('待领取任务与 Epic 账号不匹配');
        const current = (await discoverEpic(session.country)).find(o => o.id === game.offer.id && o.price === 0);
        if (!current) throw new Error('当前活动无法再次核实为零价，未交给浏览器领取');
        return { key, offer: { title: game.offer.title, url: game.offer.url, end: current.end,
          zeroPriceVerified: true, priceVerifiedAt: Date.now() } };
      } catch (e) { this.leases.delete(key); throw e; }
    }
    return null;
  }
  async report(input) {
    const { key, result } = parseBridgeReport(input);
    return withLock('cycle', async () => {
      const state = await loadState(); const game = state.games[key];
      if (!game || game.offer?.store !== 'epic') throw new Error('领取任务不存在');
      if (['claimed', 'owned'].includes(game.status)) return { verified: true };
      if (!['pending_browser', 'blocked_browser', 'unverified'].includes(game.status)) throw new Error('领取任务状态不匹配');
      const session = await epicSession(); const account = identity(session.account_id);
      if (!key.startsWith(`epic:${account}:`)) throw new Error('浏览器任务与当前 Epic 账号不匹配');
      // Browser output is untrusted. Only the platform inventory can establish success.
      const verified = await verifyEpic(session, game.offer, result === 'claimed' ? 5 : 1);
      if (verified) {
        await processOffer(state, account, game.offer, { owned: async () => true });
        if (state.lastRun) { state.lastRun.claimed++; state.lastRun.pending = Math.max(0, (state.lastRun.pending || 0) - 1); }
        await drainOutbox(state); await saveState(state);
      } else {
        state.games[key] = { ...game, status: 'blocked_browser', lastError: REASONS[result], updatedAt: new Date().toISOString() };
        alertOnce(state, `epic:browser_${result}`, `Epic：${game.offer.title}\n${REASONS[result]}`);
        await saveState(state); await drainOutbox(state); await saveState(state);
      }
      this.leases.delete(key); return { verified };
    });
  }
  async retry() {
    return withLock('cycle', async () => {
      const state = await loadState(); let count = 0;
      for (const [key, game] of Object.entries(state.games)) if (game.offer?.store === 'epic' && game.status === 'blocked_browser') {
        game.status = 'pending_browser'; delete game.lastError; this.leases.delete(key); count++;
      }
      await saveState(state); return { requeued: count };
    });
  }
  async handle(req, res, pathname) {
    const origin = req.headers.origin;
    const allowedOrigin = !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(allowedOrigin && origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}) };
    const reply = (code, data) => { res.writeHead(code, headers); res.end(JSON.stringify(data)); };
    if (!allowedOrigin) return reply(403, { error: '扩展来源无效' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-FGK-Version' }); return res.end();
    }
    if (!this.authorized(req)) return reply(403, { error: '扩展未与本机配对' });
    try {
      if (req.method === 'GET' && pathname === '/api/bridge/next') return reply(200, { job: await this.next(req.headers['x-fgk-version']) });
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new Error('请求过大'); }
      if (req.method === 'POST' && pathname === '/api/bridge/report') return reply(200, await this.report(JSON.parse(body)));
      if (req.method === 'POST' && pathname === '/api/bridge/retry') return reply(200, await this.retry());
      return reply(404, { error: '扩展接口不存在' });
    } catch (e) { return reply(400, { error: userError(e.message) }); }
  }
}
