import { spawn } from 'node:child_process';
import { epicAuthorizationUrl, epicAccountReviewUrl } from './epic.mjs';

// OS default-browser handoff. No automated browser, user-agent overrides or challenge interaction.
export async function openEpicInDefaultBrowser(spawnImpl = spawn) {
  return handoffToBrowser(epicAuthorizationUrl(), spawnImpl);
}
export async function openEpicAccountReviewInDefaultBrowser(spawnImpl = spawn) {
  return handoffToBrowser(epicAccountReviewUrl(), spawnImpl);
}
async function handoffToBrowser(url, spawnImpl) {
  const executable = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export class NativeEpicLogin {
  constructor(openBrowser = openEpicInDefaultBrowser, now = Date.now) {
    this.openBrowser = openBrowser; this.now = now; this.openedAt = null; this.opening = null;
  }
  async start() {
    if (this.opening) return this.opening;
    if (this.openedAt !== null && this.now() - this.openedAt < 60_000) return { opened: false, alreadyOpened: true };
    this.opening = Promise.resolve().then(() => this.openBrowser()).then(() => {
      this.openedAt = this.now(); return { opened: true };
    }).finally(() => { this.opening = null; });
    return this.opening;
  }
}
