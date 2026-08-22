import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { auth, requireRole } from '../middleware/auth.js';
import { requireApiKey } from './websiteLead.routes.js';
import {
  submitContactMessage,
  listContactMessages,
  markContactMessageRead
} from '../controllers/contactMessage.controller.js';

// ─── Public intake (mounted at /api/public/contact-messages, no staff auth) ──

const intakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' }
});

export const publicContactMessageRouter = Router();
publicContactMessageRouter.post('/', intakeLimiter, requireApiKey, submitContactMessage);

// ─── Management (mounted at /api/contact-messages, staff auth) ───────────────

export const contactMessageRouter = Router();
contactMessageRouter.use(auth);
contactMessageRouter.get('/list', requireRole('MASTER', 'ADMIN', 'SALES_DIRECTOR', 'SUPER_ADMIN'), listContactMessages);
contactMessageRouter.post('/:id/read', requireRole('MASTER', 'ADMIN', 'SALES_DIRECTOR', 'SUPER_ADMIN'), markContactMessageRead);
