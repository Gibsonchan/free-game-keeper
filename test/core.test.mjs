import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpicOffers, epicOwned, zeroCheckoutTotal } from '../src/epic.mjs';
import { parseAppDetails } from '../vendor/freekeep/steam.mjs';
import { processOffer, drainOutbox, alertOnce } from '../src/engine.mjs';
import { validateWebhook, sendWecom } from '../src/notify.mjs';
import { redact, userError } from '../src/storage.mjs';

const now = Date.parse('2026-11-05T12:00:00Z');
const promo = { startDate: '2026-11-04T00:00:00Z', endDate: '2026-11-06T00:00:00Z', discountSetting: { discountPercentage: 0 } };
function feed(overrides = {}) { return { data: { Catalog: { searchStore: { elements: [{ id: 'offer', namespace: 'ns', title: 'Test Game',
  productSlug: 'test-game/home', price: { totalPrice: { discountPrice: 0, originalPrice: 1000 } }, items: [{ id: 'item1' }, { id: 'item2' }],
  promotions: { promotionalOffers: [{ promotionalOffers: [promo] }] }, ...overrides }] } } } }; }
const offer = { store: 'epic', id: 'ns:offer', namespace: 'ns', offerId: 'offer', itemIds: ['item1', 'item2'], title: '测试游戏', url: 'https://store.epicgames.com/p/test' };
const state = () => ({ games: {}, outbox: [], alerts: {} });
const persist = async () => {};

test('Epic only accepts active zero-priced promotions and normalizes legacy slugs', () => {
  const offers = parseEpicOffers(feed(), now); assert.equal(offers.length, 1); assert.match(offers[0].url, /\/p\/test-game\?/);
  assert.equal(parseEpicOffers(feed({ price: { totalPrice: { discountPrice: 1, originalPrice: 1000 } } }), now).length, 0);
  assert.equal(parseEpicOffers(feed({ price: { totalPrice: { discountPrice: 0, originalPrice: 0 } } }), now).length, 0);
  assert.equal(parseEpicOffers(feed(), now + 3 * 86400_000).length, 0);
});
test('a live promotion still filed under upcoming is included, future ones are excluded', () => {
  const data = feed({ promotions: { upcomingPromotionalOffers: [{ promotionalOffers: [promo] }] } });
  assert.equal(parseEpicOffers(data, now).length, 1);
  assert.equal(parseEpicOffers(data, now - 3 * 86400_000).length, 0);
});
test('an unexpected feed shape fails rather than pretending nothing is free', () => assert.throws(() => parseEpicOffers({}), /格式/));
test('bundle ownership requires all active, non-expired items in the correct namespace', () => {
  const e1 = { namespace: 'ns', catalogItemId: 'item1', status: 'ACTIVE' }; const e2 = { ...e1, catalogItemId: 'item2' };
  assert.equal(epicOwned(offer, [e1]), false); assert.equal(epicOwned(offer, [e1, e2]), true);
  assert.equal(epicOwned(offer, [e1, { ...e2, status: 'REVOKED' }]), false);
  assert.equal(epicOwned(offer, [e1, { ...e2, namespace: 'wrong' }]), false);
  assert.equal(epicOwned(offer, [e1, { ...e2, endDate: '2000-01-01' }]), false);
});
test('checkout total must be explicitly zero; paid or ambiguous totals cannot pass', () => {
  assert.equal(zeroCheckoutTotal('Subtotal $25.00\nDiscount -$25.00\nTotal\n$0.00'), true);
  assert.equal(zeroCheckoutTotal('Total HK$10.00'), false);
  assert.equal(zeroCheckoutTotal('Total $9.99'), false);
  assert.equal(zeroCheckoutTotal('Free game - order now'), false);
  assert.equal(zeroCheckoutTotal('Total $0.00\nTotal $1.00'), false);
});
test('Steam excludes trials, free-to-play and paid packages', () => {
  const free = { packageid: 10, is_free_license: true, price_in_cents_with_discount: 0, option_text: 'Limited Free Promotional Package' };
  const details = subs => ({ 42: { success: true, data: { name: 'Game', type: 'game', package_groups: [{ subs }] } } });
  assert.equal(parseAppDetails(42, details([free])).length, 1);
  for (const sub of [{ ...free, option_text: 'Free Weekend' }, { ...free, option_text: 'Free to Play' }, { ...free, price_in_cents_with_discount: 1 }, { ...free, is_free_license: false }])
    assert.equal(parseAppDetails(42, details([sub])).length, 0);
});
test('HTTP/order success without inventory proof never emits a success notification', async () => {
  const s = state(); const result = await processOffer(s, 'account', offer, { owned: async () => false, claim: async () => 'claimed', verify: async () => false }, persist);
  assert.equal(result, 'failed'); assert.equal(s.games['epic:account:ns:offer'].status, 'unverified');
  assert.equal(s.outbox.some(e => e.key.startsWith('claimed:')), false);
});
test('already-owned games do not get reported as newly claimed', async () => {
  const s = state(); const result = await processOffer(s, 'account', offer, { owned: async () => true }, persist);
  assert.equal(result, 'owned'); assert.equal(s.outbox.length, 0);
});
test('successful claims and queued notifications persist together and do not repeat', async () => {
  const s = state(); const snapshots = []; const save = async s => snapshots.push(structuredClone(s)); let owns = false;
  const adapter = { owned: async () => owns, claim: async () => { owns = true; return 'claimed'; }, verify: async () => owns };
  assert.equal(await processOffer(s, 'account', offer, adapter, save), 'claimed');
  assert.equal(snapshots.at(-1).outbox.length, 1); assert.equal(snapshots.at(-1).games['epic:account:ns:offer'].status, 'claimed');
  await processOffer(s, 'account', offer, adapter, save); assert.equal(s.outbox.length, 1);
});
test('a crash after claiming is recovered using inventory and queues the missing notification once', async () => {
  const s = state(); s.games['epic:account:ns:offer'] = { status: 'claiming', offer };
  const adapter = { owned: async () => true };
  assert.equal(await processOffer(s, 'account', offer, adapter, persist), 'claimed');
  await processOffer(s, 'account', offer, adapter, persist); assert.equal(s.outbox.length, 1);
});
test('separate accounts have separate claim records', async () => {
  const s = state(); const adapter = { owned: async () => false, claim: async () => 'claimed', verify: async () => true };
  await processOffer(s, 'account1', offer, adapter, persist); await processOffer(s, 'account2', offer, adapter, persist);
  assert.equal(Object.keys(s.games).length, 2); assert.equal(s.outbox.length, 2);
});
test('robot failure remains queued across a restart and succeeds on a later retry', async () => {
  const s = state(); s.outbox.push({ id: '1', key: 'claim1', text: 'Test', attempts: 0, nextTry: 0 });
  await drainOutbox(s, async () => { throw Error('Temporary network failure'); }, persist, now);
  assert.equal(s.outbox[0].attempts, 1); assert.equal(s.outbox[0].deliveredAt, undefined);
  const restarted = JSON.parse(JSON.stringify(s)); let sent = 0;
  await drainOutbox(restarted, async () => { sent++; }, persist, now + 3600_000);
  await drainOutbox(restarted, async () => { sent++; }, persist, now + 3600_000);
  assert.equal(sent, 1); assert.ok(restarted.outbox[0].deliveredAt);
});
test('repeated store errors are limited to one notification per day', () => {
  const s = state(); alertOnce(s, 'epic:captcha', 'blocked', now); alertOnce(s, 'epic:captcha', 'blocked again', now + 3600_000);
  assert.equal(s.outbox.length, 1); alertOnce(s, 'epic:captcha', 'still blocked', now + 25 * 3600_000); assert.equal(s.outbox.length, 2);
});
test('WeCom HTTP 200 with nonzero errcode is a delivery failure', async () => {
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit_test_key_123456';
  await assert.rejects(sendWecom('测试', async () => new Response('{"errcode":93000}'), url), /93000/);
});
test('WeCom text is chunked by UTF-8 bytes rather than UTF-16 length', async () => {
  const payloads = [];
  await sendWecom('游'.repeat(1500), async (_, options) => { payloads.push(JSON.parse(options.body).text.content); return new Response('{"errcode":0}'); },
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit_test_key_123456');
  assert.ok(payloads.length > 1); assert.equal(payloads.join(''), '游'.repeat(1500));
  assert.ok(payloads.every(p => Buffer.byteLength(p) <= 1900));
});
test('webhook validation blocks arbitrary hosts, redirects and userinfo tricks', () => {
  for (const url of ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijklm', 'https://qyapi.weixin.qq.com.evil.com/cgi-bin/webhook/send?key=abcdefghijklm',
    ['https://user','qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijklm'].join('@'), 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijklm&redirect=evil'])
    assert.throws(() => validateWebhook(url));
});
test('logs remove webhook keys and auth codes', () => {
  const message = redact('failure https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=top_secret_key https://epicgames.com/id?code=top_secret_code');
  assert.ok(!message.includes('top_secret_key')); assert.ok(!message.includes('top_secret_code'));
});
test('browser network failures show a concise message instead of a raw Playwright stack', () => {
  const message = userError('page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://www.epicgames.com/id/login\nCall log:\nprivate details');
  assert.match(message, /网络访问/); assert.ok(!message.includes('Call log')); assert.ok(!message.includes('https://'));
});
