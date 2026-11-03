# 进度

每个步骤收尾时更新本文。

## 当前状态

- 当前阶段：**M0 技术验证已完成，待用户验收与提交**（2026-11-03）
- 下一步：用户验收 M0 结果，随后以 `M0: ...` 提交；验收提交后进入 M1 骨架。
- 阻塞项：无

## 里程碑

| 阶段 | 状态 | 完成日期 | 退出条件 |
|---|---|---|---|
| PoC | 已完成 | 2026-10-27 | 见 `poc/README.md` |
| 设计冻结 | 已完成 | 2026-10-30 | `docs/design.md` 已提交 |
| M0 验证 | 待验收 | | rc.5 冒烟、共享 OAuth 客户端、Desktop 授权窗口、凭据网关均有结论，并写回 design.md |
| M1 骨架 | 未开始 | | 单测通过，Pages 上能拉到 4 个条目 |
| M2 API Key | 未开始 | | 端到端测试通过，用户在 Desktop 上手动验证 |
| M3 OAuth | 未开始 | | 同上，并验证 token 自动刷新 |
| M4 发布 | 未开始 | | `dsh-connector-hub@0.1.0` 从 npm 安装验证通过 |

## M0 验证任务

- [x] ⓪ 在 rc.5 的 Desktop 和 dsh web 上重跑 PoC 冒烟：tab、路由、钥匙串读写、挂载 mcp-client、重新挂载后工具名不变。web 自动及 UI 冒烟、Desktop 手动验收均通过。
- [x] ① 验证共享公共客户端与 loopback 端口策略：Notion 使用 CIMD＋随机端口；Xmind 使用一次注册的共享公共客户端＋固定端口 `43118`。两家均完成真实授权、token 交换、刷新和 MCP 试连；未发生每实例动态注册。
- [x] ② Desktop 里从 tab 调用 `window.open` 打开授权页的实际行为：用户确认由系统 Chrome 打开 `example.com`。
- [x] ③ 本地凭据网关转发 Streamable HTTP（含 SSE）正常工作，非 loopback 上游出网经 DSH 的代理。

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
