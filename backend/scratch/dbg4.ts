import { createTestDb } from '../tests/helpers/db.js';
import { createTestApp, TestClient } from '../tests/helpers/app.js';
import { FakeOpenAI } from '../tests/helpers/fakeOpenAI.js';

const fake = new FakeOpenAI(); await fake.start();
const db = await createTestDb();
const t = await createTestApp({ databaseUrl: db.url, envOverrides: { OPENAI_BASE_URL: fake.url } });
try {
  const c = new TestClient(t.app);
  await c.register('dbg4@example.com','correct-horse-battery');
  const p = await c.post('/api/v1/projects', { name: 'A' });
  fake.options = { onChat: (system) => {
    const l = system.toLowerCase();
    if (l.includes('repair stage') || l.includes('construction stage'))
      return { content: JSON.stringify({ artifacts: [{ path:'Main.luau', type:'script', content:'-- draft', metadata:{} }] }) };
    return null;
  }};
  const b = await c.post('/api/v1/builds', { projectId: p.body.data.project.id, provider:'openai', model:'gpt-4.1-mini', prompt:'a wave survival arena game', apiKey:'sk-test-key-1234567890' });
  const bid = b.body.data.build.id;
  for (let i=0;i<100;i++){ const r=await c.get(`/api/v1/builds/${bid}`); if(['complete','failed','cancelled'].includes(r.body.data.build.status)){console.log('FINAL:',r.body.data.build.status, r.body.data.build.errorCode);break;} await new Promise(r=>setTimeout(r,60)); }
  const ev = await c.get(`/api/v1/builds/${bid}/events`);
  console.log((ev.body.data.events as any[]).map(e=>`${e.seq}:${e.stage}:${e.activity.slice(0,50)}`).join('\n'));
  console.log('chatCount:', fake.chatCount);
} finally { await t.close(); await db.drop(); await fake.stop(); }
