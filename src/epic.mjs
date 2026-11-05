// Store flow adapted from spin311/epic-free-games-claim (GPL-3.0),
// modified 2026-11-05: API auth, price checks, entitlement verification, headless retries.
import { jsonRequest } from './http.mjs';
import { loadSecret, saveSecret, sleep, log } from './storage.mjs';
import { withBrowser } from './browser.mjs';

const ACCOUNT = 'https://account-public-service-prod03.ol.epicgames.com';
const ENTITLEMENT = 'https://entitlement-public-service-prod08.ol.epicgames.com';
const ORDER = 'https://orderprocessor-public-service-ecomprod01.ol.epicgames.com';
const FEED = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
// Public launcher OAuth application identifiers, also used by launcher-compatible clients.
const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

export function parseEpicOffers(payload, now = Date.now()) {
  const elements = payload?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw new Error('Epic 免费列表格式已变化');
  const offers = new Map();
  for (const item of elements) {
    const price = item.price?.totalPrice;
    if (price?.discountPrice !== 0 || !(price.originalPrice > 0)) continue;
    const windows = [...(item.promotions?.promotionalOffers ?? []), ...(item.promotions?.upcomingPromotionalOffers ?? [])]
      .flatMap(g => g.promotionalOffers ?? []);
    const promo = windows.find(w => w.discountSetting?.discountPercentage === 0 && Date.parse(w.startDate) <= now && now < Date.parse(w.endDate));
    if (!promo || !item.id || !item.namespace) continue;
    const mappings = [...(item.catalogNs?.mappings ?? []), ...(item.offerMappings ?? [])];
    const raw = mappings.find(m => m.pageType === 'productHome')?.pageSlug ?? mappings.find(m => m.pageSlug)?.pageSlug ?? item.productSlug;
    const slug = String(raw ?? '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const bundle = item.offerType === 'BUNDLE' || item.categories?.some(c => c.path === 'bundles');
    offers.set(`${item.namespace}:${item.id}`, {
      store: 'epic', id: `${item.namespace}:${item.id}`, namespace: item.namespace, offerId: item.id,
      itemIds: [...new Set((item.items ?? []).map(x => x.id).filter(Boolean))],
      title: item.title || slug || item.id, kind: item.offerType,
      url: slug ? `https://store.epicgames.com/en-US/${bundle ? 'bundle' : 'p'}/${encodeURIComponent(slug)}?lang=en-US` : null,
      end: promo.endDate, price: 0
    });
  }
  return [...offers.values()];
}
export function epicOwned(offer, entitlements, now = Date.now()) {
  const owned = new Set(entitlements.filter(e => e.namespace === offer.namespace && e.status === 'ACTIVE' && e.deleted !== true &&
    (!e.endDate || Date.parse(e.endDate) > now)).map(e => e.catalogItemId));
  // A bundle is verified only when every advertised item is present.
  return offer.itemIds.length > 0 ? offer.itemIds.every(id => owned.has(id)) : owned.has(offer.offerId);
}
export async function discoverEpic(country) {
  const url = new URL(FEED); url.searchParams.set('locale', 'zh-CN');
  if (country) { url.searchParams.set('country', country); url.searchParams.set('allowCountries', country); }
  return parseEpicOffers(await jsonRequest(url));
}
async function oauth(form) {
  const result = await jsonRequest(`${ACCOUNT}/account/api/oauth/token`, { method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token_type: 'eg1', ...form }) });
  if (!result.account_id || !result.access_token || !result.refresh_token) throw new Error('Epic 登录返回缺少必要字段');
  return result;
}
async function completeSession(session) {
  // Persist a rotated refresh token before any other network operation can fail.
  await saveSecret('epic-oauth', session);
  const account = await jsonRequest(`${ACCOUNT}/account/api/public/account/${session.account_id}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (!/^[A-Z]{2}$/.test(account.country)) throw new Error('无法确认 Epic 账号地区');
  const result = { ...session, country: account.country };
  await saveSecret('epic-oauth', result); return result;
}
export async function epicSession() {
  const old = await loadSecret('epic-oauth');
  if (!old) throw new Error('AUTH_REQUIRED: 请先连接 Epic 账号');
  try { return await completeSession(await oauth({ grant_type: 'refresh_token', refresh_token: old.refresh_token })); }
  catch (e) {
    if (e.status === 400 || e.status === 401) throw new Error('AUTH_REQUIRED: Epic 授权已失效，请重新连接');
    throw e;
  }
}
export function epicAuthorizationUrl() {
  const redirect = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
  return `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(redirect)}`;
}
export function epicAccountReviewUrl() {
  return `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent('https://store.epicgames.com/zh-CN/')}`;
}
export function parseEpicAuthorizationCode(input) {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('请粘贴 Epic 登录后显示的一次性授权码，或包含 authorizationCode 的整段文本');
  let code = input.trim();
  if (code.startsWith('{')) {
    let parsed; try { parsed = JSON.parse(code); } catch { throw new Error('授权内容不是有效 JSON，请重新复制登录结果'); }
    if (parsed?.errorCode === 'errors.com.epicgames.oauth.corrective_action_required') {
      const privacy = parsed?.metadata?.correctiveAction === 'PRIVACY_POLICY_ACCEPTANCE';
      const error = new Error(privacy
        ? 'Epic 要求确认隐私政策，尚未生成授权码。请在同一常用浏览器登录 Epic 商店，阅读并自行决定是否同意政策；完成后重新获取授权码。'
        : 'Epic 账号还有待完成的确认步骤。请在常用浏览器登录 Epic 商店并按页面提示处理，再重新获取授权码。');
      error.accountAction = privacy ? 'privacy_policy' : 'account_review';
      throw error;
    }
    if (parsed?.errorCode) throw new Error('这段内容是 Epic 登录错误，尚未包含授权码。请回到平台完成登录后再试。');
    code = parsed.authorizationCode || parsed.code;
  } else if (/^https?:\/\//i.test(code)) {
    const url = new URL(code);
    if (url.protocol !== 'https:' || !['www.epicgames.com', 'epicgames.com'].includes(url.hostname) || url.pathname !== '/id/api/redirect') throw new Error('请使用 Epic 登录结果中的授权码');
    code = url.searchParams.get('authorizationCode') || url.searchParams.get('code');
  }
  if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{8,512}$/.test(code)) throw new Error('未识别到一次性授权码；不要粘贴密码、Cookie 或其他内容');
  return code;
}
export async function connectEpicCode(input) {
  const code = parseEpicAuthorizationCode(input);
  try {
    const session = await completeSession(await oauth({ grant_type: 'authorization_code', code }));
    await log('auth_connected', { store: 'epic', method: 'regular-browser-code', country: session.country });
    return { connected: true, country: session.country };
  } catch (e) {
    if (e.status === 400 || e.status === 401) throw new Error('一次性授权码已失效或已使用，请重新完成 Epic 登录后复制新的授权码');
    throw e;
  }
}
export async function epicEntitlements(session) {
  const entitlements = [];
  for (let start = 0; start < 100_000; start += 1000) {
    const url = `${ENTITLEMENT}/entitlement/api/account/${session.account_id}/entitlements?start=${start}&count=1000`;
    const page = await jsonRequest(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!Array.isArray(page)) throw new Error('Epic 库存格式已变化');
    entitlements.push(...page); if (page.length < 1000) return entitlements;
  }
  throw new Error('Epic 库存分页异常');
}
export async function verifyEpic(session, offer, attempts = 4) {
  for (let n = 0; n < attempts; n++) {
    if (epicOwned(offer, await epicEntitlements(session))) return true;
    if (n + 1 < attempts) await sleep(2500);
  }
  return false;
}
export async function epicQuickClaim(session, offer) {
  // Re-read the region-specific feed immediately before issuing the free order.
  const fresh = (await discoverEpic(session.country)).find(o => o.id === offer.id);
  if (!fresh || fresh.price !== 0) throw new Error('NOT_FREE: 该游戏在账号地区已不再免费');
  const url = `${ORDER}/orderprocessor/api/shared/accounts/${session.account_id}/orders/quickPurchase?country=${session.country}&locale=en-US`;
  const result = await jsonRequest(url, { method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ salesChannel: 'Launcher-purchase-client', entitlementSource: 'Launcher-purchase-client',
      returnSplitPaymentItems: false, lineOffers: [{ offerId: fresh.offerId, namespace: fresh.namespace, quantity: 1 }] }) });
  await log('epic_api_order_result', { title: offer.title, status: result?.quickPurchaseStatus || 'not_provided',
    responseFields: result && typeof result === 'object' ? Object.keys(result) : [] });
  // The quick-purchase route sends paid/restricted offers to interactive checkout.
  // A response alone is never proof of a successful claim.
  if (result?.quickPurchaseStatus === 'CHECKOUT') return false;
  return verifyEpic(session, offer);
}
export function zeroCheckoutTotal(text) {
  const matches = [...text.matchAll(/\btotal\s*[:：]?\s*(?:[A-Z]{2,3}\s*)?(?:[$€£¥￥]\s*)?([0-9][\d.,]*)/gi)];
  if (!matches.length) return false;
  return matches.every(m => /^0+(?:[.,]0+)?$/.test(m[1]));
}
export function epicWebLoginUrl(exchangeCode, destination) {
  const target = new URL(destination);
  if (target.protocol !== 'https:' || target.hostname !== 'store.epicgames.com') throw new Error('不允许的 Epic 商店跳转地址');
  if (typeof exchangeCode !== 'string' || !/^[a-zA-Z0-9_-]{8,512}$/.test(exchangeCode)) throw new Error('Epic 网页授权凭据无效');
  const url = new URL('https://www.epicgames.com/id/exchange');
  url.searchParams.set('exchangeCode', exchangeCode); url.searchParams.set('redirectUrl', target.href);
  return url.href;
}
export async function epicCheckoutPage(context, offer, session) {
  const page = await context.newPage();
  if (session) {
    const exchange = await jsonRequest(`${ACCOUNT}/account/api/oauth/exchange`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    await page.goto(epicWebLoginUrl(exchange.code, offer.url), { waitUntil: 'domcontentloaded' });
  } else await page.goto(offer.url, { waitUntil: 'domcontentloaded' });
  return page;
}
export async function epicBrowserClaim(offer, country, session) {
  if (!offer.url) throw new Error('Epic 商品缺少有效网址');
  if (!(await discoverEpic(country)).some(o => o.id === offer.id)) throw new Error('NOT_FREE: Epic 免费活动已结束');
  return withBrowser('epic', true, async context => {
    const page = await epicCheckoutPage(context, offer, session);
    return driveEpicPage(page);
  });
}
export async function driveEpicPage(page, timeoutMs = 90_000) {
    const purchaseSelector = '[data-testid="purchase-cta-button"],button[class*="_sidebarBuyButton_"]';
    const deadline = Date.now() + timeoutMs; const clicked = new Set(); let got = false; let confirmed = false;
    while (Date.now() < deadline) {
      if (/\/id\/login/.test(page.url())) throw new Error('AUTH_REQUIRED: Epic 网页登录已过期');
      for (const frame of page.frames()) {
        if (!/https:\/\/[^/]*epicgames\.com\//.test(frame.url()) && frame !== page.mainFrame()) continue;
        const text = await frame.locator('body').innerText({ timeout: 1500 }).catch(() => '');
        if (/verify you are human|checking your browser|security verification/i.test(text)) throw new Error('CAPTCHA: Epic 要求人机验证，稍后自动重试');
        const captcha = frame.locator('iframe[src*="hcaptcha.com"],iframe[src*="challenges.cloudflare.com"]');
        for (let i = 0; i < await captcha.count(); i++) if (await captcha.nth(i).isVisible()) throw new Error('CAPTCHA: Epic 验证码阻止了领取');
        // These UI strings only end the interaction; entitlements are checked by the caller.
        if (/thanks for your order|it['’]s all yours|has been added to your library/i.test(text)) return;
        const owned = frame.locator(purchaseSelector).filter({ hasText: /^In Library$/i });
        if (await owned.count() && await owned.first().isVisible()) return;
        const age = frame.locator('#btn_age_continue');
        if (await age.count() && await age.isVisible() && await age.isEnabled()) { await age.click(); await sleep(500); continue; }
        if (!got) {
          const button = frame.locator(purchaseSelector).filter({ hasText: /^Get$/i });
          if (await button.count() && await button.first().isVisible()) { await button.first().click(); got = true; await sleep(1200); continue; }
        }
        const dialogs = frame.getByRole('dialog').filter({ hasText: /not (supported|compatible)/i });
        if (await dialogs.count()) {
          const next = dialogs.first().getByRole('button', { name: /^Continue$/i });
          if (await next.count() && await next.isVisible()) { await next.click(); await sleep(500); continue; }
        }
        for (const label of ['Place Order', 'Add to library', 'I accept']) {
          if (clicked.has(label)) continue;
          const button = frame.getByRole('button', { name: label, exact: true });
          if (!await button.count() || !await button.first().isVisible() || !await button.first().isEnabled()) continue;
          if (label !== 'I accept' && !zeroCheckoutTotal(text)) throw new Error('PRICE_UNCONFIRMED: 结账页无法确认总额为零，未提交订单');
          if (label === 'I accept' && !confirmed) continue;
          await button.first().click(); clicked.add(label); if (label !== 'I accept') confirmed = true;
          await sleep(1200); break;
        }
      }
      await sleep(700);
    }
    throw new Error('Epic 网页领取超时，将在下轮重试');
}
