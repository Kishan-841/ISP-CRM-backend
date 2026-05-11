import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  replaySamWebhook,
  listSamWebhooks,
  listAuditLog,
  listAuditLogActors,
} from '../controllers/admin.controller.js';

const router = express.Router();

// All admin routes require staff auth + SUPER_ADMIN. The requireRole
// middleware also auto-passes SALES_DIRECTOR (view-parity) and MASTER
// (universal bypass), so audit-log read access lines up with how the
// rest of the admin surface already works.
router.use(auth);
router.use(requireRole('SUPER_ADMIN'));

router.get('/sam-webhook', listSamWebhooks);
router.post('/sam-webhook/replay/:id', replaySamWebhook);

router.get('/audit-log', listAuditLog);
router.get('/audit-log/actors', listAuditLogActors);

export default router;
