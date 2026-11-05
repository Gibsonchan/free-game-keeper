import { chromium } from 'playwright';
import { getConfig } from './config.mjs';
import { loadSecret, saveSecret, withLock, redact } from './storage.mjs';

export async function withBrowser(store, headless, action) {
  return withLock(`browser-${store}`, async () => {
    const config = await getConfig();
    const browser = await chromium.launch({ headless, ...(config.browserChannel ? { channel: config.browserChannel } : {}),
      ...(config.browserProxy === 'direct' ? { args: ['--no-proxy-server'] } :
        config.browserProxy ? { proxy: { server: config.browserProxy } } : {}) });
    let context;
    try {
      const state = await loadSecret(`${store}-browser`);
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 },
        ...(state ? { storageState: state } : {}) });
      context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(35000);
      const result = await action(context);
      return result;
    } finally {
      if (context) {
        try { await saveSecret(`${store}-browser`, await context.storageState({ indexedDB: true })); }
        finally { await browser.close(); }
      } else await browser.close();
    }
  });
}
export function requestFetch(context) {
  return async (url, options = {}) => {
    const body = options.body;
    const method = (options.method || 'GET').toUpperCase();
    let res;
    try { res = await context.request.fetch(url, { method,
      headers: { ...(options.cache === 'no-store' ? { 'Cache-Control': 'no-cache' } : {}), ...options.headers },
      ...(body instanceof URLSearchParams ? { form: Object.fromEntries(body) } : body ? { data: body } : {}),
      maxRetries: ['GET', 'HEAD'].includes(method) ? 2 : 0,
      failOnStatusCode: false, timeout: 25000 }); }
    catch (e) { throw new Error(redact(e.message)); }
    return new Response(await res.body(), { status: res.status(), headers: res.headers() });
  };
}
