chrome.storage.local.get(['lastResult', 'bridgeError']).then(data => {
  document.getElementById('status').textContent = data.lastResult ? `${data.lastResult.title}\n状态：${data.lastResult.result}` : '连接器已加载。每分钟检查本机待领取任务。';
});
document.getElementById('retry').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ action: 'retry' });
  document.getElementById('status').textContent = result?.error || '已检查待领取任务。';
};
