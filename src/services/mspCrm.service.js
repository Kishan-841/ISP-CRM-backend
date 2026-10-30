/**
 * MSP CRM integration — handing a lead to our other software.
 *
 * Two halves, deliberately separate:
 *   SEND    we push a lead once with POST /leads. Their API is idempotent on
 *           externalRef, so a retry can never create a second lead there.
 *   STATUS  they own the pipeline after that. A poll every 5 minutes pulls
 *           whatever changed and writes it onto our Lead rows.
 *
 * The send state is an outbox folded onto the Lead itself (mspSendStatus,
 * mspNextAttemptAt) rather than a separate table, because one lead maps to at
 * most one MSP lead — there is no queue of events per lead to keep.
 *
 * The API key only ever lives here, server-side. It must never reach the
 * browser, which is why the frontend calls our own endpoint and not theirs.
 */
import prisma from '../config/db.js';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_ERROR_LOG_CHARS = 2000;
const PAGE_LIMIT = 100;
/** Their documented ceiling is 120 requests/minute; stay well under it. */
const MAX_PAGES_PER_RUN = 50;

const MAX_ATTEMPTS = 11; // first attempt + 10 retries
const BACKOFF_SECONDS = [5, 30, 120, 600, 1800, 3600, 7200, 14400, 28800, 43200];

export const SYNC_CURSOR_KEY = 'msp_last_synced_at';

export function isConfigured() {
  return Boolean(process.env.MSP_CRM_API_URL && process.env.MSP_CRM_API_KEY);
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.MSP_CRM_API_KEY,
  };
}

function backoffFor(attemptCount) {
  return BACKOFF_SECONDS[Math.min(attemptCount, BACKOFF_SECONDS.length - 1)];
}

const truncate = (s) => (s ? String(s).slice(0, MAX_ERROR_LOG_CHARS) : null);

/**
 * One fetch with a timeout, returning a uniform shape instead of throwing,
 * so callers classify outcomes in one place rather than around try/catch.
 */
async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${process.env.MSP_CRM_API_URL}${path}`, {
      method,
      headers: authHeaders(),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    let parsed = null;
    let raw = '';
    try {
      raw = await res.text();
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null; // non-JSON body (a proxy error page, say)
    }
    return { ok: res.ok, status: res.status, body: parsed, raw };
  } catch (err) {
    // Timeout or network failure — no status to classify on.
    return { ok: false, status: null, body: null, raw: '', networkError: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map one of our leads onto their payload.
 *
 * externalRef is lead.id, not leadNumber: leadNumber is nullable in our schema
 * and their field must be unique and always present.
 *
 * @returns {{ payload: object|null, missing: string[] }}
 */
export function buildLeadPayload(lead, user) {
  const cd = lead.campaignData || {};
  const contactPerson =
    cd.name?.trim() ||
    [cd.firstName, cd.lastName].filter(Boolean).join(' ').trim() ||
    null;

  const payload = {
    externalRef: lead.id,
    companyName: cd.company?.trim() || null,
    contactPerson,
    phone: cd.phone?.trim() || null,
    email: cd.email?.trim() || null,
    requirement: lead.requirements || undefined,
    notes: lead.bandwidthRequirement
      ? `ISP CRM lead ${lead.leadNumber || ''} — bandwidth ${lead.bandwidthRequirement}`.trim()
      : `ISP CRM lead ${lead.leadNumber || ''}`.trim(),
    customerGstin: lead.customerGstNo || undefined,
    // Their example shows a numeric state code. We store a state name, so we
    // send what we have and let them normalise; the field is optional.
    customerState: cd.state || undefined,
    billingAddress: lead.billingAddress || cd.city || undefined,
    ...(user ? { submittedBy: { name: user.name, email: user.email } } : {}),
  };

  // Their four required fields. Checked here so an obviously-incomplete lead
  // never costs a round trip or a retry slot.
  const missing = ['companyName', 'contactPerson', 'phone', 'email'].filter(
    (k) => !payload[k]
  );

  return { payload, missing };
}

/**
 * Push one lead to the MSP CRM and record the outcome on the lead.
 *
 * Safe to call repeatedly: their 200 means "already had this externalRef" and
 * returns the same lead, so a retry after a timeout cannot duplicate.
 *
 * @returns {{ ok: boolean, permanent?: boolean, message?: string, data?: object }}
 */
export async function sendLeadToMsp(leadId, user = null) {
  if (!isConfigured()) {
    return { ok: false, permanent: false, message: 'MSP CRM integration is not configured.' };
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      campaignData: {
        select: { company: true, name: true, firstName: true, lastName: true, phone: true, email: true, state: true, city: true },
      },
    },
  });
  if (!lead) return { ok: false, permanent: true, message: 'Lead not found.' };
  if (lead.mspSendStatus === 'SENT') {
    return { ok: true, message: 'Already sent to MSP CRM.', data: { mspLeadId: lead.mspLeadId } };
  }

  const { payload, missing } = buildLeadPayload(lead, user);
  if (missing.length > 0) {
    const message = `Cannot send to MSP CRM — missing ${missing.join(', ')}.`;
    await prisma.lead.update({
      where: { id: lead.id },
      data: { mspSendStatus: 'FAILED', mspLastError: message, mspNextAttemptAt: null },
    });
    return { ok: false, permanent: true, message };
  }

  const res = await request('/leads', { method: 'POST', body: payload });
  const attempts = lead.mspSendAttempts + 1;

  // 201 created, 200 already-known. Both carry the status object.
  if (res.ok) {
    const data = res.body?.data || {};
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        mspSendStatus: 'SENT',
        mspSendAttempts: attempts,
        mspNextAttemptAt: null,
        mspLastError: null,
        mspSentAt: lead.mspSentAt || new Date(),
        mspSentById: lead.mspSentById || user?.id || null,
        mspLeadId: data.leadId || lead.mspLeadId || null,
        // Their response already tells us where the lead stands; recording it
        // now means the UI shows a real status without waiting for the poll.
        ...applyStatusFields(data),
      },
    });
    return { ok: true, message: 'Sent to MSP CRM.', data };
  }

  const message = res.body?.message || res.networkError || `HTTP ${res.status}`;

  // 400 is their validation verdict on this payload — the same bytes will be
  // rejected every time, so retrying is pointless and would mask the problem.
  if (res.status === 400) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        mspSendStatus: 'FAILED',
        mspSendAttempts: attempts,
        mspNextAttemptAt: null,
        mspLastError: truncate(message),
      },
    });
    return { ok: false, permanent: true, message };
  }

  // 401/403 mean our key is wrong or disabled. That is a configuration fault,
  // not a bad lead, so the lead stays retryable and recovers on its own once
  // someone fixes the key — but it is logged loudly because no amount of
  // retrying will help until they do.
  if (res.status === 401 || res.status === 403) {
    console.error(`[MspCrm] Auth failure (${res.status}) — check MSP_CRM_API_KEY. ${message}`);
  }

  // A 404 on the SEND endpoint means MSP_CRM_API_URL does not point at their
  // integrations API — their 404 is documented only for fetching one lead by
  // ref, never for creating one. Easy to do by pointing the URL at this very
  // backend, which answers on the same port in local setups and has no such
  // route. The lead stays retryable (it recovers once the URL is fixed) but
  // this must be loud: silently backing off would look like a slow MSP CRM
  // rather than a typo.
  if (res.status === 404) {
    console.error(
      `[MspCrm] POST /leads returned 404 — MSP_CRM_API_URL is probably wrong ` +
      `(currently "${process.env.MSP_CRM_API_URL}"). It must point at the MSP CRM backend's ` +
      `/api/v1/integrations, not at this CRM.`
    );
  }

  // Everything else (429, 5xx, timeout, DNS) is transient.
  const exhausted = attempts >= MAX_ATTEMPTS;
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      mspSendStatus: exhausted ? 'FAILED' : 'PENDING',
      mspSendAttempts: attempts,
      mspNextAttemptAt: exhausted ? null : new Date(Date.now() + backoffFor(lead.mspSendAttempts) * 1000),
      mspLastError: truncate(
        exhausted ? `Gave up after ${attempts} attempts. Last error: ${message}` : message
      ),
    },
  });
  return { ok: false, permanent: exhausted, message };
}

/** Queue a lead for the retry sweep without calling their API inline. */
export async function queueLeadForMsp(leadId, user = null) {
  return prisma.lead.update({
    where: { id: leadId },
    data: {
      mspSendStatus: 'PENDING',
      mspNextAttemptAt: new Date(),
      mspLastError: null,
      mspSentById: user?.id || undefined,
    },
  });
}

/** The subset of a status object we persist. Shared by send and sync. */
function applyStatusFields(s) {
  return {
    mspStatus: s.status ?? undefined,
    mspStatusLabel: s.statusLabel ?? undefined,
    mspAssignedTo: s.assignedTo ?? null,
    mspOrderNo: typeof s.orderNo === 'number' ? s.orderNo : undefined,
    mspDropReason: s.dropReason ?? null,
    mspSyncedAt: new Date(),
  };
}

export async function getSyncCursor() {
  const row = await prisma.integrationSyncState.findUnique({ where: { key: SYNC_CURSOR_KEY } });
  return row?.value || null;
}

export async function setSyncCursor(value) {
  await prisma.integrationSyncState.upsert({
    where: { key: SYNC_CURSOR_KEY },
    create: { key: SYNC_CURSOR_KEY, value },
    update: { value },
  });
}

/**
 * Pull every status change since the last successful run.
 *
 * The cursor is only advanced after EVERY page succeeded. A partial run
 * leaves it untouched, so the next run re-reads the same window — their docs
 * confirm a lead appearing twice is harmless, whereas advancing the cursor on
 * a half-finished run would drop the updates we never read.
 *
 * @returns {{ ok: boolean, updated: number, removed: number, pages: number, message?: string }}
 */
export async function syncMspStatuses() {
  if (!isConfigured()) return { ok: false, updated: 0, removed: 0, pages: 0, message: 'not configured' };

  const updatedSince = await getSyncCursor();
  let page = 1;
  let totalPages = 1;
  let serverTime = null;
  let updated = 0;
  let removedCount = 0;

  while (page <= totalPages && page <= MAX_PAGES_PER_RUN) {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_LIMIT),
      ...(updatedSince ? { updatedSince } : {}),
    });
    const res = await request(`/leads?${qs.toString()}`);
    if (!res.ok) {
      const message = res.body?.message || res.networkError || `HTTP ${res.status}`;
      console.error(`[MspCrm] Status sync failed on page ${page}: ${message}`);
      // Cursor deliberately not advanced — the next run retries this window.
      return { ok: false, updated, removed: removedCount, pages: page - 1, message };
    }

    const data = res.body?.data || {};
    if (page === 1) {
      // Their clock, not ours. Skew between the two servers would otherwise
      // open a window of changes that neither run ever reads.
      serverTime = data.serverTime || null;
      for (const r of data.removed || []) {
        const n = await markRemoved(r.externalRef, r.removedAt);
        removedCount += n;
      }
    }
    totalPages = Number(data.totalPages) || 1;

    for (const item of data.items || []) {
      updated += await applyStatus(item);
    }
    page += 1;
  }

  if (page > MAX_PAGES_PER_RUN && totalPages >= page) {
    // Stop short rather than hammer their rate limit; the cursor stays put so
    // the next run picks up exactly where this one stopped reading.
    console.warn(`[MspCrm] Stopped at ${MAX_PAGES_PER_RUN} pages; cursor not advanced.`);
    return { ok: false, updated, removed: removedCount, pages: MAX_PAGES_PER_RUN, message: 'page cap reached' };
  }

  if (serverTime) await setSyncCursor(serverTime);
  return { ok: true, updated, removed: removedCount, pages: totalPages };
}

/** Write one status object onto our lead. Returns 1 if a row matched. */
async function applyStatus(item) {
  if (!item?.externalRef) return 0;
  const result = await prisma.lead.updateMany({
    where: { id: item.externalRef },
    data: {
      ...applyStatusFields(item),
      // A lead we learn about from their side must have reached them, even if
      // our own send record says otherwise (e.g. a timeout we never resolved).
      mspSendStatus: 'SENT',
      ...(item.leadId ? { mspLeadId: item.leadId } : {}),
      ...(item.status === 'REMOVED' ? { mspRemovedAt: new Date() } : {}),
    },
  });
  return result.count;
}

async function markRemoved(externalRef, removedAt) {
  if (!externalRef) return 0;
  const result = await prisma.lead.updateMany({
    where: { id: externalRef },
    data: {
      mspStatus: 'REMOVED',
      mspStatusLabel: 'Removed in MSP CRM',
      mspRemovedAt: removedAt ? new Date(removedAt) : new Date(),
      mspSyncedAt: new Date(),
    },
  });
  return result.count;
}

/** Leads whose send is due for another attempt. Used by the cron sweep. */
export async function findDueSends(limit = 25) {
  return prisma.lead.findMany({
    where: { mspSendStatus: 'PENDING', mspNextAttemptAt: { lte: new Date() } },
    orderBy: { mspNextAttemptAt: 'asc' },
    take: limit,
    select: { id: true },
  });
}
