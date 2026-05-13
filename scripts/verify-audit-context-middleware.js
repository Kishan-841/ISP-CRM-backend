import { attachAuditContext } from '../src/middleware/auditContext.js';
import { auditContext } from '../src/audit/context.js';

function fakeReq({ user, customer, ip = '203.0.113.1', headers = {}, method = 'GET' } = {}) {
  return {
    user, customer, ip, method,
    originalUrl: '/test',
    route: { path: '/test' },
    get: (h) => headers[h.toLowerCase()] ?? null,
  };
}

const results = [];

// 1. Staff path
await new Promise((resolve) => {
  const req = fakeReq({ user: { id: 'u1', name: 'Alice', role: 'SUPER_ADMIN' },
                        headers: { 'user-agent': 'curl/test', 'x-request-id': 'rq-1' } });
  attachAuditContext(req, {}, () => {
    const c = auditContext.getStore();
    results.push({ name: 'staff', ok: c.actorType === 'STAFF' && c.actorId === 'u1' && c.requestId === 'rq-1' && c.userAgent === 'curl/test' && c.ipAddress === '203.0.113.1' });
    resolve();
  });
});

// 2. Customer path
await new Promise((resolve) => {
  const req = fakeReq({ customer: { customerUserId: 'c1', name: 'Bob' } });
  attachAuditContext(req, {}, () => {
    const c = auditContext.getStore();
    results.push({ name: 'customer', ok: c.actorType === 'CUSTOMER' && c.actorId === 'c1' });
    resolve();
  });
});

// 3. No actor (system path)
await new Promise((resolve) => {
  const req = fakeReq();
  attachAuditContext(req, {}, () => {
    const c = auditContext.getStore();
    results.push({ name: 'system', ok: c.actorType === 'SYSTEM' && c.actorId === null });
    resolve();
  });
});

let ok = true;
for (const r of results) {
  console.log(r.ok ? '✅' : '❌', r.name);
  if (!r.ok) ok = false;
}
process.exit(ok ? 0 : 1);
