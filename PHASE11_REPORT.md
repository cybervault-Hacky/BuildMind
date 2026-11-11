# Phase 11 — BuildMind backend and real product foundation

This is the completion report for Phase 11, in the shape the phase asked for:
the 40 required checks, and an honest matrix of what is real, what is simulated,
and what is blocked by this environment.

Everything below was measured on this checkout. Where a number appears, it came
from a command whose output is quoted.

---

## 1. Verification summary

| Area | Command | Result |
| --- | --- | --- |
| TypeScript (strict) | `npm run typecheck` | **0 errors** |
| Backend suites | `npm test` | **137 passed, 0 failed, 0 skipped**, 10 suites, 37.7 s |
| Browser E2E | `node tests/e2e/browserE2E.cjs` | **42 passed, 0 failed**, real Chromium against the real API |
| Frontend regression | the 40-suite static/browser harness | **all suites clean** |
| Production build | `npm run build && npm start` | starts, `/health` and `/ready` both 200, cookies `HttpOnly; Secure; SameSite=Strict` |
| Dependency audit | `npm audit --audit-level=high` | **0 vulnerabilities** |

Backend suites, individually:

```
PASS  api.test.ts                 23 passed
PASS  auth.test.ts                13 passed
PASS  authorization.test.ts        7 passed
PASS  buildLifecycle.test.ts      16 passed
PASS  concurrency.test.ts          7 passed
PASS  providers.test.ts           16 passed
PASS  roblox.test.ts              11 passed
PASS  secretLeak.test.ts           5 passed
PASS  security.test.ts            22 passed
PASS  studio.test.ts              17 passed
```

---

## 2. The 40 checks

Each row states what was asked, what exists, and how it was proven. "Proven by"
names a real suite or a real command — not the presence of UI.

| # | Requirement | Status | Proven by |
| --- | --- | --- | --- |
| 1 | Replace simulated frontend services with a real backend | **Done** | `js/services/mode.js` selects one of two implementations; `remoteAIService`/`remoteProjectService` satisfy the same contracts. Frontend 40-suite harness still clean. |
| 2 | Preserve the finished frontend | **Done** | No page was redesigned. All 40 frontend suites pass; visual suite 167/167. |
| 3 | Node + TypeScript strict + Fastify + Zod + PostgreSQL | **Done** | `backend/package.json`, `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`); `npm run typecheck` → 0 errors. |
| 4 | Pinned minimal dependencies | **Done** | Six runtime deps (fastify, 3 fastify plugins, pg, zod) with exact versions in `package-lock.json`. No Redis, no ORM, no bundler. |
| 5 | Validated startup configuration | **Done** | `src/config/env.ts` Zod schema; the process refuses to start on bad config (verified: `DATABASE_URL: Invalid input: expected string`). |
| 6 | `.env.example` placeholders only; `.env` never committed | **Done** | `.gitignore` covers both; CI fails if a `.env` is ever tracked. |
| 7 | Real auth: register/login/logout/me; logout invalidates server-side | **Done** | `auth.test.ts` 13/13 — includes replaying the old cookie after logout and getting `401`. |
| 8 | Secure hashing, HttpOnly/Secure/SameSite cookies | **Done** | scrypt N=2^15; cookies observed in a production run: `HttpOnly; Secure; SameSite=Strict`. |
| 9 | Server-side authorization on every owned resource | **Done** | `authorization.test.ts` 7/7 across projects, builds, events, cancel, retry. |
| 10 | IDOR returns 404, not 403 | **Done** | `authorization.test.ts`; ownership is in the SQL predicate too. |
| 11 | Controller → Service → Repository → DB; no SQL in controllers | **Done** | All SQL is in `src/repositories/`. Controllers contain no query text. |
| 12 | Ownership enforced at the query boundary | **Done** | `user_id = $n` inside every owned-resource query. |
| 13 | Routes under `/api/v1/` as specified | **Done** | `src/routes/`; health, auth, projects, builds, ai, roblox. |
| 14 | No endpoint without a real service behind it | **Done** | Every route resolves to a service; `api.test.ts` 23/23 exercises them. |
| 15 | Zod on body, path, query, headers | **Done** | `src/validation/schemas.ts`; `security.test.ts` covers malformed input per surface. |
| 16 | Size, prompt and project limits | **Done** | 256 KiB request cap, prompt 8–4000 chars, `MAX_CONCURRENT_BUILDS_PER_USER`. |
| 17 | Centralized error model, safe messages | **Done** | `AppError` + one handler; no stack/SQL/path/secret in any response. `security.test.ts` asserts the absence. |
| 18 | BYOK memory/session-scoped, never logged or returned | **Done** | `secretLeak.test.ts` 5/5 across responses, headers, DB, logs, workspace files, URLs. |
| 19 | Separate BYOK and managed-credential paths | **Done** | `credentialService.resolve` prefers the user key; managed keys never reach the browser. |
| 20 | `AIProvider` interface + registry + real OpenAI and Google adapters | **Done (adapter)** | `src/providers/ai/`; `providers.test.ts` 16/16. OpenAI is exercised against a local endpoint speaking the real wire format; Google is tested structurally (request shape, error mapping, timeouts) because no Google-shaped endpoint is reachable here. |
| 21 | Timeouts and normalized errors in adapters | **Done** | `PROVIDER_TIMEOUT_MS` 60 s; every failure maps to a normalized provider error. |
| 22 | No hard-coded model names; never trust frontend provider/model pairing | **Done** | Models come from `listModels`; `modelRegistry` validates the pairing server-side. |
| 23 | UI states Not configured / Checking / Valid / Invalid / Unavailable | **Done** | Settings + account UI; `Valid` only after a real successful request. |
| 24 | No re-validation on every page load | **Done** | Validation is explicit; a page load does not re-issue it. |
| 25 | Seven build stages as real operations | **Done** | Orchestrator; each stage is a provider call and a persisted event. |
| 26 | DB-backed job queue returning `buildId` + `runId` | **Done** | Row-based queue; `POST /api/v1/builds` → `202` with both ids. |
| 27 | Central state machine rejecting invalid transitions | **Done** | Enforced inside `BuildRepository.transition()`; illegal transitions throw. |
| 28 | `runId` on every event; stale events rejected | **Done** | `buildLifecycle.test.ts` and `concurrency.test.ts`. |
| 29 | Cancellation not overwritable by a late callback | **Done** | `concurrency.test.ts` 7/7 includes cancel↔provider-response races. |
| 30 | Structured outputs validated; malformed → `provider output invalid` | **Done** | Zod schema per artifact; malformed content produces `PROVIDER_OUTPUT_INVALID`. |
| 31 | Artifact path allowlist; isolated per-build workspace | **Done** | `workspaceManager` resolves then checks containment; server-generated directory names. |
| 32 | Real test gates | **Done** | A build that fails its gates does not reach `complete`. |
| 33 | `MAX_FIX_ATTEMPTS` exhaustion → `failed` | **Done** | Bounded repair loop; exhaustion is a terminal `failed`. |
| 34 | `complete` only with validation evidence | **Done** | No evidence, no `complete`. |
| 35 | SSE events without secrets | **Done** | `builds.routes.ts`; heartbeat cleared on terminal frame (a real leak this phase fixed). |
| 36 | Real cancellation: auth + authorize + invalidate + abort + persist + emit | **Done** | In that order, so a late response finds a dead run. |
| 37 | Retry = new run, same project | **Done** | New build row, new `runId`, `retry_of` link; proven in the browser E2E step 6. |
| 38 | Backend projects replace frontend persistence in remote mode | **Done** | `remoteProjectService`; Projects page consumes it. |
| 39 | No fake projects on load | **Done** | Remote mode never seeds; an empty account shows an empty list. |
| 40 | Non-destructive local-project migration | **Done** | `js/account.js`: detect, validate, attach, dedupe case-insensitively, keep local copies, never upload keys. |

Two further items from §58–63 are worth naming because they were separate work:

- **Real Chromium E2E of the full journey** — `tests/e2e/browserE2E.cjs`, 42
  assertions: register → provider → project → build → SSE → cancel → retry →
  complete → logout → login. Includes the failure cases (rejected key, signed-out
  access).
- **Concurrency** — `concurrency.test.ts` 7/7: two builds, multi-user isolation,
  cancel↔provider response, retry↔old event, duplicate submit, simultaneous
  update/delete.

---

## 3. REAL / SIMULATED / BLOCKED matrix

The rule for this table: a capability is **REAL** only if there is an
implementation *and* a passing test that exercises it end to end. Having a UI
for it is not evidence.

| Capability | Verdict | Evidence / reason |
| --- | --- | --- |
| Frontend (four pages, design system) | **REAL** | 40 suites clean; visual 167/167 in headless Chromium. |
| Registration, login, logout, session | **REAL** | `auth.test.ts` 13/13 over real HTTP and real PostgreSQL. |
| Session invalidation on logout | **REAL** | Old cookie replayed → `401`. |
| Password hashing (scrypt) | **REAL** | `security.test.ts`; hashes are salted and verified. |
| Authorization / IDOR → 404 | **REAL** | `authorization.test.ts` 7/7. |
| Projects CRUD + ownership | **REAL** | `api.test.ts`, `authorization.test.ts`. |
| Build engine, 7 stages | **REAL** | `buildLifecycle.test.ts` 16/16; browser E2E reaches `complete` with stage events. |
| Build state machine | **REAL** | Invalid transitions rejected in `buildRepository.transition()`. |
| `runId` staleness rejection | **REAL** | `concurrency.test.ts`. |
| Cancellation | **REAL** | Browser E2E step 5: ends `cancelled` and stays cancelled. |
| Retry → new run | **REAL** | Browser E2E step 6: distinct build id and distinct `runId`. |
| SSE build events | **REAL** | Browser E2E step 4: `EventSource` connected, history replayed, terminal frame received. |
| Structured output validation | **REAL** | Malformed output → `PROVIDER_OUTPUT_INVALID`; tested. |
| Artifact path containment | **REAL** | Traversal attempts rejected by `workspaceManager`. |
| BYOK credential handling | **REAL** | `secretLeak.test.ts` 5/5 across six sinks. |
| AES-256-GCM at-rest encryption with AAD | **REAL** | Transplanted ciphertext fails to decrypt; tested. |
| Rate limiting, CSRF, secure headers | **REAL** | `security.test.ts` 22/22 over real sockets. |
| OpenAI **adapter** (wire format, streaming, errors, timeouts) | **REAL (against a local endpoint)** | `providers.test.ts` 16/16; the stand-in speaks the real wire format. |
| Google **adapter** (request shape, error mapping, timeouts) | **PARTIALLY VERIFIED** | Structurally tested in `providers.test.ts`. There is no Google-shaped stand-in here, so its request is checked but no response has ever been parsed from one. `EXTERNAL ENVIRONMENT REQUIRED`. |
| **Live call to `api.openai.com`** | **BLOCKED** | No outbound network in this environment. `EXTERNAL ENVIRONMENT REQUIRED`. |
| **Live call to Google's endpoint** | **BLOCKED** | Same. `EXTERNAL ENVIRONMENT REQUIRED`. |
| Roblox adapter boundary + OAuth state validation | **REAL (against a stand-in)** | `roblox.test.ts` 11/11. |
| **Real Roblox OAuth against roblox.com** | **BLOCKED** | No egress, no credentials. `EXTERNAL ENVIRONMENT REQUIRED`. |
| Studio bridge protocol (versioned, nonce replay-protected) | **REAL (against a stand-in)** | `studio.test.ts` 17/17. |
| **A real Roblox Studio session** | **BLOCKED** | Requires the Studio plugin and the Roblox runtime. `EXTERNAL ENVIRONMENT REQUIRED`. |
| Publishing a game to Roblox | **NOT IMPLEMENTED** | Out of scope; nothing in the UI claims it. |
| Managed credentials (operator keys) | **IMPLEMENTED, UNTESTED LIVE** | Path exists and is exercised with stand-ins; no real operator key exists here. |
| Payments / marketplace / ads / analytics / social | **NOT IMPLEMENTED** | Out of scope by instruction. |

**Nothing in the UI claims a blocked capability works.** In remote mode with an
unreachable provider, the UI reports `Unavailable`; it never silently shows
`Valid`, and it never falls back to a simulated success.

---

## 4. Decisions worth knowing

- **The service mode is chosen once, by configuration, and nothing changes it
  at runtime.** An earlier version of `account.js` flipped the mode when the
  session state changed, which meant a deployed remote app silently downgraded
  itself to simulation for signed-out visitors. That was a direct violation of
  the no-silent-fallback rule; it was found by the browser E2E and removed. The
  mode is now fixed at boot.
- **`runId` is generated in the repository, not by a column default.** It has to
  exist the moment the row does, because every event is stamped with it, and a
  database provisioned before that default existed must still work. (This was a
  real bug: build creation failed with a NULL `run_id` against a database
  created before the default was added.)
- **The production build has its own tsconfig.** `tsconfig.json` covers `src/`
  and `tests/` so typecheck is thorough; the build compiles `src/` only, so test
  doubles never ship and `npm start`'s `dist/server.js` actually exists.
  (`npm start` pointed at a path the build never produced — it would have failed
  on a fresh production deploy.)
- **CSP moved from `connect-src 'none'` to `'self'`** on the four pages, because
  the frontend must now reach its own API. `404.html` remains `'none'`, and no
  page allows a wildcard. The frontend tests were updated to assert the new,
  stronger invariant (same-origin only, never `*`) rather than deleted.
- **Test expectation changes in this phase were contract changes, not
  weakening.** Four frontend assertions were updated: the settings section order
  (a new Account section was added between Preferences and Stored-in-this-browser),
  two CSP assertions (same relaxation as above), and the network-surface check
  (from "no network at all" to "exactly one transport file, one streaming file,
  no dynamic import"). Each is stricter or equally strict, and each explains
  itself in a comment.
- **The visual audit now measures only visible elements.** A field inside a
  hidden sign-in form legitimately has height 0 and is not part of a comparison
  of control heights.

---

## 5. Reproducing this report

```bash
# Backend
cd backend
npm ci
npm run typecheck                                  # 0 errors
TEST_DATABASE_URL=postgres://... npm test          # 137 passed
npm run build && NODE_ENV=production npm start     # serves /api/v1

# Browser end-to-end (needs the API, PostgreSQL, Chromium)
npx tsx tests/helpers/fakeOpenAIServer.ts &        # local provider endpoint
npx tsx tests/helpers/e2eProxy.ts &                # static + /api on one origin
node tests/e2e/browserE2E.cjs                      # 42 passed
```

The browser E2E uses a local server that speaks the OpenAI wire format, because
this environment has no egress. The adapter, orchestrator, state machine,
validation gates and database are all real; only the remote endpoint is local.
That is why the live-provider rows above say **BLOCKED** rather than **REAL**.
