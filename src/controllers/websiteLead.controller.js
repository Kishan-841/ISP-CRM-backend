import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { generateLeadNumber } from '../services/documentNumber.service.js';
import { notifyAllAdmins } from '../services/notification.service.js';

// ─── Public intake ───────────────────────────────────────────────────────────
//
// The website has TWO separate enquiry forms, treated as separate entities:
//   POST /api/public/website-leads/business   → Bandwidth for Business form
//   POST /api/public/website-leads/enterprise → Enterprise form
// Each maps to its own auto-created campaign; both create unassigned Leads
// (creationSource 'WEBSITE') that the single Website Leads page lists with a
// Type filter. Auth (x-api-key) is checked in the route middleware.
const FORM_TYPES = {
  BUSINESS: {
    campaignCode: 'WEBSITE_BUSINESS',
    campaignName: 'Website Leads — Business',
    title: 'Website Enquiry — Business',
    source: 'Website - Business'
  },
  ENTERPRISE: {
    campaignCode: 'WEBSITE_ENTERPRISE',
    campaignName: 'Website Leads — Enterprise',
    title: 'Website Enquiry — Enterprise',
    source: 'Website - Enterprise'
  }
};

export const submitWebsiteLead = asyncHandler(async function submitWebsiteLead(req, res) {
  const formType = FORM_TYPES[req.websiteFormType];
  if (!formType) {
    return res.status(400).json({ success: false, message: 'Unknown form type.' });
  }
  const { name, companyName, email, mobile, pincode, address } = req.body || {};

  // Validation — mirror the website form's fields
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Name is required.' });
  }
  if (!companyName || !String(companyName).trim()) {
    return res.status(400).json({ success: false, message: 'Company name is required.' });
  }
  const digitsOnly = String(mobile ?? '').replace(/\D/g, '');
  if (digitsOnly.length !== 10) {
    return res.status(400).json({ success: false, message: 'Mobile number must have exactly 10 digits.' });
  }
  if (email && !String(email).includes('@')) {
    return res.status(400).json({ success: false, message: 'Email address is invalid.' });
  }
  const cleanedPincode = pincode ? String(pincode).replace(/\D/g, '') : '';
  if (pincode && cleanedPincode.length !== 6) {
    return res.status(400).json({ success: false, message: 'Pincode must have exactly 6 digits.' });
  }

  // System-generated records need an owner; attribute them to the first
  // active super admin.
  const creator = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    select: { id: true }
  });
  if (!creator) {
    return res.status(500).json({ success: false, message: 'CRM is not configured to accept leads yet.' });
  }

  // Find-or-create the campaign for this form type (same pattern as the
  // SELF-GENERATED / SAM-GENERATED campaigns).
  let campaign = await prisma.campaign.findFirst({ where: { code: formType.campaignCode } });
  if (!campaign) {
    campaign = await prisma.campaign.create({
      data: {
        code: formType.campaignCode,
        name: formType.campaignName,
        description: 'Leads submitted through the public website enquiry form',
        type: 'ALL',
        status: 'ACTIVE',
        dataSource: 'Website',
        isActive: true,
        createdById: creator.id
      }
    });
  }

  // Duplicates are stored anyway (a genuine customer may enquire again) but
  // flagged so the team sees it's the same person.
  const existing = await prisma.campaignData.findFirst({
    where: { phone: digitsOnly },
    select: { id: true }
  });
  const repeat = !!existing;

  const nameParts = String(name).trim().split(' ');
  const leadNumber = await generateLeadNumber();

  // One transaction so a failure never leaves an orphaned contact row.
  const { lead } = await prisma.$transaction(async (tx) => {
    const campaignData = await tx.campaignData.create({
      data: {
        campaignId: campaign.id,
        name: String(name).trim(),
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        company: String(companyName).trim(),
        title: formType.title,
        phone: digitsOnly,
        email: email ? String(email).trim() : null,
        address: address ? String(address).trim() : null,
        pincode: cleanedPincode || null,
        status: 'NEW',
        source: formType.source,
        notes: repeat ? 'Repeat enquiry — this mobile number already exists in the CRM.' : null
      }
    });

    const createdLead = await tx.lead.create({
      data: {
        campaignDataId: campaignData.id,
        leadNumber,
        createdById: creator.id,
        status: 'NEW',
        type: 'QUALIFIED',
        creationSource: 'WEBSITE'
      }
    });

    return { lead: createdLead };
  });

  const typeLabel = req.websiteFormType === 'BUSINESS' ? 'Business' : 'Enterprise';
  await notifyAllAdmins(
    'WEBSITE_LEAD',
    'New Website Lead',
    `${companyName} (${name}) submitted a ${typeLabel} enquiry on the website${repeat ? ' — repeat enquiry' : ''}.`,
    { leadId: lead.id, leadNumber, formType: req.websiteFormType }
  );

  res.status(201).json({ success: true, leadNumber, repeat });
});

// ─── Management list ─────────────────────────────────────────────────────────
//
// GET /api/website-leads/list — role-gated at the route
// (MASTER / ADMIN / SALES_DIRECTOR / SUPER_ADMIN).
export const getWebsiteLeads = asyncHandler(async function getWebsiteLeads(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const { type } = req.query; // 'BUSINESS' | 'ENTERPRISE' | undefined (all)

  const where = {
    creationSource: 'WEBSITE',
    ...(FORM_TYPES[type]
      ? { campaignData: { campaign: { code: FORM_TYPES[type].campaignCode } } }
      : {})
  };

  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      select: {
        id: true,
        leadNumber: true,
        status: true,
        createdAt: true,
        assignedTo: { select: { id: true, name: true } },
        campaignData: {
          select: {
            name: true,
            company: true,
            email: true,
            phone: true,
            pincode: true,
            address: true,
            notes: true,
            campaign: { select: { code: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit
    })
  ]);

  res.json({
    leads,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});
