# dsh-connector-hub

DeepSeek Harness（DSH）的社区连接器插件：在 Plugins 页的「连接器」tab 中浏览精选目录，连接远程 MCP 服务，并将凭据保存在 macOS 钥匙串中。

> 这是社区插件，不是 DeepSeek 官方产品。

## 功能

- 内置 Notion、Xmind（中国版）、高德地图、百度地图和腾讯文档。
- 支持 OAuth 授权、token 自动刷新，以及请求头或查询参数形式的 API Key。
- 连接器挂载在 profile 根目录，添加后可由该 profile 的所有会话使用。
- 支持试连、重新挂载、停用／启用、更换凭据和删除。
- 普通配置在各 profile 间共享，Desktop 与 dsh web 可以协同使用。

## 安装

要求：

- macOS；
- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`。

在 DSH 的 Plugins 页安装 `dsh-connector-hub`，然后打开「连接器」tab，在「发现」页选择服务并完成授权或填写 API Key。

详细使用与安全说明见 [npm 包说明](packages/connector-hub/README.md)。

## 数据与安全

- API Key 和 OAuth token 保存在 macOS 钥匙串，service 为 `dsh-connector-hub`，account 为连接器 ID。
- 普通配置保存在 `$DSH_HOME/connector-hub/connectors.json`，不包含凭据。
- 上游地址只能来自内置或远程精选目录，界面和 Host 接口不接受用户提供的任意 URL。
- 本地凭据网关只监听 loopback，凭据不会进入 MCP 客户端配置。

## 一期限制

- 仅支持 macOS 和远程 Streamable HTTP MCP 服务。
- 不支持用户自行添加目录以外的连接器。
- 不提供工具调用审批和按会话开关。
- 启动时服务不可用需要手动重新挂载。
- 同名 MCP 服务冲突的专门提示只覆盖本插件挂载失败的情况；如果本插件先挂载成功、手动配置的同名服务随后失败，错误只会出现在 DSH 日志中。

## 开发

需要 Node.js 24 和 pnpm 11.5.2。

```bash
pnpm install --registry=https://registry.npmmirror.com
pnpm test
pnpm typecheck
pnpm build
pnpm catalog:build
```

自动端到端测试使用临时 `DSH_HOME`、本地模拟服务和进程内伪钥匙串，不访问真实用户配置、真实钥匙串或真实服务商。
