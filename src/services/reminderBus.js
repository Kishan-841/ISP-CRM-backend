import { emitToUser } from '../sockets/index.js';

/**
 * Shared helper for all scheduled reminder crons.
 *
 * - Keeps a single in-memory dedup cache keyed on `<type>|<recordId>` so the
 *   same event never fires twice even if its time still falls in the
 *   reminder window on subsequent cron ticks.
 * - Centralizes the socket event name + payload shape so the frontend only
 *   has one listener to maintain regardless of how many reminder types we add.
 *
 * All crons should use `tryEmitReminder()` — do NOT emit 'reminder:show'
 * directly so dedup stays consistent.
 */

const DEDUP_TTL_MS = 20 * 60 * 1000;   // 20 min keeps keys alive across typical windows
const _fired = new Map();

export function cleanExpired() {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [k, t] of _fired) {
    if (t < cutoff) _fired.delete(k);
  }
}

/**
 * @param {Object} params
 * @param {string} params.userId          — recipient
 * @param {string} params.type            — 'MEETING_BDM' | 'MEETING_SAM' | 'FOLLOW_UP_ISR' | 'FOLLOW_UP_BDM' | 'SAM_VISIT' | 'COMPLAINT_TAT' | 'INVOICE_DUE'
 * @param {string} params.recordId        — DB id of the underlying record (for dedup)
 * @param {string} params.title           — main line shown in modal
 * @param {string} [params.subtitle]      — secondary line (e.g. customer/company)
 * @param {string} params.startAt         — ISO timestamp of the event (for countdown display)
 * @param {string} params.ctaLabel        — CTA button text (e.g. "Open Meeting", "Start Call")
 * @param {string} params.ctaHref         — frontend route the CTA opens
 * @param {string} [params.joinLink]      — optional external link (e.g. Zoom URL for meetings)
 * @param {string} [params.location]      — optional location for field visits / meetings
 * @param {Object} [params.meta]          — any extra type-specific info
 * @returns {boolean} true if emitted, false if deduped
 */
export function tryEmitReminder({
  userId,
  type,
  recordId,
  title,
  subtitle = null,
  startAt,
  ctaLabel,
  ctaHref,
  joinLink = null,
  location = null,
  meta = {},
}) {
  if (!userId || !type || !recordId) return false;
  const key = `${type}|${recordId}`;
  if (_fired.has(key)) return false;
  _fired.set(key, Date.now());

  emitToUser(userId, 'reminder:show', {
    id: key,
    type,
    recordId,
    title,
    subtitle,
    startAt,
    ctaLabel,
    ctaHref,
    joinLink,
    location,
    meta,
  });
  return true;
}

/**
 * Handy window builder — returns two Dates for `gte / lte` Prisma filters.
 */
export function windowMinutesAhead(minMin, maxMin) {
  const now = Date.now();
  return {
    windowStart: new Date(now + minMin * 60 * 1000),
    windowEnd: new Date(now + maxMin * 60 * 1000),
  };
}
