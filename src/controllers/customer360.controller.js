import prisma from '../config/db.js';
import * as XLSX from 'xlsx';
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

// GET /api/customer-360/export?q=term
// Streams an XLSX file containing every customer matching the search (no
// pagination). Uses the same search filter shape as /search so the exported
// rows match what the UI is currently showing.
export const exportCustomers = asyncHandler(async function exportCustomers(req, res) {
  const { q = '', dateFrom, dateTo, leadId } = req.query;
  const searchTerm = q.trim();

  // Three filter shapes, in priority order:
  //   1. leadId        → single-customer export (ignores other filters)
  //   2. dateFrom/dateTo → range export (filter by Lead.createdAt)
  //   3. q (search)    → matches what the UI is currently showing
  let where = {};
  if (leadId) {
    where = { id: leadId };
  } else {
    const createdAtFilter = {};
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!isNaN(from.getTime())) createdAtFilter.gte = from;
    }
    if (dateTo) {
      // Treat dateTo as end-of-day inclusive so "2026-04-20 → 2026-04-21"
      // captures the full 21st, not just midnight.
      const to = new Date(dateTo);
      if (!isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        createdAtFilter.lte = to;
      }
    }
    if (Object.keys(createdAtFilter).length > 0) {
      where.createdAt = createdAtFilter;
    }
    if (searchTerm.length >= 2) {
      where.OR = buildSearchFilter(searchTerm, [
        'campaignData.company',
        'campaignData.name',
        'campaignData.firstName',
        'campaignData.lastName',
        { field: 'campaignData.phone' },
        'customerUsername',
        'customerGstNo',
      ]);
    }
  }

  const leads = await prisma.lead.findMany({
    where,
    select: {
      id: true,
      leadNumber: true,
      status: true,
      deliveryStatus: true,
      customerUsername: true,
      customerGstNo: true,
      circuitId: true,
      customerIpAssigned: true,
      billingAddress: true,
      billingPincode: true,
      fullAddress: true,
      arcAmount: true,
      otcAmount: true,
      advanceAmount: true,
      // BDM-entered requirement fields
      bandwidthRequirement: true,
      numberOfIPs: true,
      // CAPEX / OPEX — prefer actuals (from delivery) and fall back to the
      // feasibility tentative when the delivery hasn't filled the actuals yet.
      tentativeCapex: true,
      tentativeOpex: true,
      actualCapex: true,
      actualOpex: true,
      // OTC status derivation
      otcInvoiceId: true,
      otcInvoiceGeneratedAt: true,
      advancePayments: { select: { amount: true } },
      // Plan
      actualPlanName: true,
      actualPlanBandwidth: true,
      actualPlanPrice: true,
      actualPlanBillingCycle: true,
      actualPlanIsActive: true,
      actualPlanStartDate: true,
      actualPlanEndDate: true,
      // Demo plan
      demoPlanName: true,
      demoPlanIsActive: true,
      // Timestamps
      createdAt: true,
      feasibilityReviewedAt: true,
      opsApprovedAt: true,
      superAdmin2ApprovedAt: true,
      docsVerifiedAt: true,
      accountsVerifiedAt: true,
      customerCreatedAt: true,
      installationCompletedAt: true,
      customerAcceptanceAt: true,
      actualPlanCreatedAt: true,
      // Relations
      assignedTo: { select: { name: true, role: true } },
      feasibilityAssignedTo: { select: { name: true } },
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
          industry: true,
          title: true,
          campaign: { select: { name: true, type: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Pull OTC invoice status in one shot (avoids N+1). Only for leads that have
  // an otcInvoiceId — many won't.
  const otcInvoiceIds = leads.map((l) => l.otcInvoiceId).filter(Boolean);
  const otcInvoiceMap = new Map();
  if (otcInvoiceIds.length > 0) {
    const otcInvoices = await prisma.invoice.findMany({
      where: { id: { in: otcInvoiceIds } },
      select: { id: true, status: true },
    });
    otcInvoices.forEach((inv) => otcInvoiceMap.set(inv.id, inv.status));
  }

  // Format a Date/null consistently as ISO date string for Excel readability
  const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '');

  // OTC payment state — 3 levels:
  //   'Paid in Advance' → advance payments exist (paid before OTC invoice)
  //   'Paid'            → OTC invoice exists and is fully paid
  //   'Unpaid'          → neither (OTC still owing)
  const otcStatusFor = (l) => {
    const otc = Number(l.otcAmount || 0);
    if (otc === 0) return 'N/A';
    const advanceTotal = (l.advancePayments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    if (advanceTotal > 0) return 'Paid in Advance';
    const invStatus = l.otcInvoiceId ? otcInvoiceMap.get(l.otcInvoiceId) : null;
    if (invStatus === 'PAID') return 'Paid';
    return 'Unpaid';
  };

  // Flatten each lead into a single row. Ordering: identity columns first
  // (Lead#, company, contact, phone, email), then BDM-entered commercials
  // (bandwidth, IPs, ARC, OTC, OTC status, CAPEX, OPEX) as the user
  // requested, then the rest of the lifecycle fields.
  const rows = leads.map((l) => {
    const cd = l.campaignData || {};
    const contact = cd.name || `${cd.firstName || ''} ${cd.lastName || ''}`.trim();
    const capex = l.actualCapex ?? l.tentativeCapex ?? '';
    const opex  = l.actualOpex  ?? l.tentativeOpex  ?? '';
    return {
      'Lead #': l.leadNumber || '',
      'Company': cd.company || '',
      'Contact Name': contact,
      'Title': cd.title || '',
      'Phone': cd.phone || '',
      'Email': cd.email || '',
      // New commercial columns — placed right after contact info per spec.
      'Bandwidth (BDM)': l.bandwidthRequirement || '',
      'No. of IPs (BDM)': l.numberOfIPs ?? '',
      'ARC': l.arcAmount ?? '',
      'OTC': l.otcAmount ?? '',
      'OTC Status': otcStatusFor(l),
      'CAPEX': capex,
      'OPEX': opex,
      // Remaining columns
      'City': cd.city || '',
      'State': cd.state || '',
      'Industry': cd.industry || '',
      'Full Address': l.fullAddress || '',
      'Billing Address': l.billingAddress || '',
      'Billing Pincode': l.billingPincode || '',
      'GST No': l.customerGstNo || '',
      'Customer Username': l.customerUsername || '',
      'Circuit ID': l.circuitId || '',
      'IP Assigned': l.customerIpAssigned || '',
      'Source Campaign': cd.campaign?.name || '',
      'Source Type': cd.campaign?.type || '',
      'Assigned BDM': l.assignedTo?.name || '',
      'BDM Role': l.assignedTo?.role || '',
      'Feasibility Team Member': l.feasibilityAssignedTo?.name || '',
      'Lead Status': l.status || '',
      'Delivery Status': l.deliveryStatus || '',
      'Plan Name': l.actualPlanName || '',
      'Plan Bandwidth (Mbps)': l.actualPlanBandwidth || '',
      'Plan Price': l.actualPlanPrice || '',
      'Billing Cycle': l.actualPlanBillingCycle || '',
      'Plan Active': l.actualPlanIsActive ? 'Yes' : 'No',
      'Plan Start': fmt(l.actualPlanStartDate),
      'Plan End': fmt(l.actualPlanEndDate),
      'Demo Plan': l.demoPlanName || '',
      'Demo Active': l.demoPlanIsActive ? 'Yes' : 'No',
      'Advance Amount': l.advanceAmount ?? '',
      'Lead Created': fmt(l.createdAt),
      'Feasibility Reviewed': fmt(l.feasibilityReviewedAt),
      'OPS Approved': fmt(l.opsApprovedAt),
      'Sales Director Approved': fmt(l.superAdmin2ApprovedAt),
      'Docs Verified': fmt(l.docsVerifiedAt),
      'Accounts Verified': fmt(l.accountsVerifiedAt),
      'Customer Account Created': fmt(l.customerCreatedAt),
      'Installation Completed': fmt(l.installationCompletedAt),
      'Customer Acceptance': fmt(l.customerAcceptanceAt),
      'Actual Plan Activated': fmt(l.actualPlanCreatedAt),
    };
  });

  // Build workbook
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ Note: 'No customers matched the current filter' }]);

  // Auto-size columns based on header length (reasonable default)
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    ws['!cols'] = headers.map((h) => {
      const maxContent = rows.reduce((m, r) => Math.max(m, String(r[h] ?? '').length), h.length);
      return { wch: Math.min(Math.max(maxContent + 2, 10), 40) };
    });
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Customers');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  // Filename reflects the export mode — makes downloads self-describing
  // without the user having to remember which filters they had set.
  let filename = `customer-360-export-${new Date().toISOString().slice(0, 10)}`;
  if (leadId && leads[0]) {
    const co = (leads[0].campaignData?.company || leads[0].leadNumber || 'single')
      .replace(/[^a-z0-9]+/gi, '-').slice(0, 40).toLowerCase();
    filename = `customer-360-${co}-${new Date().toISOString().slice(0, 10)}`;
  } else if (dateFrom || dateTo) {
    const f = dateFrom ? String(dateFrom).slice(0, 10) : 'start';
    const t = dateTo ? String(dateTo).slice(0, 10) : 'today';
    filename = `customer-360-export-${f}_to_${t}`;
  }
  filename += '.xlsx';
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('X-Total-Count', String(rows.length));
  res.send(buffer);
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
      isColdLead: true,
      creationSource: true,
      installationStartedById: true,
      installationCompletedById: true,
      installationStartedBy:   { select: { id: true, name: true, role: true } },
      installationCompletedBy: { select: { id: true, name: true, role: true } },
      quotationAttachments: true,
      documents: true,
      loginCompletedAt: true,
      loginCompletedById: true,
      // Feasibility review outcome
      feasibilityVendorType: true,
      tentativeCapex: true,
      tentativeOpex: true,
      // Delivery vendor setup (JSON contains setupAt/setupById)
      deliveryProducts: true,
      deliveryVendorSetupDone: true,
      actualCapex: true,
      actualOpex: true,
      // NOC assignment (before NOC configures)
      nocAssignedAt: true,
      nocAssignedToId: true,
      // Installation milestones
      installationStartedAt: true,
      installationCompletedAt: true,
      customerAcceptanceNotes: true,
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
      // Quote / approval flow
      opsApprovedBy: { select: { id: true, name: true, role: true } },
      opsApprovedAt: true,
      opsApprovalStatus: true,
      opsRejectedReason: true,
      superAdmin2ApprovalStatus: true,
      superAdmin2ApprovedAt: true,
      superAdmin2ApprovedBy: { select: { id: true, name: true, role: true } },
      superAdmin2RejectedReason: true,
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
          isSelfGenerated: true,
          createdBy: { select: { id: true, name: true, role: true } },
          assignedToId: true,
          // campaign.createdBy attributes who uploaded the campaign itself —
          // needed for BULK_UPLOAD_BDM vs BULK_UPLOAD_ADMIN attribution in
          // the journey's opening event.
          campaign: {
            select: {
              id: true, name: true, type: true, code: true,
              createdBy: { select: { id: true, name: true, role: true } },
            },
          },
        },
      },
    },
  });

  if (!lead) {
    return res.status(404).json({ message: 'Customer not found.' });
  }

  // Fetch all timeline-relevant auxiliary data in parallel. Every addition
  // stays within a single Promise.all round-trip — avoids staircase latency.
  const [
    callLogs, isrUser, docsVerifiedByUser, deliveryRequests, statusChangeLogs,
    uploadLinks, loginCompletedByUser, nocAssignedByUser, vendorSetupByUser,
    samAssignment, firstInvoice, firstPayment,
  ] = await Promise.all([
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
          // Bound — a single lead with thousands of historic call logs would
          // blow up memory + latency. 500 covers every realistic case.
          take: 500,
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
        superAdminApprovedBy: { select: { id: true, name: true, role: true } },
        superAdminApprovedAt: true,
        superAdminRejectedBy: { select: { id: true, name: true, role: true } },
        superAdminRejectedAt: true,
        superAdminRejectionReason: true,
        areaHeadApprovedBy: { select: { id: true, name: true, role: true } },
        areaHeadApprovedAt: true,
        areaHeadRejectedBy: { select: { id: true, name: true, role: true } },
        areaHeadRejectedAt: true,
        areaHeadRejectionReason: true,
        assignedToStoreManager: { select: { id: true, name: true, role: true } },
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
      orderBy: { changedAt: 'desc' },
      // Bound — a very active lead could accumulate hundreds of status-change
      // rows. Show the most recent 500 on the journey; the full history can
      // be exposed on a dedicated audit page if ever needed.
      take: 500,
    }),
    // Document upload links created by BDM for the customer to upload docs
    prisma.documentUploadLink.findMany({
      where: { leadId: id },
      select: {
        id: true,
        createdAt: true,
        lastAccessedAt: true,
        accessCount: true,
        requiredDocuments: true,
        createdBy: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    lead?.loginCompletedById
      ? prisma.user.findUnique({
          where: { id: lead.loginCompletedById },
          select: { id: true, name: true, role: true },
        })
      : null,
    lead?.nocAssignedToId
      ? prisma.user.findUnique({
          where: { id: lead.nocAssignedToId },
          select: { id: true, name: true, role: true },
        })
      : null,
    // Vendor setup user id is buried in deliveryProducts JSON (setupById).
    lead?.deliveryProducts && typeof lead.deliveryProducts === 'object' && lead.deliveryProducts.setupById
      ? prisma.user.findUnique({
          where: { id: lead.deliveryProducts.setupById },
          select: { id: true, name: true, role: true },
        })
      : null,
    // Post-activation events — SAM, first invoice, first payment. Each
    // returns null if absent, so the timeline skips the row cleanly.
    // SAMAssignment uses customerId (=leadId) and has only one row per customer.
    prisma.sAMAssignment.findUnique({
      where: { customerId: id },
      select: {
        id: true, assignedAt: true,
        samExecutive: { select: { id: true, name: true, role: true } },
        assignedBy:   { select: { id: true, name: true, role: true } },
      },
    }),
    prisma.invoice.findFirst({
      where: { leadId: id },
      select: { id: true, invoiceNumber: true, invoiceDate: true, grandTotal: true },
      orderBy: { invoiceDate: 'asc' },
    }),
    prisma.invoicePayment.findFirst({
      where: { invoice: { leadId: id } },
      select: {
        id: true, amount: true, paymentDate: true, paymentMode: true,
        createdBy: { select: { id: true, name: true, role: true } },
      },
      orderBy: { paymentDate: 'asc' },
    }),
  ]);

  // ─── Detect lead origin ─────────────────────────────────────────────
  // creationSource is set once at creation by the spawning controller —
  // createDirectLead, createOpportunity, convertToLead, etc. No more
  // fragile inference (which mis-identified Add Lead as Create Opportunity
  // because both set isSelfGenerated=true).
  const ORIGIN_LABELS = {
    BULK_UPLOAD_BDM:   { label: 'Campaign → ISR (BDM-Uploaded Data)',   description: 'A BDM/Team Leader uploaded this contact into a campaign. ISR called them and converted to a lead.' },
    BULK_UPLOAD_ADMIN: { label: 'Campaign → ISR (Admin-Uploaded Data)', description: 'An admin uploaded this contact into a campaign. ISR called them and converted to a lead.' },
    ISR_SELF_DATA:     { label: 'ISR Self-Sourced Data',                description: 'An ISR added their own contact, called them, and converted to a lead.' },
    BDM_DIRECT_LEAD:   { label: 'Direct Lead (Add Lead button)',        description: "BDM added this lead via the 'Add Lead' button on the New Lead Assigned page. Goes through BDM qualification before Feasibility." },
    BDM_OPPORTUNITY:   { label: 'Opportunity (Created by BDM)',         description: "BDM used 'Create Opportunity' — qualification was skipped and the lead was sent straight to the Feasibility Team." },
    COLD_LEAD:         { label: 'Cold Lead',                             description: 'Cold lead added by a BDM after a lukewarm meeting. Needs completion before moving forward.' },
    SAM_REFERRAL:      { label: 'SAM Referral',                          description: 'Existing customer referred a new opportunity through the SAM team.' },
    UNKNOWN:           { label: 'Legacy Lead',                            description: "This lead predates the origin-tracking system. Best-effort attribution below." },
  };
  const leadOrigin = lead.creationSource || 'UNKNOWN';
  const leadOriginLabel = ORIGIN_LABELS[leadOrigin]?.label || leadOrigin;
  const leadOriginDescription = ORIGIN_LABELS[leadOrigin]?.description || '';
  // ISR-phase stages render only when the pipeline actually went through ISR.
  const showISRStages = ['BULK_UPLOAD_BDM', 'BULK_UPLOAD_ADMIN', 'ISR_SELF_DATA'].includes(leadOrigin);

  // Build timeline events from lead fields
  const timeline = [];

  // StatusChangeLog field-presence lookup — used throughout to skip
  // field-derived rows when the audit log has a richer entry for the same
  // event. Declared up-front so both the opening (cold-lead) block and the
  // later rejection blocks can reference it.
  const auditFieldsSeen = new Set(statusChangeLogs.map((l) => l.field));

  // ─── Origin-specific opening events ─────────────────────────────────
  // Each origin renders a distinct opening sequence. The 3 ISR-flow origins
  // (BULK_UPLOAD_BDM/ADMIN, ISR_SELF_DATA) share the Data → ISR Assigned →
  // ISR Calls → Lead Converted arc; they differ only in who the "uploader"
  // is on the opening event.
  if (showISRStages) {
    const campaignName = lead.campaignData?.campaign?.name;
    // Attribute the DATA_UPLOADED event to the correct human based on origin.
    // For BULK_UPLOAD_*, the campaign.createdBy is the uploader (one campaign,
    // many contacts). For ISR_SELF_DATA, it's the ISR on the campaignData row.
    const uploader =
      leadOrigin === 'ISR_SELF_DATA'
        ? lead.campaignData?.createdBy
        : (lead.campaignData?.campaign?.createdBy || lead.campaignData?.createdBy);

    const uploaderLabel =
      leadOrigin === 'BULK_UPLOAD_BDM'
        ? `BDM/Team Leader uploaded this contact into campaign "${campaignName || '—'}".`
        : leadOrigin === 'BULK_UPLOAD_ADMIN'
        ? `Admin uploaded this contact into campaign "${campaignName || '—'}".`
        : `ISR added this contact themselves${campaignName ? ` (campaign "${campaignName}")` : ''}.`;

    // When a BDM self-assigns a BULK_UPLOAD_BDM campaign, they end up being
    // the "ISR" for that row too — the pipeline uses the ISR slot, but the
    // human is a BDM. Re-label so the journey doesn't keep saying "ISR …"
    // for work the BDM actually did.
    const bdmRoles = new Set(['BDM', 'BDM_TEAM_LEADER']);
    const callingRole = (u) => (u && bdmRoles.has(u.role) ? 'BDM' : 'ISR');
    const isrSlotRole = callingRole(isrUser);
    const converterRole = callingRole(lead.createdBy);

    if (lead.campaignData) {
      timeline.push({
        stage: 'DATA_UPLOADED',
        label: leadOrigin === 'ISR_SELF_DATA' ? 'ISR Added Contact' : 'Contact Added to Campaign',
        timestamp: lead.campaignData.createdAt,
        user: uploader,
        details: uploaderLabel,
      });
    }
    if (isrUser) {
      const assignedLabel =
        leadOrigin === 'ISR_SELF_DATA'
          ? (isrSlotRole === 'BDM' ? 'BDM Calling Phase' : 'ISR Calling Phase')
          : (isrSlotRole === 'BDM' ? 'Assigned to BDM for Calling' : 'Assigned to ISR for Calling');
      const assignedDetails =
        isrSlotRole === 'BDM'
          ? 'BDM will call this contact and decide whether to convert to a lead.'
          : leadOrigin === 'ISR_SELF_DATA'
          ? 'ISR will call and decide whether to convert.'
          : 'ISR will call this contact and decide whether to convert to a lead.';
      timeline.push({
        stage: 'ISR_ASSIGNED',
        label: assignedLabel,
        timestamp: lead.campaignData?.createdAt,
        user: isrUser,
        details: assignedDetails,
      });
    }
    callLogs.forEach((log, index) => {
      const callerRole = callingRole(log.user);
      timeline.push({
        stage: 'ISR_CALL',
        label: `${callerRole} Call #${index + 1}`,
        timestamp: log.startTime,
        user: log.user,
        details: `Disposition: ${log.status}${log.duration ? ` · Duration: ${log.duration}s` : ''}${log.notes ? ` · Note: ${log.notes}` : ''}`,
        meta: { duration: log.duration, status: log.status, notes: log.notes },
      });
    });
    timeline.push({
      stage: 'LEAD_CREATED',
      label: `Lead Converted by ${converterRole}`,
      timestamp: lead.createdAt,
      user: lead.createdBy,
      details:
        converterRole === 'BDM'
          ? 'BDM marked this contact as interested and converted it into a qualified lead.'
          : 'ISR marked this contact as interested and converted it into a qualified lead.',
    });
    if (lead.assignedTo) {
      timeline.push({
        stage: 'BDM_ASSIGNED',
        label: 'Assigned to BDM for Qualification',
        timestamp: lead.createdAt,
        user: lead.assignedTo,
        details: `BDM will qualify the lead and push it to Feasibility.${lead.assignedTo.teamLeader ? ` Team Leader: ${lead.assignedTo.teamLeader.name}` : ''}`,
        meta: { teamLeader: lead.assignedTo.teamLeader },
      });
    }
  } else if (leadOrigin === 'BDM_OPPORTUNITY') {
    timeline.push({
      stage: 'OPPORTUNITY_CREATED',
      label: 'Opportunity Created',
      timestamp: lead.createdAt,
      user: lead.createdBy || lead.assignedTo,
      details: "BDM used 'Create Opportunity' — qualification skipped, sent straight to Feasibility.",
    });
    if (lead.assignedTo && (!lead.createdBy || lead.assignedTo.id !== lead.createdBy.id)) {
      timeline.push({
        stage: 'BDM_ASSIGNED',
        label: 'BDM Assigned',
        timestamp: lead.createdAt,
        user: lead.assignedTo,
        details: lead.assignedTo.teamLeader ? `Team Leader: ${lead.assignedTo.teamLeader.name}` : null,
        meta: { teamLeader: lead.assignedTo.teamLeader },
      });
    }
  } else if (leadOrigin === 'BDM_DIRECT_LEAD') {
    timeline.push({
      stage: 'LEAD_CREATED',
      label: 'Lead Added by BDM',
      timestamp: lead.createdAt,
      user: lead.createdBy || lead.assignedTo,
      details: "BDM added this lead via the 'Add Lead' button on the New Lead Assigned page.",
    });
    if (lead.assignedTo && (!lead.createdBy || lead.assignedTo.id !== lead.createdBy.id)) {
      timeline.push({
        stage: 'BDM_ASSIGNED',
        label: 'BDM Assigned',
        timestamp: lead.createdAt,
        user: lead.assignedTo,
        meta: { teamLeader: lead.assignedTo.teamLeader },
      });
    }
  } else if (leadOrigin === 'SAM_REFERRAL') {
    timeline.push({
      stage: 'LEAD_CREATED',
      label: 'Referred via SAM',
      timestamp: lead.createdAt,
      user: lead.createdBy || lead.assignedTo,
      details: 'An existing customer referred a new opportunity through the SAM team.',
    });
    if (lead.assignedTo) {
      timeline.push({
        stage: 'BDM_ASSIGNED',
        label: 'Assigned to BDM',
        timestamp: lead.createdAt,
        user: lead.assignedTo,
        meta: { teamLeader: lead.assignedTo.teamLeader },
      });
    }
  } else {
    // UNKNOWN / legacy fallback
    timeline.push({
      stage: 'LEAD_CREATED',
      label: 'Lead Created',
      timestamp: lead.createdAt,
      user: lead.createdBy || lead.assignedTo,
      details: 'Lead created before origin tracking was introduced — source inferred.',
    });
    if (lead.assignedTo) {
      timeline.push({
        stage: 'BDM_ASSIGNED',
        label: 'BDM Assigned',
        timestamp: lead.createdAt,
        user: lead.assignedTo,
      });
    }
  }

  // Cold-lead state is orthogonal to origin — a lead from any origin can be
  // parked as cold. When Phase B audit logging is present, the audit block
  // below renders this with the correct parked-at timestamp; the
  // field-derived row is a legacy fallback for cold leads parked before
  // logging was introduced.
  if (lead.isColdLead && !auditFieldsSeen.has('coldLeadParked')) {
    timeline.push({
      stage: 'COLD_LEAD_PARKED',
      label: 'Parked as Cold Lead',
      timestamp: lead.createdAt,
      user: lead.assignedTo,
      details: 'BDM parked this lead as cold after a lukewarm meeting — needs completion to move forward.',
    });
  }

  if (lead.feasibilityAssignedTo) {
    timeline.push({
      stage: 'FEASIBILITY_ASSIGNED',
      label: 'Assigned to Feasibility Team',
      timestamp: lead.createdAt,
      user: lead.feasibilityAssignedTo,
      details: 'Feasibility team will check if service can be delivered at this location.',
      meta: { notes: lead.feasibilityNotes },
    });
  }

  // (auditFieldsSeen declared earlier, near the top of the timeline build)

  // Feasibility review outcome — approval vs rejection (legacy path only)
  if (lead.feasibilityReviewedAt && !auditFieldsSeen.has('feasibilityReview')) {
    const isFeasible = !!lead.feasibilityVendorType; // vendor chosen = feasible
    timeline.push({
      stage: isFeasible ? 'FEASIBILITY_APPROVED' : 'FEASIBILITY_REJECTED',
      label: isFeasible ? 'Feasibility Approved' : 'Feasibility Rejected',
      timestamp: lead.feasibilityReviewedAt,
      user: lead.feasibilityAssignedTo,
      details: isFeasible
        ? `Vendor type: ${lead.feasibilityVendorType}${lead.tentativeCapex ? ` · Tentative CAPEX: ₹${lead.tentativeCapex}` : ''}${lead.tentativeOpex ? ` · Tentative OPEX: ₹${lead.tentativeOpex}` : ''}`
        : (lead.feasibilityNotes || 'Site is not serviceable.'),
      isError: !isFeasible,
      meta: { notes: lead.feasibilityNotes },
    });
  } else if (lead.feasibilityReviewedAt && lead.feasibilityVendorType && auditFieldsSeen.has('feasibilityReview')) {
    // Even when audit log covers decisions, enrich the FEASIBILITY_APPROVED
    // row with vendor-type + capex detail that's not in the log reason.
    // No-op here — audit row stands. If we need richer detail later, we can
    // merge meta fields. Keeping as comment so future readers know why.
  }

  // ─── Quote / Quotation phase ──────────────────────────────────────
  // We split into separate events for clarity:
  //   1. Quote Uploaded       — when BDM first attached the quotation file
  //   2. Quote Submitted      — when BDM submitted for Sales Director approval
  //   3. Sales Director decision
  //   4. (implicit) Quote shared with customer — covered in details of the approval
  const quotationUploaded = !!lead.quotationAttachments && (
    Array.isArray(lead.quotationAttachments) ? lead.quotationAttachments.length > 0 : true
  );

  // Prefer the StatusChangeLog entry (precise) when available; fall back to
  // opsApprovedAt minus a small offset so it shows before the submit event.
  const quoteUploadedLog = statusChangeLogs.find((l) => l.field === 'quotationUploaded');
  const quoteSubmittedLog = statusChangeLogs.find((l) => l.field === 'quotationSubmitted');

  // Flows vary on whether OPS approval happens first (legacy) or the lead
  // goes straight to Sales Director. Earlier we gated both rows on
  // lead.opsApprovedAt, which silently hid the whole quotation block for
  // the direct-to-SA2 path. Use whichever timestamp we have, in priority
  // order: explicit submit/upload log → OPS approval → SA2 approval.
  if (quotationUploaded) {
    const ts = quoteUploadedLog?.changedAt
      || quoteSubmittedLog?.changedAt
      || lead.opsApprovedAt
      || lead.superAdmin2ApprovedAt;
    if (ts) {
      timeline.push({
        stage: 'QUOTATION_UPLOADED',
        label: 'Quotation Uploaded',
        timestamp: ts,
        user: quoteUploadedLog?.changedBy || lead.opsApprovedBy || lead.assignedTo,
        details: 'BDM uploaded the quotation with pricing and terms.',
      });
    }
  }

  if (quotationUploaded && (quoteSubmittedLog || lead.opsApprovedAt || lead.superAdmin2ApprovedAt)) {
    const ts = quoteSubmittedLog?.changedAt || lead.opsApprovedAt || lead.superAdmin2ApprovedAt;
    timeline.push({
      stage: 'QUOTATION_SUBMITTED',
      label: 'Quotation Submitted for Approval',
      timestamp: ts,
      user: quoteSubmittedLog?.changedBy || lead.opsApprovedBy || lead.assignedTo,
      details: 'Submitted to Sales Director for approval.',
    });
  }

  // Legacy SA2 approval renderer — skipped when audit log has decisions
  const sa2InAudit = auditFieldsSeen.has('superAdmin2ApprovalStatus');
  if (lead.superAdmin2ApprovalStatus === 'APPROVED' && lead.superAdmin2ApprovedAt) {
    if (!sa2InAudit) {
      timeline.push({
        stage: 'SALES_DIRECTOR_APPROVED',
        label: 'Sales Director Approved Quotation',
        timestamp: lead.superAdmin2ApprovedAt,
        user: lead.superAdmin2ApprovedBy,
        details: 'Quotation approved — BDM can now share it with the customer and request documents.',
      });
    }
    // Quote-shared milestone is derived, not an audit event — always render.
    timeline.push({
      stage: 'QUOTE_SHARED',
      label: 'Quote Shared with Customer',
      timestamp: new Date(new Date(lead.superAdmin2ApprovedAt).getTime() + 60 * 1000),
      user: lead.assignedTo,
      details: 'BDM shared the approved quotation with the customer (offline/email). Customer document collection begins next.',
    });
  } else if (lead.superAdmin2ApprovalStatus === 'REJECTED' && lead.superAdmin2ApprovedAt && !sa2InAudit) {
    timeline.push({
      stage: 'SALES_DIRECTOR_REJECTED',
      label: 'Sales Director Rejected Quotation',
      timestamp: lead.superAdmin2ApprovedAt,
      user: lead.superAdmin2ApprovedBy,
      details: lead.superAdmin2RejectedReason || 'Quotation was rejected.',
      isError: true,
    });
  }
  if (lead.opsApprovalStatus === 'REJECTED' && lead.opsApprovedAt && !auditFieldsSeen.has('opsApprovalStatus')) {
    timeline.push({
      stage: 'OPS_REJECTED',
      label: 'OPS Rejected',
      timestamp: lead.opsApprovedAt,
      user: lead.opsApprovedBy,
      details: lead.opsRejectedReason || 'OPS rejected the lead.',
      isError: true,
    });
  }

  // ─── Document collection phase ────────────────────────────────────
  // Upload link generated by BDM for the customer to self-upload docs
  uploadLinks.forEach((link, idx) => {
    timeline.push({
      stage: 'DOCS_UPLOAD_LINK',
      label: uploadLinks.length > 1 ? `Document Upload Link Sent · #${idx + 1}` : 'Document Upload Link Sent',
      timestamp: link.createdAt,
      user: link.createdBy,
      details: `BDM generated a secure upload link for the customer${link.requiredDocuments?.length ? ` (${link.requiredDocuments.length} document types requested)` : ''}.`,
    });
  });

  // Login-completed step — who actually signed in determines the label.
  // When the BDM marks it on behalf of the customer (common when the BDM
  // walks them through it), the actor is a staff user, not the customer.
  if (lead.loginCompletedAt) {
    const loginRole = loginCompletedByUser?.role;
    const loginByBdm = loginRole === 'BDM' || loginRole === 'BDM_TEAM_LEADER';
    timeline.push({
      stage: 'LOGIN_COMPLETED',
      label: loginByBdm ? 'Login Completed by BDM' : 'Customer Completed Login',
      timestamp: lead.loginCompletedAt,
      user: loginCompletedByUser,
      details: loginByBdm
        ? 'BDM marked the customer login step complete on their behalf.'
        : 'Customer signed in to begin document upload.',
    });
  }

  // Document uploads can come from two sources: staff uploads via the
  // BDM dashboard (each doc tagged with uploadedBy: <userId>) and customer
  // uploads via a public token link (tagged with uploadedBy: 'customer').
  // Inspect the uploadedBy values to label accurately.
  if (lead.documents && typeof lead.documents === 'object' && !Array.isArray(lead.documents)) {
    const docEntries = Object.entries(lead.documents);
    const uploadedAts = docEntries
      .map(([, v]) => (v && typeof v === 'object' && v.uploadedAt) ? new Date(v.uploadedAt) : null)
      .filter(Boolean);
    if (uploadedAts.length > 0) {
      const uploaders = docEntries
        .map(([, v]) => (v && typeof v === 'object') ? v.uploadedBy : null)
        .filter((u) => u !== undefined && u !== null);
      const hasCustomerUpload = uploaders.some((u) => u === 'customer');
      const hasStaffUpload = uploaders.some((u) => u && u !== 'customer');
      let docsLabel;
      let docsDetails;
      if (hasCustomerUpload && !hasStaffUpload) {
        docsLabel = 'Documents Uploaded by Customer';
        docsDetails = `Customer uploaded ${docEntries.length} document${docEntries.length === 1 ? '' : 's'}. Docs team can now verify them.`;
      } else if (hasStaffUpload && !hasCustomerUpload) {
        docsLabel = 'Documents Uploaded by BDM';
        docsDetails = `BDM uploaded ${docEntries.length} document${docEntries.length === 1 ? '' : 's'}. Docs team can now verify them.`;
      } else {
        docsLabel = 'Documents Uploaded';
        docsDetails = `${docEntries.length} document${docEntries.length === 1 ? '' : 's'} uploaded (mix of customer and BDM). Docs team can now verify them.`;
      }
      const earliest = new Date(Math.min(...uploadedAts.map((d) => d.getTime())));
      timeline.push({
        stage: 'DOCS_UPLOADED',
        label: docsLabel,
        timestamp: earliest,
        user: null,
        details: docsDetails,
      });
    }
  }

  // Docs legacy renderer — skipped when audit log has any docsStatus entries
  if (lead.docsVerifiedById && !auditFieldsSeen.has('docsStatus')) {
    timeline.push({
      stage: 'DOCS_VERIFIED',
      label: lead.docsRejectedReason ? 'Docs Rejected' : 'Docs Verified',
      timestamp: lead.docsVerifiedAt,
      user: docsVerifiedByUser,
      details: lead.docsRejectedReason || 'All required documents verified.',
      isError: !!lead.docsRejectedReason,
      meta: { rejectedReason: lead.docsRejectedReason },
    });
  }

  // Accounts legacy renderer — skipped when audit log has accountsStatus entries
  if (lead.accountsVerifiedBy && !auditFieldsSeen.has('accountsStatus')) {
    timeline.push({
      stage: 'ACCOUNTS_VERIFIED',
      label: lead.accountsRejectedReason ? 'Accounts Rejected' : 'Accounts Verified',
      timestamp: lead.accountsVerifiedAt,
      user: lead.accountsVerifiedBy,
      details: lead.accountsRejectedReason || 'Financial/billing details verified.',
      isError: !!lead.accountsRejectedReason,
      meta: { rejectedReason: lead.accountsRejectedReason },
    });
  }

  if (lead.gstVerifiedBy) {
    timeline.push({
      stage: 'GST_VERIFIED',
      label: 'GST Verified',
      timestamp: lead.gstVerifiedAt,
      user: lead.gstVerifiedBy,
      details: 'GST details confirmed.',
    });
  }

  if (lead.pushedToInstallationBy) {
    timeline.push({
      stage: 'PUSHED_TO_INSTALLATION',
      label: 'Pushed to Installation',
      timestamp: lead.pushedToInstallationAt,
      user: lead.pushedToInstallationBy,
      details: 'Lead approved for installation — NOC and Delivery teams take over from here.',
    });
  }

  // NOC assigned (before actual configuration)
  if (lead.nocAssignedAt) {
    timeline.push({
      stage: 'NOC_ASSIGNED',
      label: 'Assigned to NOC Team',
      timestamp: lead.nocAssignedAt,
      user: nocAssignedByUser,
      details: 'NOC team will create the customer account and network config.',
    });
  }

  // Delivery vendor setup (before material request) — timestamp lives inside deliveryProducts JSON
  if (lead.deliveryVendorSetupDone && lead.deliveryProducts && typeof lead.deliveryProducts === 'object') {
    const dp = lead.deliveryProducts;
    const setupAt = dp.setupAt ? new Date(dp.setupAt) : null;
    if (setupAt && !isNaN(setupAt.getTime())) {
      const capexLine = lead.actualCapex ? ` · Actual CAPEX: ₹${lead.actualCapex}` : '';
      const opexLine = lead.actualOpex ? ` · Actual OPEX: ₹${lead.actualOpex}` : '';
      timeline.push({
        stage: 'DELIVERY_VENDOR_SETUP',
        label: 'Delivery Vendor Setup Completed',
        timestamp: setupAt,
        user: vendorSetupByUser,
        details: `Delivery team configured the fiber vendor${dp.vendorNotes ? `: ${dp.vendorNotes}` : ''}.${capexLine}${opexLine}`,
      });
    }
  }

  // ─── Delivery request lifecycle — expanded into granular events ──────
  deliveryRequests.forEach((dr) => {
    timeline.push({
      stage: 'DELIVERY_REQUEST_CREATED',
      label: `Delivery Request Created · ${dr.requestNumber}`,
      timestamp: dr.requestedAt,
      user: dr.requestedBy,
      details: `Request ${dr.requestNumber}: ${dr.items?.length || 0} line item${dr.items?.length === 1 ? '' : 's'} needed for installation.`,
      meta: { requestNumber: dr.requestNumber, items: dr.items },
    });

    if (dr.superAdminApprovedAt) {
      timeline.push({
        stage: 'DELIVERY_SUPER_ADMIN_APPROVED',
        label: 'Super Admin Approved Delivery',
        timestamp: dr.superAdminApprovedAt,
        user: dr.superAdminApprovedBy,
        details: `Approved delivery request ${dr.requestNumber}.`,
      });
    } else if (dr.superAdminRejectedAt) {
      timeline.push({
        stage: 'DELIVERY_SUPER_ADMIN_REJECTED',
        label: 'Super Admin Rejected Delivery',
        timestamp: dr.superAdminRejectedAt,
        user: dr.superAdminRejectedBy,
        details: dr.superAdminRejectionReason || `Rejected delivery request ${dr.requestNumber}.`,
        isError: true,
      });
    }

    if (dr.areaHeadApprovedAt) {
      timeline.push({
        stage: 'DELIVERY_AREA_HEAD_APPROVED',
        label: 'Area Head Approved Delivery',
        timestamp: dr.areaHeadApprovedAt,
        user: dr.areaHeadApprovedBy,
        details: `Regional approval cleared for ${dr.requestNumber}.`,
      });
    } else if (dr.areaHeadRejectedAt) {
      timeline.push({
        stage: 'DELIVERY_AREA_HEAD_REJECTED',
        label: 'Area Head Rejected Delivery',
        timestamp: dr.areaHeadRejectedAt,
        user: dr.areaHeadRejectedBy,
        details: dr.areaHeadRejectionReason || `Rejected delivery request ${dr.requestNumber}.`,
        isError: true,
      });
    }

    if (dr.assignedAt && dr.assignedToStoreManager) {
      timeline.push({
        stage: 'DELIVERY_ASSIGNED_TO_STORE',
        label: 'Assigned to Store Manager',
        timestamp: dr.assignedAt,
        user: dr.assignedToStoreManager,
        details: 'Store manager will pick and pack materials.',
      });
    }

    if (dr.dispatchedAt) {
      timeline.push({
        stage: 'DELIVERY_DISPATCHED',
        label: 'Materials Dispatched',
        timestamp: dr.dispatchedAt,
        user: dr.assignedToStoreManager,
        details: `Materials for ${dr.requestNumber} dispatched to the installation site.`,
      });
    }

    if (dr.completedAt) {
      timeline.push({
        stage: 'DELIVERY_COMPLETED',
        label: 'Delivery Completed',
        timestamp: dr.completedAt,
        user: dr.assignedToStoreManager,
        details: `Request ${dr.requestNumber} marked complete.`,
      });
    }
  });

  if (lead.nocConfiguredBy) {
    timeline.push({
      stage: 'NOC_CONFIGURED',
      label: 'NOC Configured',
      timestamp: lead.nocConfiguredAt,
      user: lead.nocConfiguredBy,
      details: lead.customerUsername ? `Customer username assigned: ${lead.customerUsername}` : 'Network configured.',
      meta: { username: lead.customerUsername },
    });
  }

  // NOC hand-off to Delivery (for install prep). Was on the lead but not rendered before.
  if (lead.nocPushedToDeliveryAt) {
    timeline.push({
      stage: 'NOC_PUSHED_TO_DELIVERY',
      label: 'NOC Pushed to Delivery for Installation',
      timestamp: lead.nocPushedToDeliveryAt,
      user: lead.nocPushedToDeliveryBy,
      details: 'Circuit ID generated. Delivery team takes over for on-site installation.',
    });
  }

  if (lead.customerCreatedBy) {
    timeline.push({
      stage: 'CUSTOMER_CREATED',
      label: 'Customer Account Created',
      timestamp: lead.customerCreatedAt,
      user: lead.customerCreatedBy,
      details: 'Customer can now log in to the portal.',
    });
  }

  if (lead.installationStartedAt) {
    timeline.push({
      stage: 'INSTALLATION_STARTED',
      label: 'Installation Started',
      timestamp: lead.installationStartedAt,
      user: lead.installationStartedBy,
      details: 'On-site installation work began.',
    });
  }

  if (lead.installationCompletedAt) {
    timeline.push({
      stage: 'INSTALLATION_COMPLETED',
      label: 'Installation Completed',
      timestamp: lead.installationCompletedAt,
      user: lead.installationCompletedBy,
      details: 'Connection installed and ready for speed test.',
    });
  }

  if (lead.demoPlanAssignedBy) {
    timeline.push({
      stage: 'DEMO_PLAN',
      label: 'Demo Plan Assigned',
      timestamp: lead.demoPlanAssignedAt,
      user: lead.demoPlanAssignedBy,
      details: lead.demoPlanName ? `Plan: ${lead.demoPlanName}` : null,
    });
  }

  if (lead.speedTestUploadedBy) {
    timeline.push({
      stage: 'SPEED_TEST',
      label: 'Speed Test Uploaded',
      timestamp: lead.speedTestUploadedAt,
      user: lead.speedTestUploadedBy,
      details: 'Bandwidth verified before customer acceptance.',
    });
  }

  // Customer acceptance — the ACCEPTED path always renders from the field;
  // the REJECTED path defers to the audit log when present, else falls back.
  if (lead.customerAcceptanceBy) {
    const accepted = lead.customerAcceptanceStatus === 'ACCEPTED';
    if (accepted || !auditFieldsSeen.has('customerAcceptance')) {
      timeline.push({
        stage: accepted ? 'CUSTOMER_ACCEPTED' : 'CUSTOMER_REJECTED',
        label: accepted ? 'Customer Accepted Service' : `Customer ${lead.customerAcceptanceStatus || 'Rejected'}`,
        timestamp: lead.customerAcceptanceAt,
        user: lead.customerAcceptanceBy,
        details: accepted
          ? 'Customer verified speed test results and accepted the service. Actual plan can now be activated.'
          : (lead.customerAcceptanceNotes || `Customer ${String(lead.customerAcceptanceStatus || 'rejected').toLowerCase()} the service.`),
        isError: !accepted,
        meta: { status: lead.customerAcceptanceStatus },
      });
    }
  }

  if (lead.actualPlanCreatedBy) {
    timeline.push({
      stage: 'ACTUAL_PLAN',
      label: 'Actual Plan Activated',
      timestamp: lead.actualPlanCreatedAt,
      user: lead.actualPlanCreatedBy,
      details: lead.actualPlanName ? `Plan: ${lead.actualPlanName} · Invoicing begins on next billing cycle.` : null,
    });
  }

  // ─── Post-activation events (optional, only render when data exists) ──
  // These close the story of a customer's onboarding — SAM takes over, first
  // invoice issued, first payment received. Missing rows simply don't render.
  if (samAssignment) {
    timeline.push({
      stage: 'SAM_ASSIGNED',
      label: 'SAM Executive Assigned',
      timestamp: samAssignment.assignedAt,
      user: samAssignment.assignedBy,
      details: samAssignment.samExecutive
        ? `${samAssignment.samExecutive.name} will handle post-sale service.`
        : 'SAM Executive assigned for post-sale service.',
      meta: { samExecutive: samAssignment.samExecutive },
    });
  }
  if (firstInvoice) {
    timeline.push({
      stage: 'FIRST_INVOICE',
      label: 'First Invoice Generated',
      timestamp: firstInvoice.invoiceDate,
      user: null,
      details: `${firstInvoice.invoiceNumber} · ₹${Number(firstInvoice.grandTotal || 0).toFixed(2)}`,
      meta: { invoiceNumber: firstInvoice.invoiceNumber, amount: firstInvoice.grandTotal },
    });
  }
  if (firstPayment) {
    timeline.push({
      stage: 'FIRST_PAYMENT',
      label: 'First Payment Received',
      timestamp: firstPayment.paymentDate,
      user: firstPayment.createdBy,
      details: `₹${Number(firstPayment.amount || 0).toFixed(2)} via ${firstPayment.paymentMode}`,
      meta: { amount: firstPayment.amount, mode: firstPayment.paymentMode },
    });
  }

  // ─── Events sourced from StatusChangeLog ───────────────────────────
  // Two classes of events live in the audit log:
  //   1. Reassignments (promoted to main timeline, not buried)
  //   2. Rejection + re-submit events (append-only — every instance of
  //      "docs rejected" or "BDM re-uploaded" gets its own row so the full
  //      ping-pong is visible)
  //
  // The per-field derived rows on the lead (docsVerified, accountsVerified,
  // opsApproval, superAdmin2Approval) still drive happy-path events above.
  // This block is additive: StatusChangeLog rows never overwrite those.
  const REASSIGNMENT_FIELDS = {
    assignedToId: 'Lead Reassigned to Another BDM',
    feasibilityAssignedToId: 'Feasibility Reassigned',
    nocAssignedToId: 'NOC Reassigned',
    deliveryAssignedToId: 'Delivery Reassigned',
  };
  // Rejection + re-submit rows. Each entry: [field, decisionValue, stage, labelFn]
  // label is a function so we can surface reason + previous state when useful.
  const AUDIT_EVENT_MAP = {
    // Disposition events
    bdmDisposition:              { stage: 'LEAD_DROPPED',               phase: 50,  label: 'Lead Dropped by BDM',              isError: true },
    coldLeadParked:              { stage: 'COLD_LEAD_PARKED',            phase: 52,  label: 'Parked as Cold Lead',              isError: false },
    feasibilityReview:           { stage: null, /* branch on newValue */ phase: 70,  label: null,                                isError: null },
    opsApprovalStatus:           { stage: null,                          phase: 100, label: null,                                isError: null },
    superAdmin2ApprovalStatus:   { stage: null,                          phase: 100, label: null,                                isError: null },
    docsStatus:                  { stage: null,                          phase: 150, label: null,                                isError: null },
    accountsStatus:              { stage: null,                          phase: 170, label: null,                                isError: null },
    customerAcceptance:          { stage: 'CUSTOMER_REJECTED',           phase: 330, label: 'Customer Rejected Service',        isError: true },
    // Re-submission events. Note: quotationUploaded and quotationSubmitted
    // intentionally NOT mapped here — they're already rendered by the
    // field-derived block above (which pulls the log entry for timestamp)
    // so mapping them here would cause duplicate rows.
    docsSubmitted:               { stage: 'DOCS_SUBMITTED',              phase: 115, label: 'Documents Submitted by BDM',       isError: false },
    docsResubmitted:             { stage: 'DOCS_RESUBMITTED',            phase: 115, label: 'Documents Re-uploaded by BDM',     isError: false, isRetry: true },
    quotationResubmitted:        { stage: 'QUOTATION_RESUBMITTED',       phase: 90,  label: 'Quotation Re-submitted',           isError: false, isRetry: true },
    feasibilityResubmitted:      { stage: 'FEASIBILITY_RESUBMITTED',     phase: 65,  label: 'Pushed to Feasibility Again',      isError: false, isRetry: true },
  };

  statusChangeLogs.forEach((log) => {
    // Reassignment path
    const reassignLabel = REASSIGNMENT_FIELDS[log.field];
    if (reassignLabel) {
      timeline.push({
        stage: 'REASSIGNMENT',
        label: reassignLabel,
        timestamp: log.changedAt,
        user: log.changedBy,
        details: `${log.oldValue || '—'} → ${log.newValue || '—'}${log.reason ? ` · ${log.reason}` : ''}`,
      });
      return;
    }

    // Audit-backed event path
    const mapped = AUDIT_EVENT_MAP[log.field];
    if (!mapped) return;

    // Dynamic mapping for multi-decision fields (branch on newValue)
    let stage = mapped.stage;
    let label = mapped.label;
    let isError = mapped.isError;

    if (log.field === 'feasibilityReview') {
      if (log.newValue === 'NOT_FEASIBLE') {
        stage = 'FEASIBILITY_REJECTED'; label = 'Feasibility Rejected'; isError = true;
      } else { stage = 'FEASIBILITY_APPROVED'; label = 'Feasibility Approved'; isError = false; }
    } else if (log.field === 'opsApprovalStatus') {
      if (log.newValue === 'REJECTED') {
        stage = 'OPS_REJECTED'; label = 'OPS Rejected Quotation'; isError = true;
      } else { stage = 'OPS_APPROVED'; label = 'OPS Approved Quotation'; isError = false; }
    } else if (log.field === 'superAdmin2ApprovalStatus') {
      if (log.newValue === 'REJECTED') {
        stage = 'SALES_DIRECTOR_REJECTED'; label = 'Sales Director Rejected Quotation'; isError = true;
      } else { stage = 'SALES_DIRECTOR_APPROVED'; label = 'Sales Director Approved Quotation'; isError = false; }
    } else if (log.field === 'docsStatus') {
      if (log.newValue === 'REJECTED') {
        stage = 'DOCS_REJECTED'; label = 'Docs Rejected'; isError = true;
      } else { stage = 'DOCS_VERIFIED'; label = 'Docs Verified'; isError = false; }
    } else if (log.field === 'accountsStatus') {
      if (log.newValue === 'ACCOUNTS_REJECTED') {
        stage = 'ACCOUNTS_REJECTED'; label = 'Accounts Rejected'; isError = true;
      } else if (log.newValue === 'SENT_BACK_TO_BDM') {
        stage = 'ACCOUNTS_SENT_BACK'; label = 'Sent Back to BDM for Re-upload'; isError = true;
      } else { stage = 'ACCOUNTS_APPROVED'; label = 'Accounts Approved'; isError = false; }
    }

    timeline.push({
      stage,
      label,
      timestamp: log.changedAt,
      user: log.changedBy,
      details: log.reason || (log.newValue ? `Status: ${log.newValue}` : null),
      isError: !!isError,
      meta: { auditField: log.field, auditOldValue: log.oldValue, auditNewValue: log.newValue, isRetry: !!mapped.isRetry },
    });
  });

  // ─── Canonical lifecycle ordering ─────────────────────────────────────
  // Each stage gets a position index matching where it belongs in a
  // well-lived lead's lifecycle. Sort is stable: primary = canonical order
  // (so e.g. QUOTE_SHARED always sits right after SALES_DIRECTOR_APPROVED
  //  even when timestamps happen seconds apart during testing), secondary =
  // timestamp (for events in the same phase — e.g. multiple ISR calls).
  const STAGE_ORDER = {
    DATA_UPLOADED: 10,
    ISR_ASSIGNED: 20,
    ISR_CALL: 30,
    LEAD_CREATED: 40,
    OPPORTUNITY_CREATED: 40,
    COLD_LEAD_ADDED: 40,
    BDM_ASSIGNED: 50,
    LEAD_DROPPED: 51,
    COLD_LEAD_PARKED: 52,
    FEASIBILITY_ASSIGNED: 60,
    FEASIBILITY_RESUBMITTED: 65,
    FEASIBILITY_APPROVED: 70,
    FEASIBILITY_REJECTED: 70,
    QUOTATION_UPLOADED: 80,
    QUOTATION_SUBMITTED: 90,
    QUOTATION_RESUBMITTED: 90,
    SALES_DIRECTOR_APPROVED: 100,
    SALES_DIRECTOR_REJECTED: 100,
    OPS_APPROVED: 100,
    OPS_REJECTED: 100,
    QUOTE_SHARED: 110,
    DOCS_SUBMITTED: 115,
    DOCS_RESUBMITTED: 115,
    DOCS_UPLOAD_LINK: 120,
    LOGIN_COMPLETED: 130,
    DOCS_UPLOADED: 140,
    DOCS_VERIFIED: 150,
    DOCS_REJECTED: 150,
    ACCOUNTS_APPROVED: 160,
    ACCOUNTS_VERIFIED: 160,
    ACCOUNTS_REJECTED: 170,
    ACCOUNTS_SENT_BACK: 170,
    GST_VERIFIED: 175,
    PUSHED_TO_INSTALLATION: 180,
    NOC_ASSIGNED: 190,
    DELIVERY_VENDOR_SETUP: 200,
    NOC_PUSHED_TO_DELIVERY: 205,
    DELIVERY_REQUEST_CREATED: 210,
    DELIVERY_SUPER_ADMIN_APPROVED: 220,
    DELIVERY_SUPER_ADMIN_REJECTED: 220,
    DELIVERY_AREA_HEAD_APPROVED: 230,
    DELIVERY_AREA_HEAD_REJECTED: 230,
    DELIVERY_ASSIGNED_TO_STORE: 240,
    DELIVERY_DISPATCHED: 250,
    DELIVERY_COMPLETED: 260,
    NOC_CONFIGURED: 270,
    CUSTOMER_CREATED: 280,
    INSTALLATION_STARTED: 290,
    INSTALLATION_COMPLETED: 300,
    DEMO_PLAN: 310,
    SPEED_TEST: 320,
    CUSTOMER_ACCEPTED: 330,
    CUSTOMER_REJECTED: 330,
    ACTUAL_PLAN: 340,
    SAM_ASSIGNED: 400,
    FIRST_INVOICE: 410,
    FIRST_PAYMENT: 420,
    REASSIGNMENT: 999, // pushed to the end — audit-style events
  };
  const orderOf = (e) => STAGE_ORDER[e.stage] ?? 500;

  timeline.sort((a, b) => {
    const phaseDelta = orderOf(a) - orderOf(b);
    if (phaseDelta !== 0) return phaseDelta;
    return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
  });

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
    leadOrigin,
    leadOriginLabel,
    leadOriginDescription,
    showISRStages,
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
