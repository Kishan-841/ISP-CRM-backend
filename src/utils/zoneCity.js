/**
 * Coherence check for a chosen (zone, city) pair.
 *
 * Pure on purpose — the caller loads the City row, this decides. Keeping the
 * rule in one place matters because two entry points apply it: the feasibility
 * disposition and the backfill screen. A stale dropdown or a hand-rolled API
 * call could otherwise pair "Walunj" with the Pune zone and nobody would
 * notice until SAM showed the wrong circle.
 *
 * @param {string|null} zoneId  the submitted zone id
 * @param {string|null} cityId  the submitted city id
 * @param {object|null} city    the City row for cityId, as loaded by the caller
 */
export function checkZoneCity(zoneId, cityId, city) {
  if (!zoneId) return { ok: false, message: 'Zone is required.' };
  if (!cityId) return { ok: false, message: 'City is required.' };
  if (!city) return { ok: false, message: 'Selected city was not found.' };
  if (city.zoneId !== zoneId) {
    return { ok: false, message: `"${city.name}" does not belong to the selected zone.` };
  }
  // An inactive city is still valid on leads that already hold it — this only
  // governs new selections.
  if (city.isActive === false) {
    return { ok: false, message: `"${city.name}" is no longer available. Pick another city.` };
  }
  return { ok: true };
}
