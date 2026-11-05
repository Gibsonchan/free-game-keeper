import { SteamClient } from '../vendor/freekeep/steam.mjs';
import { withBrowser, requestFetch } from './browser.mjs';
import { sleep, saveSecret, log } from './storage.mjs';

async function ready(client) {
  let session = await client.session();
  if (!session.loggedIn) { await client.renew(); session = await client.session(); }
  if (!session.loggedIn || !session.sessionid) throw new Error('AUTH_REQUIRED: Steam 登录已失效，请连接账号');
  if (!session.country) throw new Error('无法确认 Steam 账号地区，已停止领取');
  return session;
}
export async function connectSteam() {
  return withBrowser('steam', false, async context => {
    const page = await context.newPage();
    await page.goto('https://store.steampowered.com/login/?redir=&redir_ssl=1', { waitUntil: 'domcontentloaded' });
    await log('auth_page_loaded', { store: 'steam', host: new URL(page.url()).hostname });
    const client = new SteamClient(requestFetch(context));
    for (let n = 0; n < 400; n++) {
      if (page.isClosed()) throw new Error('登录窗口已关闭，Steam 尚未连接');
      const hasLogin = (await context.cookies('https://store.steampowered.com')).some(c => c.name === 'steamLoginSecure');
      if (!hasLogin) { await sleep(1500); continue; }
      const session = await client.session();
      if (session.loggedIn && session.country) {
        await saveSecret('steam-connected', { connected: true, country: session.country });
        return { connected: true, country: session.country };
      }
      await sleep(5000);
    }
    throw new Error('Steam 登录等待超时');
  });
}
export function steamOffer(sub) {
  return { ...sub, store: 'steam', id: String(sub.subid), title: sub.name, url: `https://store.steampowered.com/app/${sub.appid}/` };
}
export async function steamOffers(client, country, includeDlc = true) {
  const offers = [];
  const ids = await client.searchFreeAppIds(country);
  for (const appid of ids) {
    for (const sub of await client.freeSubs(appid, country)) {
      if (sub.kind === 'game' || (includeDlc && sub.kind === 'dlc')) offers.push(steamOffer(sub));
    }
    await sleep(250);
  }
  return [...new Map(offers.map(o => [o.id, o])).values()];
}
export async function verifySteam(client, offer, attempts = 4) {
  for (let n = 0; n < attempts; n++) {
    const owned = await client.owned();
    if (owned.packages.has(offer.subid)) return true;
    if (n + 1 < attempts) await sleep(2500);
  }
  return false;
}
export async function withSteam(action) {
  return withBrowser('steam', true, async context => {
    const fetchImpl = requestFetch(context);
    const client = new SteamClient(fetchImpl);
    const session = await ready(client);
    const html = await (await fetchImpl('https://store.steampowered.com/?l=english')).text();
    const accountKey = html.match(/g_AccountID\s*=\s*([1-9]\d*)/)?.[1];
    if (!accountKey) throw new Error('无法确认 Steam 账号标识，已停止领取');
    session.accountKey = accountKey;
    return action(client, session);
  });
}
export async function steamClaim(client, session, offer) {
  // Revalidate the exact free-to-keep license, rather than trusting a stale search result.
  const fresh = await client.freeSubs(offer.appid, session.country);
  if (!fresh.some(s => s.subid === offer.subid)) throw new Error('NOT_FREE: Steam 免费许可证已失效');
  const owned = await client.owned();
  if (owned.packages.has(offer.subid)) return 'owned';
  if (offer.baseAppid && !owned.apps.has(offer.baseAppid)) return 'needs_base';
  const result = await client.claim(offer.subid, session.sessionid);
  if (result.kind === 'logged_out') throw new Error('AUTH_REQUIRED: Steam 登录已过期');
  if (result.kind === 'needs_base') return 'needs_base';
  if (!['claimed', 'owned'].includes(result.kind)) throw new Error(`Steam 领取失败: ${result.code}`);
  // FreeKeep treats an HTTP success as claimed. This adapter additionally requires inventory proof.
  if (!await verifySteam(client, offer)) throw new Error('UNVERIFIED: Steam 尚未显示该许可证，已保留重试');
  return result.kind === 'owned' ? 'owned' : 'claimed';
}
