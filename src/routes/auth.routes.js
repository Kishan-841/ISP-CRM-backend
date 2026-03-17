import { Router } from 'express';
import { login, me, customerLogin } from '../controllers/auth.controller.js';
import { auth } from '../middleware/auth.js';

const router = Router();

router.post('/login', login);
router.post('/customer-login', customerLogin);
router.get('/me', auth, me);

export default router;
