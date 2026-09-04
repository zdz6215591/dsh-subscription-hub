/**
 * Hold the event loop open for the whole test run.
 *
 * Several code paths under test wait on timers that deliberately do NOT keep
 * the process alive: `AbortSignal.timeout()` (the platform unrefs it — model
 * discovery and pool usage timeouts), device-flow's poll `sleep()`, and the
 * stream idle watchdog. In the dsh host process that is the right call — a
 * pending login poll must not block shutdown — and other live handles keep
 * the loop spinning anyway.
 *
 * Under `node --test` there are no such handles. On Node ≤ 22 a test awaiting
 * one of those timers as the only pending work drains the loop, and the
 * runner cancels every test still queued in the process with "Promise
 * resolution is still pending but the event loop has already resolved"
 * (issue #55 — `device-flow.spec`, `models.spec`, `pool.spec` each trip it,
 * and through `index.ts` the cascade takes the rest of the suite with them).
 * Node 24's runner holds the loop itself, which is why the suite is green
 * there. A ref'd interval for the run's duration removes the dependency on
 * that runner detail.
 *
 * Imported by `index.ts` (so `pnpm test` is covered) and by the specs that
 * await such timers (so each also passes when run on its own).
 */
import { after } from 'node:test'

const keepAlive = setInterval(() => undefined, 60 * 60_000)
after(() => { clearInterval(keepAlive) })
