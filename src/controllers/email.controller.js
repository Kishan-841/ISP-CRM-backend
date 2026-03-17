import prisma from '../config/db.js';
import { sendEmail } from '../services/email.service.js';
import { isAdminOrTestUser } from '../utils/roleHelper.js';
import { asyncHandler, parsePagination, paginatedResponse } from '../utils/controllerHelper.js';

// Allowed roles that can send emails
const ALLOWED_ROLES = ['SUPER_ADMIN', 'BDM', 'SAM'];

// Send quotation email
export const sendQuotationEmail = asyncHandler(async function sendQuotationEmail(req, res) {
  const userId = req.user.id;
  const userRole = req.user.role;

  // Check authorization
  if (!ALLOWED_ROLES.includes(userRole)) {
    return res.status(403).json({
      message: 'You are not authorized to send emails'
    });
  }

  const {
    referenceId,
    referenceType = 'lead',
    to,
    cc = [],
    subject,
    emailData,
    attachments = []
  } = req.body;

  // Validate required fields
  if (!to) {
    return res.status(400).json({ message: 'Recipient email (to) is required' });
  }

  if (!subject) {
    return res.status(400).json({ message: 'Email subject is required' });
  }

  if (!emailData) {
    return res.status(400).json({ message: 'Email data is required' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(to)) {
    return res.status(400).json({ message: 'Invalid recipient email format' });
  }

  // Validate CC emails
  if (cc.length > 0) {
    for (const ccEmail of cc) {
      if (!emailRegex.test(ccEmail)) {
        return res.status(400).json({ message: `Invalid CC email format: ${ccEmail}` });
      }
    }
  }

  // Create email log entry first (as PENDING)
  const emailLog = await prisma.emailLog.create({
    data: {
      referenceId: referenceId || null,
      referenceType: referenceType || null,
      to,
      cc,
      subject,
      htmlSnapshot: '', // Will be updated after sending
      emailData,
      attachments,
      sentByUserId: userId,
      status: 'PENDING'
    }
  });

  try {
    // Send the email
    const result = await sendEmail({
      to,
      cc,
      subject,
      emailData,
      attachments
    });

    // Update email log with success
    await prisma.emailLog.update({
      where: { id: emailLog.id },
      data: {
        status: 'SENT',
        htmlSnapshot: result.htmlSnapshot,
        resendId: result.resendId
      }
    });

    // If referenceId is a lead, update the sharedVia field
    // When sending email, reset the flow: remove docs_verification so lead goes to "Docs Upload" stage
    if (referenceId && referenceType === 'lead') {
      try {
        const lead = await prisma.lead.findUnique({
          where: { id: referenceId }
        });

        if (lead) {
          const currentSharedVia = lead.sharedVia || '';
          const sharedMethods = currentSharedVia.split(',').filter(Boolean);

          // Keep only sharing methods (email, whatsapp), remove docs_verification
          // This ensures lead goes through proper flow: Send Email → Docs Upload → Docs Verification
          const allowedMethods = ['email', 'whatsapp'];
          let newMethods = sharedMethods.filter(method => allowedMethods.includes(method));

          if (!newMethods.includes('email')) {
            newMethods.push('email');
          }

          await prisma.lead.update({
            where: { id: referenceId },
            data: {
              sharedVia: newMethods.join(','),
              // Reset docs verification fields so lead can go through the flow again
              docsVerifiedAt: null,
              docsRejectedReason: null
            }
          });
        }
      } catch (updateError) {
        console.error('Failed to update lead sharedVia:', updateError);
        // Don't fail the request, email was still sent
      }
    }

    res.json({
      success: true,
      message: 'Email sent successfully',
      emailLogId: emailLog.id,
      resendId: result.resendId
    });

  } catch (sendError) {
    // Update email log with failure
    await prisma.emailLog.update({
      where: { id: emailLog.id },
      data: {
        status: 'FAILED',
        errorMessage: sendError.message
      }
    });

    console.error('Email send error:', sendError);
    res.status(500).json({
      success: false,
      message: 'Failed to send email',
      error: sendError.message
    });
  }
});

// Get email history for a reference (lead/campaignData)
export const getEmailHistory = asyncHandler(async function getEmailHistory(req, res) {
  const { referenceId } = req.params;
  const userId = req.user.id;

  // Build where clause
  const whereClause = { referenceId };

  // Non-admin users can only see their own emails (Admin sees all)
  if (!isAdminOrTestUser(req.user)) {
    whereClause.sentByUserId = userId;
  }

  const emails = await prisma.emailLog.findMany({
    where: whereClause,
    orderBy: { sentAt: 'desc' },
    include: {
      sentBy: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });

  res.json({ emails });
});

// Get all emails sent by user (for user's own history)
export const getMyEmails = asyncHandler(async function getMyEmails(req, res) {
  const userId = req.user.id;
  const { page, limit, skip } = parsePagination(req.query, 20);

  const [emails, total] = await Promise.all([
    prisma.emailLog.findMany({
      where: { sentByUserId: userId },
      orderBy: { sentAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.emailLog.count({
      where: { sentByUserId: userId }
    })
  ]);

  res.json(paginatedResponse({ data: emails, total, page, limit, dataKey: 'emails' }));
});

export default {
  sendQuotationEmail,
  getEmailHistory,
  getMyEmails
};
