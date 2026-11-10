/* ==========================================================================
   BuildMind API — tests/providers.test.ts
   The real OpenAI and Google adapters, exercised against local stand-in
   servers.

   What matters here is that the *production adapter code* is what runs:
   header placement, JSON-mode mapping, error normalisation, truncation
   detection, response-size limits and timeouts are all the adapter's own
   logic, not a mock's.

   Google's adapter is tested structurally (request shape) rather than against
   a live endpoint, because this environment cannot reach Google. That is
   stated as a limitation in the report rather than glossed over.
   ========================================================================== */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIProvider } from '../src/providers/ai/openai/openaiProvider.js';
import { GoogleProvider } from '../src/providers/ai/google/googleProvider.js';
import { AppError } from '../src/errors/AppError.js';
import { FakeOpenAI } from './helpers/fakeOpenAI.js';

const fake = new FakeOpenAI();
let openai: OpenAIProvider;
let google: GoogleProvider;

/** A stand-in for the Gemini API that records what the adapter sent. */
class FakeGoogle {
  private server: Server | null = null;
  url = '';
  requests: Array<{ path: string; apiKeyHeader: string; query: string; body: unknown }> = [];
  modelsStatus = 200;
  generateStatus = 200;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        this.requests.push({
          path: url.pathname,
          apiKeyHeader: String(req.headers['x-goog-api-key'] ?? ''),
          query: url.search,
          body,
        });

        const send = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (url.pathname.endsWith('/models')) {
          if (this.modelsStatus !== 200) return send(this.modelsStatus, { error: {} });
          return send(200, {
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
            ],
          });
        }

        if (url.pathname.includes(':generateContent')) {
          if (this.generateStatus !== 200) return send(this.generateStatus, { error: {} });
          return send(200, {
            candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
          });
        }

        return send(404, {});
      });
    });

    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', () => resolve()));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const googleFake = new FakeGoogle();

before(async () => {
  await fake.start();
  await googleFake.start();
  openai = new OpenAIProvider(fake.url);
  google = new GoogleProvider(googleFake.url);
});

after(async () => {
  await fake.stop();
  await googleFake.stop();
});

const byok = (key: string) => ({ apiKey: key, source: 'byok' as const });

describe('OpenAI adapter', () => {
  it('validates a key with a real request and reports the model count', async () => {
    fake.reset();
    const result = await openai.validateCredentials(byok('sk-test-key'));

    assert.equal(result.valid, true);
    // It used GET /models: no tokens spent.
    assert.ok(fake.requests.some((r) => r.path.endsWith('/models')));
    assert.ok(!fake.requests.some((r) => r.path.includes('chat/completions')));
  });

  it('sends the key in an Authorization header and never in the URL', async () => {
    fake.reset();
    await openai.validateCredentials(byok('sk-test-header-check'));

    for (const request of fake.requests) {
      assert.ok(!request.path.includes('sk-test'), 'the key must not appear in a URL');
      assert.match(request.authorization, /^Bearer sk-test-header-check$/);
    }
  });

  it('reports a rejected key as invalid, not as an error to the caller', async () => {
    fake.reset();
    fake.modelsStatus = 401;
    const result = await openai.validateCredentials(byok('sk-test-bad'));
    assert.equal(result.valid, false);
    assert.match(String(result.detail), /rejected/i);
  });

  it('reports an unreachable provider as unavailable', async () => {
    // A port nothing is listening on.
    const dead = new OpenAIProvider('http://127.0.0.1:1');
    const result = await dead.validateCredentials(byok('sk-test-key'));
    assert.equal(result.valid, false);
    assert.match(String(result.detail), /not reachable|did not answer/i);
  });

  it('maps a 429 to PROVIDER_RATE_LIMITED', async () => {
    fake.reset();
    fake.options = { failChatWith: 429 };
    await assert.rejects(
      () => openai.generate(byok('sk-test-key'), { model: 'gpt-4.1-mini', system: 's', user: 'u', json: true }),
      (err: unknown) => err instanceof AppError && err.code === 'PROVIDER_RATE_LIMITED',
    );
  });

  it('maps a 503 to PROVIDER_UNAVAILABLE', async () => {
    fake.reset();
    fake.options = { failChatWith: 503 };
    await assert.rejects(
      () => openai.generate(byok('sk-test-key'), { model: 'gpt-4.1-mini', system: 's', user: 'u', json: true }),
      (err: unknown) => err instanceof AppError && err.code === 'PROVIDER_UNAVAILABLE',
    );
  });

  it('requests JSON mode and returns parsed-ready text', async () => {
    fake.reset();
    const result = await openai.generate(byok('sk-test-key'), {
      model: 'gpt-4.1-mini',
      system: 'be brief',
      user: 'hello',
      json: true,
    });

    const sent = fake.requests.find((r) => r.path.includes('chat/completions'));
    assert.ok(sent);
    assert.deepEqual((sent.body as { response_format?: unknown }).response_format, { type: 'json_object' });
    // The fake returns a canned stage response; what matters is that the
    // adapter parsed a string out of choices[0].message.content.
    assert.equal(typeof result.text, 'string');
    assert.ok(result.text.length > 0);
    assert.doesNotThrow(() => JSON.parse(result.text), 'the adapter should return parseable JSON here');
    assert.equal(result.usage.inputTokens, 42);
  });

  it('flags a truncated response so the caller can reject it', async () => {
    fake.reset();
    fake.options = { truncated: true };
    const result = await openai.generate(byok('sk-test-key'), {
      model: 'gpt-4.1-mini',
      system: 's',
      user: 'u',
      json: true,
    });
    assert.equal(result.truncated, true);
  });

  it('refuses to generate for a model that is not in the registry', async () => {
    await assert.rejects(
      () => openai.generate(byok('sk-test-key'), { model: 'not-a-real-model', system: 's', user: 'u', json: true }),
      (err: unknown) => err instanceof AppError && err.code === 'CONFIGURATION_ERROR',
    );
  });

  it('does not send temperature for a model that rejects it', async () => {
    fake.reset();
    await openai.generate(byok('sk-test-key'), {
      model: 'o4-mini',
      system: 's',
      user: 'u',
      json: true,
      temperature: 0.7,
    });
    const sent = fake.requests.find((r) => r.path.includes('chat/completions'));
    const body = sent?.body as { temperature?: number; model?: string };
    assert.equal(body.model, 'o4-mini');
    assert.equal(body.temperature, undefined);
  });

  it('normalises a non-JSON body rather than leaking a parse error', async () => {
    // A server that returns HTML with a 200.
    const raw = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not json</html>');
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', () => resolve()));
    const port = (raw.address() as AddressInfo).port;

    try {
      const provider = new OpenAIProvider(`http://127.0.0.1:${port}`);
      await assert.rejects(
        () => provider.generate(byok('sk-test-key'), { model: 'gpt-4.1-mini', system: 's', user: 'u', json: true }),
        (err: unknown) => err instanceof AppError && err.code === 'PROVIDER_INVALID_OUTPUT',
      );
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });
});

describe('Google adapter', () => {
  it('sends the key in x-goog-api-key, never in the query string', async () => {
    googleFake.requests.length = 0;
    await google.validateCredentials(byok('AIza-test-key'));

    const request = googleFake.requests[0];
    assert.ok(request);
    assert.equal(request.apiKeyHeader, 'AIza-test-key');
    // This is the point: Google documents ?key= but we do not use it.
    assert.ok(!request.query.includes('key='), 'the key must not be a query parameter');
  });

  it('maps generation to :generateContent and normalises the response', async () => {
    googleFake.requests.length = 0;
    const result = await google.generate(byok('AIza-test-key'), {
      model: 'gemini-2.5-flash',
      system: 's',
      user: 'u',
      json: true,
    });

    const sent = googleFake.requests.find((r) => r.path.includes(':generateContent'));
    assert.ok(sent, 'the adapter should call :generateContent');
    assert.match(sent.path, /gemini-2\.5-flash:generateContent/);

    const body = sent.body as { generationConfig?: { responseMimeType?: string } };
    assert.equal(body.generationConfig?.responseMimeType, 'application/json');

    assert.equal(result.text, '{"ok":true}');
    assert.equal(result.usage.inputTokens, 5);
    assert.equal(result.usage.outputTokens, 7);
  });

  it('filters to models that support generateContent', async () => {
    googleFake.requests.length = 0;
    const models = await google.listModels(byok('AIza-test-key'));
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes('gemini-2.5-flash'));
    assert.ok(!ids.includes('embedding-001'));
  });

  it('maps a rejected key to an invalid validation result', async () => {
    googleFake.modelsStatus = 401;
    try {
      const result = await google.validateCredentials(byok('AIza-bad'));
      assert.equal(result.valid, false);
    } finally {
      googleFake.modelsStatus = 200;
    }
  });
});

describe('timeouts', () => {
  it('fails with PROVIDER_TIMEOUT rather than hanging', async () => {
    // A server that accepts the connection and never answers.
    const silent = createServer(() => {
      /* deliberately never responds */
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const port = (silent.address() as AddressInfo).port;

    try {
      const provider = new OpenAIProvider(`http://127.0.0.1:${port}`);
      const started = Date.now();
      await assert.rejects(
        () =>
          provider.generate(byok('sk-test-key'), {
            model: 'gpt-4.1-mini',
            system: 's',
            user: 'u',
            json: true,
            signal: AbortSignal.timeout(300),
          }),
        (err: unknown) => err instanceof AppError && (err.code === 'PROVIDER_TIMEOUT' || err.code === 'PROVIDER_UNAVAILABLE'),
      );
      // It must not wait the full default minute.
      assert.ok(Date.now() - started < 5000, 'the timeout should be bounded by the signal');
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
