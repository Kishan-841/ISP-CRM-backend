import { auditContext } from '../src/audit/context.js';

const store = { actorId: 'u1', ipAddress: '1.2.3.4' };

await auditContext.run(store, async () => {
  await new Promise(r => setImmediate(r));
  const got = auditContext.getStore();
  const ok = got?.actorId === 'u1' && got?.ipAddress === '1.2.3.4';
  console.log(ok ? '✅ ALS propagates across async boundary' : '❌ context lost');
  process.exit(ok ? 0 : 1);
});
