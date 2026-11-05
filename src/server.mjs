import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA, ROOT, getConfig, initData } from './config.mjs';
import { atomicJson, saveSecret, hasSecret, redact, userError, log, withLock } from './storage.mjs';
import { loadState, saveState, runCycle, drainOutbox } from './engine.mjs';
import { validateWebhook, sendWecom } from './notify.mjs';
import { connectEpicCode, parseEpicAuthorizationCode } from './epic.mjs';
import { NativeEpicLogin, openEpicAccountReviewInDefaultBrowser } from './native-auth.mjs';
import { BrowserBridge } from './bridge.mjs';

export async function serve() {
  return withLock('service', async () => {
    await initData(); const config = await getConfig();
    const bridge = new BrowserBridge(config.port); await bridge.prepare();
    const token = randomBytes(24).toString('hex');
    const nativeEpicLogin = new NativeEpicLogin();
    const nativeEpicReview = new NativeEpicLogin(openEpicAccountReviewInDefaultBrowser);
    let job = null; let lastJob = null; let stopping = false;
    const nextCheck = async () => {
      const c = await getConfig(); const state = await loadState();
      const last = state.lastRun;
      return last ? Date.parse(last.finishedAt) + (last.failed ? c.retryMinutes * 60_000 : c.intervalHours * 3600_000) : Date.now();
    };
    const startJob = (name, action) => {
      if (job) throw new Error('已有任务正在运行');
      lastJob = null;
      job = { name, startedAt: new Date().toISOString() };
      Promise.resolve().then(action).then(result => { lastJob = { ...job, result, ok: true, finishedAt: new Date().toISOString() }; })
        .catch(async e => { lastJob = { ...job, ok: false, error: userError(e.message), finishedAt: new Date().toISOString() }; await log('job_failed', { name, message: e.message }); })
        .finally(() => { job = null; });
    };
    const auth = store => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'cli.mjs'), 'auth', store],
        { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let output = ''; let errors = '';
      child.stdout.on('data', d => output += d); child.stderr.on('data', d => errors += d);
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve({ connected: true }) : reject(new Error(redact(errors || output || '账号连接失败').slice(0, 800))));
    });
    async function status() {
      const state = await loadState();
      return { config: await getConfig(), job, lastJob,
        accounts: { epic: await hasSecret('epic-oauth'), steam: await hasSecret('steam-connected') && await hasSecret('steam-browser') },
        webhookConfigured: await hasSecret('wecom'), lastRun: state.lastRun,
        nextCheck: new Date(await nextCheck()).toISOString(),
        pendingNotifications: state.outbox.filter(e => !e.deliveredAt).length, bridge: await bridge.status(),
        games: Object.values(state.games).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 80)
          .map(({ offer, status, updatedAt, lastError }) => ({ title: offer.title, store: offer.store, url: offer.url, status, updatedAt, lastError: lastError ? userError(lastError) : null })) };
    }
    function reply(res, code, value, type = 'application/json; charset=utf-8') {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    }
    const origin = `http://127.0.0.1:${config.port}`;
    const server = http.createServer(async (req, res) => {
      try {
        if (req.headers.host !== `127.0.0.1:${config.port}`) return reply(res, 403, { error: '仅允许本机访问' });
        const pathname = new URL(req.url, origin).pathname;
        if (pathname.startsWith('/api/bridge/')) return await bridge.handle(req, res, pathname);
        if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: '跨站请求已拒绝' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: '跨站请求已拒绝' });
        if (req.method === 'GET' && pathname === '/') {
          const html = (await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8')).replace('__CSRF_TOKEN__', token);
          return reply(res, 200, html, 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && pathname === '/api/status') return reply(res, 200, await status());
        if (req.method !== 'POST') return reply(res, 404, { error: '不存在的接口' });
        const presented = Buffer.from(req.headers['x-fgk-token'] || ''); const expected = Buffer.from(token);
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return reply(res, 403, { error: '请求凭证无效，请刷新页面' });
        let body = ''; for await (const data of req) { body += data; if (Buffer.byteLength(body) > 16384) throw new Error('请求过大'); }
        const input = body ? JSON.parse(body) : {};
        if (pathname === '/api/webhook') {
          await saveSecret('wecom', { webhook: validateWebhook(input.webhook) });
          return reply(res, 200, { ok: true });
        }
        if (pathname === '/api/extension-folder') { bridge.openFolder(); return reply(res, 200, { ok: true }); }
        if (pathname === '/api/notify-test') {
          startJob('测试企业微信', () => sendWecom('免费游戏助手：企业微信连接测试\n这是一条测试消息，不代表已领取游戏。'));
          return reply(res, 202, { ok: true });
        }
        if (pathname === '/api/config') {
          const updates = { intervalHours: Number(input.intervalHours), includeDlc: input.includeDlc === true };
          if (!(updates.intervalHours >= 1 && updates.intervalHours <= 24)) throw new Error('检查间隔须在 1–24 小时之间');
          await atomicJson(path.join(ROOT, 'config.json'), { ...await getConfig(), ...updates });
          return reply(res, 200, { ok: true });
        }
        if (pathname === '/api/auth') {
          if (!['epic', 'steam'].includes(input.store)) throw new Error('无效商店');
          if (input.store === 'epic') {
            if (job) throw new Error('请等待当前任务结束后再打开登录页');
            return reply(res, 200, await nativeEpicLogin.start());
          }
          startJob(`连接 ${input.store}`, () => auth(input.store));
          return reply(res, 202, { ok: true });
        }
        if (pathname === '/api/epic-code') {
          if (typeof input.code !== 'string') throw new Error('请填写 Epic 一次性授权码');
          const code = parseEpicAuthorizationCode(input.code);
          startJob('保存 Epic 授权', () => connectEpicCode(code));
          return reply(res, 202, { ok: true });
        }
        if (pathname === '/api/epic-review') {
          if (job) throw new Error('请等待当前任务结束后再打开账号确认页');
          return reply(res, 200, await nativeEpicReview.start());
        }
        if (pathname === '/api/run' || pathname === '/api/detect') {
          startJob(pathname === '/api/run' ? '立即领取' : '检查免费游戏', () => runCycle({ dryRun: pathname === '/api/detect' }));
          return reply(res, 202, { ok: true });
        }
        if (pathname === '/api/stop') {
          if (job) throw new Error('请等待当前任务结束后再停止');
          reply(res, 200, { ok: true }); stopping = true; server.close(); return;
        }
        return reply(res, 404, { error: '不存在的接口' });
      } catch (e) { if (!res.headersSent) reply(res, 400, { error: redact(e.message).slice(0, 800),
        ...(['privacy_policy', 'account_review'].includes(e.accountAction) ? { accountAction: e.accountAction } : {}) }); else res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    await atomicJson(path.join(DATA, 'service.json'), { pid: process.pid, url: origin, startedAt: new Date().toISOString() });
    await log('service_started', { url: origin });
    console.log(`配置面板：${origin}`);
    const timer = setInterval(async () => {
      if (job || stopping) return;
      try {
        // One blocked store must not prevent a connected store from running.
        const c = await getConfig();
        if (!await hasSecret('wecom')) return;
        const connected = await Promise.all(c.enabledStores.map(s => hasSecret(s === 'epic' ? 'epic-oauth' : 'steam-connected')));
        if (!connected.some(Boolean)) return;
        if (Date.now() >= await nextCheck()) startJob('定时领取', () => runCycle());
        else startJob('重试待发通知', () => withLock('cycle', async () => { const state = await loadState(); const n = await drainOutbox(state); await saveState(state); return { delivered: n }; }));
      } catch (e) { await log('scheduler_error', { message: e.message }); }
    }, 60_000);
    const stop = () => { stopping = true; server.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await new Promise(resolve => server.once('close', resolve));
    clearInterval(timer);
    await log('service_stopped');
  });
}
