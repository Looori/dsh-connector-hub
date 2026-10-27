# dsh-connector-hub-poc

最小验证：仓库外的 DSH 插件能否同时在 dsh web 和 DeepSeek Harness Desktop 中做到以下三件事：

1. 在 Plugins 页加一个「连接器」tab（`plugins.tab` 插槽，浏览器端代码由 client module system 加载）；
2. 注册只允许已登录用户访问的 Host 接口（`ctx.connection.fetch.register`，路径在 `/api/connector-hub/` 下）；
3. 在 Host 进程里加载原生模块 `@napi-rs/keyring`，对系统钥匙串做一次写入、读取、删除。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 同时声明 `dsh.bundle`（patch 层）和 `dsh.client`（浏览器端代码） |
| `cordis.patch.yml` | 插入一行 `dsh-connector-hub-poc`；必须写包名，浏览器端代码才会挂上 |
| `src/index.ts` | Host 端：`status`、`keychain-test` 两个接口 |
| `src/client.tsx` | 浏览器端：「连接器」tab，两个按钮分别调用上面两个接口 |
| `build.mjs` | 用 esbuild 构建；浏览器端输出 CommonJS，外面包一层 `window.__ModuleLoader__.load(...)`，共享模块列表照抄 DSH 的 `PLATFORM_MODULES` |

## 构建

需要 Node 24。本机 npm 全局配置的 `registry.npm.taobao.org` 证书已过期，安装依赖时临时指定新镜像：

```bash
npm install --registry=https://registry.npmmirror.com
```

```bash
npm run build
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
