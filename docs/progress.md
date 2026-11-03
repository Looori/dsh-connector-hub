# 进度

每个步骤收尾时更新本文。

## 当前状态

- 当前阶段：**M1 已完成并提交**（2026-11-03）
- 下一步：按工作节奏新开一个会话，对齐并开始 M2：API Key 添加、试连、挂载、停用、删除及「我的」「发现」页面。
- 阻塞项：无

## 里程碑

| 阶段 | 状态 | 完成日期 | 退出条件 |
|---|---|---|---|
| PoC | 已完成 | 2026-10-27 | 见 `poc/README.md` |
| 设计冻结 | 已完成 | 2026-10-30 | `docs/design.md` 已提交 |
| M0 验证 | 已完成 | 2026-11-03 | rc.5 冒烟、共享 OAuth 客户端、Desktop 授权窗口、凭据网关均有结论，并写回 design.md |
| M1 骨架 | 已完成 | 2026-11-03 | 52 项单测通过，Pages 公开目录与本地快照一致，包含 4 个条目 |
| M2 API Key | 未开始 | | 端到端测试通过，用户在 Desktop 上手动验证 |
| M3 OAuth | 未开始 | | 同上，并验证 token 自动刷新 |
| M4 发布 | 未开始 | | `dsh-connector-hub@0.1.0` 从 npm 安装验证通过 |

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

- 本仓库（插件代码）什么时候推到 GitHub。推之前要先确认：已有提交用的是工作邮箱。
