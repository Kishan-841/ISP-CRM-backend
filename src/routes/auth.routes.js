import { Router } from 'express';
import { login, me, customerLogin, resetPassword, logout } from '../controllers/auth.controller.js';
import { auth } from '../middleware/auth.js';

const router = Router();

router.post('/login', login);
router.post('/reset-password', resetPassword);
router.post('/customer-login', customerLogin);
router.get('/me', auth, me);
router.post('/logout', auth, logout);

export default router;
