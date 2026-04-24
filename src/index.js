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
import deliveryRequestRoutes from './routes/deliveryRequest.routes.js';
import invoiceRoutes from './routes/invoice.routes.js';
import creditNoteRoutes from './routes/creditNote.routes.js';
import ledgerRoutes from './routes/ledger.routes.js';
import samRoutes from './routes/sam.routes.js';
import accountsReportRoutes from './routes/accountsReport.routes.js';
import accountsDashboardRoutes from './routes/accountsDashboard.routes.js';
import complaintRoutes from './routes/complaint.routes.js';
import complaintCategoryRoutes from './routes/complaintCategory.routes.js';
import complaintCloseOptionRoutes from './routes/complaintCloseOption.routes.js';
import customer360Routes from './routes/customer360.routes.js';
import customerRoutes from './routes/customer.routes.js';
import serviceOrderRoutes from './routes/serviceOrder.routes.js';
import customerImportRoutes from './routes/customerImport.routes.js';
import popLocationRoutes from './routes/popLocation.routes.js';
import proxyRoutes from './routes/proxy.routes.js';
import { nexusRouter, customerNexusRouter } from './routes/nexus.routes.js';
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
  allowedHeaders: ['Content-Type', 'Authorization'],
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

// Middleware
app.use(helmet({
  // Allow cross-origin iframes to embed our responses (needed for the file
  // proxy that serves PDFs inline to the frontend's iframe).
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use('/api', generalLimiter);

// Serve uploaded documents — requires authentication
app.use('/uploads', auth, express.static(path.join(process.cwd(), 'uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/products', productRoutes);
app.use('/api/leads', leadRoutes);
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
app.use('/api/accounts-dashboard', accountsDashboardRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/complaint-categories', complaintCategoryRoutes);
app.use('/api/complaint-close-options', complaintCloseOptionRoutes);
app.use('/api/customer-360', customer360Routes);
app.use('/api/customer', customerRoutes);
app.use('/api/service-orders', serviceOrderRoutes);
app.use('/api/customer-import', customerImportRoutes);
app.use('/api/pop-locations', popLocationRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/nexus', nexusRouter);
app.use('/api/customer/nexus', customerNexusRouter);

// Public routes (no auth required)
app.use('/api/public/upload', publicUploadRoutes);

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
});
