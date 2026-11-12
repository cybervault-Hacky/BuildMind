# Phase 14 — Home Page Premium Experience

**Scope:** `index.html` and its presentation/behaviour only. No backend change, no
new page, no new dependency, no new CTA beyond the two approved ones.

**Commits:** `f7247d7` (the rebuild) and `321a9be` (two verification fixes).
**Branch:** `arena/19f125fa-buildmind` · **PR:** #2 · **CI:** 3/3 pass
(Frontend 6s, Backend 1m0s, Build 9s).

---

## 1. Home experience

The first screen now makes one argument in four parts, in reading order: what
this is, what it does, what you do next, and what it looks like.

| Part | Content |
| --- | --- |
| Category | `AI game development workspace`, a mono eyebrow with a live dot |
| Claim | `Turn your ideas` / `into games.` — the existing `#hero-title`, kept verbatim |
| Mechanism | One sentence: *Describe a game. BuildMind plans it, builds it, tests it and fixes what breaks — against the real tooling.* |
| Action | `Build a Game` → `build.html` (primary), `Connect Roblox` (secondary) |
| Qualifier | `Real builds · Roblox target · bring your own model` |

The claim is only that the product plans, builds, tests and fixes — the four
things the pipeline actually does — and the qualifier names the one integration
that exists. There is no pricing, no testimonial, no logo wall, no statistic, no
feature grid, no FAQ, and no invented capability.

**Below the fold** there are two blocks and nothing else:

- **`A build, end to end`** — `Idea → Plan → Build → Test → Validate` drawn as a
  track with one continuous hairline through it. These are the product's own
  stage names (`js/services/ai/stages.js`), presented as a description of how a
  run proceeds, never as a live readout. There is no interval, no fake progress
  and no per-step "active" simulation.
- **`Open your projects`** — the existing `.start-card` shortcut into the
  workspace, unchanged in behaviour.

The page is 1065px of document at 1440×900: roughly one screen of hero plus one
screen of context, which is the compact shape the brief asked for.

### The construction field

The hero visual is a hand-authored inline SVG (`viewBox 0 0 560 552`) of one
object at three heights:

1. **Idea** — five nodes and four dashed links, with a single drop line into the
   plan's top corner.
2. **Plan** — a 5×5 lattice tier lifted above the world, drawn smaller than the
   world and connected to it by four corner guides, so the tier reads as
   *intention* projected onto *mass*. Eleven cells carry the accent: the plan
   claims a footprint rather than scattering cells.
3. **World** — a 5×5 isometric slab with eight extruded blocks, each with a lit
   top face and two near-opaque side faces so nearer blocks genuinely occlude
   farther ones. One marker sits on the tallest block.

Geometry is orthographic and hand-computed (cell *(i,j)* at
`(280 + (i−j)·46, 392 + (i+j−4)·23)`), not generated at runtime. **The SVG is
complete in the markup**, which is the property everything else depends on: with
JavaScript disabled the hero is the finished composition (verified below), and in
reduced motion it is the same finished composition, still.

This replaces `#hero-world` and its 0→100 timer loop entirely — that loop read as
a loading bar, which the brief forbids. `startWorldPreview()` in `js/app.js` had
no remaining caller after the swap, so it was removed (88 lines) rather than left
as dead code; `mountWorld`/`updateWorld` stay, because `build.html` uses them.

---

## 2. Animation

One reveal and two ambient beats. Nothing else on the page moves, and no
paragraph is animated after its entrance.

### The reveal (runs once, ~1.3s, never loops)

Five ordered beats, all opacity + transform, no path morphing, no layout
animation, no `d` attribute animation:

| Beat | Element | Start | Duration |
| --- | --- | --- | --- |
| 1 | backdrop grid | 0ms | 700ms |
| 2 | plan tier settles down 10px | 70ms | 800ms |
| 3 | world settles up 10px | 150ms | 820ms |
| 4 | blocks rise from their base edge, 55ms stagger × 8 | 360ms | 620ms |
| 5 | idea graph: links 55ms stagger, nodes 55ms stagger | 200–300ms | ~480ms |
| 6 | corner guides draw, 55ms stagger × 4 | 280ms | 560ms |

The whole scene is **present from the first frame** and then settles — it is never
half-built in the sense of showing a skeleton. Verified by frame capture: at
420 ms the plan tier, four of eight blocks and the idea graph are already on
screen (`qa/out/t-420.png`). `js/home.js` adds `.is-assembling`, and swaps it for
`.is-settled` after 1600ms so the ambient beats start only once the reveal is
done.

### The ambient beats (loop, extremely quiet)

- `field-dash` — the four idea links' dashes crawl, 6s linear.
- `field-pulse` — the marker on the tallest block breathes outward, 3.8s.

Both run **only** while the field is on screen. `js/home.js` sets
`data-onscreen="false"` from the same IntersectionObserver that gates the pointer
effect, and CSS pauses them; verified `running → paused → running` across a scroll
(`data-onscreen` true → false → true). This was a real bug found in verification:
the pause rule was written *before* the shorthand that sets `animation`, so
`animation` reset `animation-play-state` and the pause never applied. Fixed by
ordering, then re-verified.

### Cursor response

Capped at **4px** of travel, applied only to the plan tier and the idea graph, on
`(hover: hover) and (pointer: fine)` only, with one rAF per pointer move that
writes a value and stops. It reads `--field-x/--field-y` and lets CSS ease it
(700ms). Measured: `--field-x: −1.55px` at a pointer 60px off-centre. On reduced
motion the offsets are neither written nor applied.

`Build a Game` hover/focus also brightens the plan tier's outline and the corner
guides via `:has()` — a stroke transition, no movement.

### Lifecycle cleanup

`js/home.js` owns exactly three things and tears all of them down:

- the reveal timer (`field.isConnected` re-checked before the swap);
- the pointer rAF + `pointermove`/`pointerleave` listeners + IntersectionObserver
  — all released on `pagehide`;
- the CTA veil listener.

The store subscription for the Roblox chip is bound to the page's lifetime, and
`buildmind` pages are separate documents, so there is no cross-page leak to
release.

---

## 3. Responsive

Designed at each width, not scaled. Verified with real Chromium screenshots
(`node qa/shots.cjs … index`) at **320, 360, 375, 390, 430, 768, 1024, 1280,
1440, 1600** — `PROBLEMS: []`, and `overflow: 0` at every width.

| Width | Layout |
| --- | --- |
| 1440+ | 2-col, measure grows, hero `min-height: min(72vh, 700px)` |
| 1280 | 2-col, field max 496px |
| 1024 | 2-col, field max 440px |
| 860 | single column: copy → field → qualifier; field max 440px centred |
| 768 | single column, concept strip keeps all five notes |
| 620 | field max 360px; concept notes drop, track stays five dots; HUD wraps |
| 430 | labels tighten |
| 380 | field max 320px, headline 26px, eyebrow tightened |
| 320 | HUD drops its third readout to stay on two lines |

Two collisions found and fixed during QA:

- **`.field` was already taken** by the form-field class in `main.css`. The hero
  visual inherited `display: grid` from it and overflowed its column by 61px on
  every phone width. Renamed the whole visual to `.planviz*`; the form class is
  untouched.
- **The HUD row** (`field … | stage … | grid …`) was a nowrap flex row that
  pushed 41px past the viewport at 320. It now wraps, tightens its tracking below
  420px, and hides the third readout below 620px.

At 375 the document is 1307px, well within a normal phone page; the hero itself
is ~849px, so the CTAs are inside the first viewport and the field begins
immediately below them.

---

## 4. Accessibility

- **One `<h1>`** (`#hero-title`), unchanged in wording and id, still the label for
  the hero `<section>` via `aria-labelledby`.
- **Landmarks**: `header` → `nav[aria-label="Primary"]` → `main#main` →
  `section` + `section` → `footer` → `nav[aria-label="Footer"]`.
- **The decorative SVG is not announced**: `role="img"` with a specific
  `aria-label` on the figure's SVG, and a `.sr-only` `<figcaption>` that narrates
  the scene in one sentence; every decorative sub-group carries `aria-hidden` or
  no text. The HUD is `aria-hidden="true"` — it is ornament, and none of its
  words are load-bearing.
- **Keyboard order** verified by tabbing at 1440 and 375:
  `Skip to content → BuildMind → Home → Build → Projects → Settings → Open
  workspace → Build a Game → Connect Roblox → View projects → Open your projects
  → footer`. Both CTAs report `outline: solid 2px` on focus at both widths.
- **Focus is not trapped** by the page-veil handler, and modified clicks
  (meta/ctrl/shift/alt) are left to the browser.
- **The concept strip is a real `<ol>`**, so the sequence is conveyed by structure
  and not only by the track graphic; `<h2>` is present but visually hidden.
- **Reduced motion** (`prefers-reduced-motion: reduce`, verified in Chromium with
  the emulation on): `document.getAnimations()` is **0**, the field is
  `is-settled` from the first frame, the reveal and both ambient beats are
  removed by name (not duration-zeroed, which would leave infinite loops
  flickering), the pointer offset is dropped, and the hero remains the finished
  composition — `qa/out/index-1440-reduced.png`. The stored
  `html[data-motion-mode="reduced"]` mirror and the `@media (hover:none),
  (pointer:coarse)` block both carry the new rules; during QA the coarse-pointer
  block was found to also strip the desktop beats (headless Chromium reports
  `hover: none`), so it is now scoped to `<=620px` where the hero really is one
  column.

---

## 5. Performance

Measured on the real page in Chromium, 1440×900:

| Metric | Value |
| --- | --- |
| DOM nodes | 322 |
| First contentful paint | 212 ms |
| DOMContentLoaded | 207 ms |
| Load complete | 210 ms |
| js/home.js | 10.5 KB |
| index.html | 29.0 KB (5 inline SVGs) |
| components.css | 58.0 KB (2,449 lines) |
| animations.css | 21.9 KB (917 lines, 29 keyframes) |
| responsive.css | 17.7 KB (1,062 lines) |

- No images, no video, no canvas, no WebGL, no animation library, no GSAP, no
  Three.js, no particle system. The entire visual is vector markup and CSS.
- No network request is added by this phase: the field is inline SVG, the font
  stack is unchanged, and no new script file is loaded (`home.js` was already in
  the page's script list).
- Steady state is **two** infinite, compositor-only animations (`stroke-dashoffset`
  and `transform`+`opacity` on one 11px circle), both paused off-screen.
- All animation is `opacity`/`transform`/`stroke` — there is no constant
  `box-shadow` animation, no layout-affecting animation, and no DOM particle
  system.

---

## 6. Backend integration

Home adds **one** new interaction and it uses the existing boundary unchanged.

`Connect Roblox` is an anchor (`href="settings.html#roblox"`), so it works with
JavaScript off and on a signed-out page. `js/home.js` intercepts the click only
when all of these are true: authenticated, `serviceMode === "remote"`, and
`connectionController.mode === "remote"`. In that case it calls
`connectionController.connect("roblox")` — the same controller Build and Settings
call — and paints the real result:

| Real state | What the chip says |
| --- | --- |
| signed out | `Connect Roblox`, links to `settings.html#roblox` |
| authenticated, not connected | `Connect Roblox`, click calls the controller |
| `connecting` | `Connecting…`, `aria-busy="true"` |
| connected | `Roblox connected`, dot takes the success colour |
| `authorizeUrl` returned | real OAuth hand-off, `window.location.assign` |
| `ROBLOX_NOT_CONFIGURED` (501) | stays on Home, toast `External integration required`, no state change |

Verified against the running API in all four states (`qa/hero.cjs`,
`hero3.cjs`, `hero5.cjs`, `edge.cjs`):

```
signed-out  {"auth":"unauthenticated","mode":"remote","chip":"Connect Roblox","connected":"false"}
outage      {"auth":"unauthenticated","mode":"remote","chip":"Connect Roblox","connected":"false"}
signed-in   {"auth":"authenticated","mode":"remote","chip":"Connect Roblox","connected":"false"}
after click {"chip":"Connect Roblox","toasts":["External integration required"]}
```

The last line is the important one: this server has **no Roblox integration
configured**, so the real answer is `unavailable` — and Home says exactly that
and stays put. Nothing is simulated. In `?mode=simulated` the chip is a plain
link to Settings and the controller is never called.

Two bugs were found and fixed here during verification:

- `controller.isRemote()` does not exist on the exported surface; the guard now
  reads `controller.mode`, which does. Before the fix the click threw.
- `preventDefault()` alone was not enough: the page-transition handler in
  `app.js` listens on `document` and navigated to `settings.html#roblox` anyway,
  hiding the real `unavailable` answer. The handler now also calls
  `stopPropagation()`, so the click is treated as a command and not a link.

---

## 7. Verification

### Automated suites

| Gate | Result |
| --- | --- |
| Backend unit/integration (`npm test`, PG16) | **137 passed, 0 failed**, 10 suites |
| Browser E2E (`scripts/e2e.sh`) | **42 passed, 0 failed** |
| UI E2E (`scripts/e2e.sh`) | **70 passed, 0 failed** |
| Backend typecheck | clean (`tsc`) |
| Backend audit | 0 vulnerabilities |
| CI (PR #2) | Frontend 6s · Backend 1m0s · Build 9s — **3/3 pass** |

Zero new failures. The E2E suites assert the Phase 12 contracts this phase could
have broken and did not: no horizontal overflow on `index.html` at 375/768/1280,
`data-auth-state` transitions, the mobile nav sheet's `aria-expanded` and Escape
close, and mid-session session expiry.

### Visual QA (real Chromium)

- `node qa/shots.cjs 320,360,375,390,430,768,1024,1280,1440,1600 index` →
  `PROBLEMS: []`; `overflow: 0` at all ten widths; console clean.
- Reviewed every screenshot: `index-320/375/430/768/1024/1280/1440.png`.
  The construction field was iterated four times against real renders before it
  was accepted — v1 scattered the plan's cells randomly, v2 let eight blocks hang
  outside the slab because the slab polygon was drawn through cell *centres*
  instead of the grid boundary, v3 made the block faces translucent enough to read
  as glass. Each was a rendered-image judgement, not a guess.
- Reduced motion captured (`index-1440-reduced.png`), and the animation count
  asserted to be 0.
- JavaScript disabled (`index-1440-nojs.png`): the field renders complete, 8
  blocks present, both CTAs keep correct hrefs.
- Pointer response verified with a fine pointer, at a real cursor position.
- Reveal frames captured at 200/420/700/1000/1600/2600 ms.
- Screenshots under `/home/user/qa/out/`.

### Code hygiene

| Rule | Result |
| --- | --- |
| `node --check` on every tracked `js/**/*.js` | clean |
| Six-digit hex outside `tokens.css` | **0** |
| Inline `<script>` / external/tracking scripts | none |
| CSP | unchanged (`style-src` already allows the inline `style` attributes the field uses for `--c/--b/--l/--n/--g/--m` indices; no `unsafe-eval`, no new directive) |
| Committed secrets / build artifacts | none |
| Auth-gate rules still last in `components.css` | yes (now §14 after renumbering) |

---

## 8. Git

```
321a9be  Phase 14: pause the field's ambient beats off-screen, and scope the
         kill switch to small screens
f7247d7  Phase 14: rebuild the Home hero around a BuildMind-native construction
         field
0249c52  Phase 13: rebuild the visual system on a five-layer stylesheet stack
```

Five files changed, +1,222 / −202 before the follow-up fix:

| File | Change |
| --- | --- |
| `index.html` | hero rebuilt; field SVG authored inline; concept strip; start row |
| `css/components.css` | §1–4 rewritten (hero/field/concept/start); sections renumbered to §5–14 |
| `css/animations.css` | 6 new keyframes; reveal + ambient choreography; 3 reduced-motion/coarse-pointer registrations |
| `css/responsive.css` | field sizing 1440→320; HUD wrap; concept strip adaptation |
| `js/home.js` | rewritten (289 lines): reveal, pointer, Roblox boundary, CTA veil |
| `js/app.js` | `startWorldPreview` removed (no remaining caller) |

Stylesheet totals after the phase: tokens 290 · main 1,767 · components 2,449 ·
animations 917 · responsive 1,062.

---

## 9. Limitations

- **The "assembling" moment is short.** The reveal is 1.3s and the field is
  legible from the first frame. That is deliberate — a longer or more staged
  entrance starts to read as a loading state, which the brief forbids — but it
  does mean the hero's first impression is closer to a *settle* than a *build*.
- **The Roblox path cannot be shown end-to-end on this deployment.** The server
  has no `ROBLOX_CLIENT_ID`, so the honest outcome here is the 501
  `External integration required` toast. The `authorizeUrl` hand-off branch is
  written and guarded but is not exercised by a real provider in QA. It is not
  claimed as verified.
- **`.start-card` is now used exactly once** on Home. It kept its original class
  and behaviour rather than becoming a one-off, so the shortcut is a smaller
  presence than the concept strip above it.
- **The field is fixed to its authored composition.** Block heights and the plan
  footprint do not reflect a user's actual project — they are one abstract,
  representative scene. Making it data-driven would be a much larger change and
  is out of scope for a hero visual.
- **The HUD is decorative.** `FIELD · IDEA → WORLD · STAGE · PLAN → WORLD ·
  GRID · 05 × 05` describes the drawing itself, not any application state;
  `aria-hidden` keeps it out of the accessibility tree for exactly that reason.
- **The stage names come from the AI pipeline but the strip is not live.** It
  names `Idea/Plan/Build/Test/Validate` because those are the real stages; it does
  not poll, tick, or highlight in real time. This is the conceptual treatment the
  brief asked for, and it should not be read as a status indicator.
- **Pointer response is 4px and inaudible.** On a trackpad it is nearly
  imperceptible by design; that is the intended ceiling, not a bug.
- **Phase 15 has not started.** This phase is verified and reported; the next
  phase begins from `321a9be`.
