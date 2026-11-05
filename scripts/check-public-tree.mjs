import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const privatePath = /(?:^|\/)(?:data(?:-[^/]*)?|runtime|browser-profile[^/]*|node_modules|\.publish-tools|\.tools)(?:\/|$)|(?:^|\/)(?:config\.json|config\.local[^/]*\.json|\.env(?:\..*)?|hosts\.yml|master\.key|webhook[^/]*|ACCEPTANCE\.md|state\.json|activity\.jsonl)$|\.secret\.json$|(?:^|\/)extension\/config\.js$|\.(?:log|jsonl|png|jpe?g|webp|mp4|zip)$/i;
const rules = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{24,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
  ['webhook-credential', /https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]{24,}/g],
  ['literal-user-token', /["'](?:access_token|refresh_token|steamLoginSecure)["']\s*:\s*["'][A-Za-z0-9_.%-]{24,}["']/g],
  ['machine-path', /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\/(?:Users|home)\/[^/\s]+\//g]
];
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export function inspectPublicText(file, text) {
  const name = file.replaceAll('\\', '/'); const findings = [];
  if (privatePath.test(name)) findings.push({ file: name, line: 1, rule: 'private-runtime-file' });
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) findings.push({ file: name, line: lineOf(text, match.index), rule });
  }
  // Public upstream licenses keep their original attribution. Other files use reserved examples only.
  if (!/(?:^|\/)(?:LICENSE|COPYING)(?:\.[^/]*)?$/i.test(name)) {
    for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/gi)) {
      if (!/@(?:example\.(?:com|org|net)|users\.noreply\.github\.com|noreply\.github\.com)$/i.test(match[0]))
        findings.push({ file: name, line: lineOf(text, match.index), rule: 'personal-email' });
    }
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const ip = match[0]; const octets = ip.split('.').map(Number);
    if (octets.some(n => n > 255)) continue;
    if (ip === '127.0.0.1' || ip === '0.0.0.0' || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip)) continue;
    findings.push({ file: name, line: lineOf(text, match.index), rule: 'non-example-ip' });
  }
  return findings;
}

export async function checkPublicTree(root = process.cwd()) {
  const output = execFileSync('git', ['-c', 'core.excludesfile=', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  const files = [...new Set(output.split('\0').filter(Boolean))];
  if (!files.length) throw new Error('No Git-visible files found; initialize the clean repository first.');
  const findings = [];
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    if (bytes.includes(0)) { findings.push({ file, line: 1, rule: 'binary-file' }); continue; }
    findings.push(...inspectPublicText(file, bytes.toString('utf8')));
  }
  let commits = [];
  try { commits = execFileSync('git', ['rev-list', '--all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean); } catch {}
  for (const commit of commits) {
    const emails = execFileSync('git', ['show', '-s', '--format=%ae%n%ce', commit], { cwd: root, encoding: 'utf8' }).trim().split('\n');
    if (emails.some(email => !/(?:@users\.noreply\.github\.com|^noreply@github\.com)$/i.test(email)))
      findings.push({ file: `commit:${commit.slice(0, 12)}`, line: 1, rule: 'non-private-commit-email' });
  }
  return { files: files.length, commits: commits.length, findings };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await checkPublicTree();
    for (const item of result.findings) console.error(`${item.file}:${item.line} [${item.rule}]`);
    if (result.findings.length) { console.error(`Privacy check failed: ${result.findings.length} finding(s). Values are intentionally not printed.`); process.exitCode = 1; }
    else console.log(`Privacy check passed: ${result.files} source files and ${result.commits} commit(s).`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
