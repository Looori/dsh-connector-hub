# dsh-connector-hub

DeepSeek Harness（DSH）的「连接器市场」外部插件：在 Plugins 页的「连接器」tab 里浏览精选目录，连接远程 MCP 服务，凭据存系统钥匙串。

## 开工前先读

1. `docs/progress.md`：当前里程碑、任务状态、下一步。从「下一步」接着做。
2. `docs/design.md`：一期的决策和方案，实现以它为准。
3. `docs/decisions.md`：决策记录和理由。已定的事不重新讨论，除非出现新事实。

## 工作节奏

每个里程碑按五步走：

1. 对齐：列出本步任务和完成标准，等用户确认。
2. 执行：实现并自测。只有需要用户拍板时才打断。
3. 汇报：结果、测试输出、与计划的偏差。
4. 用户验收：Desktop 界面操作、真实账号授权等只能由用户做的部分。
5. 收尾：更新 `docs/progress.md`（以及有变化的 design / decisions），然后提交。

规则：

- 先验证、后实现，M0 不通过就不写正式代码。
- 一个里程碑结束前不开新话题，新想法记进 progress 的「待讨论」。
- 每个里程碑开一个新会话。
- 每完成一个可验证的步骤提交一次，提交信息以里程碑开头，例如 `M1: ...`。
- 分工：用户负责决策、需要登录或真实账号的操作、Desktop 手动验证、批准对外操作（推送、发布）；Claude 负责调研、实现、测试、文档同步、提交。

## 约定

- 不提交 `.dsh/`（用户 Desktop 的授权文件）。暂存时写明路径，不用 `git add -A`。
- 公开仓库（`Looori/*`）的提交邮箱用 `66784394+Looori@users.noreply.github.com`。
- 不改全局 npm 配置。安装依赖时临时加 `--registry=https://registry.npmmirror.com`。
- Node 24：`export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`（系统 node 是 v20）。
- Desktop 自带的 CLI：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（0.2.1-rc.3）。
- 查 DSH API 要以发布版本为准：本机源码在 `../deepseek-harness`，标签是 `dsh-v0.2.1-rc.3`，不要看 master。
- 目录站点仓库：`../looori.github.io`，对应 GitHub 上的 `Looori/looori.github.io`。
- 修改用户的 Desktop 状态（退出 Desktop、改 profile）前先确认。
