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

## Pages

| Page | Purpose |
| --- | --- |
| `index.html` | First impression. Positioning, two entry actions, how a build runs, one shortcut to projects. |
| `build.html` | The workspace. Game idea, AI configuration, connections, build activity, progress. |
| `projects.html` | Your games. Preview, name, lifecycle status, description, last build, open / delete, filters and search. |
| `settings.html` | AI provider and model, Roblox and Studio connection state, appearance, general preferences. |

No other pages exist by design.

## Project structure

```
buildmind/
├── index.html
├── build.html
├── projects.html
├── settings.html
├── assets/
│   ├── icons/favicon.svg
│   ├── images/logo.svg
│   └── game-scenes/scene-lattice.svg
├── css/
│   ├── main.css          design tokens, layout, components
│   ├── animations.css    keyframes, entrance choreography, reduced motion
│   └── responsive.css    tablet and mobile composition
├── js/
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

No build step and no dependencies. Serve the folder over HTTP so relative
paths and the page-transition layer behave like production.

```bash
# Python
python3 -m http.server 8080

# or Node
npx serve .
```

Then open `http://localhost:8080`.

Opening `index.html` directly with `file://` mostly works too, but a local
server is recommended.

## Design system

Tokens live at the top of `css/main.css` and nothing outside them should be
invented locally.

- **Surfaces** `--bg` → `--surface-3`, borders from `--line` to `--line-strong`
- **Text** `--text`, `--text-soft`, `--text-muted`, `--text-faint`
  (all ≥ 4.5:1 on every surface)
- **Accent** one family (`--accent*`); mint, amber and rose are status only
- **Space** `--s-1` … `--s-12` on a 4px base
- **Radius** `--r-xs` … `--r-pill`
- **Motion** `--ease-out`, `--ease-in-out`, `--ease-soft`, `--dur-1` … `--dur-5`
- **Type** Inter with a system fallback stack, JetBrains Mono for numbers

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

## Frontend behaviour

- Shared header with active-page indicator and an animated, focus-trapped
  mobile sheet
- Cursor-following ambient light (desktop pointers only), generated
  world-construction visualizer, scroll reveals, page fade transitions
- Build workspace: prompt composer with examples and a counter, provider and
  model selectors, masked API-key field, connection rows, a current-stage card,
  a described seven-step timeline, a simulated activity log, progress with
  stage markers, and a stoppable simulated run with a result summary
- Projects: sample projects, status filters, CSS-generated previews, empty
  states
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

## Notes

- Fonts load from Google Fonts with a system-font fallback stack.
- All visuals are original SVG or CSS generated in this repository.
- No third-party JavaScript libraries are used.
