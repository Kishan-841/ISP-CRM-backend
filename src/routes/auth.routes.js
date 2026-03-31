import { Router } from 'express';
import { login, me, customerLogin, resetPassword } from '../controllers/auth.controller.js';
import { auth } from '../middleware/auth.js';

const router = Router();

router.post('/login', login);
router.post('/reset-password', resetPassword);
router.post('/customer-login', customerLogin);
router.get('/me', auth, me);

export default router;
