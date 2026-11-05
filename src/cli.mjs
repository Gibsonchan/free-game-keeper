import { initData } from './config.mjs';
import { userError, log } from './storage.mjs';
import { runCycle, loadState } from './engine.mjs';
import { epicAuthorizationUrl, discoverEpic } from './epic.mjs';
import { connectSteam } from './steam.mjs';
import { serve } from './server.mjs';
import { worker } from './worker.mjs';

try {
  await initData();
  const [command = 'serve', arg] = process.argv.slice(2);
  let result;
  if (command === 'serve') await serve();
  else if (command === 'worker') await worker();
  else if (command === 'run') result = await runCycle();
  else if (command === 'detect') result = await runCycle({ dryRun: true });
  else if (command === 'public-epic') result = await discoverEpic(arg);
  else if (command === 'status') result = await loadState();
  else if (command === 'auth' && arg === 'epic') result = { url: epicAuthorizationUrl(), instruction: '在常用浏览器打开此链接完成登录，再把一次性授权码粘贴到本机配置面板。' };
  else if (command === 'auth' && arg === 'steam') result = await connectSteam();
  else throw new Error('用法：node src/cli.mjs serve|run|detect|status|auth epic|auth steam');
  if (result) console.log(JSON.stringify(result, null, 2));
  if (result?.failed) process.exitCode = 2;
} catch (e) {
  console.error(userError(e.message));
  await log('command_error', { message: e.message }).catch(() => {});
  process.exitCode = 1;
}
