# dsh-subscription-hub

Unified subscription plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

English | [中文](README.zh.md)

One Settings → **Subscriptions** page for thirteen subscription routes:

| Route | Subscription | Notes |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | live catalog, usage, Fast tier |
| `claude` | Claude Pro/Max | OAuth or import Claude Code |
| `grok` | SuperGrok / X Premium | live catalog, usage, Imagine tools |
| `agy` | Google Antigravity | **HTTP OAuth only** — no `agy` CLI, no flashing `cmd.exe` windows |
| `commandcode` | Command Code Go | Import `~/.commandcode/auth.json` or paste API key (Studio optional) |
| `cline` | Cline (ClinePass) | paste a `sk_…` key; live quota windows, **per-model upstream channel pinning** |
| `freebuff` | Freebuff | CLI-style browser login, import from the Freebuff CLI, or paste a Bearer; live freebucks quota — **the free tier is CLI-channel-gated** |
| `codebuddy` | Tencent CodeBuddy | browser OAuth, daily auto check-in |
| `qoder` | Qoder | paste a Personal Access Token; the deployment (**qoder.com** vs **qoder.com.cn**) is discovered, not picked; live catalog, credit packages, daily auto check-in |
| `trae` | Trae (CN) | imports the local sign-in from **TRAE SOLO CN** and the **Trae CN IDE**; live catalog, credits, daily auto check-in |
| `joycode` | JD JoyCode | imports the local JoyCode IDE credential, or paste ptKey + userId; live catalog, **three wire paths chosen per model** |
| `copilot` | GitHub Copilot | device-code login |
| `zed` | Zed Pro | Windows import from Credential Manager, or paste userId + token; usage from `cloud.zed.dev/client/users/me` |

Also included:

- **Lifetime token accounting + savings banner** — totals every subscription
  token you have spent and prices it against published pay-as-you-go API rates,
  showing the money you avoided paying (in ¥, with a per-subscription breakdown).
  It reads both transcript generations (a turn's usage is recorded either as a
  stream `usage` chunk or on the settled assistant message — a session uses one
  or the other), prices each turn by its own catalog row including the
  peak/off-peak windows, context-length bands and cache-write rates that row
  publishes, and contributes NO cost for a model no published rate covers
  (reporting it as an unpriced turn) instead of guessing a lookalike or a generic
  rate. **Recalculate** re-walks the whole history.
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

## Freebuff

Freebuff (codebuff.com) speaks its own Bearer/OpenAI-shaped wire
(`POST {www.codebuff.com}/api/v1/chat/completions`). The card has **exactly three
buttons**, and the first two are the official CLI's own credential paths:

| Button | What it does |
| --- | --- |
| **Login** | A replica of the CLI's browser login — no local callback port, no PKCE. `POST https://freebuff.com/api/auth/cli/code {fingerprintId}` answers `{loginUrl, fingerprintHash, expiresAt}`; you authorize on that page and the card polls `GET https://freebuff.com/api/auth/cli/status?fingerprintId&fingerprintHash&expiresAt` **every 5 s for up to 300 s**, stopping as soon as `data.user` is an object. The browser never has to reach this machine. |
| **Import from Freebuff CLI** | Reads what the official CLI already stored — `~/.config/manicode/credentials.json`, `default.authToken` — and validates it against the session endpoint **before** storing anything; other profiles in that file are left alone. `~/.config/manicode` is the CLI launcher's own convention, the same under the home directory on every platform, Windows included. |
| **Manual input** | **Bearer only.** |

**No cookie login at all.** A freebuff.com session cookie is not a channel this
route supports, and no fallback stands behind it: the web/cookie wire was deleted
outright, because it takes one flat prompt string with no `tools` field, so a turn
through it would lose every harness tool without saying so. The only
cookie-related code left exists to RECOGNISE a cookie and refuse it by name — the
other wrong turn a cookie invites is replaying its session-token value as a
Bearer, which draws the upstream's ban-shaped `403`.

**The quota read is real, and it needs no cookie.**
`GET https://www.codebuff.com/api/v1/freebuff/session` with the CLI's own header
set answers `200` and the daily freebucks block — `balance`,
`daily.{limit, spent, remaining, resetAt, resetTimeZone}`, `wallet`, `planId` and a
per-model price map — so the credits window the card shows is the upstream's own
number.

**The hard finding: a FREE account cannot chat through the API at all, so it
cannot use tools either.** Verified live with the official CLI's own `authToken`,
an ACTIVE admitted session bound to this hub's own `cli:` instance, the
model-specific free agent, and a run id issued by `POST /api/v1/agent-runs`, the
chat call still answers:

```json
{"error":"free_mode_cli_required","message":"Free mode is only available through the freebuff CLI. Install it with `npm i -g freebuff`, then run `freebuff`. Calling the API directly is not supported and may get your account banned."}
```

That is HTTP `403` on a plain turn — no tools involved — which proves the gate is
the **channel**, not session state. So on a free account this route can
authenticate and read the quota, and then the first turn fails with the upstream's
own words: nothing is silently downgraded, the refusal is shown as it is, and
free-tier text and tools are CLI-only. **A paid credential is untested.**

What a turn encodes, for anyone comparing notes: session admission
(`POST /api/v1/freebuff/session/admission`) →
`POST https://www.codebuff.com/api/v1/agent-runs {action:"START", agentId, ancestorRunIds}`
for the **model-specific** free agent (`base2-free-space-bunny-alpha`) → the chat
call carrying
`codebuff_metadata{run_id, client_id, cost_mode:"free", freebuff_instance_id:"cli:<uuid>", freebuff_multi_session:"1", surface:"cli"}`
plus the CLI's `x-freebuff-*` headers. The agent step matters: free mode validates
the run's agent against the requested model, so a run started for the generic
`base2-free` is refused for every model but one.

**The admitted session is an ATTEMPT, and an attempt is one-shot.** The
`x-freebuff-desktop-attempt-id` header is the uuid part of the `cli:<uuid>`
instance, and the upstream retires it for good once that session start is over: a
released attempt answers `409 {"status":"purchase_claim_released",…}` and a
cancelled one (after `DELETE /api/v1/freebuff/session/attempt`) answers
`409 {"error":"admission_attempt_closed",…}` to every later admission POST,
permanently. The official CLI therefore mints a fresh `cli:<uuid>` per claim
(`wr()` = `"cli:" + randomUUID()`) and answers a release by starting a new
session; pinning one instance to a credential — what this route did until
2026-09-29 — bricks the account's turns for good. The route now holds the live
claim in memory, re-admits it while it is live (the upstream echoes the same
`admittedAt`/`expiresAt`, so this is idempotent and costs no extra session),
replaces it when the upstream retires it, and releases it
(`DELETE …/session/attempt`) before a model switch — because a live claim holds
the account's ONLY free slot (`slotLimit: 1`), so a second attempt minted while it
is live is refused with `409 {"status":"purchase_capacity","currentInstanceId":
"cli:<the holder>"}`. Every one of those statuses is handled by name, with the
remedy in the reader's own terms (end the other session in the CLI, ask for the
holder's model, or start a new session there) instead of a bare HTTP 409.

The wire shape and the pinned roster come from the reference project
[`lza6/Freebuff-2API`](https://github.com/lza6/Freebuff-2API); the login flow, the
credential path and the quota endpoint's header set were read from the official
CLI binary itself, and the `403` above is a live observation. The source cites all
of it by file and symbol.

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

### Model metadata comes from the official catalogs

Nothing about a Cline model's context window, output cap, modalities or thinking
levels is hard-coded any more. A discovery read merges two official sources:

- **Cline's own catalog** — `GET {base}/ai/cline/models` (public, no auth). It
  carries `context_length`, the per-provider `max_completion_tokens` cap and
  `architecture.input_modalities` for all 443 catalog models. Its ids are the
  underlying slugs (`z-ai/glm-5.3`), so a `cline-pass/*` id is mapped onto them
  by provider namespace (`z-ai`/`zai`, `deepseek`, `moonshotai`, `minimax`,
  `qwen`, `alibaba`, `xiaomi`, `meta`, …), with an explicit override for the one
  that needs it (`muse-spark-1.3-contributor` → `meta/…`).
- **models.dev** — the community registry the reference implementations also
  read, and the only source that publishes the per-model reasoning levels
  (`reasoning_options[].values`). It wins where both speak.

The static table is now only an offline safety net: it still supplies the id set
when a read fails, but a live read always overrides its numbers. Where no source
discloses a model's levels (the three newest rows), the adapter falls back to the
gateway-wide list rather than inventing a restriction.

### Auditing the metadata

`scripts/manual/audit-model-metadata.mjs` re-checks every provider's context
windows and thinking levels against its own endpoint, using the credentials the
hub already stores. Run it whenever a roster or a window is in question:

```sh
node scripts/manual/audit-model-metadata.mjs
```

It prints `LIVE` (the provider's own answer) beside `HUB` (what this plugin
resolves), lists anything that disagrees under `PROBLEMS`, and exits non-zero
when it finds one. Providers it cannot check — an expired Codex CLI token, a
Copilot credential that is not on this machine — are reported as `SKIPPED`
rather than quietly passing.

The last run found and fixed three real errors:

| Provider | Was | Now | Why |
|---|---|---|---|
| Trae | `Doubao-Seed-Code` = 184000 | 256000 | Several directories advertise one `config_name` with different windows; first-seen won, so the narrower `solo_coder` row locked out the wider `solo_agent` one. The widest now wins. |
| AGY | `gemini-3.1-flash-lite` had a low/medium/high picker | no picker | The id-prefix guess (`gemini-3*`) overrode the catalog, which marks this row as having no thinking support. Sending `thinkingLevel` to it is a 400. The catalog is now authoritative for every row it lists; the prefix guess only covers ids the pin does not know. |
| Grok | fallback window 256000, three retired model ids | 500000 and the live four ids | The live CLI catalog serves `grok-4.5/4.6/4.7` + `grok-4.7-build-fast`, each with a 500000-token window. The stale fallback made an offline start under-report the window and offer ids nobody serves. |

Two findings were **checked and found correct**, not bugs: `gemini-2.5-pro`
reasons without a level picker (the Antigravity `thinkingLevel` axis is a
Gemini-3+ feature; 2.5 takes a fixed thinking budget), and the plain
`charAt(0).toUpperCase()` effort naming — `max` is the vendors' own label
("Max"), so "Maximum" would have been a gratuitous divergence.

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

## JoyCode (京东)

JoyCode is an IDE-first product whose private API has no public documentation. This
hub speaks it **directly** against JD's gateway — no local JoyCode process is
involved, which is what makes the route usable on a server.

### Three ways to sign in

- **Browser / QR sign-in** — the button opens JoyCode's own login page (which shows the
  JD-app QR), and that page hands the credential back to a **local port** automatically:

  ```
  https://joycode.jd.com/login/?ideAppName=JoyCode&fromIde=ide&redirect=0&authPort=<local port>&authKey=<one-time key>
                    ↓  user scans / authorizes on that page
  http://127.0.0.1:<local port>/api/oauth-callback?pt_key=…&login_type=…&tenant=…&authKey=…
  ```

  This is the mechanism the JoyCode IDE itself uses. The callback only reaches the
  **local** machine; when the browser is elsewhere (DSH on a server), pasting the
  callback page's address-bar URL into the paste field works just as well — the plugin
  extracts the `pt_key` and validates it. `authKey` is single-use: another attempt's
  callback is refused instead of settling this one.
- **Import from the JoyCode IDE** (desktop) — reads the credential that IDE stored:
  the `JoyCoder.IDE` key of the `ItemTable` table in
  `…/JoyCode/User/globalStorage/state.vscdb`. The database is opened **read-only**, so
  the running IDE is never blocked; the macOS / Linux / Windows locations, the
  container mount `/root/.joycode-ide/state.vscdb` and a `JOYCODE_STATE_DB` override
  are tried in order, and a failed import reports every path it probed.
- **Paste a ptKey** (headless) — as `ptkey: … userid: …`, as the `ptKey` alone (the API
  reports the user id), or as that key's JSON document.

> **Why the raw JD QR endpoint is not implemented:** the reference's own postmortem
> (`docs/superpowers/plans/2026-05-03-qr-login-redirect-to-auto-login.md`) records that JD's
> `qrCodeTicketValidation` "不再通过 HTTP Set-Cookie 返回 `pt_key`" — 14 cookies, no `pt_key` — and
> that project replaced that flow with exactly the page-driven login above. What ships here is
> therefore the QR path that actually yields a credential (the scan happens on the JoyCode
> login page).

All three end in one `userInfo` call, so nothing is stored until the upstream
accepts it — and that call can return a **ROTATED ptKey**, which is why this route
re-validates on the reference's hourly cadence: it keeps the key warm and persists
whatever the upstream just handed over.

### Three wire paths, chosen per model

Sending a model to the wrong one does not fail loudly — it returns **empty output**
or a bare business code:

| Family | Wire path | Why |
| --- | --- | --- |
| `GPT-*` | `/api/saas/openai/v1/responses` | the chat path answers business code **1032** for these |
| `Claude-*` | `/api/saas/anthropic/v1/messages`, model name suffixed **`-hq`** | both OpenAI paths return **empty output** for the Claude family; the bare label is refused (**6002**) |
| everything else (GLM / Kimi / DeepSeek / MiniMax / Doubao / JoyAI) | `/api/saas/openai/v2/chat/completions` | — |

The catalog comes from the live `modelList` (`chatApiModel` is the wire name, `label`
the display name). Capabilities — the 200k context, each model's output cap, vision —
are declared only where the reference published them: **an id the table does not
describe is not guessed at**. A credential that carries a gateway origin gets the
HMAC-signed gateway with `functionId` routing; anything else uses the direct v2 path.

### Thinking levels

Only models with published level evidence get a picker:

- **GPT family** — `low / medium / high / xhigh / max`, which the reference's own test
  verifies as five distinct values, mapped onto `reasoning.effort`; `off` sends `none`.
- **Chat families** (GLM / Kimi / DeepSeek / MiniMax / Doubao) — the level is forwarded
  verbatim as `reasoning_effort`, and `off` sends `thinking: { type: "disabled" }`;
  Doubao additionally needs `thinking: { type: "enabled" }` (the reference's own
  behaviour).
- **Claude family** — no level evidence exists, so it gets no picker and no thinking
  parameter is sent.

### Models, context and quota

- **The roster is the LIVE `modelList`**: the models you see are exactly the ones the
  account's catalog carries — no more, no fewer (`chatApiModel` is the wire name, `label`
  the display name). The pinned table (16 published ids) only fills in fields the catalog
  does not publish; an id it does not describe still appears, just without declared
  capabilities.
- **200k context, 64k output.** Both come from the reference's LIVE probe record
  (`dashboard/handler.go`, `modelCapabilities`, probed 2026-09-10/11): `advertised_ctx` is the
  upstream's own `maxTotalTokens` label (200 000) and `max_output_tokens` is 64 000 for every
  model. The same probes recall ~0.9–1.0 MILLION tokens successfully and error at 1 000 000,
  so the real window is larger than the label — this route declares the published label,
  because understating makes the harness compact early while overstating breaks a request.
- **Thinking levels only for the GPT family.** It is served by OpenAI's Responses API, whose
  `reasoning.effort` vocabulary is published, and the reference's test pins all five values as
  surviving translation. The chat families (GLM / Kimi / DeepSeek / MiniMax) reason (probed)
  with no documented level axis, so they get no picker; Doubao and the whole Claude family are
  probed as NON-reasoning.
- **There is no quota/credit endpoint.** JD's balance lives in its client, and neither
  reference reads it: JoyCode2api keeps local token accounting only, and switch-dev's README
  states outright that it reuses the tool's own quota and that its cost figures are estimates
  from a built-in rate table ("真实消耗看各工具后台"). So this route shows **no composer pill
  and no balance** — nothing is displayed rather than a number upstream never disclosed.
- **Spend is still visible.** JoyCode's models are priced (including `Doubao-Seed-2.0-pro` and
  the two `-jcloud` variants; only `JoyAI-Code-1.5` has no trustworthy rate and stays unpriced),
  so the savings banner values their tokens at published API rates. Provenance is recorded row
  by row in `model-prices.ts`, including that table's version and notes.

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
| [masknull/dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect) | Primary reference for the Qoder route: the PAT → job-token exchange and its cache/single-flight, the two-region endpoint table (`api3.qoder.sh` / `gateway.qoder.com.cn`), the `Encode=1` WAF body codec (custom alphabet plus the three-chunk Base64 rotation), the COSY RSA+AES+MD5 signature header set, the `agent_chat_generation` request envelope and its encoded SSE, the `model/list` catalog with its per-model `context_config` (default vs largest window), and the `quota/usage` + `user/plan` + `user/status` credit views. |
| [Variyaone/JoyCode2api-VABoost](https://github.com/Variyaone/JoyCode2api-VABoost) | Primary reference for the JoyCode route: a Go proxy that reverse-engineers JD's private JoyCode protocol into OpenAI/Anthropic shapes. Adopted its **three wire paths** (`chat/completions`, `responses`, native `anthropic/messages`), the gateway HMAC signature and `functionId` routing, the request envelope with its per-path `loginType`/`tenant` defaults, the `-hq` internal Claude model ids, the `ChatToResponses` request translation, the **double-wrapped SSE** (`data: data: {…}`) shape, the per-family thinking mapping (GPT `reasoning.effort`, chat `reasoning_effort` + the `thinking` switch, Claude `output_config.effort`), the capability table with its context/output budgets, and the `userInfo` keepalive that **rotates the ptKey**. |
| [rosanruan/switch-dev](https://github.com/rosanruan/switch-dev) | Secondary reference for JoyCode's credential layer: the cross-platform discovery and read-only open of the `JoyCoder.IDE` state database (`state.vscdb`), its `userName`/`loginType` default handling, and the **extension-version** read — the gateway's gray-release gate trusts the joycoder-editor extension's version rather than the app shell's — plus recognition of the `AI_GRAY_ACCESS_DENIED` / `COLOR_FORWARD_EXCEPTION` gray refusals. |
| [lza6/Freebuff-2API](https://github.com/lza6/Freebuff-2API) | Primary reference for the Freebuff route: the Bearer/OpenAI-shaped wire and the CLI-shaped `x-freebuff-*` header set, the `codebuff_metadata` body fields, the `run_id` bootstrap (`/api/v1/agent-runs`), the pinned authoritative model roster with its paused-id exclusion, and the upstream error-code mapping. Everything CLI-side — the login flow, the credential path (`~/.config/manicode/credentials.json`) and the quota endpoint's header set — was read from the official CLI binary instead, which is also where the `403 free_mode_cli_required` channel gate was found. |

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

The record of the last full pass — every difference found, each marked
**adopted / adapted / deliberately skipped**, plus the items still open — is kept
in [`docs/reference-audit.md`](docs/reference-audit.md). Read it before starting
another pass so the same ground is not covered twice.

## Development notes

- `npm test` — TypeScript build plus the full offline suite.
- `npm run build` — emits `lib/client.js` and `lib/index.js`.
- The runtime loads `lib/index.js`; a Node-side change needs a DSH restart,
  while a client-side change applies on a browser refresh.

## License

MIT. See [NOTICE](NOTICE) for upstream attribution.
