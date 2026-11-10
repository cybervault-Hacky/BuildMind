/* ==========================================================================
   BuildMind API — server.ts
   Process entry point: load config, build the app, listen, shut down cleanly.

   A missing or invalid environment throws here, before the port opens, and
   the message names the variables without printing their values.
   ========================================================================== */

import { buildApp } from './app.js';
import { loadEnv, EnvError } from './config/env.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      // Names only — never a value.
      console.error(`BuildMind API cannot start.\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const { app, ctx } = await buildApp({ env });

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info({ event: 'server.shutdown', message: signal });
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    ctx.logger.info({ event: 'server.started', status: env.PORT, result: env.NODE_ENV });
  } catch (err) {
    ctx.logger.error({ event: 'server.listen_failed', message: err instanceof Error ? err.message : 'unknown' });
    process.exit(1);
  }
}

void main();
