/* ==========================================================================
   BuildMind API — scripts/run-tests.ts
   Runs every backend suite in sequence and prints one honest summary.

   Why a runner rather than `node --test tests/*.test.ts`:
     * suites share one PostgreSQL server, and running them in parallel makes
       the failure output interleave past the point of being readable
     * each suite provisions and drops its own schema, which is slower but
       isolates failures
     * the summary must include the count of *skipped/external* tests, so a
       green run cannot hide an untested integration

   Exit code is 1 if any suite fails, so CI can gate on it.
   ========================================================================== */

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TESTS = join(ROOT, 'tests');

interface SuiteResult {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  ok: boolean;
}

function parseCount(output: string, label: string): number {
  const match = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(output);
  return match?.[1] ? Number(match[1]) : 0;
}

async function main(): Promise<void> {
  if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
    console.error('TEST_DATABASE_URL must point at a PostgreSQL server.');
    process.exit(1);
  }

  const files = (await readdir(TESTS)).filter((f) => f.endsWith('.test.ts')).sort();
  const results: SuiteResult[] = [];

  for (const file of files) {
    const started = Date.now();
    const run = spawnSync('npx', ['tsx', '--test', join('tests', file)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
      timeout: 300_000,
    });

    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const passed = parseCount(output, 'pass');
    const failed = parseCount(output, 'fail');
    const skipped = parseCount(output, 'skipped');
    const durationMs = Date.now() - started;
    const ok = (run.status ?? 1) === 0 && failed === 0;

    results.push({ file, passed, failed, skipped, durationMs, ok });

    const marker = ok ? 'PASS' : 'FAIL';
    console.log(
      `${marker}  ${file.padEnd(26)} ${String(passed).padStart(3)} passed` +
        `${failed ? `, ${failed} failed` : ''}` +
        `${skipped ? `, ${skipped} skipped` : ''}` +
        `  (${(durationMs / 1000).toFixed(1)}s)`,
    );

    if (!ok) {
      // Show the failing subtests only, not the whole log.
      const failing = output
        .split('\n')
        .filter((line) => line.trim().startsWith('not ok'))
        .slice(0, 20)
        .join('\n');
      if (failing) console.log(failing);
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      passed: acc.passed + r.passed,
      failed: acc.failed + r.failed,
      skipped: acc.skipped + r.skipped,
      duration: acc.duration + r.durationMs,
    }),
    { passed: 0, failed: 0, skipped: 0, duration: 0 },
  );

  console.log('');
  console.log(`suites:   ${results.length}`);
  console.log(`passed:   ${totals.passed}`);
  console.log(`failed:   ${totals.failed}`);
  console.log(`skipped:  ${totals.skipped}`);
  console.log(`duration: ${(totals.duration / 1000).toFixed(1)}s`);

  const failedSuites = results.filter((r) => !r.ok).map((r) => r.file);
  if (failedSuites.length) {
    console.log(`\nfailing suites: ${failedSuites.join(', ')}`);
    process.exit(1);
  }
}

await main();
