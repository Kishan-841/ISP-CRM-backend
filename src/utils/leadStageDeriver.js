/**
 * Single source of truth for "where is this lead right now" derivation.
 *
 * Two pure functions:
 *   - deriveCurrentStage(lead) → { stage, owner } for human-readable display
 *     in Customer 360, the Buckets view, and anywhere else that wants to
 *     show the current pipeline state.
 *   - bucketFromLead(lead, derived, { hasInvoice }) → bucket key for the
 *     admin Buckets view. Routes a stage to the team-bucket the lead is
 *     sitting in (BDM / Feasibility / OPS / Sales Director / Docs / Accounts
 *     / Delivery / Pending Activation / Active / Cold / Dropped).
 *
 * The lead model has ~30 status flags spread across the row. The derivation
 * walks them in priority order — terminal states first, then post-pipeline,
 * then the workflow stages backward from delivery → BDM. The first match
 * wins, so a lead that's reached Accounts shows "Accounts" even though its
 * `feasibilityAssignedToId` is also still set.
 */

export const BUCKETS = Object.freeze({
  BDM: 'BDM',
  FEASIBILITY: 'FEASIBILITY',
  OPS: 'OPS',
  SALES_DIRECTOR: 'SALES_DIRECTOR',
  DOCS: 'DOCS',
  ACCOUNTS: 'ACCOUNTS',
  DELIVERY: 'DELIVERY',
  PENDING_ACTIVATION: 'PENDING_ACTIVATION',
  ACTIVE: 'ACTIVE',
  COLD: 'COLD',
  DROPPED: 'DROPPED',
});

export const VISIBLE_BUCKETS = Object.freeze([
  BUCKETS.BDM,
  BUCKETS.FEASIBILITY,
  BUCKETS.OPS,
  BUCKETS.SALES_DIRECTOR,
  BUCKETS.DOCS,
  BUCKETS.ACCOUNTS,
  BUCKETS.DELIVERY,
  BUCKETS.PENDING_ACTIVATION,
  BUCKETS.ACTIVE,
  BUCKETS.COLD,
]);

export function deriveCurrentStage(lead) {
  // Terminal states first — short-circuit the cascade so a lead that was
  // dropped or marked not-feasible doesn't accidentally get classified
  // by a leftover intermediate flag.
  if (lead.status === 'DROPPED') {
    return { stage: 'Dropped', owner: null };
  }
  if (lead.status === 'NOT_FEASIBLE') {
    return { stage: 'Not Feasible', owner: null };
  }

  // Post-activation customer lifecycle
  if (lead.actualPlanIsActive) {
    return {
      stage: 'Active Customer',
      owner: lead.samAssignment?.samExecutive?.name || 'SAM',
    };
  }
  if (lead.actualPlanName) {
    return { stage: 'Plan Creation', owner: 'Accounts Team' };
  }
  if (lead.demoPlanIsActive) {
    return { stage: 'Demo Plan', owner: 'Accounts Team' };
  }
  if (lead.customerAcceptanceAt) {
    return { stage: 'Awaiting Plan Activation', owner: 'Accounts Team' };
  }
  if (lead.speedTestUploadedAt) {
    return { stage: 'Customer Acceptance', owner: 'Delivery Team' };
  }
  if (lead.installationCompletedAt) {
    return { stage: 'Speed Test', owner: 'Delivery Team' };
  }
  if (lead.installationStartedAt) {
    return { stage: 'Installation', owner: 'Delivery Team' };
  }

  // Delivery queue
  if (lead.deliveryStatus === 'COMPLETED') {
    return { stage: 'Awaiting Installation', owner: 'Delivery Team' };
  }
  if (lead.deliveryStatus === 'DISPATCHED') {
    return { stage: 'Dispatched', owner: 'Delivery Team' };
  }
  if (lead.deliveryStatus === 'ASSIGNED') {
    return { stage: 'Delivery — Assigned to Store', owner: 'Store Manager' };
  }
  if (['APPROVED', 'AREA_HEAD_APPROVED', 'SUPER_ADMIN_APPROVED'].includes(lead.deliveryStatus)) {
    return { stage: 'Delivery — Approved', owner: 'Delivery Team' };
  }
  if (lead.deliveryStatus === 'PENDING_APPROVAL') {
    return { stage: 'Delivery Approval', owner: 'Area Head / Super Admin' };
  }

  // NOC
  if (lead.nocConfiguredAt) {
    return { stage: 'NOC → Delivery', owner: 'Delivery Team' };
  }
  if (lead.nocAssignedToId) {
    return { stage: 'NOC', owner: lead.nocAssignedTo?.name || 'NOC Team' };
  }
  if (lead.pushedToInstallationAt) {
    return { stage: 'Pushed to Installation', owner: 'NOC Team' };
  }

  // Accounts / docs
  if (lead.accountsStatus === 'ACCOUNTS_APPROVED') {
    return { stage: 'Awaiting OPS Push', owner: 'OPS Team' };
  }
  if (lead.accountsStatus === 'ACCOUNTS_REJECTED') {
    return { stage: 'Accounts Rejected', owner: lead.assignedTo?.name || 'BDM' };
  }
  if (lead.docsVerifiedAt && !lead.docsRejectedReason) {
    return { stage: 'Accounts Verification', owner: 'Accounts Team' };
  }
  if (lead.docsRejectedReason) {
    return { stage: 'Docs Rejected', owner: lead.assignedTo?.name || 'BDM' };
  }
  const docsUploaded =
    lead.documents &&
    typeof lead.documents === 'object' &&
    !Array.isArray(lead.documents) &&
    Object.keys(lead.documents).length > 0;
  if (docsUploaded && !lead.docsVerifiedAt) {
    return { stage: 'Docs Verification', owner: 'Docs Team' };
  }

  // SA2 / OPS quotation approvals
  if (lead.superAdmin2ApprovalStatus === 'APPROVED' && !docsUploaded) {
    return { stage: 'Docs Collection', owner: lead.assignedTo?.name || 'BDM' };
  }
  if (lead.superAdmin2ApprovalStatus === 'REJECTED') {
    return { stage: 'SA2 Rejected', owner: lead.assignedTo?.name || 'BDM' };
  }
  if (lead.superAdmin2ApprovalStatus === 'PENDING') {
    return { stage: 'Sales Director Approval', owner: 'Sales Director' };
  }
  if (lead.opsApprovalStatus === 'APPROVED' && !lead.superAdmin2ApprovalStatus) {
    return { stage: 'Sales Director Approval', owner: 'Sales Director' };
  }
  if (lead.opsApprovalStatus === 'PENDING') {
    return { stage: 'OPS Approval', owner: 'OPS Team' };
  }
  if (lead.opsApprovalStatus === 'REJECTED') {
    return { stage: 'OPS Rejected', owner: lead.assignedTo?.name || 'BDM' };
  }

  // Quotation / feasibility
  const hasQuotation = Array.isArray(lead.quotationAttachments)
    ? lead.quotationAttachments.length > 0
    : !!lead.quotationAttachments;
  if (hasQuotation) {
    return { stage: 'Quotation Ready', owner: lead.assignedTo?.name || 'BDM' };
  }
  if (lead.feasibilityReviewedAt) {
    return { stage: 'Quotation', owner: lead.assignedTo?.name || 'BDM' };
  }
  if (lead.feasibilityAssignedToId) {
    return { stage: 'Feasibility', owner: lead.feasibilityAssignedTo?.name || 'Feasibility Team' };
  }

  // Pre-feasibility BDM / status-based
  if (lead.status === 'FOLLOW_UP') return { stage: 'Follow-up', owner: lead.assignedTo?.name || 'BDM' };
  if (lead.status === 'QUALIFIED') return { stage: 'Qualified', owner: lead.assignedTo?.name || 'BDM' };
  if (lead.assignedToId) return { stage: 'BDM', owner: lead.assignedTo?.name || 'BDM' };

  return { stage: 'New', owner: null };
}

// Stage label → bucket. Active Customer is split between PENDING_ACTIVATION
// and ACTIVE based on whether an invoice has been generated, so it's
// resolved separately in bucketFromLead below.
const STAGE_TO_BUCKET = {
  // BDM bucket — anything sitting on a BDM's desk
  'New': BUCKETS.BDM,
  'BDM': BUCKETS.BDM,
  'Qualified': BUCKETS.BDM,
  'Follow-up': BUCKETS.BDM,
  'Quotation': BUCKETS.BDM,
  'Quotation Ready': BUCKETS.BDM,
  'Docs Collection': BUCKETS.BDM,
  'Docs Rejected': BUCKETS.BDM,
  'OPS Rejected': BUCKETS.BDM,
  'SA2 Rejected': BUCKETS.BDM,
  'Accounts Rejected': BUCKETS.BDM,

  'Feasibility': BUCKETS.FEASIBILITY,
  'OPS Approval': BUCKETS.OPS,
  'Sales Director Approval': BUCKETS.SALES_DIRECTOR,
  'Docs Verification': BUCKETS.DOCS,

  'Accounts Verification': BUCKETS.ACCOUNTS,
  'Awaiting OPS Push': BUCKETS.ACCOUNTS,

  'Pushed to Installation': BUCKETS.DELIVERY,
  'NOC': BUCKETS.DELIVERY,
  'NOC → Delivery': BUCKETS.DELIVERY,
  'Delivery Approval': BUCKETS.DELIVERY,
  'Delivery — Approved': BUCKETS.DELIVERY,
  'Delivery — Assigned to Store': BUCKETS.DELIVERY,
  'Dispatched': BUCKETS.DELIVERY,
  'Awaiting Installation': BUCKETS.DELIVERY,
  'Installation': BUCKETS.DELIVERY,
  'Speed Test': BUCKETS.DELIVERY,
  'Customer Acceptance': BUCKETS.DELIVERY,

  // Pre-activation phase: customer accepted, plan being set up but not yet
  // a fully-billing customer. ACTIVE is resolved separately based on
  // hasInvoice (see bucketFromLead).
  'Plan Creation': BUCKETS.PENDING_ACTIVATION,
  'Demo Plan': BUCKETS.PENDING_ACTIVATION,
  'Awaiting Plan Activation': BUCKETS.PENDING_ACTIVATION,

  'Dropped': BUCKETS.DROPPED,
  'Not Feasible': BUCKETS.DROPPED,
};

/**
 * Resolve the bucket for a lead.
 *
 * @param {Object} lead — same shape passed to deriveCurrentStage
 * @param {{stage: string}} derived — output of deriveCurrentStage
 * @param {Object} options
 * @param {boolean} options.hasInvoice — true if at least one invoice exists
 *   for this lead. Splits "Active Customer" into ACTIVE (fully-billing) vs
 *   PENDING_ACTIVATION (plan flipped on but not yet on the billing cycle).
 */
export function bucketFromLead(lead, derived, { hasInvoice = false } = {}) {
  // Cold leads are parked regardless of where their flags say they are.
  if (lead.isColdLead) return BUCKETS.COLD;

  if (derived.stage === 'Active Customer') {
    return hasInvoice ? BUCKETS.ACTIVE : BUCKETS.PENDING_ACTIVATION;
  }

  return STAGE_TO_BUCKET[derived.stage] || BUCKETS.BDM;
}
