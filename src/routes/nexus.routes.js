import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { customerAuth } from '../middleware/customerAuth.js';
import {
  askStaff,
  askCustomer,
  getMyConversations,
  getConversation,
  listKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  getQuotaStaff,
  getQuotaCustomer,
} from '../controllers/nexus.controller.js';

const router = Router();

// Staff chat
router.post('/ask', auth, askStaff);
router.get('/quota', auth, getQuotaStaff);
router.get('/conversations', auth, getMyConversations);
router.get('/conversations/:id', auth, getConversation);

// Knowledge base admin (SUPER_ADMIN only)
router.get('/knowledge', auth, requireRole('SUPER_ADMIN'), listKnowledge);
router.post('/knowledge', auth, requireRole('SUPER_ADMIN'), createKnowledge);
router.put('/knowledge/:id', auth, requireRole('SUPER_ADMIN'), updateKnowledge);
router.delete('/knowledge/:id', auth, requireRole('SUPER_ADMIN'), deleteKnowledge);

// Customer portal chat
const customerRouter = Router();
customerRouter.post('/ask', customerAuth, askCustomer);
customerRouter.get('/quota', customerAuth, getQuotaCustomer);
customerRouter.get('/conversations/:id', customerAuth, getConversation);

export { router as nexusRouter, customerRouter as customerNexusRouter };
