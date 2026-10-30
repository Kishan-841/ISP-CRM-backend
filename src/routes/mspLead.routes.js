import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  createMspLead,
  getMspLeads,
  resendMspLead,
  getMspLeadOptions,
} from '../controllers/mspLead.controller.js';

const router = express.Router();

router.use(auth);

// Role checks live in the controller, matching the house pattern.
router.get('/options', getMspLeadOptions);
router.get('/', getMspLeads);
router.post('/', createMspLead);
router.post('/:id/resend', resendMspLead);

export default router;
