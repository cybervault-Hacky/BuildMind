/* ==========================================================================
   BuildMind — standalone fake OpenAI endpoint for the browser E2E run.

   The E2E needs a build to actually reach its terminal state, which means the
   real OpenAI adapter must actually be exercised. This sandbox has no outbound
   egress, so the request is pointed at this local server by setting
   OPENAI_BASE_URL. The adapter, the orchestrator, the state machine, the
   validation gates and the database are all real — only the remote endpoint is
   local.

   This is a test double, not a product path. Nothing in src/ knows it exists.
   ========================================================================== */

import { writeFileSync } from 'node:fs';
import { FakeOpenAI } from './fakeOpenAI.js';

const server = new FakeOpenAI();
// Options are assigned after construction, which is the class's API.
// A short delay keeps a build running long enough to be cancelled in step 5.
server.options = {
  delayMs: 60,
  // Only the E2E's well-formed stand-in key is accepted, so the "invalid key"
  // case is a genuine rejection from the endpoint rather than a fiction.
  acceptKeyPattern: /^sk-valid-/,
};

await server.start();

/*
  The port is ephemeral, so the URL is published to a file the launcher reads
  before starting the backend. That keeps the two processes in step without a
  fixed port that could collide.
*/
const target = process.env.FAKE_URL_FILE ?? '/tmp/fake-openai-url.txt';
writeFileSync(target, server.url, 'utf8');
console.log(`fake OpenAI listening at ${server.url} (written to ${target})`);

process.on('SIGTERM', () => {
  void server.stop().then(() => process.exit(0));
});
