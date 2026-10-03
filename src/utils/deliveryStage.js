/**
 * Derive a lead's delivery board bucket.
 *
 * Extracted from getDeliveryQueue so it can be tested and reused. The
 * FRONTEND KEEPS ITS OWN COPY at
 * frontend/app/dashboard/delivery-queue/page.js - the two repos share no
 * package, so any change here must be mirrored there or leads land in
 * different tabs depending on who asks.
 *
 * @param {object} lead - needs cancelledAt, deliveryStatus, deliveryRequests[],
 *                        deliveryVendorSetupDone
 * @returns {string} bucket id
 */
export function getLeadStage(lead) {
  if (!lead) return 'vendor_setup';

  // Cancelled is terminal and checked first: a cancelled lead may still carry
  // whatever deliveryStatus and open request it had at the moment it died.
  if (lead.cancelledAt || lead.deliveryStatus === 'CANCELLED') return 'cancelled';

  const status = lead.deliveryStatus;
  if (status === 'COMPLETED') return 'completed';
  if (status === 'MATERIAL_REJECTED') return 'material_rejected';
  if (status === 'REJECTED') return 'rejected';
  if (status === 'CUSTOMER_ACCEPTANCE') return 'customer_acceptance';
  if (status === 'SPEED_TEST') return 'speed_test';
  if (status === 'DEMO_PLAN_PENDING') return 'demo_plan_pending';
  if (status === 'INSTALLING') return 'installing';
  if (status === 'ACTIVATION_READY') return 'noc_completed';
  if (status === 'MATERIAL_RECEIVED') return 'material_received';
  if (status === 'PUSHED_TO_NOC') return 'pushed_to_noc';

  const activeRequest = lead.deliveryRequests?.[0];
  if (activeRequest && activeRequest.status !== 'CANCELLED') {
    if (activeRequest.status === 'ASSIGNED' && !activeRequest.pushedToNocAt) return 'material_received';
    if (activeRequest.pushedToNocAt) return 'pushed_to_noc';
    if (['PENDING_APPROVAL', 'APPROVED'].includes(activeRequest.status)) return 'material_requested';
  }

  if (!lead.deliveryVendorSetupDone) return 'vendor_setup';
  return 'pending';
}
