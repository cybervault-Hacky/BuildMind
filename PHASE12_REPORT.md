# Phase 12 — Frontend ↔ Backend Real Product Integration Report

This report documents the Phase 12 integration of the static BuildMind frontend
with the real Fastify + PostgreSQL backend (`/api/v1`), verified end-to-end in
headless Chromium 153 against a live PostgreSQL 18 instance and local
OpenAI-compatible wire-format stand-in.

---

## 1. Executive Summary

Phase 12 replaces simulation-default frontend behavior with authoritative
backend-backed authentication, owner-scoped project persistence, real
seven-stage build orchestration over Server-Sent Events (SSE), real provider
credential validation, and honest external integration boundaries — while
preserving the strict CSP (`default-src 'self'; script-src 'self'; connect-src 'self'`),
visual system, accessibility, and responsive layout across all four pages.

`remote` is now the default service mode. No remote failure (401, 403, 404, 409,
5xx, network timeout, SSE drop, or provider error) ever silently falls back to
simulated state or fabricated completion.

---

## 2. Architecture & Layer Ownership

```
Pages / Renderers (index.html, build.html, projects.html, settings.html + js/*.js)
        ↓ user intent only (never calls fetch/EventSource/localStorage)
Controllers (authController, buildController, projectController,
             settingsController, connectionController)
        ↓ contracts.js envelopes ({ ok: true, data } | { ok: false, error })
Service Mode Selector (js/services/mode.js — remote by default; explicit simulated opt-in)
        ↓
Remote Services (authService, remoteProjectService, remoteAIService,
                 remoteRobloxService, remoteStudioService)
        ↓
Transport Layer (js/services/api/apiClient.js + sseClient.js + errors.js)
        ↓ same-origin /api/v1 (HttpOnly cookie + in-memory X-CSRF-Token)
Fastify API + PostgreSQL (`backend/`)
```

---

## 3. Transport, Error Normalization & SSE Lifecycle

- **`js/services/api/errors.js`**: Maps known backend error codes and HTTP
  statuses into the frontend's safe error taxonomy (`validation`, `connection`,
  `configuration`, `operation`, `cancelled`, `unknown`). Strips file paths, stack
  frames, SQL fragments, and URLs; replaces all `5xx` server text with safe
  user-facing copy.
- **`js/services/api/apiClient.js`**: Sole HTTP boundary (`credentials: 'include'`,
  automatic `x-csrf-token` on mutating methods, bounded 20s timeout + external
  `AbortSignal`, `x-request-id` correlation, named request lifecycle tracking,
  and central `401 UNAUTHENTICATED` session-expiry notification).
- **`js/services/api/sseClient.js`**: Managed single-stream `EventSource`
  registry keyed by logical stream ID (`build:<buildId>:<runId>`). Replaces stale
  streams deterministically, enforces idle timeout detection, advances `?after=<seq>`
  across reconnects, and closes all active streams on terminal frames and `pagehide`.

---

## 4. Authentication & Session-Gated UX

- **`js/services/auth/authService.js` & `js/controllers/authController.js`**:
  Bootstraps session state once per page via `GET /api/v1/auth/me` before
  protected resources load, publishing `data-auth-state="loading | authenticated | unauthenticated | error"`
  on `<html>`.
- **Zero-flash CSS gating (`css/main.css` + `js/boot-class.js`)**:
  `[data-auth-only]` regions stay hidden during `loading` and `unauthenticated`/`error`;
  `[data-auth-gate]` distinguishes signed-out visitors ("Sign in to build" /
  "Sign in to see your projects") from backend outages ("The service is unavailable").
- **Session hygiene**: Passwords are cleared from the DOM on submit; `bm_session`
  remains `HttpOnly`; logout and mid-session `401` expiry scrub in-memory
  projects, active build state, SSE streams, and credential hints immediately.

---

## 5. Projects Integration & Local Migration

- **`js/services/projects/remoteProjectService.js` & `js/controllers/projectController.js`**:
  Translates PostgreSQL project records (`GET/POST /api/v1/projects`,
  `GET/PATCH/DELETE /api/v1/projects/:id`) into the frontend card model with
  deterministic scene art and zero sample/mock seeding.
- **`js/projects.js`**: Renders explicit loading (`#projects-loading`), retryable
  error (`#projects-error`), empty (`#projects-empty`), filter, search,
  deep-link highlight (`?project=<id>`), reopen-in-Build (`build.html?project=<id>`),
  and native `<dialog>` delete confirmation flows.
- **Non-destructive migration (`js/account.js`)**: Detects local projects in
  `buildmind.projects.v1`, copies new projects on explicit user click, skips
  case-insensitive name duplicates, preserves local copies, and never uploads keys.

---

## 6. Build Engine, Live SSE, Cancellation & Retry

- **`js/services/ai/remoteAIService.js` & `js/controllers/buildController.js`**:
  - Ensures an owner-scoped project exists before `POST /api/v1/builds`.
  - Binds SSE stream events to `runId`, rejecting stale or out-of-order frames
    (`frame.seq <= record.seen`).
  - Maps all seven backend stages (`understanding`, `planning`, `building`,
    `testing`, `fixing`, `validating`, `complete`) onto the Build timeline,
    live stage banner, progress bar, world visualizer, and activity feed.
  - **Server-confirmed cancellation**: Clicking `Stop build` disables the button
    as `Stopping…`, calls `POST /api/v1/builds/:id/cancel`, and settles only
    after the backend records the terminal state.
  - **True server retry**: Clicking `Try again` (after failure) or `Build again`
    (after stop) calls `POST /api/v1/builds/:id/retry`, creating a new build row
    and new `runId` (`retry_of`) while closing any prior stream.
- **Database concurrency hardening (`backend/migrations/002_active_build_unique.sql` + `BuildService`)**:
  Added partial unique index `builds_one_active_per_project_idx` and per-user
  serialization in `BuildService.create`, eliminating check-then-insert races
  under simultaneous build submissions.

---

## 7. Provider Catalogue, Validation & Secret Hygiene

- **`js/services/ai/providers.js` & `js/controllers/settingsController.js`**:
  Replaces the provider/model dropdowns from `GET /api/v1/ai/providers`,
  cascading models on provider change and resetting validation state.
- **Explicit backend verification**: Only `POST /api/v1/ai/validate` moves
  `#settings-provider-status` to `Valid`, reporting `not_configured | checking | valid | invalid | unavailable`
  honestly without validating on page load.
- **Secret handling**: Submitted API keys travel only in JSON POST bodies, are
  immediately cleared from `<input type="password">` elements in both Build and
  Settings, and never appear in `localStorage`, `sessionStorage`, `BM.getState()`,
  DOM attributes, logs, or request URLs.

---

## 8. External Connection Boundaries (Roblox & Studio)

- **`js/services/connections/remoteRobloxService.js`**: Reads real status from
  `GET /api/v1/roblox/status`, initiates real OAuth handoff (`POST /api/v1/roblox/connect`)
  when configured, completes callbacks via `POST /api/v1/roblox/callback`, and
  reports `unavailable` ("External integration required") when unconfigured.
- **`js/services/connections/remoteStudioService.js`**: Reads real plugin session
  state from `GET /api/v1/studio/status` and refuses fake browser-side Studio
  connections honestly (`unavailable`).

---

## 9. Verification Results

| Check | Command | Result |
| --- | --- | --- |
| Frontend + E2E JS syntax | `node --check` across all JS/CJS files | **0 errors** |
| Backend strict TypeScript | `cd backend && npm run typecheck` | **0 errors** |
| DB migrations (up / idempotent / down / up) | `npm run migrate && npm run migrate && npm run migrate:down && npm run migrate` | **Pass** (`001_init.sql`, `002_active_build_unique.sql`) |
| Backend integration suites | `cd backend && npm test` | **10 suites, 137 passed, 0 failed, 0 skipped** |
| Production build & entry check | `cd backend && npm run build && node --check dist/server.js` | **Pass** (`dist/tests` absent) |
| Dependency security audit | `cd backend && npm audit --audit-level=high` | **0 vulnerabilities** |
| Real Chromium E2E — API & Journey (`browserE2E.cjs`) | `./scripts/e2e.sh` | **42 passed, 0 failed** |
| Real Chromium E2E — Phase 12 UI (`phase12FrontendE2E.cjs`) | `./scripts/e2e.sh` | **70 passed, 0 failed** |
| Process-group & port cleanup | `scripts/e2e.sh` (`setsid` PGID teardown) | **Ports 3100 & 8180 free, 0 orphan processes** |
