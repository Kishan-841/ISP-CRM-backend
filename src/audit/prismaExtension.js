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

  // Pre-read all rows matching a `where` for bulk operations. Same enrichment
  // logic as fetchBefore: include campaignData.company for Lead so the audit
  // label resolves to "Company · lead-XXXXX". Other models use a plain findMany.
  async function fetchManyForAudit(model, where) {
    if (model === 'Lead') {
      return client.lead.findMany({
        where,
        include: { campaignData: { select: { company: true } } },
      });
    }
    const delegateName = model[0].toLowerCase() + model.slice(1);
    return client[delegateName].findMany({ where });
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

        // Bulk insert. Postgres createMany doesn't return rows, only a count,
        // so we can't capture generated IDs. We write one CREATE audit row per
        // *input* record using the input as the snapshot. entityId will be
        // null for these rows since the DB-assigned id is unknown.
        //
        // With skipDuplicates: true, the audit count may exceed the actual
        // insert count. Acceptable — the audit rows reflect intent.
        async createMany({ model, args, query }) {
          const result = await query(args);
          if (!AUDITED_MODELS.has(model)) return result;

          const dataArray = Array.isArray(args.data)
            ? args.data
            : [args.data].filter(Boolean);
          for (const item of dataArray) {
            await writeAuditEvent({ model, action: 'CREATE', after: item });
          }
          return result;
        },

        // Bulk update. Prisma's updateMany returns only a count, so we
        // pre-read the affected rows, run the query, and synthesize each
        // `after` by applying the patch (args.data) on top of the `before`.
        // This is accurate for our schema (no triggers / generated columns
        // on audited models) and saves N round-trips vs refetching.
        async updateMany({ model, args, query }) {
          if (!AUDITED_MODELS.has(model)) return query(args);

          const beforeRows = await fetchManyForAudit(model, args.where);
          const result = await query(args);

          for (const before of beforeRows) {
            const after = { ...before, ...args.data };
            await writeAuditEvent({ model, action: 'UPDATE', before, after });
          }
          return result;
        },

        // Bulk delete. Pre-read affected rows for snapshots, then delete.
        async deleteMany({ model, args, query }) {
          if (!AUDITED_MODELS.has(model)) return query(args);

          const beforeRows = await fetchManyForAudit(model, args.where);
          const result = await query(args);

          for (const before of beforeRows) {
            await writeAuditEvent({ model, action: 'DELETE', before });
          }
          return result;
        },

        // Upsert. We pre-read by `where` to determine intent:
        //   - row exists → this is an UPDATE; audit with before/after diff
        //   - row missing → this is a CREATE; audit with the new row as `after`
        // For Lead, refetch `after` with campaignData included so the label
        // resolves correctly.
        async upsert({ model, args, query }) {
          if (!AUDITED_MODELS.has(model)) return query(args);

          const before = await fetchBefore(model, args.where);
          const result = await query(args);

          const after = model === 'Lead'
            ? await fetchBefore(model, { id: result.id })
            : result;

          if (before) {
            await writeAuditEvent({ model, action: 'UPDATE', before, after });
          } else {
            await writeAuditEvent({ model, action: 'CREATE', after });
          }
          return result;
        },
      },
    },
  });
});
