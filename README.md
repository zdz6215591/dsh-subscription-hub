# dsh-subscription-hub

Unified subscription plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

English | [中文](README.zh.md)

One Settings → **Subscriptions** page for ten subscription routes:

| Route | Subscription | Notes |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | live catalog, usage, Fast tier |
| `claude` | Claude Pro/Max | OAuth or import Claude Code |
| `grok` | SuperGrok / X Premium | live catalog, usage, Imagine tools |
| `agy` | Google Antigravity | **HTTP OAuth only** — no `agy` CLI, no flashing `cmd.exe` windows |
| `commandcode` | Command Code Go | Import `~/.commandcode/auth.json` or paste API key (Studio optional) |
| `cline` | Cline (ClinePass) | paste a `sk_…` key; live quota windows, **per-model upstream channel pinning** |
| `codebuddy` | Tencent CodeBuddy | browser OAuth, daily auto check-in |
| `trae` | Trae (CN) | imports the local sign-in from **TRAE SOLO CN** and the **Trae CN IDE**; live catalog, credits, daily auto check-in |
| `copilot` | GitHub Copilot | device-code login |
| `zed` | Zed Pro | Windows import from Credential Manager, or paste userId + token; usage from `cloud.zed.dev/client/users/me` |

Also included:

- **Lifetime token accounting + savings banner** — totals every subscription
  token you have spent and prices it against pay-as-you-go API rates, showing
  the money you avoided paying (in ¥, with a per-subscription breakdown).
- **Multi-account pool** with quota-aware rotation, per-account usage bars, and
  image-request account failover.
- **Visible-model checkboxes** (composer picker only) plus a **Refresh models**
  button that drops the server's catalog cache and re-reads the live list.
- **Cline upstream channel pinning** — the only route with a channel layer.
  Cline fans one model across several backing providers; each model can pin an
  ordered channel list, exclude channels, and pick a routing metric (cheapest /
  fastest first token / highest throughput). See below.
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

## Cline upstream channels

Cline's gateway hides two different backends behind one URL — an
OpenRouter-style router and a Vercel-AI-Gateway-style planner. Which one serves a
model decides both which providers can serve it and how a pin must be spelled,
so this plugin detects the pipeline at runtime and writes the matching fields:

| Pipeline | Detection | Pin fields |
| --- | --- | --- |
| `direct` (OpenRouter) | top-level `provider` string | `provider.only` / `.order` / `.sort` |
| `planner` (Vercel AI Gateway) | `provider_metadata.gateway.routing` | `providerOptions.gateway.only` / `.order` / `.sort` |

Until a pipeline has been observed it gets **both** spellings, since each
pipeline ignores the other's fields.

In **Settings → Subscriptions → Cline → Upstream channels**:

- **Detect channels** probes the model's channel list in two steps. First a real
  ping is sent and its `provider_metadata.gateway.routing` is read, which names
  the pipeline, the provider that actually served the request, and the whole
  `fallbacksAvailable` order. Then an impossible provider (`only: ['__probe__']`)
  is sent with the matching pipeline spelling so the router fails *before*
  spending a token and names its own list. The result is the union of both.
  The ping matters because some models are served by exactly one upstream the
  gateway has no `only`-filter list for — Vercel's `openai-compatible-private`,
  and the direct-pipeline rows behind `InferenceNet` / `Xiaomi` — so the real
  response is the only place those channels are named at all.
- **Click a channel** to pin it; the click order is the try order (the number on
  the chip shows it). Click again to unpin.
- **⊘** excludes a channel. Excludes are compiled into an `only` allow-list,
  because the gateway silently ignores exclude/ignore fields.
- **Strict** sends only the pinned channel; **Preferred** tries the pinned
  channels in order and fails over **before the first token**. Once content has
  reached the caller, that stream is the answer — a mid-stream failure is never
  silently retried on another channel.
- **Sort metric** maps to each pipeline's own vocabulary (`cost`/`ttft`/`tps` →
  `price`/`latency`/`throughput`). An empty value is dropped rather than sent,
  because `sort: ""` is rejected with HTTP 400.

An `AUTH` or quota failure stops the chain immediately: every candidate would
fail identically, so rotating channels would only hide the real problem.

Channel discovery is **in-memory** (it is derived data any probe can rebuild),
while pins are **persisted** to `~/.dsh/plugins/subscriptions/cline-pins.json`.

## Trae model list

The CN catalog is read from the official remote directory
(`solo.trae.cn/api/remote/v1/models`) with **every** directory function
unionned — `solo_agent_remote`, `solo_work_remote`, `solo_work_lite`,
`solo_agent`, `solo_coder` — because each function only advertises its own
roster: the agent directory carries `Doubao-Seed-Code`, `glm-5.1`,
`glm-5v-turbo`, `qwen-3.5` and `qwen-3.6-plus`, and the coder directory carries
the legacy `glm-5`, `kimi-k2.5`, `minimax-m2.7`, `DeepSeek-V4-Flash/Pro` and
`Doubao-Seed-2.0-Code` configs. Reading a single directory silently hid all of
them.

Two other rules keep the picker honest:

- **Only callable configs are listed.** The directory also advertises
  `deepseek-v4.1-flash`, `glm-5.3-flash`, `glm-5.3-flashx`, `qwen3.8-flash` and
  `kimi-k2.8-preview`, but every SOLO function answers `4001 param is invalid`
  for them (they belong to the IDE agent-task channel). Listing them would hand
  the picker a model that always fails, so they are dropped. The familiar
  `deepseek-v4.1-flash` id is still served, mapped onto the proven
  `DeepSeek-V4-Flash-Official` wire config.
- **Metadata comes from the richest row.** Only the agent directories carry
  `reasoning_effort_config` (the thinking-level selector) and the larger Max
  context window, so a row first seen in the work roster keeps its owner
  function while the effort levels and the Max window are folded in. A row whose
  `max` window merely repeats `dev` exposes no budget switch.

### Check-in

The daily claim tolerates both upstream behaviours the web client lives with:

- a day that is already claimed counts as **success**, not an error;
- the transient `当前签到人数过多` refusal (the claim queue is saturated) is
  **retried with backoff** (2s → 5s → 10s). Today's status is re-read between
  attempts, so a claim that actually landed on a saturated answer is still
  reported as the success it is. Only after the retry budget is spent does the
  card show the message, together with the note that the claim is idempotent —
  retrying later, or in the Trae client, is safe.

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
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | Primary reference for the Trae route: local credential discovery (`storage.json` + the `iCubeAuthInfo://icube.cloudide` decryption), the `llm_utils_chat` request envelope, the named-SSE vocabulary, tool-call handling, and the read-only credit/check-in endpoints. |
| [Wang-JQ77/dsh-trae-api](https://github.com/Wang-JQ77/dsh-trae-api) | Secondary Trae reference: the four-edition layout (Trae CN / TRAE SOLO CN / Trae / TRAE SOLO), the `tc` container format, and the endpoint-fallback shape. |
| [yhshzh/dsh-cline-pass](https://github.com/yhshzh/dsh-cline-pass) | Primary reference for the Cline route: the OpenAI-compatible wire shape, SSE → harness translation, tool-call and reasoning handling (`reasoning` / `reasoning_content` / `reasoning_details`), and — most importantly — the **per-model upstream channel pin**: the `PinProfile` schema, the two pipeline spellings, the exclude→allow-list rule, the per-pipeline sort mapping, and the zero-cost impossible-pin channel probe. |
| [munmunjaklin458-afk/cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher) | The seminal Cline Pass routing controller: upstream multi-candidate sequential failover, per-attempt timeout isolation, bare-JSON error stream detection before the first chunk, real batch channel validation (`validateUpstreams` with min-request verification), and error-triggered available-provider learning (`learnAvailableProviders`). |
| [GooDAnDReaDY/dsh-clinebot](https://github.com/GooDAnDReaDY/dsh-clinebot) | Secondary Cline reference: the `apiKeyEnv` credential-reference pattern, the `disabledModels` allow-list model, the `/users/me/plan/usage-limits` quota windows (5-hour / weekly / monthly with 80% and 95% thresholds) that back this hub's Cline usage bars, and the plan-label parsing. |

### Keeping in sync with the reference projects

**Standing rule: whenever the user asks to "check the reference projects and
update this hub", the answer is reported as two clearly separated lists**, each
entry naming the source project and marking the change **adopted / adapted /
deliberately skipped** (with the reason):

1. **Shared bugs worth fixing** — a concrete defect another project fixed that
   this hub also has (naming the upstream commit or PR).
2. **Features worth adding** — a capability another project has that this hub
   lacks (with an assessment of whether it fits the one-bundle design).

The Trae and Cline projects above are **live references**, not historical
credits: their provider endpoints, model rosters, and pin/probe mechanics change
with the upstream products, so both lists must be re-checked on every such
request. Nothing is merged silently.

## Development notes

- `npm test` — TypeScript build plus the full offline suite.
- `npm run build` — emits `lib/client.js` and `lib/index.js`.
- The runtime loads `lib/index.js`; a Node-side change needs a DSH restart,
  while a client-side change applies on a browser refresh.

## License

MIT. See [NOTICE](NOTICE) for upstream attribution.
