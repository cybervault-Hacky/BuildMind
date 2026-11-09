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
│   ├── app.js            shared state, brand/visual system, helpers
│   ├── navigation.js     active page + sliding nav indicator
│   ├── home.js           hero visual and pipeline highlight
│   ├── build.js          composer, connections, simulated build pipeline
│   ├── projects.js       project list, filters, generated previews
│   └── settings.js       provider/model, connections, preferences
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

`js/build.js` exposes the build seams:

```js
BuildMind.startBuild(prompt, config)   // replace with the agent call
BuildMind.updateBuildStatus(text)
BuildMind.updateBuildProgress(percent, label)
```

`js/projects.js` exposes `BuildMind.loadProjects()` for real project reads.

## Notes

- Fonts load from Google Fonts with a system-font fallback stack.
- All visuals are original SVG or CSS generated in this repository.
- No third-party JavaScript libraries are used.
