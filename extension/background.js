importScripts('config.js');
let busy = false;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function api(route, payload) {
  const response = await fetch(FGK_CONFIG.base + '/api/bridge/' + route, {
    method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + FGK_CONFIG.token, 'Content-Type': 'application/json', 'X-FGK-Version': chrome.runtime.getManifest().version },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(35000)
  });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '连接本机助手失败'); return data;
}
async function reportPending() {
  const { pendingReport } = await chrome.storage.local.get('pendingReport');
  if (pendingReport) { const result = await api('report', pendingReport); await chrome.storage.local.remove('pendingReport'); return result; }
}
async function poll() {
  if (busy) return;
  busy = true;
  try {
    await reportPending();
    const { job } = await api('next'); if (!job) return;
    const url = new URL(job.offer.url);
    if (url.protocol !== 'https:' || url.hostname !== 'store.epicgames.com' || Date.parse(job.offer.end) <= Date.now()) return;
    const tab = await chrome.tabs.create({ url: url.href, active: false });
    let result = 'timeout'; const clicked = []; const deadline = Date.now() + 100000;
    try {
      while (Date.now() < deadline) {
        const info = await chrome.tabs.get(tab.id);
        if (info.status !== 'complete') { await pause(800); continue; }
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['claim.js'] });
        const actions = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: runStep, args: [clicked, job.offer] });
        const state = actions[0]?.result;
        if (state?.clicked) { clicked.push(state.clicked); await pause(1200); }
        if (state?.result) { result = state.result; break; }
        await pause(700);
      }
    } catch { result = 'failed'; }
    // Persist the result before reporting, so a service-worker restart cannot lose it.
    const pendingReport = { key: job.key, result };
    await chrome.storage.local.set({ pendingReport });
    const verification = await reportPending();
    await chrome.storage.local.set({ lastResult: { title: job.offer.title, result: verification?.verified ? '已核实入库' : '已暂停，等待确认', at: new Date().toISOString() } });
    // Keep a blocked challenge/login tab available for its owner. Never solve or loop it.
    if (verification?.verified) await chrome.tabs.remove(tab.id).catch(() => {});
  } catch (e) {
    await chrome.storage.local.set({ bridgeError: String(e.message).slice(0, 300) });
  } finally { busy = false; }
}
function runStep(clicked, proof) { return globalThis.FGK_EPIC_STEP?.(clicked, proof) || { result: 'failed' }; }
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('fgk', { periodInMinutes: 1 }); poll(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('fgk', { periodInMinutes: 1 }); poll(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'fgk') poll(); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.action !== 'retry') return;
  api('retry', {}).then(() => poll()).then(() => respond({ ok: true })).catch(e => respond({ error: e.message }));
  return true;
});
chrome.alarms.create('fgk', { periodInMinutes: 1 });
