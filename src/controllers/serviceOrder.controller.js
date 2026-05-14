import prisma from '../config/db.js';
import { hasRole, hasAnyRole, isAdmin } from '../utils/roleHelper.js';
import { generateServiceOrderNumber } from '../services/documentNumber.service.js';
import { createNotification, notifyAllAdmins } from '../services/notification.service.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import { asyncHandler, parsePagination, paginatedResponse, buildSearchFilter } from '../utils/controllerHelper.js';
import { enqueueActivationWebhook, attemptDeliveryInBackground } from '../services/samWebhook.service.js';

/**
 * Get disconnection reason categories with sub-categories
 */
export const getDisconnectionReasons = asyncHandler(async function getDisconnectionReasons(req, res) {
  const categories = await prisma.disconnectionCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      isActive: true,
      subCategories: {
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, isActive: true }
      }
    }
  });
  res.json({ data: categories });
});

/**
 * Create a new service order (Upgrade / Downgrade / Disconnection)
 * Roles: SAM_HEAD, SAM_EXECUTIVE, SUPER_ADMIN
 */
export const createServiceOrder = asyncHandler(async function createServiceOrder(req, res) {
  const {
    customerId,
    orderType,
    newBandwidth,
    newArc,
    disconnectionReason,
    disconnectionCategoryId,
    disconnectionSubCategoryId,
    notes,
    effectiveDate,
    mailReceivedDate,  // optional — date SAM confirms customer consented in writing
    approvalFileUrl,   // optional — Cloudinary HTTPS URL to .pdf/.eml/.msg
    poFileUrl,         // optional — Cloudinary HTTPS URL to .pdf/.eml/.msg
  } = req.body;

  // Light validation: if a URL is sent at all, it must be HTTPS.
  // Cloudinary URLs always are; rejecting non-HTTPS prevents accidental
  // injection of arbitrary links into the docs review UI.
  const validateDocUrl = (value, label) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !/^https:\/\//i.test(value)) {
      return `${label} must be an HTTPS URL.`;
    }
    return null;
  };
  const approvalErr = validateDocUrl(approvalFileUrl, 'approvalFileUrl');
  if (approvalErr) return res.status(400).json({ message: approvalErr });
  const poErr = validateDocUrl(poFileUrl, 'poFileUrl');
  if (poErr) return res.status(400).json({ message: poErr });

  if (!customerId || !orderType) {
    return res.status(400).json({ message: 'Customer and order type are required.' });
  }

  if (!['UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'DISCONNECTION'].includes(orderType)) {
    return res.status(400).json({ message: 'Invalid order type.' });
  }

  // Validate type-specific fields
  if ((orderType === 'UPGRADE' || orderType === 'DOWNGRADE') && (!newBandwidth || !newArc)) {
    return res.status(400).json({ message: 'New bandwidth and ARC are required for upgrade/downgrade.' });
  }

  if (orderType === 'RATE_REVISION' && (!newBandwidth || newArc === undefined || newArc === null || newArc === '')) {
    return res.status(400).json({ message: 'New bandwidth and ARC are required for rate revision.' });
  }

  if (orderType === 'DISCONNECTION') {
    if (!disconnectionCategoryId || !disconnectionSubCategoryId) {
      return res.status(400).json({ message: 'Disconnection category and sub-category are required.' });
    }
    // Validate: sub-category exists & active, parent category active, parent
    // matches what the caller supplied. SAM's bridge sends slug IDs from
    // docs/INTEGRATION_CRM.md verbatim — this gate is what 400s a typo.
    const subCategory = await prisma.disconnectionSubCategory.findFirst({
      where: {
        id: disconnectionSubCategoryId,
        categoryId: disconnectionCategoryId,
        isActive: true,
        category: { isActive: true },
      },
    });
    if (!subCategory) {
      return res.status(400).json({ message: 'Invalid disconnection category or sub-category.' });
    }
  }

  // SAM_EXECUTIVE: verify customer is assigned to them (MASTER/admin bypasses)
  if (hasRole(req.user, 'SAM_EXECUTIVE') && req.user.role === 'SAM_EXECUTIVE') {
    const assignment = await prisma.sAMAssignment.findFirst({
      where: { samExecutiveId: req.user.id, customerId }
    });
    if (!assignment) {
      return res.status(403).json({ message: 'You can only create orders for your assigned customers.' });
    }
  }

  // Fetch customer to snapshot current plan
  const customer = await prisma.lead.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      actualPlanName: true,
      actualPlanBandwidth: true,
      actualPlanPrice: true,
      arcAmount: true,
      customerUserId: true,
      campaignData: { select: { company: true } }
    }
  });

  if (!customer) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  if (!customer.customerUserId) {
    return res.status(400).json({ message: 'Only active customers with a user account can have service orders.' });
  }

  const orderNumber = await generateServiceOrderNumber();

  // Initial state depends on orderType. UPGRADE/DOWNGRADE need delivery
  // approval first (they touch provisioning); RATE_REVISION/DISCONNECTION
  // skip directly to Sales Director.
  const initialStatus =
    (orderType === 'UPGRADE' || orderType === 'DOWNGRADE')
      ? 'PENDING_DELIVERY_APPROVAL'
      : 'PENDING_SALES_DIRECTOR_APPROVAL';

  const data = {
    orderNumber,
    customerId,
    orderType,
    status: initialStatus,
    createdById: req.user.id,
    currentPlanName: customer.actualPlanName,
    currentBandwidth: customer.actualPlanBandwidth,
    currentArc: customer.arcAmount ?? customer.actualPlanPrice,
    effectiveDate: effectiveDate ? new Date(effectiveDate) : null,
    mailReceivedDate: mailReceivedDate ? new Date(mailReceivedDate) : null,
    notes: notes || null,
    approvalFileUrl: approvalFileUrl || null,
    poFileUrl: poFileUrl || null,
  };

  if (orderType === 'UPGRADE' || orderType === 'DOWNGRADE') {
    const parsedBandwidth = parseInt(newBandwidth);
    const parsedArc = parseFloat(newArc);
    const currentArc = customer.arcAmount ?? customer.actualPlanPrice;

    // Validate new values differ from current
    if (customer.actualPlanBandwidth && parsedBandwidth === customer.actualPlanBandwidth) {
      return res.status(400).json({ message: 'New bandwidth must be different from current bandwidth.' });
    }
    if (currentArc && parsedArc === currentArc) {
      return res.status(400).json({ message: 'New ARC must be different from current ARC.' });
    }

    // Validate direction matches order type
    if (orderType === 'UPGRADE') {
      if (currentArc && parsedArc <= currentArc) {
        return res.status(400).json({ message: 'For an upgrade, new ARC must be greater than current ARC.' });
      }
      if (customer.actualPlanBandwidth && parsedBandwidth <= customer.actualPlanBandwidth) {
        return res.status(400).json({ message: 'For an upgrade, new bandwidth must be greater than current bandwidth.' });
      }
    }
    if (orderType === 'DOWNGRADE') {
      if (currentArc && parsedArc >= currentArc) {
        return res.status(400).json({ message: 'For a downgrade, new ARC must be less than current ARC.' });
      }
      if (customer.actualPlanBandwidth && parsedBandwidth >= customer.actualPlanBandwidth) {
        return res.status(400).json({ message: 'For a downgrade, new bandwidth must be less than current bandwidth.' });
      }
    }

    data.newBandwidth = parsedBandwidth;
    data.newArc = parsedArc;
  }

  if (orderType === 'RATE_REVISION') {
    const parsedArc = parseFloat(newArc);
    const parsedBandwidth = parseInt(newBandwidth);
    const currentArc = customer.arcAmount ?? customer.actualPlanPrice;
    const currentBandwidth = customer.actualPlanBandwidth;

    // RATE_REVISION = customer gets MORE bandwidth at the SAME ARC.
    // (Price drops are covered by DOWNGRADE; price hikes by UPGRADE.) The
    // newArc field is still required so SAM has to confirm it knows the
    // current ARC — if its snapshot is stale and it sends a different
    // value, we reject rather than silently skipping the change.
    if (currentBandwidth && parsedBandwidth <= currentBandwidth) {
      return res.status(400).json({ message: 'Rate revision requires higher bandwidth than current.' });
    }
    if (currentArc != null && parsedArc !== currentArc) {
      return res.status(400).json({
        message: `Rate revision ARC must equal current ARC (${currentArc}). Use UPGRADE or DOWNGRADE to change the price.`
      });
    }

    data.newArc = parsedArc;
    data.newBandwidth = parsedBandwidth;
  }

  if (orderType === 'DISCONNECTION') {
    data.disconnectionCategoryId = disconnectionCategoryId;
    data.disconnectionSubCategoryId = disconnectionSubCategoryId;
    data.disconnectionReason = disconnectionReason || null;
    data.disconnectionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const order = await prisma.serviceOrder.create({ data });

  // Notify the team that owns the first gate. SUPER_ADMIN always sees
  // everything (admin override is allowed).
  const companyName = customer.campaignData?.company || 'Customer';
  const orderTypeLabel = orderType.replace('_', ' ').toLowerCase();
  const firstGateLabel = initialStatus === 'PENDING_DELIVERY_APPROVAL'
    ? 'delivery approval'
    : 'Sales Director approval';
  await notifyAllAdmins(
    'SAM_ASSIGNMENT',
    'New Service Order',
    `${orderTypeLabel} request for "${companyName}" (${orderNumber}) requires ${firstGateLabel}.`,
    { serviceOrderId: order.id, orderNumber, orderType }
  );
  if (initialStatus === 'PENDING_DELIVERY_APPROVAL') {
    await emitSidebarRefreshByRole('DELIVERY_TEAM');
  }
  await emitSidebarRefreshByRole('SALES_DIRECTOR');
  await emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({ message: 'Service order created successfully.', data: order });
});

/**
 * Get service orders with role-based filtering
 * All 5 roles: SAM_EXECUTIVE, SAM_HEAD, SUPER_ADMIN, ACCOUNTS_TEAM, NOC
 */
export const getServiceOrders = asyncHandler(async function getServiceOrders(req, res) {
  const { orderType, status, search } = req.query;
  const { page, limit, skip } = parsePagination(req.query, 20);

  let where = {};

  // Role-based filtering. Each role sees only what's pending their action.
  // SUPER_ADMIN and SAM_HEAD see everything.
  if (hasRole(req.user, 'SAM_EXECUTIVE')) {
    where.createdById = req.user.id;
  } else if (hasRole(req.user, 'DOCS_TEAM')) {
    where.status = 'PENDING_DOCS_REVIEW';
    where.orderType = { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'DISCONNECTION'] };
  } else if (hasRole(req.user, 'ACCOUNTS_TEAM')) {
    where.status = 'PENDING_ACCOUNTS';
    // Accounts now handles ALL order types (disconnection completion lives here).
  } else if (hasRole(req.user, 'NOC')) {
    where.status = 'PENDING_NOC';
  } else if (hasRole(req.user, 'SALES_DIRECTOR')) {
    where.status = 'PENDING_SALES_DIRECTOR_APPROVAL';
  } else if (hasRole(req.user, 'DELIVERY_TEAM')) {
    where.status = 'PENDING_DELIVERY_APPROVAL';
    where.orderType = { in: ['UPGRADE', 'DOWNGRADE'] };
  }
  // SAM_HEAD and SUPER_ADMIN see all

  // Additional filters — use AND to combine with role-based where clause
  // so query params can't override role-based access scoping
  const additionalFilters = [];

  if (orderType) {
    additionalFilters.push({ orderType });
  }
  if (status) {
    additionalFilters.push({ status });
  }
  if (search) {
    additionalFilters.push({ OR: buildSearchFilter(search, [
      'orderNumber',
      'customer.campaignData.company'
    ])});
  }

  if (additionalFilters.length > 0) {
    where = { AND: [where, ...additionalFilters] };
  }

  const [orders, total] = await Promise.all([
    prisma.serviceOrder.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderNumber: true,
        customerId: true,
        orderType: true,
        status: true,
        currentPlanName: true,
        currentBandwidth: true,
        currentArc: true,
        newBandwidth: true,
        newArc: true,
        effectiveDate: true,
        activationDate: true,
        activationSetById: true,
        activationSetAt: true,
        activationSetBy: { select: { id: true, name: true } },
        disconnectionDate: true,
        disconnectionReason: true,
        disconnectionCategory: { select: { id: true, name: true } },
        disconnectionSubCategory: { select: { id: true, name: true } },
        attachments: true,
        approvalFileUrl: true,
        poFileUrl: true,
        notes: true,
        createdAt: true,
        customer: {
          select: {
            id: true,
            campaignData: { select: { company: true, name: true } },
            customerUsername: true,
          }
        },
        createdBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
        approvedAt: true,
        rejectionReason: true,
        processedBy: { select: { id: true, name: true } },
        processedAt: true,
        proposedEffectiveDate: true,
        proposedEffectiveDateAt: true,
        proposedEffectiveDateBy: { select: { id: true, name: true } },
      }
    }),
    prisma.serviceOrder.count({ where })
  ]);

  res.json(paginatedResponse({ data: orders, total, page, limit, dataKey: 'orders' }));
});

/**
 * Get a single service order by ID
 */
export const getServiceOrderById = asyncHandler(async function getServiceOrderById(req, res) {
  const { id } = req.params;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          campaignData: { select: { company: true, name: true, phone: true, email: true } },
          customerUsername: true,
          actualPlanName: true,
          actualPlanBandwidth: true,
          actualPlanPrice: true,
          actualPlanIsActive: true,
          circuitId: true,
          installationAddress: true,
        }
      },
      createdBy: { select: { id: true, name: true, email: true } },
      approvedBy: { select: { id: true, name: true } },
      processedBy: { select: { id: true, name: true } },
      docsReviewedBy: { select: { id: true, name: true } },
      nocProcessedBy: { select: { id: true, name: true } },
      activationSetBy: { select: { id: true, name: true } },
      proposedEffectiveDateBy: { select: { id: true, name: true } },
      disconnectionCategory: { select: { id: true, name: true } },
      disconnectionSubCategory: { select: { id: true, name: true } },
    }
  });

  if (!order) {
    return res.status(404).json({ message: 'Service order not found.' });
  }

  // SAM_EXECUTIVE can only see their own orders
  if (hasRole(req.user, 'SAM_EXECUTIVE') && order.createdById !== req.user.id) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  res.json({ data: order });
});

/**
 * Sales Director approval — universal second gate (or first gate for
 * RATE_REVISION/DISCONNECTION). Always transitions to PENDING_DOCS_REVIEW
 * regardless of orderType (disconnection now flows through DOCS too).
 *
 * Function name preserved for backward compat with the route mount.
 * Roles: SALES_DIRECTOR, SUPER_ADMIN.
 */
export const approveServiceOrder = asyncHandler(async function approveServiceOrder(req, res) {
  const { id } = req.params;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { campaignData: { select: { company: true } } } },
      createdBy: { select: { id: true, name: true } }
    }
  });

  if (!order) {
    return res.status(404).json({ message: 'Service order not found.' });
  }

  if (order.status !== 'PENDING_SALES_DIRECTOR_APPROVAL') {
    return res.status(400).json({ message: 'Order is not pending Sales Director approval.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'PENDING_DOCS_REVIEW',
      // Keep the legacy approvedBy fields populated for back-compat — these
      // are read by old reports.
      approvedById: req.user.id,
      approvedAt: new Date(),
      // New explicit field for the Sales Director gate.
      salesDirectorApprovedById: req.user.id,
      salesDirectorApprovedAt: new Date(),
    }
  });

  // Notify creator + DOCS_TEAM
  const companyName = order.customer?.campaignData?.company || 'Customer';
  await createNotification(
    order.createdById,
    'SAM_ASSIGNMENT',
    'Sales Director Approved — Pending Docs Review',
    `Your ${order.orderType} order (${order.orderNumber}) for "${companyName}" was approved and is now pending docs review.`,
    { serviceOrderId: id, orderNumber: order.orderNumber }
  );
  emitSidebarRefresh(order.createdById);

  const docsTeamUsers = await prisma.user.findMany({
    where: { role: 'DOCS_TEAM', isActive: true },
    select: { id: true }
  });
  for (const docsUser of docsTeamUsers) {
    await createNotification(
      docsUser.id,
      'SERVICE_ORDER',
      'New Order — Docs Review Pending',
      `${order.orderType.replace('_', ' ').toLowerCase()} order #${order.orderNumber} approved by Sales Director — ready for docs review.`,
      { serviceOrderId: id }
    );
    emitSidebarRefresh(docsUser.id);
  }
  await emitSidebarRefreshByRole('DOCS_TEAM');
  await emitSidebarRefreshByRole('SALES_DIRECTOR');
  await emitSidebarRefreshByRole('SUPER_ADMIN');
  await emitSidebarRefreshByRole('SAM_HEAD');

  res.json({ message: 'Service order approved.', data: updated });
});

/**
 * Delivery approval — first gate for UPGRADE / DOWNGRADE orders only.
 * Roles: DELIVERY_TEAM, SUPER_ADMIN.
 * Transitions: PENDING_DELIVERY_APPROVAL → PENDING_SALES_DIRECTOR_APPROVAL.
 */
export const deliveryApproveServiceOrder = asyncHandler(async function deliveryApproveServiceOrder(req, res) {
  const { id } = req.params;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { campaignData: { select: { company: true } } } },
      createdBy: { select: { id: true, name: true } }
    }
  });

  if (!order) return res.status(404).json({ message: 'Service order not found.' });
  if (order.status !== 'PENDING_DELIVERY_APPROVAL') {
    return res.status(400).json({ message: 'Order is not pending delivery approval.' });
  }
  if (!['UPGRADE', 'DOWNGRADE'].includes(order.orderType)) {
    return res.status(400).json({ message: 'Delivery approval only applies to upgrade/downgrade orders.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'PENDING_SALES_DIRECTOR_APPROVAL',
      deliveryApprovedById: req.user.id,
      deliveryApprovedAt: new Date(),
    }
  });

  // Notify Sales Director (next gate) + creator (status moved forward)
  const companyName = order.customer?.campaignData?.company || 'Customer';
  await createNotification(
    order.createdById,
    'SAM_ASSIGNMENT',
    'Delivery Approved — Pending Sales Director',
    `Your ${order.orderType} order (${order.orderNumber}) for "${companyName}" was approved by delivery and is now pending Sales Director approval.`,
    { serviceOrderId: id, orderNumber: order.orderNumber }
  );
  emitSidebarRefresh(order.createdById);
  await emitSidebarRefreshByRole('SALES_DIRECTOR');
  await emitSidebarRefreshByRole('SUPER_ADMIN');
  await emitSidebarRefreshByRole('DELIVERY_TEAM');

  res.json({ message: 'Service order approved by delivery.', data: updated });
});

/**
 * Reject a service order at either pending-approval state. Records which
 * stage rejected via `rejectedFromStatus` so reports can filter by gate.
 * Roles: DELIVERY_TEAM, SALES_DIRECTOR, SUPER_ADMIN.
 *
 * Note: docs review uses its own dedicated rejection path (DOCS_REJECTED),
 * so this endpoint only covers the two early gates.
 */
export const rejectServiceOrder = asyncHandler(async function rejectServiceOrder(req, res) {
  const { id } = req.params;
  const { rejectionReason } = req.body;

  if (!rejectionReason) {
    return res.status(400).json({ message: 'Rejection reason is required.' });
  }

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { campaignData: { select: { company: true } } } }
    }
  });

  if (!order) {
    return res.status(404).json({ message: 'Service order not found.' });
  }

  const rejectableStates = ['PENDING_DELIVERY_APPROVAL', 'PENDING_SALES_DIRECTOR_APPROVAL'];
  if (!rejectableStates.includes(order.status)) {
    return res.status(400).json({ message: 'Only orders pending delivery or Sales Director approval can be rejected here. Use docs-review reject for the docs stage.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'REJECTED',
      rejectionReason,
      rejectedFromStatus: order.status,   // captures which gate killed it
      approvedById: req.user.id,
      approvedAt: new Date(),
    }
  });

  // Notify creator
  const companyName = order.customer?.campaignData?.company || 'Customer';
  const rejector = order.status === 'PENDING_DELIVERY_APPROVAL' ? 'Delivery' : 'Sales Director';
  await createNotification(
    order.createdById,
    'SAM_ASSIGNMENT',
    'Service Order Rejected',
    `Your ${order.orderType} order (${order.orderNumber}) for "${companyName}" was rejected by ${rejector}: ${rejectionReason}`,
    { serviceOrderId: id, orderNumber: order.orderNumber }
  );
  emitSidebarRefresh(order.createdById);
  await emitSidebarRefreshByRole('SUPER_ADMIN');
  await emitSidebarRefreshByRole('SALES_DIRECTOR');
  await emitSidebarRefreshByRole('DELIVERY_TEAM');
  await emitSidebarRefreshByRole('SAM_HEAD');

  res.json({ message: 'Service order rejected.', data: updated });
});

/**
 * Process (complete) a service order
 * Roles: ACCOUNTS_TEAM, NOC
 */
export const processServiceOrder = asyncHandler(async function processServiceOrder(req, res) {
  const { id } = req.params;
  const { processNotes } = req.body;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { campaignData: { select: { company: true } } } }
    }
  });

  if (!order) {
    return res.status(404).json({ message: 'Service order not found.' });
  }

  if (order.status !== 'APPROVED') {
    return res.status(400).json({ message: 'Only approved orders can be processed.' });
  }

  // Verify role matches order type
  if (hasRole(req.user, 'NOC') && order.orderType !== 'DISCONNECTION') {
    return res.status(403).json({ message: 'NOC can only process disconnection orders.' });
  }
  if (hasRole(req.user, 'ACCOUNTS_TEAM') && !['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'].includes(order.orderType)) {
    return res.status(403).json({ message: 'Accounts team processes upgrade/downgrade/rate revision orders.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      processedById: req.user.id,
      processedAt: new Date(),
      processNotes: processNotes || null,
    }
  });

  // Notify creator
  const companyName = order.customer?.campaignData?.company || 'Customer';
  await createNotification(
    order.createdById,
    'SAM_ASSIGNMENT',
    'Service Order Completed',
    `Your ${order.orderType} order (${order.orderNumber}) for "${companyName}" has been processed.`,
    { serviceOrderId: id, orderNumber: order.orderNumber }
  );
  emitSidebarRefresh(order.createdById);
  await emitSidebarRefreshByRole('SUPER_ADMIN');
  await emitSidebarRefreshByRole('SAM_HEAD');
  await emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  await emitSidebarRefreshByRole('NOC');

  res.json({ message: 'Service order processed.', data: updated });
});

/**
 * Get docs review queue for all order types pending docs review
 * Roles: DOCS_TEAM, SUPER_ADMIN
 */
export const getDocsReviewQueue = asyncHandler(async function getDocsReviewQueue(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const search = req.query.search || '';

  const where = {
    status: 'PENDING_DOCS_REVIEW',
    orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'DISCONNECTION'] }
  };

  if (search) {
    where.OR = [
      { orderNumber: { contains: search, mode: 'insensitive' } },
      { customer: { campaignData: { company: { contains: search, mode: 'insensitive' } } } }
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.serviceOrder.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderNumber: true,
        orderType: true,
        status: true,
        currentPlanName: true,
        currentBandwidth: true,
        currentArc: true,
        newBandwidth: true,
        newArc: true,
        effectiveDate: true,
        attachments: true,
        approvalFileUrl: true,
        poFileUrl: true,
        notes: true,
        createdAt: true,
        customer: {
          select: {
            id: true,
            customerUsername: true,
            arcAmount: true,
            campaignData: {
              select: { company: true, name: true, phone: true, email: true }
            }
          }
        },
        createdBy: {
          select: { id: true, name: true, role: true }
        }
      }
    }),
    prisma.serviceOrder.count({ where })
  ]);

  res.json({
    orders,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

/**
 * Docs review disposition for a service order (approve/reject PO)
 * Roles: DOCS_TEAM, SUPER_ADMIN
 */
export const docsReviewServiceOrder = asyncHandler(async function docsReviewServiceOrder(req, res) {
  const { id } = req.params;
  const { decision, reason } = req.body;

  if (!decision || !['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ message: 'Decision must be APPROVED or REJECTED.' });
  }

  if (decision === 'REJECTED' && !reason) {
    return res.status(400).json({ message: 'Rejection reason is required.' });
  }

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } }
  });

  if (!order) return res.status(404).json({ message: 'Service order not found.' });
  if (order.status !== 'PENDING_DOCS_REVIEW') {
    return res.status(400).json({ message: 'Order is not pending docs review.' });
  }

  const updateData = {
    docsReviewedById: req.user.id,
    docsReviewedAt: new Date(),
    updatedAt: new Date()
  };

  if (decision === 'APPROVED') {
    updateData.status = 'PENDING_NOC';
    updateData.docsRejectionReason = null;
  } else {
    updateData.status = 'DOCS_REJECTED';
    updateData.docsRejectionReason = reason;
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: updateData
  });

  // Notifications
  if (decision === 'APPROVED') {
    // Notify creator
    await createNotification(
      order.createdBy.id,
      'SERVICE_ORDER',
      'PO Approved - Pending NOC',
      `Order #${order.orderNumber} PO has been approved. Now pending NOC processing.`,
      { serviceOrderId: id }
    );
    emitSidebarRefresh(order.createdBy.id);

    // Notify NOC team
    const nocUsers = await prisma.user.findMany({
      where: { role: 'NOC', isActive: true },
      select: { id: true }
    });
    for (const nocUser of nocUsers) {
      await createNotification(
        nocUser.id,
        'SERVICE_ORDER',
        'New Order - Bandwidth Change Required',
        `Order #${order.orderNumber} requires bandwidth change and speed test.`,
        { serviceOrderId: id }
      );
      emitSidebarRefresh(nocUser.id);
    }
    emitSidebarRefreshByRole('NOC');
  } else {
    // Notify creator of rejection
    await createNotification(
      order.createdBy.id,
      'SERVICE_ORDER',
      'PO Rejected',
      `Order #${order.orderNumber} PO was rejected: ${reason}`,
      { serviceOrderId: id }
    );
    emitSidebarRefresh(order.createdBy.id);
  }

  emitSidebarRefreshByRole('DOCS_TEAM');
  emitSidebarRefreshByRole('SAM_HEAD');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({ message: `Order ${decision === 'APPROVED' ? 'approved' : 'rejected'} successfully.`, data: updated });
});

/**
 * Get NOC queue for all order types pending NOC processing (disconnection skips speed test)
 * Roles: NOC_TEAM, SUPER_ADMIN
 */
export const getNocServiceOrderQueue = asyncHandler(async function getNocServiceOrderQueue(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const search = req.query.search || '';

  // NOC sees every order at PENDING_NOC. Disconnections now flow through
  // the same path as commercial changes (no more APPROVED short-circuit) —
  // NOC just confirms; final plan deactivation happens in ACCOUNTS.
  const baseWhere = { status: 'PENDING_NOC' };

  const where = search
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { orderNumber: { contains: search, mode: 'insensitive' } },
              { customer: { campaignData: { company: { contains: search, mode: 'insensitive' } } } },
            ],
          },
        ],
      }
    : baseWhere;

  const [orders, total] = await Promise.all([
    prisma.serviceOrder.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderNumber: true,
        orderType: true,
        status: true,
        currentPlanName: true,
        currentBandwidth: true,
        currentArc: true,
        newBandwidth: true,
        newArc: true,
        effectiveDate: true,
        attachments: true,
        approvalFileUrl: true,
        poFileUrl: true,
        notes: true,
        docsReviewedAt: true,
        createdAt: true,
        disconnectionDate: true,
        disconnectionReason: true,
        disconnectionCategory: { select: { id: true, name: true } },
        disconnectionSubCategory: { select: { id: true, name: true } },
        customer: {
          select: {
            id: true,
            customerUsername: true,
            customerIpAssigned: true,
            circuitId: true,
            campaignData: {
              select: { company: true, name: true, phone: true, email: true }
            }
          }
        },
        createdBy: {
          select: { id: true, name: true, role: true }
        },
        docsReviewedBy: {
          select: { id: true, name: true }
        }
      }
    }),
    prisma.serviceOrder.count({ where })
  ]);

  res.json({
    orders,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

/**
 * NOC processes a service order - uploads speed test after bandwidth change
 * Roles: NOC_TEAM, SUPER_ADMIN
 */
export const nocProcessServiceOrder = asyncHandler(async function nocProcessServiceOrder(req, res) {
  const { id } = req.params;
  const { nocNotes } = req.body;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } }
  });

  if (!order) return res.status(404).json({ message: 'Service order not found.' });
  if (order.status !== 'PENDING_NOC') {
    return res.status(400).json({ message: 'Order is not pending NOC processing.' });
  }

  // Speed test required for bandwidth-changing orders. Disconnection is just
  // a NOC confirmation — no speed to test (final plan deactivation now
  // happens in ACCOUNTS, not here).
  const requiresSpeedTest = ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'].includes(order.orderType);
  if (requiresSpeedTest && !req.file) {
    return res.status(400).json({ message: 'Speed test screenshot is required.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'PENDING_ACCOUNTS',
      nocSpeedTestUrl: req.file?.path || null,
      nocSpeedTestUploadedAt: req.file ? new Date() : null,
      nocProcessedById: req.user.id,
      nocProcessedAt: new Date(),
      nocNotes: nocNotes || null,
      updatedAt: new Date(),
    }
  });

  await createNotification(
    order.createdBy.id,
    'SERVICE_ORDER',
    'NOC Complete — Pending Accounts',
    `Order #${order.orderNumber} processed by NOC. Now pending accounts.`,
    { serviceOrderId: id }
  );
  emitSidebarRefresh(order.createdBy.id);
  emitSidebarRefreshByRole('NOC');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SAM_HEAD');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({ message: 'NOC processing completed. Order moved to accounts.', data: updated });
});

/**
 * DEPRECATED: SAM no longer sets activation dates. The new flow goes
 * NOC → ACCOUNTS → COMPLETED automatically; the 10-day notice is enforced
 * SAM-side via scheduled_termination_at and CRM only mirrors on COMPLETED.
 *
 * Endpoint kept mounted to return 410 for any clients still calling it.
 */
export const setActivationDate = asyncHandler(async function setActivationDate(req, res) {
  return res.status(410).json({
    message: 'set-activation-date is deprecated. The new flow goes NOC → ACCOUNTS → COMPLETED automatically.',
  });
});

/**
 * Internal helper: run the full completion pipeline for a service order.
 *
 *   - DISCONNECTION: deactivate the customer's plan + mark COMPLETED.
 *   - UPGRADE/DOWNGRADE/RATE_REVISION: write PlanUpgradeHistory, update
 *     the lead's plan fields, mark COMPLETED, fire the SAM activation
 *     webhook with the new canonical values.
 *
 * Used by:
 *   - accountsProcessServiceOrder (no-date-change path)
 *   - approveDateChange           (admin approves accounts-proposed date)
 *
 * The activationDate passed in becomes the order's effectiveDate AND the
 * planStartDate / upgradeDate stamp on the lead and history. For the
 * approve-date-change path this is the user-proposed date; for the
 * straight-through path it's order.effectiveDate (or "now" as fallback).
 *
 * Returns the updated service order. Notifies + emits sidebar refresh.
 */
async function completeServiceOrder({ order, lead, activationDate, processNotes, userId }) {
  // ── DISCONNECTION ────────────────────────────────────────────────
  if (order.orderType === 'DISCONNECTION') {
    const [updatedOrder] = await prisma.$transaction([
      prisma.serviceOrder.update({
        where: { id: order.id },
        data: {
          status: 'COMPLETED',
          effectiveDate: activationDate,
          processedById: userId,
          processedAt: new Date(),
          processNotes: processNotes ?? order.processNotes ?? null,
          updatedAt: new Date(),
        },
      }),
      prisma.lead.update({
        where: { id: order.customerId },
        data: { actualPlanIsActive: false },
      }),
    ]);
    return updatedOrder;
  }

  // ── UPGRADE / DOWNGRADE / RATE_REVISION ─────────────────────────
  const oldArc = lead.arcAmount || lead.actualPlanPrice || 0;
  const newArc = order.newArc;
  const newBandwidth = order.newBandwidth || lead.actualPlanBandwidth;

  // Idempotency: lead already at the requested state → just complete, skip history
  if (
    lead.actualPlanBandwidth === newBandwidth &&
    Number(lead.arcAmount) === Number(newArc)
  ) {
    return prisma.serviceOrder.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        effectiveDate: activationDate,
        processedById: userId,
        processedAt: new Date(),
        processNotes: `${processNotes || ''} [no-op: lead already matches requested state]`.trim(),
        updatedAt: new Date(),
      },
    });
  }

  let actionType = 'UPGRADE';
  if (order.orderType === 'DOWNGRADE') actionType = 'DOWNGRADE';
  else if (order.orderType === 'RATE_REVISION') actionType = 'RATE_REVISION';

  let bandwidthDisplay;
  if (newBandwidth >= 1000) bandwidthDisplay = `${(newBandwidth / 1000).toFixed(1)} Gbps`;
  else                       bandwidthDisplay = `${newBandwidth} Mbps`;

  const newMonthlyPrice = Math.round(newArc / 12);
  const arcFormatted = Number(newArc).toLocaleString('en-IN');
  const newPlanName = `${bandwidthDisplay} - ₹${arcFormatted}/year`;

  const result = await prisma.$transaction(async (tx) => {
    const history = await tx.planUpgradeHistory.create({
      data: {
        leadId: lead.id,
        actionType,
        previousPlanName: lead.actualPlanName || 'Unknown',
        previousBandwidth: lead.actualPlanBandwidth || 0,
        previousUploadBandwidth: lead.actualPlanUploadBandwidth,
        previousArc: oldArc,
        previousValidityDays: lead.actualPlanValidityDays || 30,
        previousBillingType: lead.actualPlanBillingType || 'PREPAID',
        previousPlanStartDate: lead.actualPlanStartDate || new Date(),
        previousPlanEndDate: lead.actualPlanEndDate || new Date(),
        newPlanName,
        newBandwidth,
        newArc,
        additionalArc: order.orderType === 'UPGRADE' ? (newArc - oldArc) : null,
        degradeArc: (order.orderType === 'DOWNGRADE' || order.orderType === 'RATE_REVISION') ? (oldArc - newArc) : null,
        upgradeDate: activationDate,
        daysOnOldPlan: 0,
        daysOnNewPlan: 0,
        oldPlanAmount: 0,
        newPlanAmount: 0,
        totalAmount: 0,
        originalAmount: 0,
        differenceAmount: newArc - oldArc,
        notes: `Service Order #${order.orderNumber} - ${order.orderType}. ${processNotes || ''}`.trim(),
        createdById: userId,
      },
    });

    const updatedLead = await tx.lead.update({
      where: { id: lead.id },
      data: {
        actualPlanName: newPlanName,
        actualPlanBandwidth: newBandwidth,
        actualPlanPrice: newMonthlyPrice,
        arcAmount: newArc,
        actualPlanStartDate: activationDate,
        bandwidthRequirement: bandwidthDisplay,
        actualPlanNotes: lead.actualPlanNotes
          ? `${lead.actualPlanNotes}\n\n[${order.orderType} ${new Date().toISOString().split('T')[0]}] Order #${order.orderNumber} - ARC: ₹${oldArc} → ₹${newArc}. ${processNotes || ''}`
          : `[${order.orderType} ${new Date().toISOString().split('T')[0]}] Order #${order.orderNumber} - ARC: ₹${oldArc} → ₹${newArc}. ${processNotes || ''}`,
      },
      include: { campaignData: { select: { company: true, name: true, email: true, phone: true } } },
    });

    const updatedOrder = await tx.serviceOrder.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        effectiveDate: activationDate,
        processedById: userId,
        processedAt: new Date(),
        processNotes: processNotes || null,
        updatedAt: new Date(),
      },
    });

    const webhookLog = await enqueueActivationWebhook(tx, updatedLead);
    return { history, updatedLead, updatedOrder, webhookLogId: webhookLog?.id || null };
  });

  if (result.webhookLogId) {
    attemptDeliveryInBackground(result.webhookLogId);
  }
  return result.updatedOrder;
}

/**
 * Accounts processes a service order - applies plan change and starts billing
 * This is the critical endpoint that actually changes the customer's plan
 * Roles: ACCOUNTS_TEAM, SUPER_ADMIN
 */
export const accountsProcessServiceOrder = asyncHandler(async function accountsProcessServiceOrder(req, res) {
  const { id } = req.params;
  const { processNotes, newEffectiveDate } = req.body;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          actualPlanName: true,
          actualPlanBandwidth: true,
          actualPlanUploadBandwidth: true,
          actualPlanPrice: true,
          actualPlanValidityDays: true,
          actualPlanBillingType: true,
          actualPlanBillingCycle: true,
          actualPlanStartDate: true,
          actualPlanEndDate: true,
          actualPlanNotes: true,
          arcAmount: true,
          campaignData: { select: { company: true } }
        }
      },
      createdBy: { select: { id: true, name: true } }
    }
  });

  if (!order) return res.status(404).json({ message: 'Service order not found.' });
  if (order.status !== 'PENDING_ACCOUNTS') {
    return res.status(400).json({ message: 'Order is not pending accounts processing.' });
  }
  if (!['UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'DISCONNECTION'].includes(order.orderType)) {
    return res.status(400).json({ message: 'Invalid order type for accounts processing.' });
  }

  // If the Accounts user proposed a different effectiveDate, hand off to
  // SUPER_ADMIN for approval — don't complete yet. The order pauses at
  // PENDING_ADMIN_DATE_APPROVAL until admin approves (which then re-runs
  // the completion logic with the new date) or rejects (which sends it
  // back here).
  if (newEffectiveDate) {
    const proposed = new Date(newEffectiveDate);
    if (isNaN(proposed.getTime())) {
      return res.status(400).json({ message: 'Invalid newEffectiveDate.' });
    }
    const current = order.effectiveDate ? new Date(order.effectiveDate).getTime() : null;
    if (proposed.getTime() !== current) {
      const paused = await prisma.serviceOrder.update({
        where: { id },
        data: {
          status: 'PENDING_ADMIN_DATE_APPROVAL',
          proposedEffectiveDate: proposed,
          proposedEffectiveDateById: req.user.id,
          proposedEffectiveDateAt: new Date(),
          processNotes: processNotes || null,
          processedById: req.user.id,
          processedAt: new Date(),
        },
      });
      // Notify SUPER_ADMIN
      const admins = await prisma.user.findMany({
        where: { role: 'SUPER_ADMIN', isActive: true },
        select: { id: true },
      });
      for (const a of admins) {
        await createNotification(
          a.id,
          'SERVICE_ORDER',
          'Order date change needs your approval',
          `Accounts changed effectiveDate on ${order.orderNumber}. Awaiting your approval.`,
          { serviceOrderId: id }
        );
        emitSidebarRefresh(a.id);
      }
      emitSidebarRefreshByRole('SUPER_ADMIN');
      emitSidebarRefreshByRole('ACCOUNTS_TEAM');
      return res.json({
        message: 'Date change submitted for admin approval.',
        data: paused,
      });
    }
  }

  // No (or unchanged) effectiveDate → run the full completion now.
  const activationDate = order.activationDate || order.effectiveDate || new Date();
  const updatedOrder = await completeServiceOrder({
    order,
    lead: order.customer,
    activationDate,
    processNotes,
    userId: req.user.id,
  });

  // Notify creator
  await createNotification(
    order.createdBy.id,
    'SERVICE_ORDER',
    order.orderType === 'DISCONNECTION' ? 'Disconnection Completed' : 'Service Order Completed',
    order.orderType === 'DISCONNECTION'
      ? `Order #${order.orderNumber} disconnected — customer plan deactivated.`
      : `Order #${order.orderNumber} (${order.orderType}) processed and completed.`,
    { serviceOrderId: id }
  );
  emitSidebarRefresh(order.createdBy.id);
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SAM_HEAD');
  emitSidebarRefreshByRole('SAM_EXECUTIVE');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  return res.json({
    message: order.orderType === 'DISCONNECTION'
      ? 'Disconnection completed. Customer plan deactivated.'
      : 'Service order processed and completed.',
    data: updatedOrder,
  });
});

/**
 * Admin approves the date change proposed by Accounts. Runs the full
 * completion pipeline — for UPGRADE/DOWNGRADE/RATE_REVISION this writes
 * PlanUpgradeHistory, swaps the lead's plan fields, and re-fires the SAM
 * activation webhook with the admin-approved effective date; for
 * DISCONNECTION it deactivates the customer's plan. The order's
 * effectiveDate is set to the proposed date as part of completion.
 *
 * Roles: SUPER_ADMIN.
 */
export const approveDateChange = asyncHandler(async function approveDateChange(req, res) {
  const { id } = req.params;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          actualPlanName: true,
          actualPlanBandwidth: true,
          actualPlanUploadBandwidth: true,
          actualPlanPrice: true,
          actualPlanValidityDays: true,
          actualPlanBillingType: true,
          actualPlanBillingCycle: true,
          actualPlanStartDate: true,
          actualPlanEndDate: true,
          actualPlanNotes: true,
          arcAmount: true,
          campaignData: { select: { company: true } },
        },
      },
      createdBy: { select: { id: true, name: true } },
    },
  });

  if (!order) return res.status(404).json({ message: 'Service order not found.' });
  if (order.status !== 'PENDING_ADMIN_DATE_APPROVAL') {
    return res.status(400).json({ message: 'Order is not pending date-change approval.' });
  }
  if (!order.proposedEffectiveDate) {
    return res.status(400).json({ message: 'No proposed date found on this order.' });
  }

  // Run the full completion using the admin-approved date
  await completeServiceOrder({
    order,
    lead: order.customer,
    activationDate: order.proposedEffectiveDate,
    processNotes: order.processNotes,
    userId: req.user.id,
  });

  // Clear the proposed-date fields now that the date is applied
  const finalOrder = await prisma.serviceOrder.update({
    where: { id },
    data: {
      proposedEffectiveDate: null,
      proposedEffectiveDateById: null,
      proposedEffectiveDateAt: null,
    },
  });

  await createNotification(
    order.createdBy.id,
    'SERVICE_ORDER',
    'Order completed',
    `Order ${order.orderNumber} (${order.orderType}) approved with the proposed effective date and completed.`,
    { serviceOrderId: id }
  );
  emitSidebarRefresh(order.createdBy.id);
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SAM_HEAD');
  emitSidebarRefreshByRole('SAM_EXECUTIVE');

  res.json({ message: 'Date change approved and order completed.', data: finalOrder });
});

/**
 * Admin rejects the date change. Order goes back to PENDING_ACCOUNTS for
 * Accounts to retry. The originally-proposed date is cleared.
 * Roles: SUPER_ADMIN.
 * Body: { rejectionReason } (required, min 5 chars)
 */
export const rejectDateChange = asyncHandler(async function rejectDateChange(req, res) {
  const { id } = req.params;
  const { rejectionReason } = req.body;
  if (!rejectionReason || rejectionReason.trim().length < 5) {
    return res.status(400).json({ message: 'Rejection reason is required (min 5 chars).' });
  }

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: { proposedEffectiveDateBy: { select: { id: true, name: true } } },
  });
  if (!order) return res.status(404).json({ message: 'Service order not found.' });
  if (order.status !== 'PENDING_ADMIN_DATE_APPROVAL') {
    return res.status(400).json({ message: 'Order is not pending date-change approval.' });
  }

  // No dedicated accountsNotes column exists — write rejection context into
  // the shared `notes` field with a clear prefix so it surfaces in the
  // detail UI.
  const trimmedReason = rejectionReason.trim();
  const rejectionNote = `[Date change rejected ${new Date().toISOString().split('T')[0]}] ${trimmedReason}`;

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'PENDING_ACCOUNTS',
      proposedEffectiveDate: null,
      proposedEffectiveDateById: null,
      proposedEffectiveDateAt: null,
      notes: order.notes ? `${order.notes}\n${rejectionNote}` : rejectionNote,
    },
  });

  // Notify the accounts user who proposed it
  if (order.proposedEffectiveDateBy?.id) {
    await createNotification(
      order.proposedEffectiveDateBy.id,
      'SERVICE_ORDER',
      'Date change rejected',
      `Your effectiveDate change on ${order.orderNumber} was rejected: ${trimmedReason}`,
      { serviceOrderId: id }
    );
    emitSidebarRefresh(order.proposedEffectiveDateBy.id);
  }
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({ message: 'Date change rejected. Order returned to Accounts.', data: updated });
});

/**
 * Upload attachment to a service order
 * Roles: SAM_HEAD, SAM_EXECUTIVE, SUPER_ADMIN
 */
export const uploadOrderAttachment = asyncHandler(async function uploadOrderAttachment(req, res) {
  const { id } = req.params;

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    select: { id: true, attachments: true, createdById: true, status: true }
  });

  if (!order) {
    return res.status(404).json({ message: 'Service order not found.' });
  }

  // SAM_EXECUTIVE can only upload to their own orders
  if (hasRole(req.user, 'SAM_EXECUTIVE') && order.createdById !== req.user.id) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }

  const newAttachment = {
    url: req.file.path,
    publicId: req.file.filename,
    originalName: req.file.originalname,
    uploadedAt: new Date().toISOString(),
  };

  const existingAttachments = Array.isArray(order.attachments) ? order.attachments : [];

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      attachments: [...existingAttachments, newAttachment]
    }
  });

  res.json({ message: 'Attachment uploaded.', data: updated });
});
