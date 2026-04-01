import prisma from '../config/db.js';
import { hasRole, hasAnyRole, isAdmin } from '../utils/roleHelper.js';
import { notifyAllAdmins, notifyAllByRole, createNotification } from '../services/notification.service.js';
import { emitSidebarRefreshByRole, emitSidebarRefresh } from '../sockets/index.js';
import { asyncHandler, parsePagination, paginatedResponse, buildSearchFilter } from '../utils/controllerHelper.js';

// Get all vendors
export const getVendors = asyncHandler(async function getVendors(req, res) {
  const { search, isActive, approvalStatus, category } = req.query;

  const where = {};

  if (isActive !== undefined) {
    where.isActive = isActive === 'true';
  }

  if (approvalStatus) {
    if (approvalStatus.includes(',')) {
      where.approvalStatus = { in: approvalStatus.split(',') };
    } else {
      where.approvalStatus = approvalStatus;
    }
  }

  if (category) {
    where.category = category;
  }

  if (search) {
    where.OR = buildSearchFilter(search, ['companyName', 'contactPerson', 'email', 'phone', 'gstNumber']);
  }

  const vendors = await prisma.vendor.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      },
      leads: {
        where: { docsVerifiedAt: { not: null } },
        select: {
          id: true,
          campaignData: { select: { company: true } }
        },
        take: 5
      }
    }
  });

  res.json(vendors);
});

// Get single vendor by ID
export const getVendorById = asyncHandler(async function getVendorById(req, res) {
  const { id } = req.params;

  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      },
      adminApprovedBy: {
        select: { id: true, name: true, email: true }
      },
      accountsApprovedBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  if (!vendor) {
    return res.status(404).json({ message: 'Vendor not found' });
  }

  res.json(vendor);
});

// Create new vendor
export const createVendor = asyncHandler(async function createVendor(req, res) {
  if (!hasAnyRole(req.user, ['SUPER_ADMIN', 'ACCOUNTS_TEAM', 'FEASIBILITY_TEAM'])) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const {
    companyName,
    individualName,
    vendorEntityType,
    gstNumber,
    contactPerson,
    email,
    phone,
    panNumber,
    address,
    city,
    state,
    category,
    accountNumber,
    ifscCode,
    accountName,
    bankName,
    branchName,
    commissionPercentage
  } = req.body;

  // Determine vendor type
  const isIndividual = vendorEntityType === 'INDIVIDUAL';
  const resolvedCompanyName = isIndividual ? (individualName?.trim() || '') : (companyName?.trim() || '');

  // Extract file URLs from multer/cloudinary
  const panDocumentUrl = req.files?.panDocument?.[0]?.path || null;
  const gstDocumentUrl = req.files?.gstDocument?.[0]?.path || null;
  const cancelledChequeUrl = req.files?.cancelledCheque?.[0]?.path || null;

  // Validate name
  if (!resolvedCompanyName) {
    return res.status(400).json({ message: isIndividual ? 'Individual name is required' : 'Company name is required' });
  }

  // Validate required fields (only basic info + category)
  const requiredFields = { contactPerson, email, phone, address, category };
  for (const [field, value] of Object.entries(requiredFields)) {
    if (!value?.toString().trim()) {
      return res.status(400).json({ message: `${field} is required` });
    }
  }

  // Validate category enum
  const validCategories = ['FIBER', 'COMMISSION', 'CHANNEL_PARTNER', 'THIRD_PARTY'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ message: 'Invalid vendor category' });
  }

  // Check for duplicate company name
  const existingVendor = await prisma.vendor.findFirst({
    where: {
      companyName: {
        equals: resolvedCompanyName,
        mode: 'insensitive'
      }
    }
  });

  if (existingVendor) {
    return res.status(400).json({ message: 'A vendor with this name already exists' });
  }

  const vendor = await prisma.vendor.create({
    data: {
      companyName: resolvedCompanyName,
      vendorType: isIndividual ? 'INDIVIDUAL' : 'COMPANY',
      individualName: isIndividual ? individualName.trim() : null,
      gstNumber: gstNumber?.trim() || null,
      gstDocument: gstDocumentUrl,
      contactPerson: contactPerson.trim(),
      email: email.trim(),
      phone: phone.trim(),
      panNumber: panNumber?.trim() || null,
      panDocument: panDocumentUrl,
      address: address.trim(),
      city: city?.trim() || null,
      state: state?.trim() || null,
      category,
      ...(category === 'CHANNEL_PARTNER' && commissionPercentage != null ? { commissionPercentage: parseFloat(commissionPercentage) } : {}),
      accountNumber: accountNumber?.trim() || null,
      ifscCode: ifscCode?.trim() || null,
      accountName: accountName?.trim() || null,
      bankName: bankName?.trim() || null,
      branchName: branchName?.trim() || null,
      cancelledCheque: cancelledChequeUrl,
      docsStatus: (panDocumentUrl && gstDocumentUrl && cancelledChequeUrl) ? 'UPLOADED' : 'PENDING',
      approvalStatus: 'PENDING_ADMIN',
      createdById: req.user.id
    },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  // Notify admins
  await notifyAllAdmins(
    'VENDOR_PENDING',
    'New Vendor Pending Approval',
    `"${vendor.companyName}" submitted by ${req.user.name} needs approval`,
    { vendorId: vendor.id, companyName: vendor.companyName }
  );
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({
    success: true,
    message: 'Vendor submitted for approval',
    vendor
  });
});

// Update vendor
export const updateVendor = asyncHandler(async function updateVendor(req, res) {
  const { id } = req.params;
  const {
    companyName,
    gstNumber,
    gstDocument,
    contactPerson,
    email,
    phone,
    panNumber,
    panDocument,
    address,
    city,
    state,
    category,
    isActive
  } = req.body;

  const existingVendor = await prisma.vendor.findUnique({
    where: { id }
  });

  if (!existingVendor) {
    return res.status(404).json({ message: 'Vendor not found' });
  }

  if (companyName && companyName.trim() !== existingVendor.companyName) {
    const duplicateVendor = await prisma.vendor.findFirst({
      where: {
        companyName: {
          equals: companyName.trim(),
          mode: 'insensitive'
        },
        id: { not: id }
      }
    });

    if (duplicateVendor) {
      return res.status(400).json({ message: 'A vendor with this company name already exists' });
    }
  }

  const updateData = {};
  if (companyName !== undefined) updateData.companyName = companyName.trim();
  if (gstNumber !== undefined) updateData.gstNumber = gstNumber?.trim() || null;
  if (gstDocument !== undefined) updateData.gstDocument = gstDocument || null;
  if (contactPerson !== undefined) updateData.contactPerson = contactPerson?.trim() || null;
  if (email !== undefined) updateData.email = email?.trim() || null;
  if (phone !== undefined) updateData.phone = phone?.trim() || null;
  if (panNumber !== undefined) updateData.panNumber = panNumber?.trim() || null;
  if (panDocument !== undefined) updateData.panDocument = panDocument || null;
  if (address !== undefined) updateData.address = address?.trim() || null;
  if (city !== undefined) updateData.city = city?.trim() || null;
  if (state !== undefined) updateData.state = state?.trim() || null;
  if (category !== undefined) updateData.category = category || null;
  if (isActive !== undefined) updateData.isActive = isActive;

  const vendor = await prisma.vendor.update({
    where: { id },
    data: updateData,
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  res.json({
    success: true,
    message: 'Vendor updated successfully',
    vendor
  });
});

// Delete vendor (permanently)
export const deleteVendor = asyncHandler(async function deleteVendor(req, res) {
  const { id } = req.params;

  const vendor = await prisma.vendor.findUnique({
    where: { id }
  });

  if (!vendor) {
    return res.status(404).json({ message: 'Vendor not found' });
  }

  await prisma.vendor.delete({
    where: { id }
  });

  res.json({
    success: true,
    message: 'Vendor deleted successfully'
  });
});

// Get vendor stats
export const getVendorStats = asyncHandler(async function getVendorStats(req, res) {
  const [total, active, inactive, pendingAdmin, pendingAccounts, approved, rejected] = await Promise.all([
    prisma.vendor.count(),
    prisma.vendor.count({ where: { isActive: true } }),
    prisma.vendor.count({ where: { isActive: false } }),
    prisma.vendor.count({ where: { approvalStatus: 'PENDING_ADMIN' } }),
    prisma.vendor.count({ where: { approvalStatus: 'PENDING_ACCOUNTS' } }),
    prisma.vendor.count({ where: { approvalStatus: 'APPROVED' } }),
    prisma.vendor.count({ where: { approvalStatus: 'REJECTED' } })
  ]);

  res.json({
    total,
    active,
    inactive,
    pendingAdmin,
    pendingAccounts,
    approved,
    rejected
  });
});

// Get pending vendors for approval queue
export const getPendingVendors = asyncHandler(async function getPendingVendors(req, res) {
  const userRole = req.user.role;
  let where = {};

  if (userRole === 'SUPER_ADMIN' || userRole === 'MASTER') {
    where.approvalStatus = 'PENDING_ADMIN';
  } else if (userRole === 'ACCOUNTS_TEAM') {
    where.approvalStatus = 'PENDING_ACCOUNTS';
  } else {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const vendors = await prisma.vendor.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  res.json(vendors);
});

// Approve vendor (2-stage: Admin → Accounts)
export const approveVendor = asyncHandler(async function approveVendor(req, res) {
  const { id } = req.params;
  const userRole = req.user.role;

  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } }
  });

  if (!vendor) {
    return res.status(404).json({ message: 'Vendor not found' });
  }

  // Stage 1: SUPER_ADMIN approves PENDING_ADMIN → PENDING_ACCOUNTS
  if ((userRole === 'SUPER_ADMIN' || userRole === 'MASTER') && vendor.approvalStatus === 'PENDING_ADMIN') {
    const updated = await prisma.vendor.update({
      where: { id },
      data: {
        approvalStatus: 'PENDING_ACCOUNTS',
        adminApprovedById: req.user.id,
        adminApprovedAt: new Date()
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } }
      }
    });

    // Notify vendor creator that admin approved, pending accounts verification
    if (vendor.createdBy?.id) {
      await createNotification(
        vendor.createdBy.id,
        'VENDOR_APPROVED',
        'Vendor Admin Approved',
        `"${vendor.companyName}" has been approved by admin. You can now select it for feasibility. Documents will be verified by accounts later.`,
        { vendorId: vendor.id, companyName: vendor.companyName }
      );
      emitSidebarRefresh(vendor.createdBy.id);
    }
    emitSidebarRefreshByRole('SUPER_ADMIN');
    emitSidebarRefreshByRole('ACCOUNTS_TEAM');

    return res.json({
      success: true,
      message: 'Vendor approved by admin. Pending accounts verification.',
      vendor: updated
    });
  }

  // Accounts team must use verify-docs endpoint (enforces docs uploaded check)
  return res.status(403).json({ message: 'You cannot approve this vendor at its current stage. Accounts team should verify vendor documents instead.' });
});

// Reject vendor
export const rejectVendor = asyncHandler(async function rejectVendor(req, res) {
  const { id } = req.params;
  const { reason } = req.body;
  const userRole = req.user.role;

  if (!reason?.trim()) {
    return res.status(400).json({ message: 'Rejection reason is required' });
  }

  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } }
  });

  if (!vendor) {
    return res.status(404).json({ message: 'Vendor not found' });
  }

  let updateData = {
    approvalStatus: 'REJECTED',
    rejectedAt: new Date()
  };

  if ((userRole === 'SUPER_ADMIN' || userRole === 'MASTER') && vendor.approvalStatus === 'PENDING_ADMIN') {
    updateData.adminRejectionReason = reason.trim();
    updateData.adminApprovedById = req.user.id;
  } else if (userRole === 'ACCOUNTS_TEAM' && vendor.approvalStatus === 'PENDING_ACCOUNTS') {
    updateData.accountsRejectionReason = reason.trim();
    updateData.accountsApprovedById = req.user.id;
  } else {
    return res.status(403).json({ message: 'You cannot reject this vendor at its current stage.' });
  }

  const updated = await prisma.vendor.update({
    where: { id },
    data: updateData,
    include: {
      createdBy: { select: { id: true, name: true, email: true } }
    }
  });

  // Notify vendor creator
  if (vendor.createdBy?.id) {
    await createNotification(
      vendor.createdBy.id,
      'VENDOR_REJECTED',
      'Vendor Rejected',
      `"${vendor.companyName}" was rejected: ${reason.trim()}`,
      { vendorId: vendor.id, companyName: vendor.companyName, reason: reason.trim() }
    );
    emitSidebarRefresh(vendor.createdBy.id);
  }
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  return res.json({
    success: true,
    message: 'Vendor rejected.',
    vendor: updated
  });
});

// Create vendor from feasibility (simplified - docs optional)
export const createVendorFromFeasibility = asyncHandler(async function createVendorFromFeasibility(req, res) {
  if (!hasAnyRole(req.user, ['SUPER_ADMIN', 'FEASIBILITY_TEAM'])) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const {
    vendorType, companyName, individualName, category,
    contactPerson, email, phone, gstNumber, panNumber,
    address, city, state,
    estimatedCapex, estimatedOpex, createdForLeadId,
    accountNumber, ifscCode, accountName, bankName, branchName
  } = req.body;

  // Validate vendor type
  if (!vendorType || !['COMPANY', 'INDIVIDUAL'].includes(vendorType)) {
    return res.status(400).json({ message: 'Vendor type (COMPANY or INDIVIDUAL) is required.' });
  }

  // Validate name based on type
  if (vendorType === 'COMPANY' && !companyName?.trim()) {
    return res.status(400).json({ message: 'Company name is required for company vendors.' });
  }
  if (vendorType === 'INDIVIDUAL' && !individualName?.trim()) {
    return res.status(400).json({ message: 'Name is required for individual vendors.' });
  }

  // Validate category
  const validCategories = ['FIBER', 'COMMISSION', 'CHANNEL_PARTNER', 'THIRD_PARTY'];
  if (!category || !validCategories.includes(category)) {
    return res.status(400).json({ message: 'Valid vendor category is required.' });
  }

  // For individual vendors, use individualName as companyName for backward compat
  const resolvedCompanyName = vendorType === 'INDIVIDUAL'
    ? individualName.trim()
    : companyName.trim();

  // Check duplicate
  const existing = await prisma.vendor.findFirst({
    where: { companyName: { equals: resolvedCompanyName, mode: 'insensitive' } }
  });
  if (existing) {
    return res.status(400).json({ message: 'A vendor with this name already exists.' });
  }

  // Extract optional file URLs
  const panDocumentUrl = req.files?.panDocument?.[0]?.path || null;
  const gstDocumentUrl = req.files?.gstDocument?.[0]?.path || null;
  const cancelledChequeUrl = req.files?.cancelledCheque?.[0]?.path || null;

  // Determine docs status
  const hasAllDocs = panDocumentUrl && gstDocumentUrl && cancelledChequeUrl;
  const docsStatus = hasAllDocs ? 'UPLOADED' : 'PENDING';

  const vendor = await prisma.vendor.create({
    data: {
      companyName: resolvedCompanyName,
      vendorType,
      individualName: vendorType === 'INDIVIDUAL' ? individualName.trim() : null,
      category,
      contactPerson: contactPerson?.trim() || null,
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      gstNumber: gstNumber?.trim() || null,
      gstDocument: gstDocumentUrl,
      panNumber: panNumber?.trim() || null,
      panDocument: panDocumentUrl,
      cancelledCheque: cancelledChequeUrl,
      address: address?.trim() || null,
      city: city?.trim() || null,
      state: state?.trim() || null,
      accountNumber: accountNumber?.trim() || null,
      ifscCode: ifscCode?.trim() || null,
      accountName: accountName?.trim() || null,
      bankName: bankName?.trim() || null,
      branchName: branchName?.trim() || null,
      estimatedCapex: estimatedCapex ? parseFloat(estimatedCapex) : null,
      estimatedOpex: estimatedOpex ? parseFloat(estimatedOpex) : null,
      createdForLeadId: createdForLeadId || null,
      docsStatus,
      approvalStatus: 'PENDING_ADMIN',
      createdById: req.user.id
    },
    include: {
      createdBy: { select: { id: true, name: true, email: true } }
    }
  });

  // Notify admins
  await notifyAllAdmins(
    'VENDOR_APPROVED',
    'New Vendor Pending Approval',
    `"${vendor.companyName}" (${vendorType}) submitted by ${req.user.name} needs approval`,
    { vendorId: vendor.id, companyName: vendor.companyName }
  );
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({
    success: true,
    message: 'Vendor submitted for admin approval.',
    vendor
  });
});

// Upload vendor documents (after initial creation)
export const uploadVendorDocs = asyncHandler(async function uploadVendorDocs(req, res) {
  if (!hasAnyRole(req.user, ['SUPER_ADMIN', 'FEASIBILITY_TEAM'])) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const vendor = await prisma.vendor.findUnique({ where: { id } });

  if (!vendor) {
    return res.status(404).json({ message: 'Vendor not found.' });
  }

  const panDocumentUrl = req.files?.panDocument?.[0]?.path || null;
  const gstDocumentUrl = req.files?.gstDocument?.[0]?.path || null;
  const cancelledChequeUrl = req.files?.cancelledCheque?.[0]?.path || null;

  const { panNumber, gstNumber, accountNumber, ifscCode, accountName, bankName, branchName } = req.body;

  const updateData = { docsStatus: 'UPLOADED' };

  if (panDocumentUrl) updateData.panDocument = panDocumentUrl;
  if (gstDocumentUrl) updateData.gstDocument = gstDocumentUrl;
  if (cancelledChequeUrl) updateData.cancelledCheque = cancelledChequeUrl;
  if (panNumber?.trim()) updateData.panNumber = panNumber.trim();
  if (gstNumber?.trim()) updateData.gstNumber = gstNumber.trim();
  if (accountNumber?.trim()) updateData.accountNumber = accountNumber.trim();
  if (ifscCode?.trim()) updateData.ifscCode = ifscCode.trim();
  if (accountName?.trim()) updateData.accountName = accountName.trim();
  if (bankName?.trim()) updateData.bankName = bankName.trim();
  if (branchName?.trim()) updateData.branchName = branchName.trim();

  const updated = await prisma.vendor.update({
    where: { id },
    data: updateData,
    include: { createdBy: { select: { id: true, name: true, email: true } } }
  });

  // Notify accounts team
  await notifyAllByRole(
    'ACCOUNTS_TEAM',
    'VENDOR_DOCS_REMINDER',
    'Vendor Documents Uploaded',
    `Documents uploaded for vendor "${updated.companyName}" - ready for verification`,
    { vendorId: updated.id, companyName: updated.companyName }
  );
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.json({
    success: true,
    message: 'Vendor documents uploaded successfully.',
    vendor: updated
  });
});

// Verify vendor documents (accounts team)
export const verifyVendorDocs = asyncHandler(async function verifyVendorDocs(req, res) {
  if (!hasAnyRole(req.user, ['SUPER_ADMIN', 'ACCOUNTS_TEAM'])) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const { decision, reason } = req.body;

  if (!decision || !['VERIFIED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ message: 'Valid decision (VERIFIED or REJECTED) is required.' });
  }

  if (decision === 'REJECTED' && !reason?.trim()) {
    return res.status(400).json({ message: 'Reason is required when rejecting.' });
  }

  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } }
  });

  if (!vendor) {
    return res.status(404).json({ message: 'Vendor not found.' });
  }

  if (vendor.docsStatus !== 'UPLOADED') {
    return res.status(400).json({ message: 'Vendor documents are not in uploadable state for verification.' });
  }

  const updateData = { docsStatus: decision };
  // When docs verified, also set vendor as fully APPROVED
  if (decision === 'VERIFIED') {
    updateData.approvalStatus = 'APPROVED';
    updateData.accountsApprovedById = req.user.id;
    updateData.accountsApprovedAt = new Date();
  }
  const updated = await prisma.vendor.update({
    where: { id },
    data: updateData,
    include: { createdBy: { select: { id: true, name: true, email: true } } }
  });

  // Update linked leads
  if (decision === 'VERIFIED') {
    await prisma.lead.updateMany({
      where: { vendorId: id, vendorDocsVerifiedAt: null },
      data: {
        vendorDocsVerifiedAt: new Date(),
        vendorDocsVerifiedById: req.user.id,
        vendorDocsRejectedReason: null
      }
    });

    // Notify vendor creator that vendor is fully approved
    if (vendor.createdBy?.id) {
      await createNotification(
        vendor.createdBy.id,
        'VENDOR_APPROVED',
        'Vendor Fully Approved',
        `"${vendor.companyName}" documents verified and vendor is now fully approved.`,
        { vendorId: vendor.id, companyName: vendor.companyName }
      );
      emitSidebarRefresh(vendor.createdBy.id);
    }
  }

  // Notify vendor creator if rejected
  if (decision === 'REJECTED' && vendor.createdBy?.id) {
    await createNotification(
      vendor.createdBy.id,
      'VENDOR_REJECTED',
      'Vendor Documents Rejected',
      `Documents for "${vendor.companyName}" were rejected: ${reason.trim()}`,
      { vendorId: vendor.id, companyName: vendor.companyName, reason: reason.trim() }
    );
    emitSidebarRefresh(vendor.createdBy.id);
  }

  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    success: true,
    message: decision === 'VERIFIED' ? 'Vendor documents verified.' : 'Vendor documents rejected.',
    vendor: updated
  });
});

// Get vendor approval queue (admin)
export const getVendorApprovalQueue = asyncHandler(async function getVendorApprovalQueue(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { page, limit, skip } = parsePagination(req.query, 20);
  const statusFilter = req.query.status || 'pending';

  const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

  // Build where clause based on filter
  let where;
  if (statusFilter === 'approved') {
    where = {
      approvalStatus: { in: ['PENDING_ACCOUNTS', 'APPROVED'] },
      adminApprovedAt: { gte: todayStart }
    };
  } else if (statusFilter === 'rejected') {
    where = {
      approvalStatus: 'REJECTED',
      rejectedAt: { gte: todayStart }
    };
  } else {
    where = { approvalStatus: 'PENDING_ADMIN' };
  }

  const [vendors, total, pendingCount, approvedToday, rejectedToday] = await Promise.all([
    prisma.vendor.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        createdForLead: {
          select: {
            id: true,
            campaignData: { select: { company: true, name: true } }
          }
        },
        adminApprovedBy: { select: { name: true } }
      }
    }),
    prisma.vendor.count({ where }),
    prisma.vendor.count({ where: { approvalStatus: 'PENDING_ADMIN' } }),
    prisma.vendor.count({
      where: {
        approvalStatus: { in: ['PENDING_ACCOUNTS', 'APPROVED'] },
        adminApprovedAt: { gte: todayStart }
      }
    }),
    prisma.vendor.count({
      where: {
        approvalStatus: 'REJECTED',
        rejectedAt: { gte: todayStart }
      }
    })
  ]);

  res.json(paginatedResponse({
    data: vendors,
    total,
    page,
    limit,
    dataKey: 'vendors',
    extra: { stats: { pending: pendingCount, approvedToday, rejectedToday } }
  }));
});

export default {
  getVendors,
  getVendorById,
  createVendor,
  updateVendor,
  deleteVendor,
  getVendorStats,
  getPendingVendors,
  approveVendor,
  rejectVendor,
  createVendorFromFeasibility,
  uploadVendorDocs,
  verifyVendorDocs,
  getVendorApprovalQueue,
  getChannelPartners
};

// Get approved Channel Partner vendors
export const getChannelPartners = asyncHandler(async function getChannelPartners(req, res) {
  const vendors = await prisma.vendor.findMany({
    where: {
      category: 'CHANNEL_PARTNER',
      approvalStatus: 'APPROVED'
    },
    select: {
      id: true,
      companyName: true,
      contactPerson: true,
      email: true,
      phone: true,
      commissionPercentage: true,
      approvalStatus: true
    },
    orderBy: { companyName: 'asc' }
  });

  res.json(vendors);
});
