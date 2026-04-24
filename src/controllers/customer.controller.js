import prisma from '../config/db.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';
import { createNotification, notifyAllAdmins } from '../services/notification.service.js';
import { generateEnquiryNumber, generateDocumentNumber } from '../services/documentNumber.service.js';
import { asyncHandler, parsePagination, paginatedResponse } from '../utils/controllerHelper.js';

// GET /api/customer/profile
export const getProfile = asyncHandler(async function getProfile(req, res) {
  const lead = await prisma.lead.findUnique({
    where: { id: req.customer.leadId },
    select: {
      customerUserId: true,
      customerUsername: true,
      customerCreatedAt: true,
      actualPlanIsActive: true,
      actualPlanName: true,
      billingAddress: true,
      installationAddress: true,
      customerGstNo: true,
      customerIpAssigned: true,
      campaignData: {
        select: {
          company: true,
          name: true,
          phone: true,
          email: true,
          address: true,
          city: true,
          state: true,
        }
      }
    }
  });

  if (!lead) {
    return res.status(404).json({ message: 'Account not found.' });
  }

  res.json({
    data: {
      customerUserId: lead.customerUserId,
      customerUsername: lead.customerUsername,
      customerCreatedAt: lead.customerCreatedAt,
      planActive: lead.actualPlanIsActive,
      planName: lead.actualPlanName,
      billingAddress: lead.billingAddress,
      installationAddress: lead.installationAddress,
      customerGstNo: lead.customerGstNo,
      customerIpAssigned: lead.customerIpAssigned,
      company: lead.campaignData?.company,
      name: lead.campaignData?.name,
      phone: lead.campaignData?.phone,
      email: lead.campaignData?.email,
      address: lead.campaignData?.address,
      city: lead.campaignData?.city,
      state: lead.campaignData?.state,
    }
  });
});

// PATCH /api/customer/profile
export const updateProfile = asyncHandler(async function updateProfile(req, res) {
  const { name, phone, email, billingAddress, installationAddress, city, state } = req.body;

  const lead = await prisma.lead.findUnique({
    where: { id: req.customer.leadId },
    select: { campaignDataId: true },
  });

  if (!lead) {
    return res.status(404).json({ message: 'Account not found.' });
  }

  // Update CampaignData fields (name, phone, email, city, state)
  const campaignDataUpdate = {};
  if (name !== undefined) campaignDataUpdate.name = name.trim();
  if (phone !== undefined) campaignDataUpdate.phone = phone.trim();
  if (email !== undefined) campaignDataUpdate.email = email.trim();
  if (city !== undefined) campaignDataUpdate.city = city.trim();
  if (state !== undefined) campaignDataUpdate.state = state.trim();

  // Update Lead fields (billingAddress, installationAddress)
  const leadUpdate = {};
  if (billingAddress !== undefined) leadUpdate.billingAddress = billingAddress.trim();
  if (installationAddress !== undefined) leadUpdate.installationAddress = installationAddress.trim();

  await prisma.$transaction(async (tx) => {
    if (Object.keys(campaignDataUpdate).length > 0) {
      await tx.campaignData.update({
        where: { id: lead.campaignDataId },
        data: campaignDataUpdate,
      });
    }
    if (Object.keys(leadUpdate).length > 0) {
      await tx.lead.update({
        where: { id: req.customer.leadId },
        data: leadUpdate,
      });
    }
  });

  res.json({ message: 'Profile updated successfully.' });
});

// GET /api/customer/plan
export const getPlan = asyncHandler(async function getPlan(req, res) {
  const lead = await prisma.lead.findUnique({
    where: { id: req.customer.leadId },
    select: {
      actualPlanIsActive: true,
      actualPlanName: true,
      actualPlanBandwidth: true,
      actualPlanUploadBandwidth: true,
      actualPlanDataLimit: true,
      actualPlanPrice: true,
      actualPlanBillingCycle: true,
      actualPlanBillingType: true,
      actualPlanStartDate: true,
      actualPlanEndDate: true,
      actualPlanValidityDays: true,
      actualPlanCreatedAt: true,
      arcAmount: true,
      demoPlanIsActive: true,
      demoPlanName: true,
      demoPlanBandwidth: true,
      demoPlanUploadBandwidth: true,
      demoPlanPrice: true,
      demoPlanStartDate: true,
      demoPlanEndDate: true,
    }
  });

  const upgradeHistory = await prisma.planUpgradeHistory.findMany({
    where: { leadId: req.customer.leadId },
    orderBy: { upgradeDate: 'desc' },
    select: {
      actionType: true,
      previousPlanName: true,
      previousBandwidth: true,
      previousArc: true,
      newPlanName: true,
      newBandwidth: true,
      newArc: true,
      upgradeDate: true,
      notes: true,
    }
  });

  res.json({
    data: {
      currentPlan: {
        isActive: lead.actualPlanIsActive,
        name: lead.actualPlanName,
        bandwidth: lead.actualPlanBandwidth,
        uploadBandwidth: lead.actualPlanUploadBandwidth,
        dataLimit: lead.actualPlanDataLimit,
        price: lead.actualPlanPrice,
        billingCycle: lead.actualPlanBillingCycle,
        billingType: lead.actualPlanBillingType,
        startDate: lead.actualPlanStartDate,
        endDate: lead.actualPlanEndDate,
        validityDays: lead.actualPlanValidityDays,
        createdAt: lead.actualPlanCreatedAt,
        arcAmount: lead.arcAmount,
      },
      demoPlan: lead.demoPlanIsActive ? {
        name: lead.demoPlanName,
        bandwidth: lead.demoPlanBandwidth,
        uploadBandwidth: lead.demoPlanUploadBandwidth,
        price: lead.demoPlanPrice,
        startDate: lead.demoPlanStartDate,
        endDate: lead.demoPlanEndDate,
      } : null,
      upgradeHistory,
    }
  });
});

// GET /api/customer/invoices
export const getInvoices = asyncHandler(async function getInvoices(req, res) {
  const { page, limit, skip } = parsePagination(req.query, 10);
  const status = req.query.status;

  const where = { leadId: req.customer.leadId };
  if (status && status !== 'ALL') {
    where.status = status;
  }

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { invoiceDate: 'desc' },
      take: limit,
      skip,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
        planName: true,
        baseAmount: true,
        grandTotal: true,
        totalPaidAmount: true,
        remainingAmount: true,
        status: true,
      }
    }),
    prisma.invoice.count({ where })
  ]);

  res.json({
    data: invoices,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

// GET /api/customer/invoices/:id
export const getInvoiceDetail = asyncHandler(async function getInvoiceDetail(req, res) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, leadId: req.customer.leadId },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      billingPeriodStart: true,
      billingPeriodEnd: true,
      companyName: true,
      customerUsername: true,
      billingAddress: true,
      installationAddress: true,
      buyerGstNo: true,
      contactPhone: true,
      contactEmail: true,
      planName: true,
      planDescription: true,
      hsnSacCode: true,
      baseAmount: true,
      discountAmount: true,
      taxableAmount: true,
      sgstRate: true,
      cgstRate: true,
      sgstAmount: true,
      cgstAmount: true,
      totalGstAmount: true,
      grandTotal: true,
      totalPaidAmount: true,
      remainingAmount: true,
      status: true,
      notes: true,
      payments: {
        select: {
          id: true,
          receiptNumber: true,
          paymentDate: true,
          amount: true,
          paymentMode: true,
        },
        orderBy: { paymentDate: 'desc' },
      },
    },
  });

  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found.' });
  }

  res.json({ data: invoice });
});

// GET /api/customer/payments
export const getPayments = asyncHandler(async function getPayments(req, res) {
  const { page, limit, skip } = parsePagination(req.query, 10);

  const [payments, total] = await Promise.all([
    prisma.invoicePayment.findMany({
      where: { invoice: { leadId: req.customer.leadId } },
      orderBy: { paymentDate: 'desc' },
      take: limit,
      skip,
      select: {
        id: true,
        amount: true,
        paymentMode: true,
        receiptNumber: true,
        paymentDate: true,
        invoice: {
          select: {
            invoiceNumber: true,
            status: true,
            remainingAmount: true,
            grandTotal: true,
          }
        }
      }
    }),
    prisma.invoicePayment.count({
      where: { invoice: { leadId: req.customer.leadId } }
    })
  ]);

  res.json({
    data: payments,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

// GET /api/customer/billing-summary
export const getBillingSummary = asyncHandler(async function getBillingSummary(req, res) {
  const lead = await prisma.lead.findUnique({
    where: { id: req.customer.leadId },
    select: {
      actualPlanPrice: true,
      actualPlanBillingCycle: true,
      arcAmount: true,
    }
  });

  // Get outstanding balance from ledger
  const latestLedger = await prisma.ledgerEntry.findFirst({
    where: { customerId: req.customer.leadId },
    orderBy: { createdAt: 'desc' },
    select: { runningBalance: true }
  });

  // Get next unpaid invoice
  const nextInvoice = await prisma.invoice.findFirst({
    where: {
      leadId: req.customer.leadId,
      status: { in: ['GENERATED', 'PARTIALLY_PAID', 'OVERDUE'] }
    },
    orderBy: { dueDate: 'asc' },
    select: {
      invoiceNumber: true,
      grandTotal: true,
      remainingAmount: true,
      dueDate: true,
      status: true,
      billingPeriodStart: true,
      billingPeriodEnd: true,
    }
  });

  // Count overdue invoices
  const overdueCount = await prisma.invoice.count({
    where: {
      leadId: req.customer.leadId,
      status: 'OVERDUE',
    }
  });

  res.json({
    data: {
      outstandingBalance: latestLedger?.runningBalance || 0,
      nextInvoice,
      overdueCount,
      planPrice: lead?.actualPlanPrice,
      billingCycle: lead?.actualPlanBillingCycle,
      arcAmount: lead?.arcAmount,
    }
  });
});

// GET /api/customer/complaints
// Returns unified view: pending customer requests + all formal complaints for this customer
export const getComplaintRequests = asyncHandler(async function getComplaintRequests(req, res) {
  const leadId = req.customer.leadId;
  const { page, limit, skip } = parsePagination(req.query, 10);
  const status = req.query.status;

  // PENDING tab: only customer-submitted requests not yet logged by NOC
  if (status === 'PENDING') {
    const where = { leadId, status: 'PENDING' };
    const [items, total] = await Promise.all([
      prisma.customerComplaintRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        select: {
          id: true, requestNumber: true, description: true, status: true, createdAt: true,
          category: { select: { name: true } },
          subCategory: { select: { name: true } },
          attachments: { select: { id: true, fileName: true, fileUrl: true, fileType: true } },
        }
      }),
      prisma.customerComplaintRequest.count({ where })
    ]);
    return res.json({
      data: items.map(r => ({
        id: r.id, number: r.requestNumber, description: r.description,
        status: 'PENDING', category: r.category, subCategory: r.subCategory,
        attachments: r.attachments, createdAt: r.createdAt, source: 'request',
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  }

  // OPEN or CLOSED tab: formal complaints from Complaint model
  if (status === 'OPEN' || status === 'CLOSED') {
    const where = { leadId, status };
    const [items, total] = await Promise.all([
      prisma.complaint.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        select: {
          id: true, complaintNumber: true, description: true, status: true, priority: true, createdAt: true,
          category: { select: { name: true } },
          subCategory: { select: { name: true } },
          attachments: { select: { id: true, fileName: true, fileUrl: true, fileType: true } },
        }
      }),
      prisma.complaint.count({ where })
    ]);
    return res.json({
      data: items.map(c => ({
        id: c.id, number: c.complaintNumber, description: c.description,
        status: c.status, priority: c.priority, category: c.category,
        subCategory: c.subCategory, attachments: c.attachments,
        createdAt: c.createdAt, source: 'complaint',
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  }

  // ALL tab: merge pending customer requests + formal complaints.
  //
  // Memory safety: we only need the top `skip + limit` rows of the merged
  // set, which is guaranteed to be within the top `skip + limit` of EACH
  // source (both are sorted by createdAt desc). Fetching `take: skip+limit`
  // from each bounds the row count regardless of how many complaints the
  // customer has historically. Totals come from two separate count queries.
  const upperBound = skip + limit;
  const [pendingRequests, complaints, requestTotal, complaintTotal] = await Promise.all([
    prisma.customerComplaintRequest.findMany({
      where: { leadId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: upperBound,
      select: {
        id: true, requestNumber: true, description: true, status: true, createdAt: true,
        category: { select: { name: true } },
        subCategory: { select: { name: true } },
        attachments: { select: { id: true, fileName: true, fileUrl: true, fileType: true } },
      }
    }),
    prisma.complaint.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: upperBound,
      select: {
        id: true, complaintNumber: true, description: true, status: true, priority: true, createdAt: true,
        category: { select: { name: true } },
        subCategory: { select: { name: true } },
        attachments: { select: { id: true, fileName: true, fileUrl: true, fileType: true } },
      }
    }),
    prisma.customerComplaintRequest.count({ where: { leadId, status: 'PENDING' } }),
    prisma.complaint.count({ where: { leadId } }),
  ]);

  const combined = [
    ...pendingRequests.map(r => ({
      id: r.id, number: r.requestNumber, description: r.description,
      status: 'PENDING', category: r.category, subCategory: r.subCategory,
      attachments: r.attachments, createdAt: r.createdAt, source: 'request',
    })),
    ...complaints.map(c => ({
      id: c.id, number: c.complaintNumber, description: c.description,
      status: c.status, priority: c.priority, category: c.category,
      subCategory: c.subCategory, attachments: c.attachments,
      createdAt: c.createdAt, source: 'complaint',
    })),
  ];
  combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = requestTotal + complaintTotal;
  const paginated = combined.slice(skip, skip + limit);

  res.json({
    data: paginated,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

// GET /api/customer/complaints/categories
export const getComplaintCategories = asyncHandler(async function getComplaintCategories(req, res) {
  const categories = await prisma.complaintCategory.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      subCategories: {
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' }
      }
    },
    orderBy: { name: 'asc' }
  });

  res.json({ data: categories });
});

// POST /api/customer/complaints
export const createComplaintRequest = asyncHandler(async function createComplaintRequest(req, res) {
  const { categoryId, subCategoryId, description } = req.body;

  if (!categoryId) return res.status(400).json({ message: 'Category is required.' });
  if (!subCategoryId) return res.status(400).json({ message: 'Sub-category is required.' });
  if (!description?.trim()) return res.status(400).json({ message: 'Description is required.' });

  // Validate category + subcategory
  const subCategory = await prisma.complaintSubCategory.findUnique({
    where: { id: subCategoryId },
    select: { id: true, categoryId: true, name: true, category: { select: { name: true } } }
  });

  if (!subCategory || subCategory.categoryId !== categoryId) {
    return res.status(400).json({ message: 'Invalid category or sub-category.' });
  }

  // Generate request number (atomic, race-condition safe)
  const requestNumber = await generateDocumentNumber('CUSTOMER_COMPLAINT');

  const request = await prisma.customerComplaintRequest.create({
    data: {
      requestNumber,
      leadId: req.customer.leadId,
      categoryId,
      subCategoryId,
      description: description.trim(),
    },
    select: {
      id: true,
      requestNumber: true,
      description: true,
      status: true,
      createdAt: true,
      category: { select: { name: true } },
      subCategory: { select: { name: true } },
    }
  });

  // Notify NOC team
  const nocUsers = await prisma.user.findMany({
    where: { role: 'NOC', isActive: true },
    select: { id: true }
  });

  const customerName = req.customer.company || req.customer.name || req.customer.customerUsername;

  for (const noc of nocUsers) {
    await createNotification(
      noc.id,
      'CUSTOMER_COMPLAINT_REQUEST',
      'New Customer Complaint Request',
      `${customerName} submitted complaint request ${requestNumber}: ${subCategory.category.name} - ${subCategory.name}`,
      { requestId: request.id, requestNumber, leadId: req.customer.leadId }
    );
  }
  emitSidebarRefreshByRole('NOC');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({ message: 'Complaint request submitted.', data: request });
});

// POST /api/customer/complaints/:id/attachments
export const uploadRequestAttachment = asyncHandler(async function uploadRequestAttachment(req, res) {
  const { id } = req.params;

  // Verify request belongs to customer
  const request = await prisma.customerComplaintRequest.findFirst({
    where: { id, leadId: req.customer.leadId }
  });

  if (!request) {
    return res.status(404).json({ message: 'Complaint request not found.' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: 'No files uploaded.' });
  }

  const attachments = await prisma.$transaction(
    req.files.map(file =>
      prisma.customerComplaintRequestAttachment.create({
        data: {
          requestId: id,
          fileName: file.originalname,
          fileUrl: file.path,
          fileType: file.mimetype,
          fileSize: file.size,
        },
        select: { id: true, fileName: true, fileUrl: true, fileType: true }
      })
    )
  );

  res.json({ message: 'Files uploaded.', data: attachments });
});

// POST /api/customer/enquiries
export const submitEnquiry = asyncHandler(async function submitEnquiry(req, res) {
  const { companyName, contactName, phone, email, address, city, state, requirements } = req.body;

  // Validation
  if (!companyName?.trim()) return res.status(400).json({ message: 'Company name is required.' });
  if (!contactName?.trim()) return res.status(400).json({ message: 'Contact name is required.' });
  if (!phone?.trim()) return res.status(400).json({ message: 'Phone number is required.' });
  const enquiryDigits = phone.replace(/\D/g, '');
  if (enquiryDigits.length !== 10) return res.status(400).json({ message: `Phone must have exactly 10 digits. Got ${enquiryDigits.length}.` });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ message: 'Invalid email format.' });
  }

  // Generate enquiry number
  const enquiryNumber = await generateEnquiryNumber();

  // Find or create CUSTOMER-REFERRAL campaign
  let campaign = await prisma.campaign.findFirst({
    where: { code: 'CUSTOMER-REFERRAL' }
  });

  if (!campaign) {
    // Find a SUPER_ADMIN early so we can set campaign creator
    const adminForCampaign = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN', isActive: true },
      select: { id: true }
    });
    campaign = await prisma.campaign.create({
      data: {
        code: 'CUSTOMER-REFERRAL',
        name: 'Customer Referrals',
        description: 'Leads referred by existing customers',
        type: 'ALL',
        status: 'ACTIVE',
        dataSource: 'Customer Portal',
        isActive: true,
        createdById: adminForCampaign?.id || null
      }
    });
  }

  // Find a SUPER_ADMIN to use as createdBy (Lead requires createdById)
  const systemUser = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    select: { id: true }
  });

  if (!systemUser) {
    return res.status(500).json({ message: 'No admin user found. Contact support.' });
  }

  // Parse contact name
  const nameParts = contactName.trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Transaction: CampaignData → Lead → CustomerEnquiry
  const result = await prisma.$transaction(async (tx) => {
    const campaignData = await tx.campaignData.create({
      data: {
        campaignId: campaign.id,
        company: companyName.trim(),
        firstName,
        lastName,
        name: contactName.trim(),
        title: 'Contact',
        email: email?.trim() || null,
        phone: enquiryDigits,
        city: city?.trim() || null,
        state: state?.trim() || null,
        source: 'Customer Referral',
        notes: requirements?.trim() || null,
        isSelfGenerated: true,
        createdById: systemUser.id,
        status: 'INTERESTED',
      },
    });

    const lead = await tx.lead.create({
      data: {
        campaignDataId: campaignData.id,
        createdById: systemUser.id,
        status: 'NEW',
        requirements: requirements?.trim() || null,
        type: 'QUALIFIED',
        // Customer-portal enquiries are referrals from an existing customer —
        // route through the SAM origin bucket so the Customer 360 banner
        // correctly attributes the source to customer referral.
        creationSource: 'SAM_REFERRAL',
      },
    });

    const enquiry = await tx.customerEnquiry.create({
      data: {
        enquiryNumber,
        referredByLeadId: req.customer.leadId,
        companyName: companyName.trim(),
        contactName: contactName.trim(),
        phone: phone.trim(),
        email: email?.trim() || null,
        address: address?.trim() || null,
        city: city?.trim() || null,
        state: state?.trim() || null,
        requirements: requirements?.trim() || null,
        createdLeadId: lead.id,
      },
    });

    return enquiry;
  });

  // Notify all admins
  const referrerName = req.customer.company || req.customer.name || req.customer.customerUsername;
  await notifyAllAdmins(
    'CUSTOMER_REFERRAL',
    'New Customer Referral',
    `${referrerName} referred ${companyName.trim()} (${contactName.trim()}) - ${enquiryNumber}`,
    { enquiryId: result.id, enquiryNumber }
  );
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({ message: 'Referral submitted successfully.', data: result });
});

// GET /api/customer/enquiries
export const getEnquiries = asyncHandler(async function getEnquiries(req, res) {
  const { page, limit, skip } = parsePagination(req.query, 10);
  const status = req.query.status;

  const where = { referredByLeadId: req.customer.leadId };
  if (status && status !== 'ALL') {
    where.status = status;
  }

  const [enquiries, total] = await Promise.all([
    prisma.customerEnquiry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
      select: {
        id: true,
        enquiryNumber: true,
        companyName: true,
        contactName: true,
        phone: true,
        email: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.customerEnquiry.count({ where }),
  ]);

  res.json({
    data: enquiries,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// === NOC-side endpoints (for existing auth) ===

// GET /api/complaints/customer-requests (used by NOC)
export const getCustomerRequests = asyncHandler(async function getCustomerRequests(req, res) {
  const { page, limit, skip } = parsePagination(req.query, 10);
  const status = req.query.status || 'PENDING';

  const [requests, total] = await Promise.all([
    prisma.customerComplaintRequest.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
      select: {
        id: true,
        requestNumber: true,
        description: true,
        status: true,
        createdAt: true,
        category: { select: { id: true, name: true } },
        subCategory: { select: { id: true, name: true } },
        lead: {
          select: {
            id: true,
            customerUserId: true,
            customerUsername: true,
            campaignData: {
              select: { company: true, name: true, phone: true }
            }
          }
        },
        attachments: {
          select: { id: true, fileName: true, fileUrl: true, fileType: true, fileSize: true }
        }
      }
    }),
    prisma.customerComplaintRequest.count({ where: { status } })
  ]);

  res.json({
    data: requests,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

// POST /api/complaints/customer-requests/:id/log (NOC logs formal complaint)
export const logComplaintFromRequest = asyncHandler(async function logComplaintFromRequest(req, res) {
  const { id } = req.params;
  const { priority, tatHours, nocAssigneeId, opsAssigneeId, accountsAssigneeId, notes, categoryId, subCategoryId } = req.body;

  const request = await prisma.customerComplaintRequest.findUnique({
    where: { id },
    include: {
      category: true,
      subCategory: true,
      lead: {
        select: {
          id: true,
          customerUsername: true,
          campaignData: { select: { company: true, name: true } }
        }
      },
      attachments: true,
    }
  });

  if (!request) {
    return res.status(404).json({ message: 'Customer request not found.' });
  }

  if (request.status !== 'PENDING') {
    return res.status(400).json({ message: 'Request already processed.' });
  }

  // Use overridden category/subCategory if provided, else fall back to request values
  const finalCategoryId = categoryId || request.categoryId;
  const finalSubCategoryId = subCategoryId || request.subCategoryId;

  // Validate category & subcategory if overridden
  let finalSubCategory = request.subCategory;
  let finalCategory = request.category;
  if (categoryId || subCategoryId) {
    const subCat = await prisma.complaintSubCategory.findUnique({
      where: { id: finalSubCategoryId },
      include: { category: true },
    });
    if (!subCat || subCat.categoryId !== finalCategoryId) {
      return res.status(400).json({ message: 'Invalid category / sub-category combination.' });
    }
    finalSubCategory = subCat;
    finalCategory = subCat.category;
  }

  // Check if this is an accounts-type category
  const ACCOUNTS_CATEGORIES = ['Billing & Payments', 'Account & Documentation'];
  const isAccountsCategory = ACCOUNTS_CATEGORIES.includes(finalCategory?.name);

  if (isAccountsCategory) {
    if (!accountsAssigneeId) return res.status(400).json({ message: 'Accounts assignee is required for this category.' });
  } else {
    if (!nocAssigneeId) return res.status(400).json({ message: 'NOC assignee is required.' });
  }

  // Build assignee list based on category type
  const assigneeIds = [];
  if (isAccountsCategory) {
    assigneeIds.push(accountsAssigneeId);
  } else {
    assigneeIds.push(nocAssigneeId);
    if (opsAssigneeId) assigneeIds.push(opsAssigneeId);
  }

  // Calculate TAT
  const effectiveTATHours = tatHours ? parseInt(tatHours) : finalSubCategory.defaultTATHours;
  const now = new Date();
  const tatDeadline = new Date(now.getTime() + effectiveTATHours * 60 * 60 * 1000);

  // Generate complaint number (atomic, race-condition safe)
  const complaintNumber = await generateDocumentNumber('COMPLAINT');

  // Create complaint + update request in transaction
  const result = await prisma.$transaction(async (tx) => {
    const complaint = await tx.complaint.create({
      data: {
        complaintNumber,
        leadId: request.leadId,
        categoryId: finalCategoryId,
        subCategoryId: finalSubCategoryId,
        priority: priority || 'MEDIUM',
        description: request.description,
        tatHours: effectiveTATHours,
        tatDeadline,
        notes: notes || null,
        createdById: req.user.id,
        assignments: {
          create: assigneeIds.map(userId => ({
            userId,
            assignedById: req.user.id,
          }))
        }
      }
    });

    // Copy attachments to complaint
    if (request.attachments.length > 0) {
      await tx.complaintAttachment.createMany({
        data: request.attachments.map(att => ({
          complaintId: complaint.id,
          fileName: att.fileName,
          fileUrl: att.fileUrl,
          fileType: att.fileType,
          fileSize: att.fileSize,
          uploadedById: req.user.id,
        }))
      });
    }

    // Update request status to OPEN and link complaint
    await tx.customerComplaintRequest.update({
      where: { id },
      data: { status: 'OPEN', complaintId: complaint.id }
    });

    return complaint;
  });

  // Notifications to assignees
  const customerName = request.lead.campaignData?.company || request.lead.campaignData?.name || request.lead.customerUsername;
  for (const assigneeId of assigneeIds) {
    await createNotification(
      assigneeId,
      'COMPLAINT_ASSIGNED',
      'Complaint Assigned',
      `Complaint ${complaintNumber} for ${customerName} assigned to you.`,
      { complaintId: result.id, complaintNumber }
    );
  }

  emitSidebarRefreshByRole('NOC');
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('FEASIBILITY_TEAM');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.status(201).json({ message: 'Complaint logged from customer request.', data: result });
});
