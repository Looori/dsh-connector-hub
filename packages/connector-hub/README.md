# dsh-connector-hub

A community connector hub for [DeepSeek Harness](https://github.com/DeepSeek-AI/deepseek-harness) (DSH). Browse a curated catalog in the **Connectors** tab, connect remote MCP services, and keep credentials in the macOS Keychain.

**This is a community plugin, not an official DeepSeek product.**

## Requirements

- macOS
- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`

## Install

Install `dsh-connector-hub` from the DSH **Plugins** page, open the **Connectors** tab, and choose a service on **Discover**. Complete its OAuth authorization or enter its API Key when prompted.

The catalog includes:

| Connector | Authentication |
| --- | --- |
| Notion | OAuth |
| Xmind (China) | OAuth |
| Amap | API Key |
| Baidu Map | API Key |
| Tencent Docs | API Key |
| Qichacha | API Key |
| GitHub | API Key (personal access token) |
| Gitee | API Key (personal access token) |
| Tencent Maps | API Key |
| Flight Master Aviation Data | API Key |
| DiDi | API Key |
| Wind Stock Data | API Key |
| VariFlight | API Key |

Enter the raw credential shown by the provider. For services that require Bearer authentication, the gateway adds the prefix and avoids duplicating it if already present.

Connected tools are mounted at the profile root and become available to sessions in that profile. You can probe, remount, disable, re-enable, replace credentials, or remove a connector from **Yours**.

## Credential storage and network behavior

- API Keys and OAuth tokens are stored in macOS Keychain under service `dsh-connector-hub`; the account is the connector ID.
- Non-secret configuration is stored in `$DSH_HOME/connector-hub/connectors.json` and shared across profiles.
- OAuth access tokens refresh automatically. Concurrent Desktop and dsh web processes coordinate refreshes to avoid invalidating each other's rotated refresh tokens.
- MCP clients connect through a loopback-only credential gateway. Credentials are injected there and are not written into MCP client configuration.
- Upstream URLs and authentication settings come from the curated catalog. The API does not accept arbitrary user-supplied URLs.

Removing a connector deletes its local credential. Where supported, the plugin also makes a best-effort remote token revocation request.

## Phase 1 limitations

- macOS only; Windows and Linux are not supported.
- Remote Streamable HTTP MCP services only; no local stdio connectors.
- No user-defined connectors outside the catalog.
- No per-session switches or tool-call approval flow.
- If a service is unavailable at startup, use **Remount** after it recovers.
- Duplicate-name guidance only covers mount failures observed by this plugin. If this plugin mounts first and a manually configured MCP client with the same name fails afterward, that error appears only in the DSH logs.

## Development

See the [repository README](https://github.com/Looori/dsh-connector-hub#readme) for development commands, tests, and project documentation.
