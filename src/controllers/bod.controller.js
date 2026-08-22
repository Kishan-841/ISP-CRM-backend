import prisma from '../config/db.js';
import { asyncHandler, parsePagination } from '../utils/controllerHelper.js';
import { generateBODNumber, generateInvoiceNumber } from '../services/documentNumber.service.js';
import { createNotification, notifyAllByRole } from '../services/notification.service.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';

// ─── Bandwidth on Demand ─────────────────────────────────────────────────────
//
// A temporary bandwidth boost for an ACTIVE customer, billed as a one-off
// invoice. Lives beside the plan — nothing here ever touches actualPlan* or
// arcAmount. Lifecycle: PENDING_ACCOUNTS → BILLED → ACTIVE → EXPIRED
// (+ SENT_BACK / CANCELLED). BILLED→ACTIVE→EXPIRED is driven by
// jobs/bodLifecycle.js.

export const BOD_CREATOR_ROLES = ['BDM', 'BDM_TEAM_LEADER', 'SUPER_ADMIN', 'MASTER'];
export const BOD_ACCOUNTS_ROLES = ['ACCOUNTS_TEAM', 'SUPER_ADMIN', 'MASTER'];
const ADMIN_ROLES = ['SUPER_ADMIN', 'MASTER'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

const BOD_INCLUDE = {
  lead: {
    select: {
      id: true, leadNumber: true, customerUsername: true,
      actualPlanBandwidth: true, actualPlanName: true,
      campaignData: { select: { company: true, name: true, phone: true } }
    }
  },
  invoice: { select: { id: true, invoiceNumber: true, status: true, grandTotal: true, remainingAmount: true } },
  createdBy: { select: { id: true, name: true } },
  billedBy: { select: { id: true, name: true } }
};

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
// Plans store bandwidth in Kbps on newer leads (>= 1000) and Mbps on older ones.
const toMbps = (v) => (v == null ? null : v >= 1000 ? Math.round(v / 1000) : v);

// Validate the user-editable fields; returns { error } or the parsed values.
const parseBodInput = (body) => {
  const requestedBandwidthMbps = parseInt(body.requestedBandwidthMbps);
  const durationDays = parseInt(body.durationDays);
  const price = parseFloat(body.price);
  const startDate = body.startDate ? startOfDay(new Date(body.startDate)) : null;
  if (!Number.isFinite(requestedBandwidthMbps) || requestedBandwidthMbps <= 0) return { error: 'Requested bandwidth (Mbps) must be greater than 0.' };
  if (!Number.isFinite(durationDays) || durationDays <= 0) return { error: 'Duration must be at least 1 day.' };
  if (!Number.isFinite(price) || price <= 0) return { error: 'Price must be greater than 0.' };
  if (!startDate || Number.isNaN(startDate.getTime())) return { error: 'Start date is required.' };
  if (startDate < startOfDay(new Date())) return { error: 'Start date cannot be in the past.' };
  return {
    requestedBandwidthMbps, durationDays, price, startDate,
    endDate: addDays(startDate, durationDays - 1),
    remarks: body.remarks ? String(body.remarks).trim() : null
  };
};

// Another non-cancelled, non-expired BOD whose window intersects [start, end]?
const findOverlap = (leadId, startDate, endDate, excludeId) => prisma.bandwidthOnDemand.findFirst({
  where: {
    leadId,
    ...(excludeId ? { id: { not: excludeId } } : {}),
    status: { notIn: ['CANCELLED', 'EXPIRED'] },
    startDate: { lte: endDate },
    endDate: { gte: startDate }
  },
  select: { bodNumber: true, startDate: true, endDate: true }
});

const statsByStatus = async (where) => {
  const rows = await prisma.bandwidthOnDemand.groupBy({ by: ['status'], where, _count: { id: true } });
  return Object.fromEntries(rows.map(r => [r.status, r._count.id]));
};

// GET /bod/customers?q= — active customers only, for the request form
export const searchActiveCustomers = asyncHandler(async function searchActiveCustomers(req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ customers: [] });
  const leads = await prisma.lead.findMany({
    where: {
      actualPlanIsActive: true,
      OR: [
        { leadNumber: { contains: q, mode: 'insensitive' } },
        { customerUsername: { contains: q, mode: 'insensitive' } },
        { campaignData: { company: { contains: q, mode: 'insensitive' } } },
        { campaignData: { name: { contains: q, mode: 'insensitive' } } },
        { campaignData: { phone: { contains: q } } }
      ]
    },
    select: {
      id: true, leadNumber: true, customerUsername: true,
      actualPlanName: true, actualPlanBandwidth: true,
      campaignData: { select: { company: true, name: true, phone: true } }
    },
    take: 10,
    orderBy: { createdAt: 'desc' }
  });
  res.json({
    customers: leads.map(l => ({
      id: l.id,
      leadNumber: l.leadNumber,
      company: l.campaignData?.company,
      contactName: l.campaignData?.name,
      phone: l.campaignData?.phone,
      customerUsername: l.customerUsername,
      planName: l.actualPlanName,
      planBandwidthMbps: toMbps(l.actualPlanBandwidth)
    }))
  });
});

// POST /bod
export const createBod = asyncHandler(async function createBod(req, res) {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ message: 'Customer is required.' });
  const parsed = parseBodInput(req.body);
  if (parsed.error) return res.status(400).json({ message: parsed.error });

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, actualPlanIsActive: true, actualPlanBandwidth: true, campaignData: { select: { company: true } } }
  });
  if (!lead) return res.status(404).json({ message: 'Customer not found.' });
  if (!lead.actualPlanIsActive) return res.status(400).json({ message: 'Bandwidth on Demand is only available for customers with an active plan.' });

  const overlap = await findOverlap(leadId, parsed.startDate, parsed.endDate);
  if (overlap) {
    return res.status(400).json({
      message: `${overlap.bodNumber} already covers ${fmtDate(overlap.startDate)} – ${fmtDate(overlap.endDate)} for this customer. Windows cannot overlap.`
    });
  }

  const bodNumber = await generateBODNumber();
  const bod = await prisma.bandwidthOnDemand.create({
    data: {
      bodNumber,
      leadId,
      currentPlanBandwidth: toMbps(lead.actualPlanBandwidth),
      requestedBandwidthMbps: parsed.requestedBandwidthMbps,
      durationDays: parsed.durationDays,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      price: parsed.price,
      remarks: parsed.remarks,
      createdById: req.user.id
    },
    include: BOD_INCLUDE
  });

  await notifyAllByRole(
    'ACCOUNTS_TEAM', 'BOD_REQUEST', 'New Bandwidth on Demand request',
    `${lead.campaignData?.company}: ${parsed.requestedBandwidthMbps} Mbps for ${parsed.durationDays} days from ${fmtDate(parsed.startDate)} (₹${parsed.price}) — raised by ${req.user.name}.`,
    { bodId: bod.id, bodNumber }
  );
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.status(201).json({ message: `${bodNumber} sent to accounts.`, bod });
});

// GET /bod — creators see their own (admins see all); ?status=&page=&limit=
export const listBods = asyncHandler(async function listBods(req, res) {
  const { page, limit, skip } = parsePagination(req.query, 20);
  const scope = isAdmin(req.user) || req.user.role === 'ACCOUNTS_TEAM' ? {} : { createdById: req.user.id };
  const where = { ...scope, ...(req.query.status ? { status: req.query.status } : {}) };
  const [items, total, stats] = await Promise.all([
    prisma.bandwidthOnDemand.findMany({ where, include: BOD_INCLUDE, orderBy: { createdAt: 'desc' }, take: limit, skip }),
    prisma.bandwidthOnDemand.count({ where }),
    statsByStatus(scope)
  ]);
  res.json({ items, stats, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// GET /bod/accounts/queue — all requests; default tab PENDING_ACCOUNTS
export const accountsQueue = asyncHandler(async function accountsQueue(req, res) {
  const { page, limit, skip } = parsePagination(req.query, 20);
  const where = { status: req.query.status || 'PENDING_ACCOUNTS' };
  const [items, total, stats] = await Promise.all([
    prisma.bandwidthOnDemand.findMany({ where, include: BOD_INCLUDE, orderBy: { createdAt: 'asc' }, take: limit, skip }),
    prisma.bandwidthOnDemand.count({ where }),
    statsByStatus({})
  ]);
  res.json({ items, stats, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

const loadEditable = async (req, res, allowedStatuses) => {
  const bod = await prisma.bandwidthOnDemand.findUnique({ where: { id: req.params.id }, include: BOD_INCLUDE });
  if (!bod) { res.status(404).json({ message: 'BOD request not found.' }); return null; }
  if (!allowedStatuses.includes(bod.status)) {
    res.status(400).json({ message: `This request is ${bod.status.replace(/_/g, ' ').toLowerCase()} and can no longer be changed.` });
    return null;
  }
  return bod;
};

// PUT /bod/:id — creator edits while pending / sent back; resubmits to accounts
export const updateBod = asyncHandler(async function updateBod(req, res) {
  const bod = await loadEditable(req, res, ['PENDING_ACCOUNTS', 'SENT_BACK']);
  if (!bod) return;
  if (bod.createdById !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ message: 'You can only edit your own requests.' });
  const parsed = parseBodInput(req.body);
  if (parsed.error) return res.status(400).json({ message: parsed.error });

  const overlap = await findOverlap(bod.leadId, parsed.startDate, parsed.endDate, bod.id);
  if (overlap) {
    return res.status(400).json({
      message: `${overlap.bodNumber} already covers ${fmtDate(overlap.startDate)} – ${fmtDate(overlap.endDate)} for this customer. Windows cannot overlap.`
    });
  }

  const wasSentBack = bod.status === 'SENT_BACK';
  const updated = await prisma.bandwidthOnDemand.update({
    where: { id: bod.id },
    data: {
      requestedBandwidthMbps: parsed.requestedBandwidthMbps,
      durationDays: parsed.durationDays,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      price: parsed.price,
      remarks: parsed.remarks,
      status: 'PENDING_ACCOUNTS'
    },
    include: BOD_INCLUDE
  });

  if (wasSentBack) {
    await notifyAllByRole(
      'ACCOUNTS_TEAM', 'BOD_REQUEST', 'BOD request resubmitted',
      `${bod.bodNumber} (${bod.lead.campaignData?.company}) was updated and resubmitted by ${req.user.name}.`,
      { bodId: bod.id, bodNumber: bod.bodNumber }
    );
  }
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  res.json({ message: 'Request updated and sent to accounts.', bod: updated });
});

// POST /bod/:id/cancel — creator/admin, only before billing
export const cancelBod = asyncHandler(async function cancelBod(req, res) {
  const bod = await loadEditable(req, res, ['PENDING_ACCOUNTS', 'SENT_BACK']);
  if (!bod) return;
  if (bod.createdById !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ message: 'You can only cancel your own requests.' });
  const updated = await prisma.bandwidthOnDemand.update({ where: { id: bod.id }, data: { status: 'CANCELLED' }, include: BOD_INCLUDE });
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  res.json({ message: `${bod.bodNumber} cancelled.`, bod: updated });
});

// POST /bod/:id/send-back — accounts returns it to the creator with a note
export const sendBack = asyncHandler(async function sendBack(req, res) {
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Please tell the BDM what needs to change.' });
  const bod = await loadEditable(req, res, ['PENDING_ACCOUNTS']);
  if (!bod) return;

  const updated = await prisma.bandwidthOnDemand.update({
    where: { id: bod.id },
    data: { status: 'SENT_BACK', accountsNote: note },
    include: BOD_INCLUDE
  });
  await createNotification(
    bod.createdById, 'BOD_SENT_BACK', 'BOD request sent back by accounts',
    `${bod.bodNumber} (${bod.lead.campaignData?.company}): ${note}`,
    { bodId: bod.id, bodNumber: bod.bodNumber }
  );
  emitSidebarRefresh(bod.createdById);
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  res.json({ message: 'Sent back to the BDM.', bod: updated });
});

// POST /bod/:id/generate-bill — accounts: invoice + ledger debit, notify NOC
export const generateBill = asyncHandler(async function generateBill(req, res) {
  const bod = await loadEditable(req, res, ['PENDING_ACCOUNTS']);
  if (!bod) return;

  let price = bod.price;
  if (req.body.price !== undefined && req.body.price !== null && req.body.price !== '') {
    price = parseFloat(req.body.price);
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ message: 'Price must be greater than 0.' });
  }

  const lead = await prisma.lead.findUnique({
    where: { id: bod.leadId },
    select: {
      id: true, customerUsername: true, billingAddress: true, fullAddress: true, installationAddress: true,
      customerGstNo: true, poNumber: true,
      campaignData: { select: { company: true, address: true, phone: true, email: true } }
    }
  });

  const userId = req.user.id;
  const planName = `Bandwidth on Demand — ${bod.requestedBandwidthMbps} Mbps × ${bod.durationDays} days`;
  const planDescription = `Temporary bandwidth upgrade to ${bod.requestedBandwidthMbps} Mbps from ${fmtDate(bod.startDate)} to ${fmtDate(bod.endDate)}` +
    (bod.currentPlanBandwidth ? ` (regular plan ${bod.currentPlanBandwidth} Mbps)` : '');

  const result = await prisma.$transaction(async (tx) => {
    const baseAmount = price;
    const taxableAmount = baseAmount;
    const sgstRate = 9;
    const cgstRate = 9;
    const sgstAmount = (taxableAmount * sgstRate) / 100;
    const cgstAmount = (taxableAmount * cgstRate) / 100;
    const totalGstAmount = sgstAmount + cgstAmount;
    const grandTotal = taxableAmount + totalGstAmount;

    const invoiceNumber = await generateInvoiceNumber();
    const invoiceDate = new Date();
    const dueDate = new Date(invoiceDate);
    dueDate.setUTCDate(dueDate.getUTCDate() + 15);

    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        leadId: bod.leadId,
        invoiceDate,
        dueDate,
        billingPeriodStart: bod.startDate,
        billingPeriodEnd: bod.endDate,
        companyName: lead.campaignData?.company || 'Unknown',
        customerUsername: lead.customerUsername,
        billingAddress: lead.billingAddress || lead.fullAddress || lead.campaignData?.address,
        installationAddress: lead.installationAddress || lead.fullAddress,
        buyerGstNo: lead.customerGstNo,
        contactPhone: lead.campaignData?.phone,
        contactEmail: lead.campaignData?.email,
        poNumber: lead.poNumber,
        planName,
        planDescription,
        hsnSacCode: '998422',
        baseAmount,
        discountAmount: 0,
        taxableAmount,
        sgstRate,
        cgstRate,
        sgstAmount,
        cgstAmount,
        totalGstAmount,
        grandTotal,
        remainingAmount: grandTotal,
        status: 'GENERATED',
        notes: `Bandwidth on Demand ${bod.bodNumber}`,
        createdById: userId
      }
    });

    // Ledger debit inside the transaction (same pattern as OTC invoices)
    const lastEntry = await tx.ledgerEntry.findFirst({
      where: { customerId: bod.leadId },
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
      select: { runningBalance: true }
    });
    const previousBalance = Number(lastEntry?.runningBalance) || 0;
    await tx.ledgerEntry.create({
      data: {
        customerId: bod.leadId,
        entryDate: invoiceDate,
        entryType: 'INVOICE',
        referenceType: 'INVOICE',
        referenceId: invoice.id,
        referenceNumber: invoice.invoiceNumber,
        debitAmount: grandTotal,
        creditAmount: 0,
        runningBalance: previousBalance + grandTotal,
        description: `Invoice ${invoice.invoiceNumber} for ${planName} (${fmtDate(bod.startDate)} to ${fmtDate(bod.endDate)})`,
        createdById: userId
      }
    });

    const updatedBod = await tx.bandwidthOnDemand.update({
      where: { id: bod.id },
      data: { status: 'BILLED', price, invoiceId: invoice.id, billedById: userId, billedAt: invoiceDate },
      include: BOD_INCLUDE
    });
    return { invoice, bod: updatedBod };
  });

  const company = lead.campaignData?.company;
  const nocMessage = `${company} (${lead.customerUsername || bod.lead.leadNumber}): provision ${bod.requestedBandwidthMbps} Mbps from ${fmtDate(bod.startDate)} to ${fmtDate(bod.endDate)}` +
    (bod.currentPlanBandwidth ? `, then revert to ${bod.currentPlanBandwidth} Mbps` : '') + `. Ref ${bod.bodNumber}.`;
  await Promise.all([
    notifyAllByRole('NOC', 'BOD_PROVISION', 'Bandwidth on Demand — provision', nocMessage, { bodId: bod.id, leadId: bod.leadId }),
    notifyAllByRole('NOC_HEAD', 'BOD_PROVISION', 'Bandwidth on Demand — provision', nocMessage, { bodId: bod.id, leadId: bod.leadId }),
    createNotification(
      bod.createdById, 'BOD_BILLED', 'BOD request billed',
      `${bod.bodNumber} (${company}) billed — invoice ${result.invoice.invoiceNumber}, ₹${result.invoice.grandTotal.toFixed(2)} incl. GST.`,
      { bodId: bod.id, invoiceId: result.invoice.id }
    )
  ]);
  emitSidebarRefresh(bod.createdById);
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({
    message: `Invoice ${result.invoice.invoiceNumber} generated for ${bod.bodNumber}.`,
    bod: result.bod,
    invoice: result.invoice
  });
});
