import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { getBdmList, createSamLead, listSamLeads } from '../controllers/samIntegration.controller.js';

// SAM → CRM integration endpoints. Behind staff auth + a role gate: the SAM
// software authenticates as a dedicated SAM_INTEGRATION service user
// (SUPER_ADMIN / MASTER also allowed). No new auth scheme — the service
// user's normal CRM JWT works as-is.

const router = express.Router();

router.use(auth);
router.use(requireRole('SAM_INTEGRATION', 'SUPER_ADMIN', 'MASTER'));

// Dropdown source for the SAM "Create Lead" form.
router.get('/bdms', getBdmList);

// Lead creation + assignment in one synchronous call.
router.post('/leads', createSamLead);

// SAM's "My Leads" / team-wide view — current owner + status of every
// SAM-dispatched lead. Polled on page-open, no webhook needed.
router.get('/leads', listSamLeads);

export default router;
