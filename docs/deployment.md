# 部署说明

## 推荐：Windows 本机

Node.js 24、系统 Edge 和已登录 Epic 的 Chrome 配合运行。后台负责发现活动、库存验证和通知；Chrome 连接器只接收已核实的网页任务。

首次运行 `npm start`，在面板完成账号、连接器和机器人配置。日常使用 `start-hidden.vbs`，或用 `scripts/install-startup.ps1` 注册当前用户的登录任务。

启动脚本通过 PATH 查找 Node.js，不依赖固定安装盘符。运行环境必须允许浏览器和 Node.js 联网。

## 实验性：Linux / Docker

仓库提供 `Dockerfile`、`compose.yaml` 和无界面的 `worker` 入口，但不将其视为与 Windows + Chrome 方案等价的已验证部署。

- 容器不提供 VNC 或初次登录界面。
- 需先在可交互的 Linux 环境中运行面板，完成账号和机器人配置，再把该环境的数据目录交给容器。
- Windows DPAPI 数据不能直接复制给容器。
- 现有无界面 Epic 流程可能被平台验证阻止；遇到验证时暂停，不保证无人介入。
- 数据卷、Linux `master.key` 和个人配置都不能提交到 Git。

需要尝试容器时，在完成账号配置和备份后执行：

```sh
docker compose up --build -d
```

## 更新

1. 从面板停止后台。
2. 更新源码并执行 `npm ci`。
3. 启动后台。
4. 若连接器版本更新，在 Chrome 的扩展管理页刷新该连接器。

不会自动接管或迁移另一台机器的登录状态。
