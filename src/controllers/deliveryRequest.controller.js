import prisma from '../config/db.js';
import { isAdminOrTestUser, hasRole, hasAnyRole } from '../utils/roleHelper.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole, emitToUser } from '../sockets/index.js';
import { createNotification } from '../services/notification.service.js';
import { asyncHandler, parsePagination, paginatedResponse } from '../utils/controllerHelper.js';

// Generate unique request number
const generateRequestNumber = async () => {
  const lastRequest = await prisma.deliveryRequest.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { requestNumber: true }
  });

  if (!lastRequest) {
    return 'DR-0001';
  }

  const lastNumber = parseInt(lastRequest.requestNumber.split('-')[1]);
  const newNumber = lastNumber + 1;
  return `DR-${newNumber.toString().padStart(4, '0')}`;
};

// Create audit log entry
const createLog = async (deliveryRequestId, action, performedById, details = null) => {
  await prisma.deliveryRequestLog.create({
    data: {
      deliveryRequestId,
      action,
      performedById,
      details
    }
  });
};

// ========== DELIVERY TEAM APIs ==========

// Create new delivery request
export const createDeliveryRequest = asyncHandler(async function createDeliveryRequest(req, res) {
  const userId = req.user.id;
  const {
    leadId,
    items, // Array of { productId, quantity }
    latitude,
    longitude,
    deliveryAddress,
    notes
  } = req.body;

  // Validate lead exists and is pushed to installation
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      campaignData: true
    }
  });

  if (!lead) {
    return res.status(404).json({ message: 'Lead not found' });
  }

  if (!lead.pushedToInstallationAt) {
    return res.status(400).json({ message: 'Lead must be pushed to installation first' });
  }

  // Check if there's already an active (non-terminal) request for this lead.
  // REJECTED and COMPLETED are terminal statuses and should not block retries.
  const existingRequest = await prisma.deliveryRequest.findFirst({
    where: {
      leadId,
      status: {
        in: ['PENDING_APPROVAL', 'SUPER_ADMIN_APPROVED', 'AREA_HEAD_APPROVED', 'APPROVED', 'ASSIGNED', 'DISPATCHED']
      }
    }
  });

  if (existingRequest) {
    return res.status(400).json({
      message: 'A delivery request already exists for this lead',
      requestNumber: existingRequest.requestNumber
    });
  }

  // Validate items
  if (!items || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required' });
  }

  // Validate all products exist
  const productIds = items.map(i => i.productId);
  const products = await prisma.storeProduct.findMany({
    where: { id: { in: productIds }, isActive: true }
  });

  if (products.length !== productIds.length) {
    return res.status(400).json({ message: 'Some products are invalid or inactive' });
  }

  // Generate request number
  const requestNumber = await generateRequestNumber();

  // Create delivery request with items
  const deliveryRequest = await prisma.deliveryRequest.create({
    data: {
      requestNumber,
      leadId,
      requestedById: userId,
      latitude: latitude || lead.latitude,
      longitude: longitude || lead.longitude,
      deliveryAddress: deliveryAddress || lead.fullAddress,
      notes,
      urgency: 'NORMAL',
      status: 'PENDING_APPROVAL',
      items: {
        create: items.map(item => ({
          productId: item.productId,
          quantity: item.quantity
        }))
      }
    },
    include: {
      items: {
        include: {
          product: true
        }
      },
      lead: {
        include: {
          campaignData: true
        }
      },
      requestedBy: {
        select: { id: true, name: true, email: true, role: true }
      }
    }
  });

  // Update lead's delivery status to MATERIAL_REQUESTED
  await prisma.lead.update({
    where: { id: leadId },
    data: { deliveryStatus: 'MATERIAL_REQUESTED' }
  });

  // Create audit log
  await createLog(deliveryRequest.id, 'CREATED', userId, {
    itemCount: items.length,
    leadId,
    company: lead.campaignData?.company
  });

  // Notify Area Head and Super Admin of new delivery request
  emitSidebarRefreshByRole('AREA_HEAD');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({
    success: true,
    message: 'Delivery request created successfully',
    request: deliveryRequest
  });
});

// Get delivery requests for current user (Delivery Team)
export const getMyDeliveryRequests = asyncHandler(async function getMyDeliveryRequests(req, res) {
  const userId = req.user.id;
  const { status } = req.query;

  const whereClause = {
    requestedById: userId
  };

  if (status && status !== 'all') {
    whereClause.status = status;
  }

  const requests = await prisma.deliveryRequest.findMany({
    where: whereClause,
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        include: {
          product: true
        }
      },
      lead: {
        include: {
          campaignData: true
        }
      },
      requestedBy: {
        select: { id: true, name: true, email: true, role: true }
      },
      superAdminApprovedBy: {
        select: { id: true, name: true }
      },
      areaHeadApprovedBy: {
        select: { id: true, name: true }
      }
    }
  });

  res.json({ success: true, requests });
});

// Get single delivery request details
export const getDeliveryRequestDetails = asyncHandler(async function getDeliveryRequestDetails(req, res) {
  const { id } = req.params;

  const request = await prisma.deliveryRequest.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: true,
          assignedFromPOItem: {
            include: {
              purchaseOrder: true
            }
          }
        }
      },
      lead: {
        include: {
          campaignData: true,
          products: {
            include: {
              product: true
            }
          }
        }
      },
      requestedBy: {
        select: { id: true, name: true, email: true, role: true, phone: true }
      },
      superAdminApprovedBy: {
        select: { id: true, name: true }
      },
      superAdminRejectedBy: {
        select: { id: true, name: true }
      },
      areaHeadApprovedBy: {
        select: { id: true, name: true }
      },
      areaHeadRejectedBy: {
        select: { id: true, name: true }
      },
      assignedToStoreManager: {
        select: { id: true, name: true }
      },
      logs: {
        orderBy: { createdAt: 'desc' },
        include: {
          performedBy: {
            select: { id: true, name: true, role: true }
          }
        }
      }
    }
  });

  if (!request) {
    return res.status(404).json({ message: 'Delivery request not found' });
  }

  res.json({ success: true, request });
});

// ========== APPROVAL APIs (Super Admin & Area Head) ==========

// Get pending approval requests
export const getPendingApprovalRequests = asyncHandler(async function getPendingApprovalRequests(req, res) {
  const userId = req.user.id;
  const userRole = req.user.role;
  const isTestUser = isAdminOrTestUser(req.user);

  // Determine which requests to show based on role
  let whereClause = {};

  if (isTestUser || userRole === 'SUPER_ADMIN' || userRole === 'MASTER') {
    // Super Admin/Test User sees all requests that need approval
    whereClause = {
      status: {
        in: ['PENDING_APPROVAL', 'AREA_HEAD_APPROVED']
      },
      superAdminApprovedById: null,
      superAdminRejectedById: null
    };
  } else if (userRole === 'AREA_HEAD') {
    // Area Head sees requests that need their approval
    whereClause = {
      status: {
        in: ['PENDING_APPROVAL', 'SUPER_ADMIN_APPROVED']
      },
      areaHeadApprovedById: null,
      areaHeadRejectedById: null
    };
  } else {
    return res.status(403).json({ message: 'Not authorized to view approval requests' });
  }

  const requests = await prisma.deliveryRequest.findMany({
    where: whereClause,
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        include: {
          product: true
        }
      },
      lead: {
        include: {
          campaignData: true
        }
      },
      requestedBy: {
        select: { id: true, name: true, email: true, role: true }
      },
      superAdminApprovedBy: {
        select: { id: true, name: true }
      },
      areaHeadApprovedBy: {
        select: { id: true, name: true }
      }
    }
  });

  // Get stats
  const stats = await getApprovalStats(userRole);

  res.json({ success: true, requests, stats });
});

// Get approval stats
const getApprovalStats = async (userRole) => {
  const isSuperOrMaster = userRole === 'SUPER_ADMIN' || userRole === 'MASTER';
  const baseWhere = isSuperOrMaster
    ? { superAdminApprovedById: null, superAdminRejectedById: null }
    : { areaHeadApprovedById: null, areaHeadRejectedById: null };

  const [pending, approved, rejected, total] = await Promise.all([
    prisma.deliveryRequest.count({
      where: {
        ...baseWhere,
        status: { in: ['PENDING_APPROVAL', isSuperOrMaster ? 'AREA_HEAD_APPROVED' : 'SUPER_ADMIN_APPROVED'] }
      }
    }),
    prisma.deliveryRequest.count({
      where: {
        status: { in: ['APPROVED', 'ASSIGNED', 'DISPATCHED', 'COMPLETED'] }
      }
    }),
    prisma.deliveryRequest.count({
      where: { status: 'REJECTED' }
    }),
    prisma.deliveryRequest.count()
  ]);

  return { pending, approved, rejected, total };
};

// Approve delivery request
export const approveDeliveryRequest = asyncHandler(async function approveDeliveryRequest(req, res) {
  const userId = req.user.id;
  const userRole = req.user.role;
  const isTestUser = isAdminOrTestUser(req.user);
  const { id } = req.params;

  // Wrap read-decide-write in serialized transaction to prevent TOCTOU race
  const { updatedRequest, newStatus, action, previousStatus } = await prisma.$transaction(async (tx) => {
    const request = await tx.deliveryRequest.findUnique({
      where: { id }
    });

    if (!request) {
      throw Object.assign(new Error('Delivery request not found'), { statusCode: 404 });
    }

    if (request.status === 'REJECTED') {
      throw Object.assign(new Error('Request has already been rejected'), { statusCode: 400 });
    }

    if (request.status === 'APPROVED') {
      throw Object.assign(new Error('Request has already been approved'), { statusCode: 400 });
    }

    let updateData = {};
    let txNewStatus = request.status;
    let txAction = '';

    if (isTestUser || userRole === 'SUPER_ADMIN' || userRole === 'MASTER') {
      if (request.superAdminApprovedById) {
        throw Object.assign(new Error('You have already approved this request'), { statusCode: 400 });
      }

      updateData = {
        superAdminApprovedById: userId,
        superAdminApprovedAt: new Date()
      };

      if (request.areaHeadApprovedById) {
        txNewStatus = 'APPROVED';
      } else {
        txNewStatus = 'SUPER_ADMIN_APPROVED';
      }
      txAction = 'SUPER_ADMIN_APPROVED';
    } else if (userRole === 'AREA_HEAD') {
      if (request.areaHeadApprovedById) {
        throw Object.assign(new Error('You have already approved this request'), { statusCode: 400 });
      }

      updateData = {
        areaHeadApprovedById: userId,
        areaHeadApprovedAt: new Date()
      };

      if (request.superAdminApprovedById) {
        txNewStatus = 'APPROVED';
      } else {
        txNewStatus = 'AREA_HEAD_APPROVED';
      }
      txAction = 'AREA_HEAD_APPROVED';
    } else {
      throw Object.assign(new Error('Not authorized to approve requests'), { statusCode: 403 });
    }

    const result = await tx.deliveryRequest.update({
      where: { id },
      data: {
        ...updateData,
        status: txNewStatus
      },
      include: {
        items: {
          include: {
            product: true
          }
        },
        lead: {
          include: {
            campaignData: true
          }
        },
        requestedBy: {
          select: { id: true, name: true, email: true, role: true }
        }
      }
    });

    return { updatedRequest: result, newStatus: txNewStatus, action: txAction, previousStatus: request.status };
  }, { isolationLevel: 'Serializable' });

  // Audit log and notifications outside transaction
  await createLog(id, action, userId, {
    previousStatus,
    newStatus
  });

  if (newStatus === 'APPROVED') {
    emitSidebarRefreshByRole('STORE_MANAGER');
  }
  emitSidebarRefreshByRole('AREA_HEAD');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    success: true,
    message: newStatus === 'APPROVED'
      ? 'Request fully approved! Sent to Store Manager.'
      : 'Approval recorded. Waiting for other approver.',
    request: updatedRequest
  });
});

// Reject delivery request
export const rejectDeliveryRequest = asyncHandler(async function rejectDeliveryRequest(req, res) {
  const userId = req.user.id;
  const userRole = req.user.role;
  const isTestUser = isAdminOrTestUser(req.user);
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ message: 'Rejection reason is required' });
  }

  const request = await prisma.deliveryRequest.findUnique({
    where: { id }
  });

  if (!request) {
    return res.status(404).json({ message: 'Delivery request not found' });
  }

  if (request.status === 'REJECTED') {
    return res.status(400).json({ message: 'Request has already been rejected' });
  }

  if (request.status === 'APPROVED' || request.status === 'ASSIGNED' || request.status === 'DISPATCHED') {
    return res.status(400).json({ message: 'Cannot reject an approved/assigned request' });
  }

  let updateData = {};
  let action = '';

  if (isTestUser || userRole === 'SUPER_ADMIN' || userRole === 'MASTER') {
    updateData = {
      superAdminRejectedById: userId,
      superAdminRejectedAt: new Date(),
      superAdminRejectionReason: reason
    };
    action = 'SUPER_ADMIN_REJECTED';
  } else if (userRole === 'AREA_HEAD') {
    updateData = {
      areaHeadRejectedById: userId,
      areaHeadRejectedAt: new Date(),
      areaHeadRejectionReason: reason
    };
    action = 'AREA_HEAD_REJECTED';
  } else {
    return res.status(403).json({ message: 'Not authorized to reject requests' });
  }

  // Update request
  const updatedRequest = await prisma.deliveryRequest.update({
    where: { id },
    data: {
      ...updateData,
      status: 'REJECTED'
    }
  });

  // Reset lead's delivery status so delivery team sees rejection
  if (request.leadId) {
    await prisma.lead.update({
      where: { id: request.leadId },
      data: { deliveryStatus: 'MATERIAL_REJECTED' }
    });
  }

  // Create audit log
  await createLog(id, action, userId, { reason });

  // Notify requester about rejection
  if (request.requestedById) {
    await createNotification(
      request.requestedById,
      'DELIVERY_REQUEST_REJECTED',
      'Delivery Request Rejected',
      `Your delivery request has been rejected. Reason: ${reason}`,
      { deliveryRequestId: request.id, leadId: request.leadId }
    );
    emitSidebarRefresh(request.requestedById);
  }
  emitSidebarRefreshByRole('DELIVERY_TEAM');

  res.json({
    success: true,
    message: 'Request rejected',
    request: updatedRequest
  });
});

// Get all requests for admin view
export const getAllDeliveryRequests = asyncHandler(async function getAllDeliveryRequests(req, res) {
  const { status } = req.query;
  const { page, limit, skip } = parsePagination(req.query, 20);

  const whereClause = {};
  if (status && status !== 'all') {
    whereClause.status = status;
  }

  const [requests, total] = await Promise.all([
    prisma.deliveryRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        items: {
          include: {
            product: true
          }
        },
        lead: {
          include: {
            campaignData: true
          }
        },
        requestedBy: {
          select: { id: true, name: true, email: true, role: true }
        },
        superAdminApprovedBy: {
          select: { id: true, name: true }
        },
        areaHeadApprovedBy: {
          select: { id: true, name: true }
        },
        assignedToStoreManager: {
          select: { id: true, name: true }
        }
      }
    }),
    prisma.deliveryRequest.count({ where: whereClause })
  ]);

  res.json({
    success: true,
    ...paginatedResponse({ data: requests, total, page, limit, dataKey: 'requests' })
  });
});

// ========== STORE MANAGER APIs ==========

// Get approved requests for store manager
export const getApprovedRequestsForStore = asyncHandler(async function getApprovedRequestsForStore(req, res) {
  const { status } = req.query;

  let whereClause = {
    status: { in: ['APPROVED', 'ASSIGNED', 'DISPATCHED'] }
  };

  if (status && status !== 'all') {
    whereClause.status = status;
  }

  const requests = await prisma.deliveryRequest.findMany({
    where: whereClause,
    orderBy: { updatedAt: 'desc' },
    include: {
      items: {
        include: {
          product: true
        }
      },
      lead: {
        include: {
          campaignData: true
        }
      },
      requestedBy: {
        select: { id: true, name: true, email: true, role: true }
      },
      superAdminApprovedBy: {
        select: { id: true, name: true }
      },
      areaHeadApprovedBy: {
        select: { id: true, name: true }
      },
      assignedToStoreManager: {
        select: { id: true, name: true }
      }
    }
  });

  // Get stats for store manager
  const stats = await prisma.deliveryRequest.groupBy({
    by: ['status'],
    _count: true,
    where: {
      status: { in: ['APPROVED', 'ASSIGNED', 'DISPATCHED', 'COMPLETED'] }
    }
  });

  const formattedStats = {
    approved: 0,
    assigned: 0,
    dispatched: 0,
    completed: 0
  };

  stats.forEach(s => {
    formattedStats[s.status.toLowerCase()] = s._count;
  });

  res.json({ success: true, requests, stats: formattedStats });
});

// Assign items to delivery request (Store Manager)
export const assignItemsToRequest = asyncHandler(async function assignItemsToRequest(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const { assignments } = req.body; // Array of { itemId, serialNumbers: [], poItemId, bulkQuantity }

  const request = await prisma.deliveryRequest.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: true
        }
      }
    }
  });

  if (!request) {
    return res.status(404).json({ message: 'Delivery request not found' });
  }

  if (request.status !== 'APPROVED') {
    return res.status(400).json({ message: 'Request must be in APPROVED status to assign items' });
  }

  // Validate assignments
  for (const assignment of assignments) {
    const item = request.items.find(i => i.id === assignment.itemId);
    if (!item) {
      return res.status(400).json({ message: `Item ${assignment.itemId} not found in request` });
    }

    const isBulkItem = item.product.category === 'FIBER' || item.product.unit === 'mtrs';
    const hasSerials = assignment.serialNumbers && assignment.serialNumbers.length > 0;
    const hasBulkQty = assignment.bulkQuantity && assignment.bulkQuantity > 0;

    if (isBulkItem || (!hasSerials && hasBulkQty)) {
      // Quantity-based assignment (bulk/fiber items OR non-serialized items)
      const bulkQty = assignment.bulkQuantity || 0;
      if (bulkQty <= 0) {
        return res.status(400).json({
          message: `Please enter quantity to assign for ${item.product.modelNumber}`
        });
      }
      if (bulkQty > item.quantity) {
        return res.status(400).json({
          message: `Assigned quantity (${bulkQty}) cannot exceed required quantity (${item.quantity}) for ${item.product.modelNumber}`
        });
      }

      // Verify quantity is available in inventory
      const poItem = await prisma.storePurchaseOrderItem.findFirst({
        where: {
          id: assignment.poItemId,
          status: 'IN_STORE'
        }
      });

      const availableQty = poItem?.receivedQuantity ?? poItem?.quantity ?? 0;
      if (!poItem || availableQty < bulkQty) {
        return res.status(400).json({
          message: `Insufficient inventory for ${item.product.modelNumber}. Available: ${availableQty}`
        });
      }
    } else if (hasSerials) {
      // Serialized item - check serial numbers count matches quantity
      if (assignment.serialNumbers.length !== item.quantity) {
        return res.status(400).json({
          message: `Serial numbers count (${assignment.serialNumbers.length}) must match quantity (${item.quantity}) for ${item.product.modelNumber}`
        });
      }

      // Verify serial numbers exist in inventory and are available
      const poItem = await prisma.storePurchaseOrderItem.findFirst({
        where: {
          id: assignment.poItemId,
          status: 'IN_STORE',
          serialNumbers: {
            hasEvery: assignment.serialNumbers
          }
        }
      });

      if (!poItem) {
        return res.status(400).json({
          message: `Some serial numbers are not available in inventory for ${item.product.modelNumber}`
        });
      }
    } else {
      return res.status(400).json({
        message: `Please select serial numbers or enter quantity for ${item.product.modelNumber}`
      });
    }
  }

  // Update each item with assignments
  for (const assignment of assignments) {
    const item = request.items.find(i => i.id === assignment.itemId);
    const isBulkItem = item.product.category === 'FIBER' || item.product.unit === 'mtrs';
    const hasSerials = assignment.serialNumbers && assignment.serialNumbers.length > 0;
    const hasBulkQty = assignment.bulkQuantity && assignment.bulkQuantity > 0;
    const useQuantityBased = isBulkItem || (!hasSerials && hasBulkQty);
    const assignedQty = useQuantityBased ? (assignment.bulkQuantity || 0) : assignment.serialNumbers.length;

    await prisma.deliveryRequestItem.update({
      where: { id: assignment.itemId },
      data: {
        assignedQuantity: assignedQty,
        assignedSerialNumbers: assignment.serialNumbers || [],
        assignedFromPOItemId: assignment.poItemId,
        isAssigned: true,
        assignedAt: new Date()
      }
    });

    if (useQuantityBased) {
      // Quantity-based - deduct quantity from inventory
      const poItem = await prisma.storePurchaseOrderItem.findUnique({
        where: { id: assignment.poItemId }
      });

      if (poItem) {
        const currentQty = poItem.receivedQuantity ?? poItem.quantity ?? 0;
        const remainingQty = currentQty - assignedQty;
        await prisma.storePurchaseOrderItem.update({
          where: { id: assignment.poItemId },
          data: {
            receivedQuantity: remainingQty > 0 ? remainingQty : 0,
            quantity: Math.max(0, poItem.quantity - assignedQty),
            status: remainingQty <= 0 ? 'ASSIGNED' : 'IN_STORE'
          }
        });
      }
    } else if (hasSerials) {
      // Serialized item - remove serial numbers from PO item inventory
      const poItem = await prisma.storePurchaseOrderItem.findUnique({
        where: { id: assignment.poItemId }
      });

      if (poItem) {
        const remainingSerials = poItem.serialNumbers.filter(
          sn => !assignment.serialNumbers.includes(sn)
        );

        await prisma.storePurchaseOrderItem.update({
          where: { id: assignment.poItemId },
          data: {
            serialNumbers: remainingSerials,
            receivedQuantity: remainingSerials.length,
            quantity: remainingSerials.length,
            status: remainingSerials.length === 0 ? 'ASSIGNED' : 'IN_STORE'
          }
        });
      }
    }
  }

  // Update request status
  const updatedRequest = await prisma.deliveryRequest.update({
    where: { id },
    data: {
      status: 'ASSIGNED',
      assignedToStoreManagerId: userId,
      assignedAt: new Date()
    },
    include: {
      items: {
        include: {
          product: true
        }
      }
    }
  });

  // Auto-push to NOC: skip MATERIAL_RECEIVED stage, go directly to PUSHED_TO_NOC
  await prisma.lead.update({
    where: { id: request.leadId },
    data: { deliveryStatus: 'PUSHED_TO_NOC' }
  });

  // Set pushedToNocAt on the delivery request
  await prisma.deliveryRequest.update({
    where: { id },
    data: {
      pushedToNocAt: new Date(),
      pushedToNocById: userId
    }
  });

  // Notify NOC team that new work is available
  emitSidebarRefreshByRole('NOC');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  // Create audit log
  await createLog(id, 'ITEMS_ASSIGNED', userId, {
    assignmentCount: assignments.length
  });
  await createLog(id, 'PUSHED_TO_NOC', userId, {
    company: request.lead?.campaignData?.company,
    itemCount: request.items?.length,
    autoTransition: true
  });

  res.json({
    success: true,
    message: 'Items assigned successfully',
    request: updatedRequest
  });
});

// Mark request as dispatched
export const markAsDispatched = asyncHandler(async function markAsDispatched(req, res) {
  const userId = req.user.id;
  const { id } = req.params;

  const request = await prisma.deliveryRequest.findUnique({
    where: { id }
  });

  if (!request) {
    return res.status(404).json({ message: 'Delivery request not found' });
  }

  if (request.status !== 'ASSIGNED') {
    return res.status(400).json({ message: 'Request must be in ASSIGNED status to dispatch' });
  }

  const updatedRequest = await prisma.deliveryRequest.update({
    where: { id },
    data: {
      status: 'DISPATCHED',
      dispatchedAt: new Date()
    }
  });

  await createLog(id, 'DISPATCHED', userId);

  res.json({
    success: true,
    message: 'Request marked as dispatched',
    request: updatedRequest
  });
});

// Mark request as completed
export const markAsCompleted = asyncHandler(async function markAsCompleted(req, res) {
  const userId = req.user.id;
  const { id } = req.params;

  const request = await prisma.deliveryRequest.findUnique({
    where: { id },
    include: {
      lead: {
        include: {
          campaignData: { select: { company: true } }
        }
      }
    }
  });

  if (!request) {
    return res.status(404).json({ message: 'Delivery request not found' });
  }

  if (request.status !== 'DISPATCHED') {
    return res.status(400).json({ message: 'Request must be in DISPATCHED status to complete' });
  }

  const updatedRequest = await prisma.deliveryRequest.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date()
    }
  });

  // Update lead's delivery status to match
  if (request.leadId) {
    await prisma.lead.update({
      where: { id: request.leadId },
      data: { deliveryStatus: 'COMPLETED' }
    });
  }

  await createLog(id, 'COMPLETED', userId);

  // Notify BDM that delivery is completed
  if (request.lead?.assignedToId) {
    await createNotification(
      request.lead.assignedToId,
      'DELIVERY_COMPLETED',
      'Delivery Completed',
      `Installation completed for "${request.lead?.campaignData?.company || 'customer'}"`,
      { leadId: request.leadId, deliveryRequestId: request.id }
    );
    emitSidebarRefresh(request.lead.assignedToId);
  }

  res.json({
    success: true,
    message: 'Delivery completed',
    request: updatedRequest
  });
});

// Push request to NOC (Delivery Team)
export const pushToNoc = asyncHandler(async function pushToNoc(req, res) {
  const userId = req.user.id;
  const { id } = req.params;

  const request = await prisma.deliveryRequest.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: true
        }
      },
      lead: {
        include: {
          campaignData: true
        }
      }
    }
  });

  if (!request) {
    return res.status(404).json({ message: 'Delivery request not found' });
  }

  if (request.status !== 'ASSIGNED') {
    return res.status(400).json({ message: 'Request must be in ASSIGNED status to push to NOC' });
  }

  if (request.pushedToNocAt) {
    return res.status(400).json({ message: 'Request has already been pushed to NOC' });
  }

  const updatedRequest = await prisma.deliveryRequest.update({
    where: { id },
    data: {
      pushedToNocById: userId,
      pushedToNocAt: new Date()
    },
    include: {
      items: {
        include: {
          product: true
        }
      },
      lead: {
        include: {
          campaignData: true
        }
      },
      requestedBy: {
        select: { id: true, name: true, email: true, role: true }
      },
      pushedToNocBy: {
        select: { id: true, name: true }
      }
    }
  });

  // Update lead's delivery status to PUSHED_TO_NOC
  await prisma.lead.update({
    where: { id: request.leadId },
    data: { deliveryStatus: 'PUSHED_TO_NOC' }
  });

  await createLog(id, 'PUSHED_TO_NOC', userId, {
    company: request.lead?.campaignData?.company,
    itemCount: request.items?.length
  });

  // Notify NOC and Super Admin
  emitSidebarRefreshByRole('NOC');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    success: true,
    message: 'Request pushed to NOC successfully',
    request: updatedRequest
  });
});

// Get requests pushed to NOC (for NOC dashboard)
export const getNocRequests = asyncHandler(async function getNocRequests(req, res) {
  const requests = await prisma.deliveryRequest.findMany({
    where: {
      pushedToNocAt: { not: null }
    },
    orderBy: { pushedToNocAt: 'desc' },
    include: {
      items: {
        include: {
          product: true
        }
      },
      lead: {
        include: {
          campaignData: true
        }
      },
      requestedBy: {
        select: { id: true, name: true, email: true, role: true }
      },
      pushedToNocBy: {
        select: { id: true, name: true }
      },
      assignedToStoreManager: {
        select: { id: true, name: true }
      }
    }
  });

  res.json({ success: true, requests });
});

// Get available inventory for assignment
export const getAvailableInventory = asyncHandler(async function getAvailableInventory(req, res) {
  const { productId } = req.query;

  const whereClause = {
    status: 'IN_STORE'
  };

  if (productId) {
    whereClause.productId = productId;
  }

  const inventory = await prisma.storePurchaseOrderItem.findMany({
    where: whereClause,
    include: {
      product: true,
      purchaseOrder: {
        select: {
          poNumber: true,
          vendor: true
        }
      }
    }
  });

  // Format inventory with available quantities
  const formattedInventory = inventory.map(item => ({
    id: item.id,
    productId: item.productId,
    productModel: item.product.modelNumber,
    productCategory: item.product.category,
    brandName: item.product.brandName,
    poNumber: item.purchaseOrder.poNumber,
    availableQuantity: item.serialNumbers.length || item.receivedQuantity || item.quantity,
    serialNumbers: item.serialNumbers,
    unit: item.product.unit
  }));

  res.json({ success: true, inventory: formattedInventory });
});

// Get stats for dashboard
export const getDeliveryRequestStats = asyncHandler(async function getDeliveryRequestStats(req, res) {
  const userRole = req.user.role;

  const stats = await prisma.deliveryRequest.groupBy({
    by: ['status'],
    _count: true
  });

  const formattedStats = {
    pendingApproval: 0,
    superAdminApproved: 0,
    areaHeadApproved: 0,
    approved: 0,
    rejected: 0,
    assigned: 0,
    dispatched: 0,
    completed: 0,
    total: 0
  };

  stats.forEach(s => {
    const key = s.status.toLowerCase().replace('_', '');
    if (s.status === 'PENDING_APPROVAL') formattedStats.pendingApproval = s._count;
    else if (s.status === 'SUPER_ADMIN_APPROVED') formattedStats.superAdminApproved = s._count;
    else if (s.status === 'AREA_HEAD_APPROVED') formattedStats.areaHeadApproved = s._count;
    else if (s.status === 'APPROVED') formattedStats.approved = s._count;
    else if (s.status === 'REJECTED') formattedStats.rejected = s._count;
    else if (s.status === 'ASSIGNED') formattedStats.assigned = s._count;
    else if (s.status === 'DISPATCHED') formattedStats.dispatched = s._count;
    else if (s.status === 'COMPLETED') formattedStats.completed = s._count;
    formattedStats.total += s._count;
  });

  res.json({ success: true, stats: formattedStats });
});
