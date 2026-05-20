import crypto from 'node:crypto';
import prisma from '../config/db.js';
import { notifyAllByRole } from '../services/notification.service.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';

// Inbound webhook receiver for SAM-originated events. SAM signs the body with
// the shared SAM_WEBHOOK_SECRET (symmetric — same secret CRM uses outbound for
// customer.activated). Each handler verifies signature + timestamp skew first,
// then dedupes on eventId before any state mutation.
//
// Notes for whoever reads this next:
//   - req.rawBody is the literal request bytes — set by express.json's `verify`
//     hook in index.js. We MUST sign over the same bytes SAM signed; reusing
//     JSON.stringify(req.body) would re-serialise with our key order and break
//     the HMAC for any non-trivial payload.
//   - 4xx responses are permanent failures from SAM's perspective; their
//     retry layer mirrors ours (4xx = stop, 5xx = backoff).

const MAX_TIMESTAMP_SKEW_SEC = 5 * 60;

// GET /api/webhooks/sam/ping
//
// Unauthenticated reachability probe for SAM-side integration testing. Lets
// them confirm DNS / TLS / routing to this endpoint family without involving
// signatures or payload shape. Returns the CRM server time so SAM can also
// sanity-check clock drift before signing real requests.
export const ping = (_req, res) => {
  res.json({
    ok: true,
    service: 'crm-sam-webhook-receiver',
    serverTime: new Date().toISOString(),
    serverUnix: Math.floor(Date.now() / 1000),
    secretConfigured: envConfigured(),
    acceptedEvents: ['quickDisconnect.requested'],
  });
};

function envConfigured() {
  return Boolean(process.env.SAM_WEBHOOK_SECRET);
}

function verifySignature(rawBody, timestamp, signatureHeader) {
  if (!signatureHeader || !timestamp) return false;
  const expected = crypto
    .createHmac('sha256', process.env.SAM_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  // timingSafeEqual throws if lengths differ — guard explicitly first.
  if (expected.length !== signatureHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

function timestampInWindow(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.abs(nowSec - ts) <= MAX_TIMESTAMP_SKEW_SEC;
}

// POST /api/webhooks/sam/quick-disconnect.requested
//
// Body (verified-then-parsed):
//   {
//     eventId, eventType, occurredAt, commercialChangeId,
//     customer: { externalId },
//     raisedBy: { id, email },
//     reason,
//     requested?: { arc, planName, bandwidth }
//   }
export const receiveQuickDisconnectRequested = async (req, res) => {
  // Every inbound request gets a one-line trace so we can diagnose
  // "SAM says sent, CRM inbox empty" without scraping a separate log
  // store. The body is logged truncated; signature header is masked.
  const TAG = '[QuickDisconnect inbound]';
  const trace = (...args) => console.log(TAG, ...args);

  if (!envConfigured()) {
    trace('REJECT 503: SAM_WEBHOOK_SECRET not set');
    return res.status(503).json({ message: 'Webhook receiver not configured.' });
  }

  const signature = req.header('x-sam-signature');
  const timestamp = req.header('x-sam-timestamp');
  const rawBody = req.rawBody || '';
  const bodyPreview = rawBody.slice(0, 500);
  trace(`hit: sig=${signature ? signature.slice(0, 8) + '…' : 'MISSING'} ts=${timestamp || 'MISSING'} bodyBytes=${rawBody.length}`);

  if (!verifySignature(rawBody, timestamp, signature)) {
    trace(`REJECT 401: bad signature. bodyPreview=${bodyPreview}`);
    return res.status(401).json({ message: 'Invalid signature.' });
  }
  if (!timestampInWindow(timestamp)) {
    const nowSec = Math.floor(Date.now() / 1000);
    trace(`REJECT 401: timestamp skew. their_ts=${timestamp} our_ts=${nowSec} drift_sec=${nowSec - Number(timestamp)}`);
    return res.status(401).json({ message: 'Timestamp outside allowed skew.' });
  }

  const payload = req.body || {};

  // Shape check — everything below assumes these fields exist. Missing →
  // permanent 400 (SAM should fix the payload, not retry).
  const eventId = payload.eventId;
  const commercialChangeId = payload.commercialChangeId;
  const externalId = payload.customer?.externalId;
  const reason = payload.reason;
  // Category fields are now part of the QUICK payload — CRM auto-creates the
  // ServiceOrder at admin approval (spec §4.4) and the SO controller requires
  // both ids. Reject up front rather than failing later in the approve path.
  const disconnectionCategoryId = payload.disconnectionCategoryId;
  const disconnectionSubCategoryId = payload.disconnectionSubCategoryId;
  if (!eventId || !commercialChangeId || !externalId || !reason?.trim()
      || !disconnectionCategoryId || !disconnectionSubCategoryId) {
    trace(`REJECT 400: missing fields. eventId=${!!eventId} commercialChangeId=${!!commercialChangeId} externalId=${!!externalId} reason=${!!reason?.trim()} categoryId=${!!disconnectionCategoryId} subCategoryId=${!!disconnectionSubCategoryId}`);
    return res.status(400).json({
      message: 'Missing required fields: eventId, commercialChangeId, customer.externalId, reason, disconnectionCategoryId, disconnectionSubCategoryId.',
    });
  }
  if (payload.eventType && payload.eventType !== 'quickDisconnect.requested') {
    trace(`REJECT 400: bad eventType=${payload.eventType}`);
    return res.status(400).json({ message: `Unexpected eventType: ${payload.eventType}` });
  }

  // Validate category pair against existing tables — same rules as
  // createServiceOrder so a mistyped slug is caught at SAM-side raise time,
  // not later when admin tries to approve and the SO create blows up.
  const subCategory = await prisma.disconnectionSubCategory.findFirst({
    where: {
      id: disconnectionSubCategoryId,
      categoryId: disconnectionCategoryId,
      isActive: true,
      category: { isActive: true },
    },
    select: { id: true },
  });
  if (!subCategory) {
    trace(`REJECT 400: invalid category pair categoryId=${disconnectionCategoryId} subCategoryId=${disconnectionSubCategoryId}`);
    return res.status(400).json({ message: 'Invalid disconnectionCategoryId / disconnectionSubCategoryId.' });
  }

  // Dedup matrix (mirrors spec):
  //   known eventId             → 200 OK no-op
  //   different eventId, known commercialChangeId → 409 Conflict
  //   unknown lead              → 404
  //   else                       → 201 Created
  const existingByEvent = await prisma.commercialChange.findUnique({
    where: { inboundEventId: eventId },
    select: { id: true },
  });
  if (existingByEvent) {
    trace(`200 OK dedup: eventId=${eventId} already processed as ${existingByEvent.id}`);
    return res.status(200).json({ message: 'Already processed.', deduped: true });
  }

  const existingByChangeId = await prisma.commercialChange.findUnique({
    where: { commercialChangeId },
    select: { id: true },
  });
  if (existingByChangeId) {
    trace(`REJECT 409: commercialChangeId=${commercialChangeId} already exists under different eventId (existing row ${existingByChangeId.id})`);
    return res.status(409).json({
      message: 'commercialChangeId already exists under a different eventId.',
    });
  }

  // Accept both the canonical lead.id (UUID) and the human-readable
  // leadNumber as fallbacks — if SAM stored the leadNumber instead of
  // externalId in their first integration, we won't 404 spuriously.
  let lead = await prisma.lead.findUnique({
    where: { id: externalId },
    select: { id: true, leadNumber: true },
  });
  if (!lead) {
    lead = await prisma.lead.findFirst({
      where: { leadNumber: externalId },
      select: { id: true, leadNumber: true },
    });
    if (lead) {
      trace(`fallback: matched lead by leadNumber=${externalId} → lead.id=${lead.id}. SAM should use lead.id as externalId for stability.`);
    }
  }
  if (!lead) {
    trace(`REJECT 404: no lead matches externalId=${externalId} (tried id, then leadNumber)`);
    return res.status(404).json({ message: `Unknown customer.externalId: ${externalId}` });
  }

  const raisedAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();
  const requested = payload.requested || {};

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.commercialChange.create({
      data: {
        commercialChangeId,
        inboundEventId: eventId,
        leadId: lead.id,
        requestedArc: requested.arc ?? null,
        requestedPlanName: requested.planName ?? null,
        requestedBandwidth: requested.bandwidth ?? null,
        raisedBySamUserId: String(payload.raisedBy?.id ?? ''),
        raisedBySamEmail: payload.raisedBy?.email ?? null,
        reason: reason.trim(),
        raisedAt,
        status: 'PENDING',
        disconnectionCategoryId,
        disconnectionSubCategoryId,
      },
    });

    await tx.auditLog.create({
      data: {
        entityType: 'COMMERCIAL_CHANGE',
        entityId: row.id,
        action: 'CREATE',
        snapshot: row,
        context: {
          source: 'sam-webhook',
          inboundEventId: eventId,
          raisedBySamEmail: payload.raisedBy?.email ?? null,
        },
        // SAM is the actor — no CRM user. userId stays null; userName captures
        // the SAM operator email for human-readable filtering in the viewer.
        userId: null,
        userRole: 'SAM',
        userName: payload.raisedBy?.email || 'SAM',
        userEmail: payload.raisedBy?.email || null,
      },
    });

    return row;
  });

  // Fire-and-forget — failure here doesn't void the persisted row.
  notifyAllByRole(
    'SUPER_ADMIN',
    'QUICK_DISCONNECT_REQUESTED',
    'Quick Disconnect Raised',
    `${payload.raisedBy?.email || 'SAM'} raised a disconnect for review.`,
    { commercialChangeId: created.id }
  ).catch((err) => console.error('[QuickDisconnect inbound] notify failed:', err));

  emitSidebarRefreshByRole('SUPER_ADMIN');

  trace(`201 CREATED: id=${created.id} commercialChangeId=${commercialChangeId} leadId=${lead.id} raisedBy=${payload.raisedBy?.email || payload.raisedBy?.id || 'unknown'}`);
  res.status(201).json({ message: 'Accepted.', id: created.id });
};

// POST /api/webhooks/sam/customer.disconnected
//
// SAM fires this once it actually terminates the customer (after the
// scheduled-termination sweep, regardless of whether it originated from a
// QUICK approval or a normal 21-day retention). Closes the loop so CRM can
// flip the Lead from active to inactive — until this fires, CRM lies about
// the customer's state.
//
// Body (verified-then-parsed):
//   {
//     eventId, eventType, occurredAt,
//     customer: { externalId },
//     terminationDate,
//     finalArc?,
//     commercialChangeId?
//   }
export const receiveCustomerDisconnected = async (req, res) => {
  const TAG = '[CustomerDisconnected inbound]';
  const trace = (...args) => console.log(TAG, ...args);

  if (!envConfigured()) {
    trace('REJECT 503: SAM_WEBHOOK_SECRET not set');
    return res.status(503).json({ message: 'Webhook receiver not configured.' });
  }

  const signature = req.header('x-sam-signature');
  const timestamp = req.header('x-sam-timestamp');
  const rawBody = req.rawBody || '';
  trace(`hit: sig=${signature ? signature.slice(0, 8) + '…' : 'MISSING'} ts=${timestamp || 'MISSING'} bodyBytes=${rawBody.length}`);

  if (!verifySignature(rawBody, timestamp, signature)) {
    trace('REJECT 401: bad signature');
    return res.status(401).json({ message: 'Invalid signature.' });
  }
  if (!timestampInWindow(timestamp)) {
    const nowSec = Math.floor(Date.now() / 1000);
    trace(`REJECT 401: timestamp skew their=${timestamp} our=${nowSec}`);
    return res.status(401).json({ message: 'Timestamp outside allowed skew.' });
  }

  const payload = req.body || {};
  const eventId = payload.eventId;
  const externalId = payload.customer?.externalId;
  const terminationDateStr = payload.terminationDate;

  if (!eventId || !externalId || !terminationDateStr) {
    trace(`REJECT 400: missing fields. eventId=${!!eventId} externalId=${!!externalId} terminationDate=${!!terminationDateStr}`);
    return res.status(400).json({
      message: 'Missing required fields: eventId, customer.externalId, terminationDate.',
    });
  }
  if (payload.eventType && payload.eventType !== 'customer.disconnected') {
    trace(`REJECT 400: bad eventType=${payload.eventType}`);
    return res.status(400).json({ message: `Unexpected eventType: ${payload.eventType}` });
  }

  const terminationDate = new Date(terminationDateStr);
  if (Number.isNaN(terminationDate.getTime())) {
    trace(`REJECT 400: invalid terminationDate=${terminationDateStr}`);
    return res.status(400).json({ message: 'Invalid terminationDate.' });
  }

  // Idempotent dedup via the generic InboundWebhookEvent table — this event
  // updates an existing Lead row rather than creating something new, so the
  // CommercialChange dedup pattern doesn't apply here.
  const existing = await prisma.inboundWebhookEvent.findUnique({
    where: { eventId },
    select: { id: true },
  });
  if (existing) {
    trace(`200 OK dedup: eventId=${eventId} already processed`);
    return res.status(200).json({ message: 'Already processed.', deduped: true });
  }

  const lead = await prisma.lead.findUnique({
    where: { id: externalId },
    select: { id: true, actualPlanIsActive: true, actualPlanEndDate: true, leadNumber: true },
  });
  if (!lead) {
    trace(`REJECT 404: unknown externalId=${externalId}`);
    return res.status(404).json({ message: `Unknown customer.externalId: ${externalId}` });
  }

  // Apply termination + dedup row + audit log in one transaction so the lead
  // never flips without a corresponding audit + dedup record.
  await prisma.$transaction(async (tx) => {
    await tx.inboundWebhookEvent.create({
      data: {
        eventId,
        eventType: 'customer.disconnected',
        payload,
      },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        actualPlanIsActive: false,
        actualPlanEndDate: terminationDate,
      },
    });

    await tx.auditLog.create({
      data: {
        entityType: 'LEAD',
        entityId: lead.id,
        action: 'UPDATE',
        changes: {
          actualPlanIsActive: { from: lead.actualPlanIsActive, to: false },
          actualPlanEndDate: { from: lead.actualPlanEndDate, to: terminationDate },
        },
        context: {
          source: 'sam-webhook',
          eventType: 'customer.disconnected',
          inboundEventId: eventId,
          commercialChangeId: payload.commercialChangeId || null,
          finalArc: payload.finalArc ?? null,
        },
        userId: null,
        userRole: 'SAM',
        userName: 'SAM',
      },
    });
  });

  trace(`200 OK: leadId=${lead.id} (${lead.leadNumber}) terminated at ${terminationDate.toISOString()}`);
  res.status(200).json({ message: 'Customer disconnected.', leadId: lead.id });
};
