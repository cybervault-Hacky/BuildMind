# BuildMind

BuildMind is an AI game development workspace. You describe a game, and the
product plans it, builds it, tests it, fixes it and helps you get to something
playable. The first target platform is Roblox.

BuildMind has its own visual identity. It is not a Roblox client, a Roblox fan
site, and it uses no Roblox artwork.

## Scope

This is the frontend. There is no backend, no AI call, no Roblox integration
and no credential handling — but the integration boundaries for all of them
exist and are documented below.

- Premium dark UI, original BuildMind mark and a generated SVG/CSS visual system
- Four separate pages: Home, Build, Projects, Settings
- Responsive from 320px to 1920px, dark-only by design
- Motion honours `prefers-reduced-motion` and a stored motion preference
- Simulated states only: anything that looks like a connection or a build run
  is a frontend simulation, and the UI says so where it matters

## Project structure

```
buildmind/
├── index.html
├── build.html
├── projects.html
├── settings.html
├── 404.html               styled not-found page for static hosting
├── robots.txt             disallows indexing (nothing here to index)
├── DEPLOYMENT.md          host setup, security headers, post-deploy checklist
├── assets/
│   ├── icons/favicon.svg
│   ├── images/logo.svg
│   └── game-scenes/scene-lattice.svg
├── css/
│   ├── main.css          design tokens, layout, components
│   ├── animations.css    keyframes, entrance choreography, reduced motion
│   └── responsive.css    tablet and mobile composition
├── js/
│   ├── boot-class.js     adds the .js class before first paint (no inline script)
│   ├── app.js            shell + boot: ambient, header, reveals, helpers
│   ├── state.js          the single state store and the build state machine
│   ├── navigation.js     active page + sliding nav indicator
│   ├── home.js           hero visual and pipeline highlight
│   ├── build.js          renderer for the Build workspace
│   ├── projects.js       renderer for the project list and filters
│   ├── settings.js       renderer for settings and connections
│   ├── services/
│   │   ├── contracts.js          result envelope, error model, service factory
│   │   ├── storage.js            the only localStorage access + key audit
│   │   ├── ai/
│   │   │   ├── providers.js      single source of truth for providers/models
│   │   │   ├── stages.js         the seven build stages, defined once
│   │   │   └── mockAIService.js  simulated AI boundary
│   │   ├── connections/
│   │   │   ├── mockRobloxService.js
│   │   │   └── mockStudioService.js
│   │   ├── projects/
│   │   │   ├── projectModel.js        pure project helpers: lifecycle copy,
│   │   │   │                          relative times, descriptions, matching
│   │   │   └── localProjectService.js the project boundary
│   │   └── settings/localSettingsService.js
│   └── controllers/
│       ├── buildController.js       orchestration: validate → AI → state
│       ├── connectionController.js  one connection path for both pages
│       ├── projectController.js     the only writer of the project slice
│       └── settingsController.js    the only settings path
├── README.md
└── .gitignore
```

## Run locally

No build step, no dependencies, no package manager. There is no `npm install`
and no `package.json` — serve the folder over HTTP so relative paths, fonts and
the page-transition layer behave like production.

```bash
# Python 3 — no dependencies
python3 -m http.server 8080

# or Node.js
npx serve .
```

Then open <http://localhost:8080>. Serve over HTTP rather than opening a
`file://` URL; only the HTTP path is verified.

A fresh clone contains everything needed to run: 37 tracked files, all assets
committed. Nothing is generated, so there is nothing to build first.

**Deployment lives in [DEPLOYMENT.md](DEPLOYMENT.md)** — required security
headers, the 404 page, MIME types, caching, HTTPS and a post-deploy checklist.

## Pages

| Path | What it is |
| --- | --- |
| `index.html` | Home — the pitch, a live preview visualizer, the Idea → Build → Test → Play strip |
| `build.html` | The workspace — composer, provider/model, connection rows, a stoppable simulated run |
| `projects.html` | Local project records with search, status filters and six generated scenes |
| `settings.html` | Provider/model, session-only key, two simulated connections, motion, scoped reset |
| `404.html` | Served for an unknown path; reuses the shell so a mistyped URL still looks like BuildMind |

All five are static HTML. Deep links use a query string
(`build.html?project=<id>`), never a path segment, so no server rewrite rules
are needed.

## Design system

Tokens live at the top of `css/main.css` and nothing outside them should be
invented locally.

- **Surfaces** `--bg` → `--surface-3`, borders from `--line` to `--line-strong`
- **Text** `--text`, `--text-soft`, `--text-muted`, `--text-faint`
  (all ≥ 4.5:1 on every surface)
- **Accent** one family (`--accent*`); mint (`--mint`, `--mint-deep`), amber and
  rose are status only
- **Space** `--s-1` … `--s-12` on a 4px base
- **Radius** `--r-xs` … `--r-pill`
- **Motion** `--ease-out`, `--ease-in-out`, `--ease-soft`, `--dur-1` … `--dur-5`
- **Type** Inter with a system fallback stack, JetBrains Mono for numbers

### Typography

Both families are **self-hosted** as variable-weight WOFF2 in `assets/fonts/`
(latin subset, ~112 KB total, SIL OFL — licence beside the files). They are not
fetched from a third party: every page's CSP is `default-src 'self'`, which
blocked the old Google Fonts stylesheet, so the product used to render in a
system font and log a console error on every load. Because the files are
variable, every weight the design uses (400, 500, 540, 560, 600) is a real
instance rather than a browser-synthesised faux weight.

The fallback stack is unchanged, so a missing font file degrades to the system
sans-serif with no layout break.

### Visual system

- **One control language.** Every input, select, textarea and button shares a
  height, radius, border, focus treatment and disabled treatment. Fields and
  selects are 42px; small buttons are 34px on pointer devices and 44px at touch
  widths.
- **One focus language.** Every interactive element shows a visible ring —
  2px accent outline with an offset, or a 1px accent border plus a 4px halo on
  fields. Focus never relies on a subtle tint alone, and never changes layout.
- **One status language.** A dot plus text, never colour alone; the dot is
  `aria-hidden` and the text is the state.
- **One elevation language.** Panels use a 1px border plus a soft, low-contrast
  gradient; shadows are reserved for things that genuinely float (the sticky
  build bar, the mobile sheet, dialogs).
- **Project art.** Six abstract CSS scenes (`lattice`, `terrain`, `graph`,
  `plates`, `dots`, `arcs`) picked deterministically from the project name. They
  share one palette and one light source so a grid of cards reads as a family.
  Each is gradients on `::before`/`::after` plus one empty child span: no
  images, no canvas, no WebGL, nothing to decode.

### Responsive strategy

One column at ≤620px, two comfortable columns from 768px, and three only when
each card can hold its name, status, date and actions on one line (≥1280px). The
grid floor is `minmax(min(320px, 100%), 1fr)` at tablet sizes so cards never get
narrower than their content needs; at ≤700px the floor falls to
`minmax(min(280px, 100%), 1fr)` so a 320px viewport cannot overflow.

Breakpoints are declared in `css/responsive.css`, in one place, at 380, 620, 700,
860 and 1024px. Mobile is composed deliberately rather than shrunk: the header
nav collapses into a sheet, the workspace stacks composer → action → activity,
rows become full-width, and touch targets grow to 44px.

### Animation system

Motion is opacity, transform and clip-path only — never width, height, top or
margin. The `@keyframes` in `css/animations.css` are checked for that in
`p8_static`. Entrances are choreographed (a 14px rise over 520ms on
`--ease-out`), interactions are 120–320ms, and only three ambient loops exist —
two slow glows and the world visualiser, all decorative and all stopped under
reduced motion.

Reduced motion is honoured two ways and both are tested:

| Source | Effect |
| --- | --- |
| `prefers-reduced-motion: reduce` | every animation and transition collapses to ~0ms, all looping decoration stops, reveals show immediately |
| the stored preference (`html[data-motion-mode="reduced"]`) | the same, applied live by `settings.html` → `settingsController.setMotion` |

Functional state changes — a stage advancing, a status changing, a toast — stay
visible in both modes. `@media print` and `forced-colors: active` force every
revealed element visible, so no content can hide behind an animation that never
ran.

### Verified in a real browser

Phase 8 is the first phase with a rendering browser available (a vendored
headless Chromium, no network access needed). `p8_visual.js` drives it and
measures pixels: horizontal overflow at six widths on four pages, loaded font
faces, heading hierarchy, painted project art, equal-height cards, one primary
action per screen, control geometry, a focus ring on **every** control (84 of
them), WCAG AA contrast on every text run, 44px touch targets by real
hit-testing, the mobile sheet, both dialogs at three viewports, reduced motion,
compositor-friendly keyframes, and whether the sticky build bar ever covers a
control. It skips loudly if the browser is absent rather than claiming success.

## Architecture

Four layers, one direction. Nothing calls upward and nothing skips a layer.

```
UI             build.js · projects.js · settings.js · navigation.js
                ↓ user intent                    ↑ subscribe()
Controllers    buildController · connectionController
                projectController · settingsController
                ↓ service calls                  ↑ results
Services       aiService · robloxService · studioService
                projectService · settingsService
                ↓ (future)                       ↑ results
Future         OpenAI · Gemini · Anthropic · Roblox OAuth
                Studio bridge · remote projects · backend
```

`js/state.js` sits beside this flow as the single state owner: controllers apply
results to it, renderers subscribe to it. There is no second state system in the
service layer — services return data and never keep UI state.

### Result convention

Every service method returns a promise of the same envelope (from
`services/contracts.js`) and never throws across its boundary:

```js
{ ok: true,  data: … }
{ ok: false, error: { type, message } }
```

`type` is one of `validation | connection | configuration | operation |
cancelled | unknown`, each with short user-safe copy. Internal errors are
caught by `createService()` and reduced to `unknown`, so no stack trace or
internal message can reach the UI.

### Where to implement things

| Job | File |
| --- | --- |
| Application state, build machine | `js/state.js` |
| Provider and model list | `js/services/ai/providers.js` |
| Build stages and timings | `js/services/ai/stages.js` |
| Real AI calls | replace `js/services/ai/mockAIService.js` |
| Roblox account connection | replace `js/services/connections/mockRobloxService.js` |
| Roblox Studio bridge | replace `js/services/connections/mockStudioService.js` |
| Project persistence | replace `js/services/projects/localProjectService.js` |
| Settings persistence | replace `js/services/settings/localSettingsService.js` |
| Storage access, key audit | `js/services/storage.js` |

Adding an AI provider means editing `providers.js` and, later, its adapter.
Build UI, Settings UI, validation and the state machine need no changes.

### State model

```
settings    provider, model, autoFix, hints      persisted
motion      full | reduced                       persisted
connections roblox, studio: disconnected | connecting | connected
                                                 (flag persisted, state simulated)
build       status, stage, progress, prompt, provider, model,
            runId, startedAt, endedAt, error     in memory
projects    list, active filter, local search,
            active project id (Build's context)  persisted list;
                                                 filter/search/active are
                                                 in-memory view state
apiKeyPresent                                    in memory only
```

```js
BuildMind.getState()                          // immutable snapshot
BuildMind.subscribe((state, changed) => {})   // changed = slice names
```

### Build state machine

`ready → building → testing → fixing → validating → complete`

with `stopped` and `error` reachable from any running state, and `ready` /
`building` reachable again from `complete`, `stopped` and `error`. Every move is
checked against `TRANSITIONS`, so the UI cannot show two contradictory states.
Each run carries a `runId`; stopping or failing bumps it, so a late event from a
dead run is ignored by both the controller and the store.

A run also has a **phase**: `preparing` covers the short beat between the click
being accepted and the first stage arriving, so the UI can acknowledge the
action instead of jumping from idle to stage one. The machine treats
`preparing` as in-flight, which is what makes repeated clicks safe.

`fixing → testing` is a legal move: a fix can hand back for another test pass
before validation. Some runs loop and some do not, decided deterministically
from the prompt, so both paths exist without a random flip on every run.

The seven stages are defined once in `services/ai/stages.js` — label,
description, activity lines, status, progress target and duration — and drive
the service timing, the timeline, the progress markers and the runner.

### Build workflow

```
idea → configuration → build → preparing → stages → result → project
```

- **Activity log** — simulated lines such as "Planned core systems" or
  "Checked gameplay systems", released as the stage progresses. These describe
  internal planning steps only; nothing claims a compilation, upload or
  deployment.
- **Current stage** — title, description, index ("3 of 7") and status, so the
  active step never depends on colour.
- **Progress** — one authoritative, monotonic value owned by the store. It never
  moves backwards, so a repeat test pass cannot pull the bar back.
- **Result** — a compact summary (concept, build status, validation, created
  time) with exactly two next actions: open the project, or build again. It
  appears only after a completed run; stopping or failing never shows it and
  never creates a project.

### Projects — lifecycle, identity, and the round trip back to Build

A project is one record, owned by `projectService` and mirrored into
`state.projects`. The renderer never sorts, copies or edits it; it reads the
list, and every intent goes through `projectController`.

**Lifecycle.** A project uses the same nine states the frontend can actually
reach — no invented backend states and nothing that implies publishing,
deploying or uploading:

| State | Meaning |
| --- | --- |
| `draft` | Exists, has no finished idea yet |
| `ready` | Has a prompt, no completed build |
| `building` / `testing` / `fixing` / `validating` | A run is in flight |
| `complete` | The last run finished |
| `stopped` | The last run was stopped by the user |
| `error` | The last run failed |

Only `building`…`validating` can be set by a live run (the Build renderer
mirrors the machine's status onto the open project). Terminal states are
written by `projectController` when the run actually ends. **`lastBuildAt` is
only ever written by `recordBuild`**, so a stopped or failed run can never
claim a build — it appends `stopped` / `error` to the project's `history`
instead.

**Identity and duplicate protection.**

```
recordBuild({ prompt, runId, projectId })
  1. the same runId was already recorded  → return it untouched (duplicate)
  2. an explicit projectId wins            → rebuild of that project
  3. same derived name, unbuilt or same prompt → that project
  4. otherwise                             → a new project
```

Rule 1 is what makes a duplicated `done` event harmless. Rule 2 is what keeps
"Build again" updating one record instead of growing the list. Rule 3 lets a
build fulfil an unbuilt idea, while a *different* prompt under a colliding name
stays a separate project, so an unrelated run can never overwrite finished
work. Run ids are minted from the clock plus a page-lifetime counter, so a new
page load cannot reuse an id already stored against a project.

**Open and Build Again.** A card's action is a link to
`build.html?project=<id>` — the id, never the name. On arrival the Build
renderer asks `projectController.open(id)`, which sets the active project and
returns the record; the composer takes the project's prompt as editable text.
The provider and model stay whatever is configured *now*. No key is restored,
because no service can return one.

From there the primary action runs normally. On completion the controller
records the result against the active project, so the card keeps its identity
and its time moves to "Just now". "Open project" in the result panel links to
`projects.html?project=<id>`, which marks the card and scrolls it into view.

**Card hierarchy.** name → status → description (derived from the prompt) →
last build (relative: "Just now", "X minutes ago", "Yesterday", "X days ago")
→ Open / Delete. A project with no completed build says "Not built yet"; if its
last event was a stop or a failure, the line says so instead. No card shows a
player count, revenue, rating, download figure or any other metric, because
none of those exist.

**Filters and search.** The filter row is derived from the statuses present in
the list, so no filter can ever dead-end. Search is local, matches a project's
name and description only (never its prompt or any setting), is capped at 60
characters, and lives in memory. Neither mutates project data.

**Empty states.** Four distinct ones: no projects at all (with a Build a Game
action), no match in the active filter, no match in the active filter *and*
search, and no match in search alone. Each names its own reason and its own way
out.

**Deletion.** Kept, because a local list that can only grow is worse. It is
confirmed in a native `<dialog>` that names the project and states the
consequence in plain words, goes through
`projectController.remove → projectService.deleteProject → state.removeProject`,
persists, and never comes back after a reload. Focus moves into the dialog,
returns to the trigger on cancel, and lands on a neighbouring card action after
deletion. There is no trash, undo or recovery screen.

**Previews.** Six original CSS scenes (`lattice`, `terrain`, `graph`,
`plates`, `dots`, `arcs`) in six accent variants, chosen by a deterministic
hash of the name. No images, no Roblox assets, no WebGL.

**Project activity.** `history` keeps the last twelve real frontend events —
`created`, `complete`, `stopped`, `error` — each with a timestamp. Nothing in
it claims a compiled script, an uploaded asset, a file count, a deployment or a
publish.

### Settings — configuration, status and reset

Settings is the only place configuration is edited, and it holds no state of
its own. The page renders `state.settings`; every change leaves through
`settingsController`, is validated against the provider catalogue, is
persisted by `settingsService`, and comes back through the store.

**One derivation, two pages.** `settingsController.describeConfiguration()`
computes the status from live state every time it is called:

| Status | When | What it means |
| --- | --- | --- |
| `Not configured` | the provider is not in the catalogue | nothing can be chosen yet |
| `Incomplete` | there is no valid model for the provider, or the provider needs a key and none is present | one thing is missing |
| `Ready` | a valid provider, a valid model, and a key if the provider requires one | a build can start |

Nothing is stored to remember a status, so the Settings chip and the Build chip
cannot drift apart — both call the same function with the same state. The
status is text plus a dot, never colour alone, and the note under the chip
names what is missing and why.

**Provider → model cascade.** `settingsController.setProvider()` writes the
provider *and* that provider's default model in a single call. A model can only
be saved through `setModel()`, which rejects anything the catalogue does not
list for the current provider, and `localSettingsService.normalize()` repairs a
stored pair that no longer matches (unknown provider → `openai`, cross-provider
model → that provider's default). An invalid provider/model pair therefore
cannot be loaded, saved, or shown for a frame.

**The API key is session-only.** It is typed into a password field, kept in the
input element (and, for a running build, passed to the service in memory), and
never written anywhere: not to `localStorage`, not to `sessionStorage`, not to
the URL, not to state, not to a log, not to an error message. State holds one
boolean, `apiKeyPresent`, and it resets on reload. The copy says so —
"Used for this session. Not saved." — and the per-field line says the key is
*held*, never *verified*: there is no provider call in this app, so there is
nothing to verify it against. A blank or whitespace-only value is called out
locally (`aria-invalid` plus a message) and does not count as present.

**Connections are two simulations.** The Roblox account and Roblox Studio are
separate rows, separate flags, separate statuses. Both are `simulated` in the
service layer and both say so in the UI. While a transition is in flight the
button is disabled and `aria-busy`, so a second click cannot start a second
attempt (`connectionController` also refuses a duplicate with an `operation`
error). A ticket per target invalidates in-flight callbacks: if the target is
disconnected while connecting, the late callback returns `superseded` and does
not repaint the button or write a connection.

**Reset is scoped and confirmed.** The reset button opens a native `<dialog>`
that names exactly what changes. Confirming calls
`settingsController.reset()` → `settingsService.resetSettings()`, which writes
the three configuration keys only (`settings`, `preferences`, `connections`) and
returns the scope it applied:

| Restored | Kept |
| --- | --- |
| provider, model, auto-fix, hints | `buildmind.projects.v1` — every project and its history |
| motion, including `html[data-motion-mode]` | `buildmind.draft.v1` — the prompt draft |
| both simulated connections | the session's API key, because it was never stored |

The dialog moves focus to "Keep settings", Escape and the backdrop both dismiss,
focus returns to the button that opened it, and the result is announced through
the page's polite live region. Settings save as they change — there is no Save,
Cancel or Discard anywhere, and the page says so.

### Service status

| Service | Mode | Notes |
| --- | --- | --- |
| `aiService` | **simulated** | Timed stages, activity lines, no model, no request |
| `robloxService` | **simulated** | No OAuth, no account, no request |
| `studioService` | **simulated** | No bridge, no plugin, no request |
| `projectService` | **local** | localStorage, no backend |
| `settingsService` | **local** | localStorage, no backend |
| real providers / backend | **future** | Not implemented, not stubbed |

### Persisted data

Exactly five non-sensitive keys, all written through `services/storage.js`:

| Key | Contents |
| --- | --- |
| `buildmind.settings.v1` | provider, model, autoFix, hints |
| `buildmind.preferences.v1` | motion |
| `buildmind.connections.v1` | roblox / studio booleans |
| `buildmind.projects.v1` | project records: id, name, description, prompt, status, timestamps, last build, run id, art, history |
| `buildmind.draft.v1` | the composer prompt draft |

Never persisted: API keys, tokens, passwords, session secrets. The adapter
refuses key names that look sensitive, and `settingsService.saveSettings()`
accepts only the four known preference keys.

### Simulation boundaries

- Builds, connections and the project created on completion are simulations.
  A project is a local record of a simulated run — there is no playable game,
  no upload and no deployment behind any card.
- The API key is only ever checked for presence; the field is cleared when the
  run starts, the value is never stored, logged, sent or put in a URL.
- There is no `fetch`, `XMLHttpRequest`, WebSocket or SSE anywhere in the
  source, and each page declares `connect-src 'none'` in its CSP.
- No endpoints, no frameworks, no dependencies.

### Content Security Policy

All four pages ship the same policy as a `<meta http-equiv>` tag:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none';
object-src 'none'; base-uri 'self'; form-action 'none'
```

`script-src` carries no `unsafe-inline` and no `unsafe-eval`. The single inline
script this app used to need (adding the `.js` class before first paint) now
lives in `js/boot-class.js` so the exception could be dropped. `style-src` keeps
`'unsafe-inline'` deliberately: the renderers set a handful of computed values
via the `style` property (progress width, visualizer cell opacity, the nav
indicator offset), which the CSP treats as inline style. There are no inline
`<style>` blocks outside a `<noscript>` fallback, and no inline event-handler
attributes anywhere in the markup.

Verified behaviour in Chromium: an injected inline script does not execute, an
`onerror` attribute does not run, `eval` and `new Function` throw `EvalError`
from page code, and `fetch`, `XMLHttpRequest`, `WebSocket` and image beacons to
another origin are all refused before a request leaves the browser.

## Frontend behaviour

- Shared header with active-page indicator and an animated, focus-trapped
  mobile sheet
- Cursor-following ambient light (desktop pointers only), generated
  world-construction visualizer, scroll reveals, page fade transitions
- Build workspace: prompt composer with examples and a counter, provider and
  model selectors, masked API-key field, connection rows, a current-stage card,
  a described seven-step timeline, a simulated activity log, progress with
  stage markers, and a stoppable simulated run with a result summary
- Projects: sample projects, status filters, six CSS-generated abstract
  preview scenes, equal-height cards, empty states
- Settings: provider and model with a live configuration status, a session-only
  API key with a reveal control, two separate simulated connections, motion and
  preference switches, and a scoped, confirmed reset
- Stored in `localStorage`: settings, motion preference, the simulated
  connection flags and the local project list. The API key is never stored.

## Intentionally not implemented

- Backend, database, accounts, authentication
- Real AI providers or API-key handling
- Real Roblox OAuth or Studio bridge
- AI agent, code generation, testing, automatic fixing
- Server-side project storage or sync
- Pricing, subscriptions, credits, analytics, marketing pages

## Integration points

The UI is already written against the service interfaces, so a real integration
replaces one file and leaves the pages untouched. `js/services/README.md`
documents the layer's rules for whoever writes that file.

```js
// AI — replace the implementation, keep the surface
aiService.initialize()                       // → { ready, mode, providers }
aiService.getProviders()                     // → providers
aiService.getModels(providerId)              // → models
aiService.validateConfiguration({ … })       // → { valid, errors }
aiService.startBuild({ prompt, provider, model, hasKey })  // → { runId, … }
aiService.stopBuild(runId)                   // → { stopped }
aiService.subscribe(listener)                // see the event contract below
aiService.failBuild(runId)                   // simulated failure, for recovery
aiService.planForPrompt(prompt)              // which path a run will take

// Roblox and Studio — separate integrations, same shape
robloxService.connect() / .disconnect() / .getConnectionState() / .subscribe()
studioService.connect() / .disconnect() / .getConnectionState() / .subscribe()

// Projects — swap local for remote
projectService.listProjects() / .getProject(id) / .createProject(data)
projectService.updateProject(id, data) / .deleteProject(id)

// Settings — swap local for per-account
settingsService.loadSettings() / .saveSettings(patch) / .resetSettings()
```

Controllers are the only callers, so nothing else changes when an
implementation is swapped:

```js
buildController.start({ prompt, hasKey })    // validate → aiService → state
buildController.stop() / .retry() / .fail()
connectionController.toggle("roblox" | "studio")
projectController.load() / .create(data) / .update(id, patch) / .recordBuild(prompt)
settingsController.load() / .setProvider(id) / .setModel(id) / .setMotion(mode)
```

What a future implementation has to keep: the envelope convention, the
`disconnected | connecting | connected` status vocabulary, and the rule that
services never hold UI state and never throw.

### AI event contract

`aiService.subscribe()` listeners receive one schema. Every event carries the
`runId` it belongs to, and consumers must ignore anything that is not their
active run:

```js
{ type: "start",    runId, run }
{ type: "stage",    runId, stageIndex, stageId, stageLabel, status,
                    progress, description, activity[] }
{ type: "progress", runId, stageIndex, progress }
{ type: "activity", runId, stageIndex, message, at }
{ type: "done",     runId, run }
{ type: "error",    runId, error }
{ type: "cancel",   runId, run }
```

## Engineering hardening (Phase 9)

Phase 9 changed no features and no visual design. It audited the existing
frontend for reliability, security, performance and test quality, and fixed
what was actually wrong.

### Defects found and fixed

| Area | Defect | Fix |
| --- | --- | --- |
| Idle work | The home visualizer repainted 47 DOM mutations per 3s while nothing changed: `dataset.state` was rewritten every tick, and every cell got an unconditional `classList.toggle` + `style.opacity` write | Compare before writing (a memo of state/progress plus per-attribute guards). Measured **47 → 14** mutations per 3s |
| Lifecycle | The home preview loop ran forever: a bare `setTimeout` at the 100% turnaround leaked a second timer, and nothing paused it off-screen | One timer handle reused by `schedule()`, an idempotent `stop()`, `IntersectionObserver` pause, `isConnected` self-teardown, `pagehide` teardown. Off-screen now measures **0** mutations per 3s and resumes correctly on return |
| Idle work | The build page ran a permanent 200ms interval that only did work during a run, and rewrote the same four progress nodes on every tick | Timer starts only when a run is in flight and retires itself when it ends; every write is guarded. Progress writes per tick **4 → 0** when values are unchanged |
| Async | `paintResult` re-wrote the result card on every tick of the clock | Filled once per run, keyed on run + project |
| Parsimony | `home.js` never cleared its pipeline interval and wrote classes unconditionally | Interval owned and cleared on `pagehide`, pauses off-screen, compare-before-write |
| Duplicate listeners | Re-dispatching `DOMContentLoaded` (or any future re-init) doubled every listener — measured 36 → 69 on the build page | Each module boots once behind an idempotence guard; re-init now measures 36 → 36 |
| Validation | A non-string project `name` was stringified to the literal `"[object Object]"` and displayed on a card; an empty `{}` record became a phantom "Untitled game" | `safeText` accepts only strings and numbers; records with no id, name or prompt are dropped as corruption |
| Data integrity | Projects created by a completed build got a positional placeholder id (`recovered-4-0`) instead of a real generated id, so deep links were tied to array order | `recordBuild` now assigns a generated (or requested) id before normalising |
| Performance | The Projects render was O(n²): `indexOf` inside the retire loop plus a `join()` comparison per render | A `Set` for membership and a cached order key. 200-card full re-filter measures **2.6–13.6ms** of script |
| Robustness | `IntersectionObserver` was used unguarded, so an environment without it threw on load | Feature-detected; the preview degrades to its timer behaviour |
| CSS | Five tokens declared and never read, one superseded `.art-dots` rule fully overridden by a later one, two single-property rules that should have been part of their main rule, one dead selector in a shared hover rule | Removed after proving each was unreferenced. `--s-1` was **kept**: it anchors the 4px space scale the static suite asserts |
| Animation | `pulse-dot` and `pulse-ring` animated `box-shadow`, repainting on every frame | Rewritten to animate `transform`/`opacity` only |

### Security posture

- **API key**: never in `localStorage`, `sessionStorage`, IndexedDB, a URL, a
  `data-*` attribute, the DOM, the store, a cookie or the console. Verified by
  entering a marked key, running a build, revealing the field and scanning every
  sink. Only `apiKeyPresent: true` survives, in memory.
- **Hostile storage**: 17 malformed payloads (invalid JSON, `null`, primitives,
  wrong shapes, non-string names, 50 000-character values, duplicate ids,
  script tags) × 4 pages — no crash, no injection, no dialog, graceful
  normalisation.
- **Error envelopes** never leak internals: a service that throws or rejects
  returns `{ ok: false, error: { type: "unknown", message: "Something went
  wrong." } }`, and no stack text escapes. Zero unhandled rejections.
- **No network**: with every non-local origin blocked at the request layer, all
  four pages, both fonts, a full build, settings persistence and the project
  list still work. **Zero** external requests were attempted.

### Measured performance

Headless Chromium 1440×900, `--disable-gpu`, `Performance.getMetrics`.
These are main-thread numbers only.

| Measurement | Result |
| --- | --- |
| Idle DOM mutations / 3s (home) | 47 → **14** (bottom of the page 0) |
| Idle DOM mutations / 3s (build, projects, settings) | **0** |
| Build page mutations / 3s during a run | 202 → **121** |
| Mutations / 3s with the visualizer scrolled off-screen | **0** |
| `DOMContentLoaded` (index / build / projects / settings) | 175 / 145 / 83 / 103 ms |
| Full-page scroll style cost (worst page) | **12 ms** total |
| 3s of a running build, 7 pulsing dots (median of 5) | task **0.143 s**, style 0.029 s, layout 0.015 s |
| Full 200-card projects re-filter | **2.6–13.6 ms** script |
| Heap after GC across 8 build cycles and 12 navigations | **9.54 MB, unchanged** |
| DOM node count across 5 consecutive builds | 423, **unchanged** |
| Responsive matrix (7 widths × 4 pages) | zero horizontal overflow, zero console errors |

Not measured: composite/raster cost, real-hardware frame timing, Safari and
Firefox rendering, and time-to-interactive on a cold network cache (the app is
served from `localhost` with no network at all).

### Test quality

The regression matrix is 39 suites, all behaviour- or invariant-based. Two
assertions needed updating during Phase 9, and neither was weakened:

1. `reduced.js` called `BM.stopBuild()`, a Phase 3 state API that Phase 4
   replaced with `buildController.stop()`. The test now calls the current API
   and still asserts the invariant (stop settles the machine under reduced
   motion).
2. `p8_static.js` caught a real regression: removing the `--s-1` token broke
   the assertion that the space scale is one arithmetic family. The token was
   restored — the test was right and the cleanup was wrong.

A new suite, `p9_hardening.js` (28 assertions), covers the paths this phase
touched: storage disabled, empty list not re-seeded, name normalisation,
generated project ids, listener idempotence, the build clock's lifecycle, the
CSP posture, and the session-only API key.

## Production readiness (Phase 10)

Phase 10 asked one question: could another developer take a fresh clone of this
repository to a working, deployable frontend without hitting hidden breakage?
The answer is yes, and here is the evidence.

### Fresh clone → running app

Verified by cloning the repository into a clean directory and serving *that*
copy, not the working tree:

```bash
git clone <repo> /tmp/freshclone && cd /tmp/freshclone
python3 -m http.server 8099
```

| Check | Result |
| --- | --- |
| Files in a fresh clone | 37 tracked files, all assets present, nothing generated |
| Install step | none — no `package.json`, no dependencies, no lockfile |
| Build step | none — and none was invented to look production-shaped |
| Documented commands | `python3 -m http.server` works; this is the only command documented |
| Assets reference-checked | 31 HTML `src`/`href` references + every CSS `url()` → all 200 |
| All four pages + 404 via direct URL | 200, rendered, one `h1` each |
| Path independence | served from `/` and from `/site/`; zero requests escaping the root |
| Browser | clean Chromium profile (new user-data-dir, no storage, cache or cookies) |

### Release blockers found and fixed

| Blocker | Why it mattered | Fix |
| --- | --- | --- |
| The font licence named only JetBrains Mono | Inter is vendored and served, but carried no attribution — an OFL clause 2 violation for a shipped font | `assets/fonts/LICENSE.txt` now attributes both families, with the upstream copyright lines |
| No `404.html` | A static host served bare browser chrome for any mistyped URL, breaking the shell | Added a styled 404 that reuses the real header, footer and design tokens; verified at 320–1920px, AA contrast, one `h1`, keyboard reachable |
| No `robots.txt` | A demo with no backend was inviting crawlers | Added `Disallow: /` |
| No deployment documentation | The README said nothing about headers, MIME types, caching or the 404 contract | Added `DEPLOYMENT.md` with a post-deploy checklist |

A fifth defect was found in my own work during this phase: the first 404 draft
omitted the shared boot chain, so `app.js` threw `BM.getState is not a function`.
The full chain (minus page-specific behaviour) is now included, and the release
suite asserts no console errors on that page.

### Security headers

The CSP lives in a `<meta http-equiv>` tag on every page, and the markers are
real: `script-src 'self'` with no `unsafe-inline` or `unsafe-eval`,
`connect-src 'none'`, `object-src 'none'`, `base-uri 'self'`,
`form-action 'none'`.

**Headers cannot be shipped from this repository.** `DEPLOYMENT.md` documents
the recommended set — including `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`Permissions-Policy` — and states plainly that they require host configuration.
`style-src 'unsafe-inline'` is required and documented as required, because the
renderers set computed values through the `style` property.

### Browser compatibility

Honest scope, not a compatibility claim:

- **Tested:** Chromium 153 (headless, Linux, no GPU), 9 widths × 5 pages.
- **Structurally compatible, unverified:** current Chrome, Edge, Firefox and
  Safari. The feature surface is small and guarded — no CSS nesting, no
  `:has()`, no module scripts, no optional-chaining-free syntax, and both
  `dialog.showModal` and `inert` are feature-detected with fallbacks.
- **Not tested at all:** any browser other than the Chromium above, and any real
  mobile device.

### Repeat-use and memory

Four full cycles of Home → Build → stop → Projects → search → filter →
Settings → provider change → reset, measured after forced GC:

| Cycle | Listeners | DOM nodes | Heap |
| --- | --- | --- | --- |
| 1 | 33 | 226 | 9.54 MB |
| 2 | 33 | 226 | 9.54 MB |
| 3 | 33 | 226 | 9.54 MB |
| 4 | 33 | 226 | 9.54 MB |

Zero growth. An earlier Phase 9 probe appeared to show node-count drift; the
cause was live activity rows inside a running build, not a leak. Measured at the
same point each time — idle after a reset — the DOM returns to exactly 402 nodes
on build.html across four consecutive builds.

### Performance (no regression from Phase 9)

| Measurement | Phase 9 | Phase 10 |
| --- | --- | --- |
| Idle mutations / 3s, Home | 14 | **14** |
| Idle mutations / 3s, Build / Projects / Settings | 0 | **0** |
| `DOMContentLoaded` (index / build / projects / settings) | 175 / 145 / 83 / 103 ms | 182–200 / 155–192 / 94–106 / 104–120 ms (3 runs) |

The load figures are quoted as a range across three runs because that is what
they do: the same page on the same machine moves by up to ~40 ms run to run.
That is measurement noise on a localhost server, not a regression — idle
mutations and the fully-flat repeat-use numbers above are the meaningful
before/after evidence.

### Verdict

Release-ready as a **static, local-first, fully simulated frontend**. The five
pages load, render and stay usable offline; every asset is committed and
same-origin; the CSP is restrictive and real; API keys never leave the field;
storage recovers from hostile input; and repeat use is flat.

It is not, and does not claim to be, ready as a product with real AI, real
Roblox integration, accounts, a database or a backend — none of which exist.

## Known limitations

- **Everything is simulated.** No provider is contacted, no key is verified, no
  Roblox account is signed in, no Studio bridge exists.
- **Fonts are latin-subset only.** Latin-extended, Cyrillic and CJK text falls
  back to the system sans-serif. Adding a subset means adding a file and a
  `unicode-range` at the top of `css/main.css`.
- **The browser used for visual verification is headless Chromium** (153) on
  Linux with no GPU. It measures layout, colour, contrast and hit areas
  accurately, but it cannot tell you how the page feels to scroll, and it is not
  Safari or Firefox: `backdrop-filter`, `100dvh` and `dialog` centring are
  verified there, not everywhere. Where a browser does not support `dialog`,
  the modal falls back to the `open` attribute (focus handling then depends on
  the page code rather than the UA).
- **Compositor cost is measured only as DevTools-style main-thread metrics**,
  not as a frame-timing trace on real hardware with a GPU. The numbers in
  "Engineering hardening" below come from `Performance.getMetrics` in headless
  Chromium with `--disable-gpu`, which is honest about task/style/layout time
  but cannot report composite or raster cost.
- **Contrast is measured on rendered pairs**, not against every possible state
  combination (for example a hovered disabled button on the amber surface).

## Notes

- Inter and JetBrains Mono are vendored in `assets/fonts/` under the SIL OFL and
  served from this origin, with a system-font fallback stack. No request leaves
  the page — the CSP forbids it.
- All visuals are original SVG or CSS generated in this repository. No stock
  photography, no game artwork, no Roblox assets.
- No third-party JavaScript libraries are used, and there is no build step.
