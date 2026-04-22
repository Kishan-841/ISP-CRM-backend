import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { uploadToCloudinary, uploadTypedDocument } from '../config/cloudinary.js';
import {
  getLeads,
  getLead,
  convertToLead,
  createDirectLead,
  getBDMColdLeads,
  completeColdLead,
  createOpportunity,
  setupDeliveryVendor,
  acknowledgeDeliveryDocs,
  updateLead,
  deleteLead,
  getBDMUsers,
  getTeamLeaders,
  reassignLeadToBDM,
  bulkReassignLeadsToBDM,
  transferAllLeads,
  checkLeadExists,
  createSelfGeneratedLead,
  // BDM functions
  getBDMQueue,
  getBDMScheduledMeetings,
  updateLeadLocation,
  bdmDisposition,
  addMOM,
  getLeadMOMs,
  updateMOM,
  deleteMOM,
  getBDMFollowUps,
  getBDMDashboardStats,
  getBDMSidebarCounts,
  getBDMReports,
  getBDMDeliveryCompleted,
  pushToDocsVerification,
  // Typed Document functions
  uploadDocument,
  removeDocument,
  getLeadDocuments,
  pushToDocsVerificationTyped,
  // Login stage
  markLoginComplete,
  // Feasibility Team functions
  getFeasibilityTeamUsers,
  getFeasibilityQueue,
  getFeasibilityReviewHistory,
  feasibilityDisposition,
  // Docs Team functions
  getDocsTeamQueue,
  getDocsTeamReviewHistory,
  docsTeamDisposition,
  sendBackToBDM,
  // OPS Team functions
  getOpsTeamQueue,
  getOpsTeamReviewHistory,
  opsTeamDisposition,
  getOpsTeamSidebarCounts,
  getOpsInstallationQueue,
  // Super Admin 2 functions
  getSuperAdmin2Queue,
  getSuperAdmin2History,
  superAdmin2Disposition,
  getSuperAdmin2SidebarCounts,
  // Accounts Team functions
  getAccountsTeamQueue,
  getAccountsTeamReviewHistory,
  updateFinancialDetails,
  accountsTeamDisposition,
  updateAccountsDetails,
  getAccountsVerifiedLeads,
  // Installation functions
  pushToInstallation,
  // Delivery Team functions
  getDeliveryQueue,
  getDeliveryLeadDetails,
  assignDeliveryLead,
  updateDeliveryProducts,
  updateDeliveryStatus,
  startInstallation,
  getDeliveryReport,
  // Customer Account functions
  createCustomerUser,
  assignCustomerIP,
  configureCustomerSwitch,
  generateCircuitId,
  // NOC Team functions
  getNocQueue,
  getNocLeadDetails,
  nocAssignLead,
  getNocTeamStats,
  nocPushToDelivery,
  // Speed Test & Customer Acceptance functions
  uploadSpeedTest,
  bypassSpeedTest,
  customerAcceptance,
  retryCustomerAcceptance,
  getSpeedTestDetails,
  // Demo Plan Assignment functions (Accounts)
  getDemoPlanQueue,
  assignDemoPlan,
  toggleDemoPlanStatus,
  // Actual Plan functions (Accounts)
  getCompletedLeadsQueue,
  createActualPlan,
  toggleActualPlanStatus,
  upgradeActualPlan,
  degradeActualPlan,
  getPlanUpgradeHistory,
  // Testing / Development utilities
  bypassPipelineApproval,
  // Vendor PO functions (Accounts Team)
  getPOEligibleLeads,
  createVendorPO,
  getVendorPOs,
  getVendorPO,
  getVendorPOApprovalQueue,
  approveVendorPO,
  rejectVendorPO,
  sendVendorPOEmail,
  // Customer Enquiry functions
  getCustomerEnquiryQueue,
  getSAMHeadEnquiryQueue,
  assignEnquiryToISR,
  // CP Leads
  getCPLeads
} from '../controllers/lead.controller.js';
import {
  generateUploadLink,
  getUploadLinks,
  revokeUploadLink,
  setUploadMethod
} from '../controllers/publicUpload.controller.js';
import {
  getDeletionPreview,
  deleteLeadEntirelyHandler,
  getDeletionAuditList,
} from '../controllers/leadDeletion.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// ========== MASTER-ONLY LEAD DELETION ==========
// Permanently wipes a lead and every linked record. Controller enforces role.
router.get('/deletion-audit', getDeletionAuditList);
router.get('/:id/deletion-preview', getDeletionPreview);
router.post('/:id/delete-entirely', deleteLeadEntirelyHandler);

// Get BDM users for assignment dropdown (all authenticated users)
router.get('/bdm-users', getBDMUsers);

// Get BDM Team Leaders for assignment dropdown
router.get('/team-leaders', getTeamLeaders);

// Check if campaign data is already converted to lead
router.get('/check/:campaignDataId', checkLeadExists);

// ========== BDM ROUTES ==========

// CP Leads tracking (Admin + TL)
router.get('/cp-leads', getCPLeads);

// Get BDM dashboard stats
router.get('/bdm/dashboard-stats', getBDMDashboardStats);

// Get BDM sidebar counts (lightweight for sidebar badges)
router.get('/bdm/sidebar-counts', getBDMSidebarCounts);

// Get BDM calling queue (leads assigned to BDM)
router.get('/bdm/queue', getBDMQueue);

// Get BDM scheduled meetings
router.get('/bdm/meetings', getBDMScheduledMeetings);

// Get BDM follow-ups
router.get('/bdm/follow-ups', getBDMFollowUps);

// Get BDM performance reports
router.get('/bdm/reports', getBDMReports);

// Get BDM delivery completed leads
router.get('/bdm/delivery-completed', getBDMDeliveryCompleted);

// Update lead location
router.patch('/bdm/:id/location', updateLeadLocation);

// BDM call disposition (Qualified, Drop, Follow Up)
router.post('/bdm/:id/disposition', bdmDisposition);

// Cold Lead Pipeline
router.get('/bdm/cold-leads', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), getBDMColdLeads);
router.post('/bdm/cold-leads/:id/complete', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), completeColdLead);

// Create Opportunity (fast path — skip calling/meeting, straight to feasibility)
router.post('/bdm/create-opportunity', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), createOpportunity);

// Delivery vendor setup (mandatory before material request)
router.post('/delivery/:id/acknowledge-docs', requireRole('DELIVERY_TEAM', 'SUPER_ADMIN'), acknowledgeDeliveryDocs);
router.post('/delivery/:id/vendor-setup', requireRole('DELIVERY_TEAM', 'SUPER_ADMIN'), setupDeliveryVendor);

// Reassign lead from Team Leader to BDM
router.post('/bdm/bulk-reassign', requireRole('BDM_TEAM_LEADER', 'SUPER_ADMIN'), bulkReassignLeadsToBDM);
router.post('/bdm/transfer-all', requireRole('BDM_TEAM_LEADER', 'SUPER_ADMIN'), transferAllLeads);
router.post('/bdm/:id/reassign', requireRole('BDM_TEAM_LEADER', 'SUPER_ADMIN'), reassignLeadToBDM);

// Customer enquiry queue (Team Leader / Admin)
router.get('/customer-enquiries', requireRole('BDM_TEAM_LEADER', 'SUPER_ADMIN'), getCustomerEnquiryQueue);

// SAM Head customer referral enquiry routes
router.get('/sam-head/customer-enquiries', requireRole('SAM_HEAD', 'SUPER_ADMIN'), getSAMHeadEnquiryQueue);
router.post('/sam-head/assign-enquiry-to-isr', requireRole('SAM_HEAD', 'SUPER_ADMIN'), assignEnquiryToISR);

// MOM (Minutes of Meeting) routes
router.get('/:id/moms', getLeadMOMs);
router.post('/:id/mom', addMOM);
router.put('/mom/:momId', updateMOM);
router.delete('/mom/:momId', deleteMOM);

// Push to document verification (with file uploads via Cloudinary) - Legacy
router.post('/:id/push-to-verification', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), uploadToCloudinary.array('documents', 10), pushToDocsVerification);

// ========== TYPED DOCUMENT ROUTES ==========

// Upload a single typed document
router.post('/:id/documents/:documentType', uploadTypedDocument.single('document'), uploadDocument);

// Remove a typed document
router.delete('/:id/documents/:documentType', removeDocument);

// Get all documents for a lead
router.get('/:id/documents', getLeadDocuments);

// Mark login complete (customer accepted quotation)
router.post('/:id/mark-login-complete', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), markLoginComplete);

// Push to verification with typed documents validation
router.post('/:id/push-to-verification-typed', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), pushToDocsVerificationTyped);

// ========== CUSTOMER UPLOAD LINK ROUTES ==========

// Generate upload link for customer (BDM/Admin only)
router.post('/:id/upload-link', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), generateUploadLink);

// Get all upload links for a lead
router.get('/:id/upload-links', getUploadLinks);

// Revoke an upload link
router.delete('/:id/upload-links/:linkId', revokeUploadLink);

// Set document upload method (bdm or customer)
router.patch('/:id/upload-method', setUploadMethod);

// ========== END CUSTOMER UPLOAD LINK ROUTES ==========

// ========== END TYPED DOCUMENT ROUTES ==========

// ========== END BDM ROUTES ==========

// ========== FEASIBILITY TEAM ROUTES ==========

// Get Feasibility Team users for assignment dropdown
router.get('/feasibility-team-users', getFeasibilityTeamUsers);

// Get Feasibility Team queue
router.get('/feasibility-team/queue', getFeasibilityQueue);

// Get Feasibility Team review history (approved/rejected leads by current user)
router.get('/feasibility-team/history', getFeasibilityReviewHistory);

// Feasibility Team disposition (Feasible / Not Feasible)
router.post('/feasibility-team/:id/disposition', feasibilityDisposition);

// ========== END FEASIBILITY TEAM ROUTES ==========

// ========== OPS TEAM ROUTES ==========

// Get OPS Team sidebar counts
router.get('/ops-team/sidebar-counts', getOpsTeamSidebarCounts);

// Get OPS Team queue (leads pending quotation approval)
router.get('/ops-team/queue', getOpsTeamQueue);

// Get OPS Team review history (approved/rejected leads)
router.get('/ops-team/history', getOpsTeamReviewHistory);

// OPS Team disposition (Approve / Reject)
router.post('/ops-team/:id/disposition', opsTeamDisposition);

// OPS Team installation assignment queue
router.get('/ops-team/installation-queue', getOpsInstallationQueue);

// ========== END OPS TEAM ROUTES ==========

// ========== SUPER ADMIN 2 ROUTES ==========

// Get Super Admin 2 sidebar counts
router.get('/super-admin2/sidebar-counts', getSuperAdmin2SidebarCounts);

// Get Super Admin 2 queue (leads pending SA2 approval after OPS approval)
router.get('/super-admin2/queue', getSuperAdmin2Queue);

// Get Super Admin 2 history (approved/rejected leads)
router.get('/super-admin2/history', getSuperAdmin2History);

// Super Admin 2 disposition (Approve / Reject)
router.post('/super-admin2/:id/disposition', superAdmin2Disposition);

// ========== END SUPER ADMIN 2 ROUTES ==========

// ========== DOCS TEAM ROUTES ==========

// Get Docs Team queue (leads pushed for document verification)
router.get('/docs-team/queue', getDocsTeamQueue);

// Get Docs Team review history (verified/rejected leads by current user)
router.get('/docs-team/history', getDocsTeamReviewHistory);

// Docs Team disposition (Approve / Reject)
router.post('/docs-team/:id/disposition', docsTeamDisposition);

// Send accounts-rejected lead back to BDM for re-upload
router.post('/docs-team/:id/send-to-bdm', sendBackToBDM);

// ========== END DOCS TEAM ROUTES ==========

// ========== ACCOUNTS TEAM ROUTES ==========

// Get Accounts Team queue (leads with docs approved, pending accounts verification)
router.get('/accounts-team/queue', getAccountsTeamQueue);

// Get Accounts Team review history (approved/rejected leads by current user)
router.get('/accounts-team/history', getAccountsTeamReviewHistory);

// Get accounts verified leads (history)
router.get('/accounts-team/verified', getAccountsVerifiedLeads);

// Update financial details for a lead
router.patch('/accounts-team/:id/financial', updateFinancialDetails);

// Accounts Team disposition (Approve / Reject)
router.post('/accounts-team/:id/disposition', accountsTeamDisposition);

// Update accounts details for approved leads
router.patch('/accounts-team/:id/details', updateAccountsDetails);

// ========== END ACCOUNTS TEAM ROUTES ==========

// ========== DEMO PLAN ASSIGNMENT ROUTES (ACCOUNTS TEAM) ==========

// Get leads pending demo plan assignment
router.get('/accounts-team/demo-plan/queue', getDemoPlanQueue);

// Assign demo plan to a lead
router.post('/accounts-team/:id/demo-plan', assignDemoPlan);

// Toggle demo plan active status
router.patch('/accounts-team/:id/demo-plan/toggle', toggleDemoPlanStatus);

// ========== END DEMO PLAN ASSIGNMENT ROUTES ==========

// ========== ACTUAL PLAN ROUTES (ACCOUNTS TEAM) ==========

// Get leads with customer acceptance completed (for Create Plan)
router.get('/accounts-team/actual-plan/queue', getCompletedLeadsQueue);

// Create actual plan for a lead
router.post('/accounts-team/:id/actual-plan', createActualPlan);

// Toggle actual plan active status
router.patch('/accounts-team/:id/actual-plan/toggle', toggleActualPlanStatus);

// Upgrade actual plan (mid-billing-cycle upgrade with pro-rated billing)
router.post('/accounts-team/:id/actual-plan/upgrade', upgradeActualPlan);

// Degrade actual plan (mid-billing-cycle downgrade with credit note)
router.post('/accounts-team/:id/actual-plan/degrade', degradeActualPlan);

// Get plan upgrade/downgrade history for a lead
router.get('/accounts-team/:id/actual-plan/upgrades', getPlanUpgradeHistory);

// ========== END ACTUAL PLAN ROUTES ==========

// ========== VENDOR PO ROUTES (ACCOUNTS TEAM) ==========

// Get leads eligible for PO creation (accounts verified + approved vendor)
router.get('/accounts-team/vendor-po/eligible-leads', getPOEligibleLeads);

// Create vendor PO
router.post('/accounts-team/vendor-po', createVendorPO);

// List vendor POs (accounts team sees own, admin sees all)
router.get('/accounts-team/vendor-pos', getVendorPOs);

// Get single vendor PO
router.get('/accounts-team/vendor-po/:id', getVendorPO);

// Admin: Vendor PO approval queue
router.get('/admin/vendor-po-approval', getVendorPOApprovalQueue);

// Admin: Approve vendor PO
router.post('/admin/vendor-po/:id/approve', approveVendorPO);

// Admin: Reject vendor PO
router.post('/admin/vendor-po/:id/reject', rejectVendorPO);

// Send vendor PO email to vendor
router.post('/accounts-team/vendor-po/:id/send-email', sendVendorPOEmail);

// ========== END VENDOR PO ROUTES ==========

// ========== INSTALLATION ROUTES ==========

// Push lead to installation team (BDM only, after accounts approval)
router.post('/:id/push-to-installation', pushToInstallation);

// ========== END INSTALLATION ROUTES ==========

// ========== TESTING / DEVELOPMENT UTILITIES ==========

// Fast-track bypass - automatically approves all pipeline stages (SUPER_ADMIN only)
router.post('/:id/bypass-pipeline', requireRole('SUPER_ADMIN'), bypassPipelineApproval);

// ========== END TESTING UTILITIES ==========

// ========== DELIVERY TEAM ROUTES ==========

// Get delivery report
router.get('/delivery-team/report', getDeliveryReport);

// Get Delivery Team queue (leads pushed to installation)
router.get('/delivery-team/queue', getDeliveryQueue);

// Get detailed lead info for delivery team
router.get('/delivery-team/:id/details', getDeliveryLeadDetails);

// Assign lead to delivery team member
router.post('/delivery-team/:id/assign', assignDeliveryLead);

// Update delivery products (editable quantities)
router.patch('/delivery-team/:id/products', updateDeliveryProducts);

// Update delivery status
router.patch('/delivery-team/:id/status', updateDeliveryStatus);

// Start installation with material verification
router.patch('/delivery-team/:id/start-installation', startInstallation);

// ========== SPEED TEST & CUSTOMER ACCEPTANCE ROUTES ==========

// Upload speed test screenshots (2 images)
router.post('/delivery-team/:id/speed-test', uploadToCloudinary.fields([
  { name: 'speedTest', maxCount: 1 },
  { name: 'latencyTest', maxCount: 1 }
]), uploadSpeedTest);

// Bypass speed test (testing only - skips file upload)
router.post('/delivery-team/:id/speed-test-bypass', bypassSpeedTest);

// Get speed test details
router.get('/delivery-team/:id/speed-test', getSpeedTestDetails);

// Record customer acceptance (accept/reject) with optional screenshot upload
router.post('/delivery-team/:id/customer-acceptance', uploadToCloudinary.single('acceptanceScreenshot'), customerAcceptance);

// Retry after customer rejection — reset to speed test stage
router.post('/delivery-team/:id/retry-acceptance', retryCustomerAcceptance);

// ========== END SPEED TEST & CUSTOMER ACCEPTANCE ROUTES ==========

// ========== CUSTOMER ACCOUNT ROUTES ==========

// Create customer user account for lead
router.post('/delivery-team/:id/customer-account', createCustomerUser);

// Assign IP address to customer
router.patch('/delivery-team/:id/customer-ip', assignCustomerIP);

// Configure switch port for customer
router.patch('/delivery-team/:id/customer-switch', configureCustomerSwitch);

// ========== END CUSTOMER ACCOUNT ROUTES ==========

// ========== END DELIVERY TEAM ROUTES ==========

// ========== NOC TEAM ROUTES ==========

// Get NOC queue (leads pushed to NOC)
router.get('/noc/queue', getNocQueue);

// NOC Head: team stats
router.get('/noc/team-stats', getNocTeamStats);

// NOC Head: assign lead to NOC user
router.post('/noc/:id/assign', nocAssignLead);

// Get NOC lead details
router.get('/noc/:id/details', getNocLeadDetails);

// Create customer user account (NOC creates this)
router.post('/noc/:id/customer-account', createCustomerUser);

// Assign IP address(es) to customer
router.patch('/noc/:id/customer-ip', assignCustomerIP);

// Generate Circuit ID (completes NOC configuration)
router.post('/noc/:id/generate-circuit', generateCircuitId);

// Push to Delivery (after NOC configuration is complete)
router.post('/noc/:id/push-to-delivery', nocPushToDelivery);

// Configure switch port for customer (deprecated - kept for backward compatibility)
router.patch('/noc/:id/customer-switch', configureCustomerSwitch);

// ========== END NOC TEAM ROUTES ==========

// Get all leads (role-based filtering in controller)
router.get('/', getLeads);

// Get single lead
router.get('/:id', getLead);

// Convert campaign data to lead
router.post('/convert', convertToLead);
router.post('/bdm/direct-add', requireRole('BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'), createDirectLead);

// Create self-generated lead (ISR creates their own lead)
router.post('/self-generate', createSelfGeneratedLead);

// Update lead (Admin and assigned BDM can update)
router.put('/:id', updateLead);

// Delete lead (Admin only)
router.delete('/:id', requireRole('SUPER_ADMIN'), deleteLead);

export default router;
