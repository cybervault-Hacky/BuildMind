# BuildMind

BuildMind is an AI game development workspace. You describe a game, and the
product plans it, builds it, tests it, fixes it and helps you get to something
playable. The first target platform is Roblox.

BuildMind has its own visual identity. It is not a Roblox client, a Roblox fan
site, and it uses no Roblox artwork.

## Scope

This is the frontend. There is no backend, no AI call, no Roblox integration
and no credential handling.

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
│   ├── app.js            shell: ambient, header, reveals, transitions, helpers
│   ├── state.js          the single state store, build machine, simulations
│   ├── navigation.js     active page + sliding nav indicator
│   ├── home.js           hero visual and pipeline highlight
│   ├── build.js          renderer for the Build workspace
│   ├── projects.js       renderer for the project list and filters
│   └── settings.js       renderer for settings and connections
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

## State architecture

`js/state.js` owns everything the UI shows. Pages never keep their own copies:
they subscribe, then render.

```
settings   provider, model, autoFix, hints        (localStorage)
motion     full | reduced                         (localStorage)
connections roblox, studio: disconnected | connecting | connected  (localStorage)
build      status, stage, progress, prompt, runId, startedAt, endedAt, error
projects   list + active filter                   (localStorage, list only)
apiKeyPresent  in memory for the session, never persisted
```

```js
BuildMind.getState()                    // immutable snapshot
BuildMind.subscribe((state, changed) => {})   // changed = slice names
```

### Build state machine

`ready → building → testing → fixing → validating → complete`

with `stopped` and `error` reachable from any running state, and `ready` /
`building` reachable again from `complete`, `stopped` and `error`. Transitions
are checked against a table, so the UI cannot show two contradictory states.
A run is identified by `runId`, which is bumped on stop/fail so stale
`await` continuations cannot repaint a dead run.

`BUILD_STAGES` is defined once and drives the timeline, the progress stage
markers, the progress values and the runner.

### Simulation boundaries

- Builds, connections and the project created on completion are simulations.
- The API key is only ever checked for presence; the field is cleared when the
  run starts, the value is never stored, logged, sent or put in a URL.
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
- Stored in `localStorage`: settings, motion preference, and the simulated
  connection state. The API key is never stored.

## Intentionally not implemented

- Backend, database, accounts, authentication
- Real AI providers or API-key handling
- Real Roblox OAuth or Studio bridge
- AI agent, code generation, testing, automatic fixing
- Project persistence beyond the local sample data
- Pricing, subscriptions, credits, analytics, marketing pages

## Future integration points

`js/app.js` exposes a small API on `window.BuildMind`:

```js
BuildMind.connectRoblox()      // replace with OAuth hand-off
BuildMind.connectStudio()      // replace with Studio bridge discovery
BuildMind.loadSettings()       // replace with server-side settings
BuildMind.saveSettings(patch)
BuildMind.onStateChange(fn)    // subscribe to connection/build state
```

`js/state.js` exposes the seams that a real implementation will replace:

```js
BuildMind.startBuild(prompt)        // replace the runner with the agent call
BuildMind.stopBuild()
BuildMind.retryBuild()
BuildMind.validateBuildConfig({ prompt, apiKey })
BuildMind.connectRoblox()           // replace with OAuth hand-off
BuildMind.connectStudio()           // replace with Studio bridge discovery
BuildMind.loadProjects()            // replace with a real project read
BuildMind.addProjectFromBuild(prompt)
BuildMind.setProvider(id) / setModel(id) / setMotion(mode)
```

The renderers (`build.js`, `projects.js`, `settings.js`) only read state and
call these functions, so a real backend can be attached without touching the
UI markup.

## Notes

- Fonts load from Google Fonts with a system-font fallback stack.
- All visuals are original SVG or CSS generated in this repository.
- No third-party JavaScript libraries are used.
