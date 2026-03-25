import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { createServer } from 'http';
import rateLimit from 'express-rate-limit';

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
import { auth } from './middleware/auth.js';
import { initializeSocket } from './sockets/index.js';
import { startFollowUpReminderJob } from './jobs/followUpReminder.js';
import { startInvoiceGenerationJob } from './jobs/invoiceGeneration.js';
import { startContractRenewalReminder } from './jobs/contractRenewalReminder.js';

const app = express();
const httpServer = createServer(app);

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000'];

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};
// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});

// Middleware
app.use(helmet());
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

// Prevent unhandled errors from crashing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Give time for logs to flush, then exit (let process manager restart)
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
});
