import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEpicLogin, openEpicInDefaultBrowser } from '../src/native-auth.mjs';
import { parseEpicAuthorizationCode, epicAuthorizationUrl } from '../src/epic.mjs';
import { redact } from '../src/storage.mjs';
import { EventEmitter } from 'node:events';

test('native Epic handoff opens only once for double-clicks and repeated polls', async () => {
  let opens = 0; let now = 1000;
  const login = new NativeEpicLogin(async () => { opens++; }, () => now);
  await Promise.all([login.start(), login.start(), login.start()]);
  assert.equal(opens, 1);
  assert.equal((await login.start()).alreadyOpened, true); assert.equal(opens, 1);
  now += 61_000;
  await login.start(); assert.equal(opens, 2);
});
test('failed native handoff can be retried rather than leaving an unusable busy flag', async () => {
  let attempts = 0;
  const login = new NativeEpicLogin(async () => { if (++attempts === 1) throw new Error('OS handoff failed'); });
  await assert.rejects(login.start(), /handoff failed/);
  assert.equal((await login.start()).opened, true); assert.equal(attempts, 2);
});
test('native handoff sends a fixed Epic URL to the OS without Playwright or shell interpolation', async () => {
  let command;
  await openEpicInDefaultBrowser((exe, args, options) => {
    command = { exe, args, options }; const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  assert.equal(command.options.stdio, 'ignore'); assert.notEqual(command.options.shell, true);
  assert.equal(command.args.at(-1), epicAuthorizationUrl());
  assert.equal(new URL(command.args.at(-1)).hostname, 'www.epicgames.com');
});
test('Epic authorization input accepts code, redirect URL and full JSON while excluding arbitrary URLs', () => {
  const code = 'authorization_code_for_test_123';
  assert.equal(parseEpicAuthorizationCode(code), code);
  assert.equal(parseEpicAuthorizationCode(JSON.stringify({ authorizationCode: code })), code);
  assert.equal(parseEpicAuthorizationCode('https://www.epicgames.com/id/api/redirect?code=' + code), code);
  for (const invalid of ['', '{broken', '{"access_token":"test_token"}', 'https://evil.example/?code='+code, 'https://www.epicgames.com/other?code='+code])
    assert.throws(() => parseEpicAuthorizationCode(invalid));
});
test('authorization code fields are redacted from accidental error text', () => {
  const text = redact('{"authorizationCode":"sensitive_one_time_code"}');
  assert.ok(!text.includes('sensitive_one_time_code'));
});
