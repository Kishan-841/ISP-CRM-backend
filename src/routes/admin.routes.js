import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { replaySamWebhook, listSamWebhooks } from '../controllers/admin.controller.js';

const router = express.Router();

// All admin routes require staff auth + SUPER_ADMIN role.
router.use(auth);
router.use(requireRole('SUPER_ADMIN'));

router.get('/sam-webhook', listSamWebhooks);
router.post('/sam-webhook/replay/:id', replaySamWebhook);

export default router;
