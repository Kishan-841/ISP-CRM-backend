import prisma from '../config/db.js';
import { emitToUser, emitToUsers } from '../sockets/index.js';

/**
 * Create a notification and emit it via Socket.io
 */
export const createNotification = async (userId, type, title, message, metadata = null) => {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message,
        metadata
      }
    });

    // Emit to user via Socket.io
    emitToUser(userId, 'notification', notification);

    return notification;
  } catch (error) {
    console.error('Create notification error:', error);
    return null;
  }
};

/**
 * Notify ISR when data is assigned to them
 */
export const notifyDataAssigned = async (userId, campaignName, dataCount, campaignId) => {
  const title = 'New Data Assigned';
  const message = `${dataCount} record${dataCount > 1 ? 's' : ''} assigned to you from "${campaignName}"`;

  return createNotification(userId, 'DATA_ASSIGNED', title, message, {
    campaignId,
    campaignName,
    dataCount
  });
};

/**
 * Notify BDM when a lead is converted and assigned to them
 */
export const notifyLeadConverted = async (bdmUserId, leadData) => {
  const { id, company, createdByName, campaignName } = leadData;

  const title = 'New Lead Assigned';
  const message = `"${company}" converted to lead by ${createdByName} from "${campaignName}"`;

  return createNotification(bdmUserId, 'LEAD_CONVERTED', title, message, {
    leadId: id,
    company,
    createdByName,
    campaignName
  });
};

/**
 * Notify user about follow-up reminder (ISR - Campaign Data)
 */
export const notifyFollowUpReminder = async (userId, followUpData) => {
  const { dataId, company, name, phone, scheduledTime, campaignName, minutesUntil } = followUpData;

  const title = 'Follow-up Reminder';
  const timeText = minutesUntil <= 60 ? `in ${minutesUntil} minutes` : 'soon';
  const message = `Follow-up with "${company}" is scheduled ${timeText}`;

  return createNotification(userId, 'FOLLOW_UP_REMINDER', title, message, {
    dataId,
    company,
    name,
    phone,
    scheduledTime,
    campaignName
  });
};

/**
 * Notify BDM about lead follow-up reminder
 */
export const notifyBDMFollowUpReminder = async (userId, followUpData) => {
  const { leadId, company, name, phone, scheduledTime, campaignName, minutesUntil } = followUpData;

  const title = 'Lead Follow-up Reminder';
  const timeText = minutesUntil <= 60 ? `in ${minutesUntil} minutes` : 'soon';
  const message = `Follow-up with "${company}" is scheduled ${timeText}`;

  return createNotification(userId, 'FOLLOW_UP_REMINDER', title, message, {
    leadId,
    company,
    name,
    phone,
    scheduledTime,
    campaignName
  });
};

/**
 * Send notification to all admins
 */
export const notifyAllAdmins = async (type, title, message, metadata = null) => {
  try {
    const admins = await prisma.user.findMany({
      where: {
        role: 'SUPER_ADMIN',
        isActive: true
      },
      select: { id: true }
    });

    const notifications = await Promise.all(
      admins.map(admin => createNotification(admin.id, type, title, message, metadata))
    );

    return notifications.filter(Boolean);
  } catch (error) {
    console.error('Notify all admins error:', error);
    return [];
  }
};

/**
 * Notify Feasibility Team member when a lead is assigned for review
 */
export const notifyFeasibilityAssigned = async (ftUserId, leadData) => {
  const { leadId, company, bdmName, campaignName } = leadData;

  const title = 'New Feasibility Review';
  const message = `"${company}" assigned for feasibility review by ${bdmName}`;

  return createNotification(ftUserId, 'FEASIBILITY_ASSIGNED', title, message, {
    leadId,
    company,
    bdmName,
    campaignName
  });
};

/**
 * Notify BDM when a lead is returned as Not Feasible
 */
export const notifyFeasibilityReturned = async (bdmUserId, leadData) => {
  const { leadId, company, ftUserName, notes } = leadData;

  const title = 'Lead Returned - Not Feasible';
  const message = `"${company}" marked as not feasible by ${ftUserName}`;

  return createNotification(bdmUserId, 'FEASIBILITY_RETURNED', title, message, {
    leadId,
    company,
    ftUserName,
    notes
  });
};

/**
 * Notify BDM when a lead is approved as Feasible
 */
/**
 * Send notification to all users of a specific role
 */
export const notifyAllByRole = async (role, type, title, message, metadata = null) => {
  try {
    const users = await prisma.user.findMany({
      where: { role, isActive: true },
      select: { id: true }
    });

    const notifications = await Promise.all(
      users.map(u => createNotification(u.id, type, title, message, metadata))
    );

    return notifications.filter(Boolean);
  } catch (error) {
    console.error('Notify all by role error:', error);
    return [];
  }
};

export const notifyFeasibilityApproved = async (bdmUserId, leadData) => {
  const { leadId, company, ftUserName, notes } = leadData;

  const title = 'Lead Approved - Feasible';
  const message = `"${company}" marked as feasible by ${ftUserName}`;

  return createNotification(bdmUserId, 'FEASIBILITY_APPROVED', title, message, {
    leadId,
    company,
    ftUserName,
    notes
  });
};

/**
 * Notify feasibility user that vendor documents are needed
 */
export const notifyVendorDocsReminder = async (userId, data) => {
  const { vendorId, companyName, leadCompany } = data;

  return createNotification(userId, 'VENDOR_DOCS_REMINDER', 'Vendor Documents Required',
    `Please upload documents for vendor "${companyName}" - lead "${leadCompany}" has reached accounts verification.`,
    { vendorId, companyName, leadCompany }
  );
};

/**
 * Notify assignees when a new complaint is created
 */
export const notifyComplaintCreated = async (assigneeIds, complaintData) => {
  const { complaintId, complaintNumber, customerName, category, createdByName } = complaintData;

  const title = 'New Complaint Assigned';
  const message = `Complaint ${complaintNumber} for "${customerName}" (${category}) assigned to you by ${createdByName}`;

  const notifications = await Promise.all(
    assigneeIds.map(userId =>
      createNotification(userId, 'COMPLAINT_CREATED', title, message, {
        complaintId,
        complaintNumber,
        customerName,
        category
      })
    )
  );

  return notifications.filter(Boolean);
};

/**
 * Notify when a complaint is reassigned
 */
export const notifyComplaintAssigned = async (userId, complaintData) => {
  const { complaintId, complaintNumber, customerName, assignedByName } = complaintData;

  return createNotification(userId, 'COMPLAINT_ASSIGNED', 'Complaint Assigned',
    `Complaint ${complaintNumber} for "${customerName}" assigned to you by ${assignedByName}`,
    { complaintId, complaintNumber, customerName }
  );
};

/**
 * Notify creator and assignees when complaint status changes
 */
export const notifyComplaintStatusChanged = async (userIds, complaintData) => {
  const { complaintId, complaintNumber, customerName, oldStatus, newStatus, changedByName } = complaintData;

  const title = 'Complaint Status Updated';
  const message = `Complaint ${complaintNumber} for "${customerName}": ${oldStatus} → ${newStatus} by ${changedByName}`;

  const notifications = await Promise.all(
    userIds.map(userId =>
      createNotification(userId, 'COMPLAINT_STATUS_CHANGED', title, message, {
        complaintId,
        complaintNumber,
        oldStatus,
        newStatus
      })
    )
  );

  return notifications.filter(Boolean);
};

