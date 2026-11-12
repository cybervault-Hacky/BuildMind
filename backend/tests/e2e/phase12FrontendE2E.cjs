/* ==========================================================================
   BuildMind — Phase 12 real-browser Frontend ↔ Backend Integration E2E.

   Exercises the static frontend's actual DOM controls, controllers, services,
   SSE client, auth gates, provider validation, error boundaries, responsive
   layouts, and secret/cleanup invariants in real Headless Chromium against the
   real Fastify API + PostgreSQL + same-origin proxy.

   Suites covered:
     1. Default remote mode, signed-out auth gates, explicit simulated opt-in
     2. Real auth UI (validation, register, reload persistence, wrong login,
        logout, login)
     3. Provider catalogue & real backend validation UI (not_configured,
        whitespace, invalid, valid, key clearing, secret non-leakage)
     4. Honest external connection boundaries (Roblox & Studio in remote mode)
     5. Real Build UI + live SSE timeline + completion + result summary +
        stream cleanup
     6. Real Build UI cancellation, retry after stop, failed build with bad
        key (never complete, no fallback), and retry with valid key
     7. Real Projects UI (list, deep-link highlight, search, filter, reopen in
        Build, delete confirmation modal)
     8. Non-destructive local-to-account project migration UI
     9. Mid-session 401 expiry recovery, backend outage error gate (no silent
        fallback), pagehide SSE cleanup, responsive viewports, and zero
        console/CSP/URL-secret violations
   ========================================================================== */

const path = require('node:path');

const CHROME = process.env.CHROMIUM_PATH || '/tmp/chromium/chromium';
const PUPPETEER = process.env.PUPPETEER_CORE || '/tmp/browser/node_modules/puppeteer-core';
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

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL: ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`);
  }
}

function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS },
  });
}

async function openTrackedPage(browser, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];
  const requestUrls = [];

  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy/i.test(text)) cspViolations.push(text);
    if (msg.type() === 'error') consoleErrors.push(text);
  });
  page.on('request', (req) => requestUrls.push(req.url()));

  return { page, consoleErrors, pageErrors, cspViolations, requestUrls };
}

(async () => {
  const email = `phase12-${Date.now()}@example.com`;
  const password = 'correct-horse-battery-12';
  const validKey = 'sk-valid-phase12-secret-777';
  const badKey = 'sk-wrong-phase12-secret-000';
  const retryKey = 'sk-valid-phase12-retry-888';
  const allSeenUrls = [];
  const allCspViolations = [];
  const allPageErrors = [];

  /* =====================================================================
     1. Default remote mode & signed-out auth gates (isolated fresh browser)
     ===================================================================== */
  console.log('1. default remote mode, signed-out auth gates, and explicit simulated opt-in');
  {
    const anonBrowser = await launchBrowser();
    try {
      // 1a. Default mode without query string is remote
      const { page, consoleErrors, pageErrors, cspViolations, requestUrls } = await openTrackedPage(anonBrowser);
      await page.goto(`${BASE}/build.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'unauthenticated',
        { timeout: 10000 },
      );

      const buildAnon = await page.evaluate(() => {
        const gate = document.querySelector('#build-auth-gate');
        const workspace = document.querySelector('.workspace[data-auth-only]');
        return {
          serviceModeAttr: document.documentElement.getAttribute('data-service-mode'),
          serviceModeRuntime: window.BuildMind && window.BuildMind.serviceMode,
          authState: document.documentElement.getAttribute('data-auth-state'),
          gateDisplay: gate ? getComputedStyle(gate).display : 'missing',
          workspaceDisplay: workspace ? getComputedStyle(workspace).display : 'missing',
          gateTitle: gate ? gate.querySelector('.empty__title').textContent.trim() : '',
        };
      });

      check('default service mode attribute is remote without query param', buildAnon.serviceModeAttr === 'remote', buildAnon);
      check('runtime BM.serviceMode defaults to remote', buildAnon.serviceModeRuntime === 'remote', buildAnon);
      check('signed-out build page shows auth gate', buildAnon.gateDisplay === 'grid' && /sign in/i.test(buildAnon.gateTitle), buildAnon);
      check('signed-out build workspace is hidden', buildAnon.workspaceDisplay === 'none', buildAnon);
      check('zero console errors on signed-out build.html', consoleErrors.length === 0, consoleErrors);

      // 1b. Signed-out projects.html shows gate, never seeds mock projects, fires zero 401s
      await page.goto(`${BASE}/projects.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'unauthenticated',
        { timeout: 10000 },
      );
      const projectsAnon = await page.evaluate(() => {
        const gate = document.querySelector('#projects-auth-gate');
        const grid = document.querySelector('#projects-grid');
        return {
          gateDisplay: gate ? getComputedStyle(gate).display : 'missing',
          gridDisplay: grid ? getComputedStyle(grid).display : 'missing',
          projectCount: window.BuildMind.getState().projects.length,
        };
      });
      check('signed-out projects page shows auth gate', projectsAnon.gateDisplay === 'grid', projectsAnon);
      check('signed-out projects grid is hidden and has zero seeded projects', projectsAnon.gridDisplay === 'none' && projectsAnon.projectCount === 0, projectsAnon);
      check('zero console errors on signed-out projects.html', consoleErrors.length === 0, consoleErrors);

      // 1c. Explicit ?mode=simulated remains opt-in only
      await page.goto(`${BASE}/build.html?mode=simulated`, { waitUntil: 'networkidle2' });
      const simCheck = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-service-mode'),
        mode: window.BuildMind.serviceMode,
      }));
      check('explicit ?mode=simulated opts into simulated mode cleanly', simCheck.attr === 'simulated' && simCheck.mode === 'simulated', simCheck);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    } finally {
      await anonBrowser.close();
    }
  }

  const browser = await launchBrowser();
  try {
    /* =====================================================================
       2. Real Auth UI (validation, register, reload, logout, wrong password, login)
       ===================================================================== */
    console.log('2. real auth UI: validation, register, session cookie hygiene, logout, wrong login, sign-in');
    {
      const { page, consoleErrors, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);
      await page.goto(`${BASE}/settings.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'unauthenticated',
        { timeout: 10000 },
      );
      check('zero console errors on signed-out settings.html', consoleErrors.length === 0, consoleErrors);

      await page.click('#account-open-auth');
      await page.click('#account-toggle-mode');

      // Short password rejected before hitting the server
      await page.type('#account-email', email);
      await page.type('#account-password', 'short');
      await page.click('#account-submit');
      const shortPwErr = await page.$eval('#password-error', (el) => ({ hidden: el.hidden, text: el.textContent.trim() }));
      check('registration rejects <12 char password in UI', !shortPwErr.hidden && /12/.test(shortPwErr.text), shortPwErr);

      // Complete real registration
      await page.$eval('#account-password', (el) => { el.value = ''; });
      await page.type('#account-password', password);
      await page.click('#account-submit');
      await page.waitForFunction(() => !document.querySelector('#account-signed-in').hidden, { timeout: 15000 });

      const authDom = await page.evaluate(() => ({
        authState: document.documentElement.getAttribute('data-auth-state'),
        identity: document.querySelector('#account-identity').textContent.trim(),
        pwField: document.querySelector('#account-password').value,
        jsCookie: document.cookie,
        localDump: JSON.stringify(localStorage),
        sessionDump: JSON.stringify(sessionStorage),
      }));
      check('HTML auth state reflects authenticated', authDom.authState === 'authenticated', authDom);
      check('account identity renders registered email', authDom.identity.includes(email), authDom.identity);
      check('password input cleared immediately after register', authDom.pwField === '', authDom.pwField);
      check('HttpOnly session cookie is invisible to document.cookie', !authDom.jsCookie.includes('bm_session'), authDom.jsCookie);
      check('neither password nor token is written to web storage', !authDom.localDump.includes(password) && !authDom.sessionDump.includes(password) && !/csrfToken|bm_session/i.test(authDom.localDump + authDom.sessionDump));

      // Sign out, attempt wrong password, verify safe error and no fallback
      await page.click('#account-sign-out');
      await page.waitForFunction(() => !document.querySelector('#account-signed-out').hidden, { timeout: 10000 });

      await page.click('#account-open-auth');
      // Switch back to sign-in mode if still in register mode
      const btnLabel = await page.$eval('#account-submit', (el) => el.textContent.trim());
      if (/create/i.test(btnLabel)) await page.click('#account-toggle-mode');

      await page.$eval('#account-email', (el) => { el.value = ''; });
      await page.$eval('#account-password', (el) => { el.value = ''; });
      await page.type('#account-email', email);
      await page.type('#account-password', 'wrong-password-12345');
      await page.click('#account-submit');
      await page.waitForFunction(() => !document.querySelector('#account-error').hidden, { timeout: 10000 });

      const wrongLogin = await page.evaluate(() => ({
        err: document.querySelector('#account-error').textContent.trim(),
        authState: document.documentElement.getAttribute('data-auth-state'),
        mode: window.BuildMind.serviceMode,
      }));
      check('wrong password displays safe error and stays unauthenticated in remote mode', wrongLogin.authState === 'unauthenticated' && wrongLogin.mode === 'remote' && wrongLogin.err.length > 0 && !/stack|sql|scrypt/i.test(wrongLogin.err), wrongLogin);

      // Sign in with real password
      await page.$eval('#account-password', (el) => { el.value = ''; });
      await page.type('#account-password', password);
      await page.click('#account-submit');
      await page.waitForFunction(() => !document.querySelector('#account-signed-in').hidden, { timeout: 15000 });

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    /* =====================================================================
       3. Provider Catalogue & Real Backend Provider Validation UI
       ===================================================================== */
    console.log('3. provider catalogue, model cascade, and real backend credential validation UI');
    {
      const { page, consoleErrors, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);
      await page.goto(`${BASE}/settings.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => document.querySelectorAll('#settings-provider option').length >= 2, { timeout: 10000 });

      // Switch provider -> Google -> OpenAI cascade
      await page.select('#settings-provider', 'google');
      await wait(150);
      const googleModels = await page.$$eval('#settings-model option', (opts) => opts.map((o) => o.value));
      check('selecting google cascades model dropdown to gemini models', googleModels.some((m) => m.includes('gemini')), googleModels);

      await page.select('#settings-provider', 'openai');
      await wait(150);
      const openaiModels = await page.$$eval('#settings-model option', (opts) => opts.map((o) => o.value));
      check('selecting openai cascades model dropdown to openai models', openaiModels.includes('gpt-4.1-mini'), openaiModels);
      await page.select('#settings-model', 'gpt-4.1-mini');

      // Test connection with no key -> Not configured
      await page.click('#settings-validate-provider');
      await page.waitForFunction(
        () => document.querySelector('#settings-validate-detail').textContent.trim().length > 0,
        { timeout: 10000 },
      );
      const emptyVal = await page.evaluate(() => ({
        status: document.querySelector('#settings-provider-status .status__text').textContent.trim(),
        detail: document.querySelector('#settings-validate-detail').textContent.trim(),
      }));
      check('validating with no key stays Not configured', emptyVal.status === 'Not configured', emptyVal);

      // Whitespace-only key locally flagged
      await page.type('#settings-api-key', '    ');
      const wsState = await page.evaluate(() => ({
        ariaInvalid: document.querySelector('#settings-api-key').getAttribute('aria-invalid'),
        errHidden: document.querySelector('#settings-key-error').hidden,
      }));
      check('whitespace-only API key is flagged invalid', wsState.ariaInvalid === 'true' && !wsState.errHidden, wsState);

      // Invalid key rejected by real backend provider check
      await page.$eval('#settings-api-key', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type('#settings-api-key', badKey);
      await page.click('#settings-validate-provider');
      await page.waitForFunction(
        () => document.querySelector('#settings-provider-status .status__text').textContent.trim() === 'Invalid',
        { timeout: 10000 },
      );
      const badValStatus = await page.$eval('#settings-provider-status .status__text', (el) => el.textContent.trim());
      check('rejected provider key renders Invalid in Settings UI', badValStatus === 'Invalid', badValStatus);

      // Valid key accepted by backend, field cleared, secret absent everywhere
      await page.$eval('#settings-api-key', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type('#settings-api-key', validKey);
      await page.click('#settings-validate-provider');
      await page.waitForFunction(
        () => document.querySelector('#settings-provider-status .status__text').textContent.trim() === 'Valid',
        { timeout: 10000 },
      );

      const goodVal = await page.evaluate((secret) => ({
        providerStatus: document.querySelector('#settings-provider-status .status__text').textContent.trim(),
        configStatus: document.querySelector('#settings-config-status .status__text').textContent.trim(),
        inputVal: document.querySelector('#settings-api-key').value,
        inLocalStorage: JSON.stringify(localStorage).includes(secret),
        inSessionStorage: JSON.stringify(sessionStorage).includes(secret),
        inHtml: document.documentElement.outerHTML.includes(secret),
        inState: JSON.stringify(window.BuildMind.getState()).includes(secret),
      }), validKey);

      check('accepted provider key renders Valid and Ready', goodVal.providerStatus === 'Valid' && goodVal.configStatus === 'Ready', goodVal);
      check('accepted API key is cleared from input and absent from DOM, state, and storage', goodVal.inputVal === '' && !goodVal.inLocalStorage && !goodVal.inSessionStorage && !goodVal.inHtml && !goodVal.inState, goodVal);
      check('zero console errors during provider validation UI', consoleErrors.length === 0, consoleErrors);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    /* =====================================================================
       4. Honest External Connection Boundaries (Roblox & Studio)
       ===================================================================== */
    console.log('4. honest external connection boundaries in Settings and Build');
    {
      const { page, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);
      await page.goto(`${BASE}/settings.html`, { waitUntil: 'networkidle2' });
      await wait(400);

      const connSettings = await page.evaluate(() => ({
        robloxText: document.querySelector('#settings-roblox-status .status__text').textContent.trim(),
        studioText: document.querySelector('#settings-studio-status .status__text').textContent.trim(),
        robloxState: window.BuildMind.getState().connections.roblox.status,
        studioState: window.BuildMind.getState().connections.studio.status,
        localConns: localStorage.getItem(window.BuildMind.STORAGE_KEYS.connections),
      }));
      check('Roblox reports unavailable when server OAuth is unconfigured, never Connected', connSettings.robloxState === 'unavailable' && /external integration required/i.test(connSettings.robloxText), connSettings);
      check('Studio reports unavailable when no Studio plugin is active, never Connected', connSettings.studioState === 'unavailable' && /external integration required/i.test(connSettings.studioText), connSettings);
      check('remote connections never write fake connected flags to localStorage', connSettings.localConns === null, connSettings.localConns);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    /* =====================================================================
       5. Real Build Workspace UI + Live SSE + Completion + Result Summary
       ===================================================================== */
    console.log('5. real Build workspace UI: prompt validation, live SSE stages, completion, result summary');
    let firstCompletedProjectId = '';
    {
      const { page, consoleErrors, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);
      await page.goto(`${BASE}/build.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'authenticated' && !document.querySelector('#build-button').hidden,
        { timeout: 10000 },
      );

      // Stored session credential from Settings makes Build configuration Ready without re-typing key
      await page.waitForFunction(
        () => document.querySelector('#build-config-status .status__text').textContent.trim() === 'Ready',
        { timeout: 10000 },
      );

      // Too-short prompt validation via real button click
      await page.type('#game-prompt', 'short');
      await page.click('#build-button');
      await wait(150);
      const promptErr = await page.evaluate(() => ({
        hidden: document.querySelector('#prompt-error').hidden,
        text: document.querySelector('#prompt-error').textContent.trim(),
        invalid: document.querySelector('#game-prompt').getAttribute('aria-invalid'),
      }));
      check('too-short prompt is rejected by Build UI before creating project/build', !promptErr.hidden && promptErr.invalid === 'true', promptErr);

      // Click an example chip to populate a valid game prompt, then click Build Game
      await page.click('.chip[data-idea]');
      const chipState = await page.evaluate(() => ({
        prompt: document.querySelector('#game-prompt').value,
        buildStatus: window.BuildMind.getState().build.status,
      }));
      check('example idea chip fills composer without starting build', chipState.prompt.length > 20 && chipState.buildStatus === 'ready', chipState);

      // Sample live UI states while the real SSE build runs
      await page.evaluate(() => {
        window.__seenUiBuildStates = [];
        window.BuildMind.subscribe((view) => {
          window.__seenUiBuildStates.push({
            status: view.build.status,
            stage: view.build.stage,
            progress: view.build.progress,
          });
        });
      });

      await page.click('#build-button');

      await page.waitForFunction(
        () => window.BuildMind.getState().build.status === 'complete' && !document.querySelector('#build-result').hidden,
        { timeout: 35000 },
      );
      await wait(250);

      const completedUi = await page.evaluate(() => ({
        seen: window.__seenUiBuildStates,
        progressText: document.querySelector('#progress-value').textContent.trim(),
        stageNow: document.querySelector('#stage-now-label').textContent.trim(),
        feedItems: document.querySelectorAll('#activity-feed .log__item').length,
        doneSteps: document.querySelectorAll('#build-timeline .timeline__step.is-done, #build-timeline .timeline__step.is-complete').length,
        resultHidden: document.querySelector('#build-result').hidden,
        resultName: document.querySelector('#result-name').textContent.trim(),
        resultValidation: document.querySelector('#result-validation').textContent.trim(),
        resultHref: document.querySelector('#result-open').getAttribute('href'),
        activeProjectId: window.BuildMind.getState().activeProjectId,
        activeStreams: window.BuildMind.sse.activeCount(),
      }));

      firstCompletedProjectId = completedUi.activeProjectId;

      check('UI observed intermediate live SSE build stages before completion', completedUi.seen.some((s) => s.status === 'building' || s.status === 'testing' || s.status === 'validating'), completedUi.seen.length);
      check('completed build paints 100% progress and all 7 timeline steps done', completedUi.progressText === '100%' && completedUi.doneSteps === 7, completedUi);
      check('live activity feed rendered real backend stage messages', completedUi.feedItems >= 5, completedUi.feedItems);
      check('result summary card renders project name, Passed validation, and deep link', !completedUi.resultHidden && completedUi.resultName.length > 0 && completedUi.resultValidation === 'Passed' && completedUi.resultHref.includes(firstCompletedProjectId), completedUi);
      check('SSE stream closed cleanly upon build completion (no leaked stream)', completedUi.activeStreams === 0, completedUi.activeStreams);
      check('zero console errors during full UI build + SSE run', consoleErrors.length === 0, consoleErrors);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    /* =====================================================================
       6. Real Build UI Cancel, Retry After Stop, Failed Build, & Retry With Key
       ===================================================================== */
    console.log('6. real Build UI cancellation, retry after stop, failed build (no fallback), and retry with new key');
    {
      const { page, consoleErrors, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);
      await page.goto(`${BASE}/build.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'authenticated' && !document.querySelector('#build-button').hidden,
        { timeout: 10000 },
      );
      await page.waitForFunction(
        () => document.querySelector('#build-config-status .status__text').textContent.trim() === 'Ready',
        { timeout: 10000 },
      );

      // 6a. Start a build via UI and click Stop build while running
      await page.$eval('#game-prompt', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type('#game-prompt', 'Create a round-based arena with classes and a scoreboard.');
      await page.click('#build-button');

      await page.waitForFunction(
        () => /stop build/i.test(document.querySelector('#build-button').textContent),
        { timeout: 10000 },
      );
      const firstRunId = await page.evaluate(() => window.BuildMind.getState().build.runId);
      await page.click('#build-button');

      await page.waitForFunction(
        () => window.BuildMind.getState().build.status === 'stopped' && !document.querySelector('#build-button').disabled,
        { timeout: 15000 },
      );

      const stoppedUi = await page.evaluate(() => ({
        status: window.BuildMind.getState().build.status,
        stageLabel: document.querySelector('#stage-now-label').textContent.trim(),
        resultHidden: document.querySelector('#build-result').hidden,
        btnText: document.querySelector('#build-button').textContent.trim(),
        activeStreams: window.BuildMind.sse.activeCount(),
      }));
      check('UI Stop build waits for server confirmation and settles on stopped, never complete', stoppedUi.status === 'stopped' && /stopped/i.test(stoppedUi.stageLabel) && stoppedUi.resultHidden === true, stoppedUi);
      check('stopped build closes SSE stream cleanly', stoppedUi.activeStreams === 0, stoppedUi.activeStreams);

      // 6b. Click "Build again" on stopped build -> retries on backend with new runId and completes
      await page.click('#build-button');
      await page.waitForFunction(
        () => window.BuildMind.getState().build.status === 'complete' && !document.querySelector('#build-result').hidden,
        { timeout: 35000 },
      );
      const retriedAfterStop = await page.evaluate(() => ({
        runId: window.BuildMind.getState().build.runId,
        status: window.BuildMind.getState().build.status,
        activeStreams: window.BuildMind.sse.activeCount(),
      }));
      check('retrying a stopped build via UI creates a distinct runId and reaches complete', retriedAfterStop.status === 'complete' && retriedAfterStop.runId !== firstRunId && retriedAfterStop.activeStreams === 0, retriedAfterStop);

      // 6c. Clear context, forget stored key, submit a BAD key in #api-key -> build fails honestly, never completes
      await page.click('#project-context-close');
      await page.evaluate(async () => {
        await window.BuildMind.aiService.forgetCredentials();
        window.BuildMind.setApiKeyPresent(false);
      });

      await page.$eval('#game-prompt', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type('#game-prompt', 'Build a tycoon where players buy droppers and expand a base.');
      await page.type('#api-key', badKey);
      await page.click('#build-button');

      // Key input must be cleared immediately on submit
      await wait(120);
      const clearedImmediately = await page.$eval('#api-key', (el) => el.value);
      check('Build #api-key input is cleared immediately after submission', clearedImmediately === '', clearedImmediately);

      await page.waitForFunction(
        () => window.BuildMind.getState().build.status === 'error',
        { timeout: 20000 },
      );

      const failedUi = await page.evaluate(() => ({
        status: window.BuildMind.getState().build.status,
        mode: window.BuildMind.serviceMode,
        stageLabel: document.querySelector('#stage-now-label').textContent.trim(),
        btnText: document.querySelector('#build-button').textContent.trim(),
        resultHidden: document.querySelector('#build-result').hidden,
        activeStreams: window.BuildMind.sse.activeCount(),
      }));
      check('provider failure settles UI on error ("Try again") with result hidden and zero simulated fallback', failedUi.status === 'error' && failedUi.mode === 'remote' && /try again/i.test(failedUi.btnText) && failedUi.resultHidden === true && failedUi.activeStreams === 0, failedUi);

      // 6d. Supply valid retryKey in #api-key and click "Try again" -> real retry succeeds!
      await page.type('#api-key', retryKey);
      await page.click('#build-button');
      await page.waitForFunction(
        () => window.BuildMind.getState().build.status === 'complete' && !document.querySelector('#build-result').hidden,
        { timeout: 35000 },
      );
      const recoveredUi = await page.evaluate(() => ({
        status: window.BuildMind.getState().build.status,
        keyFieldValue: document.querySelector('#api-key').value,
        activeStreams: window.BuildMind.sse.activeCount(),
      }));
      check('clicking Try again with valid key retries on server and completes cleanly', recoveredUi.status === 'complete' && recoveredUi.keyFieldValue === '' && recoveredUi.activeStreams === 0, recoveredUi);
      check('zero console errors across cancel, failure, and retry flows', consoleErrors.length === 0, consoleErrors);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    /* =====================================================================
       7. Real Projects UI (list, deep link, search, filter, reopen, delete)
       ===================================================================== */
    console.log('7. real Projects UI: server list, search, filter, reopen in Build, delete modal');
    {
      const { page, consoleErrors, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);
      await page.goto(`${BASE}/projects.html?project=${encodeURIComponent(firstCompletedProjectId)}`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => window.BuildMind.getState().projectsStatus === 'ready' && document.querySelectorAll('.project-card').length >= 3,
        { timeout: 10000 },
      );

      const listState = await page.evaluate(() => ({
        cards: document.querySelectorAll('.project-card').length,
        countText: document.querySelector('#projects-count').textContent.trim(),
        anySimulated: window.BuildMind.getState().projects.some((p) => p.simulated === true),
        allRemote: window.BuildMind.getState().projects.every((p) => p.remote === true),
      }));
      check('Projects UI renders all server-persisted projects and zero simulated records', listState.cards >= 3 && !listState.anySimulated && listState.allRemote && /projects/i.test(listState.countText), listState);

      // Search filtering + no-results empty state + reset
      await page.type('#projects-search', 'no-such-project-xyz');
      await wait(120);
      const noResultsVisible = await page.$eval('#projects-no-results', (el) => !el.hidden);
      check('searching non-matching text reveals #projects-no-results state', noResultsVisible === true);

      await page.click('#projects-reset-search');
      await wait(120);
      const restoredCards = await page.$$eval('.project-card', (els) => els.length);
      check('clearing search restores all project cards', restoredCards === listState.cards, restoredCards);

      // Reopen project in Build via card Open link
      const openHref = await page.$eval(`.project-card[data-id="${firstCompletedProjectId}"] .project-card__open`, (el) => el.getAttribute('href'));
      await page.goto(`${BASE}/${openHref}`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => !document.querySelector('#project-context').hidden && document.querySelector('#game-prompt').value.length > 10,
        { timeout: 10000 },
      );
      const reopened = await page.evaluate(() => ({
        contextHidden: document.querySelector('#project-context').hidden,
        contextTitle: document.querySelector('#project-context-title').textContent.trim(),
        promptVal: document.querySelector('#game-prompt').value,
        apiKeyVal: document.querySelector('#api-key').value,
      }));
      check('opening a project in Build restores context banner and prompt without restoring any key', !reopened.contextHidden && reopened.contextTitle.length > 0 && reopened.promptVal.length > 10 && reopened.apiKeyVal === '', reopened);

      // Return to Projects and delete one project through confirmation modal
      await page.goto(`${BASE}/projects.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => document.querySelectorAll('.project-card').length >= 3, { timeout: 10000 });
      const beforeDeleteCount = await page.$$eval('.project-card', (els) => els.length);

      await page.click('.project-card .project-card__delete');
      await wait(120);
      const dialogOpen = await page.$eval('#project-delete-dialog', (d) => d.open === true || d.hasAttribute('open'));
      check('clicking delete opens confirmation dialog', dialogOpen === true);

      await page.click('#project-delete-confirm');
      await page.waitForFunction(
        (prev) => document.querySelectorAll('.project-card').length === prev - 1,
        { timeout: 10000 },
        beforeDeleteCount,
      );
      const afterDeleteServer = await page.evaluate(async () => {
        const res = await fetch('/api/v1/projects', { credentials: 'include' }).then((r) => r.json());
        return res.data.projects.length;
      });
      check('confirming delete removes project in PostgreSQL and DOM', afterDeleteServer === beforeDeleteCount - 1, { beforeDeleteCount, afterDeleteServer });
      check('zero console errors during Projects UI interactions', consoleErrors.length === 0, consoleErrors);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    /* =====================================================================
       8. Non-destructive Local-to-Account Project Migration UI
       ===================================================================== */
    console.log('8. non-destructive local-to-account project migration UI');
    {
      const { page, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);
      await page.goto(`${BASE}/settings.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => !document.querySelector('#account-signed-in').hidden, { timeout: 10000 });

      const existingName = await page.evaluate(async () => {
        const res = await fetch('/api/v1/projects', { credentials: 'include' }).then((r) => r.json());
        return res.data.projects[0].name;
      });

      await page.evaluate((dupName) => {
        localStorage.setItem(
          window.BuildMind.STORAGE_KEYS.projects,
          JSON.stringify([
            { id: 'loc-1', name: 'Migrated Obby Quest', description: 'Local project', prompt: 'Make an obby quest with Lava', apiKey: 'sk-never-upload-me' },
            { id: 'loc-2', name: dupName, description: 'Duplicate name skipped', prompt: 'Duplicate prompt' },
          ]),
        );
      }, existingName);

      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction(() => !document.querySelector('#account-migration').hidden, { timeout: 10000 });

      await page.click('#account-migrate');
      await page.waitForFunction(() => document.querySelector('#account-migration').hidden, { timeout: 10000 });

      const migratedCheck = await page.evaluate(() => ({
        localStillIntact: JSON.parse(localStorage.getItem(window.BuildMind.STORAGE_KEYS.projects)).length === 2,
        serverNames: window.BuildMind.getState().projects.map((p) => p.name),
      }));
      check('local migration copies new project, skips case-insensitive duplicate, and preserves local copies', migratedCheck.localStillIntact && migratedCheck.serverNames.includes('Migrated Obby Quest'), migratedCheck);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    /* =====================================================================
       9. Session Expiry (401), Backend Outage Gate, Stream Cleanup & Responsive
       ===================================================================== */
    console.log('9. session expiry recovery, outage error gate (no fallback), pagehide cleanup, and responsive viewports');
    {
      const { page, pageErrors, cspViolations, requestUrls } = await openTrackedPage(browser);

      // 9a. Start a build and navigate away mid-stream -> pagehide closes SSE cleanly
      await page.goto(`${BASE}/build.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'authenticated' && !document.querySelector('#build-button').hidden,
        { timeout: 10000 },
      );
      await page.type('#game-prompt', 'Create a multiplayer survival game on a floating island.');
      await page.click('#build-button');
      await page.waitForFunction(() => window.BuildMind.sse.activeCount() === 1, { timeout: 10000 });

      // Navigate to projects.html while stream is open
      await page.goto(`${BASE}/projects.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => window.BuildMind.getState().projectsStatus === 'ready', { timeout: 10000 });
      const streamsOnNewPage = await page.evaluate(() => window.BuildMind.sse.activeCount());
      check('navigating away during active build leaves zero SSE streams on destination page', streamsOnNewPage === 0, streamsOnNewPage);

      // Cancel any in-flight build on server so background worker finishes cleanly
      await page.evaluate(async () => {
        const me = await fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => r.json());
        const list = await fetch('/api/v1/builds?limit=5', { credentials: 'include' }).then((r) => r.json());
        for (const b of list.data.builds) {
          if (!['complete', 'failed', 'cancelled'].includes(b.status)) {
            await fetch(`/api/v1/builds/${b.id}/cancel`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json', 'x-csrf-token': me.data.csrfToken },
              body: '{}',
            });
          }
        }
      });

      // 9b. Responsive checks across Mobile (375), Tablet (768), Desktop (1280) + mobile menu sheet
      for (const vp of [
        { label: 'mobile-375', width: 375, height: 812 },
        { label: 'tablet-768', width: 768, height: 1024 },
        { label: 'desktop-1280', width: 1280, height: 800 },
      ]) {
        await page.setViewport({ width: vp.width, height: vp.height });
        for (const route of ['index.html', 'build.html', 'projects.html', 'settings.html']) {
          await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle2' });
          await wait(120);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          );
          check(`no horizontal overflow on ${route} at ${vp.label}`, overflow === false, { route, vp: vp.label, overflow });
        }
      }

      // Mobile navigation sheet open & Escape close at 375px
      await page.setViewport({ width: 375, height: 812 });
      await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle2' });
      await page.click('.menu-toggle');
      const mobileOpen = await page.$eval('.menu-toggle', (el) => el.getAttribute('aria-expanded'));
      await page.keyboard.press('Escape');
      const mobileClosed = await page.$eval('.menu-toggle', (el) => el.getAttribute('aria-expanded'));
      check('mobile navigation sheet opens and closes cleanly on Escape', mobileOpen === 'true' && mobileClosed === 'false', { mobileOpen, mobileClosed });

      // 9c. Mid-session 401 session expiry clears projects and shows auth gate immediately
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${BASE}/projects.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => window.BuildMind.getState().projects.length >= 2, { timeout: 10000 });

      // Delete the HttpOnly cookie via CDP/Puppeteer to simulate server-side expiry, then trigger a protected load
      const cookies = await page.cookies();
      for (const c of cookies) {
        if (c.name === 'bm_session') await page.deleteCookie(c);
      }
      await page.evaluate(() => window.BuildMind.projectController.load());
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'unauthenticated',
        { timeout: 10000 },
      );
      const expiredState = await page.evaluate(() => ({
        authState: document.documentElement.getAttribute('data-auth-state'),
        mode: window.BuildMind.serviceMode,
        projectsLeft: window.BuildMind.getState().projects.length,
        gateDisplay: getComputedStyle(document.querySelector('#projects-auth-gate')).display,
      }));
      check('401 session expiry clears user projects, shows sign-in gate, and stays in remote mode', expiredState.authState === 'unauthenticated' && expiredState.mode === 'remote' && expiredState.projectsLeft === 0 && expiredState.gateDisplay === 'grid', expiredState);

      // 9d. Backend outage on /api/v1/auth/me shows service-unavailable error gate, NEVER simulated fallback
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().includes('/api/v1/auth/me')) req.abort('failed');
        else req.continue();
      });
      await page.goto(`${BASE}/projects.html`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-auth-state') === 'error',
        { timeout: 10000 },
      );
      const outageState = await page.evaluate(() => {
        const gate = document.querySelector('#projects-auth-gate');
        return {
          authState: document.documentElement.getAttribute('data-auth-state'),
          mode: window.BuildMind.serviceMode,
          title: gate.querySelector('.empty__title').textContent.trim(),
          actionHidden: gate.querySelector('.empty__action').hidden,
          projectsCount: window.BuildMind.getState().projects.length,
        };
      });
      check('backend outage renders service-unavailable error gate and never falls back to simulation', outageState.authState === 'error' && outageState.mode === 'remote' && /unavailable/i.test(outageState.title) && outageState.actionHidden === true && outageState.projectsCount === 0, outageState);

      allSeenUrls.push(...requestUrls);
      allCspViolations.push(...cspViolations);
      allPageErrors.push(...pageErrors);
      await page.close();
    }

    // Global network/CSP/pageerror audit across all visited pages & requests
    const leakedInUrl = allSeenUrls.filter(
      (u) => u.includes(validKey) || u.includes(badKey) || u.includes(retryKey) || u.includes(password) || /apiKey=/i.test(u),
    );
    check('no API key or password ever appeared in any request URL', leakedInUrl.length === 0, leakedInUrl);
    check('zero Content-Security-Policy violations across all pages', allCspViolations.length === 0, allCspViolations);
    check('zero uncaught page errors across all pages', allPageErrors.length === 0, allPageErrors);
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
