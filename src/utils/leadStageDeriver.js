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
  NOC: 'NOC',
  STORE: 'STORE',
  DELIVERY: 'DELIVERY',
  PENDING_ACTIVATION: 'PENDING_ACTIVATION',
  ACTIVE: 'ACTIVE',
  COLD: 'COLD',
  DROPPED: 'DROPPED',
});

// Visible tabs in the admin Buckets view. The principle is "in which login
// is this lead waiting?" — so every team that has its own login gets its
// own tab. NOC and Store had been folded into Delivery; they're separate
// roles with separate queues, so they're separate tabs now.
//
// Cold leads, active customers, and pending-activation leads are excluded —
// they have dedicated screens (Lead Pipeline / Customer 360) and aren't
// "in someone's working queue."
export const VISIBLE_BUCKETS = Object.freeze([
  BUCKETS.BDM,
  BUCKETS.FEASIBILITY,
  BUCKETS.OPS,
  BUCKETS.SALES_DIRECTOR,
  BUCKETS.DOCS,
  BUCKETS.ACCOUNTS,
  BUCKETS.NOC,
  BUCKETS.STORE,
  BUCKETS.DELIVERY,
]);

// Delivery sub-stage cascade. Called only when `lead.pushedToInstallationAt`
// is set. Reads three signals: `lead.deliveryStatus` (lead-level), the active
// non-completed `lead.deliveryRequest` (the DeliveryRequest row, flattened by
// the caller), and `lead.deliveryVendorSetupDone`. The order matches the
// delivery queue's `getLeadStage` helper — most-advanced state first.
function deriveDeliveryStage(lead) {
  const ds = lead.deliveryStatus;
  const req = lead.deliveryRequest || null;

  if (ds === 'COMPLETED') return { stage: 'Delivery Completed', owner: 'Delivery Team' };
  if (lead.speedTestUploadedAt || ds === 'CUSTOMER_ACCEPTANCE') {
    return { stage: 'Customer Acceptance', owner: 'Delivery Team' };
  }
  if (lead.installationCompletedAt || ds === 'SPEED_TEST') {
    return { stage: 'Speed Test', owner: 'Delivery Team' };
  }
  if (ds === 'DEMO_PLAN_PENDING') {
    return { stage: 'Demo Plan', owner: 'Accounts Team' };
  }
  if (lead.installationStartedAt || ds === 'INSTALLING') {
    return { stage: 'Installation', owner: 'Delivery Team' };
  }
  if (ds === 'ACTIVATION_READY' || lead.nocConfiguredAt) {
    return { stage: 'NOC Completed', owner: 'Delivery Team' };
  }
  if (lead.nocAssignedToId) {
    return { stage: 'At NOC', owner: lead.nocAssignedTo?.name || 'NOC Team' };
  }
  if (ds === 'PUSHED_TO_NOC' || req?.pushedToNocAt) {
    return { stage: 'At NOC', owner: 'NOC Team' };
  }
  if (ds === 'MATERIAL_REJECTED') {
    return { stage: 'Material Rejected', owner: 'Delivery Team' };
  }
  if (req?.status === 'ASSIGNED') {
    return { stage: 'Material Received', owner: 'Delivery Team' };
  }
  if (req && ['APPROVED', 'AREA_HEAD_APPROVED', 'SUPER_ADMIN_APPROVED'].includes(req.status)) {
    return { stage: 'Material Approved', owner: 'Store Manager' };
  }
  if (req?.status === 'PENDING_APPROVAL' || ds === 'MATERIAL_REQUESTED') {
    return { stage: 'Delivery Approval', owner: 'Area Head / Super Admin' };
  }
  if (!lead.deliveryVendorSetupDone) {
    return { stage: 'Vendor Setup', owner: 'Delivery Team' };
  }
  // Vendor setup done, no delivery request created yet — delivery team needs
  // to raise a material request.
  return { stage: 'Material Request — Pending', owner: 'Delivery Team' };
}

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

  // Delivery pipeline — the lead has been pushed to installation. The cascade
  // walks the delivery sub-stages in reverse-chronological order so the most
  // advanced state wins.
  if (lead.pushedToInstallationAt) {
    const deliveryStage = deriveDeliveryStage(lead);
    if (deliveryStage) return deliveryStage;
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
  // OPS bucket — both quotation approval AND the post-accounts "push to
  // install" step. Once accounts approve, the lead sits waiting for OPS to
  // push it forward, so it belongs in the OPS pile, not the accounts pile.
  'OPS Approval': BUCKETS.OPS,
  'Awaiting OPS Push': BUCKETS.OPS,

  'Sales Director Approval': BUCKETS.SALES_DIRECTOR,
  'Docs Verification': BUCKETS.DOCS,
  'Accounts Verification': BUCKETS.ACCOUNTS,

  // Plan setup happens at Accounts (demo plan + actual plan creation) —
  // surface it under Accounts so admins know who's working on it.
  'Plan Creation': BUCKETS.ACCOUNTS,
  'Demo Plan': BUCKETS.ACCOUNTS,
  'Awaiting Plan Activation': BUCKETS.ACCOUNTS,

  // NOC's queue: delivery has pushed material to NOC and is awaiting an
  // engineer to be assigned, or an engineer is mid-config.
  'At NOC': BUCKETS.NOC,

  // Store's queue: material request approved, Store Manager has to allocate
  // serial numbers / dispatch stock.
  'Material Approved': BUCKETS.STORE,

  // Delivery team's queue: vendor setup, awaiting material request, request
  // in approval (sits with Area Head but the lead is still the delivery
  // team's responsibility to chase), material received, NOC done, and
  // everything from installation through customer acceptance.
  'Vendor Setup': BUCKETS.DELIVERY,
  'Material Request — Pending': BUCKETS.DELIVERY,
  'Delivery Approval': BUCKETS.DELIVERY,
  'Material Received': BUCKETS.DELIVERY,
  'Material Rejected': BUCKETS.DELIVERY,
  'NOC Completed': BUCKETS.DELIVERY,
  'Installation': BUCKETS.DELIVERY,
  'Speed Test': BUCKETS.DELIVERY,
  'Customer Acceptance': BUCKETS.DELIVERY,
  'Delivery Completed': BUCKETS.DELIVERY,

  'Dropped': BUCKETS.DROPPED,
  'Not Feasible': BUCKETS.DROPPED,
};

/**
 * Resolve the bucket for a lead.
 *
 * Cold leads, active customers, and dropped/not-feasible leads all map to
 * non-visible buckets and get filtered out of the admin Buckets view —
 * they're either parked, fully done, or terminated, and have their own
 * dedicated screens (Lead Pipeline / Customer 360). Only leads currently
 * sitting in someone's working queue surface here.
 *
 * @param {Object} lead — same shape passed to deriveCurrentStage
 * @param {{stage: string}} derived — output of deriveCurrentStage
 */
export function bucketFromLead(lead, derived) {
  if (lead.isColdLead) return BUCKETS.COLD;
  if (derived.stage === 'Active Customer') return BUCKETS.ACTIVE;
  return STAGE_TO_BUCKET[derived.stage] || BUCKETS.BDM;
}
