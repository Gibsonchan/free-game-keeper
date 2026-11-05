import { jsonRequest } from './http.mjs';
import { loadSecret } from './storage.mjs';

export function validateWebhook(value) {
  let url; try { url = new URL(value); } catch { throw new Error('无效的企业微信机器人地址'); }
  if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.port || url.username || url.password ||
      url.pathname !== '/cgi-bin/webhook/send' || !/^[a-zA-Z0-9_-]{12,200}$/.test(url.searchParams.get('key') || '') ||
      [...url.searchParams.keys()].some(k => k !== 'key')) throw new Error('请填写企业微信官方机器人 Webhook 地址');
  return url.href;
}
export async function sendWecom(text, fetchImpl = fetch, explicitWebhook = null) {
  const webhook = explicitWebhook || (await loadSecret('wecom'))?.webhook;
  if (!webhook) throw new Error('NOTIFY_NOT_CONFIGURED: 尚未配置企业微信机器人');
  const url = validateWebhook(webhook);
  // A complete game event stays below WeCom's 2048-byte text limit; split long messages by code point.
  const parts = []; let part = '';
  for (const ch of text) {
    if (Buffer.byteLength(part + ch, 'utf8') > 1900) { parts.push(part); part = ''; }
    part += ch;
  }
  if (part) parts.push(part);
  for (const content of parts) {
    const result = await jsonRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }) }, fetchImpl);
    if (result?.errcode !== 0) throw new Error(`企业微信拒绝通知，错误码 ${Number(result?.errcode) || 'unknown'}`);
  }
}
export function claimText(offer) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false });
  return `免费游戏已领取\n平台：${offer.store === 'epic' ? 'Epic Games' : 'Steam'}\n游戏：${offer.title}\n结果：已核实进入账号库存\n时间：${time}\n${offer.url || ''}`;
}
