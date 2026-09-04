# dsh-subscription-hub

Unified subscription plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), based on [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) (MIT).

English | [中文](README.zh.md)

One Settings → **Subscriptions** page for:

| Route | Subscription | Notes |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | live catalog, usage, Fast tier |
| `claude` | Claude Pro/Max | OAuth or import Claude Code |
| `grok` | SuperGrok / X Premium | live catalog, usage, Imagine tools |
| `copilot` | GitHub Copilot | device-code login |
| `agy` | Google Antigravity | **HTTP OAuth only** — no `agy` CLI, no flashing `cmd.exe` windows |
| `commandcode` | Command Code Go | Import `~/.commandcode/auth.json` or paste API key (Studio optional) |
| `codebuddy` | Tencent CodeBuddy | browser OAuth, **check-in** button |
| `zed` | Zed Pro | import Zed desktop credentials or paste `userId` + token; usage from `cloud.zed.dev/client/users/me` |

Also: multi-account pool (quota-aware rotation), usage bars, **visible-model checkboxes** (composer picker only), `image_generate` / `video_generate` / `x_search`.

## Why this exists

Installing several subscription plugins at once:

- loads duplicate adapters → the model picker is slow
- adds several Settings pages → you pick a model twice (composer **and** Settings → Models)

This hub is **one** bundle. After installing it, remove the overlapping plugins (`dsh-plugin-subscriptions`, `dsh-agy-link`, `dsh-agy`, `@mars-sea/dsh-commandcode-provider`, `@shatyuka/dsh-llm-codebuddy`, `dsh-xai` if you only need Grok here). Then pick models **once** in the composer. Hide extras under Settings → Subscriptions.

## Install

```sh
dsh plugin --profile web add github:zdz6215591/dsh-subscription-hub
```

Git 安装会跑 `prepare`（构建 `lib/`）。pnpm ≥10 默认拦住这个脚本，把包名写进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-subscription-hub: true
```

Local checkout:

```sh
cd C:\Users\DongZhi\Desktop\vibcode\dsh_subscription_hub
pnpm install
pnpm build
dsh plugin --profile web add .
```

Restart `dsh web`. Open **Settings → Subscriptions**.

Uninstall overlapping plugins first if they are already in the profile:

```sh
dsh plugin --profile web remove dsh-plugin-subscriptions
dsh plugin --profile web remove dsh-agy-link
dsh plugin --profile web remove dsh-agy
dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
dsh plugin --profile web remove @shatyuka/dsh-llm-codebuddy
dsh plugin --profile web remove dsh-coding-subscription-oauth
```

## Zed Pro

Zed does not publish a third-party OAuth client. Sign in to the Zed app, then:

- click **Import from Zed desktop**, or
- paste `userId` + credential JSON into the manual field

The plugin mints LLM tokens from `https://cloud.zed.dev/client/llm_tokens` and reads remaining usage from `GET /client/users/me` (same cloud API the [dashboard billing page](https://dashboard.zed.dev) uses).

## Antigravity

Uses Google OAuth + `daily-cloudcode-pa.googleapis.com` HTTP streaming. It does **not** spawn `agy` / `cmd.exe`. Keep Clash/TUN on if Google is blocked.

## License

MIT. See [NOTICE](NOTICE) for upstream attribution.
