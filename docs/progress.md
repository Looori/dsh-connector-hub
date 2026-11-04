# 进度

每个步骤收尾时更新本文。

## 当前状态

- 当前阶段：**M4 本地发布验收已完成，等待对外发布**（2026-11-04）
- 下一步：创建公开的 `Looori/dsh-connector-hub` 空仓库并完成 npm 登录；经用户批准后推送代码、发布 npm，再从 npm 做 Desktop 安装验收。
- 阻塞项：GitHub 目标仓库尚不存在；当前机器未登录 npm。

## 里程碑

| 阶段 | 状态 | 完成日期 | 退出条件 |
|---|---|---|---|
| PoC | 已完成 | 2026-10-27 | 见 `poc/README.md` |
| 设计冻结 | 已完成 | 2026-10-30 | `docs/design.md` 已提交 |
| M0 验证 | 已完成 | 2026-11-03 | rc.5 冒烟、共享 OAuth 客户端、Desktop 授权窗口、凭据网关均有结论，并写回 design.md |
| M1 骨架 | 已完成 | 2026-11-03 | 52 项单测通过，Pages 公开目录与本地快照一致，包含 4 个条目 |
| M2 API Key | 已完成 | 2026-11-04 | 三个连接器的真实调用与完整生命周期验收通过；15 个测试文件、103 项测试通过 |
| M3 OAuth | 已完成 | 2026-11-04 | Notion、Xmind 的真实授权、模型调用、自动刷新、双进程及完整生命周期验收通过；19 个测试文件、126 项测试通过 |
| M4 发布 | 进行中 | | `dsh-connector-hub@0.1.0` 从 npm 安装验证通过 |

## M0 验证任务

- [x] ⓪ 在 rc.5 的 Desktop 和 dsh web 上重跑 PoC 冒烟：tab、路由、钥匙串读写、挂载 mcp-client、重新挂载后工具名不变。web 自动及 UI 冒烟、Desktop 手动验收均通过。
- [x] ① 验证共享公共客户端与 loopback 端口策略：Notion 使用 CIMD＋随机端口；Xmind 使用一次注册的共享公共客户端＋固定端口 `43118`。两家均完成真实授权、token 交换、刷新和 MCP 试连；未发生每实例动态注册。
- [x] ② Desktop 里从 tab 调用 `window.open` 打开授权页的实际行为：用户确认由系统 Chrome 打开 `example.com`。
- [x] ③ 本地凭据网关转发 Streamable HTTP（含 SSE）正常工作，非 loopback 上游出网经 DSH 的代理。

## M1 验收结果

- [x] Node `v24.16.0` 下 `pnpm build`、`pnpm typecheck` 通过，Host 使用 DSH `0.2.1-rc.5` 真实类型。
- [x] `pnpm catalog:build` 连续两次产物一致；包内快照 revision 为 `2026-11-03.1`，仅包含 `notion`、`xmind-cn`、`amap`、`baidu-map`。
- [x] `pnpm test` 的 6 个测试文件、52 项测试全部通过，覆盖目录、store、secrets、网关和包元数据。
- [x] Pages 地址 `https://looori.github.io/dsh-connector-hub/catalog/v1/index.json` 可拉取，解析后的内容与本地有效快照完全一致。
- [x] 测试仅使用临时目录、内存或伪钥匙串及本地模拟服务，不访问真实 `$DSH_HOME`、真实钥匙串、真实服务商或模型依赖。代理自动测试验证 DSH fetch 边界，真实 dispatcher 链路沿用 M0 验收结论。
- [x] 步骤 1 至 6 均独立提交；未提交 `.dsh/`、真实凭据、临时诊断文件或构建垃圾。实施未改变既定设计和决策。

## M2 实施记录

- [x] ① 挂载、状态与试连：新增 `mounts`、`health` 和状态汇总；支持配置对账、挂载冲突与失败摘要、重新挂载、工具名收集，以及经网关执行 initialize + tools/list。9 个测试文件、69 项测试通过，`pnpm typecheck` 和 `pnpm build` 通过。
- [x] ② Host 接口与 API Key 生命周期：接入目录网络拉取、ETag 缓存和包内快照；实现目录、连接器状态、API Key 添加／更换、试连、重挂、停用和删除路由。候选 Key 使用独立临时网关试连，试连失败不落盘，挂载失败回滚；接口拒绝未知 id 和多余字段。12 个测试文件、90 项测试通过，类型检查和构建通过。
- [x] ③ 客户端两页与弹窗：注册「连接器」tab，实现发现页卡片、我的页状态与生命周期操作、API Key 添加／更换弹窗和删除确认；支持中英文、目录提示、60 秒轮询及成功 Toast。OAuth 入口仅展示并禁用。14 个测试文件、100 项测试通过，类型检查和构建通过；测试使用模拟 API 和 UI 控件，未连接真实服务商，也未进行 Desktop 验收。
- [x] ④ 自动端到端测试：使用临时 `DSH_HOME`、本机目录与模拟 MCP 服务、进程内伪钥匙串和真实 DSH Host／web 路由，通过无头 Chrome 验证添加、取消、试连、重挂、停用、启用和删除；检查工具名稳定、错误 Key 不落盘及密钥不进入配置和审计日志。完整用例连续运行两次通过；全量 15 个测试文件、101 项测试通过，类型检查和构建通过。未访问真实服务商、真实钥匙串或模型，Desktop 手动验收留待下一步。
- [x] ⑤ API Key 目录更新：高德保持查询参数 `key`，百度按最新配置改为查询参数 `ak`，新增 `tencent-docs`（`https://docs.qq.com/openapi/mcp`，`Authorization` 请求头）。目录 revision 升至 `2026-11-03.2`，包内快照包含 5 个连接器；15 个测试文件、101 项测试通过，类型检查和构建通过。未填写真实鉴权值、未请求真实服务，公开 Pages 目录和 Desktop 验收尚未更新。
- [x] ⑥ 公开目录发布：目录站点提交 `7398705`（`M2: publish catalog 2026-11-03.2`）已推送到 `Looori/looori.github.io` 的 `main`，作者使用 noreply 邮箱；线上 `https://looori.github.io/dsh-connector-hub/catalog/v1/index.json` 与包内快照逐字节一致。临时发布副本已清理，真实鉴权和 Desktop 验收仍未执行。
- [x] ⑦ Desktop 验收与试连反馈：三个 API Key 连接器均完成真实模型工具调用、停用、重新启用和删除，删除后真实 Keychain 条目消失。修复试连成功／失败无 Toast 及失败后状态不刷新问题（`e878568`）；15 个测试文件、103 项测试通过，类型检查和构建通过。重启 Desktop 后，试连成功 Toast 与删除凭据复验通过。

## M2 验收结果

- [x] 高德地图：真实调用 `mcp__amap__maps_weather` 成功；停用后不可调用，重新启用后恢复；删除后 Keychain Access 中 `amap` 条目消失。
- [x] 百度地图：按 `query`／`ak` 配置真实调用 `mcp__baidu-map__map_geocode` 成功；停用、重新启用及删除凭据均通过。
- [x] 腾讯文档：按 `Authorization` 请求头真实调用 `mcp__tencent-docs__manage_create_file_295888151e2a` 成功，创建 `dsh_1103_01`；停用、重新启用及删除凭据均通过。
- [x] 试连反馈复验：点击试连后出现「试连成功」Toast；复验后删除高德，Keychain 中对应条目消失。

## M3 实施记录

- [x] ① OAuth 授权核心：实现共享公共客户端 Provider、CIMD、PKCE、随机／固定 loopback 回调、一次性 `state`、`iss` 校验、10 分钟超时和取消；新增 `oauth-start`、`oauth-status`、`oauth-cancel` 路由。token 先经独立网关试连，成功后才保存并挂载；试连或挂载失败回滚，重新授权失败保留旧凭据与连接。本地模拟授权服务器验证禁止动态注册、固定端口占用和授权生命周期；16 个测试文件、111 项测试通过，类型检查和构建通过，未访问真实服务商或钥匙串。
- [x] ② token 自动刷新与吊销：网关在过期前 5 分钟主动刷新，或在 401 后用原请求体重试一次；跨进程独占文件锁在锁内重读钥匙串并复用其他进程的新 token，轮换后的 refresh token 立即保存。`invalid_grant` 标记需要重新授权并异步卸载，避免挂载队列死锁；保留旧凭据，禁止重挂或启用。授权账号从 Notion 响应或 Xmind `id_token` 提取，API 视图对手机号打码；删除先清理本地状态，再尽力吊销且不受吊销失败影响。17 个测试文件、118 项测试通过，类型检查和构建通过；仅使用本地模拟服务、临时目录与内存密钥库。
- [x] ③ OAuth 客户端授权界面：发现页启用 OAuth 添加，我的页启用重新授权并显示打码账号；新增中英文授权弹窗、同步打开空白窗口、授权地址跳转、复制链接、取消、状态轮询、失败重试和成功 Toast。成功回调使用稳定引用，列表刷新不会重复完成授权。新增 API 封装与交互测试；17 个测试文件、123 项测试通过，类型检查和构建通过，未访问真实服务商、浏览器授权或钥匙串。
- [x] ④ OAuth 自动端到端测试：扩展本地模拟服务以提供目录、授权、MCP、刷新和吊销；使用临时 `DSH_HOME`、进程内伪钥匙串、真实 DSH Host／web 路由及无头 Chrome，验证取消无残留、授权与账号展示、401 刷新且挂载代次和工具名不变、`invalid_grant` 后卸载并重新授权、停用／启用、删除与吊销。18 个测试文件、124 项测试通过，类型检查和构建通过；未访问真实服务商、真实钥匙串或模型，Desktop 验收留待用户执行。
- [x] ⑤ Desktop 与 dsh web 真实验收：Notion、Xmind 均完成真实授权、试连及真实模型工具调用，停用后工具消失、重新启用后恢复；使用开发专用脚本提前本地过期时间后，试连均自动刷新且无需重新授权；按 Desktop → web → Desktop 顺序分别调用两连接器均正常，未互相使 refresh token 失效；在 dsh web 删除后，Keychain 中对应条目均消失。19 个测试文件、126 项测试通过，类型检查和构建通过。

## M4 实施记录

- [x] ① 发布准备：当前仓库全部历史提交的作者和提交者邮箱已统一为 GitHub noreply，旧引用已清理；其他仓库和全局 Git 配置未修改。英文「我的」tab 按设计改为 `Yours`，取消授权增加独立中英文状态。包版本升至 `0.1.0`，补齐仓库元数据、根 README 和 npm 包 README；新增 macOS CI 的 `0.2.1-rc.5`／`next` 矩阵及手动 npm 发布工作流。19 个测试文件、126 项测试通过，类型检查和构建通过。
- [x] ② 本地发布包验收：`npm pack` 仅包含 README、两份构建产物、目录快照、patch 和包元数据共 6 个文件，不包含开发调试脚本。tarball 在隔离目录的普通 npm 安装和 DSH `web` profile 安装均成功；安装后版本为 `0.1.0`、内置目录为 5 个连接器，DSH 启动和已认证 `connectors` Host 路由冒烟通过。全程使用临时 `DSH_HOME` 和进程内伪钥匙串，未访问真实凭据。
- [ ] ③ 对外发布：npm 包名当前未被占用，但目标 GitHub 仓库尚不存在且本机未登录 npm。等待用户创建仓库、完成登录并批准推送和发布。
- [ ] ④ npm 与 Desktop 验收：发布后再从 npm 安装，按检查清单完成 Desktop 验收。

## 已完成的事项

- 2026-10-26：PoC ① 跑通：tab、只限本机用户的路由、钥匙串读写，dsh web 和 Desktop 都通过。
- 2026-10-27：PoC ② 跑通：运行时挂载 mcp-client，工具名稳定，tab 里显示状态，dsh web 和 Desktop 都通过。
- 2026-10-29：确定一期决策；第一批连接器定为 Notion、Xmind（中国版）、高德、百度。
- 2026-10-30：目录站点上线，`https://looori.github.io/dsh-connector-hub/catalog/v1/index.json` 目前是空目录占位；界面方案写进 design.md §9；定下工作流程（`CLAUDE.md`）。
- 2026-11-02：实现基线由 rc.3 改为 rc.5（decisions.md）。Desktop、它自带的 CLI 和 npm 的 `latest`/`next` 都是 rc.5；源码核对显示插件用到的接口没变。
- 2026-11-02：rc.5 web 自动及 UI 冒烟通过；凭据网关 POST、GET/SSE、DELETE 转发与 DSH 代理 spike 通过。rc.5 mcp-client 卸载时不会主动发 DELETE，DELETE 由当前 MCP 会话直接请求网关验证。
- 2026-11-02：发布 Notion CIMD 到 `https://looori.github.io/dsh-connector-hub/oauth/notion/client.json`，站点提交 `542a277`；真实随机端口授权、刷新和刷新前后 MCP 试连通过。
- 2026-11-03：Xmind 共享公共客户端创建成功。随机端口在登录时被 `redirect_uri is not registered for this client` 拒绝；固定端口 `43118` 的完整授权、refresh token 轮换和刷新前后 MCP 试连通过，固定端口占用时已验证会在打开授权页前报错。
- 2026-11-03：Desktop 手动验收通过：已连接、三个会话均可见两个稳定命名的工具、试连成功、钥匙串写入／匹配／删除／删除后不存在均成功、重挂后工具名不变。

## 待讨论

（里程碑之间再讨论的新想法，放在这里）
