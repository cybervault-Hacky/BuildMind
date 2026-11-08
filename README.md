# BuildMind

BuildMind is an AI game development workspace. You describe a game, and the
product plans it, builds it, tests it, fixes it and helps you get to something
playable. The first target platform is Roblox.

BuildMind has its own visual identity. It is not a Roblox client, a Roblox fan
site, and it uses no Roblox artwork.

## Phase 1 scope

Phase 1 is the frontend foundation only.

- Premium dark UI, original BuildMind brand mark and visual system
- Four separate pages: Home, Build, Projects, Settings
- Animated, responsive layout for desktop, tablet and mobile
- Reduced-motion support, keyboard navigation and visible focus states
- No backend, no AI calls, no Roblox integration, no credentials

Anything that looks like a connection, a build or a progress run is a
simulated frontend state. The UI says so where it matters.

## Pages

| Page | Purpose |
| --- | --- |
| `index.html` | First impression. Positioning, two entry actions, how a build runs. |
| `build.html` | The workspace. Game idea, AI configuration, connections, build activity and progress. |
| `projects.html` | Created games. Name, status, last activity, open. |
| `settings.html` | AI provider and model, Roblox and Studio connection state, motion, general preferences. |

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

## Current frontend capabilities

- Shared header with active-page indicator and animated mobile sheet
- Cursor-following ambient light, generated world-construction visualizer,
  scroll reveals, page fade transitions, button micro-interactions
- Build workspace: prompt composer with examples, provider/model selectors,
  masked API-key field, connection rows, activity timeline, progress component
- Simulated build run: Understanding → Planning → Building → Testing →
  Fixing → Validating → Complete, with a stoppable run
- Projects: sample projects, status filters, generated abstract thumbnails
- Settings: provider/model, motion preference, switches, local reset
- Preferences persist in `localStorage` (settings and motion only)

## Intentionally not implemented

- Backend, database, accounts, authentication
- Real AI providers or API-key storage (fields are UI only; keys are never saved)
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
