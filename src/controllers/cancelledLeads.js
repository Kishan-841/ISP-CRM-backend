/**
 * Reading cancelled leads.
 *
 * Two audiences, one row shape:
 *  - the delivery board's Cancelled tab (scoped to the delivery user)
 *  - the sales owner's Cancelled Leads page (scoped to the lead owner)
 *
 * Both are properly paginated at the database, unlike getDeliveryQueue.
 */
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { isAdminOrTestUser, hasRole } from '../utils/roleHelper.js';

const SELECT = {
  id: true,
  leadNumber: true,
  arcAmount: true,
  otcAmount: true,
  cancelledAt: true,
  cancelledReason: true,
  cancelledAtStage: true,
  campaignData: { select: { company: true, name: true, phone: true, email: true } },
  assignedTo: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } }
};

/** One row, shared by both endpoints so the table columns never drift apart. */
export const cancelledLeadRow = (lead) => ({
  id: lead.id,
  leadNumber: lead.leadNumber,
  company: lead.campaignData?.company || null,
  contactName: lead.campaignData?.name || null,
  phone: lead.campaignData?.phone || null,
  email: lead.campaignData?.email || null,
  leadOwner: lead.assignedTo?.name || null,
  cancelledBy: lead.cancelledBy?.name || null,
  cancelledAt: lead.cancelledAt,
  cancelledAtStage: lead.cancelledAtStage,
  cancelledReason: lead.cancelledReason,
  arcAmount: lead.arcAmount,
  otcAmount: lead.otcAmount
});

const buildFilters = ({ search, fromDate, toDate, cancelledById }) => {
  const where = { cancelledAt: { not: null } };

  if (fromDate || toDate) {
    where.cancelledAt = {
      not: null,
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(new Date(toDate).setHours(23, 59, 59, 999)) })
    };
  }
  if (cancelledById) where.cancelledById = cancelledById;
  if (search && search.trim()) {
    const term = search.trim();
    where.campaignData = {
      OR: [
        { company: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } }
      ]
    };
  }
  return where;
};

const paginate = (query) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 25));
  return { page, limit, skip: (page - 1) * limit };
};

const respond = async (res, where, query) => {
  const { page, limit, skip } = paginate(query);
  const [leads, total] = await Promise.all([
    prisma.lead.findMany({ where, select: SELECT, orderBy: { cancelledAt: 'desc' }, take: limit, skip }),
    prisma.lead.count({ where })
  ]);
  res.json({
    items: leads.map(cancelledLeadRow),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
};

/**
 * Delivery board Cancelled tab. Same gate and scoping as getDeliveryQueue:
 * a delivery user sees own + unassigned; a BDM team leader (read-only board
 * view) and admins see everything.
 */
export const getDeliveryCancelledLeads = asyncHandler(async function getDeliveryCancelledLeads(req, res) {
  const isDeliveryTeam = hasRole(req.user, 'DELIVERY_TEAM');
  const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
  const isAdmin = isAdminOrTestUser(req.user);

  if (!isDeliveryTeam && !isTL && !isAdmin) {
    return res.status(403).json({ message: 'Only Delivery Team can access this endpoint.' });
  }

  const where = { ...buildFilters(req.query), pushedToInstallationAt: { not: null } };
  if (isDeliveryTeam && !isAdmin) {
    where.OR = [{ deliveryAssignedToId: req.user.id }, { deliveryAssignedToId: null }];
  }
  await respond(res, where, req.query);
});

/** Sales view: the logged-in owner's cancelled leads, or everything for an admin. */
export const getCancelledLeads = asyncHandler(async function getCancelledLeads(req, res) {
  const where = buildFilters(req.query);
  if (!isAdminOrTestUser(req.user)) where.assignedToId = req.user.id;
  await respond(res, where, req.query);
});
