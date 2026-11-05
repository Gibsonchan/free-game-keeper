# 参与开发

1. 使用 Node.js 24 或更新版本，执行 `npm ci`。
2. 修改前确认没有将个人运行数据复制到仓库。
3. 修改领取逻辑时，保留零价格、促销有效期和实际库存验证。
4. 增加有意义的回归测试，运行 `npm test` 和 `npm run privacy`。
5. PR 中说明行为变化和验证结果，不附账号信息、日志原文或已配对扩展。

浏览器测试使用隔离页面；CI 中不要配置真实账号、机器人或付费服务。

修改 vendored 代码时保留上游版权和许可证，并更新 `THIRD_PARTY.md`。不要手动修改生成的 `vendor/freekeep/steam.mjs`；修改源文件后运行 `npm run build:vendor`。
