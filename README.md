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
| `projects.html` | Started games. Preview, name, status, last activity, open. |
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
│   │   ├── projects/localProjectService.js
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
projects    list + active filter                 persisted (local data)
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

The seven stages are defined once in `services/ai/stages.js` and drive the
service timing, the timeline, the progress markers and the runner.

### Service status

| Service | Mode | Notes |
| --- | --- | --- |
| `aiService` | **simulated** | Timed stages, no model, no request |
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
| `buildmind.projects.v1` | local project list |
| `buildmind.draft.v1` | the composer prompt draft |

Never persisted: API keys, tokens, passwords, session secrets. The adapter
refuses key names that look sensitive, and `settingsService.saveSettings()`
accepts only the four known preference keys.

### Simulation boundaries

- Builds, connections and the project created on completion are simulations.
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
  model selectors, masked API-key field, connection rows, activity timeline,
  progress with stage markers, and a stoppable simulated run
- Projects: sample projects, status filters, CSS-generated previews, empty
  states
- Settings: provider and model, motion preference, switches, local reset
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
aiService.subscribe(listener)                // stage / done / error / cancel

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

## Notes

- Fonts load from Google Fonts with a system-font fallback stack.
- All visuals are original SVG or CSS generated in this repository.
- No third-party JavaScript libraries are used.
