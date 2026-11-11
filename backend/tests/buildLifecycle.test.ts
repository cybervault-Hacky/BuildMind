/* ==========================================================================
   BuildMind API — tests/buildLifecycle.test.ts
   The build engine, driven through the real HTTP surface with the test
   provider registered (NODE_ENV=test only).

   What is genuinely exercised here:
     * a full build: queued → … → complete, with real validation
     * the fix loop (a first generation that fails validation, then a fix)
     * the fix limit (a provider that always returns broken output)
     * cancellation mid-run, and the guarantee that a cancelled build never
       later becomes complete
     * retry creates a NEW runId and the old run cannot touch it
     * stale-run rejection at the database boundary
     * malformed model output fails safely rather than being trusted

   The provider is a test double, but everything around it is real: real
   PostgreSQL, real Zod validation, real artifact checks, real state machine.
   ========================================================================== */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';
import { FakeOpenAI, goodArtifacts } from './helpers/fakeOpenAI.js';
import { BuildRepository } from '../src/repositories/builds/buildRepository.js';

let db: TestDb;
let testApp: TestApp;
let client: TestClient;
let userId: string;

const fake = new FakeOpenAI();

/** Poll until the build leaves a non-terminal state, or time out. */
async function waitForTerminal(
  buildId: string,
  timeoutMs = 15_000,
): Promise<{ status: string; progress: number; runId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.get(`/api/v1/builds/${buildId}`);
    const build = res.body.data.build as { status: string; progress: number; runId: string };
    if (['complete', 'failed', 'cancelled'].includes(build.status)) return build;
    if (Date.now() > deadline) throw new Error(`build did not settle; last status ${build.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

before(async () => {
  // The real OpenAIProvider adapter is pointed at a local stand-in, so the
  // production adapter code path is what these tests exercise.
  await fake.start();
  db = await createTestDb();
  testApp = await createTestApp({
    databaseUrl: db.url,
    envOverrides: { OPENAI_BASE_URL: fake.url },
  });
});

after(async () => {
  await testApp.close();
  await db.drop();
  await fake.stop();
});

beforeEach(async () => {
  // A fresh user per test: sessions, projects and builds never cross tests.
  client = new TestClient(testApp.app);
  const registered = await client.register();
  userId = registered.user.id;
});

afterEach(async () => {
  fake.reset();
  await resetData(db.pool);
});

async function newProject(name = 'Arena'): Promise<string> {
  const res = await client.post('/api/v1/projects', { name, description: 'test project' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.project.id as string;
}

async function startBuild(projectId: string, prompt = 'a wave survival arena game'): Promise<string> {
  const res = await client.post('/api/v1/builds', {
    projectId,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    prompt,
    apiKey: 'sk-test-build-key',
  });
  assert.equal(res.status, 202, `build create failed: ${JSON.stringify(res.body)}`);
  return res.body.data.build.id as string;
}

describe('successful build', () => {
  it('runs the stages and completes with validation evidence', async () => {
    const projectId = await newProject();
    const buildId = await startBuild(projectId);

    const final = await waitForTerminal(buildId);
    assert.equal(final.status, 'complete');

    const detail = await client.get(`/api/v1/builds/${buildId}`);
    assert.equal(detail.body.data.build.progress, 100);
    assert.equal(detail.body.data.build.currentStage, 'complete');
    assert.equal(detail.body.data.build.errorCode, null);

    // Real events were persisted, in order, with real stage names.
    const events = await client.get(`/api/v1/builds/${buildId}/events`);
    const list = events.body.data.events as Array<{ seq: number; stage: string | null; status: string }>;
    // preparing, understanding x2, planning x2, building x2, testing x2,
    // validating x2, complete — every one a real backend step.
    assert.ok(list.length >= 11, `expected at least 11 events, got ${list.length}`);

    const stages = list.map((e) => e.stage).filter(Boolean);
    assert.ok(stages.includes('understanding'));
    assert.ok(stages.includes('planning'));
    assert.ok(stages.includes('building'));
    assert.ok(stages.includes('validating'));

    // Sequence numbers are monotonic and unique.
    const seqs = list.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  });

  it('writes specification, plan, artifacts and evidence to the workspace', async () => {
    const projectId = await newProject();
    const buildId = await startBuild(projectId);
    await waitForTerminal(buildId);

    const { readFile, readdir } = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.join(testApp.workspaceRoot, userId, buildId);

    const files = await readdir(dir);
    assert.ok(files.includes('specification.json'));
    assert.ok(files.includes('plan.json'));
    assert.ok(files.includes('result.json'));

    const spec = JSON.parse(await readFile(path.join(dir, 'specification.json'), 'utf8'));
    assert.equal(typeof spec.name, 'string');

    const result = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'));
    assert.equal(result.status, 'complete');
    assert.equal(result.evidence.backendValidation, 'passed');
    // Studio and runtime validation must be reported as not run, not as passed.
    assert.equal(result.evidence.studioValidation, 'not_run');
    assert.equal(result.evidence.runtimeValidation, 'not_run');
  });

  it('marks the project complete and records lastBuildAt', async () => {
    const projectId = await newProject();
    const buildId = await startBuild(projectId);
    await waitForTerminal(buildId);

    const project = await client.get(`/api/v1/projects/${projectId}`);
    assert.equal(project.body.data.project.status, 'complete');
    assert.ok(project.body.data.project.lastBuildAt, 'lastBuildAt must be set');
  });
});

describe('fix loop', () => {
  it('repairs a failing generation and then completes', async () => {
    const projectId = await newProject();

    // Drive the real adapter: the first *generation* returns a path-traversal
    // artifact so validation must fail; the repair call then returns good
    // artifacts. The loop closes on the second pass.
    fake.options = {
      onChat: (system) => {
        const lower = system.toLowerCase();
        // Order matters: the repair prompt *mentions* "construction stage" when
        // describing the artifact shape, so repair is matched first.
        if (lower.includes('repair stage')) {
          return { content: JSON.stringify({ diagnosis: 'Added the missing manifest.', artifacts: goodArtifacts() }) };
        }
        if (lower.includes('construction stage')) {
          // Passes the envelope check but is structurally incomplete: the
          // planned manifest is missing, so the real validator must complain.
          return {
            content: JSON.stringify({
              artifacts: [{ path: 'Main.luau', type: 'script', content: '-- draft', metadata: {} }],
            }),
          };
        }
        return null;
      },
    };

    const buildId = await startBuild(projectId);
    const final = await waitForTerminal(buildId);
    assert.equal(final.status, 'complete', 'the fix loop should recover');

    const events = await client.get(`/api/v1/builds/${buildId}/events`);
    const stages = (events.body.data.events as Array<{ stage: string | null }>).map((e) => e.stage);
    assert.ok(stages.includes('testing'), 'testing stage must have run');
    assert.ok(stages.includes('fixing'), 'fixing stage must have run');
    assert.ok(fake.chatCount >= 4, `expected spec+plan+generation+fix calls, got ${fake.chatCount}`);
  });

  it('fails rather than completing when fix attempts are exhausted', async () => {
    const projectId = await newProject();

    // Every generation and every repair returns the same unsafe path, so
    // validation can never pass and the loop must terminate as `failed`.
    fake.options = {
      onChat: (system) => {
        const lower = system.toLowerCase();
        if (lower.includes('repair stage')) {
          // A well-formed *fix* that still fails validation: a repair that
          // does not actually fix anything must exhaust the loop.
          return {
            content: JSON.stringify({
              diagnosis: 'Attempted a repair that did not resolve the failure.',
              artifacts: [{ path: 'Main.luau', type: 'script', content: '-- still draft', metadata: {} }],
            }),
          };
        }
        if (lower.includes('construction stage')) {
          // Structurally incomplete: the validator can never pass.
          return {
            content: JSON.stringify({
              artifacts: [{ path: 'Main.luau', type: 'script', content: '-- draft', metadata: {} }],
            }),
          };
        }
        return null;
      },
    };

    const buildId = await startBuild(projectId);
    const final = await waitForTerminal(buildId);

    assert.equal(final.status, 'failed', 'exhausted fixes must fail, never complete');

    const detail = await client.get(`/api/v1/builds/${buildId}`);
    assert.equal(detail.body.data.build.errorCode, 'BUILD_FAILED');

    // The project must not claim a build that never passed validation.
    const project = await client.get(`/api/v1/projects/${projectId}`);
    assert.equal(project.body.data.project.status, 'error');
    assert.equal(project.body.data.project.lastBuildAt, null);

    // spec + plan + generation + MAX_FIX_ATTEMPTS repairs (2) = 5 calls, and
    // no more: the loop must stop, not keep spending.
    assert.equal(fake.chatCount, 5, `expected exactly 5 provider calls, got ${fake.chatCount}`);
  });
});

describe('malformed provider output', () => {
  it('fails safely when the model returns invalid JSON', async () => {
    fake.options = { contentOverride: '{ "artifacts": [ not json' };
    const projectId = await newProject();
    const buildId = await startBuild(projectId);

    const final = await waitForTerminal(buildId);
    assert.equal(final.status, 'failed');

    const detail = await client.get(`/api/v1/builds/${buildId}`);
    assert.equal(detail.body.data.build.errorCode, 'PROVIDER_INVALID_OUTPUT');
  });

  it('fails safely when the provider is unavailable', async () => {
    // 503 maps to PROVIDER_UNAVAILABLE in the adapter.
    fake.options = { failChatWith: 503 };
    const projectId = await newProject();
    const buildId = await startBuild(projectId);

    const final = await waitForTerminal(buildId);
    assert.equal(final.status, 'failed');

    const detail = await client.get(`/api/v1/builds/${buildId}`);
    assert.equal(detail.body.data.build.errorCode, 'PROVIDER_UNAVAILABLE');
    // The safe message must not contain provider internals.
    assert.ok(!/api\.openai\.com|stack|node_modules/i.test(detail.body.data.build.errorMessageSafe));
  });
});

describe('cancellation', () => {
  it('cancels a running build and never lets it reach complete', async () => {
    // A slow provider gives us a reliable window to cancel inside.
    fake.options = { delayMs: 250 };
    const projectId = await newProject();
    const buildId = await startBuild(projectId);

    // Wait until it is actually working, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancel = await client.post(`/api/v1/builds/${buildId}/cancel`);
    assert.equal(cancel.status, 200);

    const final = await waitForTerminal(buildId);
    assert.equal(final.status, 'cancelled');

    // Wait past the point the old run would have finished, then re-check.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await client.get(`/api/v1/builds/${buildId}`);
    assert.equal(after.body.data.build.status, 'cancelled', 'a cancelled build must stay cancelled');

    const project = await client.get(`/api/v1/projects/${projectId}`);
    assert.equal(project.body.data.project.status, 'stopped');
  });

  it('rejects cancelling an already-terminal build', async () => {
    const projectId = await newProject();
    const buildId = await startBuild(projectId);
    await waitForTerminal(buildId);

    const res = await client.post(`/api/v1/builds/${buildId}/cancel`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'BUILD_CONFLICT');
  });
});

describe('retry', () => {
  it('creates a new build with a new runId, preserving the project', async () => {
    fake.options = { failChatWith: 503 };
    const projectId = await newProject();
    const firstId = await startBuild(projectId);
    const first = await waitForTerminal(firstId);
    assert.equal(first.status, 'failed');

    // Retry against a working provider.
    fake.reset();
    const retry = await client.post(`/api/v1/builds/${firstId}/retry`);
    assert.equal(retry.status, 202, JSON.stringify(retry.body));

    const retried = retry.body.data.build as { id: string; runId: string; projectId: string; retryOf: string };
    assert.notEqual(retried.id, firstId, 'retry must create a distinct build');
    assert.notEqual(retried.runId, first.runId, 'retry must create a distinct run');
    assert.equal(retried.projectId, projectId, 'retry preserves project identity');
    assert.equal(retried.retryOf, firstId);

    const final = await waitForTerminal(retried.id);
    assert.equal(final.status, 'complete');
  });

  it('rejects retrying a build that is still running', async () => {
    fake.options = { delayMs: 200 };
    const projectId = await newProject();
    const buildId = await startBuild(projectId);

    const res = await client.post(`/api/v1/builds/${buildId}/retry`);
    assert.equal(res.status, 409);

    await client.post(`/api/v1/builds/${buildId}/cancel`);
    await waitForTerminal(buildId);
  });
});

describe('stale run rejection at the storage boundary', () => {
  it('refuses a transition whose runId does not match the row', async () => {
    const projectId = await newProject();
    const buildId = await startBuild(projectId);
    await waitForTerminal(buildId);

    const row = await db.pool.query<{ run_id: string; status: string }>(
      'SELECT run_id, status FROM builds WHERE id = $1',
      [buildId],
    );
    const actualRun = row.rows[0]?.run_id ?? '';
    const staleRun = '00000000-0000-4000-8000-000000000000';

    // A writer from a superseded run updates nothing.
    const repo = new BuildRepository(db.pool);
    const stale = await repo.transition({
      id: buildId,
      userId,
      runId: staleRun,
      expected: 'validating',
      next: 'failed',
    });
    assert.equal(stale, null, 'a stale run must not change the row');

    const after = await db.pool.query<{ status: string; run_id: string }>(
      'SELECT status, run_id FROM builds WHERE id = $1',
      [buildId],
    );
    assert.equal(after.rows[0]?.status, 'complete');
    assert.equal(after.rows[0]?.run_id, actualRun);
  });

  it('refuses a transition from the wrong expected status', async () => {
    const projectId = await newProject();
    const buildId = await startBuild(projectId);
    await waitForTerminal(buildId);

    const row = await db.pool.query<{ run_id: string }>('SELECT run_id FROM builds WHERE id = $1', [buildId]);
    const runId = row.rows[0]?.run_id ?? '';

    // Even with the right run, a completed build cannot go back to building.
    const repo2 = new BuildRepository(db.pool);
    const backwards = await repo2.transition({
      id: buildId,
      userId,
      runId,
      expected: 'complete',
      next: 'building',
    });
    assert.equal(backwards, null);

    const after = await db.pool.query<{ status: string }>('SELECT status FROM builds WHERE id = $1', [buildId]);
    assert.equal(after.rows[0]?.status, 'complete');
  });
});

describe('build creation guards', () => {
  it('refuses a second build on a project that already has one running', async () => {
    fake.options = { delayMs: 300 };
    const projectId = await newProject();
    const buildId = await startBuild(projectId);

    const second = await client.post('/api/v1/builds', {
      projectId,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'another prompt entirely',
      apiKey: 'sk-test-build-key',
    });
    assert.equal(second.status, 409);
    assert.match(JSON.stringify(second.body.error.fields), /already has a build/i);

    await client.post(`/api/v1/builds/${buildId}/cancel`);
    await waitForTerminal(buildId);
  });

  it('refuses a model that does not belong to the provider', async () => {
    const projectId = await newProject();
    const res = await client.post('/api/v1/builds', {
      projectId,
      provider: 'openai',
      model: 'gemini-2.5-pro', // real model, wrong provider
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-build-key',
    });

    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body.error.fields), /not available for this provider/i);
  });

  it('refuses a build for a project owned by someone else', async () => {
    const projectId = await newProject();
    const other = new TestClient(testApp.app);
    await other.register('other@example.com', 'correct-horse-battery');

    const res = await other.post('/api/v1/builds', {
      projectId,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-build-key',
    });
    assert.equal(res.status, 404);
  });
});
