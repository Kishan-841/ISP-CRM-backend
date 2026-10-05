/**
 * Whether a lead may be cancelled out of the delivery pipeline.
 *
 * Cancellation is for leads that die BEFORE the customer accepts. Past that
 * line the customer is live and the correct instrument is a DISCONNECTION
 * service order, which has its own approval chain.
 *
 * Pure: no DB, no I/O. The controller does the work; this decides whether it may.
 */

/**
 * Delivery board stages from which cancelling is offered. Order matches the
 * board's own pipeline (delivery-queue/page.js PIPELINE_STAGES).
 * `customer_acceptance` means AWAITING acceptance, so it is included - the
 * hard stop is the acceptance itself, not the stage.
 */
export const CANCELLABLE_STAGES = Object.freeze([
  'vendor_setup',
  'pending',
  'material_requested',
  'pushed_to_noc',
  'installing',
  'demo_plan_pending',
  'speed_test',
  'customer_acceptance'
]);

const refuse = (code, message) => ({ allowed: false, code, message });

export function canCancelLead(lead, reason) {
  if (!lead || !lead.pushedToInstallationAt) {
    return refuse('NOT_IN_DELIVERY', 'This lead has not reached the delivery stage.');
  }
  if (lead.cancelledAt) {
    return refuse('ALREADY_CANCELLED', 'This lead has already been cancelled.');
  }
  // Both are checked: a lead can carry the status without the timestamp if it
  // was set by an older code path or a manual correction.
  if (lead.customerAcceptanceAt || lead.customerAcceptanceStatus === 'ACCEPTED') {
    return refuse(
      'ACCEPTANCE_RECORDED',
      'Customer acceptance is already recorded. Raise a disconnection service order instead.'
    );
  }
  if (lead.actualPlanIsActive) {
    return refuse(
      'PLAN_ACTIVE',
      'This customer has an active plan. Raise a disconnection service order instead.'
    );
  }
  if (!reason || !String(reason).trim()) {
    return refuse('REASON_REQUIRED', 'A cancellation reason is required.');
  }
  return { allowed: true, code: null, message: null };
}
