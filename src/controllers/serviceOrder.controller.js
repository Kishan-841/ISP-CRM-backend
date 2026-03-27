import prisma from '../config/db.js';
import { hasRole, hasAnyRole, isAdmin } from '../utils/roleHelper.js';
import { generateServiceOrderNumber } from '../services/documentNumber.service.js';
import { createNotification, notifyAllAdmins } from '../services/notification.service.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import { asyncHandler, parsePagination, paginatedResponse, buildSearchFilter } from '../utils/controllerHelper.js';

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
      subCategories: {
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true }
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
  const { customerId, orderType, newBandwidth, newArc, disconnectionReason, disconnectionCategoryId, disconnectionSubCategoryId, notes, effectiveDate } = req.body;

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

  if (orderType === 'RATE_REVISION' && !newArc) {
    return res.status(400).json({ message: 'New ARC is required for rate revision.' });
  }

  if (orderType === 'DISCONNECTION') {
    if (!disconnectionCategoryId || !disconnectionSubCategoryId) {
      return res.status(400).json({ message: 'Disconnection category and sub-category are required.' });
    }
    // Validate category and subcategory exist
    const subCategory = await prisma.disconnectionSubCategory.findFirst({
      where: { id: disconnectionSubCategoryId, categoryId: disconnectionCategoryId, isActive: true }
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

  const data = {
    orderNumber,
    customerId,
    orderType,
    status: orderType === 'DISCONNECTION' ? 'PENDING_APPROVAL' : 'PENDING_DOCS_REVIEW',
    createdById: req.user.id,
    currentPlanName: customer.actualPlanName,
    currentBandwidth: customer.actualPlanBandwidth,
    currentArc: customer.arcAmount ?? customer.actualPlanPrice,
    effectiveDate: effectiveDate ? new Date(effectiveDate) : null,
    notes: notes || null,
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
    const currentArc = customer.arcAmount ?? customer.actualPlanPrice;
    const currentBandwidth = customer.actualPlanBandwidth;

    // ARC must decrease for rate revision
    if (currentArc && parsedArc >= currentArc) {
      return res.status(400).json({ message: 'Rate revision requires lower ARC than current.' });
    }

    // Bandwidth can stay same or increase, but not decrease
    if (newBandwidth && currentBandwidth && parseInt(newBandwidth) < currentBandwidth) {
      return res.status(400).json({ message: 'Rate revision cannot reduce bandwidth.' });
    }

    data.newArc = parsedArc;
    data.newBandwidth = newBandwidth ? parseInt(newBandwidth) : null;
  }

  if (orderType === 'DISCONNECTION') {
    data.disconnectionCategoryId = disconnectionCategoryId;
    data.disconnectionSubCategoryId = disconnectionSubCategoryId;
    data.disconnectionReason = disconnectionReason || null;
    data.disconnectionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const order = await prisma.serviceOrder.create({ data });

  // Notify relevant team based on order type
  const companyName = customer.campaignData?.company || 'Customer';

  if (orderType === 'DISCONNECTION') {
    // Disconnection: notify SUPER_ADMIN (old flow)
    await notifyAllAdmins(
      'SAM_ASSIGNMENT',
      'New Service Order',
      `${orderType} request for "${companyName}" (${orderNumber}) requires approval.`,
      { serviceOrderId: order.id, orderNumber, orderType }
    );
    await emitSidebarRefreshByRole('SUPER_ADMIN');
  } else {
    // UPGRADE/DOWNGRADE/RATE_REVISION: notify DOCS_TEAM (new flow)
    const docsTeamUsers = await prisma.user.findMany({
      where: { role: 'DOCS_TEAM', isActive: true },
      select: { id: true }
    });
    for (const docsUser of docsTeamUsers) {
      await createNotification(
        docsUser.id,
        'SERVICE_ORDER',
        'New Order Request - PO Review',
        `New ${orderType.replace('_', ' ').toLowerCase()} order #${order.orderNumber} requires PO review.`,
        { serviceOrderId: order.id }
      );
      emitSidebarRefresh(docsUser.id);
    }
    await emitSidebarRefreshByRole('DOCS_TEAM');
  }

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

  // Role-based filtering
  if (hasRole(req.user, 'SAM_EXECUTIVE')) {
    where.createdById = req.user.id;
  } else if (hasRole(req.user, 'DOCS_TEAM')) {
    where.status = 'PENDING_DOCS_REVIEW';
    where.orderType = { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] };
  } else if (hasRole(req.user, 'ACCOUNTS_TEAM')) {
    where.status = 'PENDING_ACCOUNTS';
    where.orderType = { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] };
  } else if (hasRole(req.user, 'NOC')) {
    where.OR = [
      { status: 'PENDING_NOC', orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] } },
      { status: 'APPROVED', orderType: 'DISCONNECTION' }
    ];
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
 * Approve a service order
 * Role: SUPER_ADMIN
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

  if (order.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ message: 'Only pending orders can be approved.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'APPROVED',
      approvedById: req.user.id,
      approvedAt: new Date(),
    }
  });

  // Notify creator
  const companyName = order.customer?.campaignData?.company || 'Customer';
  await createNotification(
    order.createdById,
    'SAM_ASSIGNMENT',
    'Service Order Approved',
    `Your ${order.orderType} order (${order.orderNumber}) for "${companyName}" has been approved.`,
    { serviceOrderId: id, orderNumber: order.orderNumber }
  );
  emitSidebarRefresh(order.createdById);

  // Notify relevant team
  if (order.orderType === 'DISCONNECTION') {
    await emitSidebarRefreshByRole('NOC');
  } else {
    await emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  }
  await emitSidebarRefreshByRole('SUPER_ADMIN');
  await emitSidebarRefreshByRole('SAM_HEAD');

  res.json({ message: 'Service order approved.', data: updated });
});

/**
 * Reject a service order
 * Role: SUPER_ADMIN
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

  if (order.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ message: 'Only pending orders can be rejected.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'REJECTED',
      rejectionReason,
      approvedById: req.user.id,
      approvedAt: new Date(),
    }
  });

  // Notify creator
  const companyName = order.customer?.campaignData?.company || 'Customer';
  await createNotification(
    order.createdById,
    'SAM_ASSIGNMENT',
    'Service Order Rejected',
    `Your ${order.orderType} order (${order.orderNumber}) for "${companyName}" was rejected: ${rejectionReason}`,
    { serviceOrderId: id, orderNumber: order.orderNumber }
  );
  emitSidebarRefresh(order.createdById);
  await emitSidebarRefreshByRole('SUPER_ADMIN');
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
 * Get docs review queue for UPGRADE/DOWNGRADE/RATE_REVISION orders
 * Roles: DOCS_TEAM, SUPER_ADMIN
 */
export const getDocsReviewQueue = asyncHandler(async function getDocsReviewQueue(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const search = req.query.search || '';

  const where = {
    status: 'PENDING_DOCS_REVIEW',
    orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] }
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
 * Get NOC queue for UPGRADE/DOWNGRADE/RATE_REVISION orders pending bandwidth change
 * Roles: NOC_TEAM, SUPER_ADMIN
 */
export const getNocServiceOrderQueue = asyncHandler(async function getNocServiceOrderQueue(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const search = req.query.search || '';

  const where = {
    status: 'PENDING_NOC',
    orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] }
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
        notes: true,
        docsReviewedAt: true,
        createdAt: true,
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

  if (!req.file) {
    return res.status(400).json({ message: 'Speed test screenshot is required.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'PENDING_SAM_ACTIVATION',
      nocSpeedTestUrl: req.file.path,
      nocSpeedTestUploadedAt: new Date(),
      nocProcessedById: req.user.id,
      nocProcessedAt: new Date(),
      nocNotes: nocNotes || null,
      updatedAt: new Date()
    }
  });

  // Notify creator (SAM) that NOC is done, they need activation date
  await createNotification(
    order.createdBy.id,
    'SERVICE_ORDER',
    'NOC Complete - Set Activation Date',
    `Order #${order.orderNumber} bandwidth change is done. Please set activation date from customer.`,
    { serviceOrderId: id }
  );
  emitSidebarRefresh(order.createdBy.id);
  emitSidebarRefreshByRole('NOC');
  emitSidebarRefreshByRole('SAM_HEAD');
  emitSidebarRefreshByRole('SAM_EXECUTIVE');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({ message: 'NOC processing completed. Order moved to SAM for activation date.', data: updated });
});

/**
 * Set activation date for a service order after NOC processing
 * SAM gets the billing start date from customer and enters it here
 * Roles: SAM_EXECUTIVE, SAM_HEAD, SUPER_ADMIN
 */
export const setActivationDate = asyncHandler(async function setActivationDate(req, res) {
  const { id } = req.params;
  const { activationDate } = req.body;

  if (!activationDate) {
    return res.status(400).json({ message: 'Activation date is required.' });
  }

  const order = await prisma.serviceOrder.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } }
  });

  if (!order) return res.status(404).json({ message: 'Service order not found.' });
  if (order.status !== 'PENDING_SAM_ACTIVATION') {
    return res.status(400).json({ message: 'Order is not pending activation date.' });
  }

  // SAM_EXECUTIVE can only set for their own orders
  if (req.user.role === 'SAM_EXECUTIVE' && order.createdById !== req.user.id) {
    return res.status(403).json({ message: 'You can only set activation date for your own orders.' });
  }

  const updated = await prisma.serviceOrder.update({
    where: { id },
    data: {
      status: 'PENDING_ACCOUNTS',
      activationDate: new Date(activationDate),
      activationSetById: req.user.id,
      activationSetAt: new Date(),
      updatedAt: new Date()
    }
  });

  // Notify ACCOUNTS_TEAM
  const accountsUsers = await prisma.user.findMany({
    where: { role: 'ACCOUNTS_TEAM', isActive: true },
    select: { id: true }
  });
  for (const accUser of accountsUsers) {
    await createNotification(
      accUser.id,
      'SERVICE_ORDER',
      'Order Ready for Billing',
      `Order #${order.orderNumber} activation date set. Ready to start billing.`,
      { serviceOrderId: id }
    );
    emitSidebarRefresh(accUser.id);
  }
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SAM_HEAD');
  emitSidebarRefreshByRole('SAM_EXECUTIVE');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({ message: 'Activation date set. Order moved to accounts for billing.', data: updated });
});

/**
 * Accounts processes a service order - applies plan change and starts billing
 * This is the critical endpoint that actually changes the customer's plan
 * Roles: ACCOUNTS_TEAM, SUPER_ADMIN
 */
export const accountsProcessServiceOrder = asyncHandler(async function accountsProcessServiceOrder(req, res) {
  const { id } = req.params;
  const { processNotes } = req.body;

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
  if (!['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'].includes(order.orderType)) {
    return res.status(400).json({ message: 'Invalid order type for accounts processing.' });
  }

  const lead = order.customer;
  const activationDate = order.activationDate;
  const oldArc = lead.arcAmount || lead.actualPlanPrice || 0;
  const newArc = order.newArc;
  const newBandwidth = order.newBandwidth || lead.actualPlanBandwidth;

  // Determine action type for history
  let actionType = 'UPGRADE';
  if (order.orderType === 'DOWNGRADE') actionType = 'DOWNGRADE';
  else if (order.orderType === 'RATE_REVISION') actionType = 'RATE_REVISION';

  // Build bandwidth display string
  // Service orders store bandwidth in Mbps (unlike lead which stores Kbps)
  let bandwidthDisplay;
  if (newBandwidth >= 1000) {
    bandwidthDisplay = `${(newBandwidth / 1000).toFixed(1)} Gbps`;
  } else {
    bandwidthDisplay = `${newBandwidth} Mbps`;
  }

  // Build plan name
  const newPlanName = `${bandwidthDisplay} - ₹${newArc}/month`;

  // Use transaction to update everything atomically
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create PlanUpgradeHistory
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
        createdById: req.user.id
      }
    });

    // 2. Update Lead's actual plan fields
    const updatedLead = await tx.lead.update({
      where: { id: lead.id },
      data: {
        actualPlanName: newPlanName,
        actualPlanBandwidth: newBandwidth,
        actualPlanPrice: newArc,
        arcAmount: newArc,
        actualPlanStartDate: activationDate,
        bandwidthRequirement: bandwidthDisplay,
        actualPlanNotes: lead.actualPlanNotes
          ? `${lead.actualPlanNotes}\n\n[${order.orderType} ${new Date().toISOString().split('T')[0]}] Order #${order.orderNumber} - ARC: ₹${oldArc} → ₹${newArc}. ${processNotes || ''}`
          : `[${order.orderType} ${new Date().toISOString().split('T')[0]}] Order #${order.orderNumber} - ARC: ₹${oldArc} → ₹${newArc}. ${processNotes || ''}`
      }
    });

    // 3. Update service order to COMPLETED
    const updatedOrder = await tx.serviceOrder.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        processedById: req.user.id,
        processedAt: new Date(),
        processNotes: processNotes || null,
        updatedAt: new Date()
      }
    });

    return { history, updatedLead, updatedOrder };
  });

  // Notifications
  await createNotification(
    order.createdBy.id,
    'SERVICE_ORDER',
    'Order Completed - Billing Started',
    `Order #${order.orderNumber} billing has been started from ${new Date(activationDate).toLocaleDateString('en-IN')}.`,
    { serviceOrderId: id }
  );
  emitSidebarRefresh(order.createdBy.id);
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SAM_HEAD');
  emitSidebarRefreshByRole('SAM_EXECUTIVE');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    message: `Order completed. Billing started from ${new Date(activationDate).toLocaleDateString('en-IN')}. ARC: ₹${oldArc} → ₹${newArc}.`,
    data: result.updatedOrder
  });
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
