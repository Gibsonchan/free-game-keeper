# 上游来源与修改

核对日期：2026-11-05。本项目以 GPL-3.0-only 提供，完整文本见 LICENSE。

## FreeKeep for Steam

- 仓库：https://github.com/SmailDot/FreeKeep-for-Steam
- 读取的提交：`f1f92c8be52c6d7abd24df5244f2cc775ca927a5`
- 作者：Copyright (c) 2026 SmailDot。
- 授权：MIT，完整文本保存在 `vendor/freekeep/LICENSE`。
- 保留源文件：`src/core/steam.ts`、`src/core/types.ts`，位于 `vendor/freekeep/`，未修改。
- `steam.mjs` 由 Node 内置 TypeScript 转换器生成。其上层适配器使用 Playwright APIRequestContext 的登录 Cookie，加入账号标识、许可证二次核验、地区检测和库存验证。
- 上游 HTTP 2xx 即成功的分类不会直接触发通知；本项目必须验证 `rgOwnedPackages`。

## epic-free-games-claim

- 仓库：https://github.com/spin311/epic-free-games-claim
- 读取的提交：`df6caca18e1d32a8c1a932d14a457885f71b8994`
- 授权：以实际 LICENSE 文件 GPL-3.0 为准（README 的 MIT 表述与之不一致）。
- `src/epic.mjs` 的网页处理逻辑改编自 `epic.content.ts` 与 `utils/helpers.ts`：匹配新旧购买按钮、遍历 iframe、处理已验证年龄提示和不支持设备提示、提交订单及撤回权确认。
- 改编日期：2026-11-05。改为 Playwright 驱动，增加零金额验证、总超时、人机验证识别和账号实际库存验证；不包含上游扩展 UI。

## 协议实现参考

- https://github.com/KingHacker9000/Claim-Free-Games ：用于核对 Epic OAuth、entitlements 与 quickPurchase 的接口路径及 API 优先流程；未复制其源码文件。
- https://github.com/vogler/free-games-claimer ：用于核对已知页面改版、验证码问题及部署方式；未复制源码文件。
- https://playwright.dev/docs/api/class-browsercontext ：浏览器状态与共享请求上下文。

依赖 Playwright 1.64.1，Apache-2.0，依赖包附带其 LICENSE / NOTICE。
