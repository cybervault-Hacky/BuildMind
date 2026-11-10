# Deploying BuildMind

BuildMind is a static, local-first frontend. There is no server component, no
database and no API. "Deploying" means copying these files to any static host
and serving them over HTTPS.

Nothing in this document describes infrastructure that does not exist.

---

## 1. Prerequisites

| Need | Why |
| --- | --- |
| A static file host | Any host that serves files over HTTP(S) |
| An HTTPS endpoint | Required for a secure context (see §7) |
| Python 3 **or** Node.js | Only to run a local static server for development |

There is **no** `npm install` step. The repository has no `package.json`, no
dependencies, no build step and no bundler. Do not add one to deploy it.

## 2. Run it locally

Any static file server pointed at the repository root works:

```bash
# Python 3 (no dependencies)
python3 -m http.server 8080

# or Node.js
npx serve .
```

Open <http://localhost:8080>. Serve over HTTP rather than opening a `file://`
URL: relative paths, fonts and the page-transition layer are all verified over
HTTP.

## 3. What to deploy

Deploy the repository as-is. The deployed set is:

```
index.html  build.html  projects.html  settings.html  404.html  robots.txt
css/  (main.css, animations.css, responsive.css)
js/   (app.js, boot-class.js, state.js, controllers/, services/, page scripts)
assets/  (fonts/, icons/, images/, game-scenes/)
```

Ignore `.git/` and `README.md`/`DEPLOYMENT.md` if your host has a size limit;
they are not needed at runtime.

Everything is referenced with **relative** paths, so the app works from a domain
root (`https://example.com/`) and equally well from a subdirectory
(`https://example.com/buildmind/`). This is verified, not assumed.

## 4. Host configuration

### 4.1 The 404 page

`404.html` is a real, styled page that matches the app shell. Most static hosts
pick it up automatically. If your host requires it, configure it explicitly:

- **Netlify** — automatic (`/404.html` is the default).
- **GitHub Pages** — automatic for project and user sites.
- **Cloudflare Pages** — automatic.
- **S3 / CloudFront** — set the error document to `404.html`.
- **nginx** — `error_page 404 /404.html;`
- **Apache** — `ErrorDocument 404 /404.html`

If you serve from a subdirectory, point the error document at
`/subdir/404.html`.

### 4.2 MIME types

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

## 5. Required security headers

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
- **`script-src` carries no `unsafe-inline` and no `unsafe-eval`.** Keep it that
  way; the app has no inline scripts.
- **`connect-src 'none'`** is correct and intentional: the frontend makes no
  network calls at all. If a future phase adds a real backend, this directive
  must be widened to exactly that origin and nothing else.
- **`frame-ancestors 'none'`** can only be expressed as a header, not in a meta
  tag. It is why headers are preferred.
- `Permissions-Policy` is belt-and-braces: the app uses none of those features.

### 5.1 HSTS (only if you control the domain over HTTPS)

```http
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Only add this once every subdomain is HTTPS. It is not required for the app to
function.

## 6. Caching

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

## 7. HTTPS and secure context

The app requires no privileged browser APIs, so it also runs on plain HTTP.
Deploy over HTTPS anyway: it is the default for every modern host, and it keeps
the door shut on mixed-content and downgrade problems as the app grows.

The frontend references **no external origin of any kind** — no CDN, no font
host, no analytics, no API. Every request is same-origin, so mixed content
cannot occur. This is verified: with all non-local origins blocked, all four
pages plus a full build still work and zero external requests are attempted.

## 8. Offline behaviour

After the assets are available, the app is fully usable without internet:
pages, fonts, navigation, the build simulation, projects, settings and storage.
There is no service worker, so a first visit needs the network; a normal browser
HTTP cache covers revisits.

If you later add a service worker, the CSP does not need to change (a worker is
same-origin) — but do not add one without testing the update path.

## 9. Post-deploy verification

Run these against the deployed URL, not localhost:

1. Open `/`, `/index.html`, `/build.html`, `/projects.html`, `/settings.html`
   directly. All five should render.
2. Open a path that does not exist; confirm you get the styled BuildMind 404,
   not the host's default page.
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

## 10. Known limitations that affect deployment

- **No server-side rendering or routing.** Four HTML files and a 404 page. Deep
  links use a query string, not path segments; there is nothing to rewrite.
- **Data is per-browser.** Projects and settings live in that browser's
  `localStorage`. Clearing site data removes them. There is no sync, no account
  and no recovery across devices — by design.
- **Everything is simulated.** No provider is contacted, no key is verified, no
  Roblox or Studio integration exists. Do not market a deployment of this as
  having real generation or publishing.
- **The CSP meta tag is a fallback.** Without host headers you lose
  `frame-ancestors` and `X-Content-Type-Options`.
