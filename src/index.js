import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { createServer } from 'http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import campaignRoutes from './routes/campaign.routes.js';
import productRoutes from './routes/product.routes.js';
import leadRoutes from './routes/lead.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import emailRoutes from './routes/email.routes.js';
import vendorRoutes from './routes/vendor.routes.js';
import inventoryRoutes from './routes/inventory.routes.js';
import storeRoutes from './routes/store.routes.js';
import publicUploadRoutes from './routes/publicUpload.routes.js';
import { publicWebsiteLeadRouter, websiteLeadRouter } from './routes/websiteLead.routes.js';
import deliveryRequestRoutes from './routes/deliveryRequest.routes.js';
import invoiceRoutes from './routes/invoice.routes.js';
import creditNoteRoutes from './routes/creditNote.routes.js';
import ledgerRoutes from './routes/ledger.routes.js';
import samRoutes from './routes/sam.routes.js';
import accountsReportRoutes from './routes/accountsReport.routes.js';
import storeReportRoutes from './routes/storeReport.routes.js';
import accountsDashboardRoutes from './routes/accountsDashboard.routes.js';
import complaintRoutes from './routes/complaint.routes.js';
import complaintCategoryRoutes from './routes/complaintCategory.routes.js';
import complaintCloseOptionRoutes from './routes/complaintCloseOption.routes.js';
import customer360Routes from './routes/customer360.routes.js';
import customerRoutes from './routes/customer.routes.js';
import serviceOrderRoutes from './routes/serviceOrder.routes.js';
import customerImportRoutes from './routes/customerImport.routes.js';
import legacyCustomerRoutes from './routes/legacyCustomer.routes.js';
import popLocationRoutes from './routes/popLocation.routes.js';
import proxyRoutes from './routes/proxy.routes.js';
import { nexusRouter, customerNexusRouter } from './routes/nexus.routes.js';
import adminRoutes from './routes/admin.routes.js';
import auditRoutes from './routes/audit.routes.js';
import commercialChangeRoutes from './routes/commercialChange.routes.js';
import samWebhookInboundRoutes from './routes/samWebhookInbound.routes.js';
import samIntegrationRoutes from './routes/samIntegration.routes.js';
import { auth } from './middleware/auth.js';
import { initializeSocket } from './sockets/index.js';
import { startFollowUpReminderJob } from './jobs/followUpReminder.js';
import { startInvoiceGenerationJob } from './jobs/invoiceGeneration.js';
import { startContractRenewalReminder } from './jobs/contractRenewalReminder.js';
import { startDemoPlanExpiryJob } from './jobs/demoPlanExpiry.js';
import { startMeetingReminderJob } from './jobs/meetingReminder.js';
import { startFollowUpPopupJob } from './jobs/followUpPopupReminder.js';
import { startSamVisitReminderJob } from './jobs/samVisitReminder.js';
import { startComplaintTatReminderJob } from './jobs/complaintTatReminder.js';
import { startInvoiceDueReminderJob } from './jobs/invoiceDueReminder.js';
import { startSamWebhookRetryJob } from './jobs/samWebhookRetry.js';

// Fail fast on missing critical env vars — much better than silent runtime
// auth failures hours later. DATABASE_URL is validated by Prisma on first
// query; these are the ones that would otherwise crash mid-request.
const REQUIRED_ENV_VARS = ['JWT_SECRET', 'DATABASE_URL'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missingEnvVars.length) {
  console.error(`FATAL: Missing required env vars: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000'];

// Vercel preview allowlist: the project name must be a PREFIX of the
// hostname, otherwise anyone who creates a vercel project containing the
// string (e.g. `evil-isp-crm-frontend.vercel.app`) would pass CORS and
// be able to send credentialed cross-origin requests.
const VERCEL_PROJECT_NAME = process.env.VERCEL_PROJECT_NAME || 'isp-crm-frontend';
const vercelOriginRegex = new RegExp(
  `^https://${VERCEL_PROJECT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-[a-z0-9-]+)?\\.vercel\\.app$`
);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, etc.)
    if (!origin) return callback(null, true);
    // Check exact match
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow Vercel preview URLs that match our project name as a prefix
    if (vercelOriginRegex.test(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // x-api-key: the public website's enquiry forms post directly from the
  // visitor's browser to /api/public/website-leads/* with this header
  // (accepted trade-off: the key is visible in page source; it can only
  // create leads, and the intake rate limit + validation still apply).
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true
};
// Rate limiting — the default of 100/min was too tight for a real CRM
// session: a single dashboard load fires sidebar counts, notifications,
// queue fetches, and paginated lists; open two tabs on a shared office
// NAT and legitimate users hit the cap. Defaults now scale for that,
// and RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS let prod tune without code
// changes. Authenticated user requests keyed per-user (via the JWT's
// userId) so one heavy user doesn't starve everyone behind the same IP.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 600;

const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
  keyGenerator: (req, res) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      // Use JWT subject if we can decode it — no verification needed here,
      // the downstream auth middleware verifies for real. This is only a
      // rate-limit bucket key, and a spoofed token just shares someone
      // else's bucket (hurts the spoofer, not us).
      try {
        const payload = auth.slice(7).split('.')[1];
        if (payload) {
          const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
          if (decoded?.userId) return `user:${decoded.userId}`;
        }
      } catch { /* fall through to IP */ }
    }
    // ipKeyGenerator handles IPv6 prefix collapsing per the library's
    // guidance — a plain req.ip bucket would let IPv6 users bypass.
    return ipKeyGenerator(req, res);
  },
});

// Trust the first proxy (nginx in production Docker) so req.ip resolves
// to the real client IP via X-Forwarded-For rather than the container IP.
// Required for the audit log to capture meaningful IPs.
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  // Allow cross-origin iframes to embed our responses (needed for the file
  // proxy that serves PDFs inline to the frontend's iframe).
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors(corsOptions));
// `verify` stashes the literal request bytes on req.rawBody so signed
// inbound webhooks (e.g. SAM → /api/webhooks/sam/...) can re-derive the HMAC
// without re-serialising req.body (key order would diverge and break the
// signature for any non-trivial payload).
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use('/api', generalLimiter);

// Serve uploaded documents — requires authentication
app.use('/uploads', auth, express.static(path.join(process.cwd(), 'uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/products', productRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/website-leads', websiteLeadRouter);
app.use('/api/notifications', notificationRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/delivery-requests', deliveryRequestRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/credit-notes', creditNoteRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/sam', samRoutes);
app.use('/api/accounts-reports', accountsReportRoutes);
app.use('/api/store-reports', storeReportRoutes);
app.use('/api/accounts-dashboard', accountsDashboardRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/complaint-categories', complaintCategoryRoutes);
app.use('/api/complaint-close-options', complaintCloseOptionRoutes);
app.use('/api/customer-360', customer360Routes);
app.use('/api/customer', customerRoutes);
app.use('/api/service-orders', serviceOrderRoutes);
app.use('/api/customer-import', customerImportRoutes);
app.use('/api/legacy-customers', legacyCustomerRoutes);
app.use('/api/pop-locations', popLocationRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/nexus', nexusRouter);
app.use('/api/customer/nexus', customerNexusRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/commercial-changes', commercialChangeRoutes);
app.use('/api/integrations/sam', samIntegrationRoutes);

// Public routes (no auth required)
app.use('/api/public/upload', publicUploadRoutes);
// Website enquiry-form intake — no staff auth; the route middleware checks
// the shared x-api-key against WEBSITE_LEADS_API_KEY.
app.use('/api/public/website-leads', publicWebsiteLeadRouter);
// Inbound webhook receivers — no staff auth; each handler verifies its own
// signature header against SAM_WEBHOOK_SECRET before reading the payload.
app.use('/api/webhooks/sam', samWebhookInboundRoutes);

// Initialize Socket.io
initializeSocket(httpServer);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ message: 'Internal server error.' });
});

// Unhandled errors leave the process in an unknown state — log them and
// exit so the process manager (Docker / pm2 / systemd) can restart us
// fresh. Silently continuing after an unhandled rejection risks corrupted
// in-memory state, half-finished transactions, and cascading failures
// that are extremely hard to diagnose.
process.on('unhandledRejection', (reason) => {
  console.error('FATAL: Unhandled Promise Rejection:', reason);
  // Give logs 1s to flush before exiting so the diagnostic reaches stderr.
  setTimeout(() => process.exit(1), 1000);
});

process.on('uncaughtException', (error) => {
  console.error('FATAL: Uncaught Exception:', error);
  setTimeout(() => process.exit(1), 1000);
});

const PORT = process.env.PORT || 5001;

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.io enabled for real-time notifications`);

  // Start background jobs
  startFollowUpReminderJob();
  startInvoiceGenerationJob();
  startContractRenewalReminder();
  startDemoPlanExpiryJob();
  startMeetingReminderJob();
  startFollowUpPopupJob();
  startSamVisitReminderJob();
  startComplaintTatReminderJob();
  startInvoiceDueReminderJob();
  startSamWebhookRetryJob();
});
