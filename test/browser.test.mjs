import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { driveEpicPage } from '../src/epic.mjs';

const channel = process.platform === 'win32' ? 'msedge' : undefined;
test('Epic browser flow completes a zero-price checkout exactly once, without trusting script strings', async () => {
  const browser = await chromium.launch({ channel, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<script>window.dictionary={success:'Thanks for your order'};window.clicks=0</script>
      <button data-testid="purchase-cta-button" onclick="document.getElementById('checkout').hidden=false">Get</button>
      <div id="checkout" hidden><p>Total $0.00</p><button onclick="window.clicks++;document.body.innerHTML='<p>Thanks for your order</p>'">Place Order</button></div>`);
    await driveEpicPage(page, 8000);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally { await browser.close(); }
});
test('Epic browser flow never clicks Place Order for a nonzero total', async () => {
  const browser = await chromium.launch({ channel, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<script>window.clicks=0</script><p>Total $5.00</p><button onclick="window.clicks++">Place Order</button>`);
    await assert.rejects(driveEpicPage(page, 3000), /PRICE_UNCONFIRMED/);
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});
test('Epic browser flow reports a visible captcha and makes no order click', async () => {
  const browser = await chromium.launch({ channel, headless: true });
  try {
    const page = await browser.newPage(); await page.route('**/*', r => r.fulfill({ body: '' }));
    await page.setContent(`<iframe src="https://hcaptcha.com/challenge" width="300" height="200"></iframe><button>Place Order</button>`);
    await assert.rejects(driveEpicPage(page, 3000), /CAPTCHA/);
  } finally { await browser.close(); }
});
