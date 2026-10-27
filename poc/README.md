# dsh-connector-hub-poc

最小验证：仓库外的 DSH 插件能否同时在 dsh web 和 DeepSeek Harness Desktop 中做到以下几件事：

1. 在 Plugins 页加一个「连接器」tab（`plugins.tab` 插槽，浏览器端代码由 client module system 加载）；
2. 注册只允许已登录用户访问的 Host 接口（`ctx.connection.fetch.register`，路径在 `/api/connector-hub/` 下）；
3. 在 Host 进程里加载原生模块 `@napi-rs/keyring`，对系统钥匙串做一次写入、读取、删除；
4. 在运行时挂载 `@deepseek-ai/dsh-mcp-client`，连接本地测试 MCP 服务 `pocdemo`，让工具出现在会话里；卸载再挂载后工具名不变；在 tab 里显示连接状态。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 同时声明 `dsh.bundle`（patch 层）和 `dsh.client`（浏览器端代码）；`@deepseek-ai/dsh-mcp-client` 声明为可选 peer 依赖，运行时用 DSH 安装里的那份 |
| `cordis.patch.yml` | 插入一行 `dsh-connector-hub-poc`；必须写包名，浏览器端代码才会挂上 |
| `src/index.ts` | Host 端：启动时用 `ctx.plugin()` 挂载 mcp-client，每次挂载发送新的 `X-Connector-Token`（模拟换了凭据）；接口有 `status`、`keychain-test`、`mcp-status`、`mcp-probe`、`mcp-remount` |
| `src/client.tsx` | 浏览器端：「连接器」tab，显示测试连接器的状态（每 3 秒刷新一次）、全局工具、各会话可见的工具，提供「试连」「重新挂载」和诊断按钮 |
| `build.mjs` | 用 esbuild 构建；浏览器端输出 CommonJS，外面包一层 `window.__ModuleLoader__.load(...)`，共享模块列表照抄 DSH 的 `PLATFORM_MODULES` |
| `test-server/` | 本地测试 MCP 服务：`http://127.0.0.1:3988/mcp`，无状态 Streamable HTTP；工具 `echo`，以及返回本次请求所带 `X-Connector-Token` 的 `whoami` |

## 构建

需要 Node 24。本机 npm 全局配置的 `registry.npm.taobao.org` 证书已过期，安装依赖时临时指定新镜像：

```bash
npm install --registry=https://registry.npmmirror.com
```

```bash
npm run build
```

测试 MCP 服务：

```bash
npm --prefix test-server install --registry=https://registry.npmmirror.com
```

```bash
node test-server/server.mjs
```

## 安装与运行

下面用 Desktop 自带的 CLI，dsh 版本与 Desktop 一致：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile web add "$PWD"
```

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" web --port 3099
```

Desktop：先完全退出 Desktop，再执行下面的命令，然后重新打开 Desktop。

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$PWD"
```

两个 profile 都是 `link:` 链接到本目录，所以改代码后只需重新构建、重启即可生效。

卸载时同样先退出 Desktop：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-connector-hub-poc
```

## 结果（2026-10-26，Desktop 0.2.1-rc.3，macOS arm64）

| 检查项 | dsh web | Desktop |
|---|---|---|
| Plugins 页出现「连接器」tab | 通过 | 通过（用户确认） |
| `GET /api/connector-hub/status` | HTTP 200；Electron 44.7.0 / Node 24.21.0，以 Node 模式运行 | HTTP 200（用户确认） |
| `POST /api/connector-hub/keychain-test` | HTTP 200，`ok: true`，耗时 243 ms | HTTP 200，`ok: true`（用户确认）；Host 进程（pid 97734）已加载 `keyring.darwin-arm64.node` |
| 未登录访问接口 | 两个接口都返回 401 | 未测（Desktop 的 Host 端口和 cookie 由 Electron 主进程持有） |
| 钥匙串有无遗留测试条目 | 无 | 无 |

补充：

- Desktop 已签名，开启了 hardened runtime，却能加载 ad-hoc 签名的第三方 `.node`，因为它的签名权限包含 `disable-library-validation`。
- 浏览器端没有复刻 DSH 的 tsdown 预设，只用 esbuild 加一层外壳就能被加载。这个 PoC 没用到 CSS modules 和静态资源，这两项还没验证。

## 运行时挂载 mcp-client 的结果（2026-10-27，Desktop 0.2.1-rc.3，macOS arm64）

| 检查项 | dsh web | Desktop |
|---|---|---|
| `@deepseek-ai/dsh-mcp-client` 解析到哪份 | DSH 安装里的那份（`app.asar/dsh/node_modules/...`）；插件目录里没有自己的副本 | 同一份安装 |
| 启动时挂载并连接 | 通过：插件状态 ACTIVE，测试服务收到 `gen-1` 的握手和工具列表请求 | 通过：Desktop 启动后测试服务收到 `gen-1` 的请求 |
| 工具出现在会话里 | 通过：会话的 Agent 能看到 `mcp__pocdemo__echo`、`mcp__pocdemo__whoami`（共 52 个工具）；模型实际调用了两个工具，没有弹审批 | 通过：在 Desktop 里运行的会话中，模型调用 `whoami` 返回 `{"token":"gen-3"}`，测试服务同时收到 `gen-3` 的请求 |
| 卸载再挂载 | 通过：工具名前后一致，卸载后到重新挂载前工具列表为空，新的 `gen-2` 请求头送达服务 | 通过（用户确认）：挂载代次 gen-2、gen-3，测试服务收到对应请求 |
| 状态显示 | 已连接 / 失败 / 恢复三种状态都显示正确（见下） | 已连接（用户确认） |

状态相关的发现：

- **服务挂掉后，仅凭注册表判断的状态仍是「已连接」。** 测试服务是无状态 HTTP，mcp-client 和它之间没有常驻连接，察觉不到服务已经停了；直到某次调用失败或重新挂载才会暴露。插件自己用 MCP SDK 做一次「试连」能立即发现（`fetch failed`，17 ms）。所以连接状态需要定期试连，不能只看注册表。
- **服务挂掉时重新挂载：** 设了 `failOnStartupError: true`，插件状态变为 FAILED，错误信息是 `mcp-client(pocdemo): initial connection or tool synchronization failed`，工具全部移除，会话可见工具从 52 个降到 50 个。服务恢复后再挂载一次即恢复为「已连接」。
- **工具集变化对模型可见，并会记进会话日志。** 同一个会话从 dsh web 换到 Desktop 里继续时，DSH 用一条 `developer/message`（`tool-addition`）告诉模型新增了哪些工具。挂载或卸载连接器会改变模型在会话中看到的上下文。

接口差异：master 上的 `ctx.tools.definitions()` 在 0.2.1-rc.3 里不存在（调用时抛 `TypeError`），改用两边都有的 `ctx.tools.schemas(scope)`。查 API 要以目标发布版本为准，不能以 master 为准。
