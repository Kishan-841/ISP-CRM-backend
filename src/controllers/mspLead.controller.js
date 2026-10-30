/**
 * MSP leads — the MSP Lead tab.
 *
 * These are NOT ISP leads. A sales user who picks up MSP business (firewalls,
 * servers, cloud) captures it here; it goes straight to the MSP CRM and never
 * enters the ISP pipeline, so it cannot distort pipeline counts or ARC totals.
 */
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { hasAnyRole, isAdminOrTestUser } from '../utils/roleHelper.js';
import { isBdmLike } from '../utils/bdmRoles.js';
import { sendMspLead, isConfigured, allowedSubcategories } from '../services/mspCrm.service.js';

/** Same audience as handing an ISP lead over: the sales roles, plus admins. */
function canUse(user) {
  return (
    isBdmLike(user) ||
    isAdminOrTestUser(user) ||
    hasAnyRole(user, ['BDM_TEAM_LEADER', 'BDM_CP', 'SALES_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])
  );
}

const CLASSIFICATIONS = ['HARDWARE', 'SOFTWARE'];

const row = (r) => ({
  id: r.id,
  companyName: r.companyName,
  contactPerson: r.contactPerson,
  phone: r.phone,
  email: r.email,
  gstin: r.gstin,
  state: r.state,
  billingAddress: r.billingAddress,
  requirement: r.requirement,
  classification: r.classification,
  subcategories: r.subcategories,
  sendStatus: r.sendStatus,
  lastError: r.lastError,
  sentAt: r.sentAt,
  mspLeadId: r.mspLeadId,
  status: r.mspStatus,
  statusLabel: r.mspStatusLabel,
  assignedTo: r.mspAssignedTo,
  orderNo: r.mspOrderNo,
  dropReason: r.mspDropReason,
  syncedAt: r.syncedAt,
  removedAt: r.removedAt,
  createdBy: r.createdBy?.name || null,
  createdAt: r.createdAt,
});

/**
 * POST /api/msp-leads
 *
 * Creates the lead on our side and pushes it to the MSP CRM in one step —
 * the row is written first so a failed send leaves something to retry rather
 * than losing what the user typed.
 */
export const createMspLead = asyncHandler(async function createMspLead(req, res) {
  if (!canUse(req.user)) {
    return res.status(403).json({ message: 'You do not have permission to create MSP leads.' });
  }

  const {
    companyName, contactPerson, phone, email,
    gstin, state, billingAddress, requirement, notes,
    classification, subcategories,
  } = req.body;

  // The MSP CRM's four required fields. GSTIN, state, billing address and
  // requirement are optional on both sides.
  const missing = [];
  if (!companyName?.trim()) missing.push('company name');
  if (!contactPerson?.trim()) missing.push('contact person');
  if (!phone?.trim()) missing.push('phone');
  if (!email?.trim()) missing.push('email');
  if (missing.length > 0) {
    return res.status(400).json({ message: `Please fill in: ${missing.join(', ')}.` });
  }

  if (!CLASSIFICATIONS.includes(classification)) {
    return res.status(400).json({ message: 'Choose Hardware or Software.' });
  }

  // Reject a subcategory that does not belong to the chosen classification —
  // otherwise a stale form could send "Firewall" under Software.
  const allowed = allowedSubcategories(classification);
  const picked = Array.isArray(subcategories) ? subcategories : [];
  const invalid = picked.filter((s) => !allowed.includes(s));
  if (invalid.length > 0) {
    return res.status(400).json({
      message: `${invalid.join(', ')} ${invalid.length === 1 ? 'is' : 'are'} not valid for ${classification.toLowerCase()}.`,
    });
  }

  const created = await prisma.mspLead.create({
    data: {
      companyName: companyName.trim(),
      contactPerson: contactPerson.trim(),
      phone: phone.trim(),
      email: email.trim(),
      gstin: gstin?.trim() || null,
      state: state?.trim() || null,
      billingAddress: billingAddress?.trim() || null,
      requirement: requirement?.trim() || null,
      notes: notes?.trim() || null,
      classification,
      subcategories: picked,
      createdById: req.user.id,
      sendStatus: isConfigured() ? 'PENDING' : 'NOT_SENT',
      nextAttemptAt: isConfigured() ? new Date() : null,
    },
  });

  if (!isConfigured()) {
    return res.status(201).json({
      message: 'MSP lead saved, but the MSP CRM is not configured on the server so it was not sent.',
      data: row(created),
    });
  }

  const result = await sendMspLead(created.id, req.user);
  const after = await prisma.mspLead.findUnique({
    where: { id: created.id },
    include: { createdBy: { select: { name: true } } },
  });

  if (result.ok) {
    return res.status(201).json({ message: 'MSP lead created and sent.', data: row(after) });
  }
  if (result.permanent) {
    // Saved, but the MSP CRM rejected it. 201 not 400: the row exists and the
    // user can fix and resend rather than retyping everything.
    return res.status(201).json({
      message: `Saved, but the MSP CRM rejected it: ${result.message}`,
      data: row(after),
    });
  }
  return res.status(201).json({
    message: 'Saved. The MSP CRM was unreachable — it will retry automatically.',
    data: row(after),
  });
});

/** GET /api/msp-leads — the tab's list. */
export const getMspLeads = asyncHandler(async function getMspLeads(req, res) {
  if (!canUse(req.user)) {
    return res.status(403).json({ message: 'You do not have permission to view MSP leads.' });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const { search, status } = req.query;

  const where = {};
  // A non-admin sees what they captured. Admins see everything.
  if (!isAdminOrTestUser(req.user)) where.createdById = req.user.id;
  if (status && status !== 'all') where.mspStatus = status;
  if (search?.trim()) {
    const term = search.trim();
    where.OR = [
      { companyName: { contains: term, mode: 'insensitive' } },
      { contactPerson: { contains: term, mode: 'insensitive' } },
      { phone: { contains: term } },
      { email: { contains: term, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.mspLead.findMany({
      where,
      include: { createdBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    }),
    prisma.mspLead.count({ where }),
  ]);

  res.json({
    items: rows.map(row),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

/** POST /api/msp-leads/:id/resend — after fixing a rejected lead. */
export const resendMspLead = asyncHandler(async function resendMspLead(req, res) {
  if (!canUse(req.user)) {
    return res.status(403).json({ message: 'You do not have permission to send MSP leads.' });
  }
  if (!isConfigured()) {
    return res.status(503).json({ message: 'MSP CRM integration is not configured.' });
  }

  const existing = await prisma.mspLead.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: 'MSP lead not found.' });
  if (!isAdminOrTestUser(req.user) && existing.createdById !== req.user.id) {
    // 404 rather than 403 so the response cannot confirm it exists.
    return res.status(404).json({ message: 'MSP lead not found.' });
  }

  // A previous FAILED send sets no nextAttemptAt; clear the state so this
  // attempt is treated as fresh rather than being skipped.
  if (existing.sendStatus === 'FAILED') {
    await prisma.mspLead.update({
      where: { id: existing.id },
      data: { sendStatus: 'PENDING', nextAttemptAt: new Date(), lastError: null },
    });
  }

  const result = await sendMspLead(existing.id, req.user);
  const after = await prisma.mspLead.findUnique({
    where: { id: existing.id },
    include: { createdBy: { select: { name: true } } },
  });

  if (result.ok) return res.json({ message: 'Sent to MSP CRM.', data: row(after) });
  if (result.permanent) return res.status(400).json({ message: result.message, data: row(after) });
  return res.status(202).json({
    message: `MSP CRM is unreachable — queued for automatic retry. (${result.message})`,
    data: row(after),
  });
});

/** GET /api/msp-leads/options — what the form offers. */
export const getMspLeadOptions = asyncHandler(async function getMspLeadOptions(req, res) {
  res.json({
    message: 'Success',
    data: {
      configured: isConfigured(),
      classifications: CLASSIFICATIONS.map((c) => ({
        value: c,
        label: c === 'HARDWARE' ? 'Hardware' : 'Software',
        description: c === 'HARDWARE' ? 'Physical devices' : 'Software & cloud',
        subcategories: allowedSubcategories(c),
      })),
    },
  });
});
