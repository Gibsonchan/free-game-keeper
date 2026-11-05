import { getConfig } from './config.mjs';
import { loadState, saveState, runCycle, drainOutbox } from './engine.mjs';
import { withLock, sleep, log } from './storage.mjs';

// Headless Linux/container entry point; credentials must already be provisioned in its data volume.
export async function worker() {
  return withLock('service', async () => {
    let stopping = false;
    process.on('SIGTERM', () => { stopping = true; }); process.on('SIGINT', () => { stopping = true; });
    while (!stopping) {
      const c = await getConfig(); const state = await loadState(); const last = state.lastRun;
      const due = !last || Date.now() >= Date.parse(last.finishedAt) + (last.failed ? c.retryMinutes * 60_000 : c.intervalHours * 3600_000);
      if (due) {
        try { await runCycle(); } catch (e) { await log('worker_error', { message: e.message }); }
      } else {
        try { await withLock('cycle', async () => { const pending = await loadState(); await drainOutbox(pending); await saveState(pending); }); }
        catch (e) { await log('worker_notify_error', { message: e.message }); }
      }
      await sleep(30_000);
    }
  });
}
