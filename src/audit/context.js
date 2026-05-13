import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request audit context. Populated by middleware/auditContext.js on every
// HTTP request; read by audit/writer.js and audit/prismaExtension.js so that
// every audited write knows who did it, from where, and via which route —
// without forcing controllers to pass req through every helper call.
export const auditContext = new AsyncLocalStorage();
