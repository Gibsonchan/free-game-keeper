import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFetch } from '../src/browser.mjs';
import { redact, userError } from '../src/storage.mjs';
import { epicWebLoginUrl } from '../src/epic.mjs';

test('read requests enable reset recovery while license activation posts cannot be retried automatically', async () => {
  const calls = [];
  const context = { request: { fetch: async (_, options) => {
    calls.push(options); return { body: async () => Buffer.from('{}'), status: () => 200, headers: () => ({}) };
  } } };
  const fetchImpl = requestFetch(context);
  await fetchImpl('https://store.steampowered.com/');
  await fetchImpl('https://store.steampowered.com/freelicense/addfreelicense/123', { method: 'POST', body: new URLSearchParams({ sessionid: 'test' }) });
  assert.equal(calls[0].maxRetries, 2); assert.equal(calls[1].maxRetries, 0);
});
test('request errors cannot expose Cookie, Authorization or Set-Cookie headers in logs', async () => {
  const message = 'apiRequestContext.fetch: read ECONNRESET\nCall log:\n - cookie: secret_cookie=private_cookie\n - authorization: Bearer private_token';
  const context = { request: { fetch: async () => { throw new Error(message); } } };
  await assert.rejects(requestFetch(context)('https://store.steampowered.com/'), error => {
    assert.match(error.message, /ECONNRESET/); assert.ok(!error.message.includes('private_cookie')); assert.ok(!error.message.includes('private_token')); return true;
  });
  assert.ok(!redact('Set-Cookie: sensitive=value\nAuthorization: Bearer secret').includes('sensitive=value'));
});
test('network errors show a readable retry status while exchange codes are redacted', () => {
  assert.match(userError('apiRequestContext.fetch: read ECONNRESET'), /自动重试/);
  assert.ok(!redact('https://www.epicgames.com/id/exchange?exchangeCode=test_private_exchange').includes('test_private_exchange'));
});
test('web session exchange is limited to Epic store destinations and its credential is redacted', () => {
  const url = epicWebLoginUrl('test_private_exchange_code', 'https://store.epicgames.com/en-US/p/test');
  assert.equal(new URL(url).hostname, 'www.epicgames.com');
  assert.equal(new URL(new URL(url).searchParams.get('redirectUrl')).hostname, 'store.epicgames.com');
  assert.ok(!redact(url).includes('test_private_exchange_code'));
  assert.throws(() => epicWebLoginUrl('test_private_exchange_code', 'https://evil.example/'));
});
