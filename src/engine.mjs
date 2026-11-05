import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA, getConfig } from './config.mjs';
import { atomicJson, readJson, log, redact, userError, withLock, sleep } from './storage.mjs';
import { sendWecom, claimText } from './notify.mjs';
import { epicSession, discoverEpic, epicEntitlements, epicOwned, epicQuickClaim, epicBrowserClaim, verifyEpic } from './epic.mjs';
import { withSteam, steamOffers, steamClaim, verifySteam } from './steam.mjs';

const STATE_FILE = path.join(DATA, 'state.json');
const initialState = { version: 1, games: {}, outbox: [], alerts: {}, lastRun: null };
export const loadState = () => readJson(STATE_FILE, initialState);
export const saveState = state => atomicJson(STATE_FILE, state);
export function identity(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 16); }
function enqueue(state, key, text) {
  if (!state.outbox.some(e => e.key === key)) state.outbox.push({ id: randomUUID(), key, text, attempts: 0, createdAt: new Date().toISOString(), nextTry: 0 });
}
function enqueueClaim(state, key, offer) { enqueue(state, `claimed:${key}`, claimText(offer)); }
export function alertOnce(state, key, text, now = Date.now()) {
  // Stable error-category key prevents an expiring timestamp or changing URL from spamming the robot.
  if (now - (state.alerts[key] || 0) < 24 * 3600_000) return;
  enqueue(state, `alert:${key}:${Math.floor(now / 86400_000)}`, `免费游戏领取异常\n${redact(text).slice(0, 900)}\n程序会继续重试；该异常每天最多提醒一次。`);
  state.alerts[key] = now;
}
export async function drainOutbox(state, send = sendWecom, persist = saveState, now = Date.now()) {
  let delivered = 0;
  // Batch size prevents a recovered service from exceeding WeCom's per-minute rate limit.
  for (const event of state.outbox.filter(e => !e.deliveredAt && e.nextTry <= now).slice(0, 10)) {
    try {
      await send(event.text);
      event.deliveredAt = new Date(now).toISOString(); delivered++;
    } catch (e) {
      event.attempts++;
      event.nextTry = now + Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(event.attempts, 9));
      event.lastError = redact(e.message);
    }
    await persist(state);
  }
  // Keep delivery evidence for 90 days. Game ledger stays persistent.
  state.outbox = state.outbox.filter(e => !e.deliveredAt || Date.parse(e.deliveredAt) > now - 90 * 86400_000);
  return delivered;
}
export async function processOffer(state, account, offer, adapter, persist = saveState) {
  const key = `${offer.store}:${account}:${offer.id}`;
  const previous = state.games[key];
  if (await adapter.owned(offer)) {
    // If the process died after ordering but before saving success, resume from inventory proof.
    const recovered = ['claiming', 'unverified', 'pending_browser', 'blocked_browser'].includes(previous?.status);
    state.games[key] = { ...previous, offer, status: recovered || previous?.status === 'claimed' ? 'claimed' : 'owned', updatedAt: new Date().toISOString() };
    delete state.games[key].lastError;
    if (recovered) enqueueClaim(state, key, offer);
    await persist(state); return recovered ? 'claimed' : 'owned';
  }
  if (['pending_browser', 'blocked_browser'].includes(previous?.status)) return 'pending_browser';
  state.games[key] = { ...previous, offer, status: 'claiming', attempts: (previous?.attempts || 0) + 1, updatedAt: new Date().toISOString() };
  await persist(state);
  try {
    const result = await adapter.claim(offer);
    if (result === 'needs_base' || result === 'skipped' || result === 'pending_browser') {
      state.games[key].status = result; delete state.games[key].lastError; await persist(state); return result;
    }
    if (!await adapter.verify(offer)) throw new Error('UNVERIFIED: 尚未核实账号实际拥有游戏');
    state.games[key] = { ...state.games[key], status: result === 'owned' ? 'owned' : 'claimed', updatedAt: new Date().toISOString() };
    delete state.games[key].lastError;
    if (result !== 'owned') enqueueClaim(state, key, offer);
    // Persist success and its queued notification in the SAME atomic state write.
    await persist(state); return result === 'owned' ? 'owned' : 'claimed';
  } catch (e) {
    state.games[key] = { ...state.games[key], status: 'unverified', lastError: redact(e.message), updatedAt: new Date().toISOString() };
    const category = String(e.message).split(':')[0].replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'claim';
    alertOnce(state, `${offer.store}:${category}`, `${offer.store.toUpperCase()}：${offer.title}\n${e.message}`);
    await persist(state); return 'failed';
  }
}
export async function runCycle({ dryRun = false } = {}) {
  return withLock('cycle', async () => {
    const config = await getConfig(); const state = await loadState();
    const summary = { startedAt: new Date().toISOString(), dryRun, found: 0, claimed: 0, owned: 0, failed: 0, skipped: 0, pending: 0, stores: {} };
    const handle = async (account, offers, adapter) => {
      summary.found += offers.length;
      for (const offer of offers) {
        if (dryRun) continue;
        const result = await processOffer(state, account, offer, adapter);
        if (result === 'claimed') summary.claimed++; else if (result === 'owned') summary.owned++;
        else if (result === 'failed') summary.failed++; else if (result === 'pending_browser') summary.pending++; else summary.skipped++;
        await sleep(750);
      }
    };
    for (const store of config.enabledStores) {
      try {
        if (store === 'epic') {
          const session = await epicSession();
          const offers = (await discoverEpic(session.country)).filter(o => config.includeDlc || !['ADD_ON', 'DLC'].includes(o.kind));
          summary.stores.epic = { connected: true, country: session.country, found: offers.length, titles: offers.map(o => o.title) };
          let entitlements = await epicEntitlements(session);
          await handle(identity(session.account_id), offers, {
            owned: offer => epicOwned(offer, entitlements),
            claim: async offer => {
              let apiError;
              try { if (await epicQuickClaim(session, offer)) return 'claimed'; }
              catch (e) { apiError = e; if (e.status === 429 || /^NOT_FREE/.test(e.message)) throw e; }
              // Even a request timeout can have created the order. Verify before a second method.
              if (await verifyEpic(session, offer, 1)) return 'claimed';
              if (config.epicWebMode === 'extension') return 'pending_browser';
              try { await epicBrowserClaim(offer, session.country, session); }
              catch (e) {
                if (!await verifyEpic(session, offer, 2)) throw new Error(`${e.message}${apiError ? `；接口：${apiError.message}` : ''}`);
              }
              return 'claimed';
            },
            verify: async offer => { const ok = await verifyEpic(session, offer); entitlements = await epicEntitlements(session); return ok; }
          });
        } else {
          await withSteam(async (client, session) => {
            const offers = await steamOffers(client, session.country, config.includeDlc);
            summary.stores.steam = { connected: true, country: session.country, found: offers.length, titles: offers.map(o => o.title) };
            let owned = await client.owned();
            await handle(identity(session.accountKey), offers, {
              owned: offer => owned.packages.has(offer.subid),
              claim: offer => steamClaim(client, session, offer),
              verify: async offer => { const ok = await verifySteam(client, offer); owned = await client.owned(); return ok; }
            });
          });
        }
      } catch (e) {
        summary.failed++; summary.stores[store] = { error: userError(e.message) };
        if (!dryRun) alertOnce(state, `${store}:${e.message.startsWith('AUTH_REQUIRED') ? 'auth' : 'store'}`, `${store.toUpperCase()}：${e.message}`);
        await log('store_error', { store, message: e.message });
      }
    }
    summary.finishedAt = new Date().toISOString();
    if (!dryRun) {
      state.lastRun = summary; await saveState(state);
      await drainOutbox(state); await saveState(state);
    }
    await log(dryRun ? 'detect_finished' : 'cycle_finished', summary);
    return summary;
  });
}
