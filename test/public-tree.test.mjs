import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicText } from '../scripts/check-public-tree.mjs';

test('publication guard rejects private runtime files even when their content is encrypted', () => {
  for (const file of ['data/epic-extension/config.js', 'config.json', 'auth.secret.json', 'ACCEPTANCE.md', 'extension/config.js', 'runtime/state.json'])
    assert.ok(inspectPublicText(file, '{}').some(f => f.rule === 'private-runtime-file'));
});
test('publication guard detects credentials without returning their values', () => {
  const token = ['gh', 'p_'].join('') + 'a'.repeat(40);
  const findings = inspectPublicText('src/example.mjs', token);
  assert.ok(findings.some(f => f.rule === 'github-token'));
  assert.ok(!JSON.stringify(findings).includes(token));
  const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  assert.ok(inspectPublicText('key.txt', key).some(f => f.rule === 'private-key'));
});
test('publication guard rejects personal paths and emails while preserving neutral examples', () => {
  const absolute = 'Q' + ':' + String.fromCharCode(92) + ['Users', 'SamplePerson', 'work'].join(String.fromCharCode(92));
  const email = ['sample.person', 'mail.invalid'].join('@');
  assert.ok(inspectPublicText('README.md', absolute).some(f => f.rule === 'machine-path'));
  assert.ok(inspectPublicText('README.md', email).some(f => f.rule === 'personal-email'));
  assert.deepEqual(inspectPublicText('README.md', 'http://127.0.0.1:18769/ contributors@users.noreply.github.com'), []);
});
