/* ==========================================================================
   BuildMind API — context.ts
   The composition root's output: every service, constructed once.

   Routes receive this object rather than importing singletons. That is what
   makes a test able to build a fully isolated app against its own database
   and its own provider registry, with no module-level state shared between
   test files.
   ========================================================================== */

import type { Env } from './config/env.js';
import type { AuthService } from './services/auth/authService.js';
import type { ProjectService } from './services/projects/projectService.js';
import type { BuildService } from './services/builds/buildService.js';
import type { BuildOrchestrator } from './services/builds/buildOrchestrator.js';
import type { CredentialService } from './services/ai/credentialService.js';
import type { RobloxService } from './services/roblox/robloxService.js';
import type { StudioBridge } from './services/studio/studioBridge.js';
import type { ProviderRegistry } from './providers/ai/registry.js';
import type { BuildEventBus } from './events/buildEventBus.js';
import type { WorkspaceManager } from './workspace/workspaceManager.js';
import type { Logger } from './utils/logger.js';
import type { CleanupService } from './jobs/cleanupService.js';
import type pg from 'pg';

export interface AppContext {
  env: Env;
  logger: Logger;
  pool: pg.Pool;
  auth: AuthService;
  projects: ProjectService;
  builds: BuildService;
  orchestrator: BuildOrchestrator;
  credentials: CredentialService;
  roblox: RobloxService;
  studio: StudioBridge;
  providers: ProviderRegistry;
  bus: BuildEventBus;
  workspace: WorkspaceManager;
  cleanup: CleanupService;
}
