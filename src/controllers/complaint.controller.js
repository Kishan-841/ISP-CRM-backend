import prisma from '../config/db.js';
import { isAdmin, hasRole, hasAnyRole } from '../utils/roleHelper.js';
import { generateComplaintNumber } from '../services/documentNumber.service.js';
import {
  notifyComplaintCreated,
  notifyComplaintAssigned,
  notifyComplaintStatusChanged,
} from '../services/notification.service.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import { deleteFromCloudinary } from '../config/cloudinary.js';
import { asyncHandler, parsePagination, buildDateFilter, buildSearchFilter, paginatedResponse } from '../utils/controllerHelper.js';

// Allowed status transitions
const VALID_TRANSITIONS = {
  OPEN: ['CLOSED'],
  CLOSED: [],
};

// Roles allowed to create complaints
const CREATOR_ROLES = ['NOC', 'SUPPORT_TEAM', 'SUPER_ADMIN'];

// Roles allowed to view all complaints (not just their own)
const ADMIN_VIEW_ROLES = ['SUPER_ADMIN', 'ADMIN', 'NOC', 'OPS_TEAM'];

// Select clause for complaint list (lightweight)
const complaintListSelect = {
  id: true,
  complaintNumber: true,
  status: true,
  priority: true,
  description: true,
  tatHours: true,
  tatDeadline: true,
  reopenCount: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  closedAt: true,
  complaintDate: true,
  reasonForOutage: true,
  resolution: true,
  resolutionType: true,
  closeRemark: true,
  serviceImpact: true,
  ispImpactFrom: true,
  ispImpactTo: true,
  customerImpactFrom: true,
  customerImpactTo: true,
  closedById: true,
  closedBy: { select: { id: true, name: true } },
  lead: {
    select: {
      id: true,
      customerUsername: true,
      campaignData: {
        select: {
          company: true,
          name: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
        }
      },
    }
  },
  category: { select: { id: true, name: true } },
  subCategory: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true, role: true } },
  assignments: {
    where: { isActive: true },
    select: {
      id: true,
      user: { select: { id: true, name: true, role: true } },
      assignedBy: { select: { id: true, name: true } },
      assignedAt: true,
    }
  },
};

// Select clause for complaint detail (full)
const complaintDetailSelect = {
  ...complaintListSelect,
  notes: true,
  resolutionNotes: true,
  attachments: {
    select: {
      id: true,
      fileName: true,
      fileUrl: true,
      fileType: true,
      fileSize: true,
      uploadedBy: { select: { id: true, name: true } },
      createdAt: true,
    }
  },
  reasonForOutage: true,
  resolution: true,
  resolutionType: true,
  closeRemark: true,
  serviceImpact: true,
  ispImpactFrom: true,
  ispImpactTo: true,
  customerImpactFrom: true,
  customerImpactTo: true,
  closedById: true,
  closedBy: { select: { id: true, name: true, role: true } },
  metadata: true,
  lead: {
    select: {
      id: true,
      customerUsername: true,
      customerUserId: true,
      billingAddress: true,
      installationAddress: true,
      serviceType: true,
      actualPlanName: true,
      actualPlanIsActive: true,
      campaignData: {
        select: {
          company: true,
          name: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
        }
      },
    }
  },
};

// Helper: check if user is assigned to complaint
// Note: assignments are fetched with `where: { isActive: true }` so all returned are active.
// The select uses `user: { select: { id, ... } }` not the scalar `userId` field.
const isAssigned = (complaint, userId) => {
  return complaint.assignments.some(a => a.user?.id === userId);
};

// Helper: get active assignee user IDs
const getAssigneeIds = (complaint) => {
  return complaint.assignments.filter(a => a.isActive).map(a => a.userId);
};

// ==================== CREATE ====================

// POST /api/complaints
export const createComplaint = asyncHandler(async function createComplaint(req, res) {
  if (!hasAnyRole(req.user, CREATOR_ROLES)) {
    return res.status(403).json({ message: 'Access denied. Only NOC, Support Team, and Admin can create complaints.' });
  }

  const { leadId, categoryId, subCategoryId, priority, description, tatHours, nocAssigneeId, opsAssigneeId, accountsAssigneeId, complaintDate, metadata } = req.body;

  // Validate required fields
  if (!leadId) return res.status(400).json({ message: 'Customer (leadId) is required.' });
  if (!categoryId) return res.status(400).json({ message: 'Category is required.' });
  if (!subCategoryId) return res.status(400).json({ message: 'Sub-category is required.' });
  if (!description?.trim()) return res.status(400).json({ message: 'Description is required.' });

  // Validate lead exists
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, customerUsername: true, campaignData: { select: { company: true, name: true } } }
  });
  if (!lead) return res.status(404).json({ message: 'Customer not found.' });

  // Validate category and sub-category
  const subCategory = await prisma.complaintSubCategory.findUnique({
    where: { id: subCategoryId },
    include: { category: true }
  });
  if (!subCategory || subCategory.categoryId !== categoryId) {
    return res.status(400).json({ message: 'Invalid category or sub-category.' });
  }

  // Check if this is an accounts-type category
  const ACCOUNTS_CATEGORIES = ['Billing & Payments', 'Account & Documentation'];
  const isAccountsCategory = ACCOUNTS_CATEGORIES.includes(subCategory.category.name);

  // Validate required assignee based on category type
  if (isAccountsCategory) {
    if (!accountsAssigneeId) return res.status(400).json({ message: 'Accounts assignee is required for this category.' });
  } else {
    if (!nocAssigneeId) return res.status(400).json({ message: 'NOC assignee is required.' });
  }

  // Build assignee IDs list based on category type
  const assigneeIds = [];
  if (isAccountsCategory) {
    assigneeIds.push(accountsAssigneeId);
  } else {
    assigneeIds.push(nocAssigneeId);
    if (opsAssigneeId) assigneeIds.push(opsAssigneeId);
  }

  // Validate assignees exist and are active
  const assignees = await prisma.user.findMany({
    where: { id: { in: assigneeIds }, isActive: true },
    select: { id: true, name: true, role: true }
  });
  if (assignees.length !== assigneeIds.length) {
    return res.status(400).json({ message: 'One or more assignees not found or inactive.' });
  }

  if (isAccountsCategory) {
    // Validate accounts user has ACCOUNTS_TEAM role
    const accUser = assignees.find(a => a.id === accountsAssigneeId);
    if (!accUser || accUser.role !== 'ACCOUNTS_TEAM') {
      return res.status(400).json({ message: 'Accounts assignee must have Accounts Team role.' });
    }
  } else {
    // Validate NOC user has NOC role
    const nocUser = assignees.find(a => a.id === nocAssigneeId);
    if (!nocUser || nocUser.role !== 'NOC') {
      return res.status(400).json({ message: 'NOC assignee must have NOC role.' });
    }
    // Validate OPS user has OPS_TEAM role (if provided)
    if (opsAssigneeId) {
      const opsUser = assignees.find(a => a.id === opsAssigneeId);
      if (!opsUser || opsUser.role !== 'OPS_TEAM') {
        return res.status(400).json({ message: 'OPS assignee must have OPS Team role.' });
      }
    }
  }

  // Calculate TAT from complaintDate (or now)
  const effectiveTATHours = tatHours ? parseInt(tatHours) : subCategory.defaultTATHours;
  const baseDate = complaintDate ? new Date(complaintDate) : new Date();
  const now = new Date();
  const tatDeadline = new Date(baseDate.getTime() + effectiveTATHours * 60 * 60 * 1000);

  // Generate complaint number
  const complaintNumber = await generateComplaintNumber(now);

  // Create complaint + assignments in transaction
  const complaint = await prisma.$transaction(async (tx) => {
    const created = await tx.complaint.create({
      data: {
        complaintNumber,
        leadId,
        categoryId,
        subCategoryId,
        priority: priority || 'MEDIUM',
        description: description.trim(),
        tatHours: effectiveTATHours,
        tatDeadline,
        complaintDate: baseDate,
        metadata: metadata || null,
        createdById: req.user.id,
        assignments: {
          create: assigneeIds.map(userId => ({
            userId,
            assignedById: req.user.id,
          }))
        }
      },
      select: complaintListSelect,
    });

    return created;
  });

  // Notifications (fire and forget)
  const customerName = lead.campaignData?.company || lead.campaignData?.name || lead.customerUsername;
  notifyComplaintCreated(assigneeIds, {
    complaintId: complaint.id,
    complaintNumber,
    customerName,
    category: subCategory.category.name,
    createdByName: req.user.name,
  });

  // Sidebar refresh for assignees
  assigneeIds.forEach(id => emitSidebarRefresh(id));
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('OPS_TEAM');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.status(201).json({ message: 'Complaint created.', data: complaint });
});

// ==================== LIST / READ ====================

// GET /api/complaints
export const getComplaints = asyncHandler(async function getComplaints(req, res) {
  const { status, priority, categoryId, search, dateFrom, dateTo } = req.query;
  const { page, limit, skip } = parsePagination(req.query, 20);

  // Build where clause
  const where = {};

  // Role-based filtering
  if (!hasAnyRole(req.user, ADMIN_VIEW_ROLES)) {
    // Non-admin: see complaints they created OR are assigned to
    where.OR = [
      { createdById: req.user.id },
      { assignments: { some: { userId: req.user.id, isActive: true } } }
    ];
  }

  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (categoryId) where.categoryId = categoryId;

  if (search) {
    const searchFields = buildSearchFilter(search, [
      'complaintNumber',
      'lead.campaignData.company',
      'lead.campaignData.name',
      'lead.customerUsername',
      'lead.campaignData.phone',
    ]);
    const searchWhere = { OR: searchFields };
    // Merge with existing OR if present
    if (where.OR) {
      where.AND = [{ OR: where.OR }, searchWhere];
      delete where.OR;
    } else {
      Object.assign(where, searchWhere);
    }
  }

  const dateRange = buildDateFilter(dateFrom, dateTo);
  if (dateRange) {
    where.createdAt = dateRange;
  }

  const [complaints, total] = await Promise.all([
    prisma.complaint.findMany({
      where,
      select: complaintListSelect,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.complaint.count({ where }),
  ]);

  // Stats
  const statsWhere = { ...where };
  delete statsWhere.status; // Stats across all statuses for this filter
  const [statusCounts, priorityCounts, tatBreachedCount] = await Promise.all([
    prisma.complaint.groupBy({
      by: ['status'],
      where: statsWhere,
      _count: true,
    }),
    prisma.complaint.groupBy({
      by: ['priority'],
      where: statsWhere,
      _count: true,
    }),
    prisma.complaint.count({
      where: {
        ...statsWhere,
        tatDeadline: { lt: new Date() },
        status: { not: 'CLOSED' },
      }
    }),
  ]);

  const byStatus = {};
  statusCounts.forEach(s => { byStatus[s.status] = s._count; });
  const byPriority = {};
  priorityCounts.forEach(p => { byPriority[p.priority] = p._count; });

  res.json({
    complaints,
    stats: { total, byStatus, byPriority, tatBreached: tatBreachedCount },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET /api/complaints/my-queue
export const getMyQueue = asyncHandler(async function getMyQueue(req, res) {
  const { status } = req.query;
  const { page, limit, skip } = parsePagination(req.query, 20);

  const where = {
    assignments: { some: { userId: req.user.id, isActive: true } },
    status: status ? status : { notIn: ['CLOSED'] },
  };

  const [complaints, total] = await Promise.all([
    prisma.complaint.findMany({
      where,
      select: complaintListSelect,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.complaint.count({ where }),
  ]);

  res.json(paginatedResponse({ data: complaints, total, page, limit, dataKey: 'complaints' }));
});

// GET /api/complaints/sidebar-counts
export const getSidebarCounts = asyncHandler(async function getSidebarCounts(req, res) {
  const userId = req.user.id;

  const [myAssigned, myCreatedOpen] = await Promise.all([
    prisma.complaint.count({
      where: {
        assignments: { some: { userId, isActive: true } },
        status: { not: 'CLOSED' },
      }
    }),
    prisma.complaint.count({
      where: {
        createdById: userId,
        status: { not: 'CLOSED' },
      }
    }),
  ]);

  let counts = { myAssigned, myCreatedOpen };

  // Admin gets extra stats
  if (isAdmin(req.user)) {
    const [totalOpen, tatBreached] = await Promise.all([
      prisma.complaint.count({
        where: { status: { not: 'CLOSED' } }
      }),
      prisma.complaint.count({
        where: {
          tatDeadline: { lt: new Date() },
          status: { not: 'CLOSED' },
        }
      }),
    ]);
    counts = { ...counts, totalOpen, tatBreached };
  }

  res.json(counts);
});

// GET /api/complaints/dashboard/stats
export const getDashboardStats = asyncHandler(async function getDashboardStats(req, res) {
  if (!hasAnyRole(req.user, ADMIN_VIEW_ROLES)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [
    statusCounts,
    priorityCounts,
    tatBreached,
    createdToday,
    resolvedToday,
    categoryCounts,
  ] = await Promise.all([
    prisma.complaint.groupBy({ by: ['status'], _count: true }),
    prisma.complaint.groupBy({
      by: ['priority'],
      where: { status: { not: 'CLOSED' } },
      _count: true,
    }),
    prisma.complaint.count({
      where: { tatDeadline: { lt: now }, status: { not: 'CLOSED' } }
    }),
    prisma.complaint.count({
      where: { createdAt: { gte: todayStart } }
    }),
    prisma.complaint.count({
      where: { closedAt: { gte: todayStart } }
    }),
    prisma.complaint.groupBy({
      by: ['categoryId'],
      where: { status: { not: 'CLOSED' } },
      _count: true,
    }),
  ]);

  const byStatus = {};
  statusCounts.forEach(s => { byStatus[s.status] = s._count; });
  const byPriority = {};
  priorityCounts.forEach(p => { byPriority[p.priority] = p._count; });

  // Fetch category names for the counts
  const categoryIds = categoryCounts.map(c => c.categoryId);
  const categories = await prisma.complaintCategory.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true, name: true },
  });
  const categoryMap = {};
  categories.forEach(c => { categoryMap[c.id] = c.name; });

  const byCategory = categoryCounts.map(c => ({
    categoryId: c.categoryId,
    categoryName: categoryMap[c.categoryId] || 'Unknown',
    count: c._count,
  }));

  res.json({
    message: 'Success',
    data: {
      byStatus,
      byPriority,
      tatBreached,
      createdToday,
      closedToday: resolvedToday,
      byCategory,
    }
  });
});

// GET /api/complaints/customer/:leadId
export const getCustomerComplaints = asyncHandler(async function getCustomerComplaints(req, res) {
  if (!hasAnyRole(req.user, [...CREATOR_ROLES, 'SAM_EXECUTIVE', 'SAM_HEAD', 'ACCOUNTS_TEAM', 'OPS_TEAM'])) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { leadId } = req.params;
  const { page, limit, skip } = parsePagination(req.query, 10);

  const where = { leadId };

  const [complaints, total] = await Promise.all([
    prisma.complaint.findMany({
      where,
      select: complaintListSelect,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.complaint.count({ where }),
  ]);

  res.json(paginatedResponse({ data: complaints, total, page, limit, dataKey: 'complaints' }));
});

// GET /api/complaints/customers
// Returns all active customers with complaint counts
export const getCustomersWithComplaints = asyncHandler(async function getCustomersWithComplaints(req, res) {
  const { search } = req.query;
  const { page, limit, skip } = parsePagination(req.query, 20);

  // Build where clause for active customers
  const leadWhere = {
    OR: [
      { actualPlanIsActive: true },
      { customerUsername: { not: null } },
    ],
  };

  // Add search filter
  if (search && search.length >= 2) {
    leadWhere.AND = [
      {
        OR: buildSearchFilter(search, [
          'customerUsername',
          'circuitId',
          'campaignData.company',
          'campaignData.name',
        ]),
      },
    ];
  }

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where: leadWhere,
      select: {
        id: true,
        customerUsername: true,
        circuitId: true,
        actualPlanName: true,
        actualPlanIsActive: true,
        serviceType: true,
        campaignData: {
          select: {
            company: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        _count: {
          select: { complaints: true },
        },
        complaints: {
          select: { status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.lead.count({ where: leadWhere }),
  ]);

  const customers = leads.map(lead => {
    const openCount = lead.complaints.filter(c => c.status !== 'CLOSED').length;
    const lastComplaint = lead.complaints[0]?.createdAt || null;
    return {
      id: lead.id,
      customerUsername: lead.customerUsername,
      circuitId: lead.circuitId,
      company: lead.campaignData?.company || null,
      name: lead.campaignData?.name || null,
      phone: lead.campaignData?.phone || null,
      email: lead.campaignData?.email || null,
      actualPlanName: lead.actualPlanName,
      actualPlanIsActive: lead.actualPlanIsActive,
      serviceType: lead.serviceType,
      totalComplaints: lead._count.complaints,
      openComplaints: openCount,
      lastComplaintDate: lastComplaint,
    };
  });

  res.json(paginatedResponse({ data: customers, total, page, limit, dataKey: 'customers' }));
});

// GET /api/complaints/:id
export const getComplaintById = asyncHandler(async function getComplaintById(req, res) {
  const { id } = req.params;

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    select: complaintDetailSelect,
  });

  if (!complaint) {
    return res.status(404).json({ message: 'Complaint not found.' });
  }

  // Access check: creator, assignee, or admin
  if (!isAdmin(req.user) && complaint.createdBy.id !== req.user.id && !isAssigned(complaint, req.user.id)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  // Fetch status change history
  const statusHistory = await prisma.statusChangeLog.findMany({
    where: { entityType: 'COMPLAINT', entityId: id },
    orderBy: { changedAt: 'desc' },
    include: { changedBy: { select: { id: true, name: true } } },
  });

  res.json({ message: 'Success', data: { ...complaint, statusHistory } });
});

// ==================== STATUS CHANGES ====================

// PUT /api/complaints/:id/status
export const updateStatus = asyncHandler(async function updateStatus(req, res) {
  const { id } = req.params;
  const { status: newStatus } = req.body;

  if (!newStatus) return res.status(400).json({ message: 'Status is required.' });

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    include: {
      assignments: { where: { isActive: true }, select: { userId: true } },
      lead: { select: { customerUsername: true, campaignData: { select: { company: true, name: true } } } },
    }
  });

  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });

  // Permission: assignee or admin
  const assigneeIds = complaint.assignments.map(a => a.userId);
  if (!isAdmin(req.user) && !assigneeIds.includes(req.user.id)) {
    return res.status(403).json({ message: 'Only assignees or admin can change status.' });
  }

  // Validate transition
  const allowed = VALID_TRANSITIONS[complaint.status];
  if (!allowed || !allowed.includes(newStatus)) {
    return res.status(400).json({ message: `Cannot transition from ${complaint.status} to ${newStatus}.` });
  }

  const updateData = { status: newStatus };

  // Handle specific transitions
  if (newStatus === 'CLOSED') {
    updateData.closedAt = new Date();
  }

  const updated = await prisma.complaint.update({
    where: { id },
    data: updateData,
    select: complaintListSelect,
  });

  // Log status change
  await prisma.statusChangeLog.create({
    data: {
      entityType: 'COMPLAINT',
      entityId: id,
      field: 'status',
      oldValue: complaint.status,
      newValue: newStatus,
      changedById: req.user.id,
    }
  });

  // Notifications
  const customerName = complaint.lead.campaignData?.company || complaint.lead.campaignData?.name || complaint.lead.customerUsername;
  const notifyIds = [...new Set([complaint.createdById, ...assigneeIds])].filter(uid => uid !== req.user.id);
  notifyComplaintStatusChanged(notifyIds, {
    complaintId: id,
    complaintNumber: complaint.complaintNumber,
    customerName,
    oldStatus: complaint.status,
    newStatus,
    changedByName: req.user.name,
  });

  // Sidebar refresh
  notifyIds.forEach(uid => emitSidebarRefresh(uid));
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('OPS_TEAM');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.json({ message: `Status updated to ${newStatus}.`, data: updated });
});

// PUT /api/complaints/:id/close
export const closeComplaint = asyncHandler(async function closeComplaint(req, res) {
  // Only NOC users can close
  if (!hasRole(req.user, 'NOC') && !isAdmin(req.user)) {
    return res.status(403).json({ message: 'Only NOC users can close complaints.' });
  }

  const { id } = req.params;
  const {
    reasonForOutage,
    resolution,
    resolutionType,
    closeRemark,
    serviceImpact,
    ispImpactFrom,
    ispImpactTo,
    customerImpactFrom,
    customerImpactTo,
  } = req.body;

  // Validate required fields
  if (!reasonForOutage?.trim()) return res.status(400).json({ message: 'Reason for outage is required.' });
  if (!resolution?.trim()) return res.status(400).json({ message: 'Resolution is required.' });
  if (!resolutionType?.trim()) return res.status(400).json({ message: 'Resolution type is required.' });

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    include: { assignments: { where: { isActive: true }, select: { userId: true } } }
  });

  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
  if (complaint.status === 'CLOSED') return res.status(400).json({ message: 'Complaint is already closed.' });

  const now = new Date();
  const closeData = {
    status: 'CLOSED',
    closedAt: now,
    closedById: req.user.id,
    reasonForOutage: reasonForOutage.trim(),
    resolution: resolution.trim(),
    resolutionType: resolutionType.trim(),
    closeRemark: closeRemark?.trim() || null,
    serviceImpact: serviceImpact === true || serviceImpact === 'true',
    resolvedAt: now,
  };

  // Service impact times
  if (closeData.serviceImpact) {
    if (ispImpactFrom) closeData.ispImpactFrom = new Date(ispImpactFrom);
    if (ispImpactTo) closeData.ispImpactTo = new Date(ispImpactTo);
    if (customerImpactFrom) closeData.customerImpactFrom = new Date(customerImpactFrom);
    if (customerImpactTo) closeData.customerImpactTo = new Date(customerImpactTo);
  }

  const updated = await prisma.complaint.update({
    where: { id },
    data: closeData,
    select: complaintListSelect,
  });

  // Log status change
  await prisma.statusChangeLog.create({
    data: {
      entityType: 'COMPLAINT',
      entityId: id,
      field: 'status',
      oldValue: complaint.status,
      newValue: 'CLOSED',
      changedById: req.user.id,
      reason: `Closed - ${reasonForOutage.trim()}`,
    }
  });

  // Notify
  const assigneeIds = complaint.assignments.map(a => a.userId);
  [...assigneeIds, complaint.createdById].forEach(uid => emitSidebarRefresh(uid));
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('OPS_TEAM');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  // Notify creator that complaint was closed
  notifyComplaintStatusChanged(
    [...assigneeIds, complaint.createdById].filter(uid => uid !== req.user.id),
    {
      complaintId: id,
      complaintNumber: complaint.complaintNumber,
      customerName: '',
      oldStatus: complaint.status,
      newStatus: 'CLOSED',
      changedByName: req.user.name,
    }
  );

  res.json({ message: 'Complaint closed.', data: updated });
});

// ==================== ASSIGNMENT ====================

// PUT /api/complaints/:id/assign
export const assignComplaint = asyncHandler(async function assignComplaint(req, res) {
  const { id } = req.params;
  const { assigneeIds } = req.body;

  if (!assigneeIds?.length) return res.status(400).json({ message: 'At least one assignee is required.' });
  if (assigneeIds.length > 3) return res.status(400).json({ message: 'Maximum 3 assignees.' });

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    include: { assignments: { where: { isActive: true } } }
  });

  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });

  if (complaint.status === 'CLOSED') {
    return res.status(400).json({ message: 'Cannot reassign a closed complaint.' });
  }

  if (!isAdmin(req.user) && complaint.createdById !== req.user.id) {
    return res.status(403).json({ message: 'Only the creator or admin can reassign.' });
  }

  // Validate new assignees
  const users = await prisma.user.findMany({
    where: { id: { in: assigneeIds }, isActive: true },
    select: { id: true, name: true }
  });
  if (users.length !== assigneeIds.length) {
    return res.status(400).json({ message: 'One or more assignees not found or inactive.' });
  }

  // Deactivate old assignments and create new ones
  await prisma.$transaction(async (tx) => {
    // Deactivate all current assignments
    await tx.complaintAssignment.updateMany({
      where: { complaintId: id, isActive: true },
      data: { isActive: false },
    });

    // Create new assignments (upsert to handle re-assignment)
    for (const userId of assigneeIds) {
      await tx.complaintAssignment.upsert({
        where: { complaintId_userId: { complaintId: id, userId } },
        update: { isActive: true, assignedById: req.user.id, assignedAt: new Date() },
        create: { complaintId: id, userId, assignedById: req.user.id },
      });
    }
  });

  const updated = await prisma.complaint.findUnique({
    where: { id },
    select: complaintListSelect,
  });

  // Notify new assignees
  const currentAssigneeIds = complaint.assignments.map(a => a.userId);
  const newAssignees = assigneeIds.filter(uid => !currentAssigneeIds.includes(uid));
  for (const uid of newAssignees) {
    notifyComplaintAssigned(uid, {
      complaintId: id,
      complaintNumber: complaint.complaintNumber,
      customerName: '',
      assignedByName: req.user.name,
    });
  }

  assigneeIds.forEach(uid => emitSidebarRefresh(uid));
  currentAssigneeIds.forEach(uid => emitSidebarRefresh(uid));
  emitSidebarRefreshByRole('OPS_TEAM');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.json({ message: 'Complaint reassigned.', data: updated });
});

// PUT /api/complaints/:id/update-details
export const updateComplaintDetails = asyncHandler(async function updateComplaintDetails(req, res) {
  // Only NOC users can update
  if (!hasRole(req.user, 'NOC') && !isAdmin(req.user)) {
    return res.status(403).json({ message: 'Only NOC users can update complaints.' });
  }

  const { id } = req.params;
  const { tatHours, categoryId, subCategoryId, nocAssigneeId, opsAssigneeId, accountsAssigneeId } = req.body;

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    select: { id: true, status: true, complaintDate: true, categoryId: true, category: { select: { name: true } }, assignments: { where: { isActive: true }, select: { userId: true } } }
  });
  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
  if (complaint.status === 'CLOSED') return res.status(400).json({ message: 'Cannot update a closed complaint.' });

  const updateData = {};

  // Update TAT
  if (tatHours !== undefined) {
    const hours = parseInt(tatHours);
    if (isNaN(hours) || hours < 1) return res.status(400).json({ message: 'TAT hours must be a positive number.' });
    updateData.tatHours = hours;
    updateData.tatDeadline = new Date(new Date(complaint.complaintDate).getTime() + hours * 60 * 60 * 1000);
  }

  // Determine effective category name (after potential update)
  let effectiveCategoryName = complaint.category.name;

  // Update category/sub-category
  if (categoryId) {
    updateData.categoryId = categoryId;
    const cat = await prisma.complaintCategory.findUnique({ where: { id: categoryId }, select: { name: true } });
    if (cat) effectiveCategoryName = cat.name;
    if (subCategoryId) {
      const subCat = await prisma.complaintSubCategory.findUnique({ where: { id: subCategoryId } });
      if (!subCat || subCat.categoryId !== categoryId) {
        return res.status(400).json({ message: 'Invalid sub-category for selected category.' });
      }
      updateData.subCategoryId = subCategoryId;
    }
  }

  const ACCOUNTS_CATEGORIES = ['Billing & Payments', 'Account & Documentation'];
  const isAccountsCategory = ACCOUNTS_CATEGORIES.includes(effectiveCategoryName);

  // Update in transaction (complaint + reassign)
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.complaint.update({
      where: { id },
      data: updateData,
      select: complaintListSelect,
    });

    // Handle reassignment if provided
    const primaryAssigneeId = isAccountsCategory ? accountsAssigneeId : nocAssigneeId;
    if (primaryAssigneeId) {
      const assigneeIds = [primaryAssigneeId];
      if (!isAccountsCategory && opsAssigneeId) assigneeIds.push(opsAssigneeId);

      // Validate assignees
      const assignees = await tx.user.findMany({
        where: { id: { in: assigneeIds }, isActive: true },
        select: { id: true, role: true }
      });
      if (assignees.length !== assigneeIds.length) {
        throw new Error('One or more assignees not found or inactive.');
      }

      // Deactivate old assignments
      await tx.complaintAssignment.updateMany({
        where: { complaintId: id, isActive: true },
        data: { isActive: false },
      });

      // Create new assignments
      for (const userId of assigneeIds) {
        await tx.complaintAssignment.upsert({
          where: { complaintId_userId: { complaintId: id, userId } },
          update: { isActive: true, assignedById: req.user.id, assignedAt: new Date() },
          create: { complaintId: id, userId, assignedById: req.user.id },
        });
      }
    }

    return result;
  });

  // Notify
  const oldAssigneeIds = complaint.assignments.map(a => a.userId);
  [...new Set([...oldAssigneeIds, nocAssigneeId, opsAssigneeId, accountsAssigneeId].filter(Boolean))].forEach(uid => emitSidebarRefresh(uid));
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('OPS_TEAM');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  // Log the update
  await prisma.statusChangeLog.create({
    data: {
      entityType: 'COMPLAINT',
      entityId: id,
      field: 'details_updated',
      oldValue: null,
      newValue: 'Updated',
      changedById: req.user.id,
      reason: 'Complaint details updated',
    }
  });

  res.json({ message: 'Complaint updated.', data: updated });
});

// ==================== NOTES ====================

// PUT /api/complaints/:id/notes
export const updateNotes = asyncHandler(async function updateNotes(req, res) {
  const { id } = req.params;
  const { notes } = req.body;

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    select: { id: true, status: true, createdById: true, assignments: { where: { isActive: true }, select: { userId: true } } }
  });

  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });

  if (complaint.status === 'CLOSED') {
    return res.status(400).json({ message: 'Cannot update notes on a closed complaint.' });
  }

  const assigneeIds = complaint.assignments.map(a => a.userId);
  if (!isAdmin(req.user) && complaint.createdById !== req.user.id && !assigneeIds.includes(req.user.id)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const updated = await prisma.complaint.update({
    where: { id },
    data: { notes: notes?.trim() || null },
    select: { id: true, notes: true, updatedAt: true },
  });

  res.json({ message: 'Notes updated.', data: updated });
});

// ==================== CUSTOMER SEARCH ====================

// GET /api/complaints/search-customers?q=term
export const searchCustomers = asyncHandler(async function searchCustomers(req, res) {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ customers: [] });
  }

  const leads = await prisma.lead.findMany({
    where: {
      OR: buildSearchFilter(q, [
        'campaignData.company',
        'campaignData.name',
        'campaignData.phone',
        'customerUsername',
        'circuitId',
      ]),
    },
    select: {
      id: true,
      customerUsername: true,
      circuitId: true,
      campaignData: {
        select: {
          company: true,
          name: true,
          phone: true,
          email: true,
        }
      }
    },
    take: 10,
    orderBy: { createdAt: 'desc' },
  });

  // Flatten for frontend convenience
  const customers = leads.map(l => ({
    id: l.id,
    company: l.campaignData?.company || '',
    name: l.campaignData?.name || '',
    phone: l.campaignData?.phone || '',
    email: l.campaignData?.email || '',
    customerUsername: l.customerUsername || '',
    circuitId: l.circuitId || '',
  }));

  res.json({ customers });
});

// GET /api/complaints/assignable-users
export const getAssignableUsers = asyncHandler(async function getAssignableUsers(req, res) {
  const [nocUsers, opsUsers, accountsUsers] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'NOC', isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findMany({
      where: { role: 'OPS_TEAM', isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findMany({
      where: { role: 'ACCOUNTS_TEAM', isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  res.json({ noc: nocUsers, ops: opsUsers, accounts: accountsUsers });
});

// POST /api/complaints/:id/attachments
export const uploadAttachments = asyncHandler(async function uploadAttachments(req, res) {
  if (!hasAnyRole(req.user, CREATOR_ROLES)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const complaint = await prisma.complaint.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, createdById: true, _count: { select: { attachments: true } } }
  });
  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });

  if (complaint.status === 'CLOSED') {
    return res.status(400).json({ message: 'Cannot upload attachments to a closed complaint.' });
  }

  // Check max 5 attachments
  const existingCount = complaint._count.attachments;
  const newFiles = req.files || [];
  if (newFiles.length === 0) return res.status(400).json({ message: 'No files provided.' });
  if (existingCount + newFiles.length > 5) {
    return res.status(400).json({ message: `Maximum 5 attachments allowed. Currently ${existingCount}, trying to add ${newFiles.length}.` });
  }

  // Create attachment records
  const attachments = await prisma.$transaction(
    newFiles.map(file => prisma.complaintAttachment.create({
      data: {
        complaintId: complaint.id,
        fileName: file.originalname,
        fileUrl: file.path,
        fileType: file.mimetype,
        fileSize: file.size,
        uploadedById: req.user.id,
      }
    }))
  );

  res.status(201).json({ message: `${attachments.length} file(s) uploaded.`, data: attachments });
});

// DELETE /api/complaints/:id/attachments/:attachmentId
export const deleteAttachment = asyncHandler(async function deleteAttachment(req, res) {
  const { id, attachmentId } = req.params;

  const attachment = await prisma.complaintAttachment.findUnique({
    where: { id: attachmentId },
    include: { complaint: { select: { id: true, createdById: true } } }
  });
  if (!attachment || attachment.complaint.id !== id) {
    return res.status(404).json({ message: 'Attachment not found.' });
  }

  // Only creator or admin can delete
  if (attachment.complaint.createdById !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  // Delete from Cloudinary
  try {
    const publicId = attachment.fileUrl.split('/upload/')[1]?.replace(/\.[^/.]+$/, '');
    if (publicId) {
      const resourceType = attachment.fileType?.startsWith('image/') ? 'image' : 'raw';
      await deleteFromCloudinary(publicId, resourceType);
    }
  } catch (cloudErr) {
    console.error('Cloudinary delete failed (continuing):', cloudErr.message);
  }

  await prisma.complaintAttachment.delete({ where: { id: attachmentId } });

  res.json({ message: 'Attachment deleted.' });
});
