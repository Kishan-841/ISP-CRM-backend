import prisma from '../config/db.js';
import { hasAnyRole } from '../utils/roleHelper.js';
import { asyncHandler, parsePagination, paginatedResponse } from '../utils/controllerHelper.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';
import { notifyAllByRole } from '../services/notification.service.js';

/**
 * Legacy Customer Onboarding — standalone Accounts ↔ Delivery flow.
 *
 * Isolated from the Lead pipeline: these rows exist purely to showcase old /
 * existing customer data on the Accounts dashboard. No Lead / CampaignData /
 * SAMAssignment is ever created. Only ACCOUNTS_TEAM and DELIVERY_TEAM (and
 * SUPER_ADMIN for oversight) interact with these records.
 */

const VALID_BILLING_CYCLES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];
const ACCOUNTS_ROLES = ['ACCOUNTS_TEAM', 'SUPER_ADMIN'];
const DELIVERY_ROLES = ['DELIVERY_TEAM', 'SUPER_ADMIN'];

/** Throw a guard error honored by asyncHandler. */
const fail = (statusCode, message) => {
  throw Object.assign(new Error(message), { statusCode });
};

/** Clean a phone number down to its last 10 digits. */
const cleanPhone = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

/** Parse to float or return null (lenient — legacy data may be incomplete). */
const toFloat = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
};

/** Parse to int or return null. */
const toInt = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/** Trim a string field or return null. */
const toStr = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Parse a date string or return null (invalid dates become null). */
const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Validate & normalise one create row. Lenient by design: only name + phone are
 * required (legacy records are often partial). Billing fields are intentionally
 * NOT collected here — they are filled in the second half of the flow.
 *
 * @returns {{ valid: boolean, errors: string[], cleaned: object }}
 */
const validateCreateRow = (row, rowIndex) => {
  const errors = [];

  const name = toStr(row.name);
  if (!name) errors.push(`Row ${rowIndex}: "name" is required`);

  const phone = cleanPhone(row.phone);
  if (phone.length !== 10) {
    errors.push(`Row ${rowIndex}: phone must be 10 digits, got "${row.phone ?? ''}"`);
  }

  // IP addresses: comma-separated string → array
  const ipAddresses = String(row.ipAddresses ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);

  const cleaned = {
    name,
    firstName: toStr(row.firstName),
    lastName: toStr(row.lastName),
    phone,
    email: toStr(row.email),
    companyName: toStr(row.companyName),
    city: toStr(row.city),
    state: toStr(row.state),
    arcAmount: toFloat(row.arcAmount),
    otcAmount: toFloat(row.otcAmount),
    gstNumber: toStr(row.gstNumber),
    legalName: toStr(row.legalName),
    panNumber: toStr(row.panNumber),
    tanNumber: toStr(row.tanNumber),
    installationAddress: toStr(row.installationAddress),
    installationPincode: toStr(row.installationPincode),
    billingAddress: toStr(row.billingAddress),
    billingPincode: toStr(row.billingPincode),
    poNumber: toStr(row.poNumber),
    poExpiryDate: toDate(row.poExpiryDate),
    numberOfIPs: toInt(row.numberOfIPs),
    ipAddresses,
    bandwidth: toStr(row.bandwidth),
    username: toStr(row.username),
    techInchargeMobile: toStr(row.techInchargeMobile),
    techInchargeEmail: toStr(row.techInchargeEmail),
    accountsInchargeMobile: toStr(row.accountsInchargeMobile),
    accountsInchargeEmail: toStr(row.accountsInchargeEmail),
    bdmName: toStr(row.bdmName),
    serviceManager: toStr(row.serviceManager),
    samExecutiveName: toStr(row.samExecutiveName),
  };

  return { valid: errors.length === 0, errors, cleaned };
};

/**
 * Next sequential customer code (LCUST-#####) within a transaction.
 * Good enough for a showcase table; Serializable isolation guards concurrency.
 */
const getNextCustomerCode = async (tx) => {
  const latest = await tx.legacyCustomer.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { customerCode: true },
  });
  let next = 1;
  if (latest?.customerCode) {
    const match = latest.customerCode.match(/LCUST-(\d+)/);
    if (match) next = parseInt(match[1], 10) + 1;
  }
  return `LCUST-${String(next).padStart(5, '0')}`;
};

/** Notify Delivery that a new legacy customer awaits a delivery date. */
const notifyDelivery = async () => {
  try {
    await emitSidebarRefreshByRole('DELIVERY_TEAM');
    await notifyAllByRole(
      'DELIVERY_TEAM',
      'LEGACY_CUSTOMER_DELIVERY',
      'Customer Onboarding',
      'A legacy customer is pending a delivery date.'
    );
  } catch (e) {
    console.error('notifyDelivery error:', e);
  }
};

/** Notify Accounts that a legacy customer returned for billing. */
const notifyAccountsBilling = async (customerCode) => {
  try {
    await emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    await notifyAllByRole(
      'ACCOUNTS_TEAM',
      'LEGACY_CUSTOMER_BILLING',
      'Pending Billing',
      `Legacy customer ${customerCode} has a delivery date — billing pending.`
    );
  } catch (e) {
    console.error('notifyAccountsBilling error:', e);
  }
};

// ─── Accounts: create ────────────────────────────────────────────────────────

/**
 * POST /api/legacy-customers/single
 * Accounts creates one legacy customer (no billing fields → PENDING_DELIVERY).
 */
export const createSingle = asyncHandler(async function createSingle(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  const { valid, errors, cleaned } = validateCreateRow(req.body, 1);
  if (!valid) fail(400, errors.join('; '));

  const dup = await prisma.legacyCustomer.findFirst({ where: { phone: cleaned.phone } });
  if (dup) fail(409, `Phone ${cleaned.phone} already exists (${dup.customerCode}).`);

  const created = await prisma.$transaction(
    async (tx) => {
      const customerCode = await getNextCustomerCode(tx);
      return tx.legacyCustomer.create({
        data: { ...cleaned, customerCode, createdById: req.user.id },
      });
    },
    { isolationLevel: 'Serializable', timeout: 30000 }
  );

  await notifyDelivery();

  res.json({ message: 'Customer added. Pushed to delivery.', data: created });
});

/**
 * POST /api/legacy-customers/bulk
 * Accounts bulk-imports from Excel. Body: { rows: [...] }.
 */
export const createBulk = asyncHandler(async function createBulk(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    fail(400, 'No data provided. Expected { rows: [...] }.');
  }

  const invalidRows = [];
  const validRows = [];
  rows.forEach((row, i) => {
    const { valid, errors, cleaned } = validateCreateRow(row, i + 1);
    if (valid) validRows.push({ rowIndex: i + 1, cleaned });
    else invalidRows.push({ row: i + 1, errors });
  });

  // Skip phones already present (in DB or duplicated within the upload itself).
  const duplicateRows = [];
  const importable = [];
  const phones = validRows.map((r) => r.cleaned.phone);
  const existing = await prisma.legacyCustomer.findMany({
    where: { phone: { in: phones } },
    select: { phone: true },
  });
  const seen = new Set(existing.map((e) => e.phone));
  for (const r of validRows) {
    if (seen.has(r.cleaned.phone)) {
      duplicateRows.push({ row: r.rowIndex, phone: r.cleaned.phone, reason: 'Phone already exists' });
    } else {
      seen.add(r.cleaned.phone);
      importable.push(r);
    }
  }

  const imported = [];
  if (importable.length > 0) {
    await prisma.$transaction(
      async (tx) => {
        let nextSerial = null;
        const base = await getNextCustomerCode(tx);
        nextSerial = parseInt(base.match(/LCUST-(\d+)/)[1], 10);
        for (const { rowIndex, cleaned } of importable) {
          const customerCode = `LCUST-${String(nextSerial).padStart(5, '0')}`;
          const created = await tx.legacyCustomer.create({
            data: { ...cleaned, customerCode, createdById: req.user.id },
          });
          imported.push({ row: rowIndex, customerCode: created.customerCode, company: cleaned.companyName });
          nextSerial++;
        }
      },
      { isolationLevel: 'Serializable', timeout: 120000 }
    );
    await notifyDelivery();
  }

  res.json({
    message: `Imported ${imported.length} customers.`,
    invalidRows,
    duplicateRows,
    imported,
    summary: {
      total: rows.length,
      valid: validRows.length,
      invalid: invalidRows.length,
      duplicates: duplicateRows.length,
      imported: imported.length,
    },
  });
});

/**
 * GET /api/legacy-customers/template
 * Excel template headers + field guidance (no billing columns).
 */
export const getTemplate = asyncHandler(async function getTemplate(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  res.json({
    message: 'Template retrieved.',
    data: {
      notes: [
        'name and phone are required; all other fields are optional.',
        'phone is reduced to its last 10 digits automatically.',
        'ipAddresses: comma-separated list (e.g. "1.1.1.1, 2.2.2.2").',
        'Bill Date and Billing Cycle are NOT entered here — they are filled after delivery.',
        'Duplicate phones (already in the system) are skipped.',
      ],
    },
  });
});

// ─── Delivery: queue + set delivery date ─────────────────────────────────────

/**
 * GET /api/legacy-customers/delivery-queue
 * Delivery sees customers awaiting a delivery date (PENDING_DELIVERY).
 */
export const getDeliveryQueue = asyncHandler(async function getDeliveryQueue(req, res) {
  if (!hasAnyRole(req.user, DELIVERY_ROLES)) fail(403, 'Access denied.');

  const { page, limit, skip } = parsePagination(req.query);
  const search = toStr(req.query.search);
  const where = { status: 'PENDING_DELIVERY' };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { companyName: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
      { customerCode: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.legacyCustomer.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.legacyCustomer.count({ where }),
  ]);

  res.json(paginatedResponse({ data, total, page, limit, dataKey: 'customers' }));
});

/**
 * POST /api/legacy-customers/:id/delivery
 * Delivery records the delivery date → PENDING_BILLING. Body: { deliveryDate }.
 */
export const setDeliveryDate = asyncHandler(async function setDeliveryDate(req, res) {
  if (!hasAnyRole(req.user, DELIVERY_ROLES)) fail(403, 'Access denied.');

  const deliveryDate = toDate(req.body.deliveryDate);
  if (!deliveryDate) fail(400, 'A valid deliveryDate is required.');

  const existing = await prisma.legacyCustomer.findUnique({ where: { id: req.params.id } });
  if (!existing) fail(404, 'Customer not found.');
  if (existing.status !== 'PENDING_DELIVERY') {
    fail(400, `Customer is not awaiting delivery (status: ${existing.status}).`);
  }

  const updated = await prisma.legacyCustomer.update({
    where: { id: req.params.id },
    data: {
      deliveryDate,
      status: 'PENDING_BILLING',
      deliveryUpdatedById: req.user.id,
      deliveryUpdatedAt: new Date(),
    },
  });

  await notifyAccountsBilling(updated.customerCode);

  res.json({ message: 'Delivery date saved. Returned to accounts for billing.', data: updated });
});

// ─── Accounts: billing queue + complete billing ──────────────────────────────

/**
 * GET /api/legacy-customers/billing-queue
 * Accounts sees customers returned from delivery (PENDING_BILLING).
 */
export const getBillingQueue = asyncHandler(async function getBillingQueue(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  const { page, limit, skip } = parsePagination(req.query);
  const search = toStr(req.query.search);
  const where = { status: 'PENDING_BILLING' };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { companyName: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
      { customerCode: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.legacyCustomer.findMany({ where, orderBy: { deliveryUpdatedAt: 'desc' }, skip, take: limit }),
    prisma.legacyCustomer.count({ where }),
  ]);

  res.json(paginatedResponse({ data, total, page, limit, dataKey: 'customers' }));
});

/**
 * POST /api/legacy-customers/:id/billing
 * Accounts records billDate + billingCycle → COMPLETED.
 * Body: { billDate, billingCycle }.
 */
export const setBilling = asyncHandler(async function setBilling(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  const billDate = toDate(req.body.billDate);
  const billingCycle = toStr(req.body.billingCycle)?.toUpperCase();
  if (!billDate) fail(400, 'A valid billDate is required.');
  if (!billingCycle || !VALID_BILLING_CYCLES.includes(billingCycle)) {
    fail(400, `billingCycle must be one of ${VALID_BILLING_CYCLES.join(', ')}.`);
  }

  const existing = await prisma.legacyCustomer.findUnique({ where: { id: req.params.id } });
  if (!existing) fail(404, 'Customer not found.');
  if (existing.status !== 'PENDING_BILLING') {
    fail(400, `Customer is not awaiting billing (status: ${existing.status}).`);
  }

  const updated = await prisma.legacyCustomer.update({
    where: { id: req.params.id },
    data: {
      billDate,
      billingCycle,
      status: 'COMPLETED',
      billingUpdatedById: req.user.id,
      billingUpdatedAt: new Date(),
    },
  });

  await emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.json({ message: 'Billing saved. Customer is now complete.', data: updated });
});

/**
 * POST /api/legacy-customers/:id/ftb
 * Accounts records the FTB (first time bill) received amount + date. This is an
 * extra detail captured AFTER billing is complete — it does NOT change status
 * (the customer already counts in the dashboard once COMPLETED).
 * Body: { ftbAmount, ftbReceivedDate }.
 */
export const setFtb = asyncHandler(async function setFtb(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  const ftbAmount = toFloat(req.body.ftbAmount);
  const ftbReceivedDate = toDate(req.body.ftbReceivedDate);
  if (ftbAmount === null || ftbAmount < 0) fail(400, 'A valid FTB amount is required.');
  if (!ftbReceivedDate) fail(400, 'A valid FTB received date is required.');

  const existing = await prisma.legacyCustomer.findUnique({ where: { id: req.params.id } });
  if (!existing) fail(404, 'Customer not found.');
  if (existing.status !== 'COMPLETED') {
    fail(400, 'FTB can only be recorded after billing is complete.');
  }

  const updated = await prisma.legacyCustomer.update({
    where: { id: req.params.id },
    data: { ftbAmount, ftbReceivedDate },
  });

  res.json({ message: 'FTB recorded.', data: updated });
});

// ─── Accounts: list + stats (dashboard) ──────────────────────────────────────

/**
 * GET /api/legacy-customers
 * Full list for the Total Customers table page. Query: status, search, page, limit.
 */
export const listCustomers = asyncHandler(async function listCustomers(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  const { page, limit, skip } = parsePagination(req.query);
  const status = toStr(req.query.status);
  const search = toStr(req.query.search);

  const where = {};
  if (status && ['PENDING_DELIVERY', 'PENDING_BILLING', 'COMPLETED'].includes(status)) {
    where.status = status;
  }
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { companyName: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
      { customerCode: { contains: search, mode: 'insensitive' } },
      { username: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.legacyCustomer.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.legacyCustomer.count({ where }),
  ]);

  res.json(paginatedResponse({ data, total, page, limit, dataKey: 'customers' }));
});

/**
 * GET /api/legacy-customers/stats
 * Counts for the dashboard card. "Total Customers" = COMPLETED only.
 */
export const getStats = asyncHandler(async function getStats(req, res) {
  if (!hasAnyRole(req.user, ACCOUNTS_ROLES)) fail(403, 'Access denied.');

  const grouped = await prisma.legacyCustomer.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = { PENDING_DELIVERY: 0, PENDING_BILLING: 0, COMPLETED: 0 };
  for (const g of grouped) counts[g.status] = g._count._all;

  res.json({
    message: 'Stats retrieved.',
    data: {
      totalCustomers: counts.COMPLETED,
      pendingDelivery: counts.PENDING_DELIVERY,
      pendingBilling: counts.PENDING_BILLING,
      total: counts.PENDING_DELIVERY + counts.PENDING_BILLING + counts.COMPLETED,
    },
  });
});
