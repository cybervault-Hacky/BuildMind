import { BUILD_STATUSES, canTransition, isActive } from '../src/services/builds/stateMachine.js';
let bad = 0;
for (const s of BUILD_STATUSES.filter(isActive)) {
  if (!canTransition(s, 'cancelled')) { console.log('CANNOT CANCEL FROM', s); bad++; }
  if (!canTransition(s, 'failed')) { console.log('CANNOT FAIL FROM', s); bad++; }
}
console.log(bad === 0 ? 'ALL ACTIVE STATES CAN REACH A TERMINAL STATE' : `FAILURES ${bad}`);
