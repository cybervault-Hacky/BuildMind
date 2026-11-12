# Phase 13 — Visual System Rebuild Report

This report documents the Phase 13 redesign of the BuildMind frontend: a
five-layer stylesheet architecture, a single token source of truth, a rebuilt
component language across all four pages and the 404 page, and a verified
pass over every layout the product actually has — signed-out, signed-in,
loading, empty, error, running, dialog, sheet and toast — at nine viewport
widths.

No product behaviour was changed. Every ID, class hook, state name and
service boundary the Phase 11/12 JavaScript depends on still exists; the work
is CSS, markup structure, and the shell helpers that the new choreography
needed.

---

## 1. Executive Summary

Before this phase the frontend had three stylesheets (`main.css`,
`animations.css`, `responsive.css`) and one file that did everything: tokens,
reset, layout, header, buttons, fields, panels, pages. The result was 1,300+
lines of `main.css` where a page-composition rule and a global primitive sat
next to each other, values that were invented locally instead of read from a
token, and several real defects that only showed up when the pages were driven
in a browser with a live API behind them.

Phase 13 rebuilds that into five files with one job each, puts every design
value in one file, and rebuilds the components on top of it:

| Before | After |
| --- | --- |
| 3 stylesheets, tokens buried at the top of `main.css` | 5 stylesheets, `tokens.css` is the only place a value exists |
| 12 raw hex literals outside the token block | **0** — every colour resolves through a token |
| auth gate and workspace could both be visible | document-state rules are last and exclusive |
| `.empty` was a grey box | one structural empty-state component shared by every dead end |
| settings rows collapsed their controls | stacked rows own their full measure |
| duplicate primary CTA on Projects | the header carries the action; the page head does not repeat it |
| transient toast, no tone distinction | toast with `success`/`error`/`info` tones, icon + text |
| nav indicator measured in JS with inline styles | `aria-current`, no measurement, no inline style |

Two things were true at the start and are still true: the frontend has no build
step, and no third-party JavaScript or CSS is used. The redesign is hand-written
CSS.

---

## 2. Layer Architecture & Token Ownership

Load order is identical on all five pages:

```html
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/main.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/animations.css">
<link rel="stylesheet" href="css/responsive.css">
```

| Layer | File | Owns | Lines |
| --- | --- | --- | --- |
| 1. Tokens | `css/tokens.css` | colour, type scale, spacing, radius, borders, elevation, motion, layout metrics, z-layers | 290 |
| 2. Core | `css/main.css` | `@font-face`, reset, base typography, page furniture, header + nav + mobile sheet, buttons, fields, status language, panels | 1,767 |
| 3. Components | `css/components.css` | hero, pipeline, workspace, composer, prompt, timeline, progress, activity log, result, projects grid + scenes, settings, dialogs, toast, auth gates | 2,153 |
| 4. Motion | `css/animations.css` | keyframes, entrance utilities, page transitions, reveal choreography, the reduced-motion contract | 641 |
| 5. Adaptation | `css/responsive.css` | every breakpoint 1440+ → 380, landscape, print | 1,005 |

**One rule, one home.** A token is only ever *declared* in `tokens.css`. A page
is only ever *composed* in `components.css`. A viewport breakpoint only ever
*appears* in `responsive.css` — all 12 of them. The remaining media queries are
preference queries and live with the layer they belong to: two
`(pointer: coarse)` blocks beside the control primitives, and the
`prefers-reduced-motion` / `forced-colors` blocks in `animations.css`.

**One palette.** `tokens.css` declares 188 custom properties, of which 37 are
colour literals covering the complete palette (23 unique colours). The other
four stylesheets contain **zero** six-digit hex literals — verified with
`grep -oE '#[0-9a-fA-F]{6}'`. Earlier phases left twelve behind (button ramps,
scrollbar thumb, the danger hover text, the success gradient start); each one is
now a named token:

```css
--bm-accent-rest-top: #7f9bff;    --bm-accent-rest-bottom:  #5b78f0;
--bm-accent-ramp-top: #93acff;    --bm-accent-ramp-mid:     #7c97ff;
--bm-accent-ramp-upper: #6885f8;  --bm-accent-fill-top:     #6d89f5;
--bm-accent-fill-mid: #5b76ea;    --bm-accent-fill-bottom:  #4f69dd;
--bm-danger-hover: #ffc4c7;       --bm-success-deep:        #3fae8a;
--bm-scroll-track: #2b2f3a;       --bm-scroll-thumb:        #262a34;
```

**One compatibility block.** The legacy names from earlier phases (`--bg`,
`--text-soft`, `--line`, `--s-4`, `--r-lg`, `--mint`, `--rose`, `--dur-2`) still
resolve, because scripts and older rules use them. Every one is an alias to a
`--bm-*` token, declared once at the bottom of `tokens.css`. There is one
palette, not two.

**Named layers.** Floating things are ordered in one place instead of being
guessed per component:

```css
--layer-ambient: 0;  --layer-content: 1;  --layer-scrim: 90;   --layer-sheet: 95;
--layer-header: 100; --layer-toast: 320;  --layer-veil: 340;
```

---

## 3. Foundation — Colour, Type, Space

**Surfaces** are graphite, not black: `#08090c` page, `#0f1116` panel,
`#14161c` raised panel, `#191c24` modal/floating. Hairlines are three levels of
translucent white so a border reads as light falling on a surface rather than as
a drawn line.

**Text** is four levels, and every one is measured rather than assumed:

| Token | Value | Worst-case contrast |
| --- | --- | --- |
| `--bm-text` | `#eceef4` | 15.8:1 |
| `--bm-text-secondary` | `#b4b9c8` | 9.0:1 |
| `--bm-text-muted` | `#8b91a3` | 6.3:1 |
| `--bm-text-faint` | `#858b9e` | 5.0:1 |
| `--bm-text-disabled` | `#6b7183` | inert controls only, never body copy |

`--bm-text-faint` started the phase at `#7b8194` (4.43:1 on `--bm-surface-3`)
and was lifted to `#858b9e` after an audit of every foreground/background pair
in the system. Placeholders also had a browser default `opacity: 0.54` on top of
an already-muted colour; that is now `opacity: 1` with an explicit colour token.

**Accent** is one family: `#6d8bff` rest, `#8ba3ff` hover, `#5674ec` press,
`#a7b9ff` focus. Success (`#57cfa6`), warning (`#d8ab68`) and danger
(`#e5888d`) are status only — a filled primary button is the only place a
semantic colour never appears.

**Type** is Inter for everything, JetBrains Mono for numbers, durations and the
content-security strings. Both are self-hosted variable WOFF2 with a latin
subset and a system fallback stack; `document.fonts` reports both `loaded` on
every page in the verification sweep.

---

## 4. Page Compositions Rebuilt

### Home

- The hero is a two-column composition with a **framed preview**: the world
  visualiser sits inside a 1px structural border with a radial light field
  behind it, so the generated visual belongs to the interface instead of
  floating on it.
- The hero meta line ("Real builds · Roblox target · bring your own model") was
  a flex row of three spans that wrapped onto two ragged lines at 1280px and
  rendered middle dots as separate flex items. It is now one sentence with one
  separator and tabular numerals.
- The Idea → Build → Test → Play strip keeps its `is-live` / `is-past` state
  machine (driven by `home.js` every 2200ms) and gains a labelled "View
  projects" exit.
- The "Open your projects" shortcut is a full-width row card, not a third
  hero-sized block, so the page ends on an action rather than trailing off.

### Build

- Composer: prompt field with a character counter, four example chips, then the
  AI configuration grid. The grid is `minmax(0, 1fr)` on both columns with
  `align-items: start`, so a long provider note cannot push the model select
  down.
- The **sticky action bar** was translucent and let the panel ghost through
  underneath it while scrolling. It is now an opaque `--bm-bg` bar with a 28px
  gradient above it marking the cut, and its hint text carries the run state
  (`Ready to build`, `Building…`, and the error copy in `--bm-danger`).
- Activity column: world visualiser, `stage-now` card with title / description /
  index, the seven-step timeline, progress with stage markers, then the activity
  feed. All of that still reads from the same `is-pending | is-active | is-done
  | is-complete | is-failed | is-visited` vocabulary `build.js` writes.

### Projects

- Toolbar: filter chips on the left, search on the right, collapsing to a stack
  below 620px.
- Cards: art panel, name + status, description, footer with "Open" and delete.
  Every tile in a row is exactly the same height (`grid-auto-rows: 1fr`), which
  is what makes a two-card-plus-new-project row read as one grid rather than a
  card, a card, and a stub.
- The **new-project tile** is a dashed slot, deliberately the one dashed edge in
  the product. It is 100% of the row height and carries a very quiet accent wash
  so that when it is alone in a row it reads as an available slot instead of an
  unrendered card. It has an `aria-label` and a one-line note ("Describe an idea
  and build it") in addition to "New project".
- Six CSS-generated scenes (`lattice`, `terrain`, `graph`, `plates`, `dots`,
  `arcs`) share one slate/cool palette and one light source. The distribution is
  deterministic on the project id: 6,000 sample UUIDs produced 932–1,055 hits per
  scene, so no scene dominates a grid.

### Settings

- The narrow shell is 820px and the settings column now fills it exactly — the
  page head, the section heads and the rows all start on the same left edge at
  every width (verified by measuring `getBoundingClientRect()` on each).
- **Stacked rows** (API key, test connection) were the real defect: the row's
  grid item shrink-wrapped, so a full-width password field rendered 279px wide
  on a 720px row. A stacked row is now `flex` with `flex-wrap`, and the wide
  control (`.input`, `.select`, `.input-group`) is `flex: 1 1 100%` — it takes
  the full measure, while the status chip and its button share one line and wrap
  to a full-width button below 620px.
- Section headings step down from `--text-section` to `--text-card`, which puts
  the hierarchy in the right order: page title, then section, then row title.

### 404

Self-contained by necessity — it is served for any unknown path at any depth, so
it cannot reference `css/`. It keeps its inline styles and its CSP script hash,
which was re-verified against the actual script body
(`sha256-XiPfkVW7Fv8Pu7Gvjl3IbaK7RiUrgPZzw54hCnaV/9g=`). Its copied palette was
brought in line with `tokens.css` (`--bm-text-faint` was still the pre-audit
value).

---

## 5. Component Language

- **One control language.** Inputs, selects, textareas and buttons share one
  height (42px; 46px at touch widths), one radius, one border, one focus
  treatment and one disabled treatment.
- **One focus language.** A 2px accent outline with a 2px offset on every
  interactive element; fields use a 1px accent border plus a 4px halo. Focus
  never depends on a tint and never changes layout.
- **One status language.** A dot plus text. The dot is `aria-hidden`; the text is
  the state. `setStatus()` rewrites `className` to `status status--<tone>` and
  keeps `.status__text` / `.status__dot`, with a 340ms `.is-changing` beat.
- **One empty state.** `[data-auth-gate]` and every `#projects-empty` /
  `#projects-no-match` / `#projects-error` region are the same component: a 1px
  structural border, a surface wash, one hairline of light across the top edge,
  a 48px mark, a title, one sentence, and at most one action.
- **One dialog.** Native `<dialog>` + `BM.closeDialog()`, `.is-closing` for
  260ms with a failsafe timer, focus moved to the safe action, Escape and backdrop
  both dismiss, focus returns to the opener.
- **Tone on the toast.** `BM.toast(message, tone)` writes `[data-tone]`; the
  success (check), error (alert) and info (dot) icons differ, so the tone is not
  carried by colour alone. `role="status"` + `aria-atomic="true"`, 2600ms.

---

## 6. Defects Found and Fixed

Every one of these was found by driving the real pages in a browser with a live
API, not by reading the CSS.

| Defect | Why it happened | Fix |
| --- | --- | --- |
| Signed-out gate **and** signed-in workspace visible at once | `[data-auth-gate]{display:grid}` in `main.css` lost to `.empty{display:grid}` in `components.css`, which loads later | the document-state rules moved to the **end** of `components.css`, after every component they need to beat |
| Settings API-key field 279px wide on a 720px row | `.setting-row--stacked` was a grid whose item shrink-wrapped to its content | stacked rows are `flex-wrap` with a `flex: 1 1 100%` wide control; row grid gets `grid-template-columns: minmax(0, 1fr)` |
| Empty state read as an unstyled grey box | `.empty` had a border colour at ~4% white and no structure | structural border + surface gradient + a single `::before` hairline of accent light |
| Text at 12.5px was hard to read on raised surfaces | `--bm-text-faint` was `#7b8194` (4.43:1) | lifted to `#858b9e` (5.02:1); placeholders got `opacity: 1` |
| Build action bar showed the panel through it | translucent gradient + no opaque base | opaque `--bm-bg` + `::before` fade marking the edge |
| Settings content and page head disagreed on the left edge | a `max-width` + `margin-inline: auto` I added fought the narrow shell | the column fills the shell; alignment verified by measurement |
| Projects offered the same primary CTA twice | page head repeated the header action | removed from the page head; the header holds it, the empty state offers its own |
| New-project tile collapsed to a stub beside real cards | `grid-auto-rows` was implicit | `grid-auto-rows: 1fr` + a quiet wash so a lone tile still reads as a slot |
| Hero meta line wrapped into ragged dot-separated fragments | flex row of five children | one sentence, one separator |
| Nav indicator was measured and positioned in JS | a sliding pill needed pixel offsets | `aria-current="page"` + CSS only; `navigation.js` shrank to 74 lines |

---

## 7. Motion & Reduced Motion

`animations.css` holds 21 keyframes, the entrance utilities (`.fade-in`,
`.fade-up`, `.fade-scale`, `.slide-in` with `--enter-delay`, and `.stagger > *`),
the page transition (`.page-veil` + `body.is-leaving` / `is-entering main`), the
sheet, card, dialog and toast choreography, and the reveal system
(`.js [data-reveal]` → `.is-revealed` via `IntersectionObserver`, with a
1200ms rescan in `BM.scanReveals()`).

The contract is unchanged and now stated in three places instead of one:

1. `@media (prefers-reduced-motion: reduce)` collapses every animation and
   transition and shows every reveal immediately.
2. `html[data-motion-mode="reduced"]` does the same, applied live by Settings.
3. `@media print` and `forced-colors: active` force revealed content visible, so
   nothing can hide behind an animation that never ran.

Functional state (a stage advancing, a status changing, a toast) stays visible
in both. Two state-carrying transitions are documented exceptions to the
transform-only rule: the progress fill width, and the timeline description
opening.

---

## 8. Verification Results

### Gates

| Check | Command | Result |
| --- | --- | --- |
| Frontend JS syntax | `node --check` over every `js/**` file | **0 errors** |
| Backend strict TypeScript | `cd backend && npm run typecheck` | **0 errors** |
| Backend integration suites | `cd backend && npm test` (PostgreSQL :5433) | **10 suites, 137 passed, 0 failed, 0 skipped** |
| Production build | `cd backend && npm run build` | **pass** (`dist/server.js` present, `dist/tests` absent) |
| Dependency audit | `cd backend && npm audit --audit-level=high` | **0 vulnerabilities** |
| Chromium E2E — API & journey | `./scripts/e2e.sh` | **42 passed, 0 failed** |
| Chromium E2E — Phase 12 UI | `./scripts/e2e.sh` | **70 passed, 0 failed** |
| Round-trip total | both suites | **112 passed, 0 failed** |

### Visual sweep

Nine widths × four pages, plus the 404 page, in signed-out and signed-in
states:

`320 · 360 · 375 · 390 · 430 · 768 · 1024 · 1280 · 1440` ×
`index · build · projects · settings`

| Measurement | Result |
| --- | --- |
| Horizontal overflow | **0px on every combination** (document scroll width − client width) |
| Console errors / CSP violations | **none** |
| Failed requests | **none** (with the API and proxy running) |
| Fonts | Inter + JetBrains Mono both `loaded` on all four pages |
| `h1` per page | exactly one |
| Visible focusable controls with no hit area | none |
| Reveals stuck hidden after a full scroll | none |
| Duplicate primary CTAs in one viewport | none |
| Gate and workspace visible together | never (measured on both sides of the session check) |

Screens reviewed by eye at each width: home full-page at 320/375/430/768/1024/
1280/1440, build signed-out and signed-in, projects signed-out, signed-in with
cards, signed-in empty, settings signed-out and signed-in, the delete dialog at
1280, the mobile sheet at 375, and the toast at 375 in both tones.

### Accessibility spot checks

- Every control keeps its label association, `aria-describedby` and error
  paragraph; the new stacked-row layout moved boxes, not semantics.
- The gate is `role="status"`, the toast is `role="status"` + `aria-atomic`, and
  the run's live region (`#build-live`) still announces stage changes.
- Tab order follows reading order at every width; the mobile sheet traps focus
  and returns it to the toggle.

---

## 9. What Did Not Change

This is the most important section of the report. Every item below is a
phase-11/12 contract that the redesign had to preserve, and did:

- Every ID listed in `README.md` (build, projects, settings, account) — the E2E
  suites assert on them and all 112 assertions still pass unmodified.
- `.progress__fill` inline width, `setStatus()`'s class rewrite, the timeline state
  vocabulary, `#build-button`'s `btn--primary` / `btn--ghost` toggle (the only
  inline style the build page writes).
- Card class names `project-card__art art-${art} scene-${scene}` and the six
  scene renderers.
- `home.js`'s pipeline `is-live` / `is-past` cycling, `app.js`'s transition hooks
  (`is-leaving`, `is-entering`, `.page-veil.is-active`), `.site-header.is-stuck`,
  `is-sheet-open`, `has-pointer`, `has-error`.
- The service/mode architecture, the API client, the SSE lifecycle, error
  normalization, session gating logic and the backend. **No file under
  `backend/` was modified in this phase.**
- The CSP: `script-src 'self'` with no `unsafe-inline`, `connect-src 'self'`.
  `style-src 'unsafe-inline'` is still required, and the redesign *reduced* what
  needs it — there is no longer a nav indicator offset being written from JS.

---

## 10. Known Limits & Follow-ups

- **Headless Chromium only.** Layout, colour, contrast and hit areas are measured
  accurately; scroll feel, Safari/Firefox `backdrop-filter`, `100dvh` and
  `dialog` centring are verified in one engine. Where `dialog` is unsupported the
  `open` attribute fallback is used.
- **Contrast is measured on rendered pairs**, not every theoretical hover ×
  surface × disabled combination.
- **The 404 page duplicates eleven colour values** by design, because it cannot
  load `css/`. `tokens.css` is the source; a change there has to be mirrored in
  `404.html`. This is noted in the file itself.
- **Scene art is deterministic, not authored per project.** Two projects whose
  ids hash to the same scene get the same art; the palette is the same for all
  six, so a grid still reads as a family.
- **No dark/light toggle.** Dark only, by product decision; `color-scheme: dark`
  is declared so form controls and scrollbars match.
