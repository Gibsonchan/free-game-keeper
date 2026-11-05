import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpicAuthorizationCode, epicAccountReviewUrl } from '../src/epic.mjs';
import { openEpicAccountReviewInDefaultBrowser } from '../src/native-auth.mjs';
import { redact } from '../src/storage.mjs';
import { EventEmitter } from 'node:events';

function corrective(action = 'PRIVACY_POLICY_ACCEPTANCE') {
  return JSON.stringify({ errorCode: 'errors.com.epicgames.oauth.corrective_action_required',
    metadata: { correctiveAction: action, continuation: 'test_sensitive_continuation' } });
}
test('privacy-policy requirement is not mistaken for an authorization code and carries a safe action hint', () => {
  assert.throws(() => parseEpicAuthorizationCode(corrective()), error => {
    assert.equal(error.accountAction, 'privacy_policy'); assert.match(error.message, /隐私政策/);
    assert.ok(!error.message.includes('test_sensitive_continuation')); return true;
  });
});
test('other corrective actions use generic account review without accepting anything', () => {
  assert.throws(() => parseEpicAuthorizationCode(corrective('UNKNOWN_ACTION')), error => error.accountAction === 'account_review');
});
test('an Epic error JSON cannot override the action by including an authorizationCode field', () => {
  assert.throws(() => parseEpicAuthorizationCode(JSON.stringify({ errorCode: 'errors.test', authorizationCode: 'fake_code_for_test' })), /登录错误/);
});
test('the review link uses the official store login and never includes a continuation or acceptance request', async () => {
  const url = new URL(epicAccountReviewUrl());
  assert.equal(url.hostname, 'www.epicgames.com'); assert.equal(url.pathname, '/id/login');
  assert.equal(new URL(url.searchParams.get('redirectUrl')).hostname, 'store.epicgames.com');
  assert.ok(!url.href.includes('continuation')); assert.ok(!url.href.includes('/accept'));
  let args;
  await openEpicAccountReviewInDefaultBrowser((exe, passedArgs) => {
    args = passedArgs; const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  assert.equal(args.at(-1), epicAccountReviewUrl());
});
test('continuation credentials are removed from logs', () => {
  assert.ok(!redact(corrective()).includes('test_sensitive_continuation'));
});
