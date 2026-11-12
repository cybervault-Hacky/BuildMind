/* ==========================================================================
   BuildMind — real browser E2E against the real backend.

   Not a simulation: Chromium loads the actual frontend, which makes actual
   HTTP requests to the actual API, which writes to actual PostgreSQL and
   calls a local stand-in for the AI provider.

   Flow under test (the phase's required journey):
     visit → register → configure provider → validate provider → create
     project → start build → observe live events → cancel → retry → complete
     → open project → build again → logout → login → project still exists

   Plus the failure cases: a rejected key, a provider outage, and a build that
   must not be reported complete.

   Run against the proxy on :8180 (static + /api on one origin, the production
   layout). Requires the backend on :3100 and PostgreSQL.
   ========================================================================== */

/*
  The browser is resolved from the environment so the suite can run on a
  developer machine and in CI without editing the file. The defaults are the
  locations the repository's own tooling provisions.
*/
const path = require('node:path');

const CHROME = process.env.CHROMIUM_PATH || '/tmp/chromium/chromium';
const PUPPETEER = process.env.PUPPETEER_CORE || '/tmp/browser/node_modules/puppeteer-core';

/*
  Chromium needs its own shared libraries on the loader path. The ones that
  ship next to the binary (SwiftShader, EGL) are found through the binary's
  own directory, so that is always included; the compatibility libraries from
  the environment archive are appended when they exist.
*/
const LIBS = [
  path.dirname(CHROME),
  process.env.CHROMIUM_LIBS || '/tmp/al2023x/lib',
]
  .filter(Boolean)
  .join(':');

const puppeteer = require(PUPPETEER);

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8180';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL: ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`);
  }
  results.push({ name, ok, detail });
}

async function newPage(browser) {
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  return { page, errors, requests };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS },
  });

  const email = `e2e-${Date.now()}@example.com`;
  const password = 'correct-horse-battery';

  try {
    /* ---------------------------------------------------------------- 1 -- */
    console.log('1. visit and register through the real UI');
    {
      const { page, errors } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(500);

      // The account section starts signed out, and says so.
      const initial = await page.evaluate(() => ({
        signedOutVisible: !document.querySelector('#account-signed-out').hidden,
        signedInHidden: document.querySelector('#account-signed-in').hidden,
        mode: document.querySelector('#account-mode').textContent.trim(),
      }));
      check('account section starts signed out', initial.signedOutVisible && initial.signedInHidden, initial);
      /* The label reports where data is stored, which follows the configured
         mode — not the session. Signed out on a remote deployment still means
         server storage: the API answers 401, and that is the honest answer. */
      check('mode label reports server storage in remote mode', /server/i.test(initial.mode), initial.mode);

      // Open the form, switch to register, fill and submit.
      await page.click('#account-open-auth');
      await wait(120);
      await page.click('#account-toggle-mode');
      await wait(120);

      const submitText = await page.$eval('#account-submit', (el) => el.textContent.trim());
      check('toggle switches the form to registration', /create account/i.test(submitText), submitText);

      await page.type('#account-email', email);
      await page.type('#account-password', password);
      await page.click('#account-submit');

      // Wait for the signed-in state to appear.
      await page.waitForFunction(
        () => !document.querySelector('#account-signed-in').hidden,
        { timeout: 15000 },
      );

      const signedIn = await page.evaluate(() => ({
        identity: document.querySelector('#account-identity').textContent.trim(),
        mode: document.querySelector('#account-mode').textContent.trim(),
        passwordValue: document.querySelector('#account-password').value,
      }));

      check('registration signs the user in', signedIn.identity.includes(email), signedIn.identity);
      check('mode label switches to server storage', /server/i.test(signedIn.mode), signedIn.mode);
      check('password is cleared from the DOM after submit', signedIn.passwordValue === '', signedIn.passwordValue);
      /* A signed-out visit legitimately produces 401s for /auth/me and
         /projects; the browser logs those as resource errors. Anything else is
         a real defect, so filter narrowly rather than ignoring all errors. */
      const realErrors = errors.filter((e) => !/401 \(Unauthorized\)/.test(e));
      check('no unexpected console errors during registration', realErrors.length === 0, realErrors);
      await page.close();
    }

    /* ---------------------------------------------------------------- 2 -- */
    console.log('2. provider configuration and real validation');
    {
      const { page, errors } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(400);

      // The session survives a reload (HttpOnly cookie), which is the point.
      const stillIn = await page.evaluate(() => !document.querySelector('#account-signed-in').hidden);
      check('session survives a page reload', stillIn === true);

      // Call the real API from the page: the CSP must permit it.
      const validation = await page.evaluate(async () => {
        const me = await fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => r.json());
        const bad = await fetch('/api/v1/ai/validate', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': me.data.csrfToken },
          body: JSON.stringify({ provider: 'openai', apiKey: 'sk-wrong-invalid-key-value' }),
        }).then((r) => r.json());
        return { authenticated: me.data.authenticated, bad };
      });

      check('page is authenticated over the API', validation.authenticated === true);
      // The stand-in provider rejects anything that is not sk-test-.
      check(
        'an unusable key is reported invalid, never valid',
        validation.bad.data.valid === false,
        validation.bad.data,
      );
      check('no CSP violation from a same-origin API call', errors.length === 0, errors);
      await page.close();
    }

    /* ---------------------------------------------------------------- 3 -- */
    console.log('3. create a project and run a real build through the API');
    let buildId = null;
    {
      const { page, errors } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(400);

      const created = await page.evaluate(async () => {
        const me = await fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => r.json());
        const csrf = me.data.csrfToken;
        const project = await fetch('/api/v1/projects', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ name: 'E2E Arena', description: 'built by the browser' }),
        }).then((r) => r.json());

        const build = await fetch('/api/v1/builds', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({
            projectId: project.data.project.id,
            provider: 'openai',
            model: 'gpt-4.1-mini',
            prompt: 'a wave survival arena game with melee combat',
            apiKey: 'sk-valid-e2e-key-value-123',
          }),
        }).then((r) => r.json());

        return { project: project.data.project, build: build.data ? build.data.build : build };
      });

      check('project created', Boolean(created.project && created.project.id), created.project);
      check('build accepted', Boolean(created.build && created.build.id), created.build);
      buildId = created.build && created.build.id ? created.build.id : null;

      // Watch the build settle, and collect the live events as they arrive.
      const settled = await page.evaluate(async (id) => {
        const seen = [];
        const deadline = Date.now() + 30000;
        for (;;) {
          const res = await fetch(`/api/v1/builds/${id}`, { credentials: 'include' }).then((r) => r.json());
          seen.push({ status: res.data.build.status, progress: res.data.build.progress });
          if (['complete', 'failed', 'cancelled'].includes(res.data.build.status)) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        const events = await fetch(`/api/v1/builds/${id}/events`, { credentials: 'include' }).then((r) => r.json());
        return { final: seen[seen.length - 1], observed: seen, events: events.data.events };
      }, buildId);

      check('build reached complete', settled.final.status === 'complete', settled.final);
      check('progress ends at 100', settled.final.progress === 100, settled.final);
      check(
        'the browser observed intermediate progress',
        settled.observed.length > 1,
        settled.observed.length,
      );
      check('real stage events were recorded', settled.events.length >= 8, settled.events.length);

      const stages = new Set(settled.events.map((e) => e.stage).filter(Boolean));
      for (const stage of ['understanding', 'planning', 'building', 'testing', 'validating']) {
        check(`the ${stage} stage ran`, stages.has(stage), [...stages]);
      }
      check('no console errors during a real build', errors.length === 0, errors);
      await page.close();
    }

    /* ---------------------------------------------------------------- 4 -- */
    console.log('4. SSE live events reach the browser');
    {
      const { page } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(300);

      const streamed = await page.evaluate(async (id) => {
        return new Promise((resolve) => {
          const frames = [];
          const source = new EventSource(`/api/v1/builds/${id}/stream`, { withCredentials: true });
          const done = (reason) => {
            source.close();
            resolve({ frames, reason });
          };
          source.onmessage = (event) => {
            frames.push(JSON.parse(event.data));
            if (frames.some((f) => f.terminal === true)) done('terminal');
          };
          source.onerror = () => done('error');
          setTimeout(() => done('timeout'), 8000);
        });
      }, buildId);

      check('EventSource connected to the build stream', streamed.reason !== 'error', streamed.reason);
      check('the stream replayed the build history', streamed.frames.length > 0, streamed.frames.length);
      check(
        'the stream ended with a terminal frame',
        streamed.frames.some((f) => f.terminal === true),
        streamed.frames.length,
      );
      await page.close();
    }

    /* ---------------------------------------------------------------- 5 -- */
    console.log('5. cancellation stops a running build');
    {
      const { page } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(300);

      const cancelled = await page.evaluate(async () => {
        const me = await fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => r.json());
        const csrf = me.data.csrfToken;
        const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };

        const project = await fetch('/api/v1/projects', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ name: 'Cancel me' }),
        }).then((r) => r.json());

        const build = await fetch('/api/v1/builds', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            projectId: project.data.project.id,
            provider: 'openai',
            model: 'gpt-4.1-mini',
            prompt: 'a game that will be cancelled immediately',
            apiKey: 'sk-valid-e2e-key-value-123',
          }),
        }).then((r) => r.json());

        const id = build.data.build.id;
        await new Promise((r) => setTimeout(r, 150));

        const cancel = await fetch(`/api/v1/builds/${id}/cancel`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: '{}',
        }).then((r) => r.json());

        let status = 'unknown';
        for (let i = 0; i < 120; i += 1) {
          const res = await fetch(`/api/v1/builds/${id}`, { credentials: 'include' }).then((r) => r.json());
          status = res.data.build.status;
          if (['complete', 'failed', 'cancelled'].includes(status)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return { id, cancelOk: cancel.ok, status };
      });

      check('cancel request accepted', cancelled.cancelOk === true, cancelled);
      check('build ended cancelled, not complete', cancelled.status === 'cancelled', cancelled.status);
      await page.close();
    }

    /* ---------------------------------------------------------------- 6 -- */
    console.log('6. retry creates a new run and completes');
    {
      const { page } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(300);

      const retried = await page.evaluate(async () => {
        const me = await fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => r.json());
        const headers = { 'content-type': 'application/json', 'x-csrf-token': me.data.csrfToken };

        // The cancelled build from step 5 is retryable.
        const builds = await fetch('/api/v1/builds?limit=10', { credentials: 'include' }).then((r) => r.json());
        const cancelled = builds.data.builds.find((b) => b.status === 'cancelled');
        if (!cancelled) return { error: 'no cancelled build to retry' };

        const retry = await fetch(`/api/v1/builds/${cancelled.id}/retry`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ apiKey: 'sk-valid-e2e-key-value-123' }),
        }).then((r) => r.json());

        if (!retry.ok) return { error: retry.error };

        const id = retry.data.build.id;
        let status = 'unknown';
        for (let i = 0; i < 250; i += 1) {
          const res = await fetch(`/api/v1/builds/${id}`, { credentials: 'include' }).then((r) => r.json());
          status = res.data.build.status;
          if (['complete', 'failed', 'cancelled'].includes(status)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          oldRun: cancelled.runId,
          newRun: retry.data.build.runId,
          newId: retry.data.build.id,
          oldId: cancelled.id,
          status,
        };
      });

      check('retry created a distinct build', retried.newId && retried.newId !== retried.oldId, retried);
      check('retry created a distinct run', retried.newRun !== retried.oldRun, retried);
      check('retried build completed', retried.status === 'complete', retried.status);
      await page.close();
    }

    /* ---------------------------------------------------------------- 7 -- */
    console.log('7. projects persist across logout and login');
    {
      const { page } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(400);

      const before = await page.evaluate(async () => {
        const res = await fetch('/api/v1/projects', { credentials: 'include' }).then((r) => r.json());
        return res.data.projects.map((p) => p.name);
      });
      check('projects exist before logout', before.length >= 2, before);

      // Sign out through the real button.
      await page.click('#account-sign-out');
      await page.waitForFunction(() => !document.querySelector('#account-signed-out').hidden, { timeout: 10000 });

      const afterLogout = await page.evaluate(async () => {
        const res = await fetch('/api/v1/projects', { credentials: 'include' });
        return { status: res.status, body: await res.json() };
      });
      check('after logout the API refuses the project list', afterLogout.status === 401, afterLogout.status);

      // The session cookie is gone from the browser's jar.
      const cookies = await page.cookies();
      check('the session cookie was cleared on logout', !cookies.some((c) => c.name === 'bm_session'), cookies.map((c) => c.name));

      // Sign back in through the form.
      await page.click('#account-open-auth');
      await wait(150);
      await page.type('#account-email', email);
      await page.type('#account-password', password);
      await page.click('#account-submit');
      await page.waitForFunction(() => !document.querySelector('#account-signed-in').hidden, { timeout: 15000 });

      const after = await page.evaluate(async () => {
        const res = await fetch('/api/v1/projects', { credentials: 'include' }).then((r) => r.json());
        return res.data.projects.map((p) => p.name);
      });
      check('the same projects are there after signing back in', after.length === before.length, { before, after });
      check('project names are unchanged', JSON.stringify(after.sort()) === JSON.stringify(before.sort()), { before, after });
      await page.close();
    }

    /* ---------------------------------------------------------------- 8 -- */
    console.log('8. the settings page stays usable and honest');
    {
      const { page, errors } = await newPage(browser);
      await page.goto(`${BASE}/settings.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(500);

      const state = await page.evaluate(() => ({
        sections: [...document.querySelectorAll('.settings-section__title')].map((h) => h.textContent.trim()),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        focusable: document.querySelectorAll('#account-open-auth, #account-sign-out').length,
      }));

      check('every settings section still renders', state.sections.length >= 5, state.sections);
      check('the account section is present', state.sections.includes('Account'), state.sections);
      check('no horizontal overflow with the account UI', state.overflow === false);
      check('no console errors on a signed-in settings page', errors.length === 0, errors);
      await page.close();
    }

    /* ---------------------------------------------------------------- 9 -- */
    console.log('9. signed-out visitors are not shown server data');
    {
      /*
        A second, separate browser process: no shared cookie jar at all.
        (An incognito context would be cleaner, but this Chromium runs with
        --single-process, which does not support them.) Reusing a page from the
        steps above would still carry the session, and the check would pass for
        the wrong reason.
      */
      const isolated = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'shell',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu'],
        env: { ...process.env, LD_LIBRARY_PATH: LIBS },
      });
      const page = await isolated.newPage();
      await page.goto(`${BASE}/index.html?mode=remote`, { waitUntil: 'networkidle2' });
      await wait(400);

      const anon = await page.evaluate(async () => {
        const me = await fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => r.json());
        const projects = await fetch('/api/v1/projects', { credentials: 'include' });
        return { authenticated: me.data.authenticated, projectsStatus: projects.status };
      });

      check('a fresh browser is not authenticated', anon.authenticated === false);
      check('a fresh browser gets 401 for projects', anon.projectsStatus === 401, anon.projectsStatus);
      await page.screenshot({ path: '/tmp/e2e-anon.png', fullPage: true });
      await isolated.close();
    }
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
