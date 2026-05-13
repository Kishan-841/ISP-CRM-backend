import { randomUUID } from 'node:crypto';
import { auditContext } from '../audit/context.js';

// Opens the per-request ALS scope. Must be called AFTER req.user / req.customer
// have been populated by auth.js / customerAuth.js, because the actor fields
// snapshot from those. The auth middlewares invoke this themselves rather
// than us mounting it globally — see those files.
export function attachAuditContext(req, res, next) {
  const actorType =
    req.user     ? 'STAFF' :
    req.customer ? 'CUSTOMER' :
                   'SYSTEM';

  const ctx = {
    actorId:    req.user?.id          ?? req.customer?.customerUserId ?? null,
    actorName:  req.user?.name        ?? req.customer?.name           ?? null,
    actorRole:  req.user?.role        ?? null,
    actorType,
    ipAddress:  req.ip || null,
    userAgent:  req.get('user-agent') ?? null,
    requestId:  req.get('x-request-id') ?? randomUUID(),
    routePath:  req.route?.path       ?? req.originalUrl,
    httpMethod: req.method,
  };
  auditContext.run(ctx, () => next());
}
