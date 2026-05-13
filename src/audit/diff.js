// Fields we never include in a diff. These are framework-managed or noise;
// including them produces meaningless audit rows ("Bob updated updatedAt").
const SKIP_FIELDS = new Set(['updatedAt', 'createdAt']);

/**
 * Return field-level diff between two Prisma records, in the shape
 *   [{ field, oldValue, newValue }, …]
 *
 * Equality is JSON-aware (Dates compared by ISO, objects by JSON, null vs
 * undefined treated as equal). Fields in SKIP_FIELDS are omitted entirely.
 */
export function computeDiff(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (SKIP_FIELDS.has(key)) continue;
    const a = normalize(before?.[key]);
    const b = normalize(after?.[key]);
    if (a === b) continue;
    out.push({
      field: key,
      oldValue: before?.[key] ?? null,
      newValue: after?.[key] ?? null,
    });
  }
  return out;
}

function normalize(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
