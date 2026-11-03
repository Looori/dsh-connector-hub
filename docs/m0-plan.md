# M0 实现方案

- 日期：2026-11-02
- 状态：已完成技术验证、用户验收与提交（2026-11-03）
- 目标版本：DeepSeek Harness 0.2.1-rc.5
- 本文定义 M0 的验证实施方式，并在文末记录实测结论。服务商的共享客户端、CIMD 和 loopback 端口能力均以真实验证结果为准。

## 1. 本次调整后的目标方案

OAuth 采用以下方向：

1. **共享公共客户端**：每个服务商一个客户端，所有用户共用公开的 `client_id`；`token_endpoint_auth_method` 为 `none`，不制作、分发或保存共享 `client_secret`。
2. **随机 loopback 端口优先**：服务商允许同一客户端改变 loopback 端口时，每次授权直接绑定 `127.0.0.1:0`，使用实际分配到的端口。
3. **固定端口只作兼容退路**：服务商要求完整回调地址精确匹配时，使用该客户端登记的固定端口；端口被占用时明确报错，不用同一客户端尝试随机端口，也不静默创建新客户端。
4. **Notion 优先验证 CIMD**：使用 GitHub Pages 上公开的客户端 ID 元数据文档，以文档 HTTPS URL 作为 `client_id`，避免动态注册。
5. **Xmind 验证共享公共客户端**：优先使用有明确管理归属的预注册方式；若只能调用动态注册接口，则只创建一次供所有实例共用的公共客户端，执行前仍需用户批准。
6. 授权码 + PKCE、`state`、token 刷新和本机钥匙串存储保持不变。共享客户端不等于共享用户授权，任何用户的 token 都不离开自己的机器。

回调路径按服务商隔离：

```text
http://127.0.0.1:<端口>/oauth/callback/notion
http://127.0.0.1:<端口>/oauth/callback/xmind-cn
```

每次授权必须保存并使用本次实际的完整 `redirect_uri`；授权请求和授权码换 token 时保持一致。

## 2. 已有验证结果

| 项目 | 当前结果 | 证据与限制 |
|---|---|---|
| rc.5 dsh web Host 冒烟 | 已通过 | 未登录路由返回 401；钥匙串写入、读取、删除成功；MCP 连接和试连成功；卸载时工具消失，重挂后 `mcp__pocdemo__echo`、`mcp__pocdemo__whoami` 名称不变 |
| rc.5 dsh web UI | 已通过 | 内置浏览器实测 Plugins 页出现 Connectors tab；会话能看到两个 PoC 工具；界面上的重挂和钥匙串按钮均返回成功 |
| 本地凭据网关 | 已通过 | 未带密钥返回 403，未知路径返回 404；POST、GET/SSE、DELETE 均成功转发；重挂后工具名稳定 |
| DSH 出网代理 | 已通过 | 上游使用本机非 loopback 地址，所有上游请求均由模拟 HTTP 代理收到；loopback 的 mcp-client → 网关请求不经过代理 |
| DELETE 的调用方行为 | 已记录限制 | rc.5 的 mcp-client 在卸载时没有主动发出 DELETE；DELETE 转发是使用当前 MCP 会话直接请求网关验证的 |
| rc.5 Desktop 冒烟 | 已通过 | 已连接；三个会话均可见两个 PoC 工具；试连 HTTP 200；钥匙串写入、匹配、删除及删除后不存在均成功；重挂时工具清空，重挂后名称不变 |
| Desktop `window.open` | 已通过 | 用户确认由系统 Chrome 打开 `example.com` |
| Notion CIMD 与随机端口 | 已通过 | CIMD 已发布并采用；动态注册 0；真实随机端口授权、token 交换、刷新及刷新前后 MCP 试连通过 |
| Xmind 共享客户端与固定端口 | 已通过 | 公共客户端只注册一次；随机端口在登录时被拒绝；固定 `43118` 的授权、token 交换、refresh token 轮换及刷新前后 MCP 试连通过；占用时在打开授权页前报错 |

现有可重复脚本：

```bash
cd poc
node m0/web-smoke.mjs
node test-server/m0-gateway-smoke.mjs
node m0/oauth-local.mjs
node m0/oauth-notion.mjs probe
node m0/oauth-xmind.mjs probe --fixed
node m0/oauth-xmind.mjs busy --fixed
```

前三个脚本会启动并清理自己的临时进程，不调用真实模型或真实服务商。`probe` 只访问真实授权端点，不登录、不保存 token；完整真实授权分别用 `node m0/oauth-notion.mjs full` 和 `node m0/oauth-xmind.mjs full --fixed`，需要用户在系统浏览器操作。Xmind 的公开客户端信息保存在 `m0/xmind-client.json`，`register` 命令会拒绝覆盖它，避免重复创建外部客户端。

## 3. 剩余工作 A：Desktop 冒烟与授权窗口

### 3.1 准备

1. 重新构建 PoC。
2. 启动 `poc/test-server`，确认 `http://127.0.0.1:3988/mcp` 可用。
3. 用户启动 Desktop；如需退出、重启或修改 desktop profile，先征得用户同意。

### 3.2 用户验收清单

在 Plugins → Connectors 中：

- tab 能打开，状态为「已连接」；
- 全局和会话工具均包含 `mcp__pocdemo__echo`、`mcp__pocdemo__whoami`；
- 「测试钥匙串读写」返回 `ok: true`，且测试条目已删除；
- 「重新挂载」返回 `sameNames: true`，`afterDispose` 为空，重挂后的工具名不变；
- 点击「M0 测试 window.open」，记录返回值以及实际打开方式：系统浏览器、Desktop 内嵌窗口或被拦截。

### 3.3 完成标准

- 冒烟各项有通过／失败结论；
- `window.open` 的实际行为明确；
- 如果被拦截，一期界面保留「复制授权链接」退路；如果能打开，确认使用系统外部浏览器，而不是把 OAuth 登录嵌进可控 WebView。

## 4. 剩余工作 B：OAuth spike 测试夹具

新增或调整 `poc/m0/` 下的验证脚本，复用 SDK 的 `auth()`，不自行实现授权码、PKCE 或刷新流程。

### 4.1 两种共享客户端注入方式

- **Notion CIMD**：provider 设置 `clientMetadataUrl`。当前 `@modelcontextprotocol/client` 2.2.0 已确认支持该属性；当授权服务器声明 `client_id_metadata_document_supported: true` 且没有已保存客户端时，SDK 使用元数据 URL 作为 `client_id`，跳过动态注册。
- **预注册共享客户端**：provider 的 `clientInformation()` 返回预置的公开 `client_id`，SDK 不再进入动态注册分支。

测试使用全新的内存 provider，避免旧客户端信息让测试误走动态注册或掩盖 CIMD 行为。

### 4.2 loopback 回调服务

- 直接调用 `listen(0, '127.0.0.1')`，不先检查再监听，避免竞态；
- 只在授权期间运行，完成、取消、失败或 10 分钟超时后关闭；
- 校验 `state`、实际接收回调的地址以及服务商提供的 `iss`；
- 一次回调只能使用一次，不接受其他路径；
- 日志只记录状态、HTTP 状态码和脱敏错误，不记录授权码、PKCE verifier、token、refresh token 或完整查询字符串。

### 4.3 授权页处理

自动探测阶段只捕获 `redirectToAuthorization` 的 URL，不自动登录。需要完整授权时，再由用户在系统浏览器打开授权页并完成登录；脚本不得读取用户浏览器密码或 cookie。

## 5. 剩余工作 C：Notion CIMD 验证

### 5.1 准备元数据文档

1. 在站点仓库为 Notion 准备一份稳定的 HTTPS 元数据文档，放在 `dsh-connector-hub/` 下的非根路径。
2. 文档至少包含公开客户端身份、客户端名称和回调地址；不包含任何 secret。
3. 本地校验 JSON、HTTPS URL、内容类型和公开可访问性。
4. 发布到 GitHub Pages 属于对外操作，执行前由用户批准。

### 5.2 验证项目

按顺序执行，前一步不通过就不继续：

1. **CIMD 被采用**：捕获授权 URL，确认 `client_id` 等于元数据文档 URL，并确认没有调用动态注册接口。
2. **随机端口回调**：使用随机端口完成授权码 + PKCE + token 交换，确认 access token 能用于 MCP initialize 和 tools/list。
3. **换端口复用**：同一元数据文档、同一客户端，在另一随机端口发起授权；若初次授权页即拒绝，记录精确匹配限制；若接受，至少完成一次完整回调和 token 交换。
4. **token 刷新**：在本地测试 token 保存和刷新调用，不输出 token；确认刷新后仍使用同一共享客户端。
5. **失败处理**：记录 CIMD 拉取失败、回调不匹配、用户取消和超时，确保不留下半成品配置。

### 5.3 端口结论与退路

- 若随机端口完整流程通过：Notion 定为随机端口优先，不再验证固定端口主流程。
- 若只接受固定端口：元数据文档登记固定 loopback 地址，再验证完整流程；另用本机进程占用该端口，确认插件在打开授权页前给出明确错误。
- 若 Notion 的 CIMD 本身不可用：退回「Notion 预注册共享公共客户端」，仍按相同的端口矩阵验证；创建外部客户端前需用户批准。
- 只有共享客户端和固定端口都行不通时，才重新讨论每实例动态注册或固定 HTTPS 回调中转，不在 M0 默认实现这两条分支。

## 6. 剩余工作 D：Xmind 共享公共客户端验证

### 6.1 创建与分发边界

1. 优先通过服务商正式入口预注册公共客户端；若没有管理入口，才考虑调用动态注册接口创建一次共享客户端。
2. 创建前明确告知用户回调地址和客户端名称，并取得同意。
3. 测试脚本只读取公开的 `client_id`；如出现注册管理凭证或 `client_secret`，不得写进仓库、目录、日志或测试输出。
4. 一期仍按 `scope: openid mcp:connect` 验证。

### 6.2 验证项目

- 共享客户端在随机 loopback 端口完成授权码 + PKCE + token 交换；
- 换另一随机端口后，同一客户端是否仍被接受；
- 使用所得 token 完成 MCP initialize 和 tools/list；
- 刷新 token 后新 access token 可用，新 refresh token 能正确写回本机存储；不在 M0 输出或提交真实 token；
- 若只能固定端口，验证固定端口完整流程以及被占用时的明确错误；
- Desktop 和 dsh web 不共享回调服务，分别启动授权时也必须遵守上述端口策略。

## 7. 端口策略判定矩阵

| 服务商实测结果 | M0 结论 | 运行时行为 |
|---|---|---|
| 同一共享客户端接受任意 loopback 端口 | 支持变端口 | 默认且直接使用随机端口，不先尝试固定端口 |
| 只接受登记的完整 loopback URI | 不支持变端口 | 使用固定端口；绑定失败时明确提示端口被占用 |
| 共享客户端本身不可用 | 方案不成立 | 回到设计讨论，不自动退回每实例注册 |
| CIMD 不可用但共享公共客户端可用 | 仅替换客户端提供方式 | 使用预注册共享客户端，端口策略不变 |

端口策略是按服务商固化的兼容配置，不作为普通用户设置，也不依赖授权失败后再盲目重试。

## 8. 执行顺序与权限边界

1. 完成 Desktop 冒烟和 `window.open` 验证。
2. 完成 OAuth 本地测试夹具和模拟回调单测，不访问真实服务商。
3. 经用户批准后发布 Notion CIMD 文档，执行 Notion 验证。
4. 经用户批准后创建 Xmind 共享客户端，执行 Xmind 验证。
5. 真实账号登录、授权页面操作和 Desktop 界面验收由用户完成；其余脚本、请求构造、结果整理和文档更新由 Agent 完成。
6. 不退出或重启 Desktop、不推送站点仓库、不创建外部客户端，除非当次已取得用户同意。

旧每实例动态注册探针 `poc/m0/oauth-registration.mjs` 从未执行，已在 M0 收尾删除；保留的 `oauth-local.mjs`、`oauth-notion.mjs` 和 `oauth-xmind.mjs` 均验证共享客户端流程。

## 9. M0 退出条件

以下条件全部满足，M0 才算完成：

- rc.5 的 dsh web 和 Desktop 冒烟均有结论；
- Desktop `window.open` 行为明确，授权页打开方式或复制链接退路确定；
- Notion 的 CIMD 是否可用有结论；
- Notion、Xmind 的共享公共客户端是否可用均有结论；
- 两家分别确定随机端口或固定端口策略；固定端口占用错误已实测；
- 至少对最终选定的每家流程完成一次真实授权、token 交换和 MCP 试连；若流程涉及刷新，刷新路径有结论；
- 网关转发和 DSH 代理结果保持通过；
- 将结论写回 `docs/design.md`、`docs/progress.md`，必要时在 `docs/decisions.md` 新增替代旧动态注册决策的记录；
- 清理临时进程和测试凭据，确认仓库及日志中没有 token、secret、注册管理凭证或带敏感查询参数的授权 URL；
- 用户验收后，以 `M0: ...` 开头提交。
