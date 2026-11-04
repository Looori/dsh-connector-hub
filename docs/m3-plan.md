# M3 OAuth 实施方案

- 日期：2026-11-04
- 状态：已完成实现、自动测试、真实验收与提交（2026-11-04）
- 目标版本：DeepSeek Harness 0.2.1-rc.5
- 依据：`docs/design.md` §4、§6.2、§7、§9、§11、§12，以及 M0 的真实 OAuth 验证结论
- 目标：为 Notion、Xmind（中国版）实现完整 OAuth 生命周期，包括授权、试连、挂载、自动刷新、跨进程协调、重新授权、停用、删除和吊销

## 1. 范围与边界

### M3 交付

1. 基于 MCP SDK 的授权码 + PKCE 流程，以及服务商元数据发现。
2. 所有用户共享公共客户端；Notion 使用 CIMD，Xmind 使用预注册公开 `clientId`。
3. 按服务商固化的 loopback 回调策略：Notion 随机端口，Xmind 固定端口 `43118`。
4. 授权事务：候选 token 先试连，成功后才保存并挂载；失败、取消和超时不留下半成品。
5. 网关内自动刷新、401 后刷新并重试一次，以及 Desktop／dsh web 跨进程刷新锁。
6. 授权账号提取与手机号打码、`invalid_grant` 后重新授权、删除时尽力吊销。
7. Desktop 与 dsh web 共用的 OAuth 弹窗和 Host 路由。
8. 单元、集成、真实 DSH 路由与浏览器端到端测试，以及真实服务商验收。

### 明确不在 M3

- 每实例动态注册客户端，或分发、保存共享 `client_secret`。
- 修改 DSH 本体，或给 rc.5 的 mcp-client 增加 `authProvider`。
- 刷新 token 后重新挂载 MCP；刷新必须对模型可见的工具集透明。
- 新增 OAuth 服务商、按会话开关、工具调用审批或远程 OAuth 回调中转。
- npm 发布与从 npm 安装验收，这部分属于 M4。

## 2. 核心实现方案

### 2.1 共享公共客户端与目录配置

每个服务商只使用一个公开客户端身份，`token_endpoint_auth_method` 固定为 `none`。客户端身份属于普通目录配置，不是密钥；用户 token 只保存在各自机器的 Keychain 中。

| 服务商 | 客户端提供方式 | 回调端口 | 回调路径 |
|---|---|---|---|
| Notion | `clientMetadataUrl` 指向 GitHub Pages 上的 CIMD | 随机端口，直接监听 `127.0.0.1:0` | `/oauth/callback/notion` |
| Xmind | 目录中的预注册公开 `clientId` | 固定 `43118` | `/oauth/callback/xmind-cn` |

运行时通过 SDK 的 `OAuthClientProvider` 注入客户端身份。授权与刷新链路的 fetch 守卫都拒绝 `/register`、`/registration` POST，禁止意外进入动态注册分支。保存客户端信息时还会核对公开身份，并拒绝包含 `client_secret` 的值。

端口策略不在失败后盲目切换。Xmind 固定端口被占用时，在打开授权页前返回明确的 409 错误。

### 2.2 授权生命周期

`OAuthManager` 只把授权尝试保存在内存中，每次尝试包含独立的 `attemptId`、provider、回调服务、取消控制器、状态和定时器。

1. `oauth-start` 从目录或现有配置构造候选连接器，同一连接器已有等待中或完成中的授权时拒绝重复启动。
2. 先监听 loopback 回调端口，再调用 SDK `auth()` 完成资源与授权服务器发现、PKCE 和授权地址生成。
3. 授权请求与换 token 使用完全相同的实际 `redirect_uri`，并附加目录声明的 `authorizationParams`。
4. 回调仅接受匹配路径的 GET；使用恒定时间比较校验 `state`，拒绝缺失、错误和重放回调，并把服务商返回的 `iss` 交给 SDK 校验。
5. SDK 换取 token 后，Host 先从 token 响应提取可选账号信息，再进入候选凭据提交流程。
6. 成功回调返回「已连接，可以关闭此页」；授权完成、取消、失败或 10 分钟超时后均关闭临时回调服务。
7. 回调正在完成时禁止取消，避免取消与提交并发破坏状态。

授权状态只向浏览器返回 `waiting`、`success`、`failed` 和安全错误摘要，不返回 token、授权码或 PKCE verifier。

### 2.3 候选凭据事务与回滚

OAuth 与 API Key 共用 `ConnectorHubService` 的串行事务边界：

1. 使用候选 token 经独立网关执行 MCP `initialize + tools/list`，此时不覆盖已有凭据和配置。
2. 试连成功后，才写入 Keychain、更新 `connectors.json` 并挂载 mcp-client。
3. 新增授权失败时，删除候选凭据并清除候选配置。
4. 重新授权失败时，恢复旧配置、旧凭据和旧挂载，保证原连接不被失败的重新授权破坏。
5. 挂载返回失败也视为事务失败，不允许留下「已保存但不可用」的连接。
6. 删除时先取消等待中的授权，再卸载、删除 Keychain 条目和配置；最后在本地状态清理完成后尽力吊销 token，吊销失败不影响删除。

### 2.4 自动刷新与跨进程协调

mcp-client 始终连接本地凭据网关，因此刷新不需要改变其 URL 或静态请求头，也不需要重挂。

- 网关每次读取 OAuth 凭据时，如果 access token 距过期不足 5 分钟且存在 refresh token，则先刷新再转发。
- 上游返回 401 时，使用已缓存且不超过 4 MiB 的请求体，在刷新后用原请求体重试一次。
- 刷新前取得 `$DSH_HOME/connector-hub/locks/<id>.lock` 独占文件锁；锁文件权限为 `0600`，记录 pid 和创建时间，超过 30 秒视为陈旧锁。
- 拿到锁后重新读取 Keychain。如果 access token 已被另一个进程更新，直接复用新凭据，避免 Desktop 与 dsh web 使用同一个旧 refresh token 重复刷新。
- 刷新成功后立即保存返回的新 access token、过期时间及可能轮换的新 refresh token，并保留授权账号信息。
- refresh token 缺失、access token 被拒且无法刷新，或服务商返回 `invalid_grant` 时，将连接标记为「需要重新授权」并异步卸载；旧凭据保留，重挂和启用被阻止，直至重新授权成功。
- 重新授权状态回调与挂载串行队列分离，避免在挂载队列内等待卸载而造成死锁。

### 2.5 账号显示与吊销

- Notion 从 token 响应中的工作区和用户信息提取展示账号。
- Xmind 请求 `openid mcp:connect`，从 `id_token` 的 `name` 提取展示账号。
- 账号仅用于显示，不参与安全判断；手机号只显示前 3 位和后 4 位。
- 删除时重新发现授权服务器元数据；存在 `revocation_endpoint` 才发起吊销，优先使用 refresh token，否则使用 access token，并携带公共 `client_id`。
- 吊销请求有 10 秒超时，失败被刻意忽略，确保本机工具、配置和 Keychain 清理不被外部服务阻塞。

## 3. Host 接口与界面

### 3.1 新增路由

| 路径 | 方法 | 作用 |
|---|---|---|
| `/api/connector-hub/oauth-start` | POST | `{id}`：启动授权，返回 `attemptId` 和授权地址 |
| `/api/connector-hub/oauth-status` | POST | `{attemptId}`：查询等待、成功或失败状态 |
| `/api/connector-hub/oauth-cancel` | POST | `{attemptId}`：取消等待中的授权 |

路由沿用已登录本机用户边界，只接受目录中的连接器 id，不接受浏览器传入上游 URL。

### 3.2 OAuth 弹窗

- 「发现」页启用 OAuth 添加，「我的」页启用「重新授权」并显示打码账号。
- 用户点击「前往授权」时先同步打开 `about:blank`，再请求 Host 获取授权地址并跳转，避免浏览器弹窗拦截。
- 等待阶段显示「等待授权…」，提供「复制链接」和「取消」；轮询使用重叠请求保护。
- 成功后刷新连接器列表、显示授权账号和成功 Toast，再关闭弹窗及授权窗口。
- 失败或超时显示安全错误摘要并允许重试。
- 成功回调使用稳定引用，列表刷新不会导致重复完成授权或重复 Toast。
- 文案覆盖中英文；token 不进入浏览器组件状态。

## 4. 模块划分

| 模块 | 职责 |
|---|---|
| `src/host/oauth.ts` | 共享客户端 provider、授权尝试、loopback 回调、PKCE 生命周期、取消与超时 |
| `src/host/oauth-refresh.ts` | 主动／401 刷新、跨进程文件锁、轮换 token 保存、重新授权信号与吊销 |
| `src/host/oauth-account.ts` | Notion／Xmind 账号提取和手机号打码 |
| `src/host/gateway.ts` | 转发前取得有效凭据，401 后刷新并重放原请求 |
| `src/host/service.ts` | 授权事务、试连、回滚、重新授权状态、启停和删除 |
| `src/host/routes.ts` | OAuth 路由及请求校验 |
| `src/client/ConnectorHub.tsx` | OAuth 弹窗、授权窗口、状态轮询、重新授权与账号展示 |
| `src/client/api.ts`、`locales.ts` | 浏览器 API 封装和中英文文案 |
| `scripts/expire-oauth.mjs` | 开发专用真实验收辅助：只把本地 `expires_at` 提前，不修改或打印 token；不进入 npm 发布包 |

## 5. 实施顺序与提交

| 步骤 | 内容 | 提交 |
|---|---|---|
| ① | OAuth 授权核心、回调服务、候选试连与事务回滚 | `0cf7ba4 M3: add OAuth authorization lifecycle` |
| ② | 自动刷新、401 重试、跨进程锁、账号与吊销 | `a15a997 M3: add OAuth token refresh and revocation` |
| ③ | OAuth 弹窗、轮询、取消、重试与重新授权界面 | `88a7f00 M3: add OAuth authorization UI` |
| ④ | 真实 DSH 路由与无头浏览器端到端覆盖 | `31d385e M3: add OAuth end-to-end coverage` |
| ⑤ | 开发专用过期验收工具及进度记录 | `c08f9c2 M3: add OAuth expiry acceptance helper` |
| ⑥ | 真实验收完成与里程碑收尾 | `ae11696 M3: complete OAuth acceptance` |

每一步都先完成验证再提交；未把真实 token、授权 URL、Keychain 导出、`.dsh/` 或临时诊断文件纳入提交。

## 6. 测试与真实验收

### 6.1 自动测试边界

- 单元和集成测试使用临时 `DSH_HOME`、内存凭据和本地模拟授权／MCP 服务。
- 端到端测试使用真实 DSH Host／web 路由及无头 Chrome，但不访问真实服务商、真实 Keychain 或真实模型。
- 授权测试覆盖：禁止动态注册、固定端口占用、state 重放、取消、超时、试连失败、挂载回滚和重新授权保留旧状态。
- 刷新测试覆盖：5 分钟窗口、401 原体重试、锁内重读、跨进程复用、refresh token 轮换、`invalid_grant` 卸载与重新授权。
- 浏览器端到端覆盖：授权、账号展示、刷新时挂载代次与工具名稳定、重新授权、停用／启用、删除与吊销。

最终全量结果：19 个测试文件、126 项测试全部通过，`pnpm typecheck` 和 `pnpm build` 通过。

### 6.2 真实验收结果

- [x] Notion、Xmind 分别在 Desktop 完成真实授权、试连和真实模型工具调用。
- [x] 使用开发专用脚本将本地过期时间提前后，两者试连均自动刷新且无需重新授权。
- [x] 按 Desktop → dsh web → Desktop 顺序分别调用两连接器，均正常返回，未互相使 refresh token 失效。
- [x] 停用后工具消失，重新启用后恢复。
- [x] 在 dsh web 删除两连接器后，Keychain 中对应条目均消失。

## 7. 完成结论与后续衔接

M3 于 2026-11-04 完成。实现保持了 M0 确定的共享公共客户端、端口策略和本地凭据网关方案，没有改变一期既定范围；`docs/progress.md` 已记录最终状态。

下一阶段为 M4 发布：在新会话先对齐 npm 发布、版本与包内容检查、从 npm 安装及真实环境验收，不在 M3 收尾中提前执行发布。
