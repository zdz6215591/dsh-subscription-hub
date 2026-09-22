# Reference-project audit — findings and dispositions

This document records one full pass over every reference project this hub is a
derivative of, comparing it against the hub's own implementation and recording
each difference as **adopted / adapted / deliberately skipped**.

The standing rule (see `README.md` → "Keeping in sync with the reference
projects") is that such a pass is reported as two clearly separated lists. This
is that record.

Audited references:

| Reference | Read for |
| --- | --- |
| `yhshzh/dsh-cline-pass` (ref-cline-pass) | the Cline pin mechanism, SSE translation, channel probe |
| `GooDAnDReaDY/dsh-clinebot` (ref-clinebot) | Cline usage windows, plan label, `apiKeyEnv`, `disabledModels` |
| `munmunjaklin458-afk/cline-pass-switcher` (ref-switcher) | multi-candidate failover, batch channel validation, self-learning |
| `dingminhua/dsh-connect-trae` (ref-trae-primary) | Trae credentials, envelope, named SSE, usage/check-in |
| `Wang-JQ77/dsh-trae-api` (ref-trae-api) | Trae editions, `tc` container, endpoint fallbacks |
| `Mars-Sea/dsh-commandcode-provider` (ref-commandcode-provider) | Command Code transports, catalog, retry/rotation, plan panel |
| `V1ki/dsh-plugin-subscriptions` (ref-dsh-plugin-subscriptions) | the plugin this hub supersedes |

---

## Part 1 — Shared bugs worth fixing

Each entry names the source project and what was done about it.

### Cline

| # | Defect | Source | Disposition |
| --- | --- | --- | --- |
| C1 | **The auth/quota short-circuit was dead code.** The adapter compared `error.code` against `'INVALID_CREDENTIAL'` / `'QUOTA_EXCEEDED'`, but the hub's own `httpLlmError` maps 401/403 to `'AUTH'` and uses the harness's `QUOTA_EXCEEDED_CODE` (`'QUOTA'`). Neither literal was ever produced, so an expired key did **not** stop the chain: every pinned channel was re-hit with doomed requests, verdicts were polluted by those failures, and the user got the last channel's error instead of `unauthorized`. | ref-cline-pass (`lib/adapter.js:536-539`, `:568-579`) | **adopted** — `isFatalPinnedFailure()` now tests `'AUTH'` / `QUOTA_EXCEEDED_CODE` / the missing-credential family. Pinned by a test asserting exactly **one** request on a 401. |
| C2 | **A mid-stream failure after the first chunk was swallowed.** `streamFailure` was recorded and then never consulted on the `hasDeliveredContent` path, so a cut stream was delivered as a complete answer (no error, no harness retry) and a cut inside a tool call emitted a `block-end` carrying truncated JSON arguments the loop would try to execute. | ref-cline-pass (`lib/adapter.js:568-579`) | **adopted** — the failure is rethrown once content has been delivered. |
| C5 | **`finish_reason: length` + tool calls was reported as `tool-calls`**, advertising a complete call with partial arguments. | ref-cline-pass (`lib/adapter.js:215-229`) | **adapted** — a truncating finish now reports `max-tokens` and drops the calls, matching both the reference and the harness assembler (`assembler.js:121-126`). |

### Trae

| # | Defect | Source | Disposition |
| --- | --- | --- | --- |
| T1 | **No token refresh at all** (see Part 3, open items). | ref-trae-primary (`refresh.ts:22-27`, `auth.ts:477-502`) | **deferred** — see Part 3. |
| T2 | **Two directories advertising one `config_name` with different windows**: first-seen won, so `Doubao-Seed-Code` was locked to 184000 by the narrower `solo_coder` row and the wider `solo_agent` 256000 was skipped. | ref-trae-primary (`catalog.ts:163-196`) | **adopted** — the widest advertised window now wins. |
| T3 | **Empty id/name fragments overwrote a learned tool call** (`call.id ?? current.id` treats `""` as a value). | ref-trae-primary (`solo.ts` tool-call handling) | **adopted** (earlier pass) — empties are dropped and the learned value is retained. |

### AGY

| # | Defect | Source | Disposition |
| --- | --- | --- | --- |
| A1 | **`gemini-3.1-flash-lite` was handed a thinking-level picker** it does not support: the id-prefix heuristic (`gemini-3*`) overrode the catalog row, which marks the model as having no thinking support. Sending `thinkingLevel` to it is a 400. | ref-dsh-plugin-subscriptions (`providers/antigravity.ts` thinking path) | **adopted** — the pinned catalog is authoritative for every row it lists; the prefix guess only covers ids the pin does not know. |
| A2 | **A revoked Google grant was treated as transient.** The predicate regexed `/invalid_grant/` over `error.message`, but the message is built from `error_description` — Google sends `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`, so the literal never appeared. The session was never removed, the card never said "log in again", and a doomed refresh was retried forever. | ref-dsh-plugin-subscriptions (`providers/antigravity.ts:354-358`, matching on the structured code) | **adopted** — checks the structured `oauthCode` first. |

### Grok / CommandCode / Zed

| # | Defect | Source | Disposition |
| --- | --- | --- | --- |
| G1 | **The offline fallback window was 256000** while the live CLI catalog reports **500000** for every model it serves, and the fallback roster listed three retired ids. | ref-commandcode-provider pattern (live-catalog-derived fallbacks) | **adopted** — constant and roster aligned to the live catalog. |
| G2 | **`TRANSPORT` shares the route's near-unbounded retry window.** CommandCode's policy is 500 attempts with waits doubling to 900 s; `TRANSPORT` is in the harness's default retryable set, so a connection that cannot be established enters that loop and stalls for minutes. The reference's own `AGENTS.md` documents this as issue #39. | ref-commandcode-provider (`src/transport-retry.ts`, `Config.transportMaxRetries`) | **deferred** — see Part 3; the reference's fix is a bounded per-agent budget on `agent/request-error`. |
| Z1 | **A network blip deleted an account.** `refreshAccessToken` returned `undefined` on a *transport* failure, indistinguishable from a server refusal, and the permanent predicate was a loose `/refused\|401\|invalid/i` over the message — which also matched "connection refused" and "invalid URL". | ref-commandcode-provider (`accounts.ts` passive rotation: marks only on a real pre-stream rejection) | **adopted** — a transport failure now throws a typed `CodeBuddyTransportError` that the predicate does not match, and the predicate keys on the exact refusal marker. Zed's predicate is now **code**-based (`AUTH`/`INVALID_CREDENTIAL`) instead of message text. |

### Cross-cutting (no reference has these)

| # | Defect | Evidence | Disposition |
| --- | --- | --- | --- |
| X1 | **OAuth loopback `start()` was a check-then-act across an `await`.** The "one attempt per provider" guard ran before `await listen(...)`, and `settle()` deleted the slot unconditionally — so two concurrent starts both bound ports, the second became registered, and the first attempt's callback then unregistered the second while it was still listening. The tab the user actually authorized carried the older claim and its exchanged session was **discarded**. | reproduced by running the compiled manager | **adopted** — the slot is reserved before the first await and released only by its owner. |
| X2 | **`catalog-store` did an unserialized read-modify-write of the shared `models.json`.** Five concurrent saves threw `EPERM rename` twice and left the file holding **one** provider; the throw is swallowed upstream, so four providers' metadata vanished silently until a restart. Triggered by the normal path (`families()` lists every provider's models concurrently). | reproduced | **adopted** — mutations are serialized per path. |
| X3 | **A transient read error wiped the visibility list.** `readDocument` mapped any non-ENOENT I/O error to an empty document, and `syncDiscoveredModels` then seeded and **wrote** it back — permanently clearing the user's hidden list. The corrupt-file self-heal also wrote from inside the read, outside the file lock. | trace | **adopted** — a degraded read is flagged and never written back; the heal is queued through the lock and re-reads first. |
| X4 | **A partially-shaped `token-stats.json` crashed the stream path.** The file was accepted on the strength of `totalTokens` alone; the next increment threw `TypeError` on `byProvider` — from inside the adapter's stream wrapper, so the turn failed *after* the model had answered. | reproduced (`{"totalTokens":10,"savedRmb":1}`) | **adopted** — the full shape is validated on load. |
| X5 | **Every live usage chunk during startup launched its own full history scan** (the coalescing guard only returned early once a summary already existed), each walking and zstd-decompressing the whole sessions tree. | trace | **adopted** — an in-flight scan is shared. |
| X6 | **A pid-only temp name was shared by concurrent writers** to `token-stats.json`. | trace (every other store already used a nonce) | **adopted** — random nonce. |
| X7 | **The `status` RPC had lost per-provider error containment**: one provider throwing blanked the entire Subscriptions page. | trace | **adopted** — each provider is contained and degrades to its own error entry. |
| X8 | **`sharp` was resolved through a hard-coded absolute path** naming one machine's install (`C:/Users/DongZhi/.../sharp/lib/index.js`), both candidates swallowed by an empty `catch` — so the advertised WebP reference editing worked on exactly one computer. | trace | **adopted** — the transcoder is resolved through the host's own module tree. |
| X9 | **A spec file never ran.** `test/index.ts` omitted `agy-signature.spec.ts`, so its four thoughtSignature tests were silently absent from every run. | confirmed (495 vs 499 tests) | **adopted** — registered. |
| X10 | **`CommandCode`'s retry comment is stale**: it claims to mirror the reference while the reference has since bounded transport retries. | `commandcode.ts:48-53` vs `ref-commandcode-provider/CHANGELOG.md` | **noted** — comment corrected; the budget itself is Part 3. |

---

## Part 2 — Features worth adding

Ranked by value. None of these is implemented yet; each names what it does, where
the reference implements it, and the effort.

### High value

| # | Feature | Source | Effort | Fits? |
| --- | --- | --- | --- | --- |
| F1 | **Trae token refresh.** The reference runs the per-edition `ExchangeToken` grant inside a 5-minute margin and persists its own copy under a lock. The hub stores the `refreshToken` and never uses it. | ref-trae-primary `refresh.ts:22-27,47-86`, `auth.ts:306-312,477-502` | S–M | Yes — the `TokenManager` seam (`preemptMs`/`refresh`) already exists. |
| F2 | **Route CommandCode Claude models to the CLI transport.** The gateway answers `400 … must be called via /provider/v1/messages` for the whole Claude family on `/provider/v1/chat/completions`, and the hub's only fallback is the Go-plan 403 — so the accounts entitled to Claude are the ones that cannot use it. The live catalog even declares it (`supported_endpoints: ["/messages"]`), and the hub discards that field. | ref-commandcode-provider `capabilities.ts:299-313`, `adapter.ts:2316-2328` | S–M | Yes — and note the reference's warning: do **not** cache the decision per API key, or the whole account is pinned to that transport. |
| F3 | **Replay historical reasoning on CommandCode's CLI transport.** The reference reversed its earlier behaviour (issue #34): DeepSeek/GLM/Qwen thinking-mode tool loops die on iteration 2 with "The `reasoning_content` in the thinking mode must be passed back to the API" when the assistant's tool calls arrive without their reasoning. The hub still drops it, and pins that with a test. | ref-commandcode-provider `adapter.ts:1144-1170`, `CHANGELOG:79` | S–M | Yes. |
| F4 | **One-click Cline channel auto-configure**: probe → validate → pin the working channels ordered by measured latency → exclude the broken → verify with a real call. This removes the route's main failure mode (pinning a dead channel). | ref-cline-pass `lib/panel.js:309-369` | M | Yes — every primitive already exists (`probeClineChannels`, `validateClineChannels`, `setClinePin`); it needs one aggregating RPC and one button. |
| F5 | **Trae international editions** (`trae-global` route) with the region detected from the credential's own claim. The hub supports 2 of the 4 editions and hard-codes CN bases. | ref-trae-primary `paths.ts:19-49`, `region.ts:37-100`, `refresh.ts:22-27`, `usage.ts:202-239` | M–L | Yes — the hub is already a many-route bundle. |
| F6 | **Real Trae device identity** read from the install (64-char `telemetry.machineId`, `icube-dc` device id, `product.json` version). The hub fabricates a fresh identity per process, and `x-machine-id === x-device-id` (both 32 chars) because one random value feeds both. | ref-trae-primary `identity.ts:39-102,241-252` | S | Yes. |
| F7 | **Live Trae callable-set discovery** instead of a hand-written allow-list, so a newly shipped model appears without editing a table. | ref-trae-primary `catalog.ts:163-196`, `solo.ts:135-212` | M | Yes. |
| F8 | **A durable Command Code catalog cache.** The hub's catalog is in-memory with a 5-minute TTL and a 2-model static fallback, so any `/models` hiccup collapses the picker. The hub already owns the machinery (`catalog-store.ts`) and passes it for agy but not commandcode. | ref-commandcode-provider `adapter.ts:528-548,2059-2080` | S | Yes. |

### Medium value

| # | Feature | Source | Effort |
| --- | --- | --- | --- |
| F9 | **Overlong tool-call-id remap.** The gateway rejects `call_id` over 64 chars; the hub passes ids through verbatim, and a cross-route session (its normal case) guarantees a foreign id. | ref-commandcode-provider `adapter.ts:626-662` | S |
| F10 | **Bounded `TRANSPORT` retry budget** (see G2) with a diagnosis naming the proxy as the usual cause. | ref-commandcode-provider `transport-retry.ts` | S |
| F11 | **Temporary-pin verification** (test a pin before saving it, and report which channel actually served) plus a request history (account, provider, canonical slug, attempts, ms). | ref-cline-pass `lib/panel.js:403-407`, `lib/tools.js:401-406`; ref-switcher `server.js:685-711` | M |
| F12 | **Planner tier-0 badge.** `parseTier0` is already implemented in the hub and has zero call sites. | ref-cline-pass `lib/protocol.js:219-223`; ref-switcher `server.js:245-249` | S |
| F13 | **Command Code request-image budget ladder + 413 handling**: the gateway caps a body near 50 MB and the hub always inlines the whole history, so one image-heavy session then fails every later request on that route. | ref-commandcode-provider `adapter.ts:799-846` | M |
| F14 | **Command Code plan/deal/peak annotations and plan filtering** in the picker. | ref-commandcode-provider `capabilities.ts:340-436` | S |
| F15 | **Trae credit multiplier in the model name**, which the hub's own catalog comment already promises. | ref-trae-primary `model-metadata.ts:63-65` | S |
| F16 | **Codex per-model context budget + account ceiling clamp.** The superseded plugin had a configured window clamped by the server's `max_context_window`; the hub takes `discovered ?? configured ?? default` with no clamp. | ref-dsh-plugin-subscriptions `codex.ts:883-893` | S–M |
| F17 | **Cline per-model channel detail** (`lastProvider`, `lastMs`, `canonicalSlug`, `probedAt`) — `parseRouting` already computes `canonicalSlug` and nothing reads it. | ref-cline-pass `lib/panel.js:54-78` | S |
| F18 | **Catalog-sync guard test** that fails when a live catalog model is missing from the effort/vision tables — a visible decision point when upstream adds a model. | ref-commandcode-provider `tests/model-prices.test.ts` pattern | S |
| F19 | **Session-cost / plan panel with the durable cost projection.** | ref-commandcode-provider `client/panel.ts`, `cost-projection.ts` | M–L |

### Lower value

| # | Feature | Source | Effort |
| --- | --- | --- | --- |
| F20 | Per-account management (alias, pool opt-out, per-account model allowlist, `~account:` picker rows). | ref-dsh-plugin-subscriptions `account-preferences.ts` | M |
| F21 | Per-provider tool toggles + creation-time tool policy. | ref-dsh-plugin-subscriptions `provider-settings.ts:139-146` | M |
| F22 | Multi-provider usage dialog (all routes at once, default starred). | ref-dsh-plugin-subscriptions `SubscriptionUsageBadge.tsx:180-206` | S–M |
| F23 | Persisted Antigravity thought-signature replay (resume-safe). | ref-dsh-plugin-subscriptions `translate/antigravity.ts:301-319` | M |
| F24 | Antigravity per-family thinking budgets + `off`, and `parametersJsonSchema` with `$ref` resolution. | ref-dsh-plugin-subscriptions `antigravity-thinking.ts`, `antigravity-schema.ts` | M |
| F25 | Diagnosable failures: expose the tried-candidate list and a `creditsError` instead of a silent `{supported:false}`. | ref-trae-primary `auth.ts:369-403` | S |
| F26 | Trae queue/progress surfacing (the queue event is already decoded and then dropped). | ref-trae-primary `sse.ts:91,112` | S |
| F27 | In-band error classification (auth / hard-credit / soft-rate) so retry and rotation can react. | ref-trae-primary `upstream.ts:1-8` | S |
| F28 | Config migration from the superseded plugin (`antigravity` provider id, `provider-settings.json`, its `visibleModels`). | ref-dsh-plugin-subscriptions | M |

---

## Part 3 — Deliberately skipped, and open items

**Skipped, with reasons:**

- **Trae's 3-endpoint same-body fallback** (ref-trae-api `trae-client.js:198-243`).
  The primary reference rejects it with evidence of double-billing risk
  (`SOLO_ROUTE_DECISION.md:84-88`).
- **`request_id`/`session_id` in the Trae body** — unnecessary; both the primary
  and the hub omit them and live probes pass.
- **`MODEL_MAP` claude→glm shim** (ref-trae-api) — irrelevant to this route.
- **A `sharp` hard dependency** — transcribed as a resolution-through-the-host
  fix instead (X8) rather than adding a dependency the reference does not have.

**Open items, not yet fixed** (recorded so the next pass does not have to rediscover them):

- **T1 — Trae never refreshes a token.** `refreshTrae` is `async s => s` and
  `isTraePermanentRefreshError` is `() => false`, so the token manager saves the
  same expired session back and returns it as refreshed. The comment justifying
  it ("a desktop credential is re-read from disk on demand") is false — only a
  manual import re-reads `storage.json`. Symptom: hours after import, chat,
  credits and check-in all fail with upstream auth errors and never self-heal,
  while the card still says "signed in". Fix shape: F1.
- **G2 — `TRANSPORT` shares CommandCode's 500-attempt window.** Fix shape: F10.
- **C3/C4/C6-C14 — the remaining Cline findings** (in-band error classification,
  a stream ending without `[DONE]` treated as success, a non-JSON 200 validating
  as `ok`, a serving channel never recorded as `ok`, probe/validate using only
  `accounts[0]`, the upstream body never cancelled on early stop, unknown finish
  reasons mapping to a clean stop, envelope unwrapping, usage fidelity, and the
  Chinese quota scope labels in an English UI).
- **CommandCode findings not in this pass's fix set** — image gating, the vision
  heuristic being stale against the live catalog, the per-model default-effort
  override being ignored on that route, the CLI fingerprint headers on the
  Provider API surface, and tool-result/image fidelity.
- **Cross-cutting suspicions that need a live capture to settle**:
  `earliestReset` picking the earliest of several reported windows; a past
  `resetsAt` in `windowUrgency` outranking every fresh member forever; the
  auth store re-read on every poll with no cache; and `mergeReasoning` passing a
  provider-supplied `defaultEffort` through unvalidated on the live path.