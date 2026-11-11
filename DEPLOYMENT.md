# Deploying BuildMind

BuildMind has two deployable parts:

- **The frontend** — static files. It works completely on its own in
  `simulated` mode, and that is a legitimate deployment.
- **The API** — a Node process plus PostgreSQL. Required for accounts, stored
  projects, real builds and provider credentials.

You can deploy either one alone. The frontend never switches to the API on its
own; you have to say so (see §3). Nothing in this document describes
infrastructure that does not exist.

---

## 1. Prerequisites

| Need | Why |
| --- | --- |
| A static file host | Serves the four pages and their assets |
| An HTTPS endpoint | Required: secure cookies, and sessions will not persist without it |
| **Node 20+** | Runs the API (`backend/`) |
| **PostgreSQL 14+** | The only datastore; there is no Redis, no queue service |
| A reverse proxy | Terminates TLS and puts the API under the same origin as the pages |

The API has runtime dependencies, so `npm ci` **is** part of a backend deploy.
The frontend still has no build step, no bundler and no dependencies.

## 2. Run it locally

The frontend on its own:

```bash
python3 -m http.server 8080     # or: npx serve .
```

The whole product — see `README.md` for the annotated version:

```bash
cd backend
npm ci
cp .env.example .env            # fill in DATABASE_URL, SESSION_SECRET,
                                # ENCRYPTION_KEY, APP_ORIGIN
npm run migrate
npm run dev                     # API on :3000
```

Serve the frontend on the origin you set as `APP_ORIGIN`, then open
`/settings.html?mode=remote`.

## 3. Choosing a frontend mode

| Deployment | How to select it | Result |
| --- | --- | --- |
| Static only | do nothing | `simulated`; no network requests at all |
| Static + API | `?mode=remote`, or set `window.BM_CONFIG.mode = "remote"` | all services use the API |
| Static + API, permanent | serve both under one origin and set the mode in a tiny config script | `remote` on every page |

`connect-src` in the CSP must name the API origin for `remote` mode. Serving
both under one origin (the recommended layout, §4.2) means `connect-src 'self'`
is enough, and that is what ships. If the API genuinely lives on another origin,
replace `'self'` with that exact origin — **never** with `*` — and add it to the
backend's CORS allowlist. Wildcard CORS with credentials is rejected by the
backend and by every frontend test.

## 4. What to deploy the frontend

Deploy the repository as-is. The frontend set is:

```
index.html  build.html  projects.html  settings.html  404.html  robots.txt
css/  (main.css, animations.css, responsive.css)
js/   (app.js, boot-class.js, state.js, controllers/, services/, page scripts)
assets/  (fonts/, icons/, images/, game-scenes/)
```

Do **not** serve `backend/` from the static host. It contains source, tests and
`node_modules`; nothing in it is meant to be fetched by a browser.

Ignore `.git/` and `README.md`/`DEPLOYMENT.md` if your host has a size limit.

Everything is referenced with **relative** paths, so the app works from a domain
root (`https://example.com/`) and equally well from a subdirectory
(`https://example.com/buildmind/`). This is verified, not assumed. The API,
however, is expected at `/api/v1` on its own origin — set
`window.BM_CONFIG.apiBaseUrl` if you mount it elsewhere.

### 4.1 Recommended layout: one origin

```
https://example.com/            → static frontend
https://example.com/api/v1/*    → reverse proxy → 127.0.0.1:3000
```

This keeps `connect-src 'self'`, makes the session cookie a first-party cookie,
and means no CORS at all in the common case. An nginx sketch:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # required for SSE build events
    proxy_read_timeout 300s;      # a build stream outlives 60s
}
```

`proxy_buffering off` is not optional: the build event stream is Server-Sent
Events, and a buffering proxy delays every event until the connection closes.
Set `TRUST_PROXY=true` in the API environment when you run behind this, so it
reads `X-Forwarded-*` for the client address and the secure-cookie decision.

## 5. Static host configuration

### 5.1 The 404 page

`404.html` is a real, styled page that matches the app's design tokens. Most
static hosts pick it up automatically. If your host requires it, configure it
explicitly:

- **Netlify** — automatic (`/404.html` is the default).
- **GitHub Pages** — automatic for project and user sites.
- **Cloudflare Pages** — automatic.
- **S3 / CloudFront** — set the error document to `404.html`.
- **nginx** — `error_page 404 /404.html;`
- **Apache** — `ErrorDocument 404 /404.html`

If you serve from a subdirectory, point the error document at
`/subdir/404.html`.

**Why `404.html` is self-contained.** A static host serves the error document at
whatever depth the bad URL had — `/a/b/c` gets the same file. Any relative
`<link href="css/main.css">` inside it would resolve to
`/a/b/c/css/main.css` and fail, leaving an unstyled error page. So `404.html`
carries its styles inline and loads no CSS, no JS and no fonts: **there is
nothing left that can 404.** Its two links are corrected for the real depth by
one small inline script, allowed by an exact CSP `sha256-...` hash in that
page's own policy — not by `'unsafe-inline'`.

Verify it after deploying: request a deliberately deep path such as
`/a/b/c/does-not-exist`. You should get a styled page with a dark background and
a white "That page is not here" heading, and the buttons should lead to
`/index.html` and `/projects.html`, not to `/a/b/c/index.html`.

### 5.2 MIME types

These must be served with the correct content type or fonts and SVGs will not
render:

| Extension | Type |
| --- | --- |
| `.woff2` | `font/woff2` |
| `.svg` | `image/svg+xml` |
| `.css` | `text/css` |
| `.js` | `text/javascript` |

Every mainstream static host already does this. If you write your own config,
do not omit `.woff2` — a generic `application/octet-stream` is rejected by the
font loader.

## 6. Required security headers

**These cannot be set from HTML.** The `<meta http-equiv>` CSP in each page is a
fallback for environments where headers cannot be configured; it is a real
policy and it is tested, but headers are strictly better because they cover
responses a meta tag cannot (for example, frames).

Configure the following at the host:

```http
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```

Notes on each choice, so nobody "helpfully" loosens them:

- **`style-src 'unsafe-inline'` is required.** The renderers set computed values
  through the `style` property (progress width, visualizer cell opacity, nav
  indicator offset). CSP counts those as inline style. There is no inline
  `<style>` block outside a `<noscript>` fallback and no inline event handler.
- **`script-src` carries no `unsafe-inline` and no `unsafe-eval`.** The app's
  pages have no inline scripts at all. The single exception is `404.html`, whose
  own policy allows exactly one inline script by `sha256-` hash so it can correct
  its links at depth. A hash allow-lists one specific byte sequence, not inline
  script in general; if you edit that script you must recompute the hash, which
  is the intended safety property.
- **`connect-src 'none'`** is correct and intentional: the frontend makes no
  network calls at all. If a future phase adds a real backend, this directive
  must be widened to exactly that origin and nothing else.
- **`frame-ancestors 'none'`** can only be expressed as a header, not in a meta
  tag. It is why headers are preferred.
- `Permissions-Policy` is belt-and-braces: the app uses none of those features.

### 6.1 HSTS (only if you control the domain over HTTPS)

```http
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Only add this once every subdomain is HTTPS. It is not required for the app to
function.

## 7. Caching

Fingerprints are not generated, so use a conservative policy rather than
`immutable` on HTML:

| Asset | Suggested header |
| --- | --- |
| `*.html` | `Cache-Control: no-cache` (always revalidate) |
| `css/*`, `js/*` | `Cache-Control: public, max-age=3600` |
| `assets/*` (fonts, svg) | `Cache-Control: public, max-age=31536000` |

Long cache lifetimes on fonts and SVGs are safe because those filenames change
when the asset changes. HTML must revalidate, or a returning visitor can load an
old document against new CSS.

## 8. HTTPS and secure context

The app requires no privileged browser APIs, so it also runs on plain HTTP.
Deploy over HTTPS anyway: it is the default for every modern host, and it keeps
the door shut on mixed-content and downgrade problems as the app grows.

The frontend references **no external origin of any kind** — no CDN, no font
host, no analytics, no API. Every request is same-origin, so mixed content
cannot occur. This is verified: with all non-local origins blocked, all four
pages plus a full build still work and zero external requests are attempted.

## 9. Offline behaviour

After the assets are available, the app is fully usable without internet:
pages, fonts, navigation, the build simulation, projects, settings and storage.
There is no service worker, so a first visit needs the network; a normal browser
HTTP cache covers revisits.

If you later add a service worker, the CSP does not need to change (a worker is
same-origin) — but do not add one without testing the update path.

## 10. Deploying the API

### 10.1 Database

Create a database and a role that owns it. Nothing else is needed — no
extensions beyond `pgcrypto`, which the migration enables for `gen_random_uuid()`.

```sql
CREATE ROLE buildmind LOGIN PASSWORD '...';
CREATE DATABASE buildmind OWNER buildmind;
```

Apply the schema:

```bash
cd backend
DATABASE_URL=... npm run migrate
```

The runner applies `migrations/*.up.sql` in filename order, inside a
transaction, and records what it applied. It is idempotent: running it twice is
a no-op. `npm run migrate:down` reverses the last migration — the down file for
`001_init` exists and is tested, so a botched deploy is recoverable.

Nine tables: `users`, `sessions`, `projects`, `builds`, `build_events`,
`provider_credentials`, `roblox_accounts`, `studio_sessions`, and
`schema_migrations` for bookkeeping.

Back up with `pg_dump` on a schedule. Two things cannot be regenerated:

- `users` — accounts. Lose it and everyone re-registers.
- `provider_credentials` — encrypted with `ENCRYPTION_KEY`. **Back up the
  encryption key separately from the database.** A backup of the table without
  the key is a backup of noise; the key without the table is equally useless.

### 10.2 Environment

Everything is validated at startup by a Zod schema, and the process refuses to
start on a bad configuration rather than failing later in a request. See
`.env.example` for the full list. Production-specific requirements:

| Variable | Requirement in production |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | `https://`, checked at boot |
| `SESSION_SECRET` | 64+ characters |
| `ENCRYPTION_KEY` | exactly 32 bytes, base64 |
| `DATABASE_URL` | reachable, with credentials |
| `TRUST_PROXY` | `true` only behind a known proxy |
| `WORKSPACE_ROOT` | a path the service user can write |

Provider keys (`MANAGED_*`) are optional. Without them the API requires every
user to bring their own key, which is a supported configuration.

### 10.3 Running it

```bash
cd backend
npm ci
npm run build              # tsc -p tsconfig.build.json → dist/
NODE_ENV=production npm start
```

`npm start` runs `node dist/server.js`. The build config compiles `src/` only,
so tests and test doubles never reach the deployed artifact. (The default
`tsconfig.json` covers `src/` and `tests/` together, which is what
`npm run typecheck` should check.)

Run it under a supervisor (systemd, a container, your platform's process
manager) so it restarts on failure. It is stateless apart from PostgreSQL and
`WORKSPACE_ROOT`, so more than one instance is safe.

**Do not expose it directly to the internet.** TLS terminates at the proxy, and
the JSON logs are written to stdout for your log collector.

### 10.4 Health checks

| Endpoint | Meaning |
| --- | --- |
| `GET /api/v1/health` | the process is up and answering |
| `GET /api/v1/ready` | the process is up **and** the database answers |

Point your load balancer at `/ready`, and your restart policy at `/health`.

### 10.5 Migrations on deploy

Run `npm run migrate` **before** starting the new process, and keep it a
separate step rather than something the server does on boot. A failed migration
should stop the deploy, not produce a half-started service.

### 10.6 Background maintenance

The maintenance sweep runs inside the API process on an interval and cleans up:

- builds abandoned by a crash — an active build whose row has not been touched
  within the workspace retention window is marked `failed` with
  `BUILD_TIMEOUT`. It is not silently re-queued: a user can retry it, which
  creates a new run, and the dead run can never write to it again.
- expired sessions
- expired Studio nonces and sessions
- build workspaces past `WORKSPACE_RETENTION_MS`
- build events past `BUILD_EVENT_RETENTION_MS`

It **never** deletes a project or a user. Only provider credentials past their
TTL, expired sessions, revoked Studio sessions, old build events and old
workspace directories are removed. Retention windows are configurable; the
defaults are conservative.

### 10.7 What to monitor

- `request.failed` / `request.crashed` log lines, grouped by `code`
- `429` rate, per route
- build duration and the `failed` rate by `errorCode`
- `/ready` failures
- disk usage under `WORKSPACE_ROOT`

Every log line carries `requestId`, and build work adds `userId`, `buildId` and
`runId`. Correlate on those. Logs never contain a provider key, a session token
or a password — a test enforces this.

### 10.8 Rotating secrets

- **`SESSION_SECRET`** — rotating signs everyone out. That is acceptable; do it
  during a quiet window.
- **`ENCRYPTION_KEY`** — rotating requires re-encrypting stored provider
  credentials. There is no automatic migration for this. Until you write one,
  treat the key as permanent and store it in a secret manager.

## 11. Post-deploy verification

For a full deployment, walk this list in order. Each step is something you can
observe, not something you have to take on faith.

1. `GET /api/v1/health` returns `{"ok":true,"data":{"status":"ok"}}`.
2. `GET /api/v1/ready` returns `"database":"reachable"`.
3. `GET /api/v1/projects` without a cookie returns `401`, and the body contains
   no stack trace.
4. The pages load with the required headers (§6) and no console errors.
5. Register an account. A session cookie appears with `HttpOnly`, `Secure`,
   `SameSite`.
6. Reload: you are still signed in.
7. Sign out. `GET /api/v1/projects` returns `401` again, and the old cookie no
   longer works even if you replay it — the session row is gone.
8. In Settings, add a provider key. It reports `Checking` and then `Valid` only
   if a real request succeeded. Remove it from the network tab: the key must
   appear in exactly one request body and nowhere else.
9. Create a project and run a build. Events arrive live; the stage indicator
   moves; the build reaches `complete` with validation evidence.
10. Cancel a build mid-run. It ends `cancelled` and stays cancelled.
11. Retry a failed or cancelled build. It gets a new `runId`.
12. Sign out, sign in, open Projects. The projects and their builds are there.
13. `npm test` passes against a test database, and `npm run typecheck` is clean.

For a static-only deployment, steps 1–4 and 5–6 (without the API) are the
relevant subset; the app is in `simulated` mode and makes no requests.



Run these against the deployed URL, not localhost:

1. Open `/`, `/index.html`, `/build.html`, `/projects.html`, `/settings.html`
   directly. All five should render.
2. Open a path that does not exist; confirm you get the styled BuildMind 404,
   not the host's default page. Then open a **deep** path such as
   `/a/b/c/nope` — it must still be styled, and its buttons must point at
   `/index.html` / `/projects.html` rather than into `/a/b/c/`.
3. Open a deep link: `build.html?project=<a-real-id>`. The project context bar
   should appear. Try `?project=nope`; the UI should stay neutral, not error.
4. DevTools → Network: reload with "Disable cache". Every request must be
   same-origin. There must be zero requests to any third party.
5. DevTools → Console: reload all four pages. There must be zero errors, zero
   warnings and zero CSP violations.
6. DevTools → Application → Local Storage: only `buildmind.*.v1` keys.
7. Type a fake API key in Build, start a run, then search Application storage,
   the URL and the console for it. It must appear nowhere.
8. Turn the network off and repeat step 5. Everything must still work.

## 12. Known limitations that affect deployment

- **No server-side rendering or routing.** Four HTML files and a 404 page. Deep
  links use a query string, not path segments; there is nothing to rewrite.
- **Without the API, data is per-browser.** In `simulated` mode projects and
  settings live in that browser's `localStorage`, and clearing site data removes
  them. Deploy the API if that matters.
- **The API's live provider and Roblox integrations are unverified against the
  real services.** They are implemented and tested against local endpoints that
  speak the real wire formats, but this repository has no evidence of a
  successful call to OpenAI, Google or Roblox. Verify in your own environment
  before marketing either as working. `EXTERNAL ENVIRONMENT REQUIRED`.
- **No publishing.** A successful build produces validated artifacts; nothing
  is uploaded to Roblox and no game becomes playable.
- **The CSP meta tag is a fallback.** Without host headers you lose
  `frame-ancestors` and `X-Content-Type-Options`. The API sets its own security
  headers itself.
