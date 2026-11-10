import { createTestDb } from '../tests/helpers/db.js';
import { createTestApp, TestClient } from '../tests/helpers/app.js';
import { FakeOpenAI } from '../tests/helpers/fakeOpenAI.js';

const fake = new FakeOpenAI(); await fake.start();
const db = await createTestDb();
const t = await createTestApp({ databaseUrl: db.url, envOverrides: { OPENAI_BASE_URL: fake.url } });
try {
  const c = new TestClient(t.app);
  await c.register('dbg@example.com','correct-horse-battery');
  const p = await c.post('/api/v1/projects', { name: 'A' });
  const pid = p.body.data.project.id;
  const b = await c.post('/api/v1/builds', { projectId: pid, provider:'openai', model:'gpt-4.1-mini', prompt:'a wave survival arena game', apiKey:'sk-test-key-1234567890' });
  console.log('create:', b.status, b.body.ok ? b.body.data.build.id : JSON.stringify(b.body));
  const bid = b.body.data.build.id;
  for (let i=0;i<60;i++) {
    const r = await c.get(`/api/v1/builds/${bid}`);
    const st = r.body.data.build;
    if (['complete','failed','cancelled'].includes(st.status)) { console.log('final:', st.status, st.errorCode, st.errorMessageSafe); break; }
    await new Promise(r=>setTimeout(r,100));
  }
  const ev = await c.get(`/api/v1/builds/${bid}/events`);
  console.log('events:', (ev.body.data.events as any[]).map(e=>`${e.seq}:${e.stage}:${e.status}:${e.activity}`).join('\n  '));
  console.log('chat calls:', fake.chatCount);
  console.log('systems sent:', fake.requests.filter(r=>r.path.includes('chat')).map((r:any)=>r.body?.messages?.[0]?.content?.slice(0,40)));
} finally { await t.close(); await db.drop(); await fake.stop(); }
