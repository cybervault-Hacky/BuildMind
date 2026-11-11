/* ==========================================================================
   BuildMind API — routes/index.ts
   Mounts every route group under /api/v1.
   ========================================================================== */

import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../config/constants.js';
import type { AppContext } from '../context.js';
import { aiRoutes } from './ai.routes.js';
import { authRoutes } from './auth.routes.js';
import { buildRoutes } from './builds.routes.js';
import { healthRoutes } from './health.routes.js';
import { projectRoutes } from './projects.routes.js';
import { robloxRoutes } from './roblox.routes.js';

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Versioned: a future v2 can coexist without breaking a deployed frontend.
  await app.register(
    async (scope) => {
      await healthRoutes(scope, ctx);
      await authRoutes(scope, ctx);
      await projectRoutes(scope, ctx);
      await buildRoutes(scope, ctx);
      await aiRoutes(scope, ctx);
      await robloxRoutes(scope, ctx);
    },
    { prefix: API_PREFIX },
  );
}
