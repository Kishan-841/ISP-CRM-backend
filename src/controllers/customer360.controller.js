import prisma from '../config/db.js';
import { asyncHandler, parsePagination, paginatedResponse, buildSearchFilter } from '../utils/controllerHelper.js';

// GET /api/customer-360/search?q=term&page=1&limit=20
export const searchCustomers = asyncHandler(async function searchCustomers(req, res) {
  const { q = '' } = req.query;
  const { page, limit, skip } = parsePagination(req.query, 20);

  const searchTerm = q.trim();

  // Build where clause — empty query returns all leads
  const where = searchTerm.length >= 2
    ? {
        OR: buildSearchFilter(searchTerm, [
          'campaignData.company',
          'campaignData.name',
          'campaignData.firstName',
          'campaignData.lastName',
          { field: 'campaignData.phone' },
          'customerUsername',
          'customerGstNo',
        ]),
      }
    : {};

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: {
        id: true,
        status: true,
        deliveryStatus: true,
        customerUsername: true,
        actualPlanIsActive: true,
        actualPlanName: true,
        createdAt: true,
        campaignData: {
          select: {
            company: true,
            name: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            city: true,
            state: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.lead.count({ where }),
  ]);

  const items = leads.map((lead) => ({
    id: lead.id,
    company: lead.campaignData?.company || '',
    name: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim(),
    phone: lead.campaignData?.phone || '',
    email: lead.campaignData?.email || '',
    city: lead.campaignData?.city || '',
    state: lead.campaignData?.state || '',
    status: lead.status,
    deliveryStatus: lead.deliveryStatus,
    customerUsername: lead.customerUsername,
    planActive: lead.actualPlanIsActive,
    planName: lead.actualPlanName,
    createdAt: lead.createdAt,
  }));

  res.json(paginatedResponse({ data: items, total, page, limit }));
});

// GET /api/customer-360/:id/summary
export const getSummary = asyncHandler(async function getSummary(req, res) {
  const { id } = req.params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      type: true,
      deliveryStatus: true,
      customerUsername: true,
      customerIpAssigned: true,
      circuitId: true,
      customerGstNo: true,
      fullAddress: true,
      location: true,
      // Pricing
      arcAmount: true,
      otcAmount: true,
      advanceAmount: true,
      paymentTerms: true,
      // Current plan
      actualPlanName: true,
      actualPlanBandwidth: true,
      actualPlanUploadBandwidth: true,
      actualPlanPrice: true,
      actualPlanBillingCycle: true,
      actualPlanIsActive: true,
      actualPlanStartDate: true,
      actualPlanEndDate: true,
      // Demo plan
      demoPlanName: true,
      demoPlanBandwidth: true,
      demoPlanIsActive: true,
      // Timestamps
      createdAt: true,
      updatedAt: true,
      // Relations
      campaignData: {
        select: {
          company: true,
          name: true,
          firstName: true,
          lastName: true,
          phone: true,
          whatsapp: true,
          email: true,
          city: true,
          state: true,
          industry: true,
          campaign: { select: { name: true, code: true } },
        },
      },
      assignedTo: { select: { id: true, name: true, email: true, role: true } },
    },
  });

  if (!lead) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  const [latestLedger, samAssignment, totalComplaints, openComplaints, totalInvoices, overdueInvoices] = await Promise.all([
    prisma.ledgerEntry.findFirst({
      where: { customerId: id },
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
      select: { runningBalance: true },
    }),
    prisma.sAMAssignment.findUnique({
      where: { customerId: id },
      select: {
        samExecutive: { select: { id: true, name: true, email: true } },
        assignedAt: true,
      },
    }),
    prisma.complaint.count({ where: { leadId: id } }),
    prisma.complaint.count({
      where: { leadId: id, status: 'OPEN' },
    }),
    prisma.invoice.count({ where: { leadId: id } }),
    prisma.invoice.count({ where: { leadId: id, status: 'OVERDUE' } }),
  ]);

  res.json({
    ...lead,
    name: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim(),
    company: lead.campaignData?.company || '',
    currentBalance: latestLedger?.runningBalance ?? 0,
    samExecutive: samAssignment?.samExecutive || null,
    samAssignedAt: samAssignment?.assignedAt || null,
    complaintsSummary: { total: totalComplaints, open: openComplaints },
    invoicesSummary: { total: totalInvoices, overdue: overdueInvoices },
  });
});

// GET /api/customer-360/:id/journey
export const getJourney = asyncHandler(async function getJourney(req, res) {
  const { id } = req.params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      deliveryStatus: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true, role: true } },
      assignedTo: {
        select: {
          id: true, name: true, role: true,
          teamLeader: { select: { id: true, name: true } },
        },
      },
      feasibilityAssignedTo: { select: { id: true, name: true, role: true } },
      feasibilityReviewedAt: true,
      feasibilityNotes: true,
      opsApprovedBy: { select: { id: true, name: true, role: true } },
      opsApprovedAt: true,
      opsApprovalStatus: true,
      opsRejectedReason: true,
      docsVerifiedById: true,
      docsVerifiedAt: true,
      docsRejectedReason: true,
      accountsVerifiedBy: { select: { id: true, name: true, role: true } },
      accountsVerifiedAt: true,
      accountsRejectedReason: true,
      gstVerifiedBy: { select: { id: true, name: true, role: true } },
      gstVerifiedAt: true,
      pushedToInstallationBy: { select: { id: true, name: true, role: true } },
      pushedToInstallationAt: true,
      nocConfiguredBy: { select: { id: true, name: true, role: true } },
      nocConfiguredAt: true,
      nocPushedToDeliveryBy: { select: { id: true, name: true, role: true } },
      nocPushedToDeliveryAt: true,
      customerCreatedBy: { select: { id: true, name: true, role: true } },
      customerCreatedAt: true,
      customerUsername: true,
      deliveryAssignedTo: { select: { id: true, name: true, role: true } },
      deliveryAssignedAt: true,
      demoPlanAssignedBy: { select: { id: true, name: true, role: true } },
      demoPlanAssignedAt: true,
      demoPlanName: true,
      speedTestUploadedBy: { select: { id: true, name: true, role: true } },
      speedTestUploadedAt: true,
      customerAcceptanceBy: { select: { id: true, name: true, role: true } },
      customerAcceptanceAt: true,
      customerAcceptanceStatus: true,
      actualPlanCreatedBy: { select: { id: true, name: true, role: true } },
      actualPlanCreatedAt: true,
      actualPlanName: true,
      campaignData: {
        select: {
          id: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true, role: true } },
          assignedToId: true,
        },
      },
    },
  });

  if (!lead) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  // Fetch call logs, ISR user, docs verifier, delivery requests, and status change logs in parallel
  const [callLogs, isrUser, docsVerifiedByUser, deliveryRequests, statusChangeLogs] = await Promise.all([
    lead.campaignData?.id
      ? prisma.callLog.findMany({
          where: { campaignDataId: lead.campaignData.id },
          select: {
            id: true,
            startTime: true,
            endTime: true,
            duration: true,
            status: true,
            notes: true,
            user: { select: { id: true, name: true, role: true } },
          },
          orderBy: { startTime: 'asc' },
        })
      : [],
    lead.campaignData?.assignedToId
      ? prisma.user.findUnique({
          where: { id: lead.campaignData.assignedToId },
          select: { id: true, name: true, role: true },
        })
      : null,
    lead.docsVerifiedById
      ? prisma.user.findUnique({
          where: { id: lead.docsVerifiedById },
          select: { id: true, name: true, role: true },
        })
      : null,
    prisma.deliveryRequest.findMany({
      where: { leadId: id },
      select: {
        id: true,
        requestNumber: true,
        status: true,
        requestedAt: true,
        requestedBy: { select: { id: true, name: true, role: true } },
        superAdminApprovedBy: { select: { id: true, name: true } },
        superAdminApprovedAt: true,
        superAdminRejectedBy: { select: { id: true, name: true } },
        superAdminRejectedAt: true,
        superAdminRejectionReason: true,
        areaHeadApprovedBy: { select: { id: true, name: true } },
        areaHeadApprovedAt: true,
        areaHeadRejectedBy: { select: { id: true, name: true } },
        areaHeadRejectedAt: true,
        areaHeadRejectionReason: true,
        assignedToStoreManager: { select: { id: true, name: true } },
        assignedAt: true,
        dispatchedAt: true,
        completedAt: true,
        items: {
          select: {
            id: true,
            quantity: true,
            assignedQuantity: true,
            assignedSerialNumbers: true,
            usedQuantity: true,
            product: { select: { id: true, brandName: true, modelNumber: true, category: true } },
          },
        },
      },
      orderBy: { requestedAt: 'asc' },
    }),
    prisma.statusChangeLog.findMany({
      where: { entityType: 'LEAD', entityId: id },
      select: {
        id: true,
        field: true,
        oldValue: true,
        newValue: true,
        changedAt: true,
        reason: true,
        changedBy: { select: { id: true, name: true, role: true } },
      },
      orderBy: { changedAt: 'asc' },
    }),
  ]);

  // Build timeline events from lead fields
  const timeline = [];

  if (lead.campaignData) {
    timeline.push({
      stage: 'DATA_UPLOADED',
      label: 'Data Uploaded',
      timestamp: lead.campaignData.createdAt,
      user: lead.campaignData.createdBy,
    });
  }

  if (isrUser) {
    timeline.push({
      stage: 'ISR_ASSIGNED',
      label: 'ISR Assigned',
      timestamp: lead.campaignData?.createdAt,
      user: isrUser,
    });
  }

  callLogs.forEach((log, index) => {
    timeline.push({
      stage: 'ISR_CALL',
      label: `ISR Call #${index + 1} (${log.status})`,
      timestamp: log.startTime,
      user: log.user,
      meta: { duration: log.duration, status: log.status, notes: log.notes },
    });
  });

  timeline.push({
    stage: 'LEAD_CREATED',
    label: 'Lead Created',
    timestamp: lead.createdAt,
    user: lead.createdBy,
  });

  if (lead.assignedTo) {
    timeline.push({
      stage: 'BDM_ASSIGNED',
      label: 'BDM Assigned',
      timestamp: lead.createdAt,
      user: lead.assignedTo,
      meta: { teamLeader: lead.assignedTo.teamLeader },
    });
  }

  if (lead.feasibilityAssignedTo) {
    timeline.push({
      stage: 'FEASIBILITY_ASSIGNED',
      label: 'Feasibility Assigned',
      timestamp: lead.feasibilityReviewedAt || lead.createdAt,
      user: lead.feasibilityAssignedTo,
      meta: { notes: lead.feasibilityNotes },
    });
  }

  if (lead.opsApprovedBy) {
    timeline.push({
      stage: 'OPS_APPROVED',
      label: lead.opsApprovalStatus === 'REJECTED' ? 'OPS Rejected' : 'OPS Approved',
      timestamp: lead.opsApprovedAt,
      user: lead.opsApprovedBy,
      meta: { status: lead.opsApprovalStatus, rejectedReason: lead.opsRejectedReason },
    });
  }

  if (lead.docsVerifiedById) {
    timeline.push({
      stage: 'DOCS_VERIFIED',
      label: lead.docsRejectedReason ? 'Docs Rejected' : 'Docs Verified',
      timestamp: lead.docsVerifiedAt,
      user: docsVerifiedByUser,
      meta: { rejectedReason: lead.docsRejectedReason },
    });
  }

  if (lead.accountsVerifiedBy) {
    timeline.push({
      stage: 'ACCOUNTS_VERIFIED',
      label: lead.accountsRejectedReason ? 'Accounts Rejected' : 'Accounts Verified',
      timestamp: lead.accountsVerifiedAt,
      user: lead.accountsVerifiedBy,
      meta: { rejectedReason: lead.accountsRejectedReason },
    });
  }

  if (lead.gstVerifiedBy) {
    timeline.push({
      stage: 'GST_VERIFIED',
      label: 'GST Verified',
      timestamp: lead.gstVerifiedAt,
      user: lead.gstVerifiedBy,
    });
  }

  if (lead.pushedToInstallationBy) {
    timeline.push({
      stage: 'PUSHED_TO_INSTALLATION',
      label: 'Pushed to Installation',
      timestamp: lead.pushedToInstallationAt,
      user: lead.pushedToInstallationBy,
    });
  }

  deliveryRequests.forEach((dr) => {
    timeline.push({
      stage: 'DELIVERY_REQUESTED',
      label: `Delivery Requested (${dr.requestNumber})`,
      timestamp: dr.requestedAt,
      user: dr.requestedBy,
      meta: {
        requestNumber: dr.requestNumber,
        status: dr.status,
        items: dr.items,
        approvalChain: {
          superAdmin: dr.superAdminApprovedBy ? { user: dr.superAdminApprovedBy, at: dr.superAdminApprovedAt } : null,
          areaHead: dr.areaHeadApprovedBy ? { user: dr.areaHeadApprovedBy, at: dr.areaHeadApprovedAt } : null,
        },
        dispatchedAt: dr.dispatchedAt,
        completedAt: dr.completedAt,
      },
    });
  });

  if (lead.nocConfiguredBy) {
    timeline.push({
      stage: 'NOC_CONFIGURED',
      label: 'NOC Configured',
      timestamp: lead.nocConfiguredAt,
      user: lead.nocConfiguredBy,
      meta: { username: lead.customerUsername },
    });
  }

  if (lead.customerCreatedBy) {
    timeline.push({
      stage: 'CUSTOMER_CREATED',
      label: 'Customer Account Created',
      timestamp: lead.customerCreatedAt,
      user: lead.customerCreatedBy,
    });
  }

  if (lead.demoPlanAssignedBy) {
    timeline.push({
      stage: 'DEMO_PLAN',
      label: `Demo Plan Assigned (${lead.demoPlanName})`,
      timestamp: lead.demoPlanAssignedAt,
      user: lead.demoPlanAssignedBy,
    });
  }

  if (lead.speedTestUploadedBy) {
    timeline.push({
      stage: 'SPEED_TEST',
      label: 'Speed Test Uploaded',
      timestamp: lead.speedTestUploadedAt,
      user: lead.speedTestUploadedBy,
    });
  }

  if (lead.customerAcceptanceBy) {
    timeline.push({
      stage: 'CUSTOMER_ACCEPTANCE',
      label: `Customer ${lead.customerAcceptanceStatus}`,
      timestamp: lead.customerAcceptanceAt,
      user: lead.customerAcceptanceBy,
      meta: { status: lead.customerAcceptanceStatus },
    });
  }

  if (lead.actualPlanCreatedBy) {
    timeline.push({
      stage: 'ACTUAL_PLAN',
      label: `Actual Plan Created (${lead.actualPlanName})`,
      timestamp: lead.actualPlanCreatedAt,
      user: lead.actualPlanCreatedBy,
    });
  }

  timeline.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  const materials = deliveryRequests.flatMap((dr) =>
    dr.items.map((item) => ({
      deliveryRequest: dr.requestNumber,
      product: item.product?.brandName || item.product?.modelNumber,
      type: item.product?.category,
      quantity: item.quantity,
      assignedQuantity: item.assignedQuantity,
      serialNumbers: item.assignedSerialNumbers || [],
      usedQuantity: item.usedQuantity,
    }))
  );

  res.json({
    timeline,
    statusChangeLogs,
    materials,
  });
});

// GET /api/customer-360/:id/billing
export const getBilling = asyncHandler(async function getBilling(req, res) {
  const { id } = req.params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: {
      arcAmount: true,
      otcAmount: true,
      advanceAmount: true,
      paymentTerms: true,
      actualPlanName: true,
      actualPlanBandwidth: true,
      actualPlanUploadBandwidth: true,
      actualPlanPrice: true,
      actualPlanBillingCycle: true,
      actualPlanBillingType: true,
      actualPlanIsActive: true,
      actualPlanStartDate: true,
      actualPlanEndDate: true,
      actualPlanValidityDays: true,
    },
  });

  if (!lead) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  const [invoices, advancePayments, creditNotes, planHistory, ledgerSummary] = await Promise.all([
    prisma.invoice.findMany({
      where: { leadId: id },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
        planName: true,
        baseAmount: true,
        discountAmount: true,
        taxableAmount: true,
        sgstAmount: true,
        cgstAmount: true,
        totalGstAmount: true,
        grandTotal: true,
        totalPaidAmount: true,
        totalCreditAmount: true,
        remainingAmount: true,
        status: true,
        paidAt: true,
        notes: true,
        createdBy: { select: { id: true, name: true } },
        createdAt: true,
        payments: {
          select: {
            id: true,
            receiptNumber: true,
            paymentDate: true,
            amount: true,
            paymentMode: true,
            bankAccount: true,
            tdsAmount: true,
            remark: true,
            createdBy: { select: { id: true, name: true } },
          },
          orderBy: { paymentDate: 'asc' },
        },
        creditNotes: {
          select: {
            id: true,
            creditNoteNumber: true,
            totalAmount: true,
            reason: true,
            status: true,
          },
        },
      },
      orderBy: { invoiceDate: 'desc' },
    }),

    prisma.advancePayment.findMany({
      where: { leadId: id },
      select: {
        id: true,
        receiptNumber: true,
        amount: true,
        paymentMode: true,
        bankAccount: true,
        transactionDate: true,
        remark: true,
        createdBy: { select: { id: true, name: true } },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),

    prisma.creditNote.findMany({
      where: { invoice: { leadId: id } },
      select: {
        id: true,
        creditNoteNumber: true,
        creditNoteDate: true,
        baseAmount: true,
        totalGstAmount: true,
        totalAmount: true,
        reason: true,
        status: true,
        remarks: true,
        adjustedAt: true,
        refundedAt: true,
        refundMode: true,
        invoice: { select: { invoiceNumber: true } },
        adjustedAgainstInvoice: { select: { invoiceNumber: true } },
        createdBy: { select: { id: true, name: true } },
        createdAt: true,
      },
      orderBy: { creditNoteDate: 'desc' },
    }),

    prisma.planUpgradeHistory.findMany({
      where: { leadId: id },
      select: {
        id: true,
        actionType: true,
        previousPlanName: true,
        previousBandwidth: true,
        previousArc: true,
        newPlanName: true,
        newBandwidth: true,
        newArc: true,
        additionalArc: true,
        degradeArc: true,
        upgradeDate: true,
        daysOnOldPlan: true,
        daysOnNewPlan: true,
        oldPlanAmount: true,
        newPlanAmount: true,
        totalAmount: true,
        differenceAmount: true,
        notes: true,
        createdBy: { select: { id: true, name: true } },
        createdAt: true,
      },
      orderBy: { upgradeDate: 'desc' },
    }),

    prisma.ledgerEntry.aggregate({
      where: { customerId: id },
      _sum: { debitAmount: true, creditAmount: true },
    }),
  ]);

  const latestLedger = await prisma.ledgerEntry.findFirst({
    where: { customerId: id },
    orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
    select: { runningBalance: true },
  });

  res.json({
    pricing: {
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
    },
    currentPlan: {
      name: lead.actualPlanName,
      bandwidth: lead.actualPlanBandwidth,
      uploadBandwidth: lead.actualPlanUploadBandwidth,
      price: lead.actualPlanPrice,
      billingCycle: lead.actualPlanBillingCycle,
      billingType: lead.actualPlanBillingType,
      isActive: lead.actualPlanIsActive,
      startDate: lead.actualPlanStartDate,
      endDate: lead.actualPlanEndDate,
      validityDays: lead.actualPlanValidityDays,
    },
    planHistory,
    invoices,
    advancePayments,
    creditNotes,
    accountSummary: {
      totalBilled: ledgerSummary._sum.debitAmount || 0,
      totalPaid: ledgerSummary._sum.creditAmount || 0,
      outstandingBalance: latestLedger?.runningBalance ?? 0,
    },
  });
});

// GET /api/customer-360/:id/documents
export const getDocuments = asyncHandler(async function getDocuments(req, res) {
  const { id } = req.params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: {
      documents: true,
      docUploadMethod: true,
      speedTestScreenshot: true,
      latencyTestScreenshot: true,
      customerAcceptanceScreenshot: true,
      speedTestUploadedAt: true,
      speedTestUploadedBy: { select: { id: true, name: true } },
      customerAcceptanceAt: true,
      customerAcceptanceBy: { select: { id: true, name: true } },
      docsVerifiedAt: true,
      docsVerifiedById: true,
      docsRejectedReason: true,
      uploadLinks: {
        select: {
          id: true,
          token: true,
          expiresAt: true,
          accessCount: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!lead) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  // Fetch docs verifier user if set
  const docsVerifier = lead.docsVerifiedById
    ? await prisma.user.findUnique({
        where: { id: lead.docsVerifiedById },
        select: { id: true, name: true },
      })
    : null;

  const typedDocuments = lead.documents || {};
  const documentList = Object.entries(typedDocuments).map(([type, data]) => ({
    type,
    ...(typeof data === 'object' ? data : { url: data }),
  }));

  res.json({
    documents: documentList,
    uploadMethod: lead.docUploadMethod,
    screenshots: {
      speedTest: lead.speedTestScreenshot ? {
        url: lead.speedTestScreenshot,
        uploadedAt: lead.speedTestUploadedAt,
        uploadedBy: lead.speedTestUploadedBy,
      } : null,
      latencyTest: lead.latencyTestScreenshot ? {
        url: lead.latencyTestScreenshot,
        uploadedAt: lead.speedTestUploadedAt,
        uploadedBy: lead.speedTestUploadedBy,
      } : null,
      customerAcceptance: lead.customerAcceptanceScreenshot ? {
        url: lead.customerAcceptanceScreenshot,
        uploadedAt: lead.customerAcceptanceAt,
        uploadedBy: lead.customerAcceptanceBy,
      } : null,
    },
    verification: {
      verifiedAt: lead.docsVerifiedAt,
      verifiedBy: docsVerifier,
      rejectedReason: lead.docsRejectedReason,
    },
    uploadLinks: lead.uploadLinks,
  });
});

// GET /api/customer-360/:id/complaints
export const getComplaints = asyncHandler(async function getComplaints(req, res) {
  const { id } = req.params;

  const leadExists = await prisma.lead.findUnique({ where: { id }, select: { id: true } });
  if (!leadExists) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  const complaints = await prisma.complaint.findMany({
    where: { leadId: id },
    select: {
      id: true,
      complaintNumber: true,
      status: true,
      priority: true,
      description: true,
      tatHours: true,
      tatDeadline: true,
      resolutionNotes: true,
      resolvedAt: true,
      closedAt: true,
      reopenCount: true,
      createdAt: true,
      category: { select: { id: true, name: true } },
      subCategory: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true, role: true } },
      assignments: {
        where: { isActive: true },
        select: {
          user: { select: { id: true, name: true, role: true } },
          assignedBy: { select: { id: true, name: true } },
          assignedAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const stats = {
    total: complaints.length,
    open: complaints.filter((c) => c.status === 'OPEN').length,
    closed: complaints.filter((c) => c.status === 'CLOSED').length,
    slaBreached: complaints.filter(
      (c) => c.tatDeadline && new Date(c.tatDeadline) < new Date() && c.status !== 'CLOSED'
    ).length,
  };

  const complaintsWithSla = complaints.map((c) => {
    if (!c.tatDeadline) {
      return { ...c, slaStatus: 'NO_SLA' };
    }
    if (c.status === 'CLOSED') {
      const metDeadline = c.closedAt && new Date(c.closedAt) <= new Date(c.tatDeadline);
      return { ...c, slaStatus: metDeadline ? 'MET' : 'BREACHED' };
    }
    const pastDeadline = new Date(c.tatDeadline) < new Date();
    return { ...c, slaStatus: pastDeadline ? 'BREACHED' : 'ON_TRACK' };
  });

  res.json({ complaints: complaintsWithSla, stats });
});

// GET /api/customer-360/:id/sam
export const getSamActivity = asyncHandler(async function getSamActivity(req, res) {
  const { id } = req.params;

  const leadExists = await prisma.lead.findUnique({ where: { id }, select: { id: true } });
  if (!leadExists) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  const [assignment, meetings, visits, communications] = await Promise.all([
    prisma.sAMAssignment.findUnique({
      where: { customerId: id },
      select: {
        samExecutive: { select: { id: true, name: true, email: true } },
        assignedBy: { select: { id: true, name: true } },
        assignedAt: true,
        notes: true,
      },
    }),

    prisma.sAMMeeting.findMany({
      where: { customerId: id },
      select: {
        id: true,
        title: true,
        meetingDate: true,
        meetingType: true,
        status: true,
        location: true,
        meetingLink: true,
        attendees: true,
        discussion: true,
        actionItems: true,
        followUpDate: true,
        createdAt: true,
        samExecutive: { select: { id: true, name: true } },
      },
      orderBy: { meetingDate: 'desc' },
    }),

    prisma.sAMVisit.findMany({
      where: { customerId: id },
      select: {
        id: true,
        visitDate: true,
        visitType: true,
        status: true,
        purpose: true,
        location: true,
        outcome: true,
        customerFeedback: true,
        issuesIdentified: true,
        actionRequired: true,
        nextVisitDate: true,
        nextVisitPurpose: true,
        completedAt: true,
        createdAt: true,
        samExecutive: { select: { id: true, name: true } },
      },
      orderBy: { visitDate: 'desc' },
    }),

    prisma.customerCommunication.findMany({
      where: { customerId: id },
      select: {
        id: true,
        communicationType: true,
        channel: true,
        subject: true,
        content: true,
        status: true,
        sentAt: true,
        createdAt: true,
        samExecutive: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({ assignment, meetings, visits, communications });
});

// GET /api/customer-360/:id/feasibility
// Feasibility + Vendor summary: tentative vs actual CAPEX/OPEX, vendor type,
// linked delivery vendor, materials from delivery vendor setup, status.
export const getFeasibility = asyncHandler(async function getFeasibility(req, res) {
  const { id } = req.params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: {
      id: true,
      leadNumber: true,
      status: true,
      // Feasibility stage
      feasibilityVendorType: true,
      tentativeCapex: true,
      tentativeOpex: true,
      feasibilityDescription: true,
      feasibilityNotes: true,
      feasibilityReviewedAt: true,
      feasibilityAssignedTo: { select: { id: true, name: true, email: true } },
      // Delivery stage
      actualCapex: true,
      actualOpex: true,
      deliveryVendorSetupDone: true,
      deliveryProducts: true,
      vendorId: true,
      vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } },
      // POP / from address
      fromAddress: true,
      fromLatitude: true,
      fromLongitude: true,
    },
  });

  if (!lead) {
    return res.status(404).json({ message: 'Lead not found.' });
  }

  // Legacy support: if new columns are empty but old feasibilityNotes JSON has data,
  // parse it and extract tentative vendor info.
  let legacy = null;
  if (!lead.feasibilityVendorType && lead.feasibilityNotes) {
    try {
      const parsed = typeof lead.feasibilityNotes === 'string' ? JSON.parse(lead.feasibilityNotes) : lead.feasibilityNotes;
      if (parsed?.vendorType) {
        legacy = {
          vendorType: parsed.vendorType,
          capex: parsed.vendorDetails?.capex || null,
          opex: parsed.vendorDetails?.opex || null,
        };
      }
    } catch {}
  }

  // Pull materials from delivery vendor setup
  const dp = lead.deliveryProducts && typeof lead.deliveryProducts === 'object' ? lead.deliveryProducts : {};
  const materials = Array.isArray(dp.materials) ? dp.materials : [];
  const vendorTypeData = dp.vendorType || null;
  const fiberDetails = dp.fiberRequired || dp.perMtrCost ? {
    fiberRequired: dp.fiberRequired || null,
    perMtrCost: dp.perMtrCost || null,
    fiberAmount: dp.fiberAmount || null,
  } : null;

  // Determine status
  let status = 'PENDING';
  if (lead.feasibilityReviewedAt && lead.feasibilityVendorType) {
    status = lead.deliveryVendorSetupDone ? 'COMPLETED' : 'FEASIBILITY_DONE';
  } else if (lead.feasibilityReviewedAt) {
    status = 'FEASIBILITY_DONE';
  }

  res.json({
    status,
    // Feasibility estimates
    feasibility: {
      vendorType: lead.feasibilityVendorType || legacy?.vendorType || null,
      tentativeCapex: lead.tentativeCapex != null ? lead.tentativeCapex : (legacy?.capex ?? null),
      tentativeOpex: lead.tentativeOpex != null ? lead.tentativeOpex : (legacy?.opex ?? null),
      description: lead.feasibilityDescription || null,
      reviewedAt: lead.feasibilityReviewedAt,
      reviewedBy: lead.feasibilityAssignedTo,
      popLocation: lead.fromAddress,
      popLatitude: lead.fromLatitude,
      popLongitude: lead.fromLongitude,
    },
    // Delivery actuals
    delivery: {
      setupDone: lead.deliveryVendorSetupDone,
      actualCapex: lead.actualCapex,
      actualOpex: lead.actualOpex,
      vendor: lead.vendor,
      vendorType: vendorTypeData,
      materials,
      fiberDetails,
    },
  });
});
