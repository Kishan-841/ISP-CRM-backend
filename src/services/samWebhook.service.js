import crypto from 'node:crypto';
import prisma from '../config/db.js';

// Outbound webhook to the downstream SAM platform. Fired the moment a
// customer's actual plan goes live so SAM creates the row in its New Base
// dashboard automatically. Source of truth stays here; SAM is a downstream
// copy keyed on customer.externalId (this CRM's lead id).
//
// Delivery model:
//   1. enqueueActivationWebhook() inserts a SamWebhookLog row inside the
//      caller's DB transaction. If the activation rolls back, the row
//      rolls back too — no orphan attempts.
//   2. After commit, the caller fires attemptDeliveryInBackground() which
//      runs the first attempt without blocking the HTTP response.
//   3. Failed transient attempts (5xx, network) leave the row PENDING with
//      a backed-off nextAttemptAt; the samWebhookRetry cron sweeps those.
//   4. 4xx is treated as permanent (the payload is wrong) and marked
//      FAILED immediately.
//
// The payload is frozen at insert time and stored as JSON. Retries replay
// the original event with the same eventId, so SAM's idempotency check
// short-circuits to DUPLICATE rather than upserting stale data.

const MAX_ATTEMPTS = 11; // first attempt + 10 retries
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_LOG_BYTES = 2048;

// Backoff schedule indexed by the attemptCount that just failed.
// Index 0 = first attempt failed → wait 5s before retry.
// After index 9 (the 10th failure), we mark FAILED.
// Sum ≈ 28h — covers the 24h target for quickDisconnect.decided redeliveries
// while still letting transient blips clear within a minute.
const BACKOFF_SECONDS = [5, 30, 120, 600, 1800, 3600, 7200, 14400, 28800, 43200];

function envConfigured() {
  return Boolean(process.env.SAM_WEBHOOK_URL && process.env.SAM_WEBHOOK_SECRET);
}

// Per-event URL resolver. SAM has separate endpoints per event type (their
// customer-activated handler 400s on a quickDisconnect.decided payload — and
// vice versa), so we route to the right URL based on payload.eventType.
//
// Resolution order for each event:
//   1. The per-event env var (e.g. SAM_QUICK_DISCONNECT_DECIDED_URL)
//   2. The legacy single SAM_WEBHOOK_URL (back-compat for customer.activated,
//      which was wired before this routing existed)
// If neither is set, attemptDelivery short-circuits and logs.
const URL_ENV_BY_EVENT = {
  'customer.activated': 'SAM_CUSTOMER_ACTIVATED_URL',
  'quickDisconnect.decided': 'SAM_QUICK_DISCONNECT_DECIDED_URL',
  // New per-spec event — fires on EVERY commercial-change state transition,
  // not just the initial admin approval. URL is the new SAM endpoint
  // /integrations/crm/commercial-change-status (or the documented alias).
  'commercialChange.statusChanged': 'SAM_COMMERCIAL_CHANGE_STATUS_URL',
};

function resolveUrlForEvent(eventType) {
  const specific = URL_ENV_BY_EVENT[eventType];
  if (specific && process.env[specific]) return process.env[specific];
  return process.env.SAM_WEBHOOK_URL || null;
}

function toIsoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildPayload(lead) {
  const cd = lead.campaignData || {};
  return {
    eventId: crypto.randomUUID(),
    eventType: 'customer.activated',
    occurredAt: new Date().toISOString(),
    customer: {
      externalId: lead.id,
      // Human-readable CRM lead number (e.g. "GLL-001"). Useful for SAM
      // operators when cross-referencing tickets — externalId is the
      // canonical UUID, leadNumber is the friendly label.
      leadNumber: lead.leadNumber || null,
      companyName: cd.company || null,
      contactName: cd.name || null,
      email: cd.email || null,
      phone: cd.phone || null,
      circuitId: lead.circuitId || null,
      bandwidthMbps: lead.actualPlanBandwidth ?? null,
      currentPlan: lead.actualPlanName || null,
      // currentMrr = monthly billing-cycle price (actualPlanPrice).
      // currentArc = annual figure. Both sent so SAM can display the ARC
      // value as-is rather than computing currentMrr * 12 (which is
      // ambiguous if the cycle isn't monthly).
      currentMrr: lead.actualPlanPrice ?? null,
      currentArc: lead.arcAmount ?? null,
      onboardingDate: toIsoDate(lead.actualPlanStartDate) || toIsoDate(new Date()),
    },
  };
}

// Insert a PENDING SamWebhookLog inside the caller's transaction.
// Returns the created log row, or null if env vars aren't configured
// (we still let the activation succeed in that case — webhook is best-
// effort and the dev hasn't wired SAM up yet).
export async function enqueueActivationWebhook(tx, lead) {
  if (!envConfigured()) {
    console.warn('[SamWebhook] SAM_WEBHOOK_URL / SAM_WEBHOOK_SECRET not set; skipping enqueue.');
    return null;
  }
  const payload = buildPayload(lead);
  return tx.samWebhookLog.create({
    data: {
      eventId: payload.eventId,
      leadId: lead.id,
      payload,
      status: 'PENDING',
      nextAttemptAt: new Date(),
    },
  });
}

// Build the outbound payload for commercialChange.statusChanged. Fires on
// every transition through the QUICK workflow (admin approve, docs review
// approve/reject, NOC complete, accounts complete, cancel, etc.) — not just
// the first admin decision. Replaces the old quickDisconnect.decided event
// (spec §3.4 Option A — retire the old single-fire model).
function buildCommercialChangeStatusChangedPayload({
  change,
  fromStatus,
  toStatus,
  changedByUser,
  note,
  serviceOrder,
}) {
  return {
    eventId: crypto.randomUUID(),
    eventType: 'commercialChange.statusChanged',
    occurredAt: new Date().toISOString(),
    commercialChangeId: change.commercialChangeId,
    fromStatus: fromStatus || null,
    toStatus,
    changedBy: changedByUser?.email || changedByUser?.id || null,
    ...(note ? { note } : {}),
    ...(serviceOrder
      ? { serviceOrderId: serviceOrder.id, serviceOrderNumber: serviceOrder.orderNumber }
      : {}),
  };
}

// Enqueue a PENDING SamWebhookLog for a commercial-change status transition
// inside the caller's transaction. Returns the created row (or null if env
// isn't wired). Callers should record the resulting eventId + logId on the
// CommercialChange row only if this is the FIRST transition — subsequent
// transitions overwrite the previous link, which is fine because SAM's
// observability for older transitions lives in the SamWebhookLog table.
export async function enqueueCommercialChangeStatusChangedWebhook(tx, args) {
  if (!envConfigured()) {
    console.warn('[SamWebhook] SAM_WEBHOOK_URL / SAM_WEBHOOK_SECRET not set; skipping enqueue.');
    return null;
  }
  const payload = buildCommercialChangeStatusChangedPayload(args);
  return tx.samWebhookLog.create({
    data: {
      eventId: payload.eventId,
      // SamWebhookLog.leadId is schema-required; reuse it so the admin
      // webhook viewer's leadId filter still surfaces transition events.
      leadId: args.change.leadId,
      payload,
      status: 'PENDING',
      nextAttemptAt: new Date(),
    },
  });
}

// Convenience wrapper used by the ServiceOrder workflow controllers. Given a
// service-order id and the new status, looks up the linked CommercialChange
// (if any) and fires commercialChange.statusChanged. No-op when the SO isn't
// linked to a CC (i.e. normal disconnect, not QUICK-originated).
//
// `client` is either `prisma` or a transaction handle — pass the transaction
// handle if the caller has one open, otherwise pass the global client.
export async function notifyCommercialChangeIfLinked(client, {
  serviceOrderId,
  fromStatus,
  toStatus,
  changedByUser,
  note,
}) {
  const change = await client.commercialChange.findUnique({
    where: { serviceOrderId },
    select: { id: true, leadId: true, commercialChangeId: true },
  });
  if (!change) return null;
  const serviceOrder = await client.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    select: { id: true, orderNumber: true },
  });
  return enqueueCommercialChangeStatusChangedWebhook(client, {
    change,
    fromStatus,
    toStatus,
    changedByUser,
    note,
    serviceOrder,
  });
}

function signBody(body, timestamp) {
  return crypto
    .createHmac('sha256', process.env.SAM_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

// Re-sign the frozen payload with a fresh timestamp and POST to SAM.
// Updates the row to DELIVERED on 2xx, FAILED on 4xx or after the
// attempt cap, or leaves it PENDING with a backed-off nextAttemptAt
// on transient failures (5xx / network).
export async function attemptDelivery(logId) {
  if (!envConfigured()) return;

  const log = await prisma.samWebhookLog.findUnique({ where: { id: logId } });
  if (!log || log.status !== 'PENDING') return;

  const ts = Math.floor(Date.now() / 1000);
  // The body MUST be the same bytes we sign — re-stringifying after signing
  // would break the HMAC. payload is stored as JSON in Postgres, so the
  // canonical form here is whatever JSON.stringify produces from the parsed
  // value. SAM verifies on the bytes we send, so this is consistent.
  const body = JSON.stringify(log.payload);
  const signature = signBody(body, ts);

  const eventType = log.payload?.eventType || 'unknown';
  const targetUrl = resolveUrlForEvent(eventType);
  if (!targetUrl) {
    // No URL wired for this event type and no legacy SAM_WEBHOOK_URL fallback
    // either. Mark FAILED so the retry cron stops banging on it.
    await prisma.samWebhookLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        attemptCount: log.attemptCount + 1,
        lastAttemptedAt: new Date(),
        lastResponseStatus: null,
        lastResponseBody: `No URL configured for eventType=${eventType}. Set ${URL_ENV_BY_EVENT[eventType] || 'SAM_WEBHOOK_URL'}.`,
      },
    });
    console.error(`[SamWebhook] No URL configured for eventType=${eventType} — set ${URL_ENV_BY_EVENT[eventType] || 'SAM_WEBHOOK_URL'} env var.`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let responseStatus = null;
  let responseBody = '';
  let networkError = null;
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CRM-Signature': signature,
        'X-CRM-Timestamp': String(ts),
      },
      body,
      signal: controller.signal,
    });
    responseStatus = res.status;
    try {
      const text = await res.text();
      responseBody = text.slice(0, MAX_BODY_LOG_BYTES);
    } catch {
      responseBody = '';
    }
  } catch (err) {
    networkError = err;
    responseBody = String(err?.message || err).slice(0, MAX_BODY_LOG_BYTES);
  } finally {
    clearTimeout(timeout);
  }

  const newAttemptCount = log.attemptCount + 1;
  const now = new Date();

  // 200 = already processed (idempotent dedup hit), 201 = newly created.
  // Both are success.
  if (responseStatus === 200 || responseStatus === 201) {
    await prisma.samWebhookLog.update({
      where: { id: log.id },
      data: {
        status: 'DELIVERED',
        attemptCount: newAttemptCount,
        lastAttemptedAt: now,
        lastResponseStatus: responseStatus,
        lastResponseBody: responseBody,
      },
    });
    return;
  }

  // 4xx = our payload is wrong. Retrying won't help — log loudly and stop.
  if (responseStatus !== null && responseStatus >= 400 && responseStatus < 500) {
    await prisma.samWebhookLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        attemptCount: newAttemptCount,
        lastAttemptedAt: now,
        lastResponseStatus: responseStatus,
        lastResponseBody: responseBody,
      },
    });
    console.error(
      `[SamWebhook] Permanent failure (${responseStatus}) for eventType=${eventType} eventId=${log.eventId} url=${targetUrl}: ${responseBody}`
    );
    return;
  }

  // Transient (5xx or network/abort) — back off and stay PENDING, unless
  // we've exhausted the schedule.
  if (newAttemptCount >= MAX_ATTEMPTS) {
    await prisma.samWebhookLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        attemptCount: newAttemptCount,
        lastAttemptedAt: now,
        lastResponseStatus: responseStatus,
        lastResponseBody: responseBody,
      },
    });
    console.error(
      `[SamWebhook] Giving up after ${newAttemptCount} attempts for eventType=${eventType} eventId=${log.eventId} url=${targetUrl}` +
        (networkError ? ` (network: ${networkError.message})` : ` (status: ${responseStatus})`)
    );
    return;
  }

  const backoffSec =
    BACKOFF_SECONDS[Math.min(log.attemptCount, BACKOFF_SECONDS.length - 1)];
  await prisma.samWebhookLog.update({
    where: { id: log.id },
    data: {
      attemptCount: newAttemptCount,
      lastAttemptedAt: now,
      lastResponseStatus: responseStatus,
      lastResponseBody: responseBody,
      nextAttemptAt: new Date(Date.now() + backoffSec * 1000),
    },
  });
}

// Fire-and-forget wrapper for the immediate post-commit attempt. Errors
// are swallowed to console — the row is already persisted, so the cron
// will pick it up on the next sweep.
export function attemptDeliveryInBackground(logId) {
  if (!logId) return;
  setImmediate(() => {
    attemptDelivery(logId).catch((err) => {
      console.error('[SamWebhook] attemptDelivery threw:', err);
    });
  });
}
