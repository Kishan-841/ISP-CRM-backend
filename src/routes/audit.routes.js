import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { listEvents } from '../controllers/audit.controller.js';

const router = Router();
router.use(auth);

router.get('/events', listEvents);

export default router;
