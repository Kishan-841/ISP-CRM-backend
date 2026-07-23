/**
 * Lead contact masking.
 *
 * Company name, contact person and mobile number are confidential until the
 * lead reaches the delivery stage (pushedToInstallationAt set — the exact
 * moment it appears in the delivery login). Before that, only the roles that
 * own the customer relationship or run the business may see them; every
 * in-between processing team (Feasibility, Docs, Accounts, OPS, SA2, ...)
 * gets masked values.
 *
 * Masking happens SERVER-SIDE at the response-formatting layer on purpose:
 * a frontend-only mask is trivially bypassed via devtools/network tab, and the
 * acceptance criterion is that no API response exposes the real values.
 */

// Roles that always see contact info:
//  - SUPER_ADMIN / MASTER / SALES_DIRECTOR / ADMIN: business exemptions.
//  - ISR / BDM / BDM_CP / BDM_TEAM_LEADER: the sales chain that created and
//    owns the customer contact — an ISR must dial the number and a BDM meets
//    the customer, and their queues are already scoped to their own data.
const UNMASKED_ROLES = new Set([
  'SUPER_ADMIN',
  'MASTER',
  'SALES_DIRECTOR',
  'ADMIN',
  'ISR',
  'BDM',
  'BDM_CP',
  'BDM_TEAM_LEADER'
]);

/**
 * May this user see real contact info for this lead?
 * `pushedToInstallationAt` is the delivery-login gate: once set, the fields are
 * visible to everyone.
 */
export const isLeadContactVisible = (user, pushedToInstallationAt) => {
  if (pushedToInstallationAt) return true;
  return UNMASKED_ROLES.has(user?.role);
};

/** "ABC Technologies Pvt. Ltd." -> "***************" (length-capped) */
export const maskCompanyName = (value) => {
  if (!value) return value;
  return '*'.repeat(Math.min(Math.max(String(value).length, 6), 15));
};

/** "John Smith" -> "J*** S***" */
export const maskPersonName = (value) => {
  if (!value) return value;
  return String(value)
    .trim()
    .split(/\s+/)
    .map((w) => (w[0] || '') + '***')
    .join(' ');
};

/** "9876543210" -> "98******10" */
export const maskMobileNumber = (value) => {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
};

// The three confidential fields as they appear across the different response
// formatters. Email/address are NOT in scope per the spec.
const COMPANY_KEYS = ['company', 'companyName'];
const PERSON_KEYS = ['name', 'firstName', 'lastName', 'contactPerson', 'contactName'];
// whatsapp is a mobile number too — masking "mobile number" covers it.
const MOBILE_KEYS = ['phone', 'mobile', 'whatsapp', 'contactPhone', 'alternatePhone'];

/**
 * Mask the confidential keys present on a formatted lead object (shallow),
 * returning a new object. Only touches keys that exist — safe to apply to any
 * of the queue/detail formatter shapes.
 */
export const maskLeadContactFields = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of COMPANY_KEYS) if (k in out) out[k] = maskCompanyName(out[k]);
  for (const k of PERSON_KEYS) if (k in out) out[k] = maskPersonName(out[k]);
  for (const k of MOBILE_KEYS) if (k in out) out[k] = maskMobileNumber(out[k]);
  return out;
};

/**
 * The one-liner endpoints use: mask a formatted lead unless this user may see
 * it. `pushedToInstallationAt` should come from the Lead row itself.
 */
export const applyLeadContactMask = (formatted, user, pushedToInstallationAt) =>
  isLeadContactVisible(user, pushedToInstallationAt) ? formatted : maskLeadContactFields(formatted);
