import { FixPlanSchema, GenerationSchema } from '../src/validation/schemas.js';
const noDiag = { artifacts: [{ path:'Main.luau', type:'script', content:'-- draft', metadata:{} }] };
console.log('fix without diagnosis:', FixPlanSchema.safeParse(noDiag).success);
const OK = { diagnosis: 'x', artifacts: [{ path:'Main.luau', type:'script', content:'-- draft', metadata:{} }] };
console.log('fix with diagnosis:', FixPlanSchema.safeParse(OK).success);
console.log('generation:', GenerationSchema.safeParse(noDiag).success);
