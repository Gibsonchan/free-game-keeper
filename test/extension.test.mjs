import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { parseBridgeReport, BrowserBridge } from '../src/bridge.mjs';
import { processOffer } from '../src/engine.mjs';

test('Chrome connector reports success only after the zero-total order flow, not script-localized text', async () => {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<script>window.dictionary='Thanks for your order';window.orders=0</script><button data-testid="purchase-cta-button" onclick="document.getElementById('order').hidden=false">Get</button><div id="order" hidden><p>Total $0.00</p><button onclick="window.orders++;document.body.innerHTML='<p>Thanks for your order</p>'">Place Order</button></div>`);
    await page.addScriptTag({ path: fileURLToPath(new URL('../extension/claim.js', import.meta.url)) });
    const clicked = [];
    let result = await page.evaluate(c => window.FGK_EPIC_STEP(c), clicked); assert.equal(result.clicked, 'get'); clicked.push('get');
    result = await page.evaluate(c => window.FGK_EPIC_STEP(c), clicked); assert.equal(result.clicked, 'Place Order'); clicked.push('Place Order');
    result = await page.evaluate(c => window.FGK_EPIC_STEP(c), clicked); assert.equal(result.result, 'claimed');
    assert.equal(await page.evaluate(() => window.orders), 1);
    await page.setContent('<p>Total $9.99</p><button onclick="window.orders++">Place Order</button>');
    result = await page.evaluate(c => window.FGK_EPIC_STEP(c), []); assert.equal(result.result, 'price_unconfirmed');
    await page.setContent('<p>One more step. Verify you are human</p><button>Place Order</button>');
    result = await page.evaluate(c => window.FGK_EPIC_STEP(c), []); assert.equal(result.result, 'captcha');
  } finally { await browser.close(); }
});
test('waiting for Chrome never claims success or resubmits an order; inventory proof resumes exactly one notification', async () => {
  const state = { games: {}, outbox: [], alerts: {} }; const offer = { store: 'epic', id: 'offer', title: 'Test', url: 'https://store.epicgames.com/p/test' };
  let claims = 0; let owns = false; const adapter = { owned: async () => owns, claim: async () => { claims++; return 'pending_browser'; } };
  const save = async () => {};
  await processOffer(state, 'account', offer, adapter, save); await processOffer(state, 'account', offer, adapter, save);
  assert.equal(claims, 1); assert.equal(state.outbox.length, 0);
  owns = true; await processOffer(state, 'account', offer, adapter, save); await processOffer(state, 'account', offer, adapter, save);
  assert.equal(state.outbox.length, 1); assert.equal(state.games['epic:account:offer'].status, 'claimed');
});
test('amountless Add to library requires a recent backend price proof and the task Get click', async () => {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="dialog"><p>Add this game to your library</p><button onclick="window.orders=(window.orders||0)+1">Add to library</button></div>');
    await page.addScriptTag({ path: fileURLToPath(new URL('../extension/claim.js', import.meta.url)) });
    const proof = { zeroPriceVerified: true, priceVerifiedAt: Date.now() };
    let result = await page.evaluate(() => window.FGK_EPIC_STEP(['get'])); assert.equal(result.result, 'price_unconfirmed');
    result = await page.evaluate(p => window.FGK_EPIC_STEP([], p), proof); assert.equal(result.result, 'price_unconfirmed');
    result = await page.evaluate(p => window.FGK_EPIC_STEP(['get'], { ...p, priceVerifiedAt: Date.now()-121000 }), proof); assert.equal(result.result, 'price_unconfirmed');
    result = await page.evaluate(p => window.FGK_EPIC_STEP(['get'], p), proof); assert.equal(result.clicked, 'Add to library');
    assert.equal(await page.evaluate(() => window.orders), 1);
    await page.setContent('<div role="dialog"><p>Price $9.99</p><button>Add to library</button></div>');
    result = await page.evaluate(p => window.FGK_EPIC_STEP(['get'], p), proof); assert.equal(result.result, 'price_unconfirmed');
    await page.setContent('<div role="dialog"><p>Total 0.99</p><button>Add to library</button></div>');
    result = await page.evaluate(p => window.FGK_EPIC_STEP(['get'], p), proof); assert.equal(result.result, 'price_unconfirmed');
    await page.setContent('<div role="dialog"><button>Place Order</button></div>');
    result = await page.evaluate(p => window.FGK_EPIC_STEP(['get'], p), proof); assert.equal(result.result, 'price_unconfirmed');
  } finally { await browser.close(); }
});
test('Total Free is accepted while prose and unrelated game prices cannot establish a zero checkout', async () => {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<p>A total of 50 monsters.</p><div role="dialog"><p>Total Free</p><button>Place Order</button></div>');
    await page.addScriptTag({ path: fileURLToPath(new URL('../extension/claim.js', import.meta.url)) });
    let result = await page.evaluate(() => window.FGK_EPIC_STEP(['get'])); assert.equal(result.clicked, 'Place Order');
    await page.setContent('<p>Total $0.00</p><div role="dialog"><p>Total $7.99</p><button>Place Order</button></div>');
    result = await page.evaluate(() => window.FGK_EPIC_STEP(['get'])); assert.equal(result.result, 'price_unconfirmed');
  } finally { await browser.close(); }
});
test('extension reports cannot supply arbitrary destinations or unsupported outcomes', () => {
  assert.deepEqual(parseBridgeReport({ key: 'epic:account:offer', result: 'claimed', url: 'https://evil.example/' }), { key: 'epic:account:offer', result: 'claimed' });
  assert.throws(() => parseBridgeReport({ key: '../secret', result: 'claimed' }));
  assert.throws(() => parseBridgeReport({ key: 'epic:test', result: 'force_success' }));
});
test('bridge refuses missing or wrong pairing tokens', () => {
  const bridge = new BrowserBridge(18769); bridge.token = 'test_pairing_token';
  assert.equal(bridge.authorized({ headers: {} }), false);
  assert.equal(bridge.authorized({ headers: { authorization: 'Bearer wrong_pairing_key' } }), false);
  assert.equal(bridge.authorized({ headers: { authorization: 'Bearer test_pairing_token' } }), true);
});
