# dsh-subscription-hub

Unified subscription plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

English | [中文](README.zh.md)

One Settings → **Subscriptions** page for eight subscription routes:

| Route | Subscription | Notes |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | live catalog, usage, Fast tier |
| `claude` | Claude Pro/Max | OAuth or import Claude Code |
| `grok` | SuperGrok / X Premium | live catalog, usage, Imagine tools |
| `copilot` | GitHub Copilot | device-code login |
| `agy` | Google Antigravity | **HTTP OAuth only** — no `agy` CLI, no flashing `cmd.exe` windows |
| `commandcode` | Command Code Go | Import `~/.commandcode/auth.json` or paste API key (Studio optional) |
| `codebuddy` | Tencent CodeBuddy | browser OAuth, daily auto check-in |
| `zed` | Zed Pro | Windows import from Credential Manager, or paste userId + token; usage from `cloud.zed.dev/client/users/me` |

Also included:

- **Lifetime token accounting + savings banner** — totals every subscription
  token you have spent and prices it against pay-as-you-go API rates, showing
  the money you avoided paying (in ¥, with a per-subscription breakdown).
- **Multi-account pool** with quota-aware rotation, per-account usage bars, and
  image-request account failover.
- **Visible-model checkboxes** (composer picker only) plus a **Refresh models**
  button that drops the server's catalog cache and re-reads the live list.
- **Composer usage pill** — a compact readout of the *current model's* provider
  quota: CodeBuddy reports remaining credits, every other provider a remaining
  percentage with its reset countdown.
- **Tools**: `image_generate` (text-to-image **and** image editing via
  `referenceImages`), `video_generate`, `x_search`.

## Settings page layout

1. **Savings banner** (top) — lifetime tokens, ¥ saved, turn count, and a bar
   per subscription, with a **Recalculate** button that re-scans session history.
2. **Global card** — multi-account call mode and proxy configuration.
3. **Connected subscriptions** — every provider you are signed in to, with its
   accounts, usage windows, default-effort picker, and model visibility list.
4. **Add a subscription** — every provider you are *not* signed in to, showing
   the same sign-in buttons. Adding a second account of an already-connected
   provider uses that provider's own sign-in button in its card — there is no
   separate, differently-styled "add account" flow.

## Image editing

`image_generate` accepts an optional `referenceImages` array (1–5 complete DSH
attachment references) to edit or build on existing images:

- pass references copied from the image reference text or structured tool
  results (`read_image.image` / `image_generate.images`);
- references can come from an upload, `read_image`, or a previously generated
  image; for a local file, call `read_image` first — a filesystem path is not a
  reference;
- omitting `referenceImages` keeps plain text-to-image generation.

Edits route to the provider's own edits endpoint (`/backend-api/codex/images/edits`
for ChatGPT, `/v1/images/edits` for Grok). WebP and GIF references are
transcoded (alpha → PNG, opaque → JPEG) before they reach a provider that does
not accept them. Empty arrays, duplicate references, and attachment-limit
violations fail loudly instead of silently generating a new image.

## Tools

- **`image_generate`** — `gpt-image-2` via the Codex subscription, or
  `grok-imagine-image-2.0` via `api.x.ai/v1/images/generations`. The `provider`
  argument picks the preferred provider (`gpt` by default, or `grok`); when the
  preferred one is logged out the other serves as fallback. Output files land in
  `~/.dsh/plugins/subscriptions/images/`.
- **`video_generate`** — `grok-imagine-video-1.5` via `api.x.ai/v1/videos`
  (async submit + poll). MP4s land in `~/.dsh/plugins/subscriptions/videos/` and
  play inline. Supports duration (1–15 s), aspect ratio, resolution, and
  image-to-video through `image_url`.
- **`x_search`** — xAI-hosted X search returning `{ answer, citations }`.

## Why this exists

Installing several subscription plugins at once:

- loads duplicate adapters → the model picker is slow
- adds several Settings pages → you pick a model twice (composer **and** Settings → Models)

This hub is **one** bundle. After installing it, remove the overlapping plugins
(`dsh-plugin-subscriptions`, `dsh-agy-link`, `dsh-agy`,
`@mars-sea/dsh-commandcode-provider`, `@shatyuka/dsh-llm-codebuddy`, `dsh-xai`
if you only need Grok here). Then pick models **once** in the composer. Hide
extras under Settings → Subscriptions.

## Install

```sh
dsh plugin --profile web add github:zdz6215591/dsh-subscription-hub
```

Git installs run `prepare` (builds `lib/`). pnpm ≥10 blocks that script by
default; add the package name to that profile's `pnpm-workspace.yaml`:

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

The plugin mints LLM tokens from `https://cloud.zed.dev/client/llm_tokens` and
reads remaining usage from `GET /client/users/me` (the same cloud API the
[dashboard billing page](https://dashboard.zed.dev) uses).

## Antigravity

Uses Google OAuth + `daily-cloudcode-pa.googleapis.com` HTTP streaming. It does
**not** spawn `agy` / `cmd.exe`. Keep Clash/TUN on if Google is blocked.

## Referenced projects

This hub is a **derivative aggregation**: it merges the feature surface and bug
fixes of several independent community plugins into one bundle, then adds its own
work on top. Credit and thanks to every project below.

### Primary upstream

| Project | What was taken |
| --- | --- |
| [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) | The original architecture this hub forks: provider adapters (Codex/Claude/Grok/Copilot/Antigravity), the OAuth/device-flow engines, protocol translators, account token managers, multi-account pool, usage plumbing, and the settings-section shell. |

### Community projects consulted for specific fixes and features

| Project | What was taken |
| --- | --- |
| [yoshino-xiao7/dsh-grok-provider](https://github.com/yoshino-xiao7/dsh-grok-provider) | The WebP reference-image transcoding fix: DSH normalizes transparent attachments to `image/webp`, which Grok's Responses endpoint rejects; alpha WebP → PNG and opaque WebP → JPEG before the wire. |
| [Mars-Sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider) | Command Code model-catalog sync (GLM-5.3 FlashX and later), honest 429 reporting, account-scoped rejection rotation, and the plans/quota panel ideas. |
| [amlyczz/dsh-agy-link](https://github.com/amlyczz/dsh-agy-link) | Antigravity native tool-card rendering, thinking-row filtering, per-account conversation-DB discovery, and the `/agy` workspace-passing pattern. |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | WorkBuddy/CodeBuddy region handling, the CN enterprise billing endpoint, and the quota-display rules (refusing to draw an uncapped plan as 100% full). |
| [HaoyueQin/dsh-better-reasoning-effort](https://github.com/HaoyueQin/dsh-better-reasoning-effort) | Per-model reasoning-effort editing inside the official Models card, including the knowledge-base + protocol-inference approach and the credential-bearing probe hardening. |
| [nickhelion/dsh-plugins](https://github.com/nickhelion/dsh-plugins) (`qwen-token-plan-cn-responses`) | The Responses-wire tool-call-id handling patterns and the first-party reasoning-probe technique for third-party models. |
| [lninghaha/dsh-coding-subscription-oauth](https://github.com/lninghaha/dsh-coding-subscription-oauth) | Grok CLI v2 multi-account credential-store parsing and expired-token refresh, plus region-error mapping for region-gated models. |
| [igormel81/dsh-chat-cost](https://github.com/igormel81/dsh-chat-cost) | The multi-provider price catalog and per-million-token costing model behind this hub's savings banner. |

### Where a project's own update flow goes

When asked to **review the reference projects and update this hub**, the answer is
always reported in two clearly separated lists:

1. **Shared bugs worth fixing** — a concrete defect another project fixed that
   this hub also has (with the upstream commit or PR named).
2. **Features worth adding** — a capability another project has that this hub
   lacks (with an assessment of whether it fits this hub's one-bundle design).

Each entry names the source project, states the concrete change, and says
whether it was adopted, adapted, or deliberately skipped (and why). Nothing is
merged silently.

## Development notes

- `npm test` — TypeScript build plus the full offline suite.
- `npm run build` — emits `lib/client.js` and `lib/index.js`.
- The runtime loads `lib/index.js`; a Node-side change needs a DSH restart,
  while a client-side change applies on a browser refresh.

## License

MIT. See [NOTICE](NOTICE) for upstream attribution.
