# Free Game Keeper · 免费游戏助手

自动领取 Epic Games Store 和 Steam 的限时免费游戏，核实账号实际拥有后，通过企业微信机器人通知。

采用 Node.js 本机后台与 Chrome 连接器。首次需要连接自己的账号、安装连接器并配置机器人；日常检查、领取和通知自动执行。遇到平台要求的人机验证、账号确认或未知金额页面时暂停该任务并提醒。

## 功能

- Epic：按账号地区读取当前限免，优先通过接口领取；需要网页结账时交给已登录的 Chrome。
- Steam：识别可永久保留的免费促销许可证，排除免费周末、试玩和普通 Free to Play；DLC 缺少本体时跳过。
- 成功通知以平台库存为准，网页显示成功或接口返回成功均不能单独触发通知。
- 默认每 6 小时检查，失败后 30 分钟重试；消息队列持久保存，发送失败会重试。
- Windows 静默启动及登录自动启动；面板仅监听本机回环地址。
- Windows 用 DPAPI CurrentUser 加密授权、机器人地址和浏览器状态。

## 环境

推荐 Windows 10/11、Node.js 24 或更新版本、已安装的 Microsoft Edge 和 Chrome。

Edge 用于 Steam 登录及后台请求。Chrome 连接器用于 Epic 网页结账，需要在已登录 Epic 的同一 Chrome 配置文件中启用并保持 Chrome 运行。

Linux/Docker 入口属于实验性部署，见 [部署说明](docs/deployment.md)。

## 安装与首次配置

下载并解压本仓库，进入项目目录：

```powershell
npm ci
npm start
```

打开 [本机配置面板](http://127.0.0.1:18769/)，依次完成：

1. **Epic 授权**：点击“用常用浏览器登录 Epic”，在平台页面登录。将登录结果里的 `authorizationCode` 或包含它的整段 JSON 粘贴到本机面板。授权码不要发给其他人。
2. **Steam 登录**：点击“连接 Steam”，在独立窗口登录或扫码。
3. **Chrome 连接器**：在已登录 Epic 的 Chrome 中打开 `chrome://extensions/`，启用开发者模式，加载本项目运行后生成的 `data/epic-extension` 目录。面板会显示连接状态和版本。
4. **企业微信**：在面板保存你自己的群机器人 Webhook，再发送测试通知。

配置完成后，程序自动检查；也可以点“立即领取”。

如果 Epic 返回 `PRIVACY_POLICY_ACCEPTANCE`，请在常用浏览器登录 Epic 商店，阅读平台显示的政策并自行决定是否同意，再重新获取授权码。程序不会把 `continuation` 当授权码，也不会代用户确认政策。

## 日常运行

- Windows 双击 `start-hidden.vbs` 或 `启动助手.vbs` 静默启动。
- 双击 `打开配置面板.url` 打开面板；可从面板停止后台。
- 配置登录自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-startup.ps1
```

- 移除登录自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/remove-startup.ps1
```

一次只运行一个实例。电脑关机或睡眠期间无法检查，恢复后补查。Chrome 连接器遇到验证或账号异常会暂停该游戏，处理后可在扩展弹窗中点“重试待领取”。

## 配置与数据

面板会生成 `config.json`；可参考 [config.example.json](config.example.json)。

| 配置 | 含义 |
| --- | --- |
| `intervalHours` | 正常检查间隔，1–24 小时 |
| `retryMinutes` | 失败后重试间隔，10–360 分钟 |
| `includeDlc` | 是否领取满足条件的免费 DLC |
| `enabledStores` | 启用的商店 |
| `browserChannel` | 后台浏览器，Windows 默认为 `msedge` |
| `browserProxy` | `null` 使用默认代理、`direct` 直连，或自定义代理地址 |
| `epicWebMode` | Windows 默认为 `extension`；`headless` 为实验模式 |

实际地区取自登录账号。`country` 仅作为部分配置入口的可选值，不用于绕过地区资格。

`data/` 保存加密授权、领取记录、消息队列和已配对连接器。可用环境变量 `FGK_DATA_DIR` 指定数据目录。Windows 加密文件不能直接迁移到其他系统用户或 Docker；Linux 的本地加密密钥需要与数据卷一起保护。

**不要上传 `data/`、`config.json`、日志、浏览器配置或生成的连接器目录。** 可公开的连接器模板位于 `extension/`。本仓库的排除规则和隐私检查覆盖这些运行文件，详见 [安全与隐私](SECURITY.md)。

## 开发与验证

```powershell
npm test
npm run privacy
```

Linux 上运行浏览器测试前，安装测试用 Chromium：

```sh
npx playwright install --with-deps chromium
npm test
```

测试使用合成数据和隔离页面，不需要真实账号，也不会提交真实订单。CI 不使用账号授权或机器人凭证。

```powershell
# 只读检查，需要已连接账号，不提交订单或发送通知
npm run detect

# 执行一次真实领取，按配置发送通知
npm run run
```

升级时先停止后台，更新源码并执行 `npm ci`，然后重启。若连接器版本改变，在 Chrome 扩展管理页刷新现有连接器。

## 行为边界

结账只处理已核实为零价的活动。无金额的 `Add to library` 确认弹层，要求后台刚核实零价、证明仍有效且本轮已点击该商品的 `Get`。未知价格或有金额的付费订单不会提交。

同一通知在普通重启后不会重复发送；若服务端已经接收消息、网络却在返回确认前中断，重试仍可能造成重复通知。平台页面、验证规则和接口变更可能影响可用性。

## 来源与许可证

项目使用 GPL-3.0-only，见 [LICENSE](LICENSE)。Steam 相关实现复用 FreeKeep 的 MIT 代码；Epic 网页流程改编自 GPL-3.0 项目。固定版本、版权声明和修改说明见 [THIRD_PARTY.md](THIRD_PARTY.md)。

源码中的 Epic Launcher OAuth 客户端标识属于上游使用的公开协议参数，不是某位用户的账号授权。个人 access token、refresh token、浏览器状态和机器人地址仅在首次配置后生成，不随源码分发。
