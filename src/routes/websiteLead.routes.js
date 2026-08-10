import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { auth, requireRole } from '../middleware/auth.js';
import { submitWebsiteLead, getWebsiteLeads } from '../controllers/websiteLead.controller.js';

// ─── Public intake router (mounted at /api/public/website-leads, no staff auth)

// The website's server calls this with the shared secret; nothing else may.
const requireApiKey = (req, res, next) => {
  const configured = process.env.WEBSITE_LEADS_API_KEY;
  if (!configured) {
    // Deliberately disabled until the key is provisioned.
    return res.status(503).json({ success: false, message: 'Website lead intake is not enabled.' });
  }
  if (req.headers['x-api-key'] !== configured) {
    return res.status(401).json({ success: false, message: 'Invalid API key.' });
  }
  next();
};

// Stricter than the global limiter — a lead form has no business bursting.
const intakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' }
});

export const publicWebsiteLeadRouter = Router();
publicWebsiteLeadRouter.post('/', intakeLimiter, requireApiKey, submitWebsiteLead);

// ─── Management router (mounted at /api/website-leads, staff auth) ───────────

export const websiteLeadRouter = Router();
websiteLeadRouter.use(auth);
websiteLeadRouter.get(
  '/list',
  requireRole('MASTER', 'ADMIN', 'SALES_DIRECTOR', 'SUPER_ADMIN'),
  getWebsiteLeads
);
