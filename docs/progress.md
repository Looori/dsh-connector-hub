# 进度

每个步骤收尾时更新本文。

## 当前状态

- 当前阶段：**设计冻结已完成**（2026-10-30；2026-11-02 实现基线改为 rc.5）
- 下一步：**M0 验证**。新开一个会话，先按「对齐」列出 M0 的任务和完成标准，等用户确认。
- 阻塞项：无

## 里程碑

| 阶段 | 状态 | 完成日期 | 退出条件 |
|---|---|---|---|
| PoC | 已完成 | 2026-10-27 | 见 `poc/README.md` |
| 设计冻结 | 已完成 | 2026-10-30 | `docs/design.md` 已提交 |
| M0 验证 | 未开始 | | ⓪–③ 四项都有结论，并写回 design.md |
| M1 骨架 | 未开始 | | 单测通过，Pages 上能拉到 4 个条目 |
| M2 API Key | 未开始 | | 端到端测试通过，用户在 Desktop 上手动验证 |
| M3 OAuth | 未开始 | | 同上，并验证 token 自动刷新 |
| M4 发布 | 未开始 | | `dsh-connector-hub@0.1.0` 从 npm 安装验证通过 |

## M0 验证任务（design.md §13）

- [ ] ⓪ 在 rc.5 的 Desktop 和 dsh web 上重跑 PoC 冒烟：tab、路由、钥匙串读写、挂载 mcp-client、重新挂载后工具名不变。源码核对显示接口没变（design §3），这一项确认实际运行结果。PoC 仍链接在 Desktop 的 profile 里，需要退出或重启 Desktop 时先征得用户同意。
- [ ] ① Notion 和 Xmind 是否接受 `http://127.0.0.1:<端口>/oauth/callback` 形式回调地址的动态注册；换端口是否需要重新注册。注意：动态注册会在服务商那边新建客户端，执行前要用户同意。
- [ ] ② Desktop 里从 tab 调用 `window.open` 打开授权页的实际行为。
- [ ] ③ 本地凭据网关转发 Streamable HTTP（含 SSE）能否正常工作，出网是否走 DSH 的代理。

## 已完成的事项

- 2026-10-26：PoC ① 跑通：tab、只限本机用户的路由、钥匙串读写，dsh web 和 Desktop 都通过。
- 2026-10-27：PoC ② 跑通：运行时挂载 mcp-client，工具名稳定，tab 里显示状态，dsh web 和 Desktop 都通过。
- 2026-10-29：确定一期决策；第一批连接器定为 Notion、Xmind（中国版）、高德、百度。
- 2026-10-30：目录站点上线，`https://looori.github.io/dsh-connector-hub/catalog/v1/index.json` 目前是空目录占位；界面方案写进 design.md §9；定下工作流程（`CLAUDE.md`）。
- 2026-11-02：实现基线由 rc.3 改为 rc.5（decisions.md）。Desktop、它自带的 CLI 和 npm 的 `latest`/`next` 都是 rc.5；源码核对显示插件用到的接口没变，M0 加一项 ⓪ 实测。

## 待讨论

（里程碑之间再讨论的新想法，放在这里）

- 本仓库（插件代码）什么时候推到 GitHub。推之前要先确认：已有提交用的是工作邮箱。
