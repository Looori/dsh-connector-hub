# dsh-connector-hub 一期设计

- 日期：2026-10-29
- 状态：一期设计依据；M0 已于 2026-11-03 完成技术验证，网关与共享 OAuth 客户端结论已写回本文。
- 目标版本：DeepSeek Harness 0.2.1-rc.5（2026-11-02 由 rc.3 改为 rc.5，见 §3 末尾）
- 参考：[PoC 结果](../poc/README.md)

## 1. 目标与范围

dsh-connector-hub 是一个从仓库外安装的 DSH 插件。它在 Plugins 页的「连接器」tab 里展示一份精选的连接器目录。用户在 tab 里连接远程 MCP 服务，填写的授权信息（OAuth token、API Key）存进系统钥匙串。连接成功后，这个服务的工具出现在所有会话里。

dsh web 和 DeepSeek Harness Desktop 都要支持。DSH 仓库不接受社区 MR，所以全部功能都通过插件实现，不改 DSH。一期只支持 macOS。

一期不做：

- Windows 和 Linux；
- Xmind 国际版（`app.xmind.com`）；
- 本地（stdio）连接器；
- 用户自行添加目录以外的连接器；
- 工具调用审批；
- 按会话开关连接器（以后怎么加，见 §10）；
- 自动重连：DSH 启动时服务不可用，由用户手动「重新挂载」；
- 从别的机器访问 dsh web（比如经隧道或反向代理）时的 OAuth：回调地址是本机 loopback，见 §6.2。

## 2. 已定决策

| # | 事项 | 决定 |
|---|---|---|
| 1 | 连接器目录 | 我们自己维护的精选目录，用用户本人的 GitHub 账号 `Looori` 托管在 GitHub Pages（仓库 `Looori/looori.github.io`） |
| 2 | 连接器类型 | 一期只支持远程 MCP（Streamable HTTP） |
| 3 | 挂载位置 | profile 根，所有会话可见。以后加按会话开关，改动是增量的（§10） |
| 4 | 审批 | 一期不做。MCP 工具调用在 DSH 里默认放行（PoC 实测） |
| 5 | 启动时服务不可用 | 一期由用户手动重新挂载 |
| 6 | 配置存放 | 普通配置写 `$DSH_HOME/connector-hub/connectors.json`，各 profile 共用；密钥存系统钥匙串（§7） |
| 7 | UI 位置 | Plugins 页的 tab，分「我的」和「发现」两页（§9） |
| 8 | 版本兼容 | 按 0.2.1-rc.5 实现。`engines.dsh` 写 `>=0.2.1-rc.5 <0.3.0`，CI 同时测 rc.5 和 npm 的 `next` 标签。2026-11-02 由 rc.3 改为 rc.5：Desktop 已自动更新到 rc.5，npm 的 `latest` 和 `next` 也都指向 rc.5 |
| 9 | 包名 | `dsh-connector-hub`，不带 scope。2026-10-29 查过，npmjs 上还没人用这个名字 |
| 10 | 第一批连接器 | Notion、Xmind（中国版）、高德地图、百度地图、腾讯文档（附录 A）。一期不接 Xmind 国际版 |
| 11 | 工程结构 | pnpm 工作区（§11） |
| 12 | 测试 | 单元测试、自动端到端冒烟、Desktop 手动检查清单，三层（§12） |
| 13 | 平台 | 一期只支持 macOS |

## 3. 已验证的事实（rc.3 实测，rc.5 已核对源码）

PoC 验证过的（详见 [poc/README.md](../poc/README.md)）：

- 外部插件同时声明 `dsh.bundle` 和 `dsh.client`，就能在 Plugins 页加 tab。patch 行必须写包名，浏览器端代码才会挂上。
- `ctx.connection.fetch.register` 注册的 `/api/<ns>/*` 路由只有已登录的本机用户能访问，没带 cookie 会返回 401。Desktop 会把页面的请求连同 cookie 转发给 Host。路由处理函数抛出异常时，DSH 返回一个空的 400，所以插件要自己捕获异常，返回 JSON。
- Host 进程能加载 `@napi-rs/keyring` 原生模块，Desktop 也可以：它的签名权限包含 `disable-library-validation`。
- `@deepseek-ai/dsh-mcp-client` 声明为可选 peer 依赖时，解析到的是 DSH 安装里的那份。用 `ctx.plugin()` 在运行时挂载后，工具名是 `mcp__<serverName>__<工具名>`，卸载再挂载后名字不变。
- 卸载到重新挂载之间，工具列表是空的。工具集的变化会以 `developer/message`（`tool-registry`）的形式写进会话，模型看得到。
- 对无状态 HTTP 服务，服务挂掉后注册表仍显示工具在线。要判断服务是否可用，只能自己去试连。
- 设了 `failOnStartupError: true`，启动时连不上会让挂载变成 FAILED，并移除这个服务的工具。
- rc.3 到 rc.5 都只有 `ctx.tools.schemas(scope)`，没有 `definitions()`。查 API 要以发布版本为准，不能以 master 为准。

本次（2026-10-29）读 rc.3 安装包核对的：

- **mcp-client 的 `streamable-http` 配置只有 `url` 和静态 `headers`**，其余是 `toolCallTimeoutMs`（默认 60 s）、`failOnStartupError`、`maxInstructionBytes`、`reconnect`。没有 `authProvider`，所以它自己不会刷新 token。§4.2 的本地凭据网关就是为了解决这个问题。
- mcp-client 自带重连，默认开启：间隔从 500 ms 起，最长 30 s，最多 10 次。它只在已建立的连接断开后起作用。
- `serverName` 必须匹配 `^[A-Za-z0-9_-]{1,32}$`。同一个作用域里不能有两个同名的 mcp-client，否则挂载失败，报 `already in use`。
- DSH 在 Host 进程里把出网代理装成 undici 的全局 dispatcher，发往 loopback 地址的请求一律直连。插件只要用全局 `fetch`，出网就会自动走用户配置的代理。本机就是经 `HTTP(S)_PROXY` 出网的。
- `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 按以下顺序确定目录：显式传入的路径、`$DSH_HOME`、默认目录。
- DSH 依赖的 `@modelcontextprotocol/client` 是 2.2.0。这个版本已经实现 OAuth 的元数据发现、动态注册、PKCE、`resource` 参数、回调 `iss` 校验（RFC 9207）和 token 刷新，我们实现 `OAuthClientProvider` 接口即可。

2026-11-02 对照 rc.5 核对的（比较 `dsh-v0.2.1-rc.3` 和 `dsh-v0.2.1-rc.5` 两个标签的源码，并读了 Desktop rc.5 安装包）：

- 两个版本之间只改了十来个源文件，集中在聊天里推理内容的显示上。插件用到的接口都没变：tools、agents、`connection.fetch`、Plugins 页插槽、`ui-primitives`、`home-paths`、出网代理。
- mcp-client 只改了一处：服务器没声明 resources 能力时，不再去请求资源列表。`streamable-http` 的配置项和 rc.3 完全一样，仍然只有静态 `headers`，§4.2 的结论不变。
- rc.5 依赖的 `@deepseek-ai/cordis` 仍是 `~4.0.5`，`@modelcontextprotocol/client` 仍是 2.2.0。npm 上 `@deepseek-ai/dsh-*@0.2.1-rc.5` 各包齐全，可以直接作为类型依赖。
- M0 已在 rc.5 实测：dsh web 自动及 UI 冒烟、Desktop 手动冒烟均通过；未登录路由 401，钥匙串读写删除成功，试连成功，卸载时工具消失，重挂后工具名不变；三个 Desktop 会话均能看到两个 PoC 工具。Desktop 的 `window.open` 已由用户确认交给系统 Chrome。

## 4. 总体架构

```
浏览器端：Plugins 页「连接器」tab
   │  fetch api/connector-hub/*（只有已登录的本机用户能访问）
   ▼
Host 端：dsh-connector-hub
   ├─ catalog   拉取 GitHub Pages 上的目录，在本地缓存，并内置一份快照
   ├─ store     读写 connectors.json，与其他进程对账
   ├─ secrets   钥匙串读写，跨进程锁
   ├─ oauth     OAuthClientProvider 实现，加上临时的 loopback 回调服务
   ├─ gateway   127.0.0.1 上的本地凭据网关：注入凭据，必要时刷新 token
   ├─ mounts    每个已连接的连接器挂载一个 dsh-mcp-client
   ├─ health    经网关试连（initialize + tools/list）
   └─ routes    /api/connector-hub/*
         │
dsh-mcp-client ──► http://127.0.0.1:<端口>/c/<id>/mcp ──► gateway ──► 远程 MCP 服务
```

### 4.1 浏览器端与 Host 的分工

浏览器端只负责界面，所有状态都在 Host：目录、配置、密钥、挂载。浏览器端通过 `api/connector-hub/*` 读状态、发起操作。接口返回的内容里永远不含 token 和 Key。用户填写的 API Key 只在保存那一次随请求发给 Host。

### 4.2 本地凭据网关（M0 已验证）

**问题：** rc.3 到 rc.5 的 mcp-client 都只接受静态请求头，想把新 token 送过去，只能卸载再挂载。Xmind 的 access token 有效期只有 1 小时，这意味着每小时都要重新挂载一次。而 PoC 已经看到，重新挂载期间工具列表是空的。如果此时会话正好发起请求，模型会看到工具消失又出现，DSH 还会把这个变化写进会话；正在执行的工具调用也会失败。另外，高德把 Key 放在 URL 查询参数里，直接写进 mcp-client 配置的话，Key 可能随 URL 出现在报错和日志里。

**做法：** 插件启动时，在 `127.0.0.1` 上用随机端口起一个 HTTP 服务，作为凭据网关。挂载 mcp-client 时，`url` 指向网关的 `http://127.0.0.1:<端口>/c/<连接器 id>/mcp`，请求头只带一个本进程随机生成的 `X-Connector-Hub-Key`。网关做这几件事：

1. 校验 `X-Connector-Hub-Key`（用恒定时间比较），不对就返回 403。只监听 loopback，再加上这个本进程密钥，挡住本机其他进程和浏览器发起的 DNS 重绑定。这个密钥只在内存和 mcp-client 配置里，不写盘，不进日志。
2. 网关不是通用代理：`/c/<id>/mcp` 只转发到这个连接器在 `connectors.json` 里记录的上游地址，其他路径一律返回 404。转发时注入凭据：OAuth 用 `Authorization: Bearer`，API Key 按目录的声明放进请求头或查询参数。转发 `Accept`、`Content-Type`、`Mcp-Session-Id`、`Mcp-Protocol-Version`、`Last-Event-ID`，去掉逐跳头和 `X-Connector-Hub-Key`。
3. 请求体和响应体都按流转发，包括 SSE。支持 POST、GET、DELETE。
4. OAuth 连接器的 access token 剩不到 5 分钟时，先刷新再转发。上游返回 401 时，刷新一次后重试一次：请求体已缓存，JSON-RPC 消息很小，上限设为 4 MB。刷新失败就把连接器标成「需要重新授权」。

**效果：** 刷新 token 不需要重新挂载；密钥不会进入 mcp-client 配置、DSH 配置和日志；试连和真实调用走的是同一条路径，凭据错误也能试出来。

**M0 结论：** 未带密钥返回 403、未知路径返回 404，POST、GET/SSE、DELETE 均成功转发；非 loopback 上游请求全部经过模拟 DSH 代理，loopback 请求保持直连。采用网关方案，不再使用刷新后重挂的退路。限制是 rc.5 mcp-client 卸载时不会主动发 DELETE，DELETE 由当前 MCP 会话直接请求网关验证。

为什么不把 `authProvider` 交给 mcp-client：rc.3 到 rc.5 的 mcp-client 都不接受这个参数，我们又改不了 DSH。

## 5. 连接器目录

### 5.1 托管与获取

- 地址：`https://looori.github.io/dsh-connector-hub/catalog/v1/index.json`。
  - 托管在用户站点仓库 `Looori/looori.github.io` 的 `dsh-connector-hub/` 目录下，从 `main` 分支根目录发布，带 `.nojekyll`，文件原样发布。本地克隆在 `../looori.github.io`。
  - 2026-10-30 已上线一份空目录占位（`connectors: []`）。Pages 返回 `content-type: application/json` 和 ETag，可以直接用于条件请求。
- 插件内置这个默认地址，可以用插件配置 `catalogUrl` 覆盖，供测试和镜像使用。
- 由 Host 拉取，没有跨域问题。拉到的结果缓存在 `$DSH_HOME/connector-hub/cache/catalog.json`，并记下 ETag。
- npm 包里内置一份构建时的目录快照。第一次运行时如果没网，也有内容可看。
- 刷新时机：打开 tab 时，如果缓存超过 24 小时就刷新；tab 里也有手动刷新按钮。拉取失败就用缓存，再不行用内置快照，并在 tab 里提示「目录可能不是最新的」。
- 图标以 SVG data URI 直接写在目录里，每个不超过 8 KB。这样不用另外加载外部图片，不受 Desktop 页面安全策略限制，离线时也能显示。

### 5.2 格式

源文件放在仓库的 `catalog/connectors/<id>.yaml`，每个连接器一个文件。构建脚本用 JSON Schema 校验后，合并成 `index.json`。发布时把它写进站点仓库的 `dsh-connector-hub/catalog/v1/`，再提交并推送（§11）。

```json
{
  "schemaVersion": 1,
  "revision": "2026-10-29.1",
  "connectors": [
    {
      "id": "xmind-cn",
      "name": { "zh": "Xmind（中国版）", "en": "Xmind (China)" },
      "description": { "zh": "…", "en": "…" },
      "icon": "data:image/svg+xml;base64,…",
      "homepage": "https://xmind.cn",
      "publisher": "Xmind",
      "official": true,
      "remote": { "type": "streamable-http", "url": "https://app.xmind.cn/api/mcp" },
      "auth": {
        "type": "oauth",
        "scope": "openid mcp:connect",
        "clientId": "CIul0o4i8rMwnA",
        "callbackPath": "/oauth/callback/xmind-cn",
        "portPolicy": "fixed",
        "fixedPort": 43118
      }
    },
    {
      "id": "amap",
      "remote": { "type": "streamable-http", "url": "https://mcp.amap.com/mcp" },
      "auth": { "type": "api-key", "in": "query", "name": "key", "label": { "zh": "Web 服务 Key", "en": "Web service key" }, "helpUrl": "https://console.amap.com/dev/key/app" }
    }
  ]
}
```

`remote` 部分参照官方 MCP Registry `server.json` 的 `remotes` 字段。`server.json` 描述不了 OAuth 和放在查询参数里的 Key，所以 `auth` 是我们自己定义的：

| `auth.type` | 字段 | 说明 |
|---|---|---|
| `oauth` | `scope`、`authorizationParams`（可选）、`clientId` 或 `clientMetadataUrl`、`callbackPath`、`portPolicy`、`fixedPort`（固定端口时） | 授权地址、Token 地址和 Issuer 在运行时按 MCP 规范发现；目录提供共享公共客户端身份和按服务商实测固化的端口策略 |
| `api-key` | `in`（`header` / `query`）、`name`、`label`、`helpUrl` | 用户在 tab 里填写，存进钥匙串，由网关注入 |
| `none` | — | 公开服务，不需要凭据 |

规则：

- `id` 同时用作 mcp-client 的 `serverName`，必须匹配 `^[a-z0-9-]{1,24}$`。它决定工具名（`mcp__<id>__…`），发布后不能再改。
- `publisher` 是运营这个 MCP 服务的公司或组织，显示为卡片上的「by …」。`official: true` 表示服务由服务商自己运营，卡片上显示「官方服务」（§9.1）。
- 远程地址必须是 `https`。只有测试用的 loopback 地址允许 `http`。
- 插件忽略不认识的字段。遇到不认识的 `auth.type`，在 tab 里显示「需要更新插件」。
- 目录里永远不放 token、API Key、client secret 或注册管理凭证。公开的 `clientId` 和 CIMD URL 不是密钥，可以放在目录里（§6.2）。

### 5.3 目录的信任边界

目录决定了凭据会发给哪个地址，所以它是安全边界的一部分。一期的做法：

- 连接时，把目录里的 `remote` 和 `auth` 复制进 `connectors.json`，此后网关只用这份副本。
- 目录更新后，如果已连接连接器的地址或认证方式变了，不会自动生效。tab 里提示「目录有更新」，用户确认后重新连接才生效。
- 一期不做目录签名，靠 GitHub Pages 的 HTTPS 和仓库权限保证。

## 6. 认证

### 6.1 API Key

- 用户在弹窗里填 Key，点「保存并连接」（§9.3）。Host 先拿这个 Key 经网关试连（initialize + tools/list），这时 Key 只在内存里。试连通过后，才存进钥匙串、写入配置并挂载；失败就丢弃这个 Key。
- 保存后 Key 不再显示。编辑就是整体替换。
- 没带 Key 时各家的失败方式不同（2026-10-29 实测）：高德返回 HTTP 200，响应体是 `{"status":"0","info":"INVALID_USER_KEY",…}`，不是 JSON-RPC；百度返回 400 `ak is required`。所以没法统一从状态码判断「Key 无效」。试连失败时直接显示上游返回的错误摘要。

### 6.2 OAuth

流程是 MCP 授权规范规定的授权码 + PKCE：

1. 用户在弹窗里点「前往授权」（§9.3）。Host 在 `127.0.0.1` 起一个临时回调服务，路径按服务商隔离为 `/oauth/callback/notion` 或 `/oauth/callback/xmind-cn`。支持变端口的服务商直接监听端口 `0`；只接受完整登记 URI 的服务商使用目录中固化的端口，绑定失败时明确报错，不尝试随机端口。
2. Host 调用 SDK 的 `auth(provider, { serverUrl, scope })`。SDK 发现受保护资源和授权服务器元数据，生成 PKCE 参数并带上 `resource`。provider 通过 `clientMetadataUrl` 或 `clientInformation()` 注入共享公共客户端，禁止进入每实例动态注册分支。
3. 浏览器端打开授权页。dsh web 里用 `window.open`，点击时先同步打开空白窗口，拿到地址后再跳转（§9.3）。M0 已确认 Desktop 的 `window.open` 会交给系统 Chrome；界面仍保留「复制授权链接」作为打不开时的退路。回调发到 Host 所在机器的 loopback 地址，所以本机上的任何浏览器都能完成授权。
4. 服务商把浏览器带回本次实际的 `redirect_uri`，附带 `code`、`state`，以及服务商支持时的 `iss`。Host 校验 `state`（随机生成、只能用一次、10 分钟过期），再调用 `auth(provider, { serverUrl, authorizationCode, iss })`；授权请求和换 token 必须使用完全相同的 `redirect_uri`。之后 SDK 用 PKCE 换取 token，再调用 `saveTokens` 写进钥匙串。回调页显示「已连接，可以关闭此页」。
5. 回调服务随即关闭，Host 把连接器写入 `connectors.json` 并挂载 mcp-client。授权超过 10 分钟没完成，或者用户取消，就按失败处理，回调服务同样关闭，配置里不留任何记录。

**客户端注册：所有用户共享公共客户端。**

- 每个服务商只有一个客户端，所有用户共用公开的客户端身份；`token_endpoint_auth_method` 固定为 `none`，不分发或保存共享 `client_secret`。共享客户端不等于共享用户授权，token 仍只存在用户自己的机器上。
- 公共客户端身份是目录配置的一部分，不是密钥。Notion 的 `client_id` 是 CIMD 的 HTTPS URL；Xmind 的公开 `client_id` 由目录的 OAuth 配置提供。旧方案「目录不放 client_id、每台机器动态注册」已由 2026-11-02 的决策替代。
- Notion 使用 `https://looori.github.io/dsh-connector-hub/oauth/notion/client.json`，文档不包含 secret。M0 已确认 SDK 采用该 CIMD，动态注册调用为 0。
- Xmind 没有另行使用管理入口，M0 经 `https://app.xmind.cn/api/oauth/register` 只创建一次名为 `DSH Connector Hub` 的公共客户端。注册响应即使含 secret 或管理凭证也不保存；运行时禁止再次动态注册。

**loopback 端口策略（M0 实测）：**

| 服务商 | 最终策略 | 实测结论 |
|---|---|---|
| Notion | 随机端口 | CIMD 客户端接受随机端口；真实授权、token 交换、刷新和刷新前后 MCP 试连均通过，无需固定端口退路 |
| Xmind | 固定 `43118` | 随机端口在登录时报 `redirect_uri is not registered for this client`；登记 URI `http://127.0.0.1:43118/oauth/callback/xmind-cn` 的完整流程通过；端口占用会在打开授权页前明确报错 |

端口策略按服务商固化在目录中，不作为普通用户设置，也不在授权失败后盲目切换策略或创建新客户端。

**Token 刷新：**

- 网关负责刷新：access token 剩不到 5 分钟时主动刷新，或者上游返回 401 时刷新。
- 刷新前，先拿到跨进程文件锁 `$DSH_HOME/connector-hub/locks/<id>.lock`：用独占方式创建文件，写入 pid；超过 30 秒视为陈旧锁。拿到锁后重新读一次钥匙串，如果别的进程已经刷新过，就直接用新 token。这样 Desktop 和 dsh web 同时运行时，不会互相作废对方的 refresh token。
- 刷新成功后立即把新的 refresh token 写回钥匙串，按旧 refresh token 可能立即作废的严格规则实现。M0 已实测 Notion 刷新成功，Xmind 刷新后 refresh token 发生轮换，两家刷新后 MCP 试连均成功。
- 返回 `invalid_grant` 时，状态改为「需要重新授权」，卸载这个连接器的 mcp-client，不让模型继续调用注定失败的工具。钥匙串里的条目保留，用户重新授权时会被覆盖。

**授权账号显示：** Notion 换 token 的响应里直接带工作区和用户信息；Xmind 要请求 `openid` scope，从 `id_token` 的 `name` 字段读取。这些信息只用来显示，不用来做安全判断。如果 `name` 看起来是手机号，就打码，只显示前 3 位和后 4 位。

**删除：** 卸载 mcp-client，删除钥匙串条目，从 `connectors.json` 里移除。服务商提供 `revocation_endpoint`（比如 Notion）时，顺带尽力吊销一次 token，吊销失败不影响删除。

## 7. 配置与密钥存储

### 7.1 普通配置

文件位置是 `$DSH_HOME/connector-hub/connectors.json`，用 `resolveDshHome()` 计算。所有 profile 共用这一份，用户连接一次，各 profile 都能用。当然，连接器只会出现在装了本插件的 profile 里。

```json
{
  "schemaVersion": 1,
  "connectors": {
    "notion": {
      "catalogRevision": "2026-10-29.1",
      "remote": { "type": "streamable-http", "url": "https://mcp.notion.com/mcp" },
      "auth": { "type": "oauth" },
      "enabled": true,
      "addedAt": "2026-10-29T08:00:00.000Z"
    }
  }
}
```

- 写入时先写临时文件，再改名替换，避免写到一半时被别的进程读到。
- 带 `schemaVersion`，以后加字段（比如按会话开关）时可以平滑迁移。
- `enabled` 由「我的」页的停用开关修改（§9.2）。它和其他配置一样各 profile 共用，所以在一个进程里停用，别的进程对账后也会停用。
- 跨进程对账：插件启动时，以及 tab 打开期间每次轮询状态时，检查文件的修改时间。文件变了就重新读取，按新配置挂载或卸载。这样在 Desktop 里新增的连接，dsh web 不用重启也能用上。

### 7.2 密钥

- 存在系统钥匙串：service 是 `dsh-connector-hub`，account 是连接器 id。OAuth 值是一段紧凑 JSON：`{v, tokens: {access_token, refresh_token?, expires_at, scope?}, account?}`；API Key 连接器只存 `{v, apiKey}`。共享客户端身份和端口策略来自普通配置，不写入钥匙串，也不保存 client secret。
- Windows 不在一期范围。以后支持时要注意：Windows 的凭据管理器单条大约只能存 2.5 KB，要先实测 Notion 和 Xmind 的 token 有多大，超限时把客户端信息和 token 拆成两条存。
- macOS 的授权弹窗：Desktop 和 Desktop 自带的 CLI 是同一个 Electron 程序，不会弹框。用 npm 安装的 dsh 跑在系统 Node 上，第一次读取 Desktop 创建的条目时会弹一次，选「始终允许」后就不再弹。
- 日志和状态接口里不出现任何密钥。URL 里的查询参数一律打码。

### 7.3 不选的方案

- 按 profile 分开存：用户要在每个 profile 里各连一次。
- DSH 的 `ctx.storageDomain`：要先用 `defineDomain` 定义数据域，还要在相应插件的配置里配路由。对外部插件来说太重，而且这个接口还没稳定。

## 8. 挂载与状态

- 每个已启用的连接器在 profile 根挂载一个 mcp-client：

  ```ts
  ctx.plugin(mcpClient, {
    transport: 'streamable-http',
    serverName: id,
    url: `${gatewayOrigin}/c/${id}/mcp`,
    headers: { 'X-Connector-Hub-Key': hubKey },
    failOnStartupError: true,
  })
  ```

- 挂载逻辑全部放在 `mounts` 模块里。以后改成按会话挂载，或者加按会话开关，都只动这一个模块。
- 同名冲突：如果用户在 `cordis.yml` 里手动配置过同名的 mcp-client（比如也叫 `notion`），挂载会失败。tab 里要说明冲突的原因，并提示用户移除或改名其中一个。
- 状态综合三方面信息来判断：挂载状态、工具注册表、经网关的试连结果。显示为：连接中、已连接、需要重新授权、失败（附错误摘要）、已停用（§9.2）。
- 试连在打开 tab 时做一次，tab 打开期间每 60 秒做一次，用户也可以手动触发。tab 关着时不在后台试连。
- 启动时连不上的连接器显示「失败」，用户点「重新挂载」即可（决策 5）。已经建立的连接断开后，由 mcp-client 自带的重连处理。

## 9. 界面

「连接器」tab 注册在 Plugins 页的 `plugins.tab` 插槽里，tab 内用 `SegmentedTabs` 分成「我的」和「发现」两页，英文是 Yours / Discover。打开时，已有连接器就进「我的」，没有就进「发现」。

组件全部来自 rc.5 的 `@deepseek-ai/dsh-client-ui-primitives`，用到 `SegmentedTabs`、`Modal`、`Input`、`Button`、`Switch`、`Tag`、`StateDot`、`DisclosureRow`、`Toast`。这个包运行时与 DSH 共用，所以界面风格和深浅色都跟随 DSH。颜色用 DSH 的主题变量，不写死色值；PoC 里写死的颜色要换掉，变量名在 M1 对照 DSH 源码确定。

### 9.1 发现页

- 列出目录里的全部连接器，用响应式卡片网格（`repeat(auto-fill, minmax(320px, 1fr))`），窄屏时只有一列。
- 卡片内容：
  - 图标、名称、一句话描述、服务商（如「by Notion」）；
  - 认证方式标签：OAuth / API Key；
  - 「官方服务」标签：目录里 `official: true` 的连接器才有，表示这个 MCP 服务由服务商自己运营。
- 不做「已验证」徽章，因为我们没有审核流程。
- 卡片右上角的「+」：
  - 点击后打开添加弹窗（§9.3）；不需要认证的连接器直接添加；
  - 已添加的连接器，这里显示「已添加」，不能点。
- 页顶提示：
  - 目录拉取失败、正在用缓存或内置快照时，提示「目录可能不是最新的」，带「刷新」按钮（§5.1）；
  - 目录更新影响到已连接的连接器时，同样在页顶提示（§5.3）。
- 一期只有 4 个连接器，先不做搜索和筛选。

### 9.2 我的页

- 列表，每行显示：图标和名称、认证方式、状态、授权账号、停用开关、操作菜单。
  - 状态：已连接、连接中、失败、需要重新授权、已停用，用 `StateDot` 加文字表示。
  - 授权账号只有 OAuth 连接器才有，手机号要打码（§6.2）。
- 操作：
  - 「重新挂载」：失败时直接显示在行内，菜单里也有（决策 5）。
  - 「重新授权」（OAuth）/「更换 Key」（API Key）：打开添加时的同一个弹窗。
  - 「删除」：确认后卸载 mcp-client、删除钥匙串条目、从 `connectors.json` 里移除。OAuth 连接器还会顺带尽力吊销 token（§6.2）。
- 停用开关：
  - 关闭时卸载 mcp-client，凭据保留，`enabled` 改为 `false`；重新打开时再挂载；
  - 一期连接器挂在 profile 根，工具出现在所有会话里。停用是一期里临时去掉某个连接器工具的唯一办法。
- 展开一行（`DisclosureRow`）可以看到：
  - 工具列表，也就是模型能看到的工具名；
  - 服务地址，查询参数打码；
  - 最近一次错误，以及最近一次试连的时间。
- 还没有连接器时显示「还没有添加连接器」，带一个跳到「发现」页的按钮。

### 9.3 添加和授权弹窗

弹窗用 `Modal`。只有授权或试连成功后，连接器才写入 `connectors.json` 并挂载。用户取消或者失败了，什么都不留下，不会出现没有凭据、挂载失败的半成品连接器。

API Key：

- 弹窗内容：Key 输入框（密码样式，可以切换显示），以及「如何获取」链接（目录里的 `helpUrl`）。
- 点「保存并连接」后，Host 经网关试连（§6.1）。
  - 通过：存进钥匙串、写入配置、挂载，弹窗显示成功后关闭；
  - 失败：弹窗不关，显示服务商返回的错误摘要，Key 不保存。
- 「更换 Key」用的是同一个弹窗，新 Key 试连通过后才替换旧的。

OAuth：

1. 弹窗说明将打开哪个服务商的授权页，按钮是「前往授权」。
2. 点击时先同步打开一个空白窗口，再向 Host 要授权地址，拿到后让这个窗口跳转过去。浏览器只允许在点击事件里同步打开新窗口，如果先发请求、拿到地址再打开，会被拦截。Desktop 里的行为待 M0 验证。
3. 弹窗变成「等待授权…」，带「复制链接」（新窗口没打开时用）和「取消」。浏览器端轮询授权状态。
4. Host 收到回调、换到 token 后，弹窗显示成功和授权账号，然后关闭。失败或超过 10 分钟未完成，弹窗显示原因和「重试」按钮。

### 9.4 提示文案

- 添加、删除、停用会立即改变所有会话能用的工具，包括正在进行的会话，DSH 会把变化告诉模型。添加成功和停用时，用 `Toast` 提示一次。
- 连接在所有 profile 之间共用（§7.1），在 Desktop 里删除或停用，dsh web 里也会生效。删除确认框里写明这一点。

### 9.5 Host 接口

接口路径都在 `/api/connector-hub/` 下，都是只有已登录的本机用户能访问的路由。带参数的接口一律用 POST 和 JSON 请求体。

| 路径 | 方法 | 作用 |
|---|---|---|
| `catalog` | GET | 返回目录，以及来源（网络、缓存或内置快照）和拉取时间 |
| `catalog-refresh` | POST | 立即重新拉取目录 |
| `connectors` | GET | 已添加的连接器，含状态、授权账号、工具、最近一次错误 |
| `api-key-connect` | POST | `{id, key}`：试连通过后保存并挂载；更换 Key 也用这个接口 |
| `oauth-start` | POST | `{id}`：返回授权地址和本次授权的 `attemptId` |
| `oauth-status` | POST | `{attemptId}`：返回等待中、成功或失败 |
| `oauth-cancel` | POST | `{attemptId}` |
| `remount` | POST | `{id}` |
| `set-enabled` | POST | `{id, enabled}` |
| `probe` | POST | `{id}`：立即试连 |
| `remove` | POST | `{id}`：卸载、删除钥匙串条目、从配置里移除、尽力吊销 token |

接口只接受目录里的连接器 id，不接受 URL：连接器地址只能来自目录（§5.3），浏览器端不能指定凭据发往哪里。

## 10. 以后加按会话开关

结论：改动是增量的，一期的挂载方式不用推翻。

- 隐藏工具：在 `agent/created` 事件里，对关闭了某连接器的会话调用 `agent.ctx.tools.restrict({ deny: [该连接器的工具名] })`。它只影响这一个会话，连接本身仍然全局共用一条。rc.3 到 rc.5 都有这个事件和接口。
- 坑：`restrict()` 不接受当前未注册的工具名，会直接报错。所以要等连接器连上后再执行，重新挂载或工具列表变化后还要重新执行。
- 持久化：在 `connectors.json` 里按会话 id 记录开关状态，`schemaVersion` 加 1。工具集的变化 DSH 本身会写进会话日志，不需要我们另外记录。
- 界面：在会话页放开关，需要一个会话界面的插槽，外部插件能用哪个还没确认。退路是在「连接器」tab 里列出各会话，在那里开关。
- 不推荐每个会话单独连接（在 `agent.ctx` 里挂载 mcp-client）：每个会话都要建一条连接，开销大，状态也更难管。

## 11. 工程结构

```
dsh-connector-hub/              pnpm 工作区，Node 24
├─ packages/connector-hub/      npm 包 dsh-connector-hub
│  ├─ src/host/                 index（apply）、catalog、store、secrets、oauth、gateway、mounts、health、routes
│  ├─ src/client/               tab 注册、页面组件、接口调用、语言包（中、英）
│  ├─ src/shared/               两端共用的路由路径和 JSON 类型
│  ├─ cordis.patch.yml          - insert: [ { id: connector-hub, name: dsh-connector-hub } ]
│  ├─ build.mjs                 esbuild：Host 输出 ESM，浏览器端输出包了 __ModuleLoader__ 外壳的 CJS
│  └─ tsconfig.json
├─ catalog/                     目录源文件、JSON Schema、构建和发布脚本
├─ test/                        端到端冒烟测试、模拟 MCP 服务、模拟 OAuth 授权服务器
├─ poc/                         一期发布前保留作参考，之后删除
├─ docs/design.md               本文
└─ .github/workflows/           ci、release（发 npm）；代码仓库推到 GitHub 后再加
```

- 目录发布：一期用本地脚本，校验、构建后写进 `../looori.github.io/dsh-connector-hub/catalog/v1/`，在那个仓库里提交并推送。代码仓库推到 GitHub 后，再改成由 CI 用 deploy key 推送到站点仓库。

- `package.json`：
  - `exports` 是 `.`（Host）、`./client`（浏览器端）和 `./package.json`；
  - `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client` 和 PoC 一样；
  - `engines.dsh` 写 `>=0.2.1-rc.5 <0.3.0`。
- 依赖：
  - 运行时必须和 DSH 共用同一份的包，声明为可选 peer 依赖：`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-home-paths`；
  - 普通依赖：`@modelcontextprotocol/client`，版本和 DSH 一致，用 2.2.0；`@napi-rs/keyring`。
- 类型：devDependencies 引入 `@deepseek-ai/dsh-*@0.2.1-rc.5` 和 `@deepseek-ai/cordis@4.0.5`，用真实类型替换 PoC 里手写的接口。CI 里跑 `tsc --noEmit`。
- 浏览器端：CSS modules 和静态资源还没验证，一期只用内联样式和 `@deepseek-ai/dsh-client-ui-primitives`。共享模块列表照抄 DSH 的 `PLATFORM_MODULES`。
- README 和 `description` 里写明：这是社区插件，不是 DeepSeek 官方产品。

## 12. 测试

1. **单元测试（vitest，不依赖 DSH）**
   - 目录：Schema 校验、解析、不认识的字段和认证类型；
   - store：原子写、`schemaVersion` 迁移、对账；
   - 网关：鉴权、请求头过滤、流式转发（含 SSE）、401 后刷新再重试、4 MB 上限；
   - OAuth：用模拟授权服务器测 CIMD／共享客户端注入、禁止每实例动态注册、随机与固定端口、PKCE、`state` 和 `iss` 校验、refresh token 轮换；
   - 跨进程锁：两个进程同时刷新时，只发出一次刷新请求；
   - 状态判定；
   - 接口：只接受目录里的 id，拒绝未知 id 和多余字段；试连失败时不写配置、不存 Key；
   - 钥匙串在测试里换成内存实现。
2. **端到端冒烟测试（自动，在 CI 里跑）**
   - 用 npm 上的 `@deepseek-ai/dsh`，测试矩阵是 `0.2.1-rc.5` 加 `next`，跑在 GitHub Actions 的 macOS 机器上。
   - 每次用临时的 `DSH_HOME`，不碰真实数据。
   - 流程：
     1. 启动模拟服务：复用 `poc/test-server`，再加一个带 OAuth 的版本和一个用 API Key 鉴权的版本；
     2. 依次执行 `dsh plugin --profile <临时 profile> add <包目录>` 和 `dsh web --port 0 --no-open`，用打印出的 token 地址取得 cookie；
     3. 调插件接口，断言：连接成功、工具名正确、重新挂载后名字不变、token 过期后能自动刷新、停用后工具消失而凭据还在、删除后工具和凭据都消失。
   - 再用 Playwright 打开「连接器」tab 做界面冒烟：在「发现」页点「+」添加用 API Key 鉴权的模拟连接器，在「我的」页看到「已连接」，然后停用、启用、删除；再走一遍取消添加，确认什么都没留下。
   - 不调用真实模型，也不连真实服务商。
3. **Desktop 手动检查清单（每个版本做一次）**
   - 在 Plugins 页从 npm 安装插件；
   - 在「发现」页依次添加 Notion、Xmind、高德、百度、腾讯文档，各让模型调用一次工具；
   - 在「我的」页停用一个连接器，确认新消息里模型看不到它的工具；再启用，工具恢复；
   - 用调试开关让 Xmind 的 token 提前过期，确认能自动刷新；
   - 同时打开 dsh web，确认两边都能用，并且没有互相作废 token；
   - 删除连接器，确认钥匙串条目已删除。

调试开关（比如让 token 提前过期）只在开发构建里提供，发布包里没有。

## 13. 一期里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| M0 spike | ⓪ 在 rc.5 的 Desktop 和 dsh web 上重跑 PoC 冒烟；① Notion、Xmind 的共享公共客户端、回调端口、授权与刷新；② Desktop 的 `window.open`；③ 网关转发 Streamable HTTP（含 SSE）及 DSH 代理 | 每项有结论，写回本文 |
| M1 骨架 | 工作区、真实类型、目录格式和 4 个条目、目录构建和发布脚本、store、secrets、网关 | 单元测试通过，Pages 上能拉到目录 |
| M2 API Key | 「我的」「发现」两页和添加弹窗；高德、百度、腾讯文档端到端打通：添加、试连、挂载、调用、停用、删除 | 端到端冒烟通过，Desktop 手动验证通过 |
| M3 OAuth | Notion、Xmind：授权、刷新、跨进程锁、需要重新授权的处理、删除时吊销 | 同上，再加上 token 过期后自动刷新 |
| M4 发布 | 界面打磨、中英文、CI 矩阵、README，发布 `dsh-connector-hub@0.1.0` | 按检查清单从 npm 安装验证通过 |

## 14. 待定事项

当前无待定事项。

## 附录 A：第一批连接器

来源：用户提供的连接器清单、2026-10-29 实测的公开元数据，以及 2026-11-02 至 2026-11-03 的 M0 真实授权结果。目录里不放任何 Key、token 或 secret；公开客户端身份除外。

| id | 名称 | MCP 地址 | 认证 | 要点 |
|---|---|---|---|---|
| `notion` | Notion | `https://mcp.notion.com/mcp` | OAuth | CIMD＋随机 loopback 端口；`token_endpoint_auth_method: none`；scope 留空；回调带 `iss`；有吊销接口；M0 授权、刷新及 MCP 试连通过 |
| `xmind-cn` | Xmind（中国版） | `https://app.xmind.cn/api/mcp` | OAuth | 一次注册的共享公共客户端＋固定端口 `43118`；scope 为 `openid mcp:connect`；回调不带 `iss`；M0 授权、refresh token 轮换及 MCP 试连通过；授权账号名取自 `id_token` |
| `amap` | 高德地图 | `https://mcp.amap.com/mcp` | API Key，放在查询参数 `key` | 没带 Key 时返回 HTTP 200 加 `INVALID_USER_KEY`，不是 JSON-RPC 响应 |
| `baidu-map` | 百度地图 | `https://mcp.map.baidu.com/mcp` | API Key，放在查询参数 `ak` | 没带 Key 时返回 400 `ak is required` |
| `tencent-docs` | 腾讯文档 | `https://docs.qq.com/openapi/mcp` | API Key，放在 `Authorization` 请求头 | 配置来自用户提供；真实鉴权与工具调用待 Desktop 验收 |

补充说明：

- **Notion：** 授权地址是 `https://mcp.notion.com/authorize`，Token 地址是 `https://mcp.notion.com/token`，Issuer 是 `https://mcp.notion.com`，受保护资源是 `https://mcp.notion.com/mcp`。CIMD 是 `https://looori.github.io/dsh-connector-hub/oauth/notion/client.json`。这套授权是 `mcp.notion.com` 自己的，和 notion.so「My integrations」里创建的集成凭证不通用。
- **Xmind（中国版）：** 授权地址是 `https://app.xmind.cn/oauth/consent`，Token 地址是 `https://app.xmind.cn/api/oauth/token`，Issuer 是 `https://app.xmind.cn`。共享公开 `client_id` 是 `CIul0o4i8rMwnA`，登记回调是 `http://127.0.0.1:43118/oauth/callback/xmind-cn`。scope 必须写在目录里：受保护资源元数据里只列了 `mcp:connect`，SDK 自动选择 scope 时不会带上 `openid`，那样就拿不到账号名。中国版和国际版账号不互通，MCP 地址、授权服务器和客户端必须来自同一个区。
- **Key 申请入口（`helpUrl`）：** 高德是 `https://console.amap.com/dev/key/app`，未登录时会先跳到 `lbs.amap.com` 登录；百度是 `https://lbsyun.baidu.com/apiconsole/key`；腾讯文档使用官方 MCP 指南 `https://docs.qq.com/open/document/mcp/`。
