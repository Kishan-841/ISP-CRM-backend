import { Prisma } from '@prisma/client';
import { AUDITED_MODELS } from './auditedModels.js';
import { writeAuditEvent } from './writer.js';

// Wraps Prisma's create/update/delete so audited-model writes emit one
// audit_events row per operation. updateMany / deleteMany are NOT covered
// in v1 — add explicit writeAuditEvent calls at the call site when needed.
//
// We use Prisma.defineExtension((client) => ...) so the extended client is
// captured in closure. This is Prisma's documented pattern for extensions
// that need to issue nested queries — `this` inside query callbacks is an
// internal chain object, NOT the client, so we can't use `this.lead.findUnique`.
// The closure-captured `client` is the fully-extended Prisma client, so
// nested reads/writes route through the same extension stack.
export const auditExtension = Prisma.defineExtension((client) => {
  // Read the current state of a record before mutation. For Lead we include
  // campaignData so entityLabelFor can build a "Company · lead-XXXXX" label.
  // Other models don't need a nested relation for their label.
  async function fetchBefore(model, where) {
    if (model === 'Lead') {
      return client.lead.findUnique({
        where,
        include: { campaignData: { select: { company: true } } },
      });
    }
    const delegateName = model[0].toLowerCase() + model.slice(1);
    return client[delegateName].findUnique({ where });
  }

  return client.$extends({
    name: 'audit',
    query: {
      $allModels: {
        async create({ model, args, query }) {
          const result = await query(args);
          if (AUDITED_MODELS.has(model)) {
            await writeAuditEvent({ model, action: 'CREATE', after: result });
          }
          return result;
        },

        async update({ model, args, query }) {
          let before = null;
          if (AUDITED_MODELS.has(model)) {
            before = await fetchBefore(model, args.where);
          }
          const result = await query(args);
          if (before) {
            const after = model === 'Lead'
              ? await fetchBefore(model, { id: result.id })
              : result;
            await writeAuditEvent({ model, action: 'UPDATE', before, after });
          }
          return result;
        },

        async delete({ model, args, query }) {
          let before = null;
          if (AUDITED_MODELS.has(model)) {
            before = await fetchBefore(model, args.where);
          }
          const result = await query(args);
          if (before) {
            await writeAuditEvent({ model, action: 'DELETE', before });
          }
          return result;
        },
      },
    },
  });
});
