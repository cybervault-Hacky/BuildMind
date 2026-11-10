import { FixPlanSchema } from '../src/validation/schemas.js';
const good = {
  diagnosis: 'Restored the missing manifest and server script.',
  artifacts: [
    { path:'Main.luau', type:'script', content:'-- x', metadata:{} },
    { path:'default.project.json', type:'manifest', content:'{"name":"x"}', metadata:{} },
  ],
};
const r = FixPlanSchema.safeParse(good);
console.log('fix parse:', r.success, r.success ? '' : JSON.stringify(r.error.issues));
