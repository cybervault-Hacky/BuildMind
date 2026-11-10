import { createTestDb } from '../tests/helpers/db.js';
import { createTestApp, TestClient } from '../tests/helpers/app.js';

const db = await createTestDb();
const t = await createTestApp({ databaseUrl: db.url });
try {
  const c = new TestClient(t.app);
  const reg = await c.register('smoke@example.com', 'correct-horse-battery');
  console.log('register:', reg.user.email);
  console.log('me:', (await c.get('/api/v1/auth/me')).body.data.authenticated);

  const p = await c.post('/api/v1/projects', { name: 'Arena', description: 'test' });
  console.log('project:', p.status, p.body.data?.project?.id ?? JSON.stringify(p.body));
  const pid = p.body.data.project.id;

  const providers = await c.get('/api/v1/ai/providers');
  console.log('providers:', providers.body.data.providers.map((x:any)=>x.id).join(','));

  const noKey = await c.post('/api/v1/builds', { projectId: pid, provider: 'openai', model: 'gpt-4.1-mini', prompt: 'a wave arena game please' });
  console.log('build without key:', noKey.status, JSON.stringify(noKey.body.error));
  console.log('health:', JSON.stringify((await c.get('/api/v1/health')).body));
} finally {
  await t.close();
  await db.drop();
}
