# M1 骨架实施计划

- 日期：2026-11-03
- 状态：已确认（2026-11-03）
- 依据：`docs/design.md` §4、§5、§7、§11、§12、§13，以及 M0 已验证结论
- 目标：建立可构建、可类型检查、可测试的插件工程，完成首批目录及 store、secrets、凭据网关基础模块

## 1. 范围与边界

### M1 交付

1. Node 24 + pnpm 工作区，以及 `dsh-connector-hub` 包骨架。
2. DSH 0.2.1-rc.5 真实类型、构建配置和包元数据。
3. 目录 JSON Schema、4 个连接器 YAML 源文件、目录构建与发布脚本、包内快照。
4. `connectors.json` 的版本化、原子读写与跨进程对账基础。
5. 系统钥匙串适配、内存测试实现、凭据序列化与敏感信息打码。
6. 本地凭据网关及自动化测试。
7. 单元测试、进度文档同步和分步提交。

### 明确不在 M1

- 「我的」「发现」页面、添加弹窗和 Host 业务路由。
- mcp-client 挂载、试连、停用、删除等完整业务流程。
- OAuth 授权流程、token 刷新、401 刷新重试、跨进程刷新锁。
- 自动端到端测试和 Desktop 手动业务验收。
- 向 GitHub 推送本插件仓库。

M1 的入口文件只用于验证工程与类型链路，不安装到真实 Desktop profile，不修改用户的 Desktop 状态。

## 2. 实施原则

- 以 DSH 发布版本 `0.2.1-rc.5` 为准，不引用 master API。
- 复用 PoC 已验证的构建外壳和网关结论，但正式模块重新组织并补测试，不直接复制 spike 作为成品。
- 目录和配置只保存公开信息；token、API Key、client secret、注册管理凭证不得进入目录、日志或测试快照。
- 测试全部使用临时目录、内存凭据和本地模拟服务，不读写用户真实配置或钥匙串条目。
- 安装依赖时只对当前命令使用 `--registry=https://registry.npmmirror.com`，不改全局 npm 配置。
- 每个可验证步骤完成测试后单独提交，提交信息以 `M1:` 开头；不暂存 `.dsh/`，不使用 `git add -A`。

## 3. 目标目录结构

```text
dsh-connector-hub/
├─ package.json                  # 工作区脚本，private
├─ pnpm-workspace.yaml
├─ pnpm-lock.yaml
├─ tsconfig.base.json
├─ .gitignore                    # node_modules、构建产物、.dsh 等
├─ packages/connector-hub/
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ build.mjs
│  ├─ cordis.patch.yml
│  ├─ catalog/index.json         # 构建生成并随包发布的目录快照
│  └─ src/
│     ├─ host/
│     │  ├─ index.ts             # apply 入口，M1 仅建立骨架
│     │  ├─ store.ts
│     │  ├─ secrets.ts
│     │  ├─ gateway.ts
│     │  └─ redact.ts
│     ├─ client/index.ts         # 验证 client 构建外壳，无业务 UI
│     └─ shared/
│        ├─ catalog.ts           # 目录与认证公共类型
│        ├─ config.ts            # connectors.json 类型
│        └─ errors.ts            # 可安全展示的结构性错误
├─ catalog/
│  ├─ index.yaml                 # schemaVersion、revision、条目顺序
│  ├─ schema/
│  │  ├─ connector.schema.json
│  │  └─ index.schema.json
│  ├─ connectors/
│  │  ├─ notion.yaml
│  │  ├─ xmind-cn.yaml
│  │  ├─ amap.yaml
│  │  └─ baidu-map.yaml
│  └─ scripts/
│     ├─ build.mjs
│     └─ publish.mjs
└─ test/
   ├─ catalog.test.ts
   ├─ store.test.ts
   ├─ secrets.test.ts
   ├─ gateway.test.ts
   └─ helpers/                   # 临时目录、模拟上游、代理和 SSE
```

实现时可以为单一职责进一步拆分文件，但不增加新的运行时子系统。

## 4. 分步实施

### 步骤 1：工作区、真实类型与构建骨架

**工作内容**

- 建立 pnpm 工作区，统一 Node 24、TypeScript、Vitest、esbuild 配置。
- 设置根脚本：`build`、`typecheck`、`test`、`catalog:build`。
- 按 rc.5 添加 DSH 类型依赖；运行时共享包保持可选 peer 依赖：
  - `@deepseek-ai/dsh-mcp-client`
  - `@deepseek-ai/dsh-home-paths`
- 普通运行时依赖保持 `@modelcontextprotocol/client@2.2.0`、`@napi-rs/keyring`。
- 包元数据落实：
  - 包名 `dsh-connector-hub`；
  - `exports` 为 `.`、`./client`、`./package.json`；
  - `dsh.bundle.patch`、`dsh.client` 与 PoC 一致；
  - `engines.dsh` 为 `>=0.2.1-rc.5 <0.3.0`；
  - 描述明确为社区插件，非 DeepSeek 官方产品。
- Host 输出 ESM、依赖 external；client 输出带 `__ModuleLoader__` 外壳的 CJS，共享模块列表沿用 rc.5 已验证方案。
- 使用真实 DSH 类型约束 Host 入口，清除正式代码对手写 PoC 接口的依赖。

**验证**

- 根目录可安装依赖并生成锁文件。
- `pnpm build` 同时产出 Host 和 client 文件。
- `pnpm typecheck` 使用 rc.5 类型通过。
- 构建产物不含 PoC 诊断逻辑和真实凭据。

**拟提交**

`M1: set up typed plugin workspace`

### 步骤 2：目录 Schema 与首批 4 个条目

**工作内容**

- 定义单条目与合并目录的 JSON Schema，覆盖：
  - 顶层 `schemaVersion: 1`、`revision`、`connectors`；
  - 中英文 `name`、`description`、图标、主页、服务商、`official`；
  - `remote.type = streamable-http` 和 HTTPS 地址；
  - `oauth`／`api-key`／`none` 三种认证及各自必填字段；
  - OAuth 的共享客户端、回调路径、随机／固定端口策略；
  - API Key 的 header／query 注入位置、名称、标签和帮助链接。
- 校验规则：
  - id 匹配 `^[a-z0-9-]{1,24}$` 且目录内唯一；
  - 图标为 SVG data URI，单条不超过 8 KB；
  - 正式远程地址必须为 HTTPS，loopback HTTP 仅供测试夹具；
  - `portPolicy: fixed` 必须有合法 `fixedPort`，随机策略不得携带固定端口；
  - OAuth 必须且只能提供 `clientId` 或 `clientMetadataUrl` 之一；
  - 拒绝目录中的 secret、token、API Key 等禁用字段。
- 按附录 A 录入 4 条，顺序固定：
  1. `notion`：CIMD、随机端口、scope 留空；
  2. `xmind-cn`：公开 `clientId`、`openid mcp:connect`、固定端口 `43118`；
  3. `amap`：查询参数 `key`；
  4. `baidu-map`：请求头 `ak`。
- 图标使用仓库内生成的简洁 SVG data URI，不依赖外部图片请求。

**验证**

- 4 个真实条目全部通过 Schema 和业务约束。
- 负例覆盖：重复 id、非法 URL、非法端口组合、缺失客户端身份、超大图标、秘密字段。
- 公共类型能解析真实目录；未知普通字段可保留或忽略，不导致解析失败。

**拟提交**

`M1: define catalog schema and initial connectors`

### 步骤 3：目录构建、快照与发布脚本

**工作内容**

- `catalog/scripts/build.mjs`：
  1. 读取 `catalog/index.yaml` 和固定顺序的 YAML 条目；
  2. 校验单条目；
  3. 合并并校验完整目录；
  4. 生成确定性格式化的 JSON；
  5. 写入 `packages/connector-hub/catalog/index.json` 作为包内快照。
- 相同输入必须得到逐字节相同输出，revision 由源文件显式维护，不在构建时读取当前时间。
- `catalog/scripts/publish.mjs`：
  1. 先执行完整目录构建；
  2. 检查目标站点仓库存在；
  3. 写入 `../looori.github.io/dsh-connector-hub/catalog/v1/index.json`；
  4. 输出变更摘要，不自动 commit 或 push。
- 发布时另起站点仓库提交，使用 `66784394+Looori@users.noreply.github.com`；推送前取得用户明确批准。
- Pages 更新后用公开 URL 拉取并核对 schema、revision 和 4 个 id。

**验证**

- 连续两次构建产物一致。
- 任一源文件非法时构建失败，不覆盖上一份有效快照。
- 发布脚本只修改站点仓库中的目标目录文件。
- 最终 Pages 返回有效 JSON，包含 Notion、Xmind（中国版）、高德地图、百度地图。

**拟提交**

`M1: add catalog build and publishing pipeline`

站点仓库使用独立提交；是否推送以用户当次批准为准。

### 步骤 4：版本化配置存储 store

**工作内容**

- 通过组合根传入由 `resolveDshHome()` 得到的目录，store 本身支持注入临时路径，便于测试。
- 文件固定为 `$DSH_HOME/connector-hub/connectors.json`。
- 提供清晰的模块接口：
  - 读取当前配置；文件不存在时返回 v1 空配置；
  - 校验并解析配置；
  - 原子写入完整配置；
  - 读取文件版本信息并判断是否需要重新加载；
  - 为 M2 提供新增、更新 enabled、删除所依据的读写原语，但不实现业务路由。
- 写入流程：同目录临时文件 → flush／必要的同步 → rename 替换；失败时清理临时文件，不留下半份 JSON。
- 进程内串行化写入，避免本进程两个写操作互相覆盖。
- 建立版本迁移入口：当前正式格式只有 v1；未来版本明确报错，不静默降级或覆盖。
- 对账以文件修改信息为触发，重新读取后返回新快照；解析失败保留最后一份有效内存快照并返回可诊断错误。
- 普通配置不保存任何凭据，错误文本不序列化凭据值。

**验证**

- 缺失文件、空配置、完整读写和目录自动创建。
- 原子替换、写入失败清理、进程内并发写不损坏 JSON。
- 合法 v1、非法结构、未知 schemaVersion。
- 迁移入口用测试夹具验证分派，不虚构已发布的历史格式。
- 外部进程替换文件后能够检测到并重新加载；损坏文件不覆盖最后有效快照。
- 已连接条目的 `remote`、`auth`、`enabled`、`addedAt` 能完整往返。

**拟提交**

`M1: implement atomic connector configuration store`

### 步骤 5：钥匙串 secrets 与安全打码

**工作内容**

- 定义统一 `SecretStore` 接口：读取、写入、删除指定连接器 id 的凭据。
- 正式实现使用 `@napi-rs/keyring`：service 为 `dsh-connector-hub`，account 为连接器 id。
- 测试实现使用内存 Map，接口行为与正式实现一致；原生模块通过适配层隔离，单测不触发真实钥匙串。
- 实现版本化凭据编解码：
  - OAuth：`{v, tokens, account?}`；
  - API Key：`{v, apiKey}`；
  - 非法 JSON、未知版本和缺失必需字段返回明确错误。
- 实现 URL 查询参数打码和安全错误摘要；错误对象只保留必要的代码、状态和不敏感消息。
- 为后续网关提供按 id 读取凭据的接口，但 M1 不实现 token 刷新。

**验证**

- 内存实现的读写、覆盖、删除、删除后不存在和条目隔离。
- 两类凭据往返、非法数据和未知版本。
- 原生适配层用 fake 验证 service／account 参数，不访问真实钥匙串。
- URL 中的 `key`、token 等敏感查询值被替换；错误和日志辅助函数不泄漏凭据。

**拟提交**

`M1: add keychain credential storage`

### 步骤 6：本地凭据网关

**工作内容**

- 启动时仅监听 `127.0.0.1` 的随机端口，使用加密随机数生成本进程网关密钥。
- 唯一业务路径为 `/c/<id>/mcp`：
  - 未知路径或未知 id 返回 404；
  - 网关密钥缺失或错误返回 403，并使用恒定时间比较；
  - 仅允许 POST、GET、DELETE，其余方法返回 405。
- 上游地址和认证配置只能来自该 id 的已存配置，不接受请求方传入 URL。
- 凭据注入：
  - OAuth：覆盖为 `Authorization: Bearer <access_token>`；
  - API Key header：覆盖目录声明的请求头；
  - API Key query：在上游 URL 中设置目录声明的参数；
  - `none`：不注入凭据。
- 请求头只转发 `Accept`、`Content-Type`、`Mcp-Session-Id`、`Mcp-Protocol-Version`、`Last-Event-ID`；移除 `X-Connector-Hub-Key` 和逐跳头，不信任客户端提供的 Authorization。
- 请求体使用 4 MiB 上限的可重放读取，为 M3 的 401 刷新重试保留接口；超限返回 413。响应体按流转发，SSE 不缓冲成完整响应。
- 保留上游状态码和非逐跳响应头；网络失败返回不含上游凭据的 502 JSON 摘要。
- 客户端断开时取消上游请求；服务关闭时停止接收请求并清理连接。
- 使用全局 `fetch` 发起上游请求，保持 DSH 已安装代理 dispatcher 生效；loopback 直连行为由 DSH 保证。
- M3 只需在网关凭据读取与请求重放边界加入刷新逻辑，不改变 mcp-client 地址和请求头。

**验证**

- 监听地址为 loopback、端口随机、密钥不出现在响应或日志。
- 无密钥／错误密钥 403、未知路径／id 404、非法方法 405。
- 三种凭据注入及无认证模式；客户端伪造的认证头不会穿透。
- 请求头白名单、逐跳头过滤、查询参数注入不丢失原有安全参数。
- POST JSON、GET/SSE 分段到达、DELETE、上游状态码和响应头透传。
- 超过 4 MiB 返回 413，上游网络错误返回安全 502。
- 客户端中断和网关关闭不挂起测试。
- 使用本地模拟代理验证非 loopback 上游仍走全局 dispatcher；测试输出中的 URL 全部打码。

**拟提交**

`M1: implement streaming credential gateway`

### 步骤 7：总体验证与文档收尾

**工作内容**

- 使用 Node 24 环境依次执行完整构建、类型检查、目录构建和测试。
- 检查测试无真实网络服务、真实钥匙串、真实 `$DSH_HOME` 或真实模型依赖。
- 检查 git diff 和暂存清单，确保无 `.dsh/`、密钥、临时文件或构建垃圾。
- 更新 `docs/progress.md`：M1 状态、验证结果、Pages 目录地址、下一步 M2。
- 若实施中发现方案偏差，先记录事实，再更新 `design.md`／`decisions.md`；已定决策不因实现便利而悄悄改变。

**最终拟提交**

`M1: verify skeleton and update progress`

## 5. 测试矩阵

| 模块 | 必测内容 | 不依赖 |
|---|---|---|
| 工程 | Host/client 构建、rc.5 真实类型、包导出 | Desktop 安装 |
| 目录 | Schema、业务约束、4 个条目、确定性构建、快照 | 真实服务商 |
| store | 原子写、版本、损坏文件、外部替换、完整往返 | 真实 DSH_HOME |
| secrets | 编解码、内存行为、原生适配参数、打码 | 真实钥匙串 |
| 网关 | 鉴权、路由、注入、头过滤、POST/SSE/DELETE、4 MiB、代理 | 真实 token／Key |

测试命令必须覆盖全部模块；任何测试失败都不能将对应步骤标记完成或提交为已完成。

## 6. M1 验收清单

- [ ] `pnpm build` 通过。
- [ ] `pnpm typecheck` 通过，正式代码使用 rc.5 真实类型。
- [ ] `pnpm test` 全量通过。
- [ ] `pnpm catalog:build` 通过且重复构建结果确定。
- [ ] 包内快照包含且仅包含 `notion`、`xmind-cn`、`amap`、`baidu-map`。
- [ ] Pages 公开目录可拉取，内容与本地有效快照一致。
- [ ] store、secrets、网关测试满足第 5 节矩阵。
- [ ] 没有真实凭据、`.dsh/` 或用户状态变更进入提交。
- [ ] 所有步骤按验证节点提交，进度文档已同步。

## 7. 发布与外部操作节点

M1 唯一需要对外操作的环节是更新 GitHub Pages 目录：

1. 本地构建、测试并检查站点仓库 diff。
2. 向用户展示 revision、4 个条目和拟提交文件。
3. 用户批准后，在 `../looori.github.io` 提交并推送。
4. 拉取公开 URL 验证；若 Pages 尚未更新，记录实际状态，不把本地发布脚本成功等同于线上验收通过。

本插件仓库只本地提交，不推送。

## 8. 完成后的衔接

M1 完成后直接进入 M2 对齐，不在本里程碑顺带实现 UI。M2 将复用本步的目录快照、store、secrets 和网关，实现 API Key 添加、试连、挂载、停用、删除及两页界面。
