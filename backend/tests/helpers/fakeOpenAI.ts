/* ==========================================================================
   BuildMind API — tests/helpers/fakeOpenAI.ts
   A local HTTP server that speaks just enough of the OpenAI API for the *real*
   OpenAIProvider adapter to talk to it.

   Why this instead of a mock provider class: the adapter is production code.
   Pointing it at a local server exercises its actual request shape, header
   handling, JSON-mode mapping, response parsing, truncation detection and
   error normalisation. A hand-written mock would bypass all of that and let a
   regression in the adapter pass unnoticed.

   The server never sees a real secret: the tests use sk-test- keys.
   ========================================================================== */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOpenAIOptions {
  /** Fail the next N chat completions with this status. */
  failChatWith?: number;
  /** Return this raw string as the completion content. */
  contentOverride?: string;
  /** Delay each chat completion. */
  delayMs?: number;
  /** Report truncation via finish_reason. */
  truncated?: boolean;
  /**
   * Per-call override. Receives the system prompt and the 1-based chat call
   * index, and may return content, or a status code to fail with.
   */
  onChat?: (system: string, callIndex: number) => { content?: string; status?: number } | null;
}

interface Recorded {
  path: string;
  authorization: string;
  body: unknown;
}

export class FakeOpenAI {
  private server: Server | null = null;
  private chatCalls = 0;
  public url = '';
  public readonly requests: Recorded[] = [];
  public options: FakeOpenAIOptions = {};
  /** Set to make /models reject, simulating a bad key. */
  public modelsStatus = 200;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }

        this.requests.push({
          path: req.url ?? '',
          authorization: String(req.headers.authorization ?? ''),
          body: parsed,
        });

        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (req.url?.endsWith('/models')) {
          if (this.modelsStatus !== 200) {
            respond(this.modelsStatus, { error: { message: 'unauthorized' } });
            return;
          }
          respond(200, {
            data: [
              { id: 'gpt-4.1-mini' },
              { id: 'gpt-4.1' },
              { id: 'o4-mini' },
              { id: 'not-a-buildmind-model' },
            ],
          });
          return;
        }

        if (req.url?.endsWith('/chat/completions')) {
          this.chatCalls += 1;
          const callIndex = this.chatCalls;

          const finish = (): void => {
            if (this.options.failChatWith) {
              respond(this.options.failChatWith, { error: { message: 'provider failure' } });
              return;
            }
            const body = (parsed ?? {}) as {
              messages?: Array<{ role: string; content: string }>;
              model?: string;
            };
            const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';

            const hooked = this.options.onChat?.(system, callIndex) ?? null;
            if (hooked?.status) {
              respond(hooked.status, { error: { message: 'scripted failure' } });
              return;
            }

            const content = hooked?.content ?? this.options.contentOverride ?? cannedResponse(system);
            respond(200, {
              model: body.model ?? 'gpt-4.1-mini',
              choices: [
                {
                  message: { content },
                  finish_reason: this.options.truncated ? 'length' : 'stop',
                },
              ],
              usage: { prompt_tokens: 42, completion_tokens: 84 },
            });
          };

          if (this.options.delayMs) setTimeout(finish, this.options.delayMs);
          else finish();
          return;
        }

        respond(404, { error: { message: 'not found' } });
      });
    });

    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  reset(): void {
    this.requests.length = 0;
    this.options = {};
    this.modelsStatus = 200;
    this.chatCalls = 0;
  }

  /** How many chat completions have been requested since the last reset. */
  get chatCount(): number {
    return this.chatCalls;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }
}

/** Shape-correct JSON per stage, matching the real prompts. */
export function cannedResponse(system: string): string {
  const lower = system.toLowerCase();

  if (lower.includes('specification stage')) {
    return JSON.stringify({
      name: 'Test Arena',
      genre: 'arena',
      coreLoop: 'Players survive waves in a shrinking arena.',
      mechanics: ['melee combat', 'wave spawning'],
      systems: ['wave manager'],
      map: 'Arena floor with raised edges.',
      playerExperience: 'Fast, readable combat.',
      assets: [],
      scripts: ['Main.luau'],
      dependencies: [],
      validationRules: ['a server script exists'],
    });
  }

  if (lower.includes('planning stage')) {
    return JSON.stringify({
      summary: 'Build a wave arena with one server script and a manifest.',
      steps: [{ title: 'Create the arena', detail: 'Floor, walls, spawn points' }],
      files: ['Main.luau', 'default.project.json'],
    });
  }

  // Checked before "construction stage": the repair prompt references it.
  if (lower.includes('repair stage')) {
    return JSON.stringify({
      diagnosis: 'Restored the missing manifest and server script.',
      artifacts: goodArtifacts(),
    });
  }

  return JSON.stringify({ artifacts: goodArtifacts() });
}

/** A set of artifacts that passes every real validation check. */
export function goodArtifacts(): Array<{
  path: string;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
}> {
  return [
    {
      path: 'Main.luau',
      type: 'script',
      content: '-- BuildMind generated server script\nprint("arena ready")\n',
      metadata: {},
    },
    {
      path: 'default.project.json',
      type: 'manifest',
      content: JSON.stringify({ name: 'TestArena', tree: { $className: 'DataModel' } }),
      metadata: {},
    },
  ];
}
