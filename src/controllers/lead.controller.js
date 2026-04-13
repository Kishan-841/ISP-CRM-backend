import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import prisma from '../config/db.js';
import { notifyLeadConverted, notifyFeasibilityAssigned, notifyFeasibilityReturned, notifyFeasibilityApproved, notifyVendorDocsReminder, notifyAllAdmins, createNotification } from '../services/notification.service.js';
import { isValidDocumentType, validateDocuments, getRequiredDocumentTypes } from '../config/documentTypes.js';
import { deleteFromCloudinary, getResourceType } from '../config/cloudinary.js';
import { generateOTCInvoiceNumber, generateInvoiceNumber, generateCreditNoteNumber, generateVendorPONumber, generateLeadNumber } from '../services/documentNumber.service.js';
import { createInvoiceLedgerEntry, deleteLedgerEntriesForInvoice, createCreditNoteLedgerEntry } from '../services/ledger.service.js';
import { isAdminOrTestUser, hasRole, hasAnyRole } from '../utils/roleHelper.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import { sendEmail } from '../services/email.service.js';
import { asyncHandler, parsePagination, buildDateFilter, buildSearchFilter, paginatedResponse } from '../utils/controllerHelper.js';

// Get all leads
export const getLeads = asyncHandler(async function getLeads(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const isBDM = hasRole(req.user, 'BDM');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isFeasibilityTeam = hasRole(req.user, 'FEASIBILITY_TEAM');

    const { page, limit, skip } = parsePagination(req.query, 25);
    const { search, campaignId, status, pipelineStage } = req.query;

    // Build where clause based on role
    // Cold leads live in their own Lead Pipeline tab and are excluded here.
    let whereClause = { isColdLead: false };
    if (isAdmin || isTL || isFeasibilityTeam) {
      // unchanged, just the cold filter above
    } else if (isBDM) {
      // BDM users only see leads assigned to them or created by them
      whereClause.OR = [{ assignedToId: userId }, { createdById: userId }];
    } else {
      whereClause.createdById = userId;
    }

    // Server-side search across lead number and campaign data fields
    if (search) {
      whereClause.OR = buildSearchFilter(search, [
        'leadNumber',
        'campaignData.company',
        'campaignData.name',
        'campaignData.firstName',
        'campaignData.lastName',
        'campaignData.email',
        { field: 'campaignData.phone' },
      ]);
    }

    // Server-side campaign filter
    if (campaignId) {
      whereClause.campaignData = {
        ...whereClause.campaignData,
        campaignId
      };
    }

    // Server-side status filter
    if (status) {
      whereClause.status = status;
    }

    // Server-side pipeline stage filter
    // Must match getCurrentStage logic: check from end of pipeline backward
    if (pipelineStage) {
      const stageFilters = {
        feasibilityCheck: {
          feasibilityAssignedToId: { not: null },
          feasibilityReviewedAt: null,
          status: { notIn: ['FEASIBLE', 'NOT_FEASIBLE', 'DROPPED'] },
        },
        feasible: { status: 'FEASIBLE', opsApprovalStatus: null },
        quoteSent: { opsApprovalStatus: 'PENDING' },
        docsUpload: { opsApprovalStatus: 'APPROVED', NOT: { sharedVia: { contains: 'docs_verification' } }, docsVerifiedAt: null },
        docsReview: { sharedVia: { contains: 'docs_verification' }, docsVerifiedAt: null },
        accountsReview: { docsVerifiedAt: { not: null }, docsRejectedReason: null, OR: [{ accountsVerifiedAt: null }, { accountsStatus: { not: 'ACCOUNTS_APPROVED' } }] },
        pushToDelivery: { accountsStatus: 'ACCOUNTS_APPROVED', accountsVerifiedAt: { not: null }, customerUsername: null },
        atNOC: { customerUsername: { not: null }, customerAcceptanceAt: null, installationCompletedAt: null, actualPlanIsActive: false },
        installed: { OR: [{ installationCompletedAt: { not: null } }, { customerAcceptanceAt: { not: null } }], actualPlanIsActive: false },
        live: { actualPlanIsActive: true },
        dropped: { OR: [{ status: 'DROPPED' }, { status: 'NOT_FEASIBLE' }, { opsApprovalStatus: 'REJECTED' }, { accountsStatus: 'ACCOUNTS_REJECTED' }] },
      };
      const filter = stageFilters[pipelineStage];
      if (filter) {
        Object.assign(whereClause, filter);
      }
    }

    const includeClause = {
      campaignData: {
        include: {
          campaign: { select: { id: true, code: true, name: true } },
          createdBy: { select: { id: true, name: true, email: true } }
        }
      },
      createdBy: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      products: { include: { product: { select: { id: true, title: true } } } }
    };

    const baseStatsWhere = {
      isColdLead: false,
      ...(isAdmin || isTL || isFeasibilityTeam
        ? {}
        : isBDM
          ? { OR: [{ assignedToId: userId }, { createdById: userId }] }
          : { createdById: userId })
    };
    const isISR = hasRole(req.user, 'ISR');
    const [leads, total, statusCounts, liveCount, meetingsDoneCount] = await Promise.all([
      prisma.lead.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: includeClause
      }),
      prisma.lead.count({ where: whereClause }),
      // Stats: count by status (uses base role filter only, not search/campaign/status filters)
      prisma.lead.groupBy({
        by: ['status'],
        where: baseStatsWhere,
        _count: { status: true }
      }),
      prisma.lead.count({ where: { ...baseStatsWhere, actualPlanIsActive: true } }),
      // Count leads where BDM attended a meeting and gave outcome (meetingDate set + moved past MEETING_SCHEDULED)
      prisma.lead.count({ where: { ...baseStatsWhere, meetingDate: { not: null }, status: { not: 'MEETING_SCHEDULED' } } })
    ]);

    // Build stats from groupBy
    const statusMap = new Map(statusCounts.map(s => [s.status, s._count.status]));
    const totalAll = statusCounts.reduce((sum, s) => sum + s._count.status, 0);
    const stats = {
      total: totalAll,
      pending: statusMap.get('NEW') || 0,
      qualified: statusMap.get('QUALIFIED') || 0,
      followUp: statusMap.get('FOLLOW_UP') || 0,
      dropped: statusMap.get('DROPPED') || 0,
      feasible: statusMap.get('FEASIBLE') || 0,
      notFeasible: statusMap.get('NOT_FEASIBLE') || 0,
      meetingScheduled: statusMap.get('MEETING_SCHEDULED') || 0,
      meetingsDone: meetingsDoneCount,
      pushedToPresales: statusMap.get('PUSHED_TO_PRESALES') || 0,
      live: liveCount,
    };

    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      leadNumber: lead.leadNumber,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      sharedVia: lead.sharedVia || '',
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      industry: lead.campaignData.industry,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      source: lead.campaignData.source,
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      campaign: lead.campaignData.campaign,
      createdBy: lead.createdBy,
      assignedTo: lead.assignedTo,
      products: lead.products.map(lp => lp.product),
      location: lead.location,
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      interestLevel: lead.interestLevel,
      opsApprovalStatus: lead.opsApprovalStatus,
      opsRejectedReason: lead.opsRejectedReason,
      superAdmin2ApprovalStatus: lead.superAdmin2ApprovalStatus,
      superAdmin2RejectedReason: lead.superAdmin2RejectedReason,
      loginCompletedAt: lead.loginCompletedAt,
      documents: lead.documents || [],
      docsVerifiedAt: lead.docsVerifiedAt,
      docsVerifiedById: lead.docsVerifiedById,
      docsRejectedReason: lead.docsRejectedReason,
      verificationAttempts: lead.verificationAttempts || 0,
      accountsVerifiedAt: lead.accountsVerifiedAt,
      accountsRejectedReason: lead.accountsRejectedReason,
      tentativePrice: lead.tentativePrice,
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
      pushedToInstallationAt: lead.pushedToInstallationAt,
      installationNotes: lead.installationNotes,
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt,
      feasibilityAssignedToId: lead.feasibilityAssignedToId,
      feasibilityVendorType: lead.feasibilityVendorType,
      tentativeCapex: lead.tentativeCapex,
      tentativeOpex: lead.tentativeOpex,
      feasibilityDescription: lead.feasibilityDescription,
      accountsStatus: lead.accountsStatus,
      customerUsername: lead.customerUsername,
      installationCompletedAt: lead.installationCompletedAt,
      customerAcceptanceAt: lead.customerAcceptanceAt,
      actualPlanIsActive: lead.actualPlanIsActive,
    }));

    res.json(paginatedResponse({ data: formattedLeads, total, page, limit, dataKey: 'leads', extra: { stats } }));
});

// Get single lead
export const getLead = asyncHandler(async function getLead(req, res) {
    const { id } = req.params;

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: true,
            callLogs: {
              orderBy: { createdAt: 'desc' },
              include: {
                user: {
                  select: { id: true, name: true }
                }
              }
            }
          }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: true
          }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    res.json({ lead });
});

// Convert campaign data to lead
export const convertToLead = asyncHandler(async function convertToLead(req, res) {
    const { campaignDataId, requirements, productIds, assignedToId, type, sharedVia, bandwidthRequirement } = req.body;
    const userId = req.user.id;

    if (!campaignDataId) {
      return res.status(400).json({ message: 'Campaign data ID is required.' });
    }

    // Check if campaign data exists
    const campaignData = await prisma.campaignData.findUnique({
      where: { id: campaignDataId },
      include: { lead: true, assignedByBdm: { select: { id: true, name: true } } }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Campaign data not found.' });
    }

    // Check if already converted
    if (campaignData.lead) {
      return res.status(400).json({ message: 'This data is already converted to a lead.' });
    }

    // Enforce BDM binding: if data was assigned by a BDM, force that BDM as assignee
    let effectiveAssignedToId = assignedToId && assignedToId.trim() !== '' ? assignedToId : null;
    if (campaignData.assignedByBdmId) {
      if (effectiveAssignedToId && effectiveAssignedToId !== campaignData.assignedByBdmId) {
        return res.status(400).json({
          message: `This data is bound to BDM ${campaignData.assignedByBdm?.name || 'Unknown'}. Cannot assign to a different BDM.`
        });
      }
      effectiveAssignedToId = campaignData.assignedByBdmId;
    }

    // BDM_CP auto-assignment: if the caller is BDM_CP, auto-assign to themselves
    if (req.user.role === 'BDM_CP') {
      effectiveAssignedToId = userId;
    }

    // Generate sequential lead number
    const leadNumber = await generateLeadNumber();

    // Build lead data object
    const leadData = {
      campaignDataId,
      leadNumber,
      requirements: requirements || null,
      createdById: userId,
      assignedToId: effectiveAssignedToId,
      status: 'NEW',
    };

    // If campaign data has a channel partner vendor, auto-set vendor on lead
    if (campaignData.channelPartnerVendorId) {
      leadData.vendorId = campaignData.channelPartnerVendorId;
      const cpVendor = await prisma.vendor.findUnique({
        where: { id: campaignData.channelPartnerVendorId },
        select: { commissionPercentage: true }
      });
      if (cpVendor?.commissionPercentage != null) {
        leadData.vendorCommissionPercentage = cpVendor.commissionPercentage;
      }
    }

    // Only add products if productIds provided and not empty
    if (productIds && productIds.length > 0) {
      leadData.products = {
        create: productIds.map(productId => ({
          productId
        }))
      };
    }

    // Add type and sharedVia only if provided (for backward compatibility)
    if (type) {
      leadData.type = type;
    }
    if (sharedVia) {
      leadData.sharedVia = sharedVia;
    }
    if (bandwidthRequirement) {
      leadData.bandwidthRequirement = bandwidthRequirement;
    }

    // Create lead + update campaign data atomically in a transaction
    const lead = await prisma.$transaction(async (tx) => {
      const newLead = await tx.lead.create({
        data: leadData,
        include: {
          campaignData: {
            include: {
              campaign: {
                select: { id: true, code: true, name: true }
              }
            }
          },
          createdBy: {
            select: { id: true, name: true, email: true }
          },
          assignedTo: {
            select: { id: true, name: true, email: true }
          },
          products: {
            include: {
              product: {
                select: { id: true, title: true }
              }
            }
          }
        }
      });

      // Update campaign data status to INTERESTED
      await tx.campaignData.update({
        where: { id: campaignDataId },
        data: { status: 'INTERESTED' }
      });

      return newLead;
    });

    // Notify assigned BDM if one is assigned
    if (lead.assignedTo) {
      notifyLeadConverted(lead.assignedTo.id, {
        id: lead.id,
        company: lead.campaignData.company,
        createdByName: lead.createdBy.name,
        campaignName: lead.campaignData.campaign.name
      });
      emitSidebarRefresh(lead.assignedTo.id);
    }
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      lead,
      message: 'Successfully converted to lead.'
    });
});

// Create a lead directly from the BDM queue — used when a BDM already has
// their own lead (walk-in, referral, existing relationship) and wants to
// skip the ISR calling step entirely. Mirrors what the ISR "Interested"
// disposition does: it creates a CampaignData row + a Lead in one transaction.
export const createDirectLead = asyncHandler(async function createDirectLead(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Only BDM-family roles can add direct leads to their own queue
    if (!['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'].includes(userRole)) {
      return res.status(403).json({ message: 'Only BDM users can add direct leads.' });
    }

    const {
      // Contact fields (required)
      name,
      company,
      phone,
      // Contact fields (optional)
      email,
      title,
      industry,
      city,
      // Lead-specific fields
      productIds,
      bandwidthRequirement,
      notes,
    } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ message: 'Full name is required.' });
    if (!company || !company.trim()) return res.status(400).json({ message: 'Company is required.' });
    if (!phone || !phone.trim()) return res.status(400).json({ message: 'Phone number is required.' });
    if (!email || !email.trim()) return res.status(400).json({ message: 'Email is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    const phoneDigits = String(phone).replace(/\D/g, '');
    if (phoneDigits.length !== 10) {
      return res.status(400).json({ message: 'Phone number must be exactly 10 digits.' });
    }

    // Global dedup against existing campaign data
    const existingPhone = await prisma.campaignData.findFirst({
      where: { phone: phoneDigits },
      select: { id: true }
    });
    if (existingPhone) {
      return res.status(400).json({ message: 'A contact with this phone number already exists.' });
    }

    // Find or create a reusable [BDM Self Lead] campaign for this BDM so we
    // don't bloat the campaign list with one campaign per manually-added lead.
    const campaignName = `[BDM Self Lead] ${req.user.name || req.user.email}`;
    let selfLeadCampaign = await prisma.campaign.findFirst({
      where: { createdById: userId, name: campaignName, type: 'SELF' },
      select: { id: true }
    });

    if (!selfLeadCampaign) {
      // Generate a unique code with retry on collision
      let retries = 3;
      while (retries > 0) {
        try {
          const latest = await prisma.campaign.findFirst({
            where: { code: { startsWith: 'CMP' } },
            orderBy: { code: 'desc' },
            select: { code: true }
          });
          let maxNumber = 0;
          if (latest?.code) {
            const match = latest.code.match(/CMP(\d+)/);
            if (match) maxNumber = parseInt(match[1], 10);
          }
          const code = `CMP${String(maxNumber + 1).padStart(3, '0')}`;
          selfLeadCampaign = await prisma.campaign.create({
            data: {
              code,
              name: campaignName,
              description: 'Direct leads added by BDM (no ISR call)',
              type: 'SELF',
              status: 'ACTIVE',
              dataSource: 'BDM Direct Add',
              createdById: userId,
            },
            select: { id: true }
          });
          // Self-assign so the creator sees the campaign in queues that filter by assignment
          await prisma.campaignAssignment.create({
            data: { userId, campaignId: selfLeadCampaign.id }
          });
          break;
        } catch (err) {
          if (err.code === 'P2002' && retries > 1) {
            retries--;
            continue;
          }
          throw err;
        }
      }
    }

    // Validate products if provided
    if (productIds && productIds.length > 0) {
      const foundProducts = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true }
      });
      if (foundProducts.length !== productIds.length) {
        return res.status(400).json({ message: 'One or more selected products are invalid.' });
      }
    }

    const leadNumber = await generateLeadNumber();

    // Create CampaignData + Lead atomically
    const result = await prisma.$transaction(async (tx) => {
      const campaignData = await tx.campaignData.create({
        data: {
          campaignId: selfLeadCampaign.id,
          name: name.trim(),
          company: company.trim(),
          phone: phoneDigits,
          // `title` is a required column on CampaignData — fall back to a placeholder
          // when the BDM doesn't supply one (we already ask for it in the form).
          title: title?.trim() || '-',
          email: email?.trim() || null,
          industry: industry?.trim() || null,
          city: city?.trim() || null,
          status: 'INTERESTED',
          assignedToId: userId,
          assignedByBdmId: userId,
          isSelfGenerated: true,
          createdById: userId,
        }
      });

      const lead = await tx.lead.create({
        data: {
          campaignDataId: campaignData.id,
          leadNumber,
          requirements: notes?.trim() || null,
          bandwidthRequirement: bandwidthRequirement?.trim() || null,
          createdById: userId,
          assignedToId: userId,
          status: 'NEW',
          type: 'QUALIFIED',
          ...(productIds && productIds.length > 0 && {
            products: { create: productIds.map((productId) => ({ productId })) }
          })
        },
        include: {
          campaignData: {
            include: {
              campaign: { select: { id: true, code: true, name: true } }
            }
          },
          assignedTo: { select: { id: true, name: true, email: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          products: { include: { product: { select: { id: true, title: true } } } }
        }
      });

      return lead;
    });

    emitSidebarRefresh(userId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      lead: result,
      message: 'Lead created successfully.'
    });
});

// Helper function to format lead response
// Use campaignData as single source of truth for contact info and linkedinUrl
const formatLeadResponse = (lead) => ({
  id: lead.id,
  requirements: lead.requirements,
  status: lead.status,
  type: lead.type,
  // Engagement data - prefer Lead fields, fallback to CampaignData
  sharedVia: lead.sharedVia || lead.campaignData.sharedVia || [],
  linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
  createdAt: lead.createdAt,
  updatedAt: lead.updatedAt,
  // Contact details from campaign data
  company: lead.campaignData.company,
  name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
  firstName: lead.campaignData.firstName,
  lastName: lead.campaignData.lastName,
  title: lead.campaignData.title,
  email: lead.campaignData.email,
  phone: lead.campaignData.phone,
  whatsapp: lead.campaignData.whatsapp,
  industry: lead.campaignData.industry,
  city: lead.campaignData.city,
  state: lead.campaignData.state,
  source: lead.campaignData.source,
  // Self-generated info
  isSelfGenerated: lead.campaignData.isSelfGenerated || false,
  dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
  // Campaign info
  campaign: lead.campaignData.campaign,
  // Users
  createdBy: lead.createdBy,
  assignedTo: lead.assignedTo,
  // Products
  products: lead.products.map(lp => lp.product),
  // Keep campaignDataId for reference
  campaignDataId: lead.campaignDataId,
  // BDM location (entered during calls)
  location: lead.location,
  // Full address (entered during meeting outcome)
  fullAddress: lead.fullAddress,
  // Bandwidth requirement (set by BDM during meeting outcome)
  bandwidthRequirement: lead.bandwidthRequirement,
  // Number of IPs (set by BDM during meeting outcome)
  numberOfIPs: lead.numberOfIPs,
  // Interest level (set by BDM during meeting outcome)
  interestLevel: lead.interestLevel,
  // OPS approval status
  opsApprovalStatus: lead.opsApprovalStatus,
  opsRejectedReason: lead.opsRejectedReason,
  opsApprovedAt: lead.opsApprovedAt,
  // Docs verification fields
  documents: lead.documents || [],
  docsVerifiedAt: lead.docsVerifiedAt,
  docsVerifiedById: lead.docsVerifiedById,
  docsRejectedReason: lead.docsRejectedReason,
  verificationAttempts: lead.verificationAttempts || 0,
  // Accounts verification fields
  accountsVerifiedAt: lead.accountsVerifiedAt,
  accountsRejectedReason: lead.accountsRejectedReason,
  arcAmount: lead.arcAmount,
  otcAmount: lead.otcAmount,
  advanceAmount: lead.advanceAmount,
  paymentTerms: lead.paymentTerms,
  // Installation fields
  pushedToInstallationAt: lead.pushedToInstallationAt,
  installationNotes: lead.installationNotes,
  // Feasibility fields
  feasibilityNotes: lead.feasibilityNotes,
  feasibilityReviewedAt: lead.feasibilityReviewedAt,
  // Document upload method
  docUploadMethod: lead.docUploadMethod
});

// Update lead
export const updateLead = asyncHandler(async function updateLead(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const {
      requirements, status, assignedToId, productIds, type, sharedVia, linkedinUrl,
      // Contact details (CampaignData fields)
      company, name, firstName, lastName, title, email, phone, whatsapp, industry, city,
      // Quotation fields
      bandwidthRequirement, arcAmount, otcAmount, quotationAttachments,
      // OPS approval fields
      opsApprovalStatus
    } = req.body;

    const existing = await prisma.lead.findUnique({
      where: { id },
      include: { campaignData: true }
    });
    if (!existing) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Authorization: Only admin or the assigned BDM/TL can update a lead
    const isUserAdmin = isAdminOrTestUser(req.user);
    const isAssignedBDM = existing.assignedToId === userId;
    const isCreator = existing.createdById === userId;
    const isBDMOrTL = hasAnyRole(req.user, ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER']);

    if (!isUserAdmin && !(isBDMOrTL && (isAssignedBDM || isCreator))) {
      return res.status(403).json({ message: 'You can only update leads assigned to or created by you.' });
    }

    // Only admin can change sensitive fields
    if (!isUserAdmin) {
      if (opsApprovalStatus !== undefined) {
        // BDM/TL can submit for OPS approval (set to PENDING), but only admin can APPROVE/REJECT
        const canSubmitForApproval = isBDMOrTL && opsApprovalStatus === 'PENDING';
        if (!canSubmitForApproval) {
          return res.status(403).json({ message: 'Only admin can approve or reject OPS approval status.' });
        }
      }
      if (assignedToId !== undefined && assignedToId !== existing.assignedToId) {
        return res.status(403).json({ message: 'Only admin can reassign leads.' });
      }
    }

    // BDM/BDM_CP cannot change status from leads table - must use call disposition
    if ((userRole === 'BDM' || userRole === 'BDM_CP') && status !== undefined) {
      return res.status(403).json({
        message: 'BDM cannot change lead status directly. Use call disposition instead.'
      });
    }

    // Update lead fields
    const updateData = {};
    if (requirements !== undefined) updateData.requirements = requirements;
    if (status !== undefined) updateData.status = status;
    if (assignedToId !== undefined) updateData.assignedToId = assignedToId;
    if (type !== undefined) updateData.type = type;
    if (sharedVia !== undefined) updateData.sharedVia = sharedVia;
    if (linkedinUrl !== undefined) updateData.linkedinUrl = linkedinUrl;
    // Quotation fields
    if (bandwidthRequirement !== undefined) updateData.bandwidthRequirement = bandwidthRequirement;
    if (arcAmount !== undefined) {
      updateData.arcAmount = parseFloat(arcAmount) || 0;
      // Set original ARC if not already captured
      if (existing.originalArcAmount === null) {
        updateData.originalArcAmount = parseFloat(arcAmount) || 0;
      }
    }
    if (otcAmount !== undefined) updateData.otcAmount = parseFloat(otcAmount) || 0;
    if (quotationAttachments !== undefined) updateData.quotationAttachments = quotationAttachments;
    // OPS approval fields
    if (opsApprovalStatus !== undefined) {
      updateData.opsApprovalStatus = opsApprovalStatus;
      // When resubmitting to OPS, clear SA2 approval fields
      if (opsApprovalStatus === 'PENDING') {
        updateData.superAdmin2ApprovalStatus = null;
        updateData.superAdmin2ApprovedAt = null;
        updateData.superAdmin2ApprovedById = null;
        updateData.superAdmin2RejectedReason = null;
      }
    }

    // Update CampaignData fields (contact details)
    const campaignDataUpdate = {};
    if (company !== undefined) campaignDataUpdate.company = company;
    if (name !== undefined) campaignDataUpdate.name = name;
    if (firstName !== undefined) campaignDataUpdate.firstName = firstName;
    if (lastName !== undefined) campaignDataUpdate.lastName = lastName;
    if (title !== undefined) campaignDataUpdate.title = title;
    if (email !== undefined) campaignDataUpdate.email = email;
    if (phone !== undefined) campaignDataUpdate.phone = phone;
    if (whatsapp !== undefined) campaignDataUpdate.whatsapp = whatsapp;
    if (industry !== undefined) campaignDataUpdate.industry = industry;
    if (city !== undefined) campaignDataUpdate.city = city;

    // Update CampaignData if there are changes
    if (Object.keys(campaignDataUpdate).length > 0) {
      await prisma.campaignData.update({
        where: { id: existing.campaignDataId },
        data: campaignDataUpdate
      });
    }

    // If productIds is provided, update the products
    if (productIds !== undefined) {
      // Delete existing products
      await prisma.leadProduct.deleteMany({
        where: { leadId: id }
      });

      // Add new products
      if (productIds.length > 0) {
        await prisma.leadProduct.createMany({
          data: productIds.map(productId => ({
            leadId: id,
            productId
          }))
        });
      }
    }

    // Update lead data
    if (Object.keys(updateData).length > 0) {
      await prisma.lead.update({
        where: { id },
        data: updateData
      });
    }

    // Fetch updated lead with all relations
    const updatedLead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: {
              select: { id: true, code: true, name: true }
            },
            createdBy: {
              select: { id: true, name: true, email: true }
            }
          }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: {
              select: { id: true, title: true }
            }
          }
        }
      }
    });

    // Format and return the response
    const formattedLead = formatLeadResponse(updatedLead);
    res.json({ lead: formattedLead, message: 'Lead updated successfully.' });
});

// Delete lead
export const deleteLead = asyncHandler(async function deleteLead(req, res) {
    const { id } = req.params;

    const existing = await prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    await prisma.lead.delete({ where: { id } });

    res.json({ message: 'Lead deleted successfully.' });
});

// Get BDM users for assignment dropdown
export const getBDMUsers = asyncHandler(async function getBDMUsers(req, res) {
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');

    // Team leader sees themselves + their team members
    const whereClause = isTL
      ? { isActive: true, OR: [{ role: 'BDM', teamLeaderId: req.user.id }, { id: req.user.id }] }
      : { role: 'BDM', isActive: true };

    const bdmUsers = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        email: true
      },
      orderBy: { name: 'asc' }
    });

    res.json({ users: bdmUsers });
});

// Get BDM Team Leaders for assignment dropdown (ISR uses this)
export const getTeamLeaders = asyncHandler(async function getTeamLeaders(req, res) {
    const teamLeaders = await prisma.user.findMany({
      where: {
        role: 'BDM_TEAM_LEADER',
        isActive: true
      },
      select: {
        id: true,
        name: true,
        email: true
      },
      orderBy: { name: 'asc' }
    });

    res.json({ users: teamLeaders });
});

// Check if campaign data is already converted
export const checkLeadExists = asyncHandler(async function checkLeadExists(req, res) {
    const { campaignDataId } = req.params;

    const lead = await prisma.lead.findUnique({
      where: { campaignDataId }
    });

    res.json({ exists: !!lead, leadId: lead?.id });
});

// ========== BDM FUNCTIONS ==========

// Get BDM calling queue (leads assigned to BDM with NEW status only)
export const getBDMQueue = asyncHandler(async function getBDMQueue(req, res) {
    const userId = req.user.id;
    const isBDM = hasRole(req.user, 'BDM');
    const isBDMCP = hasRole(req.user, 'BDM_CP');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);
    const { campaignId } = req.query;

    if (!isBDM && !isBDMCP && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only BDM, BDM(CP), Team Leader, or Admin can access this endpoint.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 50);

    // Admins/MASTER see all, TLs see their own + team's leads, BDMs see only their assigned leads
    // Cold leads live in their dedicated Lead Pipeline tab and are hidden here.
    let whereClause = { isColdLead: false };
    if (isAdmin) {
      // Admin/MASTER: see all leads — only the cold filter above applies
    } else if (isTL) {
      const teamMemberIds = (await prisma.user.findMany({
        where: { teamLeaderId: userId, isActive: true },
        select: { id: true }
      })).map(u => u.id);
      whereClause.assignedToId = { in: [userId, ...teamMemberIds] };
    } else if (isBDMCP) {
      whereClause.assignedToId = userId;
      whereClause.vendorId = { not: null };
      whereClause.vendor = { category: 'CHANNEL_PARTNER' };
    } else if (isBDM) {
      whereClause.assignedToId = userId;
    }
    const statsWhere = campaignId
      ? { ...whereClause, campaignData: { campaignId } }
      : whereClause;

    // Get stats using groupBy (single query instead of fetching all leads)
    const [statusCounts, campaignsList, queueTotal, meetingsDoneCount] = await Promise.all([
      prisma.lead.groupBy({
        by: ['status'],
        where: statsWhere,
        _count: { status: true }
      }),
      // Get campaigns for dropdown
      prisma.lead.findMany({
        where: whereClause,
        select: {
          campaignData: {
            select: {
              campaign: { select: { id: true, code: true, name: true } },
              createdBy: { select: { id: true, name: true } },
              assignedToId: true,
              isSelfGenerated: true
            }
          }
        },
        distinct: ['campaignDataId']
      }),
      // Count for pagination (Admin/MASTER: all; TL: own working + team NEW; others: only NEW)
      prisma.lead.count({
        where: {
          ...whereClause,
          ...(isAdmin
            ? {}
            : isTL
              ? {
                  OR: [
                    { status: 'NEW' },
                    { assignedToId: userId, status: { in: ['FOLLOW_UP', 'MEETING_SCHEDULED', 'QUALIFIED', 'FEASIBLE', 'NOT_FEASIBLE', 'DROPPED'] } }
                  ]
                }
              : { status: 'NEW' }
          ),
          ...(campaignId && { campaignData: { campaignId } })
        }
      }),
      // Meetings done: leads where meetingDate was set and status moved past MEETING_SCHEDULED
      prisma.lead.count({
        where: {
          ...statsWhere,
          meetingDate: { not: null },
          status: { notIn: ['MEETING_SCHEDULED', 'NEW'] }
        }
      })
    ]);

    // Build stats from groupBy
    const statusMap = new Map(statusCounts.map(s => [s.status, s._count.status]));
    const totalCount = statusCounts.reduce((sum, s) => sum + s._count.status, 0);
    const stats = {
      total: totalCount,
      pending: statusMap.get('NEW') || 0,
      meetingScheduled: statusMap.get('MEETING_SCHEDULED') || 0,
      meetingsDone: meetingsDoneCount,
      qualified: statusMap.get('QUALIFIED') || 0,
      followUp: statusMap.get('FOLLOW_UP') || 0,
      dropped: statusMap.get('DROPPED') || 0,
      feasible: statusMap.get('FEASIBLE') || 0,
      notFeasible: statusMap.get('NOT_FEASIBLE') || 0
    };

    // Build campaigns for dropdown
    const campaignsMap = new Map();
    const assignedToIds = new Set();

    campaignsList.forEach(item => {
      const cd = item.campaignData;
      if (cd.campaign) {
        const campaign = cd.campaign;
        if (!campaignsMap.has(campaign.id)) {
          campaignsMap.set(campaign.id, {
            ...campaign,
            createdBy: cd.createdBy || null,
            _assignedToId: !cd.createdBy ? cd.assignedToId : null
          });
          if (!cd.createdBy && cd.assignedToId) {
            assignedToIds.add(cd.assignedToId);
          }
        }
      }
    });

    // Lookup users for campaigns where createdBy is null (older data)
    if (assignedToIds.size > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: Array.from(assignedToIds) } },
        select: { id: true, name: true }
      });
      const usersMap = new Map(users.map(u => [u.id, u]));

      campaignsMap.forEach((campaign, id) => {
        if (!campaign.createdBy && campaign._assignedToId) {
          campaign.createdBy = usersMap.get(campaign._assignedToId) || null;
        }
        delete campaign._assignedToId;
      });
    }

    const campaigns = Array.from(campaignsMap.values());

    // Admin/MASTER: show all statuses; TL: own working + team NEW; BDM: only NEW
    const statusFilter = isAdmin
      ? {}
      : isTL
        ? {
            OR: [
              { status: 'NEW' },
              { assignedToId: userId, status: { in: ['FOLLOW_UP', 'MEETING_SCHEDULED', 'QUALIFIED', 'FEASIBLE', 'NOT_FEASIBLE', 'DROPPED'] } }
            ]
          }
        : { status: 'NEW' };

    const queueLeads = await prisma.lead.findMany({
      where: {
        ...whereClause,
        ...statusFilter,
        ...(campaignId && {
          campaignData: {
            campaignId: campaignId
          }
        })
      },
      take: limit,
      skip,
      orderBy: [
        { createdAt: 'desc' }
      ],
      select: {
        id: true,
        assignedToId: true,
        requirements: true,
        status: true,
        type: true,
        location: true,
        callLaterAt: true,
        createdAt: true,
        meetingDate: true,
        meetingPlace: true,
        meetingNotes: true,
        meetingOutcome: true,
        sharedVia: true,
        linkedinUrl: true,
        assignedTo: { select: { id: true, name: true } },
        campaignData: {
          select: {
            company: true,
            name: true,
            firstName: true,
            lastName: true,
            title: true,
            email: true,
            phone: true,
            whatsapp: true,
            city: true,
            state: true,
            industry: true,
            linkedinUrl: true,
            isSelfGenerated: true,
            campaign: {
              select: { id: true, code: true, name: true }
            },
            createdBy: {
              select: { id: true, name: true, email: true }
            },
            callLogs: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                id: true,
                createdAt: true,
                notes: true,
                user: { select: { id: true, name: true } }
              }
            }
          }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        products: {
          select: {
            product: { select: { id: true, title: true } }
          }
        },
        enquiryCreatedFrom: {
          select: {
            id: true,
            enquiryNumber: true,
            referredByLead: {
              select: { campaignData: { select: { company: true } } }
            }
          }
        },
        vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } }
      }
    });

    // Format response
    // Use campaignData as single source of truth for contact info and linkedinUrl
    const formattedLeads = queueLeads.map(lead => ({
      id: lead.id,
      assignedToId: lead.assignedToId,
      assignedTo: lead.assignedTo,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      callLaterAt: lead.callLaterAt,
      createdAt: lead.createdAt,
      // Meeting fields
      meetingDate: lead.meetingDate,
      meetingPlace: lead.meetingPlace,
      meetingNotes: lead.meetingNotes,
      meetingOutcome: lead.meetingOutcome,
      // Engagement data - sharedVia is on Lead only, linkedinUrl exists on both (prefer Lead, fallback to CampaignData)
      sharedVia: lead.sharedVia || '',
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // Last call info
      lastCall: lead.campaignData.callLogs[0] || null,
      // Products
      products: lead.products.map(lp => lp.product),
      // Created by (ISR who generated the lead)
      createdBy: lead.createdBy,
      // Customer enquiry info (if lead was created from an enquiry)
      isCustomerReferral: !!lead.enquiryCreatedFrom,
      referredByCompany: lead.enquiryCreatedFrom?.referredByLead?.campaignData?.company || null,
      // Vendor / Channel Partner info
      vendor: lead.vendor
    }));

    res.json(paginatedResponse({ data: formattedLeads, total: queueTotal, page, limit, dataKey: 'leads', extra: { stats, campaigns } }));
});

// Reassign lead from Team Leader to a BDM in their team
export const reassignLeadToBDM = asyncHandler(async function reassignLeadToBDM(req, res) {
    const { id } = req.params;
    const { bdmId } = req.body;
    const userId = req.user.id;
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Team Leader or Admin can reassign leads.' });
    }

    if (!bdmId) {
      return res.status(400).json({ message: 'BDM ID is required.' });
    }

    // Validate BDM exists and is in team leader's team (if not admin)
    const bdm = await prisma.user.findUnique({
      where: { id: bdmId },
      select: { id: true, name: true, role: true, isActive: true, teamLeaderId: true }
    });

    if (!bdm || !['BDM', 'BDM_TEAM_LEADER'].includes(bdm.role) || !bdm.isActive) {
      return res.status(400).json({ message: 'Invalid BDM user.' });
    }

    // TL can assign to themselves or their team members
    if (isTL && bdm.id !== userId && bdm.teamLeaderId !== userId) {
      return res.status(403).json({ message: 'This BDM is not in your team.' });
    }

    // Validate lead exists
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, assignedToId: true, status: true, campaignData: { select: { company: true } } }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Update lead assignment
    // When TL self-assigns, also mark as FOLLOW_UP so it moves from "Unassigned" to "My Leads"
    const isSelfAssign = isTL && bdmId === userId;
    const updateData = { assignedToId: bdmId };
    if (isSelfAssign && lead.status === 'NEW') {
      updateData.status = 'FOLLOW_UP';
    }
    const updatedLead = await prisma.lead.update({
      where: { id },
      data: updateData,
      select: { id: true, assignedToId: true, status: true }
    });

    // If this lead was created from a customer enquiry, mark it as UNDER_REVIEW
    const linkedEnquiry = await prisma.customerEnquiry.findUnique({
      where: { createdLeadId: id },
      select: { id: true, status: true }
    });
    if (linkedEnquiry && linkedEnquiry.status === 'SUBMITTED') {
      await prisma.customerEnquiry.update({
        where: { id: linkedEnquiry.id },
        data: { status: 'UNDER_REVIEW' }
      });
    }

    // Notify the BDM
    await createNotification(
      bdmId,
      'LEAD_ASSIGNED',
      'Lead Assigned',
      `Lead ${lead.campaignData?.company || 'Unknown'} has been assigned to you by Team Leader.`,
      { leadId: id }
    );
    emitSidebarRefresh(bdmId);

    res.json({ message: 'Lead reassigned successfully.', data: updatedLead });
});

// Bulk reassign leads from Team Leader to BDM
export const bulkReassignLeadsToBDM = asyncHandler(async function bulkReassignLeadsToBDM(req, res) {
    const { leadIds, bdmId } = req.body;
    const userId = req.user.id;
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Team Leader or Admin can reassign leads.' });
    }

    if (!bdmId || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ message: 'BDM ID and at least one lead are required.' });
    }

    if (leadIds.length > 100) {
      return res.status(400).json({ message: 'Cannot assign more than 100 leads at once.' });
    }

    // Validate BDM exists and is in team leader's team
    const bdm = await prisma.user.findUnique({
      where: { id: bdmId },
      select: { id: true, name: true, role: true, isActive: true, teamLeaderId: true }
    });

    if (!bdm || !['BDM', 'BDM_TEAM_LEADER'].includes(bdm.role) || !bdm.isActive) {
      return res.status(400).json({ message: 'Invalid BDM user.' });
    }

    // TL can assign to themselves or their team members
    if (isTL && bdm.id !== userId && bdm.teamLeaderId !== userId) {
      return res.status(403).json({ message: 'This BDM is not in your team.' });
    }

    // Bulk update all leads in a transaction
    // When TL self-assigns, also mark NEW leads as FOLLOW_UP
    const isSelfAssign = isTL && bdmId === userId;
    const result = await prisma.$transaction(async (tx) => {
      if (isSelfAssign) {
        await tx.lead.updateMany({
          where: { id: { in: leadIds }, status: 'NEW' },
          data: { assignedToId: bdmId, status: 'FOLLOW_UP' }
        });
        await tx.lead.updateMany({
          where: { id: { in: leadIds }, status: { not: 'NEW' } },
          data: { assignedToId: bdmId }
        });
        return { count: leadIds.length };
      }
      const updated = await tx.lead.updateMany({
        where: { id: { in: leadIds } },
        data: { assignedToId: bdmId }
      });
      return updated;
    });

    // Single notification for the BDM
    await createNotification(
      bdmId,
      'LEAD_ASSIGNED',
      'Leads Assigned',
      `${result.count} lead${result.count > 1 ? 's have' : ' has'} been assigned to you by Team Leader.`,
      { leadIds }
    );
    emitSidebarRefresh(bdmId);

    res.json({ message: `${result.count} lead(s) assigned successfully.`, data: { count: result.count } });
});

// Transfer ALL leads from one BDM to another (when BDM leaves / full handover)
export const transferAllLeads = asyncHandler(async function transferAllLeads(req, res) {
    const { fromBdmId, toBdmId } = req.body;
    const userId = req.user.id;
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Team Leader or Admin can transfer leads.' });
    }

    if (!fromBdmId || !toBdmId) {
      return res.status(400).json({ message: 'Source BDM and target BDM are required.' });
    }

    if (fromBdmId === toBdmId) {
      return res.status(400).json({ message: 'Source and target BDM cannot be the same.' });
    }

    // Validate both BDMs exist
    const [fromBdm, toBdm] = await Promise.all([
      prisma.user.findUnique({
        where: { id: fromBdmId },
        select: { id: true, name: true, role: true, isActive: true, teamLeaderId: true }
      }),
      prisma.user.findUnique({
        where: { id: toBdmId },
        select: { id: true, name: true, role: true, isActive: true, teamLeaderId: true }
      })
    ]);

    if (!fromBdm || !['BDM', 'BDM_TEAM_LEADER'].includes(fromBdm.role)) {
      return res.status(400).json({ message: 'Invalid source BDM.' });
    }

    if (!toBdm || !['BDM', 'BDM_TEAM_LEADER'].includes(toBdm.role) || !toBdm.isActive) {
      return res.status(400).json({ message: 'Target BDM must be an active BDM user.' });
    }

    // TL can only transfer within their team
    if (isTL && !isAdmin) {
      const isFromInTeam = fromBdm.id === userId || fromBdm.teamLeaderId === userId;
      const isToInTeam = toBdm.id === userId || toBdm.teamLeaderId === userId;
      if (!isFromInTeam || !isToInTeam) {
        return res.status(403).json({ message: 'Both BDMs must be in your team.' });
      }
    }

    // Count leads before transfer for response
    const leadCount = await prisma.lead.count({
      where: { assignedToId: fromBdmId }
    });

    if (leadCount === 0) {
      return res.status(400).json({ message: `${fromBdm.name} has no leads to transfer.` });
    }

    // Count unconverted campaign data bound to this BDM
    const campaignDataCount = await prisma.campaignData.count({
      where: { assignedByBdmId: fromBdmId, lead: { is: null } }
    });

    // Execute transfer in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Transfer all leads
      const leadsUpdated = await tx.lead.updateMany({
        where: { assignedToId: fromBdmId },
        data: { assignedToId: toBdmId }
      });

      // 2. Transfer unconverted campaign data BDM binding
      let campaignDataUpdated = { count: 0 };
      if (campaignDataCount > 0) {
        campaignDataUpdated = await tx.campaignData.updateMany({
          where: { assignedByBdmId: fromBdmId, lead: { is: null } },
          data: { assignedByBdmId: toBdmId }
        });
      }

      // 3. Log the transfer as a status change for audit
      await tx.statusChangeLog.create({
        data: {
          entityType: 'LEAD',
          entityId: fromBdmId, // Using source BDM as reference
          field: 'BULK_TRANSFER',
          oldValue: fromBdm.name,
          newValue: toBdm.name,
          reason: `Transferred ${leadsUpdated.count} leads and ${campaignDataUpdated.count} campaign records from ${fromBdm.name} to ${toBdm.name}`,
          changedById: userId
        }
      });

      return {
        leadsTransferred: leadsUpdated.count,
        campaignDataTransferred: campaignDataUpdated.count
      };
    });

    // Notify the target BDM
    await createNotification(
      toBdmId,
      'LEAD_ASSIGNED',
      'Leads Transferred',
      `${result.leadsTransferred} lead(s) have been transferred to you from ${fromBdm.name}.`,
      { fromBdmId, transferredBy: userId }
    );
    emitSidebarRefresh(toBdmId);
    emitSidebarRefresh(fromBdmId);

    res.json({
      message: `Successfully transferred ${result.leadsTransferred} lead(s) and ${result.campaignDataTransferred} campaign record(s) from ${fromBdm.name} to ${toBdm.name}.`,
      data: result
    });
});

// Get BDM scheduled meetings
export const getBDMScheduledMeetings = asyncHandler(async function getBDMScheduledMeetings(req, res) {
    const isBDM = hasRole(req.user, 'BDM');
    const isBDMCP = hasRole(req.user, 'BDM_CP');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isBDM && !isBDMCP && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only BDM, BDM(CP), Team Leader or Admin can access this endpoint.' });
    }

    // Admin/TL can view a specific BDM's meetings via ?userId= query param
    // Admin/MASTER without userId param sees ALL meetings
    const targetUserId = (isAdmin || isTL) && req.query.userId ? req.query.userId : req.user.id;
    const showAll = isAdmin && !req.query.userId;

    // Get all scheduled meetings for this BDM (or all if admin without filter)
    const meetings = await prisma.lead.findMany({
      where: {
        ...(!showAll && { assignedToId: targetUserId }),
        status: 'MEETING_SCHEDULED'
      },
      orderBy: [
        { meetingDate: 'asc' }
      ],
      include: {
        campaignData: {
          include: {
            campaign: {
              select: { id: true, code: true, name: true }
            }
          }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Format response
    const formattedMeetings = meetings.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      location: lead.location,
      createdAt: lead.createdAt,
      // Meeting fields
      meetingDate: lead.meetingDate,
      meetingPlace: lead.meetingPlace,
      meetingNotes: lead.meetingNotes,
      meetingCount: lead.meetingCount || 1,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Bandwidth
      bandwidthRequirement: lead.bandwidthRequirement,
      // Products
      products: lead.products.map(lp => lp.product),
      // Created by
      createdBy: lead.createdBy
    }));

    // Separate today's meetings and upcoming
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todaysMeetings = formattedMeetings.filter(m => {
      const meetingDate = new Date(m.meetingDate);
      return meetingDate >= today && meetingDate < tomorrow;
    });

    const upcomingMeetings = formattedMeetings.filter(m => {
      const meetingDate = new Date(m.meetingDate);
      return meetingDate >= tomorrow;
    });

    const pastMeetings = formattedMeetings.filter(m => {
      const meetingDate = new Date(m.meetingDate);
      return meetingDate < today;
    });

    // Count completed meetings (leads that had meetings and have meetingOutcome set)
    const completedMeetingsCount = await prisma.lead.count({
      where: {
        ...(!showAll && { assignedToId: targetUserId }),
        meetingOutcome: { not: null }
      }
    });

    res.json({
      meetings: formattedMeetings,
      todaysMeetings,
      upcomingMeetings,
      pastMeetings,
      stats: {
        total: formattedMeetings.length,
        today: todaysMeetings.length,
        upcoming: upcomingMeetings.length,
        overdue: pastMeetings.length,
        completed: completedMeetingsCount
      }
    });
});

// Update lead location
export const updateLeadLocation = asyncHandler(async function updateLeadLocation(req, res) {
    const { id } = req.params;
    const { location } = req.body;

    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Authorization: Only admin or the assigned BDM can update location
    const isUserAdmin = isAdminOrTestUser(req.user);
    const isBDMOrTL = hasAnyRole(req.user, ['BDM', 'BDM_TEAM_LEADER']);
    if (!isUserAdmin && !(isBDMOrTL && lead.assignedToId === req.user.id)) {
      return res.status(403).json({ message: 'You can only update locations of leads assigned to you.' });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: { location }
    });

    res.json({ lead: updated, message: 'Location updated successfully.' });
});

// BDM call disposition - Schedule Meeting, Follow Up, Drop
// After meeting - Qualified (assign to FT), Drop
export const bdmDisposition = asyncHandler(async function bdmDisposition(req, res) {
    const { id } = req.params;
    const {
      disposition,
      notes,
      callLaterAt,
      dropReason,
      location,
      feasibilityAssignedToId,
      // Meeting fields
      meetingDate,
      meetingPlace,
      meetingNotes,
      meetingOutcome,
      // Source/POP Location (From)
      fromAddress,
      fromLatitude,
      fromLongitude,
      // Customer Location (To)
      latitude,
      longitude,
      fullAddress,
      // Service Requirements
      bandwidthRequirement,
      numberOfIPs,
      interestLevel,
      tentativePrice,
      otcAmount,
      // Billing Address
      billingAddress,
      billingPincode,
      // Expected Delivery Date
      expectedDeliveryDate,
      // Products
      productIds,
      // Cold Lead flag — when true and disposition is QUALIFIED, the lead is
      // parked in the Lead Pipeline tab with whatever partial data exists;
      // no required field validation runs and no feasibility assignment.
      isColdLead
    } = req.body;
    const bdmUserId = req.user.id;
    const bdmUserName = req.user.name;

    const validDispositions = ['MEETING_SCHEDULED', 'QUALIFIED', 'DROPPED', 'FOLLOW_UP', 'MEETING_LATER', 'NOT_REACHABLE', 'RINGING_NOT_PICKED'];
    if (!disposition || !validDispositions.includes(disposition)) {
      return res.status(400).json({ message: 'Valid disposition required.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        }
      }
    });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Only allow disposition for leads in valid BDM-actionable states
    const allowedStatuses = ['NEW', 'FOLLOW_UP', 'MEETING_SCHEDULED'];
    if (!allowedStatuses.includes(lead.status)) {
      return res.status(400).json({
        message: `Cannot disposition lead with status "${lead.status}". Only NEW, FOLLOW_UP, or MEETING_SCHEDULED leads can be dispositioned.`
      });
    }

    // Prepare update data
    const updateData = {
      status: disposition,
      updatedAt: new Date()
    };

    // Add location if provided
    if (location) {
      updateData.location = location;
    }

    // Handle MEETING_SCHEDULED - schedule a physical meeting
    if (disposition === 'MEETING_SCHEDULED') {
      if (!meetingDate) {
        return res.status(400).json({ message: 'Meeting date/time is required.' });
      }
      if (!meetingPlace) {
        return res.status(400).json({ message: 'Meeting place is required.' });
      }
      updateData.meetingDate = new Date(meetingDate);
      updateData.meetingPlace = meetingPlace;
      if (meetingNotes) {
        updateData.meetingNotes = meetingNotes;
      }
    }

    // Handle MEETING_LATER - reschedule meeting (after attending previous meeting)
    if (disposition === 'MEETING_LATER') {
      if (!meetingDate) {
        return res.status(400).json({ message: 'New meeting date/time is required.' });
      }
      if (!meetingPlace) {
        return res.status(400).json({ message: 'Meeting place is required.' });
      }
      // Increment meeting count
      updateData.meetingCount = (lead.meetingCount || 1) + 1;
      updateData.meetingDate = new Date(meetingDate);
      updateData.meetingPlace = meetingPlace;
      updateData.status = 'MEETING_SCHEDULED'; // Keep status as MEETING_SCHEDULED
      // Store outcome of previous meeting if provided
      if (meetingOutcome) {
        updateData.meetingOutcome = meetingOutcome;
      }
      if (meetingNotes) {
        updateData.meetingNotes = meetingNotes;
      }
    }

    // Handle FOLLOW_UP - schedule a follow-up call
    if (disposition === 'FOLLOW_UP') {
      if (!callLaterAt) {
        return res.status(400).json({ message: 'Follow-up date/time required.' });
      }
      updateData.callLaterAt = new Date(callLaterAt);
    }

    // Handle NOT_REACHABLE / RINGING_NOT_PICKED — treat as an auto follow-up:
    // land the lead in the BDM Follow-Ups tab with a 2-hour retry window and
    // an auto-prefixed note so the BDM remembers why it's there.
    if (disposition === 'NOT_REACHABLE' || disposition === 'RINGING_NOT_PICKED') {
      updateData.status = 'FOLLOW_UP';
      updateData.callLaterAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const autoNote = disposition === 'NOT_REACHABLE' ? 'Not reachable' : 'Ringing, not picked up';
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[${new Date().toLocaleString()}] ${autoNote}${notes ? ` — ${notes}` : ''}`
        : `${autoNote}${notes ? ` — ${notes}` : ''}`;
    }

    // Handle DROPPED
    if (disposition === 'DROPPED') {
      updateData.dropReason = dropReason || 'Not specified';
    }

    // Handle QUALIFIED with Feasibility Team assignment (after meeting)
    if (disposition === 'QUALIFIED') {
      if (isColdLead) {
        // Cold lead path: park with partial data, no feasibility assignment,
        // no required field validation. The BDM fills in whatever they have.
        updateData.isColdLead = true;
        // Meeting is still marked as done — the customer did have a meeting,
        // just a lukewarm one. We keep status=QUALIFIED so the existing
        // pipeline logic (meetingsDone stats, dashboards) continues to work.
      } else {
        if (!feasibilityAssignedToId) {
          return res.status(400).json({ message: 'Feasibility Team assignment is required.' });
        }
        if (!latitude || !longitude) {
          return res.status(400).json({ message: 'Location coordinates (lat/long) are required for feasibility check.' });
        }
        if (!fullAddress) {
          return res.status(400).json({ message: 'Full address is required for feasibility check.' });
        }
        if (!interestLevel) {
          return res.status(400).json({ message: 'Customer interest level is required.' });
        }
        updateData.feasibilityAssignedToId = feasibilityAssignedToId;
        updateData.isColdLead = false;
      }

      // Source/POP Location (From) — always optional
      if (fromAddress) {
        updateData.fromAddress = fromAddress;
      }
      if (fromLatitude !== undefined && fromLatitude !== null && fromLatitude !== '') {
        updateData.fromLatitude = parseFloat(fromLatitude);
      }
      if (fromLongitude !== undefined && fromLongitude !== null && fromLongitude !== '') {
        updateData.fromLongitude = parseFloat(fromLongitude);
      }

      // Customer Location (To) — required only on the non-cold path, but we
      // still persist anything the BDM did fill in on the cold path.
      if (latitude !== undefined && latitude !== null && latitude !== '') {
        updateData.latitude = parseFloat(latitude);
      }
      if (longitude !== undefined && longitude !== null && longitude !== '') {
        updateData.longitude = parseFloat(longitude);
      }
      if (fullAddress) updateData.fullAddress = fullAddress;
      if (interestLevel) updateData.interestLevel = interestLevel;

      // Service Requirements
      if (bandwidthRequirement) {
        updateData.bandwidthRequirement = bandwidthRequirement;
      }
      if (numberOfIPs !== undefined && numberOfIPs !== null && numberOfIPs !== '') {
        updateData.numberOfIPs = parseInt(numberOfIPs);
      }
      if (tentativePrice !== undefined && tentativePrice !== null && tentativePrice !== '') {
        updateData.tentativePrice = parseFloat(tentativePrice);
      }
      if (otcAmount !== undefined && otcAmount !== null && otcAmount !== '') {
        updateData.otcAmount = parseFloat(otcAmount);
      }

      // Billing Address
      if (billingAddress) {
        updateData.billingAddress = billingAddress;
      }
      if (billingPincode) {
        updateData.billingPincode = billingPincode;
      }

      // Expected Delivery Date
      if (expectedDeliveryDate) {
        updateData.expectedDeliveryDate = new Date(expectedDeliveryDate);
      }

      // Store meeting outcome if provided
      if (meetingOutcome) {
        updateData.meetingOutcome = meetingOutcome;
      }
    }

    // Update requirements/notes (skip when NOT_REACHABLE/RINGING_NOT_PICKED
    // already wrote the combined auto-note above)
    if (notes && disposition !== 'NOT_REACHABLE' && disposition !== 'RINGING_NOT_PICKED') {
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[${new Date().toLocaleString()}] ${notes}`
        : notes;
    }

    let updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        },
        feasibilityAssignedTo: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // Update products if provided
    if (productIds && Array.isArray(productIds) && productIds.length > 0) {
      // Delete existing product associations
      await prisma.leadProduct.deleteMany({
        where: { leadId: id }
      });

      // Create new product associations
      await prisma.leadProduct.createMany({
        data: productIds.map(productId => ({
          leadId: id,
          productId
        }))
      });

      // Re-fetch to get updated products
      updated = await prisma.lead.findUnique({
        where: { id },
        include: {
          campaignData: {
            include: {
              campaign: { select: { id: true, code: true, name: true } }
            }
          },
          products: {
            include: {
              product: { select: { id: true, title: true } }
            }
          },
          feasibilityAssignedTo: {
            select: { id: true, name: true, email: true }
          }
        }
      });
    }

    // Notify Feasibility Team member if assigned (skipped for cold leads)
    if (disposition === 'QUALIFIED' && !isColdLead && feasibilityAssignedToId) {
      notifyFeasibilityAssigned(feasibilityAssignedToId, {
        leadId: updated.id,
        company: updated.campaignData.company,
        bdmName: bdmUserName,
        campaignName: updated.campaignData.campaign?.name
      });
      emitSidebarRefresh(feasibilityAssignedToId);
      emitSidebarRefreshByRole('SUPER_ADMIN');
    }

    // Refresh BDM's own sidebar counts (queue, followUps, meetings all change on disposition)
    emitSidebarRefresh(bdmUserId);

    // Build success message
    let message = '';
    if (disposition === 'MEETING_SCHEDULED') {
      message = `Meeting scheduled for ${new Date(meetingDate).toLocaleString()} at ${meetingPlace}`;
    } else if (disposition === 'QUALIFIED') {
      message = isColdLead
        ? 'Cold lead saved to Lead Pipeline — complete the details when the customer provides them.'
        : 'Lead qualified and assigned to Feasibility Team';
    } else {
      message = `Lead marked as ${disposition.replace('_', ' ').toLowerCase()}`;
    }

    res.json({ lead: updated, message });
});

// Add MOM (Minutes of Meeting)
export const addMOM = asyncHandler(async function addMOM(req, res) {
    const { id } = req.params;
    const { meetingDate, attendees, agenda, discussion, nextSteps, followUpDate } = req.body;

    if (!discussion) {
      return res.status(400).json({ message: 'Discussion points are required.' });
    }

    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Only admin or users associated with this lead can add MOMs
    const isUserAdmin = isAdminOrTestUser(req.user);
    if (!isUserAdmin && lead.assignedToId !== req.user.id && lead.createdById !== req.user.id) {
      return res.status(403).json({ message: 'You can only add MOMs to leads assigned to you.' });
    }

    const mom = await prisma.mOM.create({
      data: {
        leadId: id,
        meetingDate: meetingDate ? new Date(meetingDate) : new Date(),
        attendees: attendees || null,
        agenda: agenda || null,
        discussion,
        nextSteps: nextSteps || null,
        followUpDate: followUpDate ? new Date(followUpDate) : null
      }
    });

    res.status(201).json({ mom, message: 'MOM added successfully.' });
});

// Get MOMs for a lead
export const getLeadMOMs = asyncHandler(async function getLeadMOMs(req, res) {
    const { id } = req.params;

    const moms = await prisma.mOM.findMany({
      where: { leadId: id },
      orderBy: { meetingDate: 'desc' }
    });

    res.json({ moms });
});

// Update MOM
export const updateMOM = asyncHandler(async function updateMOM(req, res) {
    const { momId } = req.params;
    const { meetingDate, attendees, agenda, discussion, nextSteps, followUpDate } = req.body;

    const existing = await prisma.mOM.findUnique({ where: { id: momId } });
    if (!existing) {
      return res.status(404).json({ message: 'MOM not found.' });
    }

    // Authorization: Only admin or users associated with the lead can update MOMs
    const lead = await prisma.lead.findUnique({ where: { id: existing.leadId }, select: { assignedToId: true, createdById: true } });
    const isUserAdmin = isAdminOrTestUser(req.user);
    if (!isUserAdmin && lead?.assignedToId !== req.user.id && lead?.createdById !== req.user.id) {
      return res.status(403).json({ message: 'You can only update MOMs on leads assigned to you.' });
    }

    const updateData = {};
    if (meetingDate !== undefined) updateData.meetingDate = new Date(meetingDate);
    if (attendees !== undefined) updateData.attendees = attendees;
    if (agenda !== undefined) updateData.agenda = agenda;
    if (discussion !== undefined) updateData.discussion = discussion;
    if (nextSteps !== undefined) updateData.nextSteps = nextSteps;
    if (followUpDate !== undefined) updateData.followUpDate = followUpDate ? new Date(followUpDate) : null;

    const mom = await prisma.mOM.update({
      where: { id: momId },
      data: updateData
    });

    res.json({ mom, message: 'MOM updated successfully.' });
});

// Delete MOM
export const deleteMOM = asyncHandler(async function deleteMOM(req, res) {
    const { momId } = req.params;

    const existing = await prisma.mOM.findUnique({ where: { id: momId } });
    if (!existing) {
      return res.status(404).json({ message: 'MOM not found.' });
    }

    // Authorization: Only admin or users associated with the lead can delete MOMs
    const lead = await prisma.lead.findUnique({ where: { id: existing.leadId }, select: { assignedToId: true, createdById: true } });
    const isUserAdmin = isAdminOrTestUser(req.user);
    if (!isUserAdmin && lead?.assignedToId !== req.user.id && lead?.createdById !== req.user.id) {
      return res.status(403).json({ message: 'You can only delete MOMs on leads assigned to you.' });
    }

    await prisma.mOM.delete({ where: { id: momId } });

    res.json({ message: 'MOM deleted successfully.' });
});

// Get BDM follow-ups
export const getBDMFollowUps = asyncHandler(async function getBDMFollowUps(req, res) {
    const userId = req.user.id;
    const isBDM = hasRole(req.user, 'BDM');
    const isBDMCP = hasRole(req.user, 'BDM_CP');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isBDM && !isBDMCP && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only BDM, BDM(CP), Team Leader or Admin can access this endpoint.' });
    }

    const leads = await prisma.lead.findMany({
      where: {
        ...(!isAdmin && { assignedToId: userId }),
        status: 'FOLLOW_UP',
        callLaterAt: { not: null }
      },
      orderBy: { callLaterAt: 'asc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        },
        moms: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    // Format response - flatten campaignData fields
    // Use campaignData as single source of truth for contact info and linkedinUrl
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      callLaterAt: lead.callLaterAt,
      dropReason: lead.dropReason,
      createdAt: lead.createdAt,
      // Engagement data - sharedVia is on Lead only, linkedinUrl exists on both (prefer Lead, fallback to CampaignData)
      sharedVia: lead.sharedVia || '',
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      // Contact details from campaignData
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Products
      products: lead.products.map(lp => lp.product),
      // Latest MOM
      latestMom: lead.moms[0] || null
    }));

    // Categorize by overdue, today, upcoming
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    const categorized = {
      overdue: formattedLeads.filter(l => new Date(l.callLaterAt) < today),
      dueToday: formattedLeads.filter(l => {
        const d = new Date(l.callLaterAt);
        return d >= today && d < tomorrow;
      }),
      upcoming: formattedLeads.filter(l => new Date(l.callLaterAt) >= tomorrow)
    };

    res.json({ followUps: formattedLeads, categorized });
});

// Get BDM delivery completed leads
export const getBDMDeliveryCompleted = asyncHandler(async function getBDMDeliveryCompleted(req, res) {
    const userId = req.user.id;
    const isBDM = hasRole(req.user, 'BDM');
    const isBDMCP = hasRole(req.user, 'BDM_CP');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isBDM && !isBDMCP && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only BDM, BDM(CP), Team Leader or Admin can access this endpoint.' });
    }

    const leads = await prisma.lead.findMany({
      where: {
        ...(!isAdmin && { assignedToId: userId }),
        deliveryStatus: 'COMPLETED'
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        },
        deliveryAssignedTo: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // Mark all unviewed completed deliveries as viewed (clears the sidebar badge)
    const unviewedLeadIds = leads
      .filter(lead => !lead.deliveryCompletedViewedAt)
      .map(lead => lead.id);

    if (unviewedLeadIds.length > 0) {
      await prisma.lead.updateMany({
        where: { id: { in: unviewedLeadIds } },
        data: { deliveryCompletedViewedAt: new Date() }
      });
    }

    // Format response
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      deliveryStatus: lead.deliveryStatus,
      deliveryNotes: lead.deliveryNotes,
      deliveryAssignedAt: lead.deliveryAssignedAt,
      deliveryAssignedTo: lead.deliveryAssignedTo,
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      // Contact details from campaignData
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Products
      products: lead.products.map(lp => lp.product)
    }));

    res.json({ leads: formattedLeads, total: formattedLeads.length });
});

// ========== END BDM FUNCTIONS ==========

// ========== FEASIBILITY TEAM FUNCTIONS ==========

// Get Feasibility Team users for assignment dropdown
export const getFeasibilityTeamUsers = asyncHandler(async function getFeasibilityTeamUsers(req, res) {
    const ftUsers = await prisma.user.findMany({
      where: {
        role: 'FEASIBILITY_TEAM',
        isActive: true
      },
      select: {
        id: true,
        name: true,
        email: true
      },
      orderBy: { name: 'asc' }
    });

    res.json({ users: ftUsers });
});

// Get Feasibility Team queue (leads assigned for feasibility review)
export const getFeasibilityQueue = asyncHandler(async function getFeasibilityQueue(req, res) {
    const userId = req.user.id;
    const isFT = hasRole(req.user, 'FEASIBILITY_TEAM');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isFT && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Feasibility Team can access this endpoint.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 50);

    // Date range for stats filtering
    const { period, fromDate, toDate } = req.query;
    let statsDateFilter = {};
    if (period === 'last7days') {
      statsDateFilter = { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
    } else if (period === 'last30days') {
      statsDateFilter = { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
    } else if (period === 'last90days') {
      statsDateFilter = { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) };
    } else if (period === 'custom' && fromDate && toDate) {
      statsDateFilter = { gte: new Date(fromDate), lte: new Date(new Date(toDate).setHours(23, 59, 59, 999)) };
    }

    // Get leads assigned to this FT member with QUALIFIED status
    // Admin/Team Leader sees all, FT sees only their assigned leads
    const whereClause = (isAdmin || isTL)
      ? { status: 'QUALIFIED' }
      : { feasibilityAssignedToId: userId, status: 'QUALIFIED' };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where: whereClause,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip,
        select: {
          id: true,
          requirements: true,
          status: true,
          type: true,
          location: true,
          latitude: true,
          longitude: true,
          fullAddress: true,
          bandwidthRequirement: true,
          numberOfIPs: true,
          fromAddress: true,
          fromLatitude: true,
          fromLongitude: true,
          createdAt: true,
          updatedAt: true,
          sharedVia: true,
          linkedinUrl: true,
          interestLevel: true,
          tentativePrice: true,
          arcAmount: true,
          billingAddress: true,
          billingPincode: true,
          expectedDeliveryDate: true,
          feasibilityNotes: true,
          feasibilityReviewedAt: true,
          campaignData: {
            select: {
              company: true,
              name: true,
              firstName: true,
              lastName: true,
              title: true,
              email: true,
              phone: true,
              whatsapp: true,
              city: true,
              state: true,
              industry: true,
              linkedinUrl: true,
              isSelfGenerated: true,
              campaign: { select: { id: true, code: true, name: true } },
              createdBy: { select: { id: true, name: true, email: true } }
            }
          },
          createdBy: {
            select: { id: true, name: true, email: true }
          },
          assignedTo: {
            select: { id: true, name: true, email: true }
          },
          products: {
            select: {
              product: { select: { id: true, title: true } }
            }
          },
          enquiryCreatedFrom: {
            select: { id: true }
          },
          vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } }
        }
      }),
      prisma.lead.count({ where: whereClause })
    ]);

    // Calculate stats
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);

    // Base where for all reviewed stats
    const baseReviewedWhere = { feasibilityAssignedToId: userId };

    // Period-filtered where (for total/approved/rejected/approvalRate)
    const periodWhere = statsDateFilter.gte
      ? { ...baseReviewedWhere, feasibilityReviewedAt: statsDateFilter }
      : baseReviewedWhere;

    const [reviewedToday, reviewedThisWeek, approvedToday, rejectedToday, totalApproved, totalRejected, totalReviewedInPeriod] = await Promise.all([
      // Today stats (always today, not affected by period)
      prisma.lead.count({ where: { ...baseReviewedWhere, feasibilityReviewedAt: { gte: todayStart } } }),
      prisma.lead.count({ where: { ...baseReviewedWhere, feasibilityReviewedAt: { gte: weekStart } } }),
      prisma.lead.count({ where: { ...baseReviewedWhere, status: 'FEASIBLE', feasibilityReviewedAt: { gte: todayStart } } }),
      prisma.lead.count({ where: { ...baseReviewedWhere, status: 'NOT_FEASIBLE', feasibilityReviewedAt: { gte: todayStart } } }),
      // Period-filtered totals
      prisma.lead.count({ where: { ...periodWhere, status: 'FEASIBLE' } }),
      prisma.lead.count({ where: { ...periodWhere, status: 'NOT_FEASIBLE' } }),
      statsDateFilter.gte
        ? prisma.lead.count({ where: { ...periodWhere, feasibilityReviewedAt: { not: null, ...statsDateFilter } } })
        : prisma.lead.count({ where: { ...baseReviewedWhere, feasibilityReviewedAt: { not: null } } }),
    ]);

    const stats = {
      pending: leads.length,
      reviewedToday,
      reviewedThisWeek,
      approvedToday,
      rejectedToday,
      totalApproved,
      totalRejected,
      totalReviewed: totalReviewedInPeriod,
      approvalRate: (totalApproved + totalRejected) > 0
        ? Math.round((totalApproved / (totalApproved + totalRejected)) * 100)
        : 0
    };

    // Format response
    // Use campaignData as single source of truth for contact info and linkedinUrl
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      // Location coordinates for feasibility check
      latitude: lead.latitude,
      longitude: lead.longitude,
      // Additional location details
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      // From/POP location details
      fromAddress: lead.fromAddress,
      fromLatitude: lead.fromLatitude,
      fromLongitude: lead.fromLongitude,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      // Engagement data - sharedVia is on Lead only, linkedinUrl exists on both (prefer Lead, fallback to CampaignData)
      sharedVia: lead.sharedVia || '',
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // Interest level (set by BDM during meeting outcome)
      interestLevel: lead.interestLevel,
      tentativePrice: lead.tentativePrice,
      arcAmount: lead.arcAmount,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product),
      // Customer referral info
      isCustomerReferral: !!lead.enquiryCreatedFrom,
      // Vendor / Channel Partner info
      vendor: lead.vendor
    }));

    res.json(paginatedResponse({ data: formattedLeads, total, page, limit, dataKey: 'leads', extra: { stats } }));
});

// Get feasibility review history (approved and rejected by current user)
export const getFeasibilityReviewHistory = asyncHandler(async function getFeasibilityReviewHistory(req, res) {
    const userId = req.user.id;
    const isFT = hasRole(req.user, 'FEASIBILITY_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isFT && !isAdmin) {
      return res.status(403).json({ message: 'Only Feasibility Team can access this endpoint.' });
    }

    const { filter = 'all' } = req.query; // all, approved, rejected

    // Build status filter
    let statusFilter = {};
    if (filter === 'approved') {
      statusFilter = { status: 'FEASIBLE' };
    } else if (filter === 'rejected') {
      statusFilter = { status: 'NOT_FEASIBLE' };
    } else {
      statusFilter = { status: { in: ['FEASIBLE', 'NOT_FEASIBLE'] } };
    }

    // Get leads reviewed by this FT member (Admin sees all)
    const whereClause = isAdmin
      ? { ...statusFilter }
      : { feasibilityAssignedToId: userId, ...statusFilter };

    const leads = await prisma.lead.findMany({
      where: whereClause,
      orderBy: { feasibilityReviewedAt: 'desc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } },
            createdBy: { select: { id: true, name: true, email: true } }
          }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Format response
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      latitude: lead.latitude,
      longitude: lead.longitude,
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      // From/POP location details
      fromAddress: lead.fromAddress,
      fromLatitude: lead.fromLatitude,
      fromLongitude: lead.fromLongitude,
      // Feasibility review info
      feasibilityReviewedAt: lead.feasibilityReviewedAt,
      feasibilityNotes: lead.feasibilityNotes,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // Interest level
      interestLevel: lead.interestLevel,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product)
    }));

    // Get counts for tabs
    const counts = {
      approved: await prisma.lead.count({
        where: { feasibilityAssignedToId: userId, status: 'FEASIBLE' }
      }),
      rejected: await prisma.lead.count({
        where: { feasibilityAssignedToId: userId, status: 'NOT_FEASIBLE' }
      })
    };

    res.json({ leads: formattedLeads, counts });
});

// Feasibility Team disposition - Feasible (Yes) or Not Feasible (No)
export const feasibilityDisposition = asyncHandler(async function feasibilityDisposition(req, res) {
    const { id } = req.params;
    const {
      decision,
      notes,
      // Simplified feasibility fields (vendor setup moved to delivery stage)
      vendorType,           // ownNetwork | fiberVendor | commissionVendor | thirdParty | telco
      tentativeCapex,
      tentativeOpex,
      feasibilityDescription,
      // POP Location
      popLocation,
      popLatitude,
      popLongitude,
      // Legacy fields — still accepted for backward compatibility but no longer required
      vendorInfo,
      vendorId,
    } = req.body;
    const ftUserId = req.user.id;
    const ftUserName = req.user.name;

    if (!decision || !['FEASIBLE', 'NOT_FEASIBLE'].includes(decision)) {
      return res.status(400).json({ message: 'Valid decision required (FEASIBLE, NOT_FEASIBLE).' });
    }

    if (decision === 'NOT_FEASIBLE' && !notes) {
      return res.status(400).json({ message: 'Notes are required when marking as not feasible.' });
    }

    // FEASIBLE requires vendor type (just the type — no vendor creation at this stage)
    const effectiveVendorType = vendorType || vendorInfo?.vendorType;
    if (decision === 'FEASIBLE' && !effectiveVendorType) {
      return res.status(400).json({ message: 'Vendor type is required when marking as feasible.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!isAdminOrTestUser(req.user) && lead.feasibilityAssignedToId !== ftUserId) {
      return res.status(403).json({ message: 'This lead is not assigned to you.' });
    }

    const updateData = {
      feasibilityReviewedAt: new Date(),
      updatedAt: new Date()
    };

    if (decision === 'FEASIBLE') {
      updateData.status = 'FEASIBLE';
      // Store the simplified feasibility data
      updateData.feasibilityVendorType = effectiveVendorType;
      if (tentativeCapex !== undefined && tentativeCapex !== null && tentativeCapex !== '') {
        updateData.tentativeCapex = parseFloat(tentativeCapex);
      }
      if (tentativeOpex !== undefined && tentativeOpex !== null && tentativeOpex !== '') {
        updateData.tentativeOpex = parseFloat(tentativeOpex);
      }
      if (feasibilityDescription) {
        updateData.feasibilityDescription = feasibilityDescription.trim();
      }
      // Store notes in feasibilityNotes for continuity
      updateData.feasibilityNotes = notes || feasibilityDescription || null;
      // POP Location
      if (popLocation) updateData.fromAddress = popLocation;
      if (popLatitude) updateData.fromLatitude = parseFloat(popLatitude);
      if (popLongitude) updateData.fromLongitude = parseFloat(popLongitude);
      // Legacy: if old-style vendorInfo was sent (from an older client), still save POP from it
      if (!popLocation && vendorInfo?.vendorDetails) {
        const vd = vendorInfo.vendorDetails;
        if (vd.popLocation) updateData.fromAddress = vd.popLocation;
        if (vd.popLatitude) updateData.fromLatitude = parseFloat(vd.popLatitude);
        if (vd.popLongitude) updateData.fromLongitude = parseFloat(vd.popLongitude);
      }
    } else {
      updateData.status = 'NOT_FEASIBLE';
      updateData.feasibilityAssignedToId = null;
      updateData.feasibilityNotes = notes || null;
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[FT Review - ${new Date().toLocaleString()}] NOT FEASIBLE: ${notes}`
        : `[FT Review - ${new Date().toLocaleString()}] NOT FEASIBLE: ${notes}`;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    if (lead.assignedToId) {
      if (decision === 'FEASIBLE') {
        notifyFeasibilityApproved(lead.assignedToId, {
          leadId: updated.id,
          company: updated.campaignData.company,
          ftUserName: ftUserName,
          notes: notes
        });
      } else if (decision === 'NOT_FEASIBLE') {
        notifyFeasibilityReturned(lead.assignedToId, {
          leadId: updated.id,
          company: updated.campaignData.company,
          ftUserName: ftUserName,
          notes: notes
        });
      }
      emitSidebarRefresh(lead.assignedToId);
    }
    emitSidebarRefresh(req.user.id);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: decision === 'FEASIBLE'
        ? 'Lead marked as feasible.'
        : 'Lead returned to BDM as not feasible.'
    });
});

// ========== END FEASIBILITY TEAM FUNCTIONS ==========

// ========== OPS TEAM FUNCTIONS ==========

/**
 * Get OPS Team queue (leads pending OPS approval before sharing quote with customer)
 * GET /leads/ops-team/queue
 */
export const getOpsTeamQueue = asyncHandler(async function getOpsTeamQueue(req, res) {
    const isOpsTeam = hasRole(req.user, 'OPS_TEAM');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isOpsTeam && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only OPS Team can access this endpoint.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 50);

    // Get leads that have been submitted for OPS approval (opsApprovalStatus = PENDING)
    // and have FEASIBLE status
    const opsWhere = {
      opsApprovalStatus: 'PENDING',
      status: 'FEASIBLE'
    };

    const [pendingLeads, total, approvedCount, rejectedCount] = await Promise.all([
      prisma.lead.findMany({
        where: opsWhere,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip,
        select: {
          id: true,
          requirements: true,
          status: true,
          type: true,
          location: true,
          fullAddress: true,
          bandwidthRequirement: true,
          numberOfIPs: true,
          interestLevel: true,
          createdAt: true,
          updatedAt: true,
          documents: true,
          opsApprovalStatus: true,
          opsRejectedReason: true,
          arcAmount: true,
          otcAmount: true,
          advanceAmount: true,
          paymentTerms: true,
          quotationAttachments: true,
          billingAddress: true,
          billingPincode: true,
          expectedDeliveryDate: true,
          linkedinUrl: true,
          feasibilityNotes: true,
          feasibilityReviewedAt: true,
          feasibilityVendorType: true,
          tentativeCapex: true,
          tentativeOpex: true,
          feasibilityDescription: true,
          campaignData: {
            select: {
              company: true,
              name: true,
              firstName: true,
              lastName: true,
              title: true,
              email: true,
              phone: true,
              whatsapp: true,
              industry: true,
              city: true,
              state: true,
              linkedinUrl: true,
              isSelfGenerated: true,
              campaign: { select: { id: true, code: true, name: true } },
              createdBy: { select: { id: true, name: true, email: true } }
            }
          },
          createdBy: {
            select: { id: true, name: true, email: true }
          },
          assignedTo: {
            select: { id: true, name: true, email: true }
          },
          products: {
            select: {
              product: { select: { id: true, title: true } }
            }
          },
          enquiryCreatedFrom: {
            select: { id: true }
          },
          vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } }
        }
      }),
      prisma.lead.count({ where: opsWhere }),
      prisma.lead.count({
        where: { opsApprovalStatus: 'APPROVED' }
      }),
      prisma.lead.count({
        where: { opsApprovalStatus: 'REJECTED' }
      })
    ]);

    // Calculate stats
    const stats = {
      pending: total,
      approved: approvedCount,
      rejected: rejectedCount
    };

    // Format response
    const formattedLeads = pendingLeads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      interestLevel: lead.interestLevel,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      // Documents
      documents: lead.documents || {},
      // OPS status
      opsApprovalStatus: lead.opsApprovalStatus,
      opsRejectedReason: lead.opsRejectedReason,
      // Financial details
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
      quotationAttachments: lead.quotationAttachments,
      // Campaign data
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      industry: lead.campaignData.industry,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      campaign: lead.campaignData.campaign,
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy,
      createdBy: lead.createdBy,
      assignedTo: lead.assignedTo,
      products: lead.products.map(lp => lp.product),
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt,
      // Customer referral info
      isCustomerReferral: !!lead.enquiryCreatedFrom,
      // Vendor / Channel Partner info
      vendor: lead.vendor
    }));

    res.json(paginatedResponse({ data: formattedLeads, total, page, limit, dataKey: 'leads', extra: { stats } }));
});

/**
 * Get OPS Team review history (approved/rejected leads)
 * GET /leads/ops-team/history
 */
export const getOpsTeamReviewHistory = asyncHandler(async function getOpsTeamReviewHistory(req, res) {
    const isOpsTeam = hasRole(req.user, 'OPS_TEAM');
    const { tab = 'approved' } = req.query;

    if (!isOpsTeam && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only OPS Team can access this endpoint.' });
    }

    // Get counts for tabs (always)
    const [approvedCount, rejectedCount] = await Promise.all([
      prisma.lead.count({ where: { opsApprovalStatus: 'APPROVED' } }),
      prisma.lead.count({ where: { opsApprovalStatus: 'REJECTED' } })
    ]);

    const counts = { approved: approvedCount, rejected: rejectedCount };

    // If tab is 'all', just return counts without fetching leads
    if (tab === 'all') {
      return res.json({ leads: [], counts });
    }

    // Build filter based on tab
    let whereClause = {};
    if (tab === 'approved') {
      whereClause = {
        opsApprovalStatus: 'APPROVED'
      };
    } else if (tab === 'rejected') {
      whereClause = {
        opsApprovalStatus: 'REJECTED'
      };
    }

    const leads = await prisma.lead.findMany({
      where: whereClause,
      orderBy: { opsApprovedAt: 'desc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } },
            createdBy: { select: { id: true, name: true, email: true } }
          }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        opsApprovedBy: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Format response
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      interestLevel: lead.interestLevel,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      // Documents
      documents: lead.documents || {},
      // OPS status
      opsApprovalStatus: lead.opsApprovalStatus,
      opsRejectedReason: lead.opsRejectedReason,
      opsApprovedAt: lead.opsApprovedAt,
      opsApprovedBy: lead.opsApprovedBy,
      // Financial details
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
      // Campaign data
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      industry: lead.campaignData.industry,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      campaign: lead.campaignData.campaign,
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy,
      createdBy: lead.createdBy,
      assignedTo: lead.assignedTo,
      products: lead.products.map(lp => lp.product),
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt
    }));

    res.json({ leads: formattedLeads, counts });
});

/**
 * OPS Team disposition (Approve / Reject)
 * POST /leads/ops-team/:id/disposition
 */
export const opsTeamDisposition = asyncHandler(async function opsTeamDisposition(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { decision, reason } = req.body;
    const isOpsTeam = hasRole(req.user, 'OPS_TEAM');

    if (!isOpsTeam && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only OPS Team can perform this action.' });
    }

    if (!decision || !['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ message: 'Valid decision (APPROVED/REJECTED) is required.' });
    }

    if (decision === 'REJECTED' && !reason) {
      return res.status(400).json({ message: 'Rejection reason is required.' });
    }

    // Find the lead
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (lead.opsApprovalStatus !== 'PENDING') {
      return res.status(400).json({ message: 'This lead is not pending OPS approval.' });
    }

    // Prepare update data
    const updateData = {
      opsApprovalStatus: decision,
      opsApprovedAt: new Date(),
      opsApprovedById: userId
    };

    if (decision === 'REJECTED') {
      updateData.opsRejectedReason = reason;
    } else {
      // Clear any previous rejection reason on approval
      updateData.opsRejectedReason = null;
      // Auto-send to Super Admin 2 for second approval
      updateData.superAdmin2ApprovalStatus = 'PENDING';
      updateData.superAdmin2ApprovedAt = null;
      updateData.superAdmin2ApprovedById = null;
      updateData.superAdmin2RejectedReason = null;
    }

    const updatedLead = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        createdBy: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } }
      }
    });

    // Sidebar refresh: OPS queue updated
    emitSidebarRefreshByRole('OPS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');
    if (decision === 'APPROVED') {
      // Notify Super Admin about new approval pending
      emitSidebarRefreshByRole('SUPER_ADMIN');
    }
    if (updatedLead.assignedTo) {
      emitSidebarRefresh(updatedLead.assignedTo.id);
    }

    res.json({
      success: true,
      lead: {
        id: updatedLead.id,
        opsApprovalStatus: updatedLead.opsApprovalStatus,
        opsRejectedReason: updatedLead.opsRejectedReason,
        opsApprovedAt: updatedLead.opsApprovedAt,
        sharedVia: updatedLead.sharedVia
      },
      message: decision === 'APPROVED'
        ? 'Quotation approved. Lead pushed to Docs Verification.'
        : 'Quotation rejected. BDM will be notified.'
    });
});

/**
 * Get OPS Team sidebar counts
 * GET /leads/ops-team/sidebar-counts
 */
export const getOpsTeamSidebarCounts = asyncHandler(async function getOpsTeamSidebarCounts(req, res) {
    const isOpsTeam = hasRole(req.user, 'OPS_TEAM');

    if (!isOpsTeam && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only OPS Team can access this endpoint.' });
    }

    const pendingCount = await prisma.lead.count({
      where: {
        opsApprovalStatus: 'PENDING',
        status: 'FEASIBLE'
      }
    });

    const installationPendingCount = await prisma.lead.count({
      where: {
        status: 'FEASIBLE',
        accountsStatus: 'ACCOUNTS_APPROVED',
        accountsVerifiedAt: { not: null },
        pushedToInstallationAt: null
      }
    });

    res.json({ pending: pendingCount, installationPending: installationPendingCount });
});

/**
 * Get leads pending installation assignment (for OPS team)
 * GET /leads/ops-team/installation-queue
 */
export const getOpsInstallationQueue = asyncHandler(async function getOpsInstallationQueue(req, res) {
    const isOpsTeam = hasRole(req.user, 'OPS_TEAM');
    if (!isOpsTeam && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only OPS Team can access this endpoint.' });
    }

    const { page = 1, limit = 50, search = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const whereClause = {
      status: 'FEASIBLE',
      accountsStatus: 'ACCOUNTS_APPROVED',
      accountsVerifiedAt: { not: null },
      pushedToInstallationAt: null
    };

    if (search) {
      whereClause.OR = [
        { companyName: { contains: search, mode: 'insensitive' } },
        { campaignData: { contactPerson: { contains: search, mode: 'insensitive' } } },
        { campaignData: { email: { contains: search, mode: 'insensitive' } } }
      ];
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where: whereClause,
        include: {
          campaignData: { include: { campaign: { select: { id: true, code: true, name: true } } } },
          assignedTo: { select: { id: true, name: true, email: true, role: true } },
          createdBy: { select: { id: true, name: true } }
        },
        orderBy: { accountsVerifiedAt: 'asc' },
        take: parseInt(limit),
        skip
      }),
      prisma.lead.count({ where: whereClause })
    ]);

    res.json({
      leads,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
});

// ========== END OPS TEAM FUNCTIONS ==========

// ========== SUPER_ADMIN_2 APPROVAL FUNCTIONS ==========

/**
 * Get Super Admin 2 approval queue
 * GET /leads/super-admin2/queue
 */
export const getSuperAdmin2Queue = asyncHandler(async function getSuperAdmin2Queue(req, res) {
    const isSA2 = hasRole(req.user, 'SUPER_ADMIN_2');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isSA2 && !isAdmin) {
      return res.status(403).json({ message: 'Only Super Admin 2 can access this endpoint.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 50);

    const sa2Where = {
      superAdmin2ApprovalStatus: 'PENDING',
      opsApprovalStatus: 'APPROVED',
      status: 'FEASIBLE'
    };

    const [pendingLeads, total, approvedCount, rejectedCount] = await Promise.all([
      prisma.lead.findMany({
        where: sa2Where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip,
        select: {
          id: true,
          requirements: true,
          status: true,
          type: true,
          location: true,
          fullAddress: true,
          bandwidthRequirement: true,
          numberOfIPs: true,
          interestLevel: true,
          createdAt: true,
          updatedAt: true,
          documents: true,
          opsApprovalStatus: true,
          opsApprovedAt: true,
          superAdmin2ApprovalStatus: true,
          superAdmin2RejectedReason: true,
          arcAmount: true,
          otcAmount: true,
          advanceAmount: true,
          paymentTerms: true,
          quotationAttachments: true,
          billingAddress: true,
          billingPincode: true,
          expectedDeliveryDate: true,
          linkedinUrl: true,
          feasibilityNotes: true,
          feasibilityReviewedAt: true,
          feasibilityVendorType: true,
          tentativeCapex: true,
          tentativeOpex: true,
          feasibilityDescription: true,
          campaignData: {
            select: {
              company: true,
              name: true,
              firstName: true,
              lastName: true,
              title: true,
              email: true,
              phone: true,
              whatsapp: true,
              industry: true,
              city: true,
              state: true,
              linkedinUrl: true,
              isSelfGenerated: true,
              campaign: { select: { id: true, code: true, name: true } },
              createdBy: { select: { id: true, name: true, email: true } }
            }
          },
          createdBy: {
            select: { id: true, name: true, email: true }
          },
          assignedTo: {
            select: { id: true, name: true, email: true }
          },
          opsApprovedBy: {
            select: { id: true, name: true, email: true }
          },
          products: {
            select: {
              product: { select: { id: true, title: true } }
            }
          }
        }
      }),
      prisma.lead.count({ where: sa2Where }),
      prisma.lead.count({
        where: { superAdmin2ApprovalStatus: 'APPROVED' }
      }),
      prisma.lead.count({
        where: { superAdmin2ApprovalStatus: 'REJECTED' }
      })
    ]);

    const stats = {
      pending: total,
      approved: approvedCount,
      rejected: rejectedCount
    };

    const formattedLeads = pendingLeads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      interestLevel: lead.interestLevel,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      documents: lead.documents || {},
      opsApprovalStatus: lead.opsApprovalStatus,
      opsApprovedAt: lead.opsApprovedAt,
      superAdmin2ApprovalStatus: lead.superAdmin2ApprovalStatus,
      superAdmin2RejectedReason: lead.superAdmin2RejectedReason,
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
      quotationAttachments: lead.quotationAttachments,
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      industry: lead.campaignData.industry,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      campaign: lead.campaignData.campaign,
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy,
      createdBy: lead.createdBy,
      assignedTo: lead.assignedTo,
      opsApprovedBy: lead.opsApprovedBy,
      products: lead.products.map(lp => lp.product),
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt
    }));

    res.json(paginatedResponse({ data: formattedLeads, total, page, limit, dataKey: 'leads', extra: { stats } }));
});

/**
 * Super Admin 2 disposition (Approve / Reject)
 * POST /leads/super-admin2/:id/disposition
 */
export const superAdmin2Disposition = asyncHandler(async function superAdmin2Disposition(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { decision, reason } = req.body;
    const isSA2 = hasRole(req.user, 'SUPER_ADMIN_2');

    if (!isSA2 && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only Super Admin 2 can perform this action.' });
    }

    if (!decision || !['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ message: 'Valid decision (APPROVED/REJECTED) is required.' });
    }

    if (decision === 'REJECTED' && !reason) {
      return res.status(400).json({ message: 'Rejection reason is required.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (lead.superAdmin2ApprovalStatus !== 'PENDING') {
      return res.status(400).json({ message: 'This lead is not pending Super Admin 2 approval.' });
    }

    const updateData = {
      superAdmin2ApprovalStatus: decision,
      superAdmin2ApprovedAt: new Date(),
      superAdmin2ApprovedById: userId
    };

    if (decision === 'REJECTED') {
      updateData.superAdmin2RejectedReason = reason;
      // Reset OPS approval so the lead re-enters the OPS queue for revision
      updateData.opsApprovalStatus = 'PENDING';
    } else {
      updateData.superAdmin2RejectedReason = null;
    }

    const updatedLead = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        createdBy: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } }
      }
    });

    // Sidebar refresh
    emitSidebarRefreshByRole('SUPER_ADMIN');
    if (decision === 'REJECTED') {
      // Lead goes back to OPS queue for revision
      emitSidebarRefreshByRole('OPS_TEAM');
    }
    if (updatedLead.assignedTo) {
      emitSidebarRefresh(updatedLead.assignedTo.id);
    }

    // Notify BDM about the decision
    if (updatedLead.assignedTo) {
      const companyName = updatedLead.campaignData?.company || 'Unknown';
      if (decision === 'APPROVED') {
        await createNotification(
          updatedLead.assignedTo.id,
          'QUOTATION_SA2_APPROVED',
          'Quotation Approved by Admin',
          `Quotation for ${companyName} has been approved. You can now share it with the customer.`,
          { leadId: id }
        );
      } else {
        await createNotification(
          updatedLead.assignedTo.id,
          'QUOTATION_SA2_REJECTED',
          'Quotation Rejected by Admin',
          `Quotation for ${companyName} has been rejected. Reason: ${reason}`,
          { leadId: id }
        );
      }
    }

    res.json({
      success: true,
      lead: {
        id: updatedLead.id,
        superAdmin2ApprovalStatus: updatedLead.superAdmin2ApprovalStatus,
        superAdmin2RejectedReason: updatedLead.superAdmin2RejectedReason,
        superAdmin2ApprovedAt: updatedLead.superAdmin2ApprovedAt
      },
      message: decision === 'APPROVED'
        ? 'Quotation approved. BDM can now share with the customer.'
        : 'Quotation rejected. BDM will be notified.'
    });
});

/**
 * Get Super Admin 2 sidebar counts
 * GET /leads/super-admin2/sidebar-counts
 */
export const getSuperAdmin2SidebarCounts = asyncHandler(async function getSuperAdmin2SidebarCounts(req, res) {
    const isSA2 = hasRole(req.user, 'SUPER_ADMIN_2');

    if (!isSA2 && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only Super Admin 2 can access this endpoint.' });
    }

    const pendingCount = await prisma.lead.count({
      where: {
        superAdmin2ApprovalStatus: 'PENDING',
        opsApprovalStatus: 'APPROVED',
        status: 'FEASIBLE'
      }
    });

    res.json({ pending: pendingCount });
});

// ========== END SUPER_ADMIN_2 APPROVAL FUNCTIONS ==========

// ========== DOCS TEAM FUNCTIONS ==========

// Get Docs Team queue (leads pushed for document verification)
export const getDocsTeamQueue = asyncHandler(async function getDocsTeamQueue(req, res) {
    const { page, limit, skip } = parsePagination(req.query, 50);

    const userId = req.user.id;
    const isDocsTeam = hasRole(req.user, 'DOCS_TEAM');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    console.log('getDocsTeamQueue called by:', req.user.email, 'role:', req.user.role);

    if (!isDocsTeam && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Docs Team can access this endpoint.' });
    }

    // Get leads that have been pushed to docs verification (sharedVia contains 'docs_verification')
    // and have FEASIBLE status, OPS approved, and not yet verified
    const docsWhere = {
      sharedVia: { contains: 'docs_verification' },
      status: 'FEASIBLE',
      opsApprovalStatus: 'APPROVED',
      docsVerifiedAt: null
    };

    const docsLeadSelect = {
      id: true,
      requirements: true,
      status: true,
      type: true,
      location: true,
      fullAddress: true,
      createdAt: true,
      updatedAt: true,
      sharedVia: true,
      linkedinUrl: true,
      documents: true,
      docsVerifiedAt: true,
      docsRejectedReason: true,
      verificationAttempts: true,
      billingAddress: true,
      billingPincode: true,
      expectedDeliveryDate: true,
      bandwidthRequirement: true,
      numberOfIPs: true,
      feasibilityNotes: true,
      feasibilityReviewedAt: true,
      // Additional fields for accounts-rejected tab
      accountsStatus: true,
      accountsRejectedReason: true,
      accountsVerifiedAt: true,
      arcAmount: true,
      otcAmount: true,
      campaignData: {
        select: {
          company: true,
          name: true,
          firstName: true,
          lastName: true,
          title: true,
          email: true,
          phone: true,
          whatsapp: true,
          city: true,
          state: true,
          industry: true,
          linkedinUrl: true,
          isSelfGenerated: true,
          campaign: { select: { id: true, code: true, name: true } },
          createdBy: { select: { id: true, name: true, email: true } }
        }
      },
      createdBy: {
        select: { id: true, name: true, email: true }
      },
      assignedTo: {
        select: { id: true, name: true, email: true }
      },
      products: {
        select: {
          product: { select: { id: true, title: true } }
        }
      },
      enquiryCreatedFrom: {
        select: { id: true }
      },
      vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } }
    };

    const [pendingLeads, docsTotal] = await Promise.all([
      prisma.lead.findMany({
        where: docsWhere,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip,
        select: docsLeadSelect
      }),
      prisma.lead.count({ where: docsWhere })
    ]);

    // Get stats for verified and rejected (parallel)
    const [verifiedCount, rejectedCount] = await Promise.all([
      prisma.lead.count({
        where: {
          sharedVia: { contains: 'docs_verification' },
          docsVerifiedAt: { not: null },
          docsRejectedReason: null
        }
      }),
      prisma.lead.count({
        where: {
          sharedVia: { contains: 'docs_verification' },
          docsVerifiedAt: { not: null },
          docsRejectedReason: { not: null }
        }
      })
    ]);

    // Get leads that were rejected by accounts team (docs team needs to review and send back to BDM)
    const accountsRejectedLeads = await prisma.lead.findMany({
      where: {
        status: 'FEASIBLE',
        accountsStatus: 'ACCOUNTS_REJECTED'
      },
      orderBy: { updatedAt: 'desc' },
      select: docsLeadSelect
    });

    console.log('Docs Team Queue - Found leads:', pendingLeads.length, 'verified:', verifiedCount, 'rejected:', rejectedCount, 'accountsRejected:', accountsRejectedLeads.length);

    // Calculate stats
    const stats = {
      pending: docsTotal,
      verified: verifiedCount,
      rejected: rejectedCount,
      accountsRejected: accountsRejectedLeads.length
    };

    // Format response
    const formattedLeads = pendingLeads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      sharedVia: lead.sharedVia || '',
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      // Documents
      documents: lead.documents || [],
      docsVerifiedAt: lead.docsVerifiedAt,
      docsRejectedReason: lead.docsRejectedReason,
      verificationAttempts: lead.verificationAttempts || 0,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product),
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt,
      // Customer referral info
      isCustomerReferral: !!lead.enquiryCreatedFrom,
      // Vendor / Channel Partner info
      vendor: lead.vendor
    }));

    // Format accounts rejected leads
    const formattedAccountsRejected = accountsRejectedLeads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      sharedVia: lead.sharedVia || '',
      linkedinUrl: lead.linkedinUrl || lead.campaignData.linkedinUrl,
      // Documents
      documents: lead.documents || [],
      docsVerifiedAt: lead.docsVerifiedAt,
      docsRejectedReason: lead.docsRejectedReason,
      verificationAttempts: lead.verificationAttempts || 0,
      // Accounts rejection info
      accountsStatus: lead.accountsStatus,
      accountsRejectedReason: lead.accountsRejectedReason,
      accountsVerifiedAt: lead.accountsVerifiedAt,
      // Financial details
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product),
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt,
      // Customer referral info
      isCustomerReferral: !!lead.enquiryCreatedFrom,
      // Vendor / Channel Partner info
      vendor: lead.vendor
    }));

    res.json(paginatedResponse({ data: formattedLeads, total: docsTotal, page, limit, dataKey: 'leads', extra: { accountsRejectedLeads: formattedAccountsRejected, stats } }));
});

// Send accounts-rejected lead back to BDM for document re-upload
export const sendBackToBDM = asyncHandler(async function sendBackToBDM(req, res) {
    const { id } = req.params;
    const { reason } = req.body;
    const isDocsTeam = req.user.role === 'DOCS_TEAM';

    if (!isDocsTeam) {
      return res.status(403).json({ message: 'Only Docs Team can access this endpoint.' });
    }

    const lead = await prisma.lead.findUnique({ where: { id } });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Lead must be accounts rejected
    if (lead.accountsStatus !== 'ACCOUNTS_REJECTED') {
      return res.status(400).json({ message: 'This lead is not in accounts rejected status.' });
    }

    // Reset the lead status to go back to BDM for document re-upload
    // Remove 'docs_verification' from sharedVia so lead appears in docs_upload stage
    let newSharedVia = lead.sharedVia || '';
    newSharedVia = newSharedVia.replace(/,?docs_verification,?/g, ',').replace(/^,|,$/g, '');

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        // Clear accounts verification
        accountsStatus: null,
        accountsRejectedReason: null,
        accountsVerifiedAt: null,
        accountsVerifiedById: null,
        // Clear docs verification so BDM needs to re-upload
        docsVerifiedAt: null,
        docsVerifiedById: null,
        docsRejectedReason: reason || 'Accounts rejected - requires document re-upload',
        // Remove docs_verification from sharedVia so BDM can see it in docs_upload stage
        sharedVia: newSharedVia,
        updatedAt: new Date()
      }
    });

    res.json({
      message: 'Lead sent back to BDM for document re-upload',
      lead: { id: updated.id }
    });
});

// Get docs team review history (verified and rejected by current user)
export const getDocsTeamReviewHistory = asyncHandler(async function getDocsTeamReviewHistory(req, res) {
    const userId = req.user.id;
    const isDocsTeam = req.user.role === 'DOCS_TEAM';

    if (!isDocsTeam) {
      return res.status(403).json({ message: 'Only Docs Team can access this endpoint.' });
    }

    const { filter = 'all' } = req.query; // all, approved, rejected

    // Build filter based on query
    let whereClause = {
      docsVerifiedById: userId,
      docsVerifiedAt: { not: null }
    };

    if (filter === 'approved') {
      whereClause.docsRejectedReason = null;
    } else if (filter === 'rejected') {
      whereClause.docsRejectedReason = { not: null };
    }

    // Get leads reviewed by this Docs Team member
    const leads = await prisma.lead.findMany({
      where: whereClause,
      orderBy: { docsVerifiedAt: 'desc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } },
            createdBy: { select: { id: true, name: true, email: true } }
          }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Format response
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      sharedVia: lead.sharedVia || '',
      // Documents
      documents: lead.documents || [],
      docsVerifiedAt: lead.docsVerifiedAt,
      docsRejectedReason: lead.docsRejectedReason,
      docsStatus: lead.docsRejectedReason ? 'DOCS_REJECTED' : 'DOCS_APPROVED',
      verificationAttempts: lead.verificationAttempts || 0,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product),
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt
    }));

    // Get counts for tabs
    const counts = {
      approved: await prisma.lead.count({
        where: { docsVerifiedById: userId, docsVerifiedAt: { not: null }, docsRejectedReason: null }
      }),
      rejected: await prisma.lead.count({
        where: { docsVerifiedById: userId, docsVerifiedAt: { not: null }, docsRejectedReason: { not: null } }
      })
    };

    res.json({ leads: formattedLeads, counts });
});

// Docs Team disposition - Approve or Reject documents
export const docsTeamDisposition = asyncHandler(async function docsTeamDisposition(req, res) {
    const { id } = req.params;
    const { decision, reason } = req.body;
    const docsTeamUserId = req.user.id;
    const docsTeamUserName = req.user.name;

    if (!hasRole(req.user, 'DOCS_TEAM') && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only Docs Team can access this endpoint.' });
    }

    if (!decision || !['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ message: 'Valid decision required (APPROVED, REJECTED).' });
    }

    // REJECTED requires reason
    if (decision === 'REJECTED' && !reason) {
      return res.status(400).json({ message: 'Reason is required when rejecting documents.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Prepare update data
    const updateData = {
      docsVerifiedAt: new Date(),
      docsVerifiedById: docsTeamUserId,
      updatedAt: new Date()
    };

    if (decision === 'REJECTED') {
      updateData.docsRejectedReason = reason;
      // Add rejection note to requirements
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[Docs REJECTED by ${docsTeamUserName} on ${new Date().toLocaleString()}]\nReason: ${reason}`
        : `[Docs REJECTED by ${docsTeamUserName} on ${new Date().toLocaleString()}]\nReason: ${reason}`;
    } else {
      // APPROVED
      updateData.docsRejectedReason = null;
      // Add approval note to requirements
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[Docs APPROVED by ${docsTeamUserName} on ${new Date().toLocaleString()}]`
        : `[Docs APPROVED by ${docsTeamUserName} on ${new Date().toLocaleString()}]`;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Sidebar refresh: docs queue updated, if approved accounts gets new work
    emitSidebarRefreshByRole('DOCS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');
    if (decision === 'APPROVED') {
      emitSidebarRefreshByRole('ACCOUNTS_TEAM');

      // Check if lead has a vendor with pending docs → notify feasibility user
      if (updated.vendorId) {
        try {
          const vendor = await prisma.vendor.findUnique({
            where: { id: updated.vendorId },
            select: { id: true, companyName: true, docsStatus: true, createdById: true }
          });
          if (vendor && vendor.docsStatus === 'PENDING') {
            await notifyVendorDocsReminder(vendor.createdById, {
              vendorId: vendor.id,
              companyName: vendor.companyName,
              leadCompany: updated.campaignData?.company
            });
            emitSidebarRefresh(vendor.createdById);
          }
        } catch (vendorErr) {
          console.error('Vendor docs reminder error:', vendorErr);
        }
      }
    }
    if (updated.assignedTo) {
      emitSidebarRefresh(updated.assignedTo.id);
    }

    // Notify BDM when documents are rejected
    if (decision === 'REJECTED' && lead.assignedToId) {
      await createNotification(
        lead.assignedToId,
        'DOCS_REJECTED',
        'Documents Rejected',
        `Documents for "${lead.campaignData?.company || 'Lead'}" have been rejected: ${reason || 'No reason provided'}`,
        { leadId: lead.id }
      );
      emitSidebarRefresh(lead.assignedToId);
    }

    res.json({
      lead: updated,
      message: decision === 'APPROVED'
        ? 'Documents approved successfully.'
        : 'Documents rejected.'
    });
});

// ========== END DOCS TEAM FUNCTIONS ==========

// Create self-generated lead (ISR creates their own lead)
export const createSelfGeneratedLead = asyncHandler(async function createSelfGeneratedLead(req, res) {
    const userId = req.user.id;
    const {
      // Contact details
      company,
      contactName,
      phone,
      email,
      designation,
      industry,
      companySize,
      city,
      state,
      linkedinUrl,
      notes,
      source,
      // Campaign assignment (optional)
      campaignId,
      // Whether to create as Lead immediately
      createAsLead,
      // Product IDs (optional)
      productIds,
      // SAM can assign to a BDM Team Leader
      assignToTeamLeaderId,
      // SAM can assign to an ISR (new flow)
      assignToISRId
    } = req.body;

    // Validate required fields
    if (!company || !contactName || !phone || !source) {
      return res.status(400).json({
        message: 'Company name, contact name, phone, and lead source are required.'
      });
    }

    // Validate phone: must have exactly 10 digits
    const phoneStr = String(phone).trim();
    const digitsOnly = phoneStr.replace(/\D/g, '');
    if (digitsOnly.length !== 10) {
      return res.status(400).json({
        message: `Phone number must have exactly 10 digits. Got ${digitsOnly.length} digits.`
      });
    }
    const cleanedPhone = digitsOnly;

    // Check for duplicate phone across all campaign data
    const existingData = await prisma.campaignData.findFirst({
      where: { phone: cleanedPhone },
      select: { id: true, campaign: { select: { name: true } } }
    });
    if (existingData) {
      return res.status(400).json({
        message: `Phone number ${cleanedPhone} already exists in campaign: ${existingData.campaign?.name || 'Unknown'}.`
      });
    }

    const isSAMRole = ['SAM_EXECUTIVE', 'SAM_HEAD'].includes(req.user.role);

    // If campaignId not provided, we need a default "Self Generated" campaign
    let targetCampaignId = campaignId;

    if (!targetCampaignId) {
      // Determine campaign code based on role/flow
      const useSAMCampaign = isSAMRole || assignToISRId;
      const campaignCode = useSAMCampaign ? 'SAM-GENERATED' : 'SELF-GENERATED';
      const campaignName = useSAMCampaign ? 'SAM Generated Leads' : 'Self Generated Leads';
      const campaignDesc = useSAMCampaign ? 'Leads created by SAM team' : 'Campaign for leads created by ISRs';

      let selfCampaign = await prisma.campaign.findFirst({
        where: { code: campaignCode }
      });

      if (!selfCampaign) {
        selfCampaign = await prisma.campaign.create({
          data: {
            code: campaignCode,
            name: campaignName,
            description: campaignDesc,
            type: 'ALL',
            status: 'ACTIVE',
            dataSource: 'Self Upload',
            isActive: true,
            createdById: req.user.id
          }
        });
      }
      targetCampaignId = selfCampaign.id;
    }

    // Parse contact name into first and last name
    const nameParts = contactName.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // For SAM roles (or admin on SAM page) using ISR flow: assign to ISR, don't create lead
    const samISRFlow = (isSAMRole || isAdminOrTestUser(req.user)) && assignToISRId;
    const effectiveAssigneeId = samISRFlow ? assignToISRId : (assignToTeamLeaderId || userId);
    const effectiveCreateAsLead = samISRFlow ? false : createAsLead;

    // Create CampaignData entry
    const campaignData = await prisma.campaignData.create({
      data: {
        campaignId: targetCampaignId,
        company,
        firstName,
        lastName,
        name: contactName,
        title: designation || 'Contact',
        email: email || null,
        phone: cleanedPhone,
        industry: industry || null,
        companySize: companySize || null,
        city: city || null,
        state: state || null,
        linkedinUrl: linkedinUrl || null,
        source: source,
        notes: notes || null,
        isSelfGenerated: true,
        createdById: userId,
        assignedToId: effectiveAssigneeId,
        assignedByBdmId: (assignToTeamLeaderId || samISRFlow) ? userId : null,
        status: effectiveCreateAsLead ? 'INTERESTED' : 'NEW'
      },
      include: {
        campaign: {
          select: { id: true, code: true, name: true }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // For SAM→ISR flow: upsert CampaignAssignment so ISR sees the campaign
    if (samISRFlow) {
      await prisma.campaignAssignment.upsert({
        where: {
          userId_campaignId: {
            userId: assignToISRId,
            campaignId: targetCampaignId
          }
        },
        update: {},
        create: {
          userId: assignToISRId,
          campaignId: targetCampaignId
        }
      });
    }

    let lead = null;

    // If createAsLead is true, also create a Lead entry (not for SAM→ISR flow)
    if (effectiveCreateAsLead) {
      const leadNumber = await generateLeadNumber();
      const leadData = {
        campaignDataId: campaignData.id,
        leadNumber,
        createdById: userId,
        assignedToId: effectiveAssigneeId,
        linkedinUrl: linkedinUrl || null,
        status: 'NEW',
        type: 'QUALIFIED'
      };

      // Add products if provided
      if (productIds && productIds.length > 0) {
        leadData.products = {
          create: productIds.map(productId => ({ productId }))
        };
      }

      lead = await prisma.lead.create({
        data: leadData,
        include: {
          campaignData: {
            include: {
              campaign: {
                select: { id: true, code: true, name: true }
              },
              createdBy: {
                select: { id: true, name: true, email: true }
              }
            }
          },
          createdBy: {
            select: { id: true, name: true, email: true }
          },
          products: {
            include: {
              product: {
                select: { id: true, title: true }
              }
            }
          }
        }
      });
    }

    // Notify assignee
    if (samISRFlow) {
      await createNotification(
        assignToISRId,
        'DATA_ASSIGNED',
        'New Data Assigned',
        `${req.user.name} has assigned new data to you: ${company} (${contactName})`,
        { campaignDataId: campaignData.id }
      );
      emitSidebarRefresh(assignToISRId);
      emitSidebarRefreshByRole('ISR');
    } else if (assignToTeamLeaderId) {
      await createNotification(
        assignToTeamLeaderId,
        'LEAD_ASSIGNED',
        'New Lead Assigned',
        `${req.user.name} has assigned a new lead: ${company} (${contactName})`,
        { campaignDataId: campaignData.id }
      );
      emitSidebarRefresh(assignToTeamLeaderId);
      emitSidebarRefreshByRole('BDM_TEAM_LEADER');
    }

    res.status(201).json({
      success: true,
      message: samISRFlow
        ? 'Data created and assigned to ISR.'
        : assignToTeamLeaderId
          ? 'Lead created and assigned to Team Leader.'
          : effectiveCreateAsLead ? 'Lead created successfully.' : 'Data saved successfully.',
      campaignData,
      lead
    });
});

// ========== BDM DASHBOARD STATS ==========

// Get BDM dashboard stats
export const getBDMDashboardStats = asyncHandler(async function getBDMDashboardStats(req, res) {
    const userRole = req.user.role;
    const isAdmin = isAdminOrTestUser(req.user);
    const isBDM = hasRole(req.user, 'BDM');
    const isBDMCP = hasRole(req.user, 'BDM_CP');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');

    if (!isBDM && !isBDMCP && !isAdmin && !isTL) {
      return res.status(403).json({ message: 'Only BDM, BDM(CP), Team Leader or Admin can access this endpoint.' });
    }

    // Admin/TL can view a specific BDM's dashboard by passing userId query param
    const targetUserId = (isAdmin || isTL) && req.query.userId ? req.query.userId : req.user.id;

    // Verify target user is BDM if admin/TL is viewing
    if ((isAdmin || isTL) && req.query.userId) {
      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { role: true }
      });
      if (!targetUser || (targetUser.role !== 'BDM' && targetUser.role !== 'BDM_CP')) {
        return res.status(400).json({ message: 'Target user is not a BDM.' });
      }
    }

    const userId = targetUserId;

    // Handle date filter from query params
    const { period, fromDate, toDate } = req.query;

    // Calculate date range based on period
    const now = new Date();
    let dateFrom = null;
    let dateTo = new Date(now);
    dateTo.setHours(23, 59, 59, 999);

    if (period === 'last7days') {
      dateFrom = new Date(now);
      dateFrom.setDate(now.getDate() - 7);
      dateFrom.setHours(0, 0, 0, 0);
    } else if (period === 'lastMonth') {
      dateFrom = new Date(now);
      dateFrom.setMonth(now.getMonth() - 1);
      dateFrom.setHours(0, 0, 0, 0);
    } else if (period === 'lastYear') {
      dateFrom = new Date(now);
      dateFrom.setFullYear(now.getFullYear() - 1);
      dateFrom.setHours(0, 0, 0, 0);
    } else if (period === 'mtd') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFrom.setHours(0, 0, 0, 0);
    } else if (period === 'ytd') {
      dateFrom = new Date(now.getFullYear(), 0, 1);
      dateFrom.setHours(0, 0, 0, 0);
    } else if (period === 'custom' && fromDate && toDate) {
      dateFrom = new Date(fromDate);
      dateFrom.setHours(0, 0, 0, 0);
      dateTo = new Date(toDate);
      dateTo.setHours(23, 59, 59, 999);
    }
    // If no period specified, get all-time stats (dateFrom remains null)

    // Get start of today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get start of this week (Monday)
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay() + 1);
    if (today.getDay() === 0) startOfWeek.setDate(startOfWeek.getDate() - 7);

    // Get start of this month
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    // Build where clause for leads
    const whereClause = { assignedToId: userId };
    if (dateFrom) {
      whereClause.createdAt = {
        gte: dateFrom,
        lte: dateTo
      };
    }

    // Get all leads assigned to this BDM (with date filter)
    const allLeads = await prisma.lead.findMany({
      where: whereClause,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, name: true } }
          }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Status counts
    const statusCounts = {
      NEW: 0,
      QUALIFIED: 0,  // This will now count leads pushed to installation
      FEASIBLE: 0,
      NOT_FEASIBLE: 0,
      FOLLOW_UP: 0,
      DROPPED: 0
    };

    allLeads.forEach(lead => {
      if (statusCounts.hasOwnProperty(lead.status)) {
        statusCounts[lead.status]++;
      }
    });

    // Count leads pushed to installation as "Qualified" (truly converted leads)
    const pushedToInstallation = allLeads.filter(lead => lead.pushedToInstallationAt).length;
    statusCounts.QUALIFIED = pushedToInstallation;

    // Leads pending with Feasibility Team (sent but not reviewed)
    const pendingWithFT = allLeads.filter(lead =>
      lead.feasibilityAssignedToId &&
      !lead.feasibilityReviewedAt &&
      lead.status === 'QUALIFIED'
    ).length;

    // Today's activity
    const todayLeads = allLeads.filter(lead =>
      new Date(lead.updatedAt) >= today
    );
    const todayDispositions = todayLeads.length;
    // Qualified = pushed to installation today
    const todayQualified = allLeads.filter(l =>
      l.pushedToInstallationAt && new Date(l.pushedToInstallationAt) >= today
    ).length;
    const todayFeasible = todayLeads.filter(l => l.status === 'FEASIBLE').length;
    const todayFollowUp = todayLeads.filter(l => l.status === 'FOLLOW_UP').length;
    const todayDropped = todayLeads.filter(l => l.status === 'DROPPED').length;

    // This week's stats
    const weekLeads = allLeads.filter(lead =>
      new Date(lead.updatedAt) >= startOfWeek
    );
    // Qualified = pushed to installation this week
    const weekQualified = allLeads.filter(l =>
      l.pushedToInstallationAt && new Date(l.pushedToInstallationAt) >= startOfWeek
    ).length;
    const weekFeasible = weekLeads.filter(l => l.status === 'FEASIBLE').length;

    // This month's stats
    const monthLeads = allLeads.filter(lead =>
      new Date(lead.updatedAt) >= startOfMonth
    );
    // Qualified = pushed to installation this month
    const monthQualified = allLeads.filter(l =>
      l.pushedToInstallationAt && new Date(l.pushedToInstallationAt) >= startOfMonth
    ).length;
    const monthFeasible = monthLeads.filter(l => l.status === 'FEASIBLE').length;

    // Conversion rate (Pushed to Installation out of total leads)
    const processedLeads = allLeads.filter(l => l.status !== 'NEW').length;
    const successfulLeads = pushedToInstallation; // Leads that completed the entire pipeline
    const conversionRate = processedLeads > 0
      ? Math.round((successfulLeads / processedLeads) * 100)
      : 0;

    // Follow-up schedule
    const followUpLeads = await prisma.lead.findMany({
      where: {
        assignedToId: userId,
        status: 'FOLLOW_UP',
        callLaterAt: { not: null }
      },
      select: {
        id: true,
        callLaterAt: true
      }
    });

    // Count overdue and upcoming follow-ups
    const currentTime = new Date();
    let overdueCount = 0;
    const upcomingByDay = {};

    // Initialize next 7 days
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dateKey = date.toISOString().split('T')[0];
      upcomingByDay[dateKey] = 0;
    }

    followUpLeads.forEach(lead => {
      if (lead.callLaterAt) {
        const scheduledDate = new Date(lead.callLaterAt);
        if (scheduledDate < currentTime) {
          overdueCount++;
        } else {
          const dateKey = scheduledDate.toISOString().split('T')[0];
          if (upcomingByDay.hasOwnProperty(dateKey)) {
            upcomingByDay[dateKey]++;
          }
        }
      }
    });

    // Format upcoming schedule
    const upcomingSchedule = Object.entries(upcomingByDay).map(([date, count], index) => {
      let day;
      if (index === 0) day = 'Today';
      else if (index === 1) day = 'Tomorrow';
      else {
        const d = new Date(date);
        day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      }
      return { date, day, count };
    });

    // Recent activity (last 10 dispositions)
    const recentActivity = allLeads.slice(0, 10).map(lead => ({
      id: lead.id,
      company: lead.campaignData?.company || '-',
      name: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim() || '-',
      status: lead.status,
      updatedAt: lead.updatedAt,
      campaign: lead.campaignData?.campaign?.name
    }));

    // Lead sources (by campaign)
    const campaignStats = {};
    allLeads.forEach(lead => {
      const campaignName = lead.campaignData?.campaign?.name || 'No Campaign';
      if (!campaignStats[campaignName]) {
        campaignStats[campaignName] = { total: 0, qualified: 0, feasible: 0 };
      }
      campaignStats[campaignName].total++;
      // Qualified = pushed to installation (completed entire pipeline)
      if (lead.pushedToInstallationAt) campaignStats[campaignName].qualified++;
      if (lead.status === 'FEASIBLE') campaignStats[campaignName].feasible++;
    });

    // Count quotations sent (leads with 'quotation' in sharedVia)
    const quotationsSent = allLeads.filter(lead =>
      lead.sharedVia && lead.sharedVia.includes('quotation')
    ).length;

    // ========== NEW STATS FOR BDM DASHBOARD ==========

    // Meetings Done (leads where a meeting was scheduled and outcome was updated)
    const meetingsDone = allLeads.filter(lead =>
      lead.meetingDate &&
      lead.status !== 'MEETING_SCHEDULED' &&
      lead.status !== 'NEW'
    ).length;

    // Total Funnel Value (sum of tentativePrice from all leads)
    const totalFunnelValue = allLeads.reduce((sum, lead) => {
      return sum + (lead.tentativePrice || 0);
    }, 0);

    // Total Quotation Sent Amount (sum of ARC + OTC for leads that have quotations)
    const quotationsWithAmount = allLeads.filter(lead => lead.arcAmount || lead.otcAmount);
    const totalQuotationAmount = quotationsWithAmount.reduce((sum, lead) => {
      return sum + (lead.arcAmount || 0) + (lead.otcAmount || 0);
    }, 0);
    const quotationCount = quotationsWithAmount.length;

    // ========== PIPELINE STAT CARDS (filtered by event date) ==========
    // Helper: build date range filter for a specific date field
    const eventDateFilter = (field) => {
      const filter = { assignedToId: userId, [field]: { not: null } };
      if (dateFrom) {
        filter[field] = { gte: dateFrom, lte: dateTo };
      }
      return filter;
    };

    // 1. Login (customer accepted quotation)
    const loginLeads = allLeads.filter(lead =>
      lead.loginCompletedAt &&
      (!dateFrom || (new Date(lead.loginCompletedAt) >= dateFrom && new Date(lead.loginCompletedAt) <= dateTo))
    );
    const loginCount = loginLeads.length;
    const loginAmount = loginLeads.reduce((sum, lead) => sum + (lead.arcAmount || 0), 0);

    // 2. PO Received (accounts verified)
    const poLeads = allLeads.filter(lead =>
      lead.accountsVerifiedAt &&
      (!dateFrom || (new Date(lead.accountsVerifiedAt) >= dateFrom && new Date(lead.accountsVerifiedAt) <= dateTo))
    );
    const poReceivedCount = poLeads.length;
    const poReceivedAmount = poLeads.reduce((sum, lead) => sum + (lead.arcAmount || 0), 0);

    // 3. Installation Done
    const installDoneLeads = allLeads.filter(lead =>
      lead.installationCompletedAt &&
      (!dateFrom || (new Date(lead.installationCompletedAt) >= dateFrom && new Date(lead.installationCompletedAt) <= dateTo))
    );
    const installDoneCount = installDoneLeads.length;
    const installDoneAmount = installDoneLeads.reduce((sum, lead) => sum + (lead.arcAmount || 0), 0);

    // 4. Customer Accept
    const custAcceptLeads = allLeads.filter(lead =>
      lead.customerAcceptanceAt &&
      (!dateFrom || (new Date(lead.customerAcceptanceAt) >= dateFrom && new Date(lead.customerAcceptanceAt) <= dateTo))
    );
    const custAcceptCount = custAcceptLeads.length;
    const custAcceptAmount = custAcceptLeads.reduce((sum, lead) => sum + (lead.arcAmount || 0), 0);

    // 5. FTB Received (first non-OTC invoice payment per lead)
    const leadIds = allLeads.map(l => l.id);
    let ftbCount = 0;
    let ftbAmount = 0;
    if (leadIds.length > 0) {
      // Get first non-OTC invoice payment per lead
      const ftbPayments = await prisma.$queryRaw`
        SELECT DISTINCT ON (i."leadId")
          i."leadId",
          ip.amount,
          ip."paymentDate"
        FROM "InvoicePayment" ip
        JOIN "Invoice" i ON ip."invoiceId" = i.id
        WHERE i."leadId" = ANY(${leadIds}::text[])
          AND i."planName" != 'One Time Charge (OTC)'
        ORDER BY i."leadId", ip."paymentDate" ASC
      `;

      const filteredFtb = ftbPayments.filter(p =>
        !dateFrom || (new Date(p.paymentDate) >= dateFrom && new Date(p.paymentDate) <= dateTo)
      );
      ftbCount = filteredFtb.length;
      ftbAmount = filteredFtb.reduce((sum, p) => sum + (p.amount || 0), 0);
    }

    // Helper to format lead for pipeline list
    const formatPipelineLead = (lead) => ({
      id: lead.id,
      company: lead.campaignData?.company || '-',
      contactName: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim() || '-',
      phone: lead.campaignData?.phone || '-',
      arcAmount: lead.arcAmount || 0,
      otcAmount: lead.otcAmount || 0,
    });

    // Build FTB map: leadId -> { amount, paymentDate }
    const ftbMap = new Map();
    if (leadIds.length > 0) {
      const allFtbPayments = await prisma.$queryRaw`
        SELECT DISTINCT ON (i."leadId")
          i."leadId",
          ip.amount,
          ip."paymentDate"
        FROM "InvoicePayment" ip
        JOIN "Invoice" i ON ip."invoiceId" = i.id
        WHERE i."leadId" = ANY(${leadIds}::text[])
          AND i."planName" != 'One Time Charge (OTC)'
        ORDER BY i."leadId", ip."paymentDate" ASC
      `;
      allFtbPayments.forEach(p => ftbMap.set(p.leadId, { amount: p.amount || 0, paymentDate: p.paymentDate }));
    }

    // Build full pipeline view per lead (all milestones for each lead)
    const pipelineLeads = allLeads
      .filter(lead => lead.loginCompletedAt || lead.accountsVerifiedAt || lead.installationCompletedAt || lead.customerAcceptanceAt)
      .map(lead => {
        const ftb = ftbMap.get(lead.id);
        return {
          id: lead.id,
          company: lead.campaignData?.company || '-',
          contactName: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim() || '-',
          phone: lead.campaignData?.phone || '-',
          arcAmount: lead.arcAmount || 0,
          otcAmount: lead.otcAmount || 0,
          loginCompletedAt: lead.loginCompletedAt,
          accountsVerifiedAt: lead.accountsVerifiedAt,
          installationCompletedAt: lead.installationCompletedAt,
          customerAcceptanceAt: lead.customerAcceptanceAt,
          actualPlanIsActive: lead.actualPlanIsActive || false,
          ftbAmount: ftb?.amount || 0,
          ftbDate: ftb?.paymentDate || null,
        };
      });

    res.json({
      summary: {
        totalLeads: allLeads.length,
        newLeads: statusCounts.NEW,
        qualified: statusCounts.QUALIFIED,
        feasible: statusCounts.FEASIBLE,
        notFeasible: statusCounts.NOT_FEASIBLE,
        followUp: statusCounts.FOLLOW_UP,
        dropped: statusCounts.DROPPED,
        pendingWithFT,
        conversionRate,
        quotationsSent
      },
      // New dashboard stats
      dashboardStats: {
        totalLeads: allLeads.length,
        meetingsDone,
        totalFunnelValue,
        quotationCount,
        totalQuotationAmount,
        // Pipeline stat cards
        loginCount,
        loginAmount,
        loginLeads: loginLeads.map(formatPipelineLead),
        poReceivedCount,
        poReceivedAmount,
        poReceivedLeads: poLeads.map(formatPipelineLead),
        installDoneCount,
        installDoneAmount,
        installDoneLeads: installDoneLeads.map(formatPipelineLead),
        custAcceptCount,
        custAcceptAmount,
        custAcceptLeads: custAcceptLeads.map(formatPipelineLead),
        ftbCount,
        ftbAmount,
        pipelineLeads
      },
      todayStats: {
        dispositions: todayDispositions,
        qualified: todayQualified,
        feasible: todayFeasible,
        followUp: todayFollowUp,
        dropped: todayDropped
      },
      weekStats: {
        qualified: weekQualified,
        feasible: weekFeasible
      },
      monthStats: {
        qualified: monthQualified,
        feasible: monthFeasible
      },
      followUpSchedule: {
        overdue: overdueCount,
        upcoming: upcomingSchedule
      },
      recentActivity,
      campaignStats: Object.entries(campaignStats).map(([name, stats]) => ({
        campaign: name,
        ...stats
      }))
    });
});

// Get BDM sidebar counts (lightweight endpoint for sidebar badges)
// Only counts TODAY and OVERDUE items for meetings and follow-ups (not upcoming)
export const getBDMSidebarCounts = asyncHandler(async function getBDMSidebarCounts(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const isBDM = hasRole(req.user, 'BDM');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isBDM && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only BDM or Team Leader can access this endpoint.' });
    }

    // Calculate end of today (includes all of today)
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    // BDMs and TLs see only their own assigned leads in sidebar counts
    let assignedFilter = {};
    if (isTL || isBDM) {
      assignedFilter = { assignedToId: userId };
    }

    // Cold leads live in their own Lead Pipeline tab and are excluded here
    const queueCount = await prisma.lead.count({
      where: {
        ...assignedFilter,
        status: 'NEW',
        isColdLead: false
      }
    });

    const meetingsCount = await prisma.lead.count({
      where: {
        ...assignedFilter,
        meetingDate: {
          not: null,
          lte: endOfToday
        },
        status: 'MEETING_SCHEDULED',
        isColdLead: false
      }
    });

    const followUpsCount = await prisma.lead.count({
      where: {
        ...assignedFilter,
        status: 'FOLLOW_UP',
        callLaterAt: {
          not: null,
          lte: endOfToday
        },
        isColdLead: false
      }
    });

    res.json({
      queue: queueCount,
      meetings: meetingsCount,
      followUps: followUpsCount
    });
});

// Push lead to document verification
export const pushToDocsVerification = asyncHandler(async function pushToDocsVerification(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { notes } = req.body;
    const files = req.files || [];

    // Check if user is BDM, Team Leader, or Admin/TestUser
    if (!hasRole(req.user, 'BDM') && !hasRole(req.user, 'BDM_TEAM_LEADER') && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only BDM, Team Leader, or Admin can push to verification.' });
    }

    // Find the lead
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, name: true, code: true } }
          }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Build document metadata (Cloudinary response)
    const documentMeta = files.map(file => ({
      originalName: file.originalname,
      filename: file.filename,
      // Cloudinary provides the URL in 'path' property
      url: file.path,
      publicId: file.filename,
      size: file.size,
      mimetype: file.mimetype,
      uploadedAt: new Date().toISOString(),
      uploadedBy: userId
    }));

    // Update lead with verification info
    const currentSharedVia = lead.sharedVia || '';
    const newSharedVia = currentSharedVia.includes('docs_verification')
      ? currentSharedVia
      : (currentSharedVia ? `${currentSharedVia},docs_verification` : 'docs_verification');

    // Merge with existing documents if any
    const existingDocs = lead.documents || [];
    const allDocuments = [...existingDocs, ...documentMeta];

    const updatedLead = await prisma.lead.update({
      where: { id },
      data: {
        sharedVia: newSharedVia,
        documents: allDocuments,
        // Ensure lead appears in Docs Team queue (requires opsApprovalStatus = APPROVED)
        opsApprovalStatus: lead.opsApprovalStatus || 'APPROVED',
        // Reset docs verification status when new docs are pushed
        docsVerifiedAt: null,
        docsVerifiedById: null,
        docsRejectedReason: null,
        // Also reset accounts verification status (in case of re-submission after accounts rejection)
        accountsVerifiedAt: null,
        accountsVerifiedById: null,
        accountsRejectedReason: null,
        // Increment verification attempts counter
        verificationAttempts: (lead.verificationAttempts || 0) + 1,
        requirements: lead.requirements
          ? `${lead.requirements}\n\n[Pushed to Doc Verification (Attempt #${(lead.verificationAttempts || 0) + 1}) on ${new Date().toLocaleString()}]${notes ? `\nNotes: ${notes}` : ''}${files.length > 0 ? `\nDocuments: ${files.map(f => f.originalname).join(', ')}` : ''}`
          : `[Pushed to Doc Verification (Attempt #${(lead.verificationAttempts || 0) + 1}) on ${new Date().toLocaleString()}]${notes ? `\nNotes: ${notes}` : ''}${files.length > 0 ? `\nDocuments: ${files.map(f => f.originalname).join(', ')}` : ''}`
      },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, name: true, code: true } }
          }
        },
        createdBy: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Format response
    const formattedLead = {
      id: updatedLead.id,
      requirements: updatedLead.requirements,
      status: updatedLead.status,
      type: updatedLead.type,
      sharedVia: updatedLead.sharedVia || '',
      linkedinUrl: updatedLead.linkedinUrl || updatedLead.campaignData.linkedinUrl,
      createdAt: updatedLead.createdAt,
      updatedAt: updatedLead.updatedAt,
      company: updatedLead.campaignData.company,
      name: updatedLead.campaignData.name || `${updatedLead.campaignData.firstName || ''} ${updatedLead.campaignData.lastName || ''}`.trim(),
      firstName: updatedLead.campaignData.firstName,
      lastName: updatedLead.campaignData.lastName,
      title: updatedLead.campaignData.title,
      email: updatedLead.campaignData.email,
      phone: updatedLead.campaignData.phone,
      whatsapp: updatedLead.campaignData.whatsapp,
      industry: updatedLead.campaignData.industry,
      city: updatedLead.campaignData.city,
      state: updatedLead.campaignData.state,
      campaign: updatedLead.campaignData.campaign,
      createdBy: updatedLead.createdBy,
      assignedTo: updatedLead.assignedTo,
      products: updatedLead.products.map(lp => lp.product)
    };

    // Sidebar refresh: docs team gets new work
    emitSidebarRefreshByRole('DOCS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({ lead: formattedLead, documents: documentMeta });
});

// Get BDM Performance Reports
export const getBDMReports = asyncHandler(async function getBDMReports(req, res) {
    const { period = '30', bdmId } = req.query; // days
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');

    // Determine which user's reports to fetch
    let targetUserId = req.user.id;
    if (bdmId && isTL) {
      // Verify BDM belongs to this TL
      const bdm = await prisma.user.findUnique({ where: { id: bdmId }, select: { teamLeaderId: true } });
      if (!bdm || bdm.teamLeaderId !== req.user.id) {
        return res.status(403).json({ message: 'This BDM is not in your team.' });
      }
      targetUserId = bdmId;
    }

    const periodDays = parseInt(period);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Get all leads assigned to this BDM
    const allLeads = await prisma.lead.findMany({
      where: { assignedToId: targetUserId },
      include: {
        products: { include: { product: true } },
        campaignData: {
          include: { campaign: true }
        },
        moms: true
      }
    });

    // Get leads within period
    const periodLeads = allLeads.filter(l => new Date(l.createdAt) >= startDate);

    // Lead Status Distribution
    const statusCounts = {
      NEW: 0,
      MEETING_SCHEDULED: 0,
      QUALIFIED: 0,
      FOLLOW_UP: 0,
      DROPPED: 0,
      FEASIBLE: 0,
      NOT_FEASIBLE: 0
    };
    allLeads.forEach(lead => {
      if (statusCounts.hasOwnProperty(lead.status)) {
        statusCounts[lead.status]++;
      }
    });

    // Calculate conversion metrics
    const totalLeads = allLeads.length;
    const qualifiedLeads = allLeads.filter(l => l.status === 'QUALIFIED' || l.status === 'FEASIBLE').length;
    const droppedLeads = allLeads.filter(l => l.status === 'DROPPED' || l.status === 'NOT_FEASIBLE').length;
    const activeLeads = totalLeads - droppedLeads;
    const conversionRate = totalLeads > 0 ? ((qualifiedLeads / totalLeads) * 100).toFixed(1) : 0;

    // Meeting statistics
    const meetingsScheduled = allLeads.filter(l => l.meetingDate !== null).length;
    const meetingsCompleted = allLeads.filter(l => l.meetingOutcome !== null).length;
    const totalMOMs = allLeads.reduce((acc, l) => acc + l.moms.length, 0);

    // Follow-up statistics
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const followUps = allLeads.filter(l => l.status === 'FOLLOW_UP' && l.callLaterAt);
    const overdueFollowUps = followUps.filter(l => new Date(l.callLaterAt) < today).length;
    const todayFollowUps = followUps.filter(l => {
      const d = new Date(l.callLaterAt);
      return d >= today && d < tomorrow;
    }).length;
    const upcomingFollowUps = followUps.filter(l => new Date(l.callLaterAt) >= tomorrow).length;

    // Performance data based on period
    // For 7 days: show daily data
    // For 30/90 days: show weekly data
    // For 365 days: show monthly data
    const performanceData = [];

    if (periodDays <= 7) {
      // Daily performance for last 7 days
      for (let i = 6; i >= 0; i--) {
        const dayStart = new Date();
        dayStart.setDate(dayStart.getDate() - i);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const dayLeads = allLeads.filter(l => {
          const d = new Date(l.createdAt);
          return d >= dayStart && d < dayEnd;
        });

        performanceData.push({
          label: dayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
          leads: dayLeads.length,
          qualified: dayLeads.filter(l => l.status === 'QUALIFIED' || l.status === 'FEASIBLE').length,
          meetings: dayLeads.filter(l => l.meetingDate !== null).length
        });
      }
    } else if (periodDays <= 90) {
      // Weekly performance
      const weeksToShow = Math.min(Math.ceil(periodDays / 7), 12);
      for (let i = weeksToShow - 1; i >= 0; i--) {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
        const weekEnd = new Date();
        weekEnd.setDate(weekEnd.getDate() - i * 7);

        const weekLeads = allLeads.filter(l => {
          const d = new Date(l.createdAt);
          return d >= weekStart && d < weekEnd;
        });

        performanceData.push({
          label: `Week ${weeksToShow - i}`,
          leads: weekLeads.length,
          qualified: weekLeads.filter(l => l.status === 'QUALIFIED' || l.status === 'FEASIBLE').length,
          meetings: weekLeads.filter(l => l.meetingDate !== null).length
        });
      }
    } else {
      // Monthly performance for year view
      for (let i = 11; i >= 0; i--) {
        const monthStart = new Date();
        monthStart.setMonth(monthStart.getMonth() - i);
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);

        const monthLeads = allLeads.filter(l => {
          const d = new Date(l.createdAt);
          return d >= monthStart && d < monthEnd;
        });

        performanceData.push({
          label: monthStart.toLocaleDateString('en-US', { month: 'short' }),
          leads: monthLeads.length,
          qualified: monthLeads.filter(l => l.status === 'QUALIFIED' || l.status === 'FEASIBLE').length,
          meetings: monthLeads.filter(l => l.meetingDate !== null).length
        });
      }
    }

    // Product performance
    const productCounts = {};
    allLeads.forEach(lead => {
      lead.products.forEach(lp => {
        const productName = lp.product.title;
        productCounts[productName] = (productCounts[productName] || 0) + 1;
      });
    });
    const productPerformance = Object.entries(productCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Self-generated leads performance
    const selfLeads = allLeads.filter(l =>
      l.campaignData?.campaign?.name?.startsWith('[BDM Self]')
    );
    const selfLeadsCount = selfLeads.length;
    const selfQualified = selfLeads.filter(l => l.status === 'QUALIFIED' || l.status === 'FEASIBLE').length;

    // Source distribution (campaign sources)
    const sourceCounts = {};
    allLeads.forEach(lead => {
      const source = lead.campaignData?.campaign?.name?.startsWith('[BDM Self]')
        ? 'Self Generated'
        : lead.campaignData?.campaign?.name || 'Unknown';
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    });
    const sourceDistribution = Object.entries(sourceCounts)
      .map(([name, value]) => ({ name: name.replace('[BDM Self] ', ''), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    // Determine period type for frontend to display correct labels
    const periodType = periodDays <= 7 ? 'daily' : periodDays <= 90 ? 'weekly' : 'monthly';

    res.json({
      summary: {
        totalLeads,
        activeLeads,
        qualifiedLeads,
        droppedLeads,
        conversionRate: parseFloat(conversionRate),
        meetingsScheduled,
        meetingsCompleted,
        totalMOMs,
        selfLeadsCount,
        selfQualified
      },
      followUps: {
        overdue: overdueFollowUps,
        today: todayFollowUps,
        upcoming: upcomingFollowUps,
        total: followUps.length
      },
      statusDistribution: Object.entries(statusCounts).map(([status, count]) => ({
        status: status.replace('_', ' '),
        count
      })),
      performanceData,
      periodType,
      productPerformance,
      sourceDistribution
    });
});

// ========== TYPED DOCUMENT MANAGEMENT ==========

/**
 * Upload a single typed document
 * POST /leads/:id/documents/:documentType
 */
export const uploadDocument = asyncHandler(async function uploadDocument(req, res) {
    const { id, documentType } = req.params;
    const userId = req.user.id;
    const file = req.file;

    // Validate user role
    if (!hasRole(req.user, 'BDM') && !hasRole(req.user, 'BDM_TEAM_LEADER') && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only BDM, Team Leader, or Admin can upload documents.' });
    }

    // Validate document type
    if (!isValidDocumentType(documentType)) {
      return res.status(400).json({ message: `Invalid document type: ${documentType}` });
    }

    // Validate file
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    // Find the lead
    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Check if there's an existing document of this type and delete it from Cloudinary
    const existingDocs = lead.documents || {};
    if (existingDocs[documentType]) {
      const existingDoc = existingDocs[documentType];
      try {
        const resourceType = getResourceType(existingDoc.mimetype);
        await deleteFromCloudinary(existingDoc.publicId, resourceType);
      } catch (deleteError) {
        console.error('Error deleting old document from Cloudinary:', deleteError);
        // Continue anyway - we'll overwrite the reference
      }
    }

    // Build document metadata
    const documentMeta = {
      documentType,
      originalName: file.originalname,
      filename: file.filename,
      url: file.path,
      publicId: file.filename,
      size: file.size,
      mimetype: file.mimetype,
      uploadedAt: new Date().toISOString(),
      uploadedBy: userId
    };

    // Add ADVANCE_OTC specific fields if provided
    if (documentType === 'ADVANCE_OTC') {
      if (req.body.paymentMethod) {
        documentMeta.paymentMethod = req.body.paymentMethod; // 'cheque' | 'neft' | 'mail_approval'
      }
      if (req.body.referenceNumber) {
        documentMeta.referenceNumber = req.body.referenceNumber; // cheque number or UTR
      }
      if (req.body.date) {
        documentMeta.date = req.body.date; // cheque date or payment date
      }
      if (req.body.amount) {
        documentMeta.amount = req.body.amount; // payment amount
      }
    }

    // Update documents object (keyed by document type)
    const updatedDocs = {
      ...existingDocs,
      [documentType]: documentMeta
    };

    // Update lead
    const updatedLead = await prisma.lead.update({
      where: { id },
      data: {
        documents: updatedDocs
      }
    });

    res.json({
      success: true,
      document: documentMeta,
      documents: updatedDocs,
      uploadedCount: Object.keys(updatedDocs).length
    });
});

/**
 * Remove a typed document
 * DELETE /leads/:id/documents/:documentType
 */
export const removeDocument = asyncHandler(async function removeDocument(req, res) {
    const { id, documentType } = req.params;

    // Validate user role
    if (!hasRole(req.user, 'BDM') && !hasRole(req.user, 'BDM_TEAM_LEADER') && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only BDM, Team Leader, or Admin can remove documents.' });
    }

    // Validate document type
    if (!isValidDocumentType(documentType)) {
      return res.status(400).json({ message: `Invalid document type: ${documentType}` });
    }

    // Find the lead
    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const existingDocs = lead.documents || {};

    // Check if document exists
    if (!existingDocs[documentType]) {
      return res.status(404).json({ message: `Document type ${documentType} not found.` });
    }

    // Delete from Cloudinary
    const doc = existingDocs[documentType];
    try {
      const resourceType = getResourceType(doc.mimetype);
      await deleteFromCloudinary(doc.publicId, resourceType);
    } catch (deleteError) {
      console.error('Error deleting from Cloudinary:', deleteError);
      // Continue anyway - we'll remove the reference
    }

    // Remove document type from object
    const { [documentType]: removed, ...remainingDocs } = existingDocs;

    // Update lead
    await prisma.lead.update({
      where: { id },
      data: {
        documents: remainingDocs
      }
    });

    res.json({
      success: true,
      removedType: documentType,
      documents: remainingDocs,
      uploadedCount: Object.keys(remainingDocs).length
    });
});

/**
 * Get all documents for a lead
 * GET /leads/:id/documents
 */
export const getLeadDocuments = asyncHandler(async function getLeadDocuments(req, res) {
    const { id } = req.params;

    // Find the lead
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        documents: true,
        docsVerifiedAt: true,
        docsVerifiedById: true,
        docsRejectedReason: true
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const documents = lead.documents || {};
    const requiredTypes = getRequiredDocumentTypes();

    res.json({
      documents,
      uploadedCount: Object.keys(documents).length,
      requiredCount: requiredTypes.length,
      requiredTypes: requiredTypes.map(t => t.id),
      verificationStatus: {
        verifiedAt: lead.docsVerifiedAt,
        verifiedById: lead.docsVerifiedById,
        rejectedReason: lead.docsRejectedReason
      }
    });
});

/**
 * Mark Login Complete - Customer has accepted the quotation
 * POST /leads/:id/mark-login-complete
 */
export const markLoginComplete = asyncHandler(async function markLoginComplete(req, res) {
    const { id } = req.params;

    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, status: true, sharedVia: true, loginCompletedAt: true, opsApprovalStatus: true } });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    if (lead.status !== 'FEASIBLE') {
      return res.status(400).json({ message: 'Lead must be in FEASIBLE status.' });
    }

    const hasShared = lead.sharedVia?.includes('email') || lead.sharedVia?.includes('whatsapp');
    if (!hasShared) {
      return res.status(400).json({ message: 'Quotation must be shared with customer first.' });
    }

    if (lead.loginCompletedAt) {
      return res.status(400).json({ message: 'Login is already marked complete for this lead.' });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        loginCompletedAt: new Date(),
        loginCompletedById: req.user.id
      }
    });

    res.json({ message: 'Login marked complete.', lead: updated });
});

/**
 * Push to verification with typed documents validation
 * POST /leads/:id/push-to-verification-typed
 */
export const pushToDocsVerificationTyped = asyncHandler(async function pushToDocsVerificationTyped(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { notes, testMode, arcAmount, otcAmount, advanceAmount, paymentTerms } = req.body;

    // Check if user is BDM, BDM_CP, Team Leader, or Admin/TestUser
    if (!hasRole(req.user, 'BDM') && !hasRole(req.user, 'BDM_CP') && !hasRole(req.user, 'BDM_TEAM_LEADER') && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only BDM, BDM(CP), Team Leader, or Admin can push to verification.' });
    }

    // Only allow testMode for BDM/BDM_CP/Admin/TestUser
    const allowTestMode = isAdminOrTestUser(req.user) || req.user.role === 'BDM' || req.user.role === 'BDM_CP' || req.user.role === 'BDM_TEAM_LEADER';
    const isTestMode = allowTestMode && testMode === true;

    // Find the lead
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, name: true, code: true } }
          }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Validate documents
    const documents = lead.documents || {};
    const validation = validateDocuments(documents, isTestMode);

    if (!validation.valid) {
      return res.status(400).json({
        message: 'Missing required documents.',
        missing: validation.missing,
        uploadedCount: validation.uploadedCount,
        requiredCount: validation.requiredCount
      });
    }

    // Update sharedVia to include docs_verification (so lead moves to docs verification stage)
    const currentSharedVia = lead.sharedVia || '';
    const newSharedVia = currentSharedVia.includes('docs_verification')
      ? currentSharedVia
      : (currentSharedVia ? `${currentSharedVia},docs_verification` : 'docs_verification');

    // Prepare update data
    // In test mode: skip OPS approval and go directly to Docs Team
    // In normal mode: Send to OPS Team for approval first
    const updateData = {
      // Update sharedVia to move lead to docs verification stage
      sharedVia: newSharedVia,
      // Set OPS approval status - APPROVED for test mode (skip OPS), PENDING otherwise
      opsApprovalStatus: isTestMode ? 'APPROVED' : 'PENDING',
      // Reset OPS approval fields for resubmission (or set for test mode)
      opsApprovedAt: isTestMode ? new Date() : null,
      opsApprovedById: isTestMode ? userId : null,
      opsRejectedReason: null,
      // Reset docs verification status when pushed
      docsVerifiedAt: null,
      docsVerifiedById: null,
      docsRejectedReason: null,
      // Also reset accounts verification status (in case of re-submission after accounts rejection)
      accountsVerifiedAt: null,
      accountsVerifiedById: null,
      accountsRejectedReason: null,
      // Increment verification attempts counter
      verificationAttempts: (lead.verificationAttempts || 0) + 1,
      requirements: lead.requirements
        ? `${lead.requirements}\n\n[${isTestMode ? 'TEST MODE - Bypassed to Docs Team' : `Submitted for OPS Approval (Attempt #${(lead.verificationAttempts || 0) + 1})`} on ${new Date().toLocaleString()}]${notes ? `\nNotes: ${notes}` : ''}${Object.keys(documents).length > 0 ? `\nDocuments: ${Object.keys(documents).join(', ')}` : ''}`
        : `[${isTestMode ? 'TEST MODE - Bypassed to Docs Team' : `Submitted for OPS Approval (Attempt #${(lead.verificationAttempts || 0) + 1})`} on ${new Date().toLocaleString()}]${notes ? `\nNotes: ${notes}` : ''}${Object.keys(documents).length > 0 ? `\nDocuments: ${Object.keys(documents).join(', ')}` : ''}`
    };

    // Add financial details if provided
    if (arcAmount !== undefined && arcAmount !== null && arcAmount !== '') {
      updateData.arcAmount = parseFloat(arcAmount);
    }
    if (otcAmount !== undefined && otcAmount !== null && otcAmount !== '') {
      updateData.otcAmount = parseFloat(otcAmount);
    }
    if (advanceAmount !== undefined && advanceAmount !== null && advanceAmount !== '') {
      updateData.advanceAmount = parseFloat(advanceAmount);
    }
    if (paymentTerms !== undefined && paymentTerms !== null && paymentTerms !== '') {
      updateData.paymentTerms = paymentTerms;
    }

    const updatedLead = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, name: true, code: true } }
          }
        },
        createdBy: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Format response
    const formattedLead = {
      id: updatedLead.id,
      requirements: updatedLead.requirements,
      status: updatedLead.status,
      type: updatedLead.type,
      sharedVia: updatedLead.sharedVia || '',
      linkedinUrl: updatedLead.linkedinUrl || updatedLead.campaignData.linkedinUrl,
      documents: updatedLead.documents,
      // OPS approval status
      opsApprovalStatus: updatedLead.opsApprovalStatus,
      opsRejectedReason: updatedLead.opsRejectedReason,
      createdAt: updatedLead.createdAt,
      updatedAt: updatedLead.updatedAt,
      company: updatedLead.campaignData.company,
      name: updatedLead.campaignData.name || `${updatedLead.campaignData.firstName || ''} ${updatedLead.campaignData.lastName || ''}`.trim(),
      firstName: updatedLead.campaignData.firstName,
      lastName: updatedLead.campaignData.lastName,
      title: updatedLead.campaignData.title,
      email: updatedLead.campaignData.email,
      phone: updatedLead.campaignData.phone,
      whatsapp: updatedLead.campaignData.whatsapp,
      industry: updatedLead.campaignData.industry,
      city: updatedLead.campaignData.city,
      state: updatedLead.campaignData.state,
      campaign: updatedLead.campaignData.campaign,
      createdBy: updatedLead.createdBy,
      assignedTo: updatedLead.assignedTo,
      products: updatedLead.products.map(lp => lp.product)
    };

    // Notify relevant teams via socket for real-time sidebar count update
    if (isTestMode) {
      // Test mode bypasses OPS, goes directly to Docs Team
      emitSidebarRefreshByRole('DOCS_TEAM');
    } else {
      // Normal mode: notify OPS Team about new pending approval
      emitSidebarRefreshByRole('OPS_TEAM');
    }
    // BDM's own lead pipeline count changes
    emitSidebarRefresh(userId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      success: true,
      lead: formattedLead,
      testMode: isTestMode,
      documentsCount: Object.keys(documents).length,
      message: isTestMode
        ? 'Test mode: Bypassed to Docs Team for verification.'
        : 'Quotation submitted to OPS Team for approval.'
    });
});

// ========== ACCOUNTS TEAM FUNCTIONS ==========

// Get Accounts Team queue (leads with docs approved, pending accounts verification)
export const getAccountsTeamQueue = asyncHandler(async function getAccountsTeamQueue(req, res) {
    const { page, limit, skip } = parsePagination(req.query, 50);

    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can access this endpoint.' });
    }

    // Get leads that have docs verified (approved) but not yet accounts verified
    const accountsWhere = {
      docsVerifiedAt: { not: null },
      docsRejectedReason: null,
      accountsVerifiedAt: null
    };

    const [pendingLeads, accountsTotal] = await Promise.all([
      prisma.lead.findMany({
        where: accountsWhere,
        orderBy: { docsVerifiedAt: 'desc' },
        take: limit,
        skip,
        select: {
          id: true,
          requirements: true,
          status: true,
          type: true,
          location: true,
          fullAddress: true,
          bandwidthRequirement: true,
          numberOfIPs: true,
          createdAt: true,
          updatedAt: true,
          sharedVia: true,
          linkedinUrl: true,
          documents: true,
          docsVerifiedAt: true,
          verificationAttempts: true,
          arcAmount: true,
          otcAmount: true,
          advanceAmount: true,
          paymentTerms: true,
          accountsNotes: true,
          accountsStatus: true,
          accountsRejectedReason: true,
          accountsVerifiedAt: true,
          interestLevel: true,
          feasibilityNotes: true,
          feasibilityReviewedAt: true,
          customerGstNo: true,
          customerLegalName: true,
          gstVerifiedAt: true,
          billingAddress: true,
          billingPincode: true,
          expectedDeliveryDate: true,
          installationAddress: true,
          installationPincode: true,
          panCardNo: true,
          tanNumber: true,
          poNumber: true,
          poExpiryDate: true,
          billDate: true,
          technicalInchargeMobile: true,
          technicalInchargeEmail: true,
          accountsInchargeMobile: true,
          accountsInchargeEmail: true,
          bdmName: true,
          serviceManager: true,
          createdById: true,
          assignedToId: true,
          campaignData: {
            select: {
              company: true,
              name: true,
              firstName: true,
              lastName: true,
              title: true,
              email: true,
              phone: true,
              whatsapp: true,
              city: true,
              state: true,
              industry: true,
              linkedinUrl: true,
              isSelfGenerated: true,
              campaign: { select: { id: true, code: true, name: true } },
              createdBy: { select: { id: true, name: true, email: true } }
            }
          },
          assignedTo: {
            select: { id: true, name: true, email: true }
          },
          createdBy: {
            select: { id: true, name: true, email: true }
          },
          products: {
            select: {
              product: { select: { id: true, title: true } }
            }
          },
          vendor: {
            select: {
              id: true, companyName: true, vendorType: true, individualName: true,
              category: true, docsStatus: true, panDocument: true, gstDocument: true,
              cancelledCheque: true, panNumber: true, gstNumber: true,
              contactPerson: true, email: true, phone: true,
              accountNumber: true, ifscCode: true, accountName: true, bankName: true, branchName: true
            }
          },
          enquiryCreatedFrom: {
            select: { id: true }
          }
        }
      }),
      prisma.lead.count({ where: accountsWhere })
    ]);

    // Get stats
    const verifiedCount = await prisma.lead.count({
      where: {
        docsVerifiedAt: { not: null },
        docsRejectedReason: null,
        accountsVerifiedAt: { not: null },
        accountsRejectedReason: null
      }
    });

    const rejectedCount = await prisma.lead.count({
      where: {
        docsVerifiedAt: { not: null },
        docsRejectedReason: null,
        accountsVerifiedAt: { not: null },
        accountsRejectedReason: { not: null }
      }
    });

    const stats = {
      pending: accountsTotal,
      verified: verifiedCount,
      rejected: rejectedCount
    };

    // Format response
    const formattedLeads = pendingLeads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      sharedVia: lead.sharedVia || '',
      linkedinUrl: lead.linkedinUrl || lead.campaignData?.linkedinUrl,
      // Documents
      documents: lead.documents || {},
      docsVerifiedAt: lead.docsVerifiedAt,
      verificationAttempts: lead.verificationAttempts || 0,
      // Financial details
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
      accountsNotes: lead.accountsNotes,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product),
      // Interest level (set by BDM during meeting outcome)
      interestLevel: lead.interestLevel,
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt,
      // GST details
      customerGstNo: lead.customerGstNo,
      customerLegalName: lead.customerLegalName,
      gstVerifiedAt: lead.gstVerifiedAt,
      // Vendor data
      vendor: lead.vendor || null,
      // Customer referral info
      isCustomerReferral: !!lead.enquiryCreatedFrom
    }));

    // Batch lookup: find existing GST data for companies that need it
    const companiesNeedingGst = [...new Set(
      formattedLeads
        .filter(lead => !lead.customerGstNo && lead.company)
        .map(lead => lead.company)
    )];

    const gstLookupMap = new Map();
    if (companiesNeedingGst.length > 0) {
      const existingGstLeads = await prisma.lead.findMany({
        where: {
          customerGstNo: { not: null },
          campaignData: {
            company: { in: companiesNeedingGst, mode: 'insensitive' }
          }
        },
        select: {
          customerGstNo: true,
          customerLegalName: true,
          gstVerifiedAt: true,
          campaignData: { select: { company: true } }
        }
      });

      for (const gstLead of existingGstLeads) {
        const companyKey = gstLead.campaignData.company?.toLowerCase();
        if (companyKey && !gstLookupMap.has(companyKey)) {
          gstLookupMap.set(companyKey, {
            customerGstNo: gstLead.customerGstNo,
            customerLegalName: gstLead.customerLegalName,
          });
        }
      }
    }

    const leadsWithGstSuggestion = formattedLeads.map(lead => {
      if (!lead.customerGstNo && lead.company) {
        const gstData = gstLookupMap.get(lead.company.toLowerCase());
        if (gstData) {
          return {
            ...lead,
            suggestedGstNo: gstData.customerGstNo,
            suggestedLegalName: gstData.customerLegalName,
            gstAlreadyVerified: true
          };
        }
      }
      return lead;
    });

    res.json(paginatedResponse({ data: leadsWithGstSuggestion, total: accountsTotal, page, limit, dataKey: 'leads', extra: { stats } }));
});

// Update financial details for a lead
export const updateFinancialDetails = asyncHandler(async function updateFinancialDetails(req, res) {
    const { id } = req.params;
    const { arcAmount, otcAmount, advanceAmount, paymentTerms, accountsNotes } = req.body;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);
    const isBDM = hasRole(req.user, 'BDM');

    const lead = await prisma.lead.findUnique({ where: { id } });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // BDM can only update their own rejected leads
    if (isBDM) {
      const isOwnLead = lead.createdById === req.user.id || lead.assignedToId === req.user.id;
      // Check both accountsStatus and accountsRejectedReason for backward compatibility
      const isRejected = lead.accountsStatus === 'ACCOUNTS_REJECTED' ||
        (lead.accountsVerifiedAt && lead.accountsRejectedReason);

      if (!isOwnLead) {
        return res.status(403).json({ message: 'You can only update your own leads.' });
      }
      if (!isRejected) {
        return res.status(403).json({ message: 'You can only update pricing for rejected leads.' });
      }
    } else if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can update financial details.' });
    }

    // Validate amounts if provided
    if (arcAmount !== undefined && arcAmount !== null && isNaN(parseFloat(arcAmount))) {
      return res.status(400).json({ message: 'Invalid ARC amount.' });
    }
    if (otcAmount !== undefined && otcAmount !== null && isNaN(parseFloat(otcAmount))) {
      return res.status(400).json({ message: 'Invalid OTC amount.' });
    }
    if (advanceAmount !== undefined && advanceAmount !== null && isNaN(parseFloat(advanceAmount))) {
      return res.status(400).json({ message: 'Invalid advance amount.' });
    }

    const updateData = {
      updatedAt: new Date()
    };

    if (arcAmount !== undefined) {
      updateData.arcAmount = arcAmount === null || arcAmount === '' ? null : parseFloat(arcAmount);
      // Set original ARC if not already captured
      if (lead.originalArcAmount === null && arcAmount !== null && arcAmount !== '') {
        updateData.originalArcAmount = parseFloat(arcAmount);
      }
    }
    if (otcAmount !== undefined) {
      updateData.otcAmount = otcAmount === null || otcAmount === '' ? null : parseFloat(otcAmount);
    }
    if (advanceAmount !== undefined) {
      updateData.advanceAmount = advanceAmount === null || advanceAmount === '' ? null : parseFloat(advanceAmount);
    }
    if (paymentTerms !== undefined) {
      updateData.paymentTerms = paymentTerms || null;
    }
    if (accountsNotes !== undefined) {
      updateData.accountsNotes = accountsNotes || null;
    }

    // If BDM is updating a rejected lead, resubmit for accounts review
    const wasRejected = lead.accountsStatus === 'ACCOUNTS_REJECTED' ||
      (lead.accountsVerifiedAt && lead.accountsRejectedReason);
    if (isBDM && wasRejected) {
      updateData.accountsStatus = 'ACCOUNTS_PENDING';
      updateData.accountsRejectedReason = null;
      updateData.accountsVerifiedAt = null;
      updateData.accountsVerifiedById = null;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    res.json({
      lead: {
        id: updated.id,
        arcAmount: updated.arcAmount,
        otcAmount: updated.otcAmount,
        advanceAmount: updated.advanceAmount,
        paymentTerms: updated.paymentTerms,
        accountsNotes: updated.accountsNotes,
        company: updated.campaignData.company,
        name: updated.campaignData.name || `${updated.campaignData.firstName || ''} ${updated.campaignData.lastName || ''}`.trim()
      },
      message: 'Financial details updated successfully.'
    });
});

// Accounts Team disposition - Approve or Reject
export const accountsTeamDisposition = asyncHandler(async function accountsTeamDisposition(req, res) {
    const { id } = req.params;
    const {
      decision,
      reason,
      arcAmount,
      otcAmount,
      advanceAmount,
      paymentTerms,
      customerGstNo,
      customerLegalName,
      // New customer detail fields
      companyName,
      panCardNo,
      tanNumber,
      billingAddress,
      billingPincode,
      installationAddress,
      installationPincode,
      poNumber,
      poExpiryDate,
      billDate,
      technicalInchargeMobile,
      technicalInchargeEmail,
      accountsInchargeMobile,
      accountsInchargeEmail,
      bdmName,
      serviceManager
    } = req.body;
    const accountsUserId = req.user.id;
    const accountsUserName = req.user.name;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can access this endpoint.' });
    }

    if (!decision || !['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ message: 'Valid decision required (APPROVED, REJECTED).' });
    }

    // REJECTED requires reason
    if (decision === 'REJECTED' && !reason) {
      return res.status(400).json({ message: 'Reason is required when rejecting.' });
    }

    // Validate financial fields (applies regardless of decision)
    if (arcAmount !== undefined && arcAmount !== null && arcAmount !== '') {
      if (typeof arcAmount !== 'number' || isNaN(arcAmount) || arcAmount < 0) {
        return res.status(400).json({ message: 'ARC amount must be a non-negative number.' });
      }
    }
    if (otcAmount !== undefined && otcAmount !== null && otcAmount !== '') {
      if (typeof otcAmount !== 'number' || isNaN(otcAmount) || otcAmount < 0) {
        return res.status(400).json({ message: 'OTC amount must be a non-negative number.' });
      }
    }
    if (advanceAmount !== undefined && advanceAmount !== null && advanceAmount !== '') {
      if (typeof advanceAmount !== 'number' || isNaN(advanceAmount) || advanceAmount < 0) {
        return res.status(400).json({ message: 'Advance amount must be a non-negative number.' });
      }
    }

    // Validate GST number format (Indian GST: 15 chars alphanumeric)
    if (customerGstNo && customerGstNo.trim() !== '') {
      const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      if (!gstRegex.test(customerGstNo.trim().toUpperCase())) {
        return res.status(400).json({ message: 'Invalid GST number format. Expected format: 22AAAAA0000A1Z5' });
      }
    }

    // APPROVED requires all mandatory fields
    if (decision === 'APPROVED') {
      if (!arcAmount || isNaN(parseFloat(arcAmount))) {
        return res.status(400).json({ message: 'Valid ARC amount is required for approval.' });
      }
      if (!otcAmount || isNaN(parseFloat(otcAmount))) {
        return res.status(400).json({ message: 'Valid OTC amount is required for approval.' });
      }
      if (!customerGstNo || customerGstNo.trim().length !== 15) {
        return res.status(400).json({ message: 'Valid 15-character GST number is required for approval.' });
      }
      if (!customerLegalName || customerLegalName.trim().length === 0) {
        return res.status(400).json({ message: 'Legal name (as per GST) is required for approval.' });
      }
      // New mandatory field validations
      if (!panCardNo || panCardNo.trim().length !== 10) {
        return res.status(400).json({ message: 'Valid 10-character PAN card number is required for approval.' });
      }
      if (!tanNumber || tanNumber.trim().length === 0) {
        return res.status(400).json({ message: 'TAN number is required for approval.' });
      }
      if (!billingAddress || billingAddress.trim().length === 0) {
        return res.status(400).json({ message: 'Billing address is required for approval.' });
      }
      if (!billingPincode || billingPincode.trim().length === 0) {
        return res.status(400).json({ message: 'Billing pincode is required for approval.' });
      }
      if (!installationAddress || installationAddress.trim().length === 0) {
        return res.status(400).json({ message: 'Installation address is required for approval.' });
      }
      if (!installationPincode || installationPincode.trim().length === 0) {
        return res.status(400).json({ message: 'Installation pincode is required for approval.' });
      }
      if (!poNumber || poNumber.trim().length === 0) {
        return res.status(400).json({ message: 'PO number is required for approval.' });
      }
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Verify this lead has docs approved
    if (!lead.docsVerifiedAt || lead.docsRejectedReason) {
      return res.status(400).json({ message: 'Lead documents must be approved before accounts verification.' });
    }

    // Prepare update data
    const updateData = {
      accountsVerifiedAt: new Date(),
      accountsVerifiedById: accountsUserId,
      updatedAt: new Date()
    };

    if (decision === 'REJECTED') {
      updateData.accountsRejectedReason = reason;
      updateData.accountsStatus = 'ACCOUNTS_REJECTED';
      // Add rejection note to requirements
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[Accounts REJECTED by ${accountsUserName} on ${new Date().toLocaleString()}]\nReason: ${reason}`
        : `[Accounts REJECTED by ${accountsUserName} on ${new Date().toLocaleString()}]\nReason: ${reason}`;
    } else {
      // APPROVED - save financial details and customer information
      updateData.accountsRejectedReason = null;
      updateData.accountsStatus = 'ACCOUNTS_APPROVED';
      updateData.arcAmount = parseFloat(arcAmount);
      // Set original ARC if not already captured
      if (lead.originalArcAmount === null) {
        updateData.originalArcAmount = parseFloat(arcAmount);
      }
      updateData.otcAmount = parseFloat(otcAmount);
      if (advanceAmount) {
        updateData.advanceAmount = parseFloat(advanceAmount);
      }
      if (paymentTerms) {
        updateData.paymentTerms = paymentTerms;
      }
      // Save GST details if provided
      if (customerGstNo) {
        updateData.customerGstNo = customerGstNo.toUpperCase().trim();
        updateData.gstVerifiedAt = new Date();
        updateData.gstVerifiedById = accountsUserId;
      }
      if (customerLegalName) {
        updateData.customerLegalName = customerLegalName.trim();
      }

      // Save new customer detail fields
      if (panCardNo) {
        updateData.panCardNo = panCardNo.toUpperCase().trim();
      }
      if (tanNumber) {
        updateData.tanNumber = tanNumber.toUpperCase().trim();
      }
      if (billingAddress) {
        updateData.billingAddress = billingAddress.trim().slice(0, 100);
      }
      if (billingPincode) {
        updateData.billingPincode = billingPincode.trim();
      }
      if (installationAddress) {
        updateData.installationAddress = installationAddress.trim().slice(0, 100);
      }
      if (installationPincode) {
        updateData.installationPincode = installationPincode.trim();
      }
      if (poNumber) {
        updateData.poNumber = poNumber.trim();
      }
      if (poExpiryDate) {
        updateData.poExpiryDate = new Date(poExpiryDate);
      }
      if (billDate) {
        updateData.billDate = new Date(billDate);
      }
      if (technicalInchargeMobile) {
        updateData.technicalInchargeMobile = technicalInchargeMobile.trim();
      }
      if (technicalInchargeEmail) {
        updateData.technicalInchargeEmail = technicalInchargeEmail.trim().toLowerCase();
      }
      if (accountsInchargeMobile) {
        updateData.accountsInchargeMobile = accountsInchargeMobile.trim();
      }
      if (accountsInchargeEmail) {
        updateData.accountsInchargeEmail = accountsInchargeEmail.trim().toLowerCase();
      }
      if (bdmName) {
        updateData.bdmName = bdmName.trim();
      }
      if (serviceManager) {
        updateData.serviceManager = serviceManager.trim();
      }

      // Add approval note to requirements
      const gstNote = customerGstNo ? ` | GST: ${customerGstNo}` : '';
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[Accounts APPROVED by ${accountsUserName} on ${new Date().toLocaleString()}]\nARC: ₹${arcAmount} | OTC: ₹${otcAmount}${advanceAmount ? ` | Advance: ₹${advanceAmount}` : ''}${gstNote}`
        : `[Accounts APPROVED by ${accountsUserName} on ${new Date().toLocaleString()}]\nARC: ₹${arcAmount} | OTC: ₹${otcAmount}${advanceAmount ? ` | Advance: ₹${advanceAmount}` : ''}${gstNote}`;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Sidebar refresh: accounts queue updated, BDM can now push to installation
    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');
    if (updated.assignedToId) emitSidebarRefresh(updated.assignedToId);

    // Notify BDM when accounts team rejects the lead
    if (decision === 'REJECTED' && lead.assignedToId) {
      await createNotification(
        lead.assignedToId,
        'ACCOUNTS_REJECTED',
        'Accounts Verification Rejected',
        `Lead "${lead.campaignData?.company || 'Lead'}" rejected by Accounts team: ${reason || 'No reason provided'}`,
        { leadId: lead.id }
      );
      emitSidebarRefresh(lead.assignedToId);
    }

    res.json({
      lead: updated,
      message: decision === 'APPROVED'
        ? 'Lead approved by accounts team successfully.'
        : 'Lead rejected by accounts team.'
    });
});

// Update Accounts Details for approved leads
export const updateAccountsDetails = asyncHandler(async function updateAccountsDetails(req, res) {
    const { id } = req.params;
    const {
      arcAmount,
      otcAmount,
      advanceAmount,
      paymentTerms,
      customerGstNo,
      customerLegalName,
      companyName,
      panCardNo,
      tanNumber,
      billingAddress,
      billingPincode,
      installationAddress,
      installationPincode,
      poNumber,
      poExpiryDate,
      billDate,
      technicalInchargeMobile,
      technicalInchargeEmail,
      accountsInchargeMobile,
      accountsInchargeEmail,
      bdmName,
      serviceManager
    } = req.body;

    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can update these details.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Build update data - only include fields that are provided
    const updateData = { updatedAt: new Date() };

    if (arcAmount !== undefined) updateData.arcAmount = arcAmount ? parseFloat(arcAmount) : null;
    if (otcAmount !== undefined) updateData.otcAmount = otcAmount ? parseFloat(otcAmount) : null;
    if (advanceAmount !== undefined) updateData.advanceAmount = advanceAmount ? parseFloat(advanceAmount) : null;
    if (paymentTerms !== undefined) updateData.paymentTerms = paymentTerms || null;
    if (customerGstNo !== undefined) updateData.customerGstNo = customerGstNo?.trim() || null;
    if (customerLegalName !== undefined) updateData.customerLegalName = customerLegalName?.trim() || null;
    if (companyName !== undefined) updateData.company = companyName?.trim() || lead.company;
    if (panCardNo !== undefined) updateData.panCardNo = panCardNo?.trim() || null;
    if (tanNumber !== undefined) updateData.tanNumber = tanNumber?.trim() || null;
    if (billingAddress !== undefined) updateData.billingAddress = billingAddress?.trim() || null;
    if (billingPincode !== undefined) updateData.billingPincode = billingPincode?.trim() || null;
    if (installationAddress !== undefined) updateData.installationAddress = installationAddress?.trim() || null;
    if (installationPincode !== undefined) updateData.installationPincode = installationPincode?.trim() || null;
    if (poNumber !== undefined) updateData.poNumber = poNumber?.trim() || null;
    if (poExpiryDate !== undefined) updateData.poExpiryDate = poExpiryDate ? new Date(poExpiryDate) : null;
    if (billDate !== undefined) updateData.billDate = billDate ? new Date(billDate) : null;
    if (technicalInchargeMobile !== undefined) updateData.technicalInchargeMobile = technicalInchargeMobile?.trim() || null;
    if (technicalInchargeEmail !== undefined) updateData.technicalInchargeEmail = technicalInchargeEmail?.trim() || null;
    if (accountsInchargeMobile !== undefined) updateData.accountsInchargeMobile = accountsInchargeMobile?.trim() || null;
    if (accountsInchargeEmail !== undefined) updateData.accountsInchargeEmail = accountsInchargeEmail?.trim() || null;
    if (bdmName !== undefined) updateData.bdmName = bdmName?.trim() || null;
    if (serviceManager !== undefined) updateData.serviceManager = serviceManager?.trim() || null;

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    res.json({
      lead: updated,
      message: 'Accounts details updated successfully.'
    });
});

// Get Accounts Team review history (leads reviewed by current user)
export const getAccountsTeamReviewHistory = asyncHandler(async function getAccountsTeamReviewHistory(req, res) {
    const userId = req.user.id;
    const { filter = 'all' } = req.query; // 'all', 'approved', 'rejected'
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can access this endpoint.' });
    }

    // Build where clause based on filter
    // Admin/Test User sees all leads, regular accounts team sees only their own
    let whereClause = {
      accountsVerifiedAt: { not: null }
    };

    // Only filter by user ID for non-admin users
    if (!isAdmin) {
      whereClause.accountsVerifiedById = userId;
    }

    if (filter === 'approved') {
      whereClause.accountsRejectedReason = null;
    } else if (filter === 'rejected') {
      whereClause.accountsRejectedReason = { not: null };
    }

    const leads = await prisma.lead.findMany({
      where: whereClause,
      orderBy: { accountsVerifiedAt: 'desc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } },
            createdBy: { select: { id: true, name: true, email: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        createdBy: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      // Accounts verification info
      accountsStatus: lead.accountsRejectedReason ? 'ACCOUNTS_REJECTED' : 'ACCOUNTS_APPROVED',
      accountsVerifiedAt: lead.accountsVerifiedAt,
      accountsRejectionReason: lead.accountsRejectedReason,
      // Financial details
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
      accountsNotes: lead.accountsNotes,
      // GST & Tax details
      customerGstNo: lead.customerGstNo,
      customerLegalName: lead.customerLegalName,
      gstVerifiedAt: lead.gstVerifiedAt,
      panCardNo: lead.panCardNo,
      tanNumber: lead.tanNumber,
      // Address details
      billingAddress: lead.billingAddress,
      billingPincode: lead.billingPincode,
      installationAddress: lead.installationAddress,
      installationPincode: lead.installationPincode,
      // PO & Billing details
      poNumber: lead.poNumber,
      poExpiryDate: lead.poExpiryDate,
      billDate: lead.billDate,
      // Contact details - accounts filled
      technicalInchargeMobile: lead.technicalInchargeMobile,
      technicalInchargeEmail: lead.technicalInchargeEmail,
      accountsInchargeMobile: lead.accountsInchargeMobile,
      accountsInchargeEmail: lead.accountsInchargeEmail,
      bdmName: lead.bdmName,
      serviceManager: lead.serviceManager,
      // Documents
      documents: lead.documents || {},
      docsVerifiedAt: lead.docsVerifiedAt,
      verificationAttempts: lead.verificationAttempts || 0,
      // Contact details from campaign
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      firstName: lead.campaignData.firstName,
      lastName: lead.campaignData.lastName,
      title: lead.campaignData.title,
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      whatsapp: lead.campaignData.whatsapp,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      industry: lead.campaignData.industry,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // Self-generated info
      isSelfGenerated: lead.campaignData.isSelfGenerated || false,
      dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product),
      // Interest level
      interestLevel: lead.interestLevel,
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt
    }));

    // Get counts for tabs (admin sees all, others see their own)
    const countWhereBase = isAdmin
      ? { accountsVerifiedAt: { not: null } }
      : { accountsVerifiedById: userId, accountsVerifiedAt: { not: null } };

    const counts = {
      approved: await prisma.lead.count({
        where: { ...countWhereBase, accountsRejectedReason: null }
      }),
      rejected: await prisma.lead.count({
        where: { ...countWhereBase, accountsRejectedReason: { not: null } }
      })
    };

    res.json({ leads: formattedLeads, counts });
});

// Get accounts verified leads (history)
export const getAccountsVerifiedLeads = asyncHandler(async function getAccountsVerifiedLeads(req, res) {
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can access this endpoint.' });
    }

    const leads = await prisma.lead.findMany({
      where: {
        accountsVerifiedAt: { not: null }
      },
      orderBy: { accountsVerifiedAt: 'desc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: {
          select: { id: true, name: true, email: true }
        },
        accountsVerifiedBy: {
          select: { id: true, name: true, email: true }
        },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      requirements: lead.requirements,
      status: lead.status,
      type: lead.type,
      location: lead.location,
      fullAddress: lead.fullAddress,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      // Financial details
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      paymentTerms: lead.paymentTerms,
      accountsNotes: lead.accountsNotes,
      accountsVerifiedAt: lead.accountsVerifiedAt,
      accountsVerifiedBy: lead.accountsVerifiedBy,
      accountsRejectedReason: lead.accountsRejectedReason,
      // Documents
      documents: lead.documents || {},
      docsVerifiedAt: lead.docsVerifiedAt,
      // Contact details
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      email: lead.campaignData.email,
      phone: lead.campaignData.phone,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      // Campaign info
      campaign: lead.campaignData.campaign,
      // BDM info
      bdm: lead.assignedTo,
      // Products
      products: lead.products.map(lp => lp.product),
      // Feasibility data
      feasibilityNotes: lead.feasibilityNotes,
      feasibilityReviewedAt: lead.feasibilityReviewedAt
    }));

    res.json({ leads: formattedLeads });
});

// ========== END ACCOUNTS TEAM FUNCTIONS ==========

// ========== INSTALLATION FUNCTIONS ==========

// Push lead to installation team (BDM only, after accounts approval)
export const pushToInstallation = asyncHandler(async function pushToInstallation(req, res) {
    const { id } = req.params;
    const { notes } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    const userName = req.user.name;

    // Only OPS_TEAM, BDM, Team Leader, or SUPER_ADMIN can push to installation
    if (!hasRole(req.user, 'OPS_TEAM') && !hasRole(req.user, 'BDM') && !hasRole(req.user, 'BDM_TEAM_LEADER') && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only OPS Team, BDM or Team Leader can push leads to installation.' });
    }

    // Get the lead
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: true,
        assignedTo: { select: { id: true, name: true } }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Verify lead is assigned to this BDM (unless admin/test user or OPS_TEAM)
    if (!isAdminOrTestUser(req.user) && !hasRole(req.user, 'OPS_TEAM') && lead.assignedToId !== userId) {
      return res.status(403).json({ message: 'You can only push leads assigned to you.' });
    }

    // Verify accounts team has approved
    if (!lead.accountsVerifiedAt) {
      return res.status(400).json({ message: 'Lead must be approved by accounts team first.' });
    }

    if (lead.accountsRejectedReason) {
      return res.status(400).json({ message: 'Cannot push rejected lead to installation.' });
    }

    // Check if already pushed
    if (lead.pushedToInstallationAt) {
      return res.status(400).json({ message: 'Lead has already been pushed to installation.' });
    }

    // Get delivery user assignment if provided
    const { deliveryUserId } = req.body;

    // Update lead with installation push details
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    const installationNote = `\n\n[Pushed to Installation by ${userName} on ${dateStr}]${notes ? `\nNotes: ${notes}` : ''}`;

    const updateData = {
      pushedToInstallationAt: now,
      pushedToInstallationById: userId,
      installationNotes: notes || null,
      requirements: lead.requirements ? lead.requirements + installationNote : installationNote.trim()
    };

    // Assign to delivery user if provided
    if (deliveryUserId) {
      updateData.deliveryAssignedToId = deliveryUserId;
      updateData.deliveryAssignedAt = now;
      updateData.deliveryStatus = 'PENDING';
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: { select: { id: true, name: true, email: true } },
        pushedToInstallationBy: { select: { id: true, name: true, email: true } },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        products: {
          include: {
            product: { select: { id: true, title: true } }
          }
        }
      }
    });

    // Sidebar refresh: delivery team gets new work, BDM pipeline changes
    emitSidebarRefreshByRole('DELIVERY_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');
    if (updated.assignedToId) emitSidebarRefresh(updated.assignedToId);
    if (updated.deliveryAssignedToId) emitSidebarRefresh(updated.deliveryAssignedToId);

    const deliveryUserName = updated.deliveryAssignedTo?.name;
    res.json({
      lead: updated,
      message: deliveryUserName
        ? `Lead pushed to installation and assigned to ${deliveryUserName}.`
        : 'Lead pushed to installation team successfully.'
    });
});

// ========== END INSTALLATION FUNCTIONS ==========

// ========== DELIVERY TEAM FUNCTIONS ==========

// Get delivery report for delivery team
export const getDeliveryReport = asyncHandler(async function getDeliveryReport(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = hasRole(req.user, 'DELIVERY_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { fromDate, toDate, search, deliveryUserId } = req.query;

    // Build where clause
    const where = {
      pushedToInstallationAt: { not: null }
    };

    // Delivery team sees only their assigned leads
    if (isDeliveryTeam && !isAdmin) {
      where.deliveryAssignedToId = userId;
    } else if (isAdmin && deliveryUserId) {
      // Admin filtering by specific delivery user
      where.deliveryAssignedToId = deliveryUserId;
    }

    // Date filter on pushedToInstallationAt
    const dateFilter = buildDateFilter(fromDate, toDate);
    if (dateFilter) where.pushedToInstallationAt = dateFilter;

    // Search filter
    if (search) {
      where.OR = buildSearchFilter(search, [
        'campaignData.company',
        'campaignData.name',
        'campaignData.phone',
        'location',
      ]);
    }

    const leads = await prisma.lead.findMany({
      where,
      select: {
        id: true,
        location: true,
        fullAddress: true,
        fromAddress: true,
        deliveryStatus: true,
        bandwidthRequirement: true,
        numberOfIPs: true,
        arcAmount: true,
        otcAmount: true,
        pushedToInstallationAt: true,
        installationStartedAt: true,
        installationCompletedAt: true,
        nocConfiguredAt: true,
        speedTestUploadedAt: true,
        customerAcceptanceAt: true,
        customerAcceptanceStatus: true,
        deliveryAssignedTo: { select: { id: true, name: true } },
        campaignData: {
          select: {
            company: true,
            name: true,
            phone: true,
            city: true,
            campaign: { select: { name: true } }
          }
        },
        deliveryRequests: {
          where: { status: { notIn: ['REJECTED'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            requestNumber: true,
            status: true,
            items: {
              select: {
                id: true,
                quantity: true,
                assignedQuantity: true,
                assignedSerialNumbers: true,
                usedQuantity: true,
                isUsed: true,
                isAssigned: true,
                product: {
                  select: { id: true, modelNumber: true, category: true, brandName: true, unit: true }
                }
              }
            }
          }
        }
      },
      orderBy: { pushedToInstallationAt: 'desc' }
    });

    // Compute stats
    const stats = {
      total: leads.length,
      pending: 0,
      installing: 0,
      completed: 0,
      inProgress: 0
    };

    const completedStages = ['COMPLETED'];
    const installingStages = ['INSTALLING'];
    const pendingStages = ['PENDING', 'MATERIAL_REQUESTED', 'MATERIAL_RECEIVED', 'PUSHED_TO_NOC', 'ACTIVATION_READY'];
    const inProgressStages = ['DEMO_PLAN_PENDING', 'SPEED_TEST', 'CUSTOMER_ACCEPTANCE'];

    leads.forEach(lead => {
      const s = lead.deliveryStatus;
      if (completedStages.includes(s)) stats.completed++;
      else if (installingStages.includes(s)) stats.installing++;
      else if (inProgressStages.includes(s)) stats.inProgress++;
      else if (pendingStages.includes(s)) stats.pending++;
    });

    // Format response
    const report = leads.map(lead => {
      const dr = lead.deliveryRequests?.[0];
      const items = dr?.items || [];
      const materialsUsed = items.filter(i => i.isUsed).map(i => ({
        product: i.product.modelNumber,
        category: i.product.category,
        brand: i.product.brandName,
        unit: i.product.unit,
        assignedQty: i.assignedQuantity || i.quantity,
        usedQty: i.usedQuantity,
        serialNumbers: i.assignedSerialNumbers || [],
        verified: i.isUsed
      }));
      const allMaterials = items.map(i => ({
        product: i.product.modelNumber,
        category: i.product.category,
        brand: i.product.brandName,
        unit: i.product.unit,
        assignedQty: i.assignedQuantity || i.quantity,
        usedQty: i.usedQuantity,
        serialNumbers: i.assignedSerialNumbers || [],
        verified: i.isUsed
      }));

      // Calculate duration
      let installDuration = null;
      if (lead.installationStartedAt && lead.installationCompletedAt) {
        const diffMs = new Date(lead.installationCompletedAt) - new Date(lead.installationStartedAt);
        const diffHrs = Math.round(diffMs / (1000 * 60 * 60) * 10) / 10;
        installDuration = diffHrs;
      }

      return {
        id: lead.id,
        company: lead.campaignData?.company || '',
        contactName: lead.campaignData?.name || '',
        phone: lead.campaignData?.phone || '',
        address: lead.fullAddress || lead.location,
        popLocation: lead.fromAddress || '',
        city: lead.campaignData?.city || '',
        bandwidth: lead.bandwidthRequirement,
        ips: lead.numberOfIPs,
        arc: lead.arcAmount,
        otc: lead.otcAmount,
        status: lead.deliveryStatus,
        assignedTo: lead.deliveryAssignedTo?.name,
        deliveryRequestNumber: dr?.requestNumber,
        deliveryRequestStatus: dr?.status,
        materials: allMaterials,
        materialsVerified: items.length > 0 && items.every(i => i.isUsed),
        totalMaterialItems: items.length,
        verifiedItems: items.filter(i => i.isUsed).length,
        pushedAt: lead.pushedToInstallationAt,
        installStarted: lead.installationStartedAt,
        installCompleted: lead.installationCompletedAt,
        installDurationHrs: installDuration,
        nocConfigured: lead.nocConfiguredAt,
        speedTestUploaded: lead.speedTestUploadedAt,
        customerAccepted: lead.customerAcceptanceAt,
        customerAcceptanceStatus: lead.customerAcceptanceStatus
      };
    });

    res.json({ report, stats });
});

// Get delivery queue - leads pushed to installation
export const getDeliveryQueue = asyncHandler(async function getDeliveryQueue(req, res) {
    const { page, limit } = parsePagination(req.query, 50);

    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = hasRole(req.user, 'DELIVERY_TEAM');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can access this endpoint.' });
    }

    const { stage = 'pending' } = req.query;

    // First, get ALL leads pushed to installation with their delivery requests
    const allLeadsWithRequests = await prisma.lead.findMany({
      where: { pushedToInstallationAt: { not: null } },
      select: {
        id: true,
        requirements: true,
        status: true,
        type: true,
        location: true,
        latitude: true,
        longitude: true,
        fullAddress: true,
        fromAddress: true,
        billingAddress: true,
        billingPincode: true,
        expectedDeliveryDate: true,
        bandwidthRequirement: true,
        numberOfIPs: true,
        arcAmount: true,
        otcAmount: true,
        advanceAmount: true,
        paymentTerms: true,
        tentativePrice: true,
        vendorCommissionPercentage: true,
        pushedToInstallationAt: true,
        installationNotes: true,
        deliveryStatus: true,
        deliveryAssignedToId: true,
        deliveryAssignedAt: true,
        deliveryNotes: true,
        deliveryProducts: true,
        nocPushedToDeliveryAt: true,
        circuitId: true,
        customerUserId: true,
        customerUsername: true,
        customerIpAddresses: true,
        speedTestScreenshot: true,
        latencyTestScreenshot: true,
        speedTestUploadedAt: true,
        customerAcceptanceStatus: true,
        customerAcceptanceAt: true,
        customerAcceptanceNotes: true,
        demoPlanName: true,
        demoPlanBandwidth: true,
        demoPlanUploadBandwidth: true,
        demoPlanDataLimit: true,
        demoPlanValidityDays: true,
        demoPlanIsActive: true,
        demoPlanAssignedAt: true,
        demoPlanNotes: true,
        installationStartedAt: true,
        installationCompletedAt: true,
        feasibilityNotes: true,
        feasibilityVendorType: true,
        tentativeCapex: true,
        tentativeOpex: true,
        feasibilityDescription: true,
        deliveryVendorSetupDone: true,
        vendorId: true,
        createdAt: true,
        updatedAt: true,
        campaignData: {
          select: {
            company: true,
            name: true,
            firstName: true,
            lastName: true,
            title: true,
            email: true,
            phone: true,
            whatsapp: true,
            city: true,
            state: true,
            industry: true,
            isSelfGenerated: true,
            channelPartnerVendorId: true,
            channelPartnerVendor: { select: { id: true, companyName: true, commissionPercentage: true } },
            campaign: { select: { id: true, code: true, name: true } },
            createdBy: { select: { id: true, name: true, email: true } }
          }
        },
        createdBy: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        pushedToInstallationBy: { select: { id: true, name: true, email: true } },
        enquiryCreatedFrom: {
          select: { id: true }
        },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        speedTestUploadedBy: { select: { id: true, name: true, email: true } },
        customerAcceptanceBy: { select: { id: true, name: true, email: true } },
        demoPlanAssignedBy: { select: { id: true, name: true, email: true } },
        vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } },
        products: {
          select: {
            product: { select: { id: true, title: true } }
          }
        },
        deliveryRequests: {
          where: {
            status: { notIn: ['COMPLETED'] }
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            requestNumber: true,
            status: true,
            createdAt: true,
            pushedToNocAt: true,
            areaHeadRejectionReason: true,
            superAdminRejectionReason: true,
            items: {
              where: { isAssigned: true },
              select: {
                id: true,
                quantity: true,
                assignedQuantity: true,
                assignedSerialNumbers: true,
                usedQuantity: true,
                isUsed: true,
                product: {
                  select: { id: true, modelNumber: true, category: true, brandName: true, unit: true }
                }
              }
            }
          }
        },
        vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } }
      },
      orderBy: { pushedToInstallationAt: 'desc' }
    });

    // Helper function to determine which stage a lead belongs to
    const getLeadStage = (lead) => {
      const status = lead.deliveryStatus;
      const activeRequest = lead.deliveryRequests?.[0];

      // Check explicit statuses first (higher priority)
      if (status === 'COMPLETED') return 'completed';
      if (status === 'MATERIAL_REJECTED') return 'material_rejected';
      if (status === 'REJECTED') return 'rejected';
      if (status === 'CUSTOMER_ACCEPTANCE') return 'customer_acceptance';
      if (status === 'SPEED_TEST') return 'speed_test';
      if (status === 'DEMO_PLAN_PENDING') return 'demo_plan_pending';
      if (status === 'INSTALLING') return 'installing';
      if (status === 'ACTIVATION_READY') return 'noc_completed';
      if (status === 'PUSHED_TO_NOC') return 'pushed_to_noc';

      // Check based on delivery request status
      if (activeRequest) {
        // Material received but not pushed to NOC yet
        if (activeRequest.status === 'ASSIGNED' && !activeRequest.pushedToNocAt) {
          return 'material_received';
        }
        // Pushed to NOC (via delivery request)
        if (activeRequest.pushedToNocAt) {
          return 'pushed_to_noc';
        }
        // Material requested, awaiting approval
        if (['PENDING_APPROVAL', 'SUPER_ADMIN_APPROVED', 'AREA_HEAD_APPROVED', 'APPROVED'].includes(activeRequest.status)) {
          return 'material_requested';
        }
      }

      // Vendor setup must be done before material request
      if (!lead.deliveryVendorSetupDone) {
        return 'vendor_setup';
      }

      // Default: Pending (no request yet)
      return 'pending';
    };

    // Calculate stats for all stages
    const stats = {
      vendorSetup: 0,
      pending: 0,
      materialRequested: 0,
      materialReceived: 0,
      pushedToNoc: 0,
      nocCompleted: 0,
      installing: 0,
      demoPlanPending: 0,
      speedTest: 0,
      customerAcceptance: 0,
      completed: 0,
      rejected: 0
    };

    // Categorize all leads
    allLeadsWithRequests.forEach(lead => {
      const leadStage = getLeadStage(lead);
      switch (leadStage) {
        case 'vendor_setup': stats.vendorSetup++; break;
        case 'pending': stats.pending++; break;
        case 'material_rejected': stats.pending++; break;
        case 'material_requested': stats.materialRequested++; break;
        case 'material_received': stats.pushedToNoc++; break;
        case 'pushed_to_noc': stats.pushedToNoc++; break;
        case 'noc_completed': stats.installing++; break;
        case 'installing': stats.installing++; break;
        case 'demo_plan_pending': stats.demoPlanPending++; break;
        case 'speed_test': stats.speedTest++; break;
        case 'customer_acceptance': stats.customerAcceptance++; break;
        case 'completed': stats.completed++; break;
        case 'rejected': stats.rejected++; break;
      }
    });

    // Filter leads based on requested stage
    // Merge removed stages: material_received→pushed_to_noc, noc_completed→installing
    const filteredLeads = allLeadsWithRequests.filter(lead => {
      const leadStage = getLeadStage(lead);
      if (stage === 'vendor_setup') return leadStage === 'vendor_setup';
      if (stage === 'pending') return leadStage === 'pending' || leadStage === 'material_rejected';
      if (stage === 'pushed_to_noc') return leadStage === 'pushed_to_noc' || leadStage === 'material_received';
      if (stage === 'installing') return leadStage === 'installing' || leadStage === 'noc_completed';
      return leadStage === stage;
    });

    // If delivery team member (but not admin/MASTER), filter to only their leads or unassigned
    let leadsToReturn = filteredLeads;
    if (isDeliveryTeam && !isAdmin) {
      leadsToReturn = filteredLeads.filter(lead =>
        lead.deliveryAssignedToId === userId || !lead.deliveryAssignedToId
      );
    }

    // Apply pagination to filtered results
    const deliveryTotal = leadsToReturn.length;
    const paginatedLeads = leadsToReturn.slice((page - 1) * limit, page * limit);

    // Format response
    const formattedLeads = paginatedLeads.map(lead => {
      let feasibilityInfo = null;
      try {
        if (lead.feasibilityNotes) {
          feasibilityInfo = JSON.parse(lead.feasibilityNotes);
        }
      } catch (e) {
        feasibilityInfo = { additionalNotes: lead.feasibilityNotes };
      }

      return {
        id: lead.id,
        requirements: lead.requirements,
        status: lead.status,
        type: lead.type,
        company: lead.campaignData.company,
        name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
        firstName: lead.campaignData.firstName,
        lastName: lead.campaignData.lastName,
        title: lead.campaignData.title,
        email: lead.campaignData.email,
        phone: lead.campaignData.phone,
        whatsapp: lead.campaignData.whatsapp,
        city: lead.campaignData.city,
        state: lead.campaignData.state,
        industry: lead.campaignData.industry,
        location: lead.location,
        latitude: lead.latitude,
        longitude: lead.longitude,
        fullAddress: lead.fullAddress,
        fromAddress: lead.fromAddress,
        billingAddress: lead.billingAddress,
        billingPincode: lead.billingPincode,
        expectedDeliveryDate: lead.expectedDeliveryDate,
        bandwidthRequirement: lead.bandwidthRequirement,
        numberOfIPs: lead.numberOfIPs,
        arcAmount: lead.arcAmount,
        otcAmount: lead.otcAmount,
        advanceAmount: lead.advanceAmount,
        paymentTerms: lead.paymentTerms,
        tentativePrice: lead.tentativePrice,
        campaign: lead.campaignData.campaign,
        // Self-generated info
        isSelfGenerated: lead.campaignData.isSelfGenerated || false,
        dataCreatedBy: lead.campaignData.createdBy || lead.createdBy,
        // Customer referral info
        isCustomerReferral: !!lead.enquiryCreatedFrom,
        pushedToInstallationAt: lead.pushedToInstallationAt,
        pushedToInstallationBy: lead.pushedToInstallationBy,
        installationNotes: lead.installationNotes,
        deliveryStatus: lead.deliveryStatus || 'PENDING',
        deliveryAssignedTo: lead.deliveryAssignedTo,
        deliveryAssignedAt: lead.deliveryAssignedAt,
        deliveryNotes: lead.deliveryNotes,
        deliveryProducts: lead.deliveryProducts,
        nocPushedToDeliveryAt: lead.nocPushedToDeliveryAt,
        circuitId: lead.circuitId,
        customerUserId: lead.customerUserId,
        // Speed test info
        speedTestScreenshot: lead.speedTestScreenshot,
        latencyTestScreenshot: lead.latencyTestScreenshot,
        speedTestUploadedAt: lead.speedTestUploadedAt,
        speedTestUploadedBy: lead.speedTestUploadedBy,
        // Customer acceptance info
        customerAcceptanceStatus: lead.customerAcceptanceStatus,
        customerAcceptanceAt: lead.customerAcceptanceAt,
        customerAcceptanceBy: lead.customerAcceptanceBy,
        customerAcceptanceNotes: lead.customerAcceptanceNotes,
        // Customer user info (for accounts to see)
        customerUsername: lead.customerUsername,
        customerIpAddresses: lead.customerIpAddresses,
        // Demo plan info
        demoPlanName: lead.demoPlanName,
        demoPlanBandwidth: lead.demoPlanBandwidth,
        demoPlanUploadBandwidth: lead.demoPlanUploadBandwidth,
        demoPlanDataLimit: lead.demoPlanDataLimit,
        demoPlanValidityDays: lead.demoPlanValidityDays,
        demoPlanIsActive: lead.demoPlanIsActive,
        demoPlanAssignedAt: lead.demoPlanAssignedAt,
        demoPlanAssignedBy: lead.demoPlanAssignedBy,
        demoPlanNotes: lead.demoPlanNotes,
        // Installation timestamps
        installationStartedAt: lead.installationStartedAt,
        installationCompletedAt: lead.installationCompletedAt,
        feasibilityInfo,
        feasibilityVendorType: lead.feasibilityVendorType,
        tentativeCapex: lead.tentativeCapex,
        tentativeOpex: lead.tentativeOpex,
        feasibilityDescription: lead.feasibilityDescription,
        deliveryVendorSetupDone: lead.deliveryVendorSetupDone,
        bdm: lead.assignedTo,
        createdBy: lead.createdBy,
        products: lead.products.map(lp => lp.product),
        activeDeliveryRequest: lead.deliveryRequests?.[0] || null,
        // Vendor / Channel Partner info
        vendor: lead.vendor,
        vendorCommissionPercentage: lead.vendorCommissionPercentage,
        channelPartnerVendor: lead.campaignData?.channelPartnerVendor || null,
        isChannelPartnerLead: !!lead.campaignData?.channelPartnerVendorId,
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt
      };
    });

    res.json(paginatedResponse({ data: formattedLeads, total: deliveryTotal, page, limit, dataKey: 'leads', extra: { stats } }));
});

// Get detailed lead info for delivery team
export const getDeliveryLeadDetails = asyncHandler(async function getDeliveryLeadDetails(req, res) {
    const { id } = req.params;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can access this endpoint.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } },
            createdBy: { select: { id: true, name: true, email: true } }
          }
        },
        createdBy: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        feasibilityAssignedTo: { select: { id: true, name: true, email: true } },
        opsApprovedBy: { select: { id: true, name: true, email: true } },
        accountsVerifiedBy: { select: { id: true, name: true, email: true } },
        pushedToInstallationBy: { select: { id: true, name: true, email: true } },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        customerCreatedBy: { select: { id: true, name: true, email: true } },
        nocConfiguredBy: { select: { id: true, name: true, email: true } },
        vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } },
        products: {
          include: {
            product: { select: { id: true, title: true, parentId: true } }
          }
        },
        moms: {
          orderBy: { meetingDate: 'desc' }
        },
        deliveryRequests: {
          where: {
            status: {
              notIn: ['REJECTED', 'COMPLETED']
            }
          },
          select: {
            id: true,
            requestNumber: true,
            status: true,
            createdAt: true,
            pushedToNocAt: true
          },
          take: 1
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.pushedToInstallationAt) {
      return res.status(400).json({ message: 'This lead has not been pushed to installation.' });
    }

    // Parse feasibility notes to get product quantities
    let feasibilityInfo = null;
    try {
      if (lead.feasibilityNotes) {
        feasibilityInfo = JSON.parse(lead.feasibilityNotes);
      }
    } catch (e) {
      feasibilityInfo = { additionalNotes: lead.feasibilityNotes };
    }

    // Combine feasibility products with delivery products (delivery takes precedence).
    // New-format deliveryProducts (with materials array) should be used directly
    // without merging old vendorDetails keys on top.
    let combinedProducts = null;
    if (lead.deliveryProducts && (lead.deliveryProducts.materials || lead.deliveryProducts.setupAt)) {
      // New vendor-setup format — use as-is
      combinedProducts = lead.deliveryProducts;
    } else if (feasibilityInfo && feasibilityInfo.vendorDetails) {
      // Legacy: merge old vendorDetails with old deliveryProducts
      combinedProducts = { ...feasibilityInfo.vendorDetails };
      if (lead.deliveryProducts) {
        combinedProducts = { ...combinedProducts, ...lead.deliveryProducts };
      }
    } else if (lead.deliveryProducts) {
      combinedProducts = lead.deliveryProducts;
    }

    res.json({
      lead: {
        id: lead.id,
        requirements: lead.requirements,
        status: lead.status,
        type: lead.type,
        // Company details
        company: lead.campaignData.company,
        name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
        firstName: lead.campaignData.firstName,
        lastName: lead.campaignData.lastName,
        title: lead.campaignData.title,
        email: lead.campaignData.email,
        phone: lead.campaignData.phone,
        whatsapp: lead.campaignData.whatsapp,
        city: lead.campaignData.city,
        state: lead.campaignData.state,
        industry: lead.campaignData.industry,
        address: lead.campaignData.address,
        // Location info
        location: lead.location,
        latitude: lead.latitude,
        longitude: lead.longitude,
        fullAddress: lead.fullAddress,
        // Billing info
        billingAddress: lead.billingAddress,
        billingPincode: lead.billingPincode,
        bandwidthRequirement: lead.bandwidthRequirement,
        numberOfIPs: lead.numberOfIPs,
        interestLevel: lead.interestLevel,
        // Financial info
        arcAmount: lead.arcAmount,
        otcAmount: lead.otcAmount,
        advanceAmount: lead.advanceAmount,
        paymentTerms: lead.paymentTerms,
        tentativePrice: lead.tentativePrice,
        // Documents
        documents: lead.documents,
        // Campaign info
        campaign: lead.campaignData.campaign,
        // Installation info
        pushedToInstallationAt: lead.pushedToInstallationAt,
        pushedToInstallationBy: lead.pushedToInstallationBy,
        installationNotes: lead.installationNotes,
        // Delivery info
        deliveryStatus: lead.deliveryStatus || 'PENDING',
        deliveryAssignedTo: lead.deliveryAssignedTo,
        deliveryAssignedAt: lead.deliveryAssignedAt,
        deliveryNotes: lead.deliveryNotes,
        deliveryProducts: lead.deliveryProducts,
        // Feasibility info
        feasibilityInfo,
        feasibilityAssignedTo: lead.feasibilityAssignedTo,
        feasibilityReviewedAt: lead.feasibilityReviewedAt,
        feasibilityVendorType: lead.feasibilityVendorType,
        tentativeCapex: lead.tentativeCapex,
        tentativeOpex: lead.tentativeOpex,
        feasibilityDescription: lead.feasibilityDescription,
        deliveryVendorSetupDone: lead.deliveryVendorSetupDone,
        vendorId: lead.vendorId,
        vendor: lead.vendor,
        // Combined products (for editing)
        combinedProducts,
        // OPS approval info
        opsApprovalStatus: lead.opsApprovalStatus,
        opsApprovedAt: lead.opsApprovedAt,
        opsApprovedBy: lead.opsApprovedBy,
        // Accounts info
        accountsVerifiedAt: lead.accountsVerifiedAt,
        accountsVerifiedBy: lead.accountsVerifiedBy,
        // Team members
        bdm: lead.assignedTo,
        createdBy: lead.createdBy,
        // Products
        products: lead.products.map(lp => lp.product),
        // Active delivery request (if any)
        activeDeliveryRequest: lead.deliveryRequests?.[0] || null,
        // Meeting notes
        moms: lead.moms,
        // Customer Account info
        customerUserId: lead.customerUserId,
        customerUsername: lead.customerUsername,
        customerCreatedAt: lead.customerCreatedAt,
        customerCreatedBy: lead.customerCreatedBy,
        customerIpAssigned: lead.customerIpAssigned,
        customerSwitchPort: lead.customerSwitchPort,
        nocConfiguredAt: lead.nocConfiguredAt,
        nocConfiguredBy: lead.nocConfiguredBy,
        // NOC push to delivery
        nocPushedToDeliveryAt: lead.nocPushedToDeliveryAt,
        circuitId: lead.circuitId,
        // Timestamps
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt
      }
    });
});

// Assign lead to delivery team member
export const assignDeliveryLead = asyncHandler(async function assignDeliveryLead(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can access this endpoint.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.pushedToInstallationAt) {
      return res.status(400).json({ message: 'This lead has not been pushed to installation.' });
    }

    // Update lead with delivery assignment
    const updated = await prisma.lead.update({
      where: { id },
      data: {
        deliveryAssignedToId: userId,
        deliveryAssignedAt: new Date(),
        deliveryStatus: lead.deliveryStatus || 'PENDING'
      },
      include: {
        deliveryAssignedTo: { select: { id: true, name: true, email: true } }
      }
    });

    // Sidebar refresh: delivery pending count changes
    emitSidebarRefresh(userId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: 'Lead assigned to you successfully.'
    });
});

// Update delivery products (editable quantities)
export const updateDeliveryProducts = asyncHandler(async function updateDeliveryProducts(req, res) {
    const { id } = req.params;
    const { products, notes, bandwidthRequirement, numberOfIPs } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can update products.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.pushedToInstallationAt) {
      return res.status(400).json({ message: 'This lead has not been pushed to installation.' });
    }

    // Update lead with new product quantities
    const updateData = {
      deliveryProducts: products,
      updatedAt: new Date()
    };

    if (notes !== undefined) {
      updateData.deliveryNotes = notes;
    }

    // Update bandwidth and IPs if provided
    if (bandwidthRequirement !== undefined) {
      updateData.bandwidthRequirement = bandwidthRequirement;
    }
    if (numberOfIPs !== undefined) {
      updateData.numberOfIPs = numberOfIPs ? parseInt(numberOfIPs) : null;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } }
      }
    });

    res.json({
      lead: updated,
      message: 'Products updated successfully.'
    });
});

// Update delivery status
export const updateDeliveryStatus = asyncHandler(async function updateDeliveryStatus(req, res) {
    const { id } = req.params;
    const { status, notes } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can update status.' });
    }

    const validStatuses = [
      'PENDING',
      'MATERIAL_REQUESTED',
      'MATERIAL_RECEIVED',
      'PUSHED_TO_NOC',
      'ACTIVATION_READY',
      'INSTALLING',
      'DEMO_PLAN_PENDING',
      'SPEED_TEST',
      'CUSTOMER_ACCEPTANCE',
      'COMPLETED',
      'REJECTED'
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.pushedToInstallationAt) {
      return res.status(400).json({ message: 'This lead has not been pushed to installation.' });
    }

    // Build update data
    const updateData = {
      deliveryStatus: status,
      updatedAt: new Date()
    };

    // Auto-assign if picking up (changing from PENDING)
    if (status === 'IN_PROGRESS' && !lead.deliveryAssignedToId) {
      updateData.deliveryAssignedToId = userId;
      updateData.deliveryAssignedAt = new Date();
    }

    // Set installation started timestamp
    if (status === 'INSTALLING' && !lead.installationStartedAt) {
      updateData.installationStartedAt = new Date();
    }

    // Set installation completed timestamp when moving to demo plan pending
    if (status === 'DEMO_PLAN_PENDING' && !lead.installationCompletedAt) {
      updateData.installationCompletedAt = new Date();
    }

    if (notes !== undefined) {
      updateData.deliveryNotes = notes;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        pushedToInstallationBy: { select: { id: true, name: true, email: true } }
      }
    });

    // Sidebar refresh: BDM gets deliveryCompleted, accounts gets demoPlan/createPlan
    if (updated.assignedToId) emitSidebarRefresh(updated.assignedToId);
    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: `Delivery status updated to ${status}.`
    });
});

// Start installation with material verification
export const startInstallation = asyncHandler(async function startInstallation(req, res) {
    const { id } = req.params;
    const { materials } = req.body; // [{ itemId, isUsed, usedQuantity }]
    const userId = req.user.id;

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        deliveryRequests: {
          where: { status: { notIn: ['REJECTED', 'COMPLETED'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { items: true }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (lead.deliveryStatus !== 'ACTIVATION_READY' && lead.deliveryStatus !== 'INSTALLING') {
      return res.status(400).json({ message: 'Lead must be in NOC Complete or Installing status to verify materials.' });
    }

    const activeRequest = lead.deliveryRequests?.[0];
    if (!activeRequest) {
      return res.status(400).json({ message: 'No active delivery request found for this lead.' });
    }

    // Update material verification for each item
    if (materials && materials.length > 0) {
      for (const mat of materials) {
        const item = activeRequest.items.find(i => i.id === mat.itemId);
        if (item) {
          await prisma.deliveryRequestItem.update({
            where: { id: mat.itemId },
            data: {
              isUsed: mat.isUsed || false,
              usedQuantity: mat.usedQuantity != null ? parseInt(mat.usedQuantity) : null
            }
          });
        }
      }
    }

    // Transition lead to INSTALLING (only if not already installing)
    const updateData = { updatedAt: new Date() };
    if (lead.deliveryStatus === 'ACTIVATION_READY') {
      updateData.deliveryStatus = 'INSTALLING';
      updateData.installationStartedAt = new Date();
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        pushedToInstallationBy: { select: { id: true, name: true, email: true } }
      }
    });

    res.json({
      lead: updated,
      message: 'Installation started with material verification.'
    });
});

// Create customer user account for lead (after push to NOC)
export const createCustomerUser = asyncHandler(async function createCustomerUser(req, res) {
    const { id } = req.params;
    const { username, password } = req.body;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const isNOC = hasRole(req.user, 'NOC') || hasRole(req.user, 'NOC_HEAD');

    if (!isAdmin && !isNOC) {
      return res.status(403).json({ message: 'Only NOC team can create customer accounts.' });
    }

    // Validate required fields
    if (!username || !username.trim()) {
      return res.status(400).json({ message: 'Username is required.' });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ message: 'Password is required.' });
    }

    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();

    // Check if username already exists
    const existingUsername = await prisma.lead.findFirst({
      where: {
        customerUsername: trimmedUsername
      }
    });

    if (existingUsername) {
      return res.status(400).json({ message: 'Username already exists. Please choose a different username.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          select: { company: true }
        },
        deliveryRequests: {
          where: {
            pushedToNocAt: { not: null }
          },
          take: 1
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Check if lead has a delivery request that was pushed to NOC
    if (!lead.deliveryRequests || lead.deliveryRequests.length === 0) {
      return res.status(400).json({ message: 'This lead has not been pushed to NOC yet.' });
    }

    if (lead.customerUserId) {
      return res.status(400).json({ message: 'Customer account already exists for this lead.' });
    }

    // Hash the password before storing
    const hashedPassword = await bcrypt.hash(trimmedPassword, 10);

    // Generate customer ID + update atomically inside a serialized transaction
    let updated;
    try {
    updated = await prisma.$transaction(async (tx) => {
      const latestCustomer = await tx.lead.findFirst({
        where: { customerUserId: { not: null } },
        orderBy: { customerCreatedAt: 'desc' },
        select: { customerUserId: true }
      });

      let nextCustomerNumber = 1;
      if (latestCustomer && latestCustomer.customerUserId) {
        const match = latestCustomer.customerUserId.match(/CUST-(\d+)/);
        if (match) {
          nextCustomerNumber = parseInt(match[1]) + 1;
        }
      }

      const customerUserId = `CUST-${String(nextCustomerNumber).padStart(5, '0')}`;

      return tx.lead.update({
        where: { id },
        data: {
          customerUserId,
          customerUsername: trimmedUsername,
          customerPassword: hashedPassword,
          customerCreatedAt: new Date(),
          customerCreatedById: userId
        },
        include: {
          customerCreatedBy: { select: { id: true, name: true, email: true } },
          campaignData: {
            select: { company: true, name: true, phone: true, email: true, address: true }
          }
        }
      });
    }, { isolationLevel: 'Serializable' });
    } catch (err) {
      if (err.code === 'P2002') {
        return res.status(400).json({ message: 'Username already exists. Please choose a different username.' });
      }
      throw err;
    }

    // Auto-generate OTC Invoice if OTC amount exists
    let otcInvoice = null;
    if (lead.otcAmount && lead.otcAmount > 0 && !lead.otcInvoiceId) {
      try {
        // Calculate amounts
        const baseAmount = lead.otcAmount;
        const taxableAmount = baseAmount;
        const sgstRate = 9;
        const cgstRate = 9;
        const sgstAmount = (taxableAmount * sgstRate) / 100;
        const cgstAmount = (taxableAmount * cgstRate) / 100;
        const totalGstAmount = sgstAmount + cgstAmount;
        const grandTotal = taxableAmount + totalGstAmount;

        // Generate OTC invoice number
        const invoiceNumber = await generateOTCInvoiceNumber();

        // Calculate due date (15 days from invoice date)
        const invoiceDate = new Date();
        const dueDate = new Date(invoiceDate);
        dueDate.setDate(dueDate.getDate() + 15);

        // Create OTC invoice
        otcInvoice = await prisma.invoice.create({
          data: {
            invoiceNumber,
            leadId: id,
            invoiceDate,
            dueDate,
            billingPeriodStart: invoiceDate,
            billingPeriodEnd: invoiceDate,
            companyName: updated.campaignData?.company || 'Unknown',
            customerUsername: trimmedUsername,
            billingAddress: lead.billingAddress || lead.fullAddress || updated.campaignData?.address,
            installationAddress: lead.fullAddress,
            buyerGstNo: null,
            contactPhone: updated.campaignData?.phone,
            contactEmail: updated.campaignData?.email,
            poNumber: null,
            planName: 'One Time Charge (OTC)',
            planDescription: 'One Time Installation & Setup Charges',
            hsnSacCode: '998422',
            baseAmount,
            discountAmount: 0,
            taxableAmount,
            sgstRate,
            cgstRate,
            sgstAmount,
            cgstAmount,
            totalGstAmount,
            grandTotal,
            status: 'GENERATED',
            notes: 'One Time Charge Invoice - Auto Generated',
            createdById: userId
          }
        });

        // Update lead with OTC invoice reference
        await prisma.lead.update({
          where: { id },
          data: {
            otcInvoiceId: otcInvoice.id,
            otcInvoiceGeneratedAt: new Date()
          }
        });

        // Create ledger entry for OTC invoice
        await createInvoiceLedgerEntry(otcInvoice);

        console.log(`OTC Invoice ${invoiceNumber} auto-generated for customer ${trimmedUsername}`);
      } catch (otcError) {
        console.error('Failed to auto-generate OTC invoice:', otcError);
        // Don't fail the main operation, just log the error
      }
    }

    // Sidebar refresh: NOC pending count changes
    emitSidebarRefreshByRole('NOC');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      customerDetails: {
        customerUserId: updated.customerUserId,
        customerUsername: trimmedUsername,
        customerPassword: trimmedPassword
      },
      otcInvoice: otcInvoice ? {
        id: otcInvoice.id,
        invoiceNumber: otcInvoice.invoiceNumber,
        grandTotal: otcInvoice.grandTotal
      } : null,
      message: otcInvoice
        ? `Customer account created successfully. OTC Invoice ${otcInvoice.invoiceNumber} generated.`
        : 'Customer account created successfully.'
    });
});

// Helper function to generate random password
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// Assign IP to customer
export const assignCustomerIP = asyncHandler(async function assignCustomerIP(req, res) {
    const { id } = req.params;
    const { ipAddress, ipAddresses } = req.body;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const isNOC = hasRole(req.user, 'NOC') || hasRole(req.user, 'NOC_HEAD');

    if (!isAdmin && !isNOC) {
      return res.status(403).json({ message: 'Only NOC team can assign IPs.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.customerUserId) {
      return res.status(400).json({ message: 'Customer account must be created first.' });
    }

    // Handle multiple IPs (new flow)
    if (ipAddresses && Array.isArray(ipAddresses)) {
      // Filter out empty strings
      const validIps = ipAddresses.filter(ip => ip && ip.trim());

      if (validIps.length === 0) {
        return res.status(400).json({ message: 'At least one IP address is required.' });
      }

      const updated = await prisma.lead.update({
        where: { id },
        data: {
          customerIpAddresses: validIps,
          customerIpAssigned: validIps[0] // Keep legacy field for backward compatibility
        }
      });

      return res.json({
        lead: updated,
        message: `${validIps.length} IP address(es) assigned successfully.`
      });
    }

    // Legacy single IP support
    if (!ipAddress) {
      return res.status(400).json({ message: 'IP address is required.' });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        customerIpAssigned: ipAddress,
        customerIpAddresses: [ipAddress]
      }
    });

    res.json({
      lead: updated,
      message: 'IP address assigned successfully.'
    });
});

// Generate Circuit ID and complete NOC configuration
export const generateCircuitId = asyncHandler(async function generateCircuitId(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const isNOC = hasRole(req.user, 'NOC') || hasRole(req.user, 'NOC_HEAD');

    if (!isAdmin && !isNOC) {
      return res.status(403).json({ message: 'Only NOC team can generate circuit IDs.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.customerUserId) {
      return res.status(400).json({ message: 'Customer account must be created first.' });
    }

    // Check if IPs are assigned
    const hasIps = lead.customerIpAddresses &&
      Array.isArray(lead.customerIpAddresses) &&
      lead.customerIpAddresses.length > 0;

    if (!hasIps && !lead.customerIpAssigned) {
      return res.status(400).json({ message: 'IP addresses must be assigned first.' });
    }

    if (lead.circuitId) {
      return res.status(400).json({ message: 'Circuit ID already generated for this lead.' });
    }

    // Use manually provided circuit ID from request body
    const { circuitId: manualCircuitId } = req.body;

    if (!manualCircuitId || manualCircuitId.trim().length === 0) {
      return res.status(400).json({ message: 'Circuit ID is required.' });
    }

    // Check for duplicate circuit ID
    const existingCircuit = await prisma.lead.findFirst({
      where: { circuitId: manualCircuitId.trim() }
    });
    if (existingCircuit) {
      return res.status(400).json({ message: `Circuit ID "${manualCircuitId.trim()}" is already in use.` });
    }

    const circuitId_gen = manualCircuitId.trim();

    const now = new Date();
    const updated = await prisma.lead.update({
        where: { id },
        data: {
          circuitId: circuitId_gen,
          nocConfiguredAt: now,
          nocConfiguredById: userId,
          nocPushedToDeliveryAt: now,
          nocPushedToDeliveryById: userId,
          deliveryStatus: 'INSTALLING',
          installationStartedAt: now
        },
        include: {
          nocConfiguredBy: { select: { id: true, name: true, email: true } },
          deliveryAssignedTo: { select: { id: true, name: true, email: true } }
        }
      });

    const circuitId = updated.circuitId;

    // Notify delivery team
    if (updated.deliveryAssignedToId) emitSidebarRefresh(updated.deliveryAssignedToId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      circuitId,
      message: `Circuit ID generated and pushed to delivery (${updated.deliveryAssignedTo?.name || 'Unassigned'}).`
    });
});

// Configure switch port for customer
export const configureCustomerSwitch = asyncHandler(async function configureCustomerSwitch(req, res) {
    const { id } = req.params;
    const { switchPort } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);
    const isNOC = userRole === 'NOC' || userRole === 'NOC_HEAD';

    if (!isDeliveryTeam && !isAdmin && !isNOC) {
      return res.status(403).json({ message: 'Only Delivery Team or NOC can configure switch.' });
    }

    if (!switchPort) {
      return res.status(400).json({ message: 'Switch port is required.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.customerUserId) {
      return res.status(400).json({ message: 'Customer account must be created first.' });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        customerSwitchPort: switchPort,
        nocConfiguredAt: new Date(),
        nocConfiguredById: userId
      },
      include: {
        nocConfiguredBy: { select: { id: true, name: true, email: true } }
      }
    });

    res.json({
      lead: updated,
      message: 'Switch port configured successfully.'
    });
});

// ========== END DELIVERY TEAM FUNCTIONS ==========

// ========== NOC TEAM FUNCTIONS ==========

// Get NOC queue (leads pushed to NOC)
export const getNocQueue = asyncHandler(async function getNocQueue(req, res) {
    const { page, limit, skip } = parsePagination(req.query, 50);

    const userRole = req.user.role;
    const isNOC = hasRole(req.user, 'NOC') || hasRole(req.user, 'NOC_HEAD');
    const isNOCHead = hasRole(req.user, 'NOC_HEAD');
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isNOC && !isNOCHead && !isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only NOC team can access this endpoint.' });
    }

    const { status = 'all' } = req.query;

    // Build where clause
    let whereClause = {};

    // Get leads from delivery requests that have been pushed to NOC
    const deliveryRequests = await prisma.deliveryRequest.findMany({
      where: {
        pushedToNocAt: { not: null }
      },
      select: {
        leadId: true
      }
    });

    const leadIds = deliveryRequests.map(dr => dr.leadId);

    if (leadIds.length === 0) {
      return res.json({
        leads: [],
        stats: {
          total: 0,
          pending: 0,
          customerCreated: 0,
          ipAssigned: 0,
          configured: 0
        }
      });
    }

    whereClause.id = { in: leadIds };

    // NOC users only see leads assigned to them; NOC_HEAD and admins see all
    if (isNOC && !isNOCHead && !isAdmin) {
      whereClause.nocAssignedToId = req.user.id;
    }

    // Filter by status (new flow: pending -> user_created -> ip_assigned -> completed)
    if (status === 'pending') {
      whereClause.customerUserId = null;
    } else if (status === 'customer_created') {
      // User created but no IPs assigned yet
      // Use AND to combine conditions properly
      whereClause.AND = [
        { customerUserId: { not: null } },
        {
          OR: [
            { customerIpAddresses: { equals: Prisma.DbNull } },
            { customerIpAddresses: { equals: Prisma.JsonNull } },
            { customerIpAddresses: { equals: [] } }
          ]
        }
      ];
    } else if (status === 'ip_assigned') {
      // IPs assigned but circuit ID not generated yet
      whereClause.AND = [
        { customerUserId: { not: null } },
        { customerIpAddresses: { not: { equals: Prisma.DbNull } } },
        { customerIpAddresses: { not: { equals: [] } } },
        { circuitId: null }
      ];
    } else if (status === 'configured') {
      whereClause.circuitId = { not: null };
    }

    const [leads, nocTotal] = await Promise.all([
      prisma.lead.findMany({
        where: whereClause,
        take: limit,
        skip,
        select: {
          id: true,
          location: true,
          fullAddress: true,
          billingAddress: true,
          billingPincode: true,
          expectedDeliveryDate: true,
          bandwidthRequirement: true,
          numberOfIPs: true,
          customerUserId: true,
          customerUsername: true,
          customerCreatedAt: true,
          customerIpAssigned: true,
          customerIpAddresses: true,
          circuitId: true,
          nocAssignedToId: true,
          nocAssignedAt: true,
          nocConfiguredAt: true,
          deliveryStatus: true,
          nocPushedToDeliveryAt: true,
          createdAt: true,
          updatedAt: true,
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
              isSelfGenerated: true,
              campaign: { select: { id: true, code: true, name: true } },
              createdBy: { select: { id: true, name: true, email: true } }
            }
          },
          createdBy: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          deliveryAssignedTo: { select: { id: true, name: true, email: true } },
          customerCreatedBy: { select: { id: true, name: true, email: true } },
          nocAssignedTo: { select: { id: true, name: true, email: true } },
          nocConfiguredBy: { select: { id: true, name: true, email: true } },
          enquiryCreatedFrom: {
            select: { id: true }
          },
          deliveryRequests: {
            where: {
              pushedToNocAt: { not: null }
            },
            select: {
              id: true,
              requestNumber: true,
              status: true,
              pushedToNocAt: true
            },
            take: 1,
            orderBy: { pushedToNocAt: 'desc' }
          },
          vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } }
        },
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.lead.count({ where: whereClause })
    ]);

    // Calculate stats from all leads pushed to NOC using already-fetched data
    // When status filter is applied, we need stats from ALL NOC leads (not just filtered)
    // Use a lightweight count query only when filter is active, otherwise reuse leads
    let allNocLeads;
    if (status !== 'all') {
      allNocLeads = await prisma.lead.findMany({
        where: { id: { in: leadIds } },
        select: {
          customerUserId: true,
          customerIpAddresses: true,
          circuitId: true
        }
      });
    } else {
      allNocLeads = leads;
    }

    // Helper to check if IPs are assigned
    const hasIps = (lead) => {
      return lead.customerIpAddresses &&
             Array.isArray(lead.customerIpAddresses) &&
             lead.customerIpAddresses.length > 0;
    };

    const stats = {
      total: allNocLeads.length,
      pending: allNocLeads.filter(l => !l.customerUserId).length,
      customerCreated: allNocLeads.filter(l => l.customerUserId && !hasIps(l)).length,
      ipAssigned: allNocLeads.filter(l => hasIps(l) && !l.circuitId).length,
      configured: allNocLeads.filter(l => l.circuitId).length
    };

    res.json({
      leads: leads.map(lead => ({
        id: lead.id,
        company: lead.campaignData?.company,
        name: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim(),
        phone: lead.campaignData?.phone,
        email: lead.campaignData?.email,
        city: lead.campaignData?.city,
        state: lead.campaignData?.state,
        location: lead.location,
        fullAddress: lead.fullAddress,
        // Billing info
        billingAddress: lead.billingAddress,
        billingPincode: lead.billingPincode,
        bandwidthRequirement: lead.bandwidthRequirement,
        numberOfIPs: lead.numberOfIPs,
        // Customer Account info
        customerUserId: lead.customerUserId,
        customerUsername: lead.customerUsername,
        customerCreatedAt: lead.customerCreatedAt,
        customerCreatedBy: lead.customerCreatedBy,
        customerIpAssigned: lead.customerIpAssigned,
        customerIpAddresses: lead.customerIpAddresses || [],
        circuitId: lead.circuitId,
        nocAssignedTo: lead.nocAssignedTo,
        nocConfiguredAt: lead.nocConfiguredAt,
        nocConfiguredBy: lead.nocConfiguredBy,
        // Delivery info
        deliveryAssignedTo: lead.deliveryAssignedTo,
        deliveryStatus: lead.deliveryStatus,
        // Campaign
        campaign: lead.campaignData?.campaign,
        // Self-generated info
        isSelfGenerated: lead.campaignData?.isSelfGenerated || false,
        dataCreatedBy: lead.campaignData?.createdBy || lead.createdBy,
        // Customer referral info
        isCustomerReferral: !!lead.enquiryCreatedFrom,
        // BDM
        bdm: lead.assignedTo,
        // Delivery request
        deliveryRequest: lead.deliveryRequests?.[0] || null,
        pushedToNocAt: lead.deliveryRequests?.[0]?.pushedToNocAt,
        // NOC push to delivery
        nocPushedToDeliveryAt: lead.nocPushedToDeliveryAt,
        // Vendor / Channel Partner info
        vendor: lead.vendor,
        // Timestamps
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt
      })),
      stats,
      pagination: { page, limit, total: nocTotal, totalPages: Math.ceil(nocTotal / limit) }
    });
});

/**
 * NOC Head: Assign lead to a NOC user
 * POST /leads/noc/:id/assign
 */
export const nocAssignLead = asyncHandler(async function nocAssignLead(req, res) {
    const { id } = req.params;
    const { nocUserId } = req.body;
    const isNOCHead = hasRole(req.user, 'NOC_HEAD');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isNOCHead && !isAdmin) {
      return res.status(403).json({ message: 'Only NOC Head can assign leads.' });
    }

    if (!nocUserId) {
      return res.status(400).json({ message: 'NOC user ID is required.' });
    }

    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    const nocUser = await prisma.user.findUnique({ where: { id: nocUserId }, select: { id: true, name: true, role: true } });
    if (!nocUser || (nocUser.role !== 'NOC' && nocUser.role !== 'NOC_HEAD')) {
      return res.status(400).json({ message: 'Invalid NOC user.' });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: { nocAssignedToId: nocUserId, nocAssignedAt: new Date() }
    });

    emitSidebarRefresh(nocUserId);

    res.json({ message: `Lead assigned to ${nocUser.name}.`, lead: updated });
});

/**
 * NOC Head: Get NOC team stats
 * GET /leads/noc/team-stats
 */
export const getNocTeamStats = asyncHandler(async function getNocTeamStats(req, res) {
    const isNOCHead = hasRole(req.user, 'NOC_HEAD');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isNOCHead && !isAdmin) {
      return res.status(403).json({ message: 'Only NOC Head can view team stats.' });
    }

    // Get all NOC users
    const nocUsers = await prisma.user.findMany({
      where: { role: 'NOC', isActive: true },
      select: { id: true, name: true, email: true }
    });

    // Get all NOC-pushed leads
    const deliveryRequests = await prisma.deliveryRequest.findMany({
      where: { pushedToNocAt: { not: null } },
      select: { leadId: true }
    });
    const leadIds = deliveryRequests.map(dr => dr.leadId);

    if (leadIds.length === 0) {
      return res.json({ nocUsers: nocUsers.map(u => ({ ...u, stats: { assigned: 0, pending: 0, customerCreated: 0, ipAssigned: 0, configured: 0 } })), unassigned: 0 });
    }

    // Get all leads with NOC data
    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds } },
      select: {
        id: true,
        nocAssignedToId: true,
        customerUserId: true,
        customerIpAddresses: true,
        circuitId: true
      }
    });

    const hasIps = (lead) => lead.customerIpAddresses && Array.isArray(lead.customerIpAddresses) && lead.customerIpAddresses.length > 0;

    const unassigned = leads.filter(l => !l.nocAssignedToId).length;

    const userStats = nocUsers.map(user => {
      const userLeads = leads.filter(l => l.nocAssignedToId === user.id);
      return {
        ...user,
        stats: {
          assigned: userLeads.length,
          pending: userLeads.filter(l => !l.customerUserId).length,
          customerCreated: userLeads.filter(l => l.customerUserId && !hasIps(l)).length,
          ipAssigned: userLeads.filter(l => hasIps(l) && !l.circuitId).length,
          configured: userLeads.filter(l => !!l.circuitId).length
        }
      };
    });

    res.json({ nocUsers: userStats, unassigned, totalLeads: leads.length });
});

// Get NOC lead details
export const getNocLeadDetails = asyncHandler(async function getNocLeadDetails(req, res) {
    const { id } = req.params;
    const userRole = req.user.role;
    const isNOC = userRole === 'NOC' || userRole === 'NOC_HEAD';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isNOC && !isAdmin) {
      return res.status(403).json({ message: 'Only NOC team can access this endpoint.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: { select: { id: true, name: true, email: true } },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        customerCreatedBy: { select: { id: true, name: true, email: true } },
        nocConfiguredBy: { select: { id: true, name: true, email: true } },
        deliveryRequests: {
          where: {
            pushedToNocAt: { not: null }
          },
          select: {
            id: true,
            requestNumber: true,
            status: true,
            pushedToNocAt: true,
            items: true
          },
          take: 1,
          orderBy: { pushedToNocAt: 'desc' }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Verify lead has been pushed to NOC
    if (!lead.deliveryRequests || lead.deliveryRequests.length === 0) {
      return res.status(400).json({ message: 'This lead has not been pushed to NOC.' });
    }

    res.json({
      lead: {
        id: lead.id,
        company: lead.campaignData?.company,
        companyName: lead.campaignData?.company,
        name: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim(),
        phone: lead.campaignData?.phone,
        email: lead.campaignData?.email,
        city: lead.campaignData?.city,
        state: lead.campaignData?.state,
        address: lead.campaignData?.address,
        location: lead.location,
        latitude: lead.latitude,
        longitude: lead.longitude,
        fullAddress: lead.fullAddress,
        // Billing info
        billingAddress: lead.billingAddress,
        billingPincode: lead.billingPincode,
        bandwidthRequirement: lead.bandwidthRequirement,
        numberOfIPs: lead.numberOfIPs,
        // Financial
        arcAmount: lead.arcAmount,
        otcAmount: lead.otcAmount,
        // Customer Account info
        customerUserId: lead.customerUserId,
        customerUsername: lead.customerUsername,
        customerCreatedAt: lead.customerCreatedAt,
        customerCreatedBy: lead.customerCreatedBy,
        customerIpAssigned: lead.customerIpAssigned,
        customerIpAddresses: lead.customerIpAddresses || [],
        circuitId: lead.circuitId,
        nocAssignedTo: lead.nocAssignedTo,
        nocConfiguredAt: lead.nocConfiguredAt,
        nocConfiguredBy: lead.nocConfiguredBy,
        // Delivery info
        deliveryAssignedTo: lead.deliveryAssignedTo,
        deliveryStatus: lead.deliveryStatus,
        // Campaign
        campaign: lead.campaignData?.campaign,
        // BDM
        bdm: lead.assignedTo,
        // Delivery request
        deliveryRequest: lead.deliveryRequests?.[0] || null,
        pushedToNocAt: lead.deliveryRequests?.[0]?.pushedToNocAt,
        // NOC push to delivery
        nocPushedToDeliveryAt: lead.nocPushedToDeliveryAt,
        // Timestamps
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt
      }
    });
});

// Push to Delivery from NOC (after configuration is complete)
export const nocPushToDelivery = asyncHandler(async function nocPushToDelivery(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isNOC = userRole === 'NOC' || userRole === 'NOC_HEAD';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isNOC && !isAdmin) {
      return res.status(403).json({ message: 'Only NOC team can push to delivery.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        deliveryRequests: {
          where: { pushedToNocAt: { not: null } },
          take: 1,
          orderBy: { pushedToNocAt: 'desc' }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Check if NOC configuration is complete
    if (!lead.circuitId) {
      return res.status(400).json({ message: 'NOC configuration is not complete. Please generate Circuit ID first.' });
    }

    // Check if already pushed back to delivery
    if (lead.nocPushedToDeliveryAt) {
      return res.status(400).json({ message: 'Already pushed to delivery.' });
    }

    // Update lead: auto-transition to INSTALLING (skip ACTIVATION_READY stage)
    const updated = await prisma.lead.update({
      where: { id },
      data: {
        nocPushedToDeliveryAt: new Date(),
        nocPushedToDeliveryById: userId,
        deliveryStatus: 'INSTALLING',
        installationStartedAt: new Date()
      },
      include: {
        deliveryAssignedTo: { select: { id: true, name: true, email: true } }
      }
    });

    // Sidebar refresh: delivery team gets activation-ready work
    if (updated.deliveryAssignedToId) emitSidebarRefresh(updated.deliveryAssignedToId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: `Pushed to delivery (${lead.deliveryAssignedTo?.name || 'Unassigned'}) successfully.`
    });
});

// ========== END NOC TEAM FUNCTIONS ==========

// ========== DELIVERY SPEED TEST & CUSTOMER ACCEPTANCE ==========

// Upload speed test screenshots (2 images: speed test and latency test)
export const uploadSpeedTest = asyncHandler(async function uploadSpeedTest(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can upload speed test.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Check if installation is complete
    if (!lead.installationCompletedAt && lead.deliveryStatus !== 'SPEED_TEST') {
      return res.status(400).json({ message: 'Installation must be completed first.' });
    }

    // Get uploaded files (from multer fields)
    const files = req.files;
    if (!files) {
      return res.status(400).json({ message: 'No files uploaded.' });
    }

    // Files come as { speedTest: [file], latencyTest: [file] }
    const speedTestFile = files.speedTest?.[0];
    const latencyTestFile = files.latencyTest?.[0];

    if (!speedTestFile || !latencyTestFile) {
      return res.status(400).json({ message: 'Both speed test and latency test screenshots are required.' });
    }

    // Update lead with uploaded URLs
    const updated = await prisma.lead.update({
      where: { id },
      data: {
        speedTestScreenshot: speedTestFile.path, // Cloudinary URL
        latencyTestScreenshot: latencyTestFile.path, // Cloudinary URL
        speedTestUploadedAt: new Date(),
        speedTestUploadedById: userId,
        deliveryStatus: 'CUSTOMER_ACCEPTANCE' // Move to next stage
      },
      include: {
        campaignData: true,
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        speedTestUploadedBy: { select: { id: true, name: true, email: true } }
      }
    });

    // Notify BDM and admin about delivery status change
    if (updated.assignedToId) {
      emitSidebarRefresh(updated.assignedToId);
    }
    emitSidebarRefreshByRole('DELIVERY_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: 'Speed test uploaded successfully. Proceed to customer acceptance.'
    });
});

// Bypass speed test (testing only - skips file upload, sets placeholder URLs)
export const bypassSpeedTest = asyncHandler(async function bypassSpeedTest(req, res) {
    const { id } = req.params;
    const userId = req.user.id;

    if (!isAdminOrTestUser(req.user) && req.user.role !== 'DELIVERY_TEAM') {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        speedTestScreenshot: 'https://placehold.co/600x400?text=Speed+Test+Bypass',
        latencyTestScreenshot: 'https://placehold.co/600x400?text=Latency+Test+Bypass',
        speedTestUploadedAt: new Date(),
        speedTestUploadedById: userId,
        deliveryStatus: 'CUSTOMER_ACCEPTANCE'
      },
      include: {
        campaignData: true,
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        speedTestUploadedBy: { select: { id: true, name: true, email: true } }
      }
    });

    if (updated.assignedToId) emitSidebarRefresh(updated.assignedToId);
    emitSidebarRefreshByRole('DELIVERY_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({ lead: updated, message: 'Speed test bypassed (test mode). Proceed to customer acceptance.' });
});

// Customer acceptance (accept/reject based on customer feedback)
export const customerAcceptance = asyncHandler(async function customerAcceptance(req, res) {
    const { id } = req.params;
    const { status, notes } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can record customer acceptance.' });
    }

    if (!status || !['ACCEPTED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ message: 'Status must be ACCEPTED or REJECTED.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Check if speed test is complete
    if (!lead.speedTestUploadedAt) {
      return res.status(400).json({ message: 'Speed test must be uploaded first.' });
    }

    // Update lead with customer acceptance
    const updateData = {
      customerAcceptanceStatus: status,
      customerAcceptanceAt: new Date(),
      customerAcceptanceById: userId,
      deliveryStatus: status === 'ACCEPTED' ? 'COMPLETED' : 'REJECTED'
    };

    // If accepted, deactivate the demo plan automatically
    if (status === 'ACCEPTED') {
      updateData.demoPlanIsActive = false;
    }

    if (notes) {
      updateData.customerAcceptanceNotes = notes;
    }

    // Handle uploaded acceptance screenshot
    if (req.file) {
      updateData.customerAcceptanceScreenshot = req.file.path;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: true,
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        customerAcceptanceBy: { select: { id: true, name: true, email: true } },
        speedTestUploadedBy: { select: { id: true, name: true, email: true } }
      }
    });

    // Notify BDM about delivery completion and Accounts Team about new plan creation pending
    if (updated.assignedToId) {
      emitSidebarRefresh(updated.assignedToId);
    }
    if (status === 'ACCEPTED') {
      emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    }
    emitSidebarRefreshByRole('DELIVERY_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: status === 'ACCEPTED'
        ? 'Customer accepted. Delivery completed successfully!'
        : 'Customer rejected. Please review and take necessary action.'
    });
});

// Retry after customer rejection — reset to speed test stage for re-verification
export const retryCustomerAcceptance = asyncHandler(async function retryCustomerAcceptance(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const isDeliveryTeam = hasRole(req.user, 'DELIVERY_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can retry customer acceptance.' });
    }

    const lead = await prisma.lead.findUnique({ where: { id } });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (lead.customerAcceptanceStatus !== 'REJECTED') {
      return res.status(400).json({ message: 'Only rejected leads can be retried.' });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        customerAcceptanceStatus: null,
        customerAcceptanceAt: null,
        customerAcceptanceById: null,
        customerAcceptanceNotes: null,
        customerAcceptanceScreenshot: null,
        deliveryStatus: 'SPEED_TEST',
        speedTestUploadedAt: null,
        speedTestUploadedById: null,
        speedTestScreenshot: null
      },
      include: {
        campaignData: { select: { company: true } }
      }
    });

    emitSidebarRefreshByRole('DELIVERY_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');
    if (updated.assignedToId) emitSidebarRefresh(updated.assignedToId);

    res.json({
      lead: updated,
      message: 'Lead reset to speed test stage. Delivery team can re-upload speed test and retry acceptance.'
    });
});

// Get speed test details for a lead
export const getSpeedTestDetails = asyncHandler(async function getSpeedTestDetails(req, res) {
    const { id } = req.params;
    const userRole = req.user.role;
    const isDeliveryTeam = userRole === 'DELIVERY_TEAM';
    const isAdmin = isAdminOrTestUser(req.user);
    const isNOC = userRole === 'NOC' || userRole === 'NOC_HEAD';

    if (!isDeliveryTeam && !isAdmin && !isNOC) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        speedTestScreenshot: true,
        latencyTestScreenshot: true,
        speedTestUploadedAt: true,
        speedTestUploadedBy: { select: { id: true, name: true, email: true } },
        customerAcceptanceStatus: true,
        customerAcceptanceAt: true,
        customerAcceptanceBy: { select: { id: true, name: true, email: true } },
        customerAcceptanceNotes: true,
        deliveryStatus: true,
        installationStartedAt: true,
        installationCompletedAt: true
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    res.json(lead);
});

// ========== END DELIVERY SPEED TEST & CUSTOMER ACCEPTANCE ==========

// ========== DEMO PLAN ASSIGNMENT (ACCOUNTS TEAM) ==========

// Get leads pending demo plan assignment (for Accounts team)
export const getDemoPlanQueue = asyncHandler(async function getDemoPlanQueue(req, res) {
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can access this endpoint.' });
    }

    const { status = 'pending' } = req.query; // pending, assigned, all

    let whereClause = {
      pushedToInstallationAt: { not: null }
    };

    if (status === 'pending') {
      whereClause.deliveryStatus = 'DEMO_PLAN_PENDING';
    } else if (status === 'assigned') {
      whereClause.demoPlanAssignedAt = { not: null };
    }

    const leads = await prisma.lead.findMany({
      where: whereClause,
      orderBy: { installationCompletedAt: 'desc' },
      include: {
        campaignData: {
          include: {
            campaign: { select: { id: true, code: true, name: true } }
          }
        },
        assignedTo: { select: { id: true, name: true, email: true } },
        deliveryAssignedTo: { select: { id: true, name: true, email: true } },
        demoPlanAssignedBy: { select: { id: true, name: true, email: true } }
      }
    });

    // Format response
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      phone: lead.campaignData.phone,
      email: lead.campaignData.email,
      city: lead.campaignData.city,
      state: lead.campaignData.state,
      fullAddress: lead.fullAddress,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      // Customer credentials
      customerUsername: lead.customerUsername,
      customerUserId: lead.customerUserId,
      customerIpAddresses: lead.customerIpAddresses,
      circuitId: lead.circuitId,
      // Demo plan info
      demoPlanName: lead.demoPlanName,
      demoPlanBandwidth: lead.demoPlanBandwidth,
      demoPlanUploadBandwidth: lead.demoPlanUploadBandwidth,
      demoPlanDataLimit: lead.demoPlanDataLimit,
      demoPlanValidityDays: lead.demoPlanValidityDays,
      demoPlanIsActive: lead.demoPlanIsActive,
      demoPlanAssignedAt: lead.demoPlanAssignedAt,
      demoPlanAssignedBy: lead.demoPlanAssignedBy,
      demoPlanNotes: lead.demoPlanNotes,
      demoPlanStartDate: lead.demoPlanStartDate,
      demoPlanEndDate: lead.demoPlanEndDate,
      // Other info
      deliveryStatus: lead.deliveryStatus,
      installationCompletedAt: lead.installationCompletedAt,
      bdm: lead.assignedTo,
      deliveryPerson: lead.deliveryAssignedTo,
      campaign: lead.campaignData.campaign
    }));

    // Get counts
    const pendingCount = await prisma.lead.count({
      where: { deliveryStatus: 'DEMO_PLAN_PENDING' }
    });
    const assignedCount = await prisma.lead.count({
      where: { demoPlanAssignedAt: { not: null } }
    });

    res.json({
      leads: formattedLeads,
      stats: {
        pending: pendingCount,
        assigned: assignedCount
      }
    });
});

// Helper function to calculate end date based on billing type
const calculateEndDate = (startDate, validityDays, billingType, billingCycle) => {
  if (!validityDays) return null;

  // For Month End billing with a billing cycle, align to month boundaries
  // The partial start month counts as month 1 of the cycle
  // e.g., March 15 QUARTERLY → end May 31 (March partial + April + May)
  // e.g., June 1 QUARTERLY → end Aug 31 (June + July + Aug)
  if (billingType === 'MONTHLY' && billingCycle) {
    let cycleMonths;
    switch (billingCycle) {
      case 'MONTHLY': cycleMonths = 1; break;
      case 'QUARTERLY': cycleMonths = 3; break;
      case 'HALF_YEARLY': cycleMonths = 6; break;
      case 'YEARLY': cycleMonths = 12; break;
      default: cycleMonths = 1;
    }
    const start = new Date(startDate);
    // End at last day of (startMonth + cycleMonths - 1)
    const endDate = new Date(start.getFullYear(), start.getMonth() + cycleMonths, 0);
    endDate.setHours(23, 59, 59, 999);
    return endDate;
  }

  const endDate = new Date(startDate);
  // Subtract 1 because: Day 1 = startDate, Day N = startDate + (N-1)
  // e.g., 90-day plan starting Jan 31: Day 90 = Jan 31 + 89 = Apr 30
  endDate.setDate(endDate.getDate() + parseInt(validityDays) - 1);

  return endDate;
};

// Assign demo plan to a lead (Accounts team) - Simplified: just plan name, speeds, and active status
export const assignDemoPlan = asyncHandler(async function assignDemoPlan(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can assign demo plans.' });
    }

    const {
      planName,
      bandwidth,        // in kbps (download speed)
      uploadBandwidth,  // in kbps (upload speed, optional)
      isActive,
      notes,
      expiryDate,       // ISO date string (YYYY-MM-DD or full ISO) — demo plan auto-stops after this
    } = req.body;

    // Validate required fields
    if (!planName || !bandwidth) {
      return res.status(400).json({ message: 'Plan name and bandwidth are required.' });
    }

    // Validate expiry date if provided
    let parsedExpiry = null;
    if (expiryDate) {
      parsedExpiry = new Date(expiryDate);
      if (Number.isNaN(parsedExpiry.getTime())) {
        return res.status(400).json({ message: 'Invalid expiry date.' });
      }
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (lead.deliveryStatus !== 'DEMO_PLAN_PENDING') {
      return res.status(400).json({ message: 'Lead is not in demo plan pending status.' });
    }

    // Don't allow demo plan if actual plan is already active
    if (lead.actualPlanIsActive) {
      return res.status(400).json({ message: 'Cannot assign demo plan when actual plan is already active.' });
    }

    // Check if customer user exists
    if (!lead.customerUsername) {
      return res.status(400).json({ message: 'Customer user must be created first by NOC.' });
    }

    // Update lead with demo plan (simplified - no billing info)
    const now = new Date();
    const updated = await prisma.lead.update({
      where: { id },
      data: {
        demoPlanName: planName,
        demoPlanBandwidth: parseInt(bandwidth),
        demoPlanUploadBandwidth: uploadBandwidth ? parseInt(uploadBandwidth) : null,
        demoPlanIsActive: isActive ?? true,
        demoPlanAssignedAt: now,
        demoPlanStartDate: now,
        demoPlanEndDate: parsedExpiry,
        demoPlanAssignedById: userId,
        demoPlanNotes: notes || null,
        // Move to next stage (Speed Test)
        deliveryStatus: 'SPEED_TEST'
      },
      include: {
        campaignData: true,
        demoPlanAssignedBy: { select: { id: true, name: true, email: true } }
      }
    });

    // Notify Accounts Team (demoPlanPending count changes) and Delivery Team
    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('DELIVERY_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: 'Demo plan assigned successfully. Lead moved to Speed Test stage.'
    });
});

// Toggle demo plan active status
export const toggleDemoPlanStatus = asyncHandler(async function toggleDemoPlanStatus(req, res) {
    const { id } = req.params;
    const { isActive } = req.body;
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can modify demo plans.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.demoPlanAssignedAt) {
      return res.status(400).json({ message: 'No demo plan assigned to this lead.' });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        demoPlanIsActive: isActive
      }
    });

    res.json({
      lead: updated,
      message: `Demo plan ${isActive ? 'activated' : 'deactivated'} successfully.`
    });
});

// ========== END DEMO PLAN ASSIGNMENT ==========

// ========== ACTUAL PLAN MANAGEMENT (After Customer Acceptance) ==========

// Get leads with customer acceptance completed (for Create Plan)
export const getCompletedLeadsQueue = asyncHandler(async function getCompletedLeadsQueue(req, res) {
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can access this.' });
    }

    const { status } = req.query; // 'pending' or 'created'

    let whereCondition = {};

    if (status === 'created') {
      // Leads with actual plan already created
      whereCondition = {
        actualPlanCreatedAt: { not: null }
      };
    } else {
      // Leads with customer acceptance done but no actual plan
      whereCondition = {
        deliveryStatus: 'COMPLETED',
        customerAcceptanceStatus: 'ACCEPTED',
        actualPlanCreatedAt: null
      };
    }

    const leads = await prisma.lead.findMany({
      where: whereCondition,
      include: {
        campaignData: {
          select: {
            company: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            city: true,
            state: true
          }
        },
        assignedTo: { select: { id: true, name: true } },
        actualPlanCreatedBy: { select: { id: true, name: true } }
      },
      orderBy: status === 'created'
        ? { actualPlanCreatedAt: 'desc' }
        : { customerAcceptanceAt: 'desc' }
    });

    // Count stats
    const [pendingCount, createdCount] = await Promise.all([
      prisma.lead.count({
        where: {
          deliveryStatus: 'COMPLETED',
          customerAcceptanceStatus: 'ACCEPTED',
          actualPlanCreatedAt: null
        }
      }),
      prisma.lead.count({
        where: {
          actualPlanCreatedAt: { not: null }
        }
      })
    ]);

    // Format leads
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      company: lead.campaignData?.company || '-',
      name: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim() || '-',
      email: lead.campaignData?.email,
      phone: lead.campaignData?.phone,
      city: lead.campaignData?.city,
      state: lead.campaignData?.state,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      customerUserId: lead.customerUserId,
      customerUsername: lead.customerUsername,
      circuitId: lead.circuitId,
      // Financial details
      arcAmount: lead.arcAmount,
      otcAmount: lead.otcAmount,
      advanceAmount: lead.advanceAmount,
      // Demo plan details
      demoPlanName: lead.demoPlanName,
      demoPlanBandwidth: lead.demoPlanBandwidth,
      demoPlanIsActive: lead.demoPlanIsActive,
      // Actual plan details
      actualPlanName: lead.actualPlanName,
      actualPlanBandwidth: lead.actualPlanBandwidth,
      actualPlanUploadBandwidth: lead.actualPlanUploadBandwidth,
      actualPlanDataLimit: lead.actualPlanDataLimit,
      actualPlanValidityDays: lead.actualPlanValidityDays,
      actualPlanPrice: lead.actualPlanPrice,
      actualPlanIsActive: lead.actualPlanIsActive,
      actualPlanStartDate: lead.actualPlanStartDate,
      actualPlanEndDate: lead.actualPlanEndDate,
      actualPlanCreatedAt: lead.actualPlanCreatedAt,
      actualPlanCreatedBy: lead.actualPlanCreatedBy,
      actualPlanNotes: lead.actualPlanNotes,
      // Dates
      customerAcceptanceAt: lead.customerAcceptanceAt,
      isImported: lead.isImported,
      assignedTo: lead.assignedTo
    }));

    res.json({
      leads: formattedLeads,
      stats: {
        pending: pendingCount,
        created: createdCount
      }
    });
});

// Create actual plan for a lead
export const createActualPlan = asyncHandler(async function createActualPlan(req, res) {
    const { id } = req.params;
    const {
      planName,
      bandwidth,
      uploadBandwidth,
      dataLimit,
      validityDays,     // billing cycle in days (30, 90, 180, 365)
      billingType,      // DAY_TO_DAY or MONTHLY
      billingCycle,     // MONTHLY, QUARTERLY, HALF_YEARLY, YEARLY
      price,
      isActive,
      startDate,
      poNumber,
      poExpiryDate,
      notes
    } = req.body;

    const userId = req.user.id;
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can create plans.' });
    }

    if (!planName || !bandwidth) {
      return res.status(400).json({ message: 'Plan name and bandwidth are required.' });
    }
    if (!poNumber || !poNumber.trim()) {
      return res.status(400).json({ message: 'PO Number is required.' });
    }
    if (!poExpiryDate) {
      return res.status(400).json({ message: 'PO Expiry Date is required.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (lead.customerAcceptanceStatus !== 'ACCEPTED') {
      return res.status(400).json({ message: 'Customer acceptance is required before creating actual plan.' });
    }

    // Calculate start and end dates using billing type logic
    const planStartDate = startDate ? new Date(startDate) : new Date();
    const planEndDate = calculateEndDate(planStartDate, validityDays, billingType, billingCycle);

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        actualPlanName: planName,
        actualPlanBandwidth: parseInt(bandwidth),
        actualPlanUploadBandwidth: uploadBandwidth ? parseInt(uploadBandwidth) : null,
        actualPlanDataLimit: dataLimit ? parseInt(dataLimit) : null,
        actualPlanValidityDays: validityDays ? parseInt(validityDays) : null,
        actualPlanBillingType: billingType || 'DAY_TO_DAY',
        actualPlanBillingCycle: billingCycle || 'MONTHLY',
        actualPlanPrice: price ? parseFloat(price) : null,
        actualPlanIsActive: isActive ?? true,
        actualPlanStartDate: planStartDate,
        actualPlanEndDate: planEndDate,
        actualPlanCreatedAt: new Date(),
        actualPlanCreatedById: userId,
        actualPlanNotes: notes || null,
        poNumber: poNumber || undefined,
        poExpiryDate: poExpiryDate ? new Date(poExpiryDate) : undefined,
        // Deactivate demo plan when actual plan is created
        demoPlanIsActive: false
      },
      include: {
        campaignData: {
          select: { company: true, name: true }
        },
        actualPlanCreatedBy: { select: { id: true, name: true } }
      }
    });

    // Trigger immediate invoice generation for this lead if billing period has started
    try {
      const { generateInvoiceForLead } = await import('../jobs/invoiceGeneration.js');
      await generateInvoiceForLead(updated.id, userId);
    } catch (invoiceError) {
      console.error('Auto-invoice generation error:', invoiceError.message);
      // Don't fail the plan creation if invoice generation fails
    }

    // Notify Accounts Team (createPlanPending count changes)
    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: 'Actual plan created successfully. Demo plan has been deactivated.'
    });
});

// Toggle actual plan status
export const toggleActualPlanStatus = asyncHandler(async function toggleActualPlanStatus(req, res) {
    const { id } = req.params;
    const { isActive } = req.body;
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can modify plans.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.actualPlanCreatedAt) {
      return res.status(400).json({ message: 'No actual plan created for this lead.' });
    }

    const updateData = { actualPlanIsActive: isActive };

    // Ensure demo plan is deactivated when activating actual plan
    if (isActive) {
      updateData.demoPlanIsActive = false;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData
    });

    res.json({
      lead: updated,
      message: `Plan ${isActive ? 'activated' : 'deactivated'} successfully.`
    });
});

// Upgrade actual plan for a lead (mid-billing-cycle upgrade with pro-rated billing)
export const upgradeActualPlan = asyncHandler(async function upgradeActualPlan(req, res) {
    const { id } = req.params;
    const {
      planName,
      bandwidth,
      uploadBandwidth,
      newArc,
      upgradeDate,
      notes
    } = req.body;

    const userId = req.user.id;
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can upgrade plans.' });
    }

    // Validate required fields (newArc can be 0 for rate revisions)
    if (!planName || !bandwidth || (newArc === undefined || newArc === null) || !upgradeDate) {
      return res.status(400).json({ message: 'Plan name, bandwidth, new ARC, and upgrade date are required.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: { select: { company: true, name: true, phone: true, email: true, address: true } }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.actualPlanCreatedAt) {
      return res.status(400).json({ message: 'No actual plan exists for this lead. Create a plan first.' });
    }

    if (!lead.actualPlanIsActive) {
      return res.status(400).json({ message: 'Cannot upgrade an inactive plan. Activate the plan first.' });
    }

    // Normalize dates to UTC midnight
    const normalizeDate = (date) => {
      const d = new Date(date);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    };

    const upgradeDateObj = normalizeDate(upgradeDate);
    const planStartDate = normalizeDate(lead.actualPlanStartDate);
    const planEndDate = normalizeDate(lead.actualPlanEndDate);

    if (upgradeDateObj < planStartDate) {
      return res.status(400).json({ message: 'Upgrade date cannot be before the plan start date.' });
    }

    if (upgradeDateObj > planEndDate) {
      return res.status(400).json({ message: 'Upgrade date cannot be after the current billing period end.' });
    }

    // Calculate days for upgrade period (upgrade date to billing period end)
    const daysBetween = (start, end) => {
      const diffTime = normalizeDate(end).getTime() - normalizeDate(start).getTime();
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    };

    // Upgrade period: from upgrade date to billing period end
    const upgradePeriodDays = daysBetween(upgradeDateObj, planEndDate) + 1; // Include both start and end dates

    // Calculate pro-rated amount for upgrade period (Additional ARC / 360 * days)
    // IMPORTANT: Use arcAmount (annual) not actualPlanPrice (billing cycle price)
    const oldArc = lead.arcAmount || 0;
    const additionalArc = parseFloat(newArc); // This is the ADDITIONAL ARC entered by user
    const newTotalArc = oldArc + additionalArc; // New total ARC = old + additional

    // Upgrade invoice is calculated on the ADDITIONAL ARC for remaining days
    const upgradeBaseAmount = Math.round((additionalArc / 360) * upgradePeriodDays);

    // GST calculation
    const sgstRate = 9;
    const cgstRate = 9;
    const upgradeSgst = Math.round((upgradeBaseAmount * sgstRate) / 100);
    const upgradeCgst = Math.round((upgradeBaseAmount * cgstRate) / 100);
    const upgradeTotal = upgradeBaseAmount + upgradeSgst + upgradeCgst;

    // Use a transaction for data consistency
    const result = await prisma.$transaction(async (tx) => {
      // 1. Generate invoice number for upgrade
      const upgradeInvoiceNumber = await generateInvoiceNumber();

      // Invoice dates
      const invoiceDate = new Date();
      const dueDate = new Date(invoiceDate);
      dueDate.setDate(dueDate.getDate() + 15);

      // 2. Create Upgrade Invoice (additional invoice for upgrade period at new rate)
      // Note: Original invoice remains untouched
      const upgradeInvoice = await tx.invoice.create({
        data: {
          invoiceNumber: upgradeInvoiceNumber,
          leadId: id,
          invoiceDate,
          dueDate,
          billingPeriodStart: upgradeDateObj,
          billingPeriodEnd: planEndDate,
          companyName: lead.campaignData?.company || 'Unknown',
          customerUsername: lead.customerUsername,
          billingAddress: lead.billingAddress || lead.fullAddress || lead.campaignData?.address,
          installationAddress: lead.fullAddress,
          contactPhone: lead.campaignData?.phone,
          contactEmail: lead.campaignData?.email,
          planName: `${planName} (Upgrade)`,
          planDescription: `Upgrade charges for ${upgradePeriodDays} days (${upgradeDateObj.toISOString().split('T')[0]} to ${planEndDate.toISOString().split('T')[0]})`,
          hsnSacCode: '998422',
          baseAmount: upgradeBaseAmount,
          discountAmount: 0,
          taxableAmount: upgradeBaseAmount,
          sgstRate,
          cgstRate,
          sgstAmount: upgradeSgst,
          cgstAmount: upgradeCgst,
          totalGstAmount: upgradeSgst + upgradeCgst,
          grandTotal: upgradeTotal,
          status: 'GENERATED',
          notes: `Upgrade invoice - ${lead.actualPlanName} to ${planName} - ${upgradePeriodDays} days | Additional ARC: ₹${additionalArc} | New Total ARC: ₹${newTotalArc}`,
          createdById: userId
        }
      });

      // 3. Create upgrade history record
      const totalDays = daysBetween(planStartDate, planEndDate) + 1;
      const daysOnOldPlan = daysBetween(planStartDate, upgradeDateObj);

      const upgradeHistory = await tx.planUpgradeHistory.create({
        data: {
          leadId: id,
          previousPlanName: lead.actualPlanName,
          previousBandwidth: lead.actualPlanBandwidth,
          previousUploadBandwidth: lead.actualPlanUploadBandwidth,
          previousArc: oldArc,
          previousValidityDays: lead.actualPlanValidityDays,
          previousBillingType: lead.actualPlanBillingType,
          previousPlanStartDate: lead.actualPlanStartDate,
          previousPlanEndDate: lead.actualPlanEndDate,
          newPlanName: planName,
          newBandwidth: parseInt(bandwidth),
          newUploadBandwidth: uploadBandwidth ? parseInt(uploadBandwidth) : null,
          newArc: newTotalArc, // Store the NEW TOTAL ARC (old + additional)
          additionalArc: additionalArc, // Store the additional ARC that was added
          upgradeDate: upgradeDateObj,
          daysOnOldPlan: daysOnOldPlan,
          daysOnNewPlan: upgradePeriodDays,
          oldPlanAmount: 0, // Original invoice already exists
          newPlanAmount: upgradeTotal,
          totalAmount: upgradeTotal,
          originalAmount: 0,
          differenceAmount: upgradeTotal,
          notes: notes || null,
          createdById: userId
        }
      });

      // 4. Update the lead with new plan details
      const bandwidthKbps = parseInt(bandwidth);
      let bandwidthDisplay;
      if (bandwidthKbps >= 1000000) {
        bandwidthDisplay = `${(bandwidthKbps / 1000000).toFixed(1)} Gbps`;
      } else if (bandwidthKbps >= 1000) {
        bandwidthDisplay = `${Math.round(bandwidthKbps / 1000)} Mbps`;
      } else {
        bandwidthDisplay = `${bandwidthKbps} Kbps`;
      }

      const updatedLead = await tx.lead.update({
        where: { id },
        data: {
          actualPlanName: planName,
          actualPlanBandwidth: bandwidthKbps,
          actualPlanUploadBandwidth: uploadBandwidth ? parseInt(uploadBandwidth) : null,
          actualPlanPrice: newTotalArc, // NEW TOTAL ARC (old + additional)
          arcAmount: newTotalArc, // NEW TOTAL ARC (old + additional)
          bandwidthRequirement: bandwidthDisplay,
          actualPlanNotes: lead.actualPlanNotes
            ? `${lead.actualPlanNotes}\n\n[UPGRADE ${new Date().toISOString().split('T')[0]}] Additional ARC: ₹${additionalArc}, New Total ARC: ₹${newTotalArc}. ${notes || ''}`
            : `[UPGRADE ${new Date().toISOString().split('T')[0]}] Additional ARC: ₹${additionalArc}, New Total ARC: ₹${newTotalArc}. ${notes || ''}`
        },
        include: {
          campaignData: { select: { company: true, name: true } },
          actualPlanCreatedBy: { select: { id: true, name: true } }
        }
      });

      return { upgradeHistory, updatedLead, upgradeInvoice };
    });

    // Create ledger entry for upgrade invoice
    await createInvoiceLedgerEntry(result.upgradeInvoice, userId);

    // Return success response with invoice details
    res.json({
      lead: result.updatedLead,
      upgradeHistory: result.upgradeHistory,
      upgradeInvoice: {
        invoiceNumber: result.upgradeInvoice.invoiceNumber,
        period: `${upgradeDateObj.toISOString().split('T')[0]} to ${planEndDate.toISOString().split('T')[0]}`,
        days: upgradePeriodDays,
        additionalArc: additionalArc,
        newTotalArc: newTotalArc,
        baseAmount: upgradeBaseAmount,
        gst: upgradeSgst + upgradeCgst,
        total: upgradeTotal
      },
      message: `Plan upgraded successfully. Additional ARC: ₹${additionalArc}, New Total ARC: ₹${newTotalArc}. Upgrade invoice: ₹${upgradeTotal} for ${upgradePeriodDays} days.`
    });
});

/**
 * Degrade (downgrade) an actual plan for a lead
 * Creates a credit note on the last invoice for remaining days at the degrade ARC
 * Subtracts degrade ARC from old ARC for future billing
 */
export const degradeActualPlan = asyncHandler(async function degradeActualPlan(req, res) {
    const { id } = req.params;
    const {
      planName,
      bandwidth,
      uploadBandwidth,
      degradeArc, // The ARC amount to subtract
      degradeDate,
      notes
    } = req.body;

    const userId = req.user.id;
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can degrade plans.' });
    }

    // Validate required fields
    if (!planName || !bandwidth || !degradeArc || !degradeDate) {
      return res.status(400).json({ message: 'Plan name, bandwidth, degrade ARC, and degrade date are required.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: { select: { company: true, name: true, phone: true, email: true, address: true } },
        invoices: {
          where: {
            // Find the last non-OTC invoice for this lead
            planName: { not: 'One Time Charge (OTC)' }
          },
          orderBy: { billingPeriodEnd: 'desc' },
          take: 1
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.actualPlanCreatedAt) {
      return res.status(400).json({ message: 'No actual plan exists for this lead. Create a plan first.' });
    }

    if (!lead.actualPlanIsActive) {
      return res.status(400).json({ message: 'Cannot degrade an inactive plan. Activate the plan first.' });
    }

    const lastInvoice = lead.invoices[0];
    if (!lastInvoice) {
      return res.status(400).json({ message: 'No invoice found for this plan. Cannot create credit note.' });
    }

    // Normalize dates to UTC midnight
    const normalizeDate = (date) => {
      const d = new Date(date);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    };

    const degradeDateObj = normalizeDate(degradeDate);
    const planStartDate = normalizeDate(lead.actualPlanStartDate);
    const planEndDate = normalizeDate(lead.actualPlanEndDate);

    if (degradeDateObj < planStartDate) {
      return res.status(400).json({ message: 'Degrade date cannot be before the plan start date.' });
    }

    if (degradeDateObj > planEndDate) {
      return res.status(400).json({ message: 'Degrade date cannot be after the current billing period end.' });
    }

    // Calculate days for credit period (degrade date to billing period end)
    const daysBetween = (start, end) => {
      const diffTime = normalizeDate(end).getTime() - normalizeDate(start).getTime();
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    };

    // Credit period: from degrade date to billing period end
    const creditPeriodDays = daysBetween(degradeDateObj, planEndDate) + 1; // Include both start and end dates

    // Calculate pro-rated credit amount for degrade period (Degrade ARC / 360 * days)
    // IMPORTANT: Use arcAmount (annual) not actualPlanPrice (billing cycle price)
    const oldArc = lead.arcAmount || 0;
    const degradeArcAmount = parseFloat(degradeArc);

    // Validate degrade ARC is not greater than or equal to old ARC
    // (You can't reduce ARC to 0 or negative)
    if (degradeArcAmount >= oldArc) {
      const maxDegrade = oldArc - 1;
      return res.status(400).json({
        message: `Degrade ARC (₹${degradeArcAmount}) must be less than current ARC (₹${oldArc}). Maximum degrade amount: ₹${maxDegrade}. The new ARC cannot be zero or negative.`
      });
    }

    const newTotalArc = oldArc - degradeArcAmount; // New total ARC after degrade

    const creditBaseAmount = Math.round((degradeArcAmount / 360) * creditPeriodDays);

    // GST calculation for credit note
    const sgstRate = 9;
    const cgstRate = 9;
    const creditSgst = Math.round((creditBaseAmount * sgstRate) / 100);
    const creditCgst = Math.round((creditBaseAmount * cgstRate) / 100);
    const creditTotal = creditBaseAmount + creditSgst + creditCgst;

    // Use a transaction for data consistency
    const result = await prisma.$transaction(async (tx) => {
      // 1. Generate credit note number
      const creditNoteNumber = await generateCreditNoteNumber();

      // 2. Create Credit Note linked to the last invoice
      const creditNote = await tx.creditNote.create({
        data: {
          creditNoteNumber,
          invoiceId: lastInvoice.id,
          baseAmount: creditBaseAmount,
          sgstRate,
          cgstRate,
          sgstAmount: creditSgst,
          cgstAmount: creditCgst,
          totalGstAmount: creditSgst + creditCgst,
          totalAmount: creditTotal,
          reason: 'PLAN_DOWNGRADE',
          status: 'ISSUED',
          remarks: `Plan downgrade - ${lead.actualPlanName} to ${planName} | ${creditPeriodDays} days (${degradeDateObj.toISOString().split('T')[0]} to ${planEndDate.toISOString().split('T')[0]}) | Degrade ARC: ₹${degradeArcAmount} | New Total ARC: ₹${newTotalArc}`,
          createdById: userId
        }
      });

      // 2.5 Update invoice with credit note amount
      const currentTotalCredit = lastInvoice.totalCreditAmount || 0;
      const newTotalCredit = currentTotalCredit + creditTotal;
      const netPayable = lastInvoice.grandTotal - newTotalCredit;
      const totalPaid = lastInvoice.totalPaidAmount || 0;
      const newRemainingAmount = Math.max(0, netPayable - totalPaid);

      await tx.invoice.update({
        where: { id: lastInvoice.id },
        data: {
          totalCreditAmount: newTotalCredit,
          remainingAmount: newRemainingAmount,
          // Update status if fully credited
          status: newRemainingAmount <= 0 && lastInvoice.status !== 'PAID' ? 'PAID' : lastInvoice.status
        }
      });

      // 3. Create degrade history record
      const totalDays = daysBetween(planStartDate, planEndDate) + 1;
      const daysOnOldPlan = daysBetween(planStartDate, degradeDateObj);

      const degradeHistory = await tx.planUpgradeHistory.create({
        data: {
          leadId: id,
          actionType: 'DOWNGRADE',
          previousPlanName: lead.actualPlanName,
          previousBandwidth: lead.actualPlanBandwidth,
          previousUploadBandwidth: lead.actualPlanUploadBandwidth,
          previousArc: oldArc,
          previousValidityDays: lead.actualPlanValidityDays,
          previousBillingType: lead.actualPlanBillingType,
          previousPlanStartDate: lead.actualPlanStartDate,
          previousPlanEndDate: lead.actualPlanEndDate,
          newPlanName: planName,
          newBandwidth: parseInt(bandwidth),
          newUploadBandwidth: uploadBandwidth ? parseInt(uploadBandwidth) : null,
          newArc: newTotalArc, // Store the NEW TOTAL ARC (old - degrade)
          degradeArc: degradeArcAmount, // Store the degrade ARC that was subtracted
          upgradeDate: degradeDateObj,
          daysOnOldPlan: daysOnOldPlan,
          daysOnNewPlan: creditPeriodDays,
          oldPlanAmount: 0, // Original invoice already exists
          newPlanAmount: creditTotal, // Credit amount (negative impact)
          totalAmount: creditTotal,
          originalAmount: 0,
          differenceAmount: -creditTotal, // Negative because it's a credit
          creditNoteId: creditNote.id,
          notes: notes || null,
          createdById: userId
        }
      });

      // 4. Update the lead with new plan details
      const bandwidthKbps = parseInt(bandwidth);
      let bandwidthDisplay;
      if (bandwidthKbps >= 1000000) {
        bandwidthDisplay = `${(bandwidthKbps / 1000000).toFixed(1)} Gbps`;
      } else if (bandwidthKbps >= 1000) {
        bandwidthDisplay = `${Math.round(bandwidthKbps / 1000)} Mbps`;
      } else {
        bandwidthDisplay = `${bandwidthKbps} Kbps`;
      }

      const updatedLead = await tx.lead.update({
        where: { id },
        data: {
          actualPlanName: planName,
          actualPlanBandwidth: bandwidthKbps,
          actualPlanUploadBandwidth: uploadBandwidth ? parseInt(uploadBandwidth) : null,
          actualPlanPrice: newTotalArc, // NEW TOTAL ARC (old - degrade)
          arcAmount: newTotalArc, // NEW TOTAL ARC (old - degrade)
          bandwidthRequirement: bandwidthDisplay,
          actualPlanNotes: lead.actualPlanNotes
            ? `${lead.actualPlanNotes}\n\n[DOWNGRADE ${new Date().toISOString().split('T')[0]}] Degrade ARC: ₹${degradeArcAmount}, New Total ARC: ₹${newTotalArc}. ${notes || ''}`
            : `[DOWNGRADE ${new Date().toISOString().split('T')[0]}] Degrade ARC: ₹${degradeArcAmount}, New Total ARC: ₹${newTotalArc}. ${notes || ''}`
        },
        include: {
          campaignData: { select: { company: true, name: true } },
          actualPlanCreatedBy: { select: { id: true, name: true } }
        }
      });

      return { degradeHistory, updatedLead, creditNote, lastInvoice };
    });

    // Create ledger entry for credit note
    // Arguments: creditNote, invoice, customerId (leadId), userId
    try {
      await createCreditNoteLedgerEntry(result.creditNote, result.lastInvoice, id, userId);
    } catch (ledgerError) {
      console.error('Failed to create credit note ledger entry:', ledgerError);
      // Don't fail the operation if ledger entry fails
    }

    // Return success response with credit note details
    res.json({
      lead: result.updatedLead,
      degradeHistory: result.degradeHistory,
      creditNote: {
        creditNoteNumber: result.creditNote.creditNoteNumber,
        invoiceNumber: result.lastInvoice.invoiceNumber,
        period: `${degradeDateObj.toISOString().split('T')[0]} to ${planEndDate.toISOString().split('T')[0]}`,
        days: creditPeriodDays,
        degradeArc: degradeArcAmount,
        newTotalArc: newTotalArc,
        baseAmount: creditBaseAmount,
        gst: creditSgst + creditCgst,
        total: creditTotal
      },
      message: `Plan downgraded successfully. Degrade ARC: ₹${degradeArcAmount}, New Total ARC: ₹${newTotalArc}. Credit note: ₹${creditTotal} for ${creditPeriodDays} days.`
    });
});

// Get plan upgrade history for a lead
export const getPlanUpgradeHistory = asyncHandler(async function getPlanUpgradeHistory(req, res) {
    const { id } = req.params;
    const userRole = req.user.role;
    const isAccountsTeam = hasRole(req.user, 'ACCOUNTS_TEAM');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isAccountsTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Accounts Team can view upgrade history.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, campaignData: { select: { company: true } } }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const upgradeHistory = await prisma.planUpgradeHistory.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true } }
      }
    });

    res.json({
      leadId: id,
      company: lead.campaignData?.company,
      upgrades: upgradeHistory,
      totalUpgrades: upgradeHistory.length
    });
});

// ========== END ACTUAL PLAN MANAGEMENT ==========

// ========== TESTING / DEVELOPMENT UTILITIES ==========

/**
 * Fast-track bypass for testing - automatically approves all pipeline stages
 * SUPER_ADMIN only - skips OPS, Docs, Accounts verification, assigns demo plan
 */
export const bypassPipelineApproval = asyncHandler(async function bypassPipelineApproval(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN' || req.user.role === 'MASTER';

    if (!isSuperAdmin) {
      return res.status(403).json({ message: 'Only SUPER_ADMIN or MASTER can bypass pipeline approvals.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        campaignData: true
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const now = new Date();

    // Update lead with all approvals bypassed
    const updatedLead = await prisma.lead.update({
      where: { id },
      data: {
        // OPS Approval
        opsApprovalStatus: 'APPROVED',
        opsApprovedAt: now,
        opsApprovedById: userId,

        // Docs Verification
        docsVerifiedAt: now,
        docsVerifiedById: userId,

        // Accounts Verification
        accountsVerifiedAt: now,
        accountsVerifiedById: userId,

        // Demo Plan Assignment
        accountsDemoPlanAssigned: true,
        accountsDemoPlanAssignedAt: now,
        accountsDemoPlanAssignedById: userId,

        // Delivery Status (mark as pending delivery)
        deliveryStatus: 'PENDING',

        // NOC Status (mark as pending NOC)
        nocStatus: 'PENDING'
      }
    });

    res.json({
      message: 'Lead fast-tracked successfully! All approval stages bypassed.',
      lead: {
        id: updatedLead.id,
        company: lead.campaignData?.company,
        opsApprovalStatus: updatedLead.opsApprovalStatus,
        docsVerifiedAt: updatedLead.docsVerifiedAt,
        accountsVerifiedAt: updatedLead.accountsVerifiedAt,
        accountsDemoPlanAssigned: updatedLead.accountsDemoPlanAssigned,
        deliveryStatus: updatedLead.deliveryStatus,
        nocStatus: updatedLead.nocStatus
      }
    });
});

// ========== VENDOR PO FUNCTIONS (ACCOUNTS TEAM) ==========

// Get leads eligible for vendor PO creation
export const getPOEligibleLeads = asyncHandler(async function getPOEligibleLeads(req, res) {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 20);
    const search = req.query.search || '';

    const where = {
      accountsVerifiedAt: { not: null },
      vendorDocsVerifiedAt: { not: null }
    };

    if (search) {
      where.OR = buildSearchFilter(search, [
        'campaignData.name',
        'campaignData.company',
        'customerGstNo',
      ]);
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: {
          id: true,
          campaignData: {
            select: { name: true, company: true, phone: true }
          },
          vendor: {
            select: {
              id: true,
              companyName: true,
              category: true,
              gstNumber: true,
              contactPerson: true
            }
          },
          vendorsCreatedFor: {
            select: {
              id: true,
              companyName: true,
              category: true,
              gstNumber: true,
              contactPerson: true,
              approvalStatus: true
            }
          },
          fromAddress: true,
          installationAddress: true,
          location: true,
          feasibilityNotes: true,
          arcAmount: true,
          bandwidthRequirement: true,
          vendorCommissionPercentage: true,
          products: {
            select: {
              product: { select: { id: true, title: true, code: true } }
            }
          },
          vendorPurchaseOrders: {
            select: { id: true, poNumber: true, status: true, vendorCategory: true, emailSentAt: true }
          }
        },
        orderBy: { accountsVerifiedAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.lead.count({ where })
    ]);

    res.json(paginatedResponse({ data: leads, total, page, limit, dataKey: 'leads' }));
});

// Create vendor purchase order
export const createVendorPO = asyncHandler(async function createVendorPO(req, res) {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const {
      leadId, vendorId, vendorCategory, validityMonths,
      customerName, popLocation, installationLocation,
      distance, rate, baseAmount, gstApplicable, gstPercentage,
      gstAmount, totalAmount, termsAndConditions,
      commissionPercentage, arcAmount, bandwidthSpeed,
      paymentTerms, lockInPeriod, noticePeriod
    } = req.body;

    if (!leadId || !vendorId || !vendorCategory || !validityMonths) {
      return res.status(400).json({ message: 'Lead, vendor, category and validity are required.' });
    }

    if (!baseAmount || !totalAmount) {
      return res.status(400).json({ message: 'Amount details are required.' });
    }

    // Verify lead eligibility
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        accountsVerifiedAt: true,
        vendorDocsVerifiedAt: true
      }
    });

    if (!lead || !lead.accountsVerifiedAt || !lead.vendorDocsVerifiedAt) {
      return res.status(400).json({ message: 'Lead is not eligible for PO creation.' });
    }

    // Generate PO number
    const poNumber = await generateVendorPONumber();

    const po = await prisma.vendorPurchaseOrder.create({
      data: {
        poNumber,
        validityMonths: parseInt(validityMonths),
        vendorCategory,
        vendorId,
        leadId,
        customerName: customerName || '',
        popLocation: popLocation || null,
        installationLocation: installationLocation || null,
        distance: distance ? parseFloat(distance) : null,
        rate: rate ? parseFloat(rate) : null,
        commissionPercentage: commissionPercentage ? parseFloat(commissionPercentage) : null,
        arcAmount: arcAmount ? parseFloat(arcAmount) : null,
        bandwidthSpeed: bandwidthSpeed || null,
        paymentTerms: paymentTerms || null,
        lockInPeriod: lockInPeriod ? parseInt(lockInPeriod) : null,
        noticePeriod: noticePeriod ? parseInt(noticePeriod) : null,
        baseAmount: parseFloat(baseAmount),
        gstApplicable: gstApplicable || false,
        gstPercentage: gstPercentage ? parseFloat(gstPercentage) : null,
        gstAmount: gstAmount ? parseFloat(gstAmount) : null,
        totalAmount: parseFloat(totalAmount),
        termsAndConditions: termsAndConditions || null,
        createdById: req.user.id
      },
      include: {
        vendor: { select: { companyName: true, category: true } },
        lead: {
          select: {
            campaignData: { select: { name: true, company: true } }
          }
        },
        createdBy: { select: { name: true } }
      }
    });

    // Notify all SUPER_ADMINs
    await notifyAllAdmins(
      'VENDOR_PO_CREATED',
      'New Vendor PO Created',
      `PO ${poNumber} created for ${customerName} by ${req.user.name}`,
      { poId: po.id, poNumber, leadId }
    );

    // Refresh sidebar for admins
    const admins = await prisma.user.findMany({
      where: { role: 'SUPER_ADMIN', isActive: true },
      select: { id: true }
    });
    admins.forEach(admin => emitSidebarRefresh(admin.id));

    res.status(201).json({ message: 'Vendor PO created successfully.', po });
});

// List vendor POs
export const getVendorPOs = asyncHandler(async function getVendorPOs(req, res) {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 20);
    const status = req.query.status || '';
    const isAdmin = isAdminOrTestUser(req.user);

    const where = {};
    if (status) where.status = status;

    // Non-admin sees only their own POs
    if (!isAdmin) {
      where.createdById = req.user.id;
    }

    const [pos, total] = await Promise.all([
      prisma.vendorPurchaseOrder.findMany({
        where,
        include: {
          vendor: { select: { companyName: true, category: true, gstNumber: true } },
          lead: {
            select: {
              campaignData: { select: { name: true, company: true } },
              fromAddress: true,
              installationAddress: true
            }
          },
          createdBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
          rejectedBy: { select: { name: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.vendorPurchaseOrder.count({ where })
    ]);

    res.json(paginatedResponse({ data: pos, total, page, limit, dataKey: 'pos' }));
});

// Get single vendor PO
export const getVendorPO = asyncHandler(async function getVendorPO(req, res) {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const po = await prisma.vendorPurchaseOrder.findUnique({
      where: { id: req.params.id },
      include: {
        vendor: true,
        lead: {
          select: {
            campaignData: { select: { name: true, company: true, phone: true } },
            fromAddress: true,
            installationAddress: true,
            location: true,
            products: { select: { product: { select: { title: true } } } }
          }
        },
        createdBy: { select: { name: true, email: true } },
        approvedBy: { select: { name: true } },
        rejectedBy: { select: { name: true } }
      }
    });

    if (!po) return res.status(404).json({ message: 'PO not found.' });

    res.json({ po });
});

// Admin: Get vendor PO approval queue
export const getVendorPOApprovalQueue = asyncHandler(async function getVendorPOApprovalQueue(req, res) {
    if (!isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 20);
    const statusFilter = req.query.status;

    const where = {};
    if (statusFilter && ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(statusFilter)) {
      where.status = statusFilter;
    }

    const [pos, total, stats] = await Promise.all([
      prisma.vendorPurchaseOrder.findMany({
        where,
        include: {
          vendor: { select: { companyName: true, category: true, gstNumber: true, contactPerson: true } },
          lead: {
            select: {
              campaignData: { select: { name: true, company: true, phone: true } },
              fromAddress: true,
              installationAddress: true,
              location: true
            }
          },
          createdBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
          rejectedBy: { select: { name: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.vendorPurchaseOrder.count({ where }),
      prisma.vendorPurchaseOrder.groupBy({
        by: ['status'],
        _count: { id: true }
      })
    ]);

    const statsMap = { pending: 0, approved: 0, rejected: 0 };
    stats.forEach(s => {
      if (s.status === 'PENDING_APPROVAL') statsMap.pending = s._count.id;
      else if (s.status === 'APPROVED') statsMap.approved = s._count.id;
      else if (s.status === 'REJECTED') statsMap.rejected = s._count.id;
    });

    res.json(paginatedResponse({ data: pos, total, page, limit, dataKey: 'pos', extra: { stats: statsMap } }));
});

// Admin: Approve vendor PO
export const approveVendorPO = asyncHandler(async function approveVendorPO(req, res) {
    if (!isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const po = await prisma.vendorPurchaseOrder.findUnique({
      where: { id: req.params.id },
      select: { status: true, createdById: true, poNumber: true, customerName: true }
    });

    if (!po) return res.status(404).json({ message: 'PO not found.' });
    if (po.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({ message: 'PO is not pending approval.' });
    }

    const updatedPO = await prisma.vendorPurchaseOrder.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        approvedById: req.user.id,
        approvedAt: new Date()
      }
    });

    // Notify the accounts user who created the PO
    await createNotification(
      po.createdById,
      'VENDOR_PO_APPROVED',
      'Vendor PO Approved',
      `PO ${po.poNumber} for ${po.customerName} has been approved.`,
      { poId: req.params.id, poNumber: po.poNumber }
    );
    emitSidebarRefresh(po.createdById);

    res.json({ message: 'PO approved successfully.', po: updatedPO });
});

// Admin: Reject vendor PO
export const rejectVendorPO = asyncHandler(async function rejectVendorPO(req, res) {
    if (!isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'Rejection reason is required.' });

    const po = await prisma.vendorPurchaseOrder.findUnique({
      where: { id: req.params.id },
      select: { status: true, createdById: true, poNumber: true, customerName: true }
    });

    if (!po) return res.status(404).json({ message: 'PO not found.' });
    if (po.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({ message: 'PO is not pending approval.' });
    }

    const updatedPO = await prisma.vendorPurchaseOrder.update({
      where: { id: req.params.id },
      data: {
        status: 'REJECTED',
        rejectedById: req.user.id,
        rejectedAt: new Date(),
        rejectionReason: reason
      }
    });

    // Notify the accounts user who created the PO
    await createNotification(
      po.createdById,
      'VENDOR_PO_REJECTED',
      'Vendor PO Rejected',
      `PO ${po.poNumber} for ${po.customerName} was rejected: ${reason}`,
      { poId: req.params.id, poNumber: po.poNumber, reason }
    );
    emitSidebarRefresh(po.createdById);

    res.json({ message: 'PO rejected.', po: updatedPO });
});

// Send Vendor PO email to vendor
export const sendVendorPOEmail = asyncHandler(async function sendVendorPOEmail(req, res) {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { to, cc, subject, message } = req.body;
    if (!to || !subject) {
      return res.status(400).json({ message: 'Recipient email and subject are required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return res.status(400).json({ message: 'Invalid recipient email format.' });
    }

    const po = await prisma.vendorPurchaseOrder.findUnique({
      where: { id: req.params.id },
      include: {
        vendor: true,
        lead: {
          select: {
            campaignData: { select: { name: true, company: true, phone: true } },
            fromAddress: true,
            installationAddress: true,
            products: { select: { product: { select: { title: true } } } }
          }
        },
        createdBy: { select: { name: true, email: true } },
        approvedBy: { select: { name: true } }
      }
    });

    if (!po) return res.status(404).json({ message: 'PO not found.' });
    if (po.status !== 'APPROVED') {
      return res.status(400).json({ message: 'Only approved POs can be sent.' });
    }

    const formatCurrency = (amount) => {
      if (!amount && amount !== 0) return '-';
      return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount);
    };

    const isCommission = po.vendorCategory === 'COMMISSION' || po.vendorCategory === 'CHANNEL_PARTNER';
    const isThirdParty = po.vendorCategory === 'THIRD_PARTY';

    // Build category-specific rows
    let categoryRows = '';
    if (isCommission) {
      categoryRows = `
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">ARC Amount</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.arcAmount ? formatCurrency(po.arcAmount) : '-'}</td>
        </tr>
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Commission %</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.commissionPercentage || '-'}%</td>
        </tr>
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Bandwidth</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.bandwidthSpeed || '-'}</td>
        </tr>`;
    } else if (isThirdParty) {
      categoryRows = `
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Rate</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.rate ? formatCurrency(po.rate) : '-'}</td>
        </tr>
        ${po.arcAmount ? `<tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">ARC Amount</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${formatCurrency(po.arcAmount)}</td>
        </tr>` : ''}
        ${po.bandwidthSpeed ? `<tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Bandwidth</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.bandwidthSpeed}</td>
        </tr>` : ''}
        ${po.paymentTerms ? `<tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Payment Terms</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.paymentTerms}</td>
        </tr>` : ''}
        ${po.lockInPeriod ? `<tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Lock-in Period</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.lockInPeriod} Months</td>
        </tr>` : ''}
        ${po.noticePeriod ? `<tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Notice Period</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.noticePeriod} Months</td>
        </tr>` : ''}`;
    } else {
      categoryRows = `
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Distance</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.distance || '-'} meters</td>
        </tr>
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Rate per meter</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.rate ? formatCurrency(po.rate) : '-'}</td>
        </tr>`;
    }

    // Build PO details HTML table
    const poDetailsHtml = `
      <table width="100%" style="border-collapse:collapse;margin:16px 0;">
        <tr style="background:#f8fafc;">
          <td style="border:1px solid #e2e8f0;padding:10px;font-weight:600;color:#334155;width:40%;">PO Number</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;font-weight:500;font-family:monospace;">${po.poNumber}</td>
        </tr>
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">PO Date</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${new Date(po.poDate || po.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
        </tr>
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Customer</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;font-weight:500;">${po.customerName || '-'}</td>
        </tr>
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Category</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.vendorCategory}</td>
        </tr>
        ${categoryRows}
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Base Amount</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${formatCurrency(po.baseAmount)}</td>
        </tr>
        ${po.gstApplicable ? `
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">GST (${po.gstPercentage}%)</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${formatCurrency(po.gstAmount)}</td>
        </tr>
        ` : ''}
        <tr style="background:#f0fdf4;">
          <td style="border:1px solid #e2e8f0;padding:10px;color:#166534;font-weight:600;">Total Amount</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;font-weight:700;font-size:16px;">${formatCurrency(po.totalAmount)}</td>
        </tr>
        <tr>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#475569;">Validity</td>
          <td style="border:1px solid #e2e8f0;padding:10px;color:#1e293b;">${po.validityMonths} Months</td>
        </tr>
      </table>
    `;

    // Escape message for HTML (preserve newlines)
    const escapedMessage = (message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');

    const htmlContent = `
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 0;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
            <tr>
              <td style="background:#7c3aed;padding:24px;border-radius:8px 8px 0 0;">
                <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;">Purchase Order</h1>
                <p style="margin:4px 0 0;color:#e9d5ff;font-size:14px;font-family:monospace;">${po.poNumber}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 20px;">${escapedMessage}</p>
                <h3 style="margin:0 0 4px;color:#334155;font-size:15px;font-weight:600;">Purchase Order Details</h3>
                ${poDetailsHtml}
                ${po.termsAndConditions ? `
                <div style="margin-top:20px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">
                  <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;">Terms & Conditions</p>
                  <p style="margin:0;font-size:13px;color:#475569;line-height:1.6;white-space:pre-wrap;">${po.termsAndConditions.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                </div>
                ` : ''}
                <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:14px;color:#1e293b;">
                    Best Regards,<br/>
                    <strong style="color:#7c3aed;">Gazon Communications India Ltd.</strong>
                  </p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background:#f8fafc;padding:16px 24px;border-radius:0 0 8px 8px;border-top:1px solid #e2e8f0;">
                <p style="margin:0;font-size:12px;color:#64748b;text-align:center;">
                  This is an automated email from Gazon Communications CRM.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

    // Send via Resend
    const { Resend } = await import('resend');
    const resendClient = new Resend(process.env.RESEND_API_KEY);

    const emailOptions = {
      from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to: [to],
      subject,
      html: htmlContent
    };
    if (cc && cc.length > 0) {
      const validCc = cc.filter(e => emailRegex.test(e));
      if (validCc.length > 0) emailOptions.cc = validCc;
    }

    const { data, error } = await resendClient.emails.send(emailOptions);
    if (error) {
      console.error('Resend API error:', error);
      return res.status(500).json({ message: error.message || 'Failed to send email.' });
    }

    // Log the email + mark PO as sent
    const now = new Date();
    await Promise.all([
      prisma.emailLog.create({
        data: {
          referenceId: po.id,
          referenceType: 'vendor_po',
          to,
          cc: cc || [],
          subject,
          htmlSnapshot: htmlContent,
          status: 'SENT',
          resendId: data?.id,
          sentByUserId: req.user.id,
          sentAt: now
        }
      }),
      prisma.vendorPurchaseOrder.update({
        where: { id: req.params.id },
        data: { emailSentAt: now, emailSentTo: to }
      })
    ]);

    res.json({ message: 'PO email sent successfully.', resendId: data?.id });
});

// ========== END VENDOR PO FUNCTIONS ==========

// ========== CUSTOMER ENQUIRY FUNCTIONS ==========

// Get customer enquiry queue for Team Leader
export const getCustomerEnquiryQueue = asyncHandler(async function getCustomerEnquiryQueue(req, res) {
    if (!hasAnyRole(req.user, ['BDM_TEAM_LEADER', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const enquiries = await prisma.customerEnquiry.findMany({
      where: {
        status: 'SUBMITTED',
        OR: [
          { createdLeadId: null },
          { createdLead: { assignedToId: null } }
        ]
      },
      select: {
        id: true,
        enquiryNumber: true,
        companyName: true,
        contactName: true,
        phone: true,
        email: true,
        city: true,
        state: true,
        requirements: true,
        status: true,
        createdAt: true,
        createdLeadId: true,
        referredByLead: {
          select: {
            id: true,
            campaignData: {
              select: { company: true }
            }
          }
        },
        createdLead: {
          select: {
            id: true,
            status: true,
            campaignData: {
              select: {
                company: true,
                name: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
                city: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ enquiries, total: enquiries.length });
});

// Get customer enquiry queue for SAM Head (referral enquiries pending assignment)
export const getSAMHeadEnquiryQueue = asyncHandler(async function getSAMHeadEnquiryQueue(req, res) {
    if (!hasAnyRole(req.user, ['SAM_HEAD', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const enquiries = await prisma.customerEnquiry.findMany({
      where: { status: 'SUBMITTED' },
      select: {
        id: true,
        enquiryNumber: true,
        companyName: true,
        contactName: true,
        phone: true,
        email: true,
        city: true,
        state: true,
        requirements: true,
        status: true,
        createdAt: true,
        createdLeadId: true,
        referredByLead: {
          select: {
            id: true,
            campaignData: {
              select: { company: true }
            }
          }
        },
        createdLead: {
          select: {
            id: true,
            status: true,
            campaignDataId: true,
            campaignData: {
              select: {
                id: true,
                company: true,
                name: true,
                phone: true,
                email: true,
                city: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ enquiries, total: enquiries.length });
});

// Assign a customer referral enquiry to an ISR
export const assignEnquiryToISR = asyncHandler(async function assignEnquiryToISR(req, res) {
    if (!hasAnyRole(req.user, ['SAM_HEAD', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { enquiryId, isrId } = req.body;

    if (!enquiryId || !isrId) {
      return res.status(400).json({ message: 'Enquiry ID and ISR ID are required.' });
    }

    // Verify ISR exists and has ISR role
    const isrUser = await prisma.user.findUnique({
      where: { id: isrId },
      select: { id: true, name: true, role: true }
    });
    if (!isrUser || isrUser.role !== 'ISR') {
      return res.status(400).json({ message: 'Invalid ISR user.' });
    }

    // Find the enquiry with its created lead
    const enquiry = await prisma.customerEnquiry.findUnique({
      where: { id: enquiryId },
      include: {
        createdLead: {
          select: { id: true, campaignDataId: true }
        }
      }
    });

    if (!enquiry) {
      return res.status(404).json({ message: 'Enquiry not found.' });
    }

    if (enquiry.status !== 'SUBMITTED') {
      return res.status(400).json({ message: 'Enquiry is no longer pending.' });
    }

    // Find or create CUSTOMER-REFERRAL campaign
    let referralCampaign = await prisma.campaign.findFirst({
      where: { code: 'CUSTOMER-REFERRAL' }
    });

    if (!referralCampaign) {
      referralCampaign = await prisma.campaign.create({
        data: {
          code: 'CUSTOMER-REFERRAL',
          name: 'Customer Referral Leads',
          description: 'Leads from customer referral enquiries',
          type: 'ALL',
          status: 'ACTIVE',
          dataSource: 'Customer Referral',
          isActive: true,
          createdById: req.user.id
        }
      });
    }

    // Get the CampaignData ID from the created lead (if exists)
    const campaignDataId = enquiry.createdLead?.campaignDataId;

    if (campaignDataId) {
      // Delete the pre-created Lead (ISR will re-create via convert flow)
      if (enquiry.createdLeadId) {
        await prisma.lead.delete({ where: { id: enquiry.createdLeadId } });
      }

      // Update CampaignData: reassign to ISR, reset status
      await prisma.campaignData.update({
        where: { id: campaignDataId },
        data: {
          assignedToId: isrId,
          campaignId: referralCampaign.id,
          status: 'NEW'
        }
      });
    } else {
      // No existing CampaignData — create one from enquiry data
      // Delete the pre-created Lead if it exists
      if (enquiry.createdLeadId) {
        await prisma.lead.delete({ where: { id: enquiry.createdLeadId } });
      }

      const nameParts = enquiry.contactName.trim().split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      await prisma.campaignData.create({
        data: {
          campaignId: referralCampaign.id,
          company: enquiry.companyName,
          firstName,
          lastName,
          name: enquiry.contactName,
          title: 'Contact',
          email: enquiry.email || null,
          phone: enquiry.phone,
          city: enquiry.city || null,
          state: enquiry.state || null,
          source: 'Customer Referral',
          notes: enquiry.requirements || null,
          isSelfGenerated: true,
          createdById: req.user.id,
          assignedToId: isrId,
          status: 'NEW'
        }
      });
    }

    // Update enquiry status
    await prisma.customerEnquiry.update({
      where: { id: enquiryId },
      data: {
        status: 'UNDER_REVIEW',
        createdLeadId: null
      }
    });

    // Upsert CampaignAssignment for ISR → CUSTOMER-REFERRAL campaign
    await prisma.campaignAssignment.upsert({
      where: {
        userId_campaignId: {
          userId: isrId,
          campaignId: referralCampaign.id
        }
      },
      update: {},
      create: {
        userId: isrId,
        campaignId: referralCampaign.id
      }
    });

    // Notify ISR
    await createNotification(
      isrId,
      'DATA_ASSIGNED',
      'Customer Referral Assigned',
      `${req.user.name} assigned a customer referral to you: ${enquiry.companyName} (${enquiry.contactName})`,
      { enquiryId }
    );
    emitSidebarRefresh(isrId);
    emitSidebarRefreshByRole('ISR');
    emitSidebarRefreshByRole('SAM_HEAD');

    res.json({
      success: true,
      message: `Enquiry assigned to ISR ${isrUser.name}.`
    });
});

// ========== END CUSTOMER ENQUIRY FUNCTIONS ==========

// ========== CHANNEL PARTNER LEADS ==========

/**
 * Get all Channel Partner leads with stage, costs, and commission info
 * GET /leads/cp-leads
 */
export const getCPLeads = asyncHandler(async function getCPLeads(req, res) {
    const isTL = hasRole(req.user, 'BDM_TEAM_LEADER');
    const isAdmin = isAdminOrTestUser(req.user);

    if (!isTL && !isAdmin) {
      return res.status(403).json({ message: 'Only Admin or Team Leader can access CP leads.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 50);
    const { cpVendorId, search } = req.query;

    // Find all leads that have a channelPartnerVendorId on their campaign data
    const where = {
      campaignData: { channelPartnerVendorId: { not: null } }
    };

    if (cpVendorId) {
      where.campaignData.channelPartnerVendorId = cpVendorId;
    }

    if (search) {
      where.OR = [
        { campaignData: { company: { contains: search, mode: 'insensitive' } } },
        { campaignData: { name: { contains: search, mode: 'insensitive' } } },
        { campaignData: { phone: { contains: search } } },
        { customerUsername: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          arcAmount: true,
          otcAmount: true,
          vendorCommissionPercentage: true,
          deliveryStatus: true,
          opsApprovalStatus: true,
          feasibilityNotes: true,
          feasibilityVendorType: true,
          tentativeCapex: true,
          tentativeOpex: true,
          pushedToInstallationAt: true,
          actualPlanIsActive: true,
          createdAt: true,
          updatedAt: true,
          campaignData: {
            select: {
              company: true,
              name: true,
              phone: true,
              channelPartnerVendor: { select: { id: true, companyName: true, commissionPercentage: true } }
            }
          },
          assignedTo: { select: { id: true, name: true } },
          vendor: { select: { id: true, companyName: true, category: true } },
        }
      }),
      prisma.lead.count({ where })
    ]);

    // Format and calculate
    const formattedLeads = leads.map(lead => {
      const cpVendor = lead.campaignData?.channelPartnerVendor;
      const cpPercent = cpVendor?.commissionPercentage || lead.vendorCommissionPercentage || 0;
      const arcAmount = lead.arcAmount || 0;
      const cpCommission = (cpPercent / 100) * arcAmount;

      // Parse feasibility for OPEX/CAPEX — new direct columns first, then legacy JSON
      let capex = 0, opex = 0, vendorType = '';
      if (lead.feasibilityVendorType || lead.tentativeCapex != null || lead.tentativeOpex != null) {
        vendorType = lead.feasibilityVendorType || '';
        capex = parseFloat(lead.tentativeCapex) || 0;
        opex = parseFloat(lead.tentativeOpex) || 0;
      } else {
        try {
          if (lead.feasibilityNotes) {
            const feas = JSON.parse(lead.feasibilityNotes);
            vendorType = feas.vendorType || '';
            capex = parseFloat(feas.vendorDetails?.capex) || 0;
            opex = parseFloat(feas.vendorDetails?.opex) || 0;
          }
        } catch (e) {}
      }

      // Determine current stage
      let stage = 'New';
      if (lead.actualPlanIsActive) stage = 'Active Plan';
      else if (lead.deliveryStatus === 'COMPLETED') stage = 'Delivery Completed';
      else if (lead.pushedToInstallationAt) stage = 'Installation';
      else if (lead.opsApprovalStatus === 'APPROVED') stage = 'OPS Approved';
      else if (lead.opsApprovalStatus === 'PENDING') stage = 'OPS Pending';
      else if (lead.status === 'FEASIBLE') stage = 'Feasible';
      else if (lead.status === 'QUALIFIED') stage = 'Qualified';
      else if (lead.status === 'MEETING_SCHEDULED') stage = 'Meeting';
      else if (lead.status === 'FOLLOW_UP') stage = 'Follow Up';
      else if (lead.status === 'DROPPED') stage = 'Dropped';
      else stage = lead.status;

      return {
        id: lead.id,
        company: lead.campaignData?.company,
        name: lead.campaignData?.name,
        phone: lead.campaignData?.phone,
        cpVendor: cpVendor?.companyName || 'Unknown CP',
        cpVendorId: cpVendor?.id,
        cpPercent,
        arcAmount,
        otcAmount: lead.otcAmount || 0,
        cpCommission,
        capex,
        opex,
        netMargin: arcAmount - opex - cpCommission,
        vendorType,
        stage,
        assignedTo: lead.assignedTo?.name || '-',
        feasibilityVendor: lead.vendor?.companyName || '-',
        createdAt: lead.createdAt,
      };
    });

    // Stats
    const allCPLeads = await prisma.lead.findMany({
      where: { campaignData: { channelPartnerVendorId: { not: null } } },
      select: { arcAmount: true, vendorCommissionPercentage: true, campaignData: { select: { channelPartnerVendor: { select: { commissionPercentage: true } } } } }
    });

    let totalARC = 0, totalCommission = 0;
    allCPLeads.forEach(l => {
      const arc = l.arcAmount || 0;
      const pct = l.campaignData?.channelPartnerVendor?.commissionPercentage || l.vendorCommissionPercentage || 0;
      totalARC += arc;
      totalCommission += (pct / 100) * arc;
    });

    res.json({
      leads: formattedLeads,
      stats: { total: allCPLeads.length, totalARC, totalCommission },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
});

// ==========================================================================
// COLD LEAD PIPELINE
// Leads the BDM parked with partial details after a lukewarm meeting. Lives
// in a dedicated "Lead Pipeline" sidebar tab. When the customer eventually
// provides full details, the BDM completes the lead and it auto-pushes to
// the Feasibility Team, disappearing from this list.
// ==========================================================================

export const getBDMColdLeads = asyncHandler(async function getBDMColdLeads(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const isAdmin = isAdminOrTestUser(req.user);
    const isTL = userRole === 'BDM_TEAM_LEADER';
    const isBDM = userRole === 'BDM';
    const isBDMCP = userRole === 'BDM_CP';

    if (!isAdmin && !isTL && !isBDM && !isBDMCP) {
      return res.status(403).json({ message: 'Only BDM, Team Leader, or Admin can view cold leads.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 25);
    const { search } = req.query;

    // Scoping: BDMs see their own; TLs see their own + team members'; admins see all.
    let scopeWhere = { isColdLead: true };
    if (isAdmin) {
      // all cold leads
    } else if (isTL) {
      const teamMemberIds = (await prisma.user.findMany({
        where: { teamLeaderId: userId, isActive: true },
        select: { id: true }
      })).map((u) => u.id);
      scopeWhere.assignedToId = { in: [userId, ...teamMemberIds] };
    } else {
      scopeWhere.assignedToId = userId;
    }

    if (search && search.trim()) {
      scopeWhere.OR = buildSearchFilter(search.trim(), [
        'leadNumber',
        'campaignData.company',
        'campaignData.name',
        'campaignData.email',
        { field: 'campaignData.phone' },
      ]);
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where: scopeWhere,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        include: {
          campaignData: {
            include: {
              campaign: { select: { id: true, code: true, name: true } }
            }
          },
          assignedTo: { select: { id: true, name: true, email: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          products: { include: { product: { select: { id: true, title: true } } } }
        }
      }),
      prisma.lead.count({ where: scopeWhere })
    ]);

    const formatted = leads.map((lead) => ({
      id: lead.id,
      leadNumber: lead.leadNumber,
      status: lead.status,
      isColdLead: lead.isColdLead,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      meetingDate: lead.meetingDate,
      meetingPlace: lead.meetingPlace,
      meetingOutcome: lead.meetingOutcome,
      // Contact
      company: lead.campaignData.company,
      name: lead.campaignData.name || `${lead.campaignData.firstName || ''} ${lead.campaignData.lastName || ''}`.trim(),
      phone: lead.campaignData.phone,
      email: lead.campaignData.email,
      city: lead.campaignData.city,
      // Whatever partial data was captured
      fullAddress: lead.fullAddress,
      latitude: lead.latitude,
      longitude: lead.longitude,
      fromAddress: lead.fromAddress,
      fromLatitude: lead.fromLatitude,
      fromLongitude: lead.fromLongitude,
      bandwidthRequirement: lead.bandwidthRequirement,
      numberOfIPs: lead.numberOfIPs,
      interestLevel: lead.interestLevel,
      tentativePrice: lead.tentativePrice,
      otcAmount: lead.otcAmount,
      billingAddress: lead.billingAddress,
      billingPincode: lead.billingPincode,
      expectedDeliveryDate: lead.expectedDeliveryDate,
      requirements: lead.requirements,
      products: lead.products.map((lp) => lp.product),
      assignedTo: lead.assignedTo,
      createdBy: lead.createdBy,
      campaign: lead.campaignData.campaign,
    }));

    res.json(paginatedResponse({
      data: formatted,
      total,
      page,
      limit,
      dataKey: 'leads',
    }));
});

// Complete a cold lead — fills in the missing required fields, clears the
// isColdLead flag, and assigns it to the Feasibility Team (same behavior as
// a fresh Ready-for-Feasibility disposition).
export const completeColdLead = asyncHandler(async function completeColdLead(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userName = req.user.name;
    const userRole = req.user.role;
    const isAdmin = isAdminOrTestUser(req.user);
    const isTL = userRole === 'BDM_TEAM_LEADER';
    const isBDM = userRole === 'BDM';
    const isBDMCP = userRole === 'BDM_CP';

    if (!isAdmin && !isTL && !isBDM && !isBDMCP) {
      return res.status(403).json({ message: 'Only BDM, Team Leader, or Admin can complete cold leads.' });
    }

    const {
      feasibilityAssignedToId,
      latitude,
      longitude,
      fullAddress,
      fromAddress,
      fromLatitude,
      fromLongitude,
      bandwidthRequirement,
      numberOfIPs,
      interestLevel,
      tentativePrice,
      otcAmount,
      billingAddress,
      billingPincode,
      expectedDeliveryDate,
      productIds,
      notes,
    } = req.body;

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: { campaignData: { include: { campaign: { select: { id: true, name: true } } } } }
    });

    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    if (!lead.isColdLead) return res.status(400).json({ message: 'This lead is not in cold state.' });

    // Scope check — non-admin can only complete their own (or team, for TL)
    if (!isAdmin) {
      if (isTL) {
        const teamMemberIds = (await prisma.user.findMany({
          where: { teamLeaderId: userId, isActive: true },
          select: { id: true }
        })).map((u) => u.id);
        if (lead.assignedToId !== userId && !teamMemberIds.includes(lead.assignedToId)) {
          return res.status(403).json({ message: 'You can only complete cold leads in your team.' });
        }
      } else if (lead.assignedToId !== userId) {
        return res.status(403).json({ message: 'You can only complete cold leads assigned to you.' });
      }
    }

    // Same required-field contract as the Ready-for-Feasibility path
    if (!feasibilityAssignedToId) {
      return res.status(400).json({ message: 'Feasibility Team assignment is required.' });
    }
    if (!latitude || !longitude) {
      return res.status(400).json({ message: 'Location coordinates (lat/long) are required.' });
    }
    if (!fullAddress) {
      return res.status(400).json({ message: 'Full address is required.' });
    }
    if (!interestLevel) {
      return res.status(400).json({ message: 'Customer interest level is required.' });
    }

    const updateData = {
      isColdLead: false,
      feasibilityAssignedToId,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      fullAddress,
      interestLevel,
      status: 'QUALIFIED',
      updatedAt: new Date(),
    };

    if (fromAddress) updateData.fromAddress = fromAddress;
    if (fromLatitude !== undefined && fromLatitude !== null && fromLatitude !== '') {
      updateData.fromLatitude = parseFloat(fromLatitude);
    }
    if (fromLongitude !== undefined && fromLongitude !== null && fromLongitude !== '') {
      updateData.fromLongitude = parseFloat(fromLongitude);
    }
    if (bandwidthRequirement) updateData.bandwidthRequirement = bandwidthRequirement;
    if (numberOfIPs !== undefined && numberOfIPs !== null && numberOfIPs !== '') {
      updateData.numberOfIPs = parseInt(numberOfIPs);
    }
    if (tentativePrice !== undefined && tentativePrice !== null && tentativePrice !== '') {
      updateData.tentativePrice = parseFloat(tentativePrice);
    }
    if (otcAmount !== undefined && otcAmount !== null && otcAmount !== '') {
      updateData.otcAmount = parseFloat(otcAmount);
    }
    if (billingAddress) updateData.billingAddress = billingAddress;
    if (billingPincode) updateData.billingPincode = billingPincode;
    if (expectedDeliveryDate) updateData.expectedDeliveryDate = new Date(expectedDeliveryDate);
    if (notes) {
      updateData.requirements = lead.requirements
        ? `${lead.requirements}\n\n[${new Date().toLocaleString()}] ${notes}`
        : notes;
    }

    let updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        campaignData: { include: { campaign: { select: { id: true, code: true, name: true } } } },
        products: { include: { product: { select: { id: true, title: true } } } },
        feasibilityAssignedTo: { select: { id: true, name: true, email: true } }
      }
    });

    if (productIds && Array.isArray(productIds) && productIds.length > 0) {
      await prisma.leadProduct.deleteMany({ where: { leadId: id } });
      await prisma.leadProduct.createMany({
        data: productIds.map((productId) => ({ leadId: id, productId }))
      });
      updated = await prisma.lead.findUnique({
        where: { id },
        include: {
          campaignData: { include: { campaign: { select: { id: true, code: true, name: true } } } },
          products: { include: { product: { select: { id: true, title: true } } } },
          feasibilityAssignedTo: { select: { id: true, name: true, email: true } }
        }
      });
    }

    // Notify feasibility — same contract as bdmDisposition
    notifyFeasibilityAssigned(feasibilityAssignedToId, {
      leadId: updated.id,
      company: updated.campaignData.company,
      bdmName: userName,
      campaignName: updated.campaignData.campaign?.name
    });
    emitSidebarRefresh(feasibilityAssignedToId);
    emitSidebarRefresh(userId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: 'Cold lead completed and assigned to Feasibility Team.'
    });
});

// ==========================================================================
// CREATE OPPORTUNITY
// Fast path for BDMs who already have a customer fully committed (meetings
// done, details agreed). Creates a brand-new CampaignData + Lead with all
// the meeting-outcome fields filled in one shot, skips the call/meeting
// flow entirely, and assigns to the Feasibility Team immediately. Lands
// in the Opportunity Pipeline after feasibility review.
// ==========================================================================
export const createOpportunity = asyncHandler(async function createOpportunity(req, res) {
    const userId = req.user.id;
    const userName = req.user.name;
    const userRole = req.user.role;

    if (!['BDM', 'BDM_CP', 'BDM_TEAM_LEADER', 'SUPER_ADMIN'].includes(userRole)) {
      return res.status(403).json({ message: 'Only BDM users can create opportunities.' });
    }

    const {
      // Contact
      name,
      company,
      phone,
      email,
      title,
      industry,
      city,
      // Feasibility assignment
      feasibilityAssignedToId,
      // Customer location
      latitude,
      longitude,
      fullAddress,
      // Requirements
      bandwidthRequirement,
      numberOfIPs,
      interestLevel,
      productIds,
      // Pricing
      tentativePrice,
      otcAmount,
      // Billing
      billingAddress,
      billingPincode,
      // Expected delivery
      expectedDeliveryDate,
      // Notes
      notes,
    } = req.body;

    // Contact validations (same contract as createDirectLead)
    if (!name || !name.trim()) return res.status(400).json({ message: 'Full name is required.' });
    if (!company || !company.trim()) return res.status(400).json({ message: 'Company is required.' });
    if (!phone || !phone.trim()) return res.status(400).json({ message: 'Phone number is required.' });
    if (!email || !email.trim()) return res.status(400).json({ message: 'Email is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }
    const phoneDigits = String(phone).replace(/\D/g, '');
    if (phoneDigits.length !== 10) {
      return res.status(400).json({ message: 'Phone number must be exactly 10 digits.' });
    }

    // Feasibility contract (same as Ready-for-Feasibility path)
    if (!feasibilityAssignedToId) {
      return res.status(400).json({ message: 'Feasibility Team assignment is required.' });
    }
    if (!latitude || !longitude) {
      return res.status(400).json({ message: 'Location coordinates (lat/long) are required.' });
    }
    if (!fullAddress || !fullAddress.trim()) {
      return res.status(400).json({ message: 'Customer address is required.' });
    }
    if (!interestLevel) {
      return res.status(400).json({ message: 'Customer interest level is required.' });
    }

    // Global phone dedup
    const existingPhone = await prisma.campaignData.findFirst({
      where: { phone: phoneDigits },
      select: { id: true }
    });
    if (existingPhone) {
      return res.status(400).json({ message: 'A contact with this phone number already exists.' });
    }

    // Validate products if provided
    if (productIds && productIds.length > 0) {
      const found = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true }
      });
      if (found.length !== productIds.length) {
        return res.status(400).json({ message: 'One or more selected products are invalid.' });
      }
    }

    // Find or create the reusable [BDM Self Lead] campaign for this BDM
    const campaignName = `[BDM Self Lead] ${userName || req.user.email}`;
    let selfLeadCampaign = await prisma.campaign.findFirst({
      where: { createdById: userId, name: campaignName, type: 'SELF' },
      select: { id: true }
    });

    if (!selfLeadCampaign) {
      let retries = 3;
      while (retries > 0) {
        try {
          const latest = await prisma.campaign.findFirst({
            where: { code: { startsWith: 'CMP' } },
            orderBy: { code: 'desc' },
            select: { code: true }
          });
          let maxNumber = 0;
          if (latest?.code) {
            const match = latest.code.match(/CMP(\d+)/);
            if (match) maxNumber = parseInt(match[1], 10);
          }
          const code = `CMP${String(maxNumber + 1).padStart(3, '0')}`;
          selfLeadCampaign = await prisma.campaign.create({
            data: {
              code,
              name: campaignName,
              description: 'Direct leads added by BDM (no ISR call)',
              type: 'SELF',
              status: 'ACTIVE',
              dataSource: 'BDM Direct Add',
              createdById: userId,
            },
            select: { id: true }
          });
          await prisma.campaignAssignment.create({
            data: { userId, campaignId: selfLeadCampaign.id }
          });
          break;
        } catch (err) {
          if (err.code === 'P2002' && retries > 1) {
            retries--;
            continue;
          }
          throw err;
        }
      }
    }

    const leadNumber = await generateLeadNumber();

    // CampaignData + Lead in one transaction, pre-filled with all the
    // Qualified/Ready-for-Feasibility fields. Status = QUALIFIED so it
    // goes straight to the Feasibility Team.
    const result = await prisma.$transaction(async (tx) => {
      const campaignData = await tx.campaignData.create({
        data: {
          campaignId: selfLeadCampaign.id,
          name: name.trim(),
          company: company.trim(),
          phone: phoneDigits,
          // `title` is required; fall back to placeholder if not supplied
          title: title?.trim() || '-',
          email: email.trim(),
          industry: industry?.trim() || null,
          city: city?.trim() || null,
          status: 'INTERESTED',
          assignedToId: userId,
          assignedByBdmId: userId,
          isSelfGenerated: true,
          createdById: userId,
        }
      });

      const lead = await tx.lead.create({
        data: {
          campaignDataId: campaignData.id,
          leadNumber,
          createdById: userId,
          assignedToId: userId,
          status: 'QUALIFIED',
          type: 'QUALIFIED',
          isColdLead: false,
          // Feasibility assignment
          feasibilityAssignedToId,
          // Customer location
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          fullAddress: fullAddress.trim(),
          interestLevel,
          // Requirements
          ...(bandwidthRequirement ? { bandwidthRequirement } : {}),
          ...(numberOfIPs !== undefined && numberOfIPs !== null && numberOfIPs !== ''
            ? { numberOfIPs: parseInt(numberOfIPs) }
            : {}),
          // Pricing
          ...(tentativePrice !== undefined && tentativePrice !== null && tentativePrice !== ''
            ? { tentativePrice: parseFloat(tentativePrice) }
            : {}),
          ...(otcAmount !== undefined && otcAmount !== null && otcAmount !== ''
            ? { otcAmount: parseFloat(otcAmount) }
            : {}),
          // Billing
          ...(billingAddress ? { billingAddress } : {}),
          ...(billingPincode ? { billingPincode } : {}),
          // Expected delivery
          ...(expectedDeliveryDate ? { expectedDeliveryDate: new Date(expectedDeliveryDate) } : {}),
          // Notes
          ...(notes ? { requirements: notes } : {}),
          // Products
          ...(productIds && productIds.length > 0 && {
            products: { create: productIds.map((productId) => ({ productId })) }
          })
        },
        include: {
          campaignData: {
            include: { campaign: { select: { id: true, code: true, name: true } } }
          },
          products: { include: { product: { select: { id: true, title: true } } } },
          feasibilityAssignedTo: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          createdBy: { select: { id: true, name: true, email: true } },
        }
      });

      return lead;
    });

    // Notify feasibility team (same contract as the Ready-for-Feasibility path)
    notifyFeasibilityAssigned(feasibilityAssignedToId, {
      leadId: result.id,
      company: result.campaignData.company,
      bdmName: userName,
      campaignName: result.campaignData.campaign?.name
    });
    emitSidebarRefresh(feasibilityAssignedToId);
    emitSidebarRefresh(userId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      lead: result,
      message: 'Opportunity created and assigned to Feasibility Team.'
    });
});

// ==========================================================================
// DELIVERY VENDOR SETUP
// Mandatory step before material request. The delivery team selects or
// creates a vendor based on the vendor type chosen during feasibility, and
// enters the actual cost details (fiber req, per-mtr cost, etc.) that
// produce the real CAPEX/OPEX replacing the feasibility estimates.
// ==========================================================================
export const setupDeliveryVendor = asyncHandler(async function setupDeliveryVendor(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const isDeliveryTeam = hasRole(req.user, 'DELIVERY_TEAM');

    if (!isDeliveryTeam && !isAdmin) {
      return res.status(403).json({ message: 'Only Delivery Team can set up vendors.' });
    }

    const {
      vendorId,
      // Fiber vendor fields
      fiberRequired,
      perMtrCost,
      // Actual CAPEX/OPEX (calculated by frontend from real vendor data)
      actualCapex,
      actualOpex,
      vendorNotes,
      // All vendor-type-specific data (commission %, telco details, etc.)
      vendorTypeData,
    } = req.body;

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        feasibilityVendorType: true,
        deliveryStatus: true,
        pushedToInstallationAt: true,
        vendorId: true,
      }
    });

    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    if (!lead.pushedToInstallationAt) {
      return res.status(400).json({ message: 'Lead has not been pushed to installation yet.' });
    }

    const updateData = { updatedAt: new Date() };

    // Link vendor if provided
    if (vendorId) {
      const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { id: true, approvalStatus: true, commissionPercentage: true }
      });
      if (!vendor) return res.status(400).json({ message: 'Selected vendor not found.' });
      updateData.vendorId = vendorId;
      if (vendor.commissionPercentage != null) {
        updateData.vendorCommissionPercentage = vendor.commissionPercentage;
      }
    }

    // Store all vendor-type-specific cost data in deliveryProducts JSON
    const { materials } = req.body;
    const deliveryVendorData = {
      ...(vendorTypeData || {}),
      ...(fiberRequired ? { fiberRequired: parseFloat(fiberRequired) } : {}),
      ...(perMtrCost ? { perMtrCost: parseFloat(perMtrCost) } : {}),
      ...(fiberRequired && perMtrCost ? { fiberAmount: Math.round(parseFloat(fiberRequired) * parseFloat(perMtrCost) * 100) / 100 } : {}),
      ...(materials && materials.length > 0 ? { materials } : {}),
      vendorNotes: vendorNotes || null,
      setupAt: new Date().toISOString(),
      setupById: userId,
    };
    updateData.deliveryProducts = deliveryVendorData;

    // Store actual CAPEX/OPEX (overrides tentative from feasibility)
    if (actualCapex !== undefined && actualCapex !== null && actualCapex !== '') {
      updateData.tentativeCapex = parseFloat(actualCapex);
    }
    if (actualOpex !== undefined && actualOpex !== null && actualOpex !== '') {
      updateData.tentativeOpex = parseFloat(actualOpex);
    }

    // Mark vendor setup as done
    updateData.deliveryVendorSetupDone = true;

    const updated = await prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        vendor: { select: { id: true, companyName: true, category: true, commissionPercentage: true } },
        campaignData: { select: { company: true, name: true, phone: true } }
      }
    });

    emitSidebarRefresh(userId);
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      lead: updated,
      message: 'Vendor setup saved successfully.'
    });
});