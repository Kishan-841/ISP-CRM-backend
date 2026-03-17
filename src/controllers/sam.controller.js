import prisma from '../config/db.js';
import bcrypt from 'bcryptjs';
import { Resend } from 'resend';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import { createNotification } from '../services/notification.service.js';
import { asyncHandler, parsePagination, buildSearchFilter } from '../utils/controllerHelper.js';

// Lazy initialize Resend client
let resend = null;

const getResendClient = () => {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY environment variable is not set');
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
};

// ==================== SAM HEAD ENDPOINTS ====================

/**
 * Get all customers with userId created by NOC (for SAM assignment)
 */
export const getCustomersWithInvoices = asyncHandler(async function getCustomersWithInvoices(req, res) {
    const { search, assigned } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 20);

    // Build where clause - customers who have userId created by NOC
    const where = {
      customerUserId: { not: null }
    };

    const searchOR = buildSearchFilter(search, [
      'campaignData.company',
      'campaignData.name',
      'customerUsername'
    ]);
    if (searchOR) {
      where.OR = searchOR;
    }

    // Filter by assignment status
    if (assigned === 'true') {
      where.samAssignment = { isNot: null };
    } else if (assigned === 'false') {
      where.samAssignment = null;
    }

    const [customers, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: {
          id: true,
          customerUsername: true,
          customerCreatedAt: true,
          actualPlanName: true,
          actualPlanPrice: true,
          actualPlanBandwidth: true,
          actualPlanStartDate: true,
          installationAddress: true,
          circuitId: true,
          arcAmount: true,
          contractStartDate: true,
          contractDurationMonths: true,
          contractEndDate: true,
          campaignData: {
            select: {
              company: true,
              name: true,
              phone: true,
              email: true,
              city: true
            }
          },
          samAssignment: {
            select: {
              id: true,
              assignedAt: true,
              notes: true,
              samExecutive: {
                select: {
                  id: true,
                  name: true,
                  email: true
                }
              }
            }
          },
          contractEndDate: true,
          invoices: {
            where: { status: { not: 'CANCELLED' } },
            select: { status: true },
            orderBy: { invoiceDate: 'desc' },
            take: 20
          },
          samMeetings: {
            select: { status: true, meetingDate: true },
            orderBy: { meetingDate: 'desc' },
            take: 10
          },
          samVisits: {
            select: { status: true, visitDate: true },
            orderBy: { visitDate: 'desc' },
            take: 10
          },
          _count: {
            select: {
              invoices: true,
              samMeetings: true
            }
          }
        },
        orderBy: { customerCreatedAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.lead.count({ where })
    ]);

    res.json({
      customers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
});

/**
 * Get all SAM executives (users with SAM_EXECUTIVE role)
 */
export const getSAMExecutives = asyncHandler(async function getSAMExecutives(req, res) {
    const { includeInactive } = req.query;

    const executives = await prisma.user.findMany({
      where: {
        role: 'SAM_EXECUTIVE',
        ...(includeInactive !== 'true' && { isActive: true })
      },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        createdAt: true,
        _count: {
          select: {
            samAssignmentsAsExecutive: true,
            samMeetings: true
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    res.json({ executives });
});

/**
 * Create a new SAM Executive user
 * Role: SAM_HEAD, SUPER_ADMIN
 */
export const createSAMExecutive = asyncHandler(async function createSAMExecutive(req, res) {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true }
    });

    if (existing) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        password: hashedPassword,
        name,
        role: 'SAM_EXECUTIVE'
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true
      }
    });

    res.status(201).json({ message: 'SAM Executive created successfully.', user });
});

/**
 * Toggle SAM Executive active/inactive status
 * Role: SAM_HEAD, SUPER_ADMIN
 */
export const toggleSAMExecutiveStatus = asyncHandler(async function toggleSAMExecutiveStatus(req, res) {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true, name: true }
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.role !== 'SAM_EXECUTIVE') {
      return res.status(400).json({ message: 'Can only toggle status of SAM Executive users.' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive: !user.isActive },
      select: { id: true, name: true, email: true, isActive: true }
    });

    res.json({
      message: `${updated.name} has been ${updated.isActive ? 'activated' : 'deactivated'}.`,
      user: updated
    });
});

/**
 * Assign customer to SAM executive
 */
export const assignCustomerToSAM = asyncHandler(async function assignCustomerToSAM(req, res) {
    const { customerId, samExecutiveId, notes } = req.body;
    const assignedById = req.user.id;

    // Validate customer exists and has active plan or invoices
    const customer = await prisma.lead.findFirst({
      where: {
        id: customerId,
        OR: [
          { invoices: { some: {} } },
          { actualPlanIsActive: true }
        ]
      },
      select: { id: true, arcAmount: true }
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found or has no active plan/invoices.' });
    }

    // Check if already assigned
    const existingAssignment = await prisma.sAMAssignment.findUnique({
      where: { customerId }
    });

    if (existingAssignment) {
      return res.status(400).json({ message: 'Customer is already assigned to an executive.' });
    }

    // Validate SAM executive
    const executive = await prisma.user.findFirst({
      where: { id: samExecutiveId, role: 'SAM_EXECUTIVE', isActive: true },
      select: { id: true }
    });

    if (!executive) {
      return res.status(404).json({ message: 'SAM executive not found or inactive.' });
    }

    // Create assignment
    const assignment = await prisma.sAMAssignment.create({
      data: {
        customerId,
        samExecutiveId,
        assignedById,
        notes
      },
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true } }
          }
        },
        samExecutive: {
          select: { name: true, email: true }
        }
      }
    });

    // Set originalArcAmount = current arcAmount so business impact starts at 0
    await prisma.lead.update({
      where: { id: customerId },
      data: { originalArcAmount: customer.arcAmount || 0 }
    });

    // Notify SAM executive of new assignment
    const companyName = assignment.customer?.campaignData?.company || 'a customer';
    emitSidebarRefresh(samExecutiveId);
    await createNotification(samExecutiveId, 'SAM_ASSIGNMENT', 'New Customer Assigned', `You have been assigned to ${companyName}.`, { customerId });

    res.status(201).json({
      message: 'Customer assigned successfully.',
      assignment
    });
});

/**
 * Reassign customer to different SAM executive
 */
export const reassignCustomer = asyncHandler(async function reassignCustomer(req, res) {
    const { customerId } = req.params;
    const { samExecutiveId, notes } = req.body;
    const assignedById = req.user.id;

    // Find existing assignment
    const existingAssignment = await prisma.sAMAssignment.findUnique({
      where: { customerId }
    });

    if (!existingAssignment) {
      return res.status(404).json({ message: 'Customer assignment not found.' });
    }

    // Validate new SAM executive
    const executive = await prisma.user.findFirst({
      where: { id: samExecutiveId, role: 'SAM_EXECUTIVE', isActive: true },
      select: { id: true }
    });

    if (!executive) {
      return res.status(404).json({ message: 'SAM executive not found or inactive.' });
    }

    // Get current ARC for baseline reset
    const customerLead = await prisma.lead.findUnique({
      where: { id: customerId },
      select: { arcAmount: true, originalArcAmount: true }
    });

    // Log old assignment to history before overwriting
    // Store the baseline (originalArc) and final (arcAmount) so historical views work
    await prisma.sAMAssignmentHistory.create({
      data: {
        customerId: existingAssignment.customerId,
        samExecutiveId: existingAssignment.samExecutiveId,
        assignedById: existingAssignment.assignedById,
        assignedAt: existingAssignment.assignedAt,
        removedAt: new Date(),
        reason: `Reassigned to another executive`,
        originalArc: customerLead?.originalArcAmount || 0,
        finalArc: customerLead?.arcAmount || 0
      }
    });

    // Update assignment
    const assignment = await prisma.sAMAssignment.update({
      where: { customerId },
      data: {
        samExecutiveId,
        assignedById,
        assignedAt: new Date(),
        notes: notes || existingAssignment.notes
      },
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true } }
          }
        },
        samExecutive: {
          select: { name: true, email: true }
        }
      }
    });

    // Reset originalArcAmount = arcAmount so new SAM starts with impact = 0
    await prisma.lead.update({
      where: { id: customerId },
      data: { originalArcAmount: customerLead?.arcAmount || 0 }
    });

    // Notify new SAM executive of reassignment
    const companyName = assignment.customer?.campaignData?.company || 'a customer';
    emitSidebarRefresh(samExecutiveId);
    await createNotification(samExecutiveId, 'SAM_ASSIGNMENT', 'Customer Reassigned', `${companyName} has been reassigned to you.`, { customerId });

    // Also refresh old executive's sidebar
    if (existingAssignment.samExecutiveId !== samExecutiveId) {
      emitSidebarRefresh(existingAssignment.samExecutiveId);
    }

    res.json({
      message: 'Customer reassigned successfully.',
      assignment
    });
});

/**
 * Bulk reassign all customers from one SAM executive to another.
 * Resets originalArcAmount = arcAmount so new SAM starts with impact = 0.
 * Role: SAM_HEAD, SUPER_ADMIN
 */
export const bulkReassignCustomers = asyncHandler(async function bulkReassignCustomers(req, res) {
    const { fromExecutiveId, toExecutiveId } = req.body;
    const assignedById = req.user.id;

    if (!fromExecutiveId || !toExecutiveId) {
      return res.status(400).json({ message: 'Both source and target executive IDs are required.' });
    }

    if (fromExecutiveId === toExecutiveId) {
      return res.status(400).json({ message: 'Source and target executive cannot be the same.' });
    }

    // Validate target executive exists and is active
    const targetExec = await prisma.user.findFirst({
      where: { id: toExecutiveId, role: 'SAM_EXECUTIVE', isActive: true },
      select: { id: true, name: true }
    });
    if (!targetExec) {
      return res.status(404).json({ message: 'Target SAM executive not found or inactive.' });
    }

    // Get all assignments for the source executive
    const assignments = await prisma.sAMAssignment.findMany({
      where: { samExecutiveId: fromExecutiveId },
      select: {
        id: true,
        customerId: true,
        assignedAt: true,
        customer: {
          select: { id: true, arcAmount: true, originalArcAmount: true, campaignData: { select: { company: true } } }
        }
      }
    });

    if (assignments.length === 0) {
      return res.status(400).json({ message: 'No customers found for the source executive.' });
    }

    // Perform bulk reassignment in a transaction
    await prisma.$transaction(async (tx) => {
      for (const assignment of assignments) {
        // Log old assignment to history with baseline and final ARC
        await tx.sAMAssignmentHistory.create({
          data: {
            customerId: assignment.customerId,
            samExecutiveId: fromExecutiveId,
            assignedById: assignment.id ? assignedById : assignedById,
            assignedAt: assignment.assignedAt,
            removedAt: new Date(),
            reason: `Bulk reassigned to ${targetExec.name}`,
            originalArc: assignment.customer?.originalArcAmount || 0,
            finalArc: assignment.customer?.arcAmount || 0
          }
        });

        // Update assignment to new executive
        await tx.sAMAssignment.update({
          where: { id: assignment.id },
          data: {
            samExecutiveId: toExecutiveId,
            assignedById,
            assignedAt: new Date(),
            notes: `Bulk reassigned from previous executive`
          }
        });

        // Set originalArcAmount = arcAmount so new SAM starts with impact = 0
        // Total Final ARC (sum of arcAmount) stays constant
        const currentArc = assignment.customer?.arcAmount || 0;
        await tx.lead.update({
          where: { id: assignment.customerId },
          data: { originalArcAmount: currentArc }
        });
      }
    });

    // Notify new executive
    emitSidebarRefresh(toExecutiveId);
    await createNotification(
      toExecutiveId,
      'SAM_ASSIGNMENT',
      'Customers Bulk Reassigned',
      `${assignments.length} customer(s) have been reassigned to you.`,
      { count: assignments.length }
    );

    // Refresh old executive sidebar
    emitSidebarRefresh(fromExecutiveId);

    res.json({
      message: `${assignments.length} customer(s) reassigned successfully.`,
      count: assignments.length
    });
});

/**
 * Get SAM Head dashboard stats
 */
export const getSAMHeadDashboardStats = asyncHandler(async function getSAMHeadDashboardStats(req, res) {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);

    const [
      totalCustomers,
      assignedCustomers,
      meetingsThisWeek,
      executiveCount
    ] = await Promise.all([
      prisma.lead.count({
        where: { customerUserId: { not: null } }
      }),
      prisma.sAMAssignment.count(),
      prisma.sAMMeeting.count({
        where: {
          meetingDate: {
            gte: startOfWeek,
            lt: endOfWeek
          }
        }
      }),
      prisma.user.count({
        where: { role: 'SAM_EXECUTIVE', isActive: true }
      })
    ]);

    res.json({
      totalCustomers,
      assignedCustomers,
      unassignedCustomers: totalCustomers - assignedCustomers,
      meetingsThisWeek,
      executiveCount
    });
});

// ==================== SAM EXECUTIVE ENDPOINTS ====================

/**
 * Get customers assigned to current SAM executive
 */
export const getMyAssignedCustomers = asyncHandler(async function getMyAssignedCustomers(req, res) {
    const samExecutiveId = req.user.id;
    const { search } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 20);

    const where = {
      samExecutiveId
    };

    if (search) {
      where.customer = {
        OR: [
          { campaignData: { company: { contains: search, mode: 'insensitive' } } },
          { campaignData: { name: { contains: search, mode: 'insensitive' } } },
          { customerUsername: { contains: search, mode: 'insensitive' } }
        ]
      };
    }

    const [assignments, total] = await Promise.all([
      prisma.sAMAssignment.findMany({
        where,
        select: {
          id: true,
          assignedAt: true,
          notes: true,
          customer: {
            select: {
              id: true,
              customerUsername: true,
              customerCreatedAt: true,
              circuitId: true,
              actualPlanName: true,
              actualPlanPrice: true,
              actualPlanBandwidth: true,
              arcAmount: true,
              campaignData: {
                select: {
                  company: true,
                  name: true,
                  phone: true,
                  email: true
                }
              },
              contractEndDate: true,
              invoices: {
                where: { status: { not: 'CANCELLED' } },
                select: { status: true, invoiceDate: true },
                orderBy: { invoiceDate: 'desc' },
                take: 20
              },
              samMeetings: {
                select: { meetingDate: true, status: true },
                orderBy: { meetingDate: 'desc' },
                take: 10
              },
              samVisits: {
                select: { status: true, visitDate: true },
                orderBy: { visitDate: 'desc' },
                take: 10
              },
              _count: {
                select: { invoices: true, samMeetings: true }
              }
            }
          }
        },
        orderBy: { assignedAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.sAMAssignment.count({ where })
    ]);

    res.json({
      assignments,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
});

/**
 * Get single customer details (for both SAM_HEAD and SAM_EXECUTIVE)
 */
export const getCustomerDetails = asyncHandler(async function getCustomerDetails(req, res) {
    const { customerId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // For SAM_EXECUTIVE, verify assignment
    if (userRole === 'SAM_EXECUTIVE') {
      const assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId, samExecutiveId: userId }
      });

      if (!assignment) {
        return res.status(403).json({ message: 'Not authorized to view this customer.' });
      }
    }

    const customer = await prisma.lead.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        customerUsername: true,
        customerCreatedAt: true,
        actualPlanName: true,
        actualPlanPrice: true,
        actualPlanBandwidth: true,
        billingAddress: true,
        // NOC-set fields
        circuitId: true,
        customerIpAssigned: true,
        customerIpAddresses: true,
        numberOfIPs: true,
        installationAddress: true,
        campaignData: {
          select: {
            company: true,
            name: true,
            phone: true,
            email: true
          }
        },
        samAssignment: {
          select: {
            id: true,
            assignedAt: true,
            notes: true,
            samExecutive: {
              select: { id: true, name: true, email: true }
            }
          }
        },
        invoices: {
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            grandTotal: true,
            status: true
          },
          orderBy: { invoiceDate: 'desc' },
          take: 10
        },
        samMeetings: {
          select: {
            id: true,
            title: true,
            meetingDate: true,
            meetingType: true,
            status: true,
            discussion: true,
            momEmailSentAt: true
          },
          orderBy: { meetingDate: 'desc' },
          take: 10
        },
        samVisits: {
          select: {
            id: true,
            visitDate: true,
            visitType: true,
            status: true,
            purpose: true,
            outcome: true
          },
          orderBy: { visitDate: 'desc' },
          take: 10
        }
      }
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    res.json({ customer });
});

// ==================== MEETING ENDPOINTS ====================

/**
 * Create a new meeting
 */
export const createMeeting = asyncHandler(async function createMeeting(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { customerId, meetingDate, meetingType, location, clientParticipants, gazonParticipants, actionItems } = req.body;

    if (!customerId || !meetingDate) {
      return res.status(400).json({ message: 'Customer and meeting date are required.' });
    }

    // For SAM_EXECUTIVE: verify assignment. For SAM_HEAD/SUPER_ADMIN: verify customer has any assignment
    let assignment;
    if (userRole === 'SAM_HEAD' || userRole === 'SUPER_ADMIN') {
      assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId },
        include: { customer: { select: { campaignData: { select: { company: true } } } } }
      });
    } else {
      assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId, samExecutiveId: userId },
        include: { customer: { select: { campaignData: { select: { company: true } } } } }
      });
    }

    if (!assignment) {
      return res.status(403).json({ message: 'Not authorized to create meeting for this customer.' });
    }

    // SAM_HEAD/SUPER_ADMIN uses the assigned executive; SAM_EXECUTIVE uses themselves
    const samExecutiveId = (userRole === 'SAM_HEAD' || userRole === 'SUPER_ADMIN')
      ? assignment.samExecutiveId
      : userId;

    const companyName = assignment.customer.campaignData?.company || 'Customer';
    const title = `MOM - ${companyName}`;

    const meeting = await prisma.sAMMeeting.create({
      data: {
        customerId,
        samExecutiveId,
        title,
        meetingDate: new Date(meetingDate),
        meetingType: meetingType || 'ONLINE',
        location: location || null,
        status: 'COMPLETED',
        clientParticipants: clientParticipants || null,
        gazonParticipants: gazonParticipants || null,
        actionItems: actionItems || null
      },
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true, name: true } }
          }
        }
      }
    });

    // Refresh SAM head sidebar and own sidebar for count updates
    emitSidebarRefreshByRole('SAM_HEAD');
    emitSidebarRefresh(samExecutiveId);

    res.status(201).json({
      message: 'MOM created successfully.',
      meeting
    });
});

/**
 * Get meetings (for calendar view)
 */
export const getMeetings = asyncHandler(async function getMeetings(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { startDate, endDate, status, executiveId } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 100);

    const where = {};

    // Filter by role
    if (userRole === 'SAM_EXECUTIVE') {
      where.samExecutiveId = userId;
    } else if (userRole === 'SAM_HEAD' && executiveId) {
      where.samExecutiveId = executiveId;
    }

    // Filter by date range
    if (startDate || endDate) {
      where.meetingDate = {};
      if (startDate) {
        // Set start date to beginning of day (00:00:00.000)
        const startDateTime = new Date(startDate);
        startDateTime.setHours(0, 0, 0, 0);
        where.meetingDate.gte = startDateTime;
      }
      if (endDate) {
        // Set end date to end of day (23:59:59.999)
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        where.meetingDate.lte = endDateTime;
      }
    }

    // Filter by status
    if (status) {
      where.status = status;
    }

    const [meetings, total] = await Promise.all([
      prisma.sAMMeeting.findMany({
        where,
        select: {
          id: true,
          customerId: true,
          title: true,
          meetingDate: true,
          meetingType: true,
          location: true,
          meetingLink: true,
          status: true,
          clientParticipants: true,
          gazonParticipants: true,
          attendees: true,
          discussion: true,
          actionItems: true,
          followUpDate: true,
          momEmailSentAt: true,
          createdAt: true,
          customer: {
            select: {
              id: true,
              customerUsername: true,
              campaignData: {
                select: { company: true, name: true, email: true }
              }
            }
          },
          samExecutive: {
            select: { id: true, name: true, email: true }
          }
        },
        orderBy: { meetingDate: 'desc' },
        skip,
        take: limit
      }),
      prisma.sAMMeeting.count({ where })
    ]);

    res.json({
      meetings,
      total,
      page,
      limit
    });
});

/**
 * Get single meeting by ID
 */
export const getMeetingById = asyncHandler(async function getMeetingById(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const meeting = await prisma.sAMMeeting.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            customerUsername: true,
            actualPlanName: true,
            campaignData: {
              select: { company: true, name: true, phone: true, email: true }
            }
          }
        },
        samExecutive: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' });
    }

    // Verify access
    if (userRole === 'SAM_EXECUTIVE' && meeting.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized to view this meeting.' });
    }

    // Ensure actionItems is always an array for frontend consumption
    if (meeting.actionItems && typeof meeting.actionItems === 'string') {
      try { meeting.actionItems = JSON.parse(meeting.actionItems); } catch { meeting.actionItems = null; }
    }

    res.json({ meeting });
});

/**
 * Update MOM details
 */
export const updateMeeting = asyncHandler(async function updateMeeting(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { meetingDate, meetingType, location, clientParticipants, gazonParticipants, actionItems } = req.body;

    // Verify ownership
    const existingMeeting = await prisma.sAMMeeting.findUnique({
      where: { id }
    });

    if (!existingMeeting) {
      return res.status(404).json({ message: 'Meeting not found.' });
    }

    const userRole = req.user.role;
    if (userRole !== 'SAM_HEAD' && userRole !== 'SUPER_ADMIN' && existingMeeting.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized to update this MOM.' });
    }

    if (existingMeeting.momEmailSentAt) {
      return res.status(400).json({ message: 'Cannot edit MOM after email has been sent.' });
    }

    const updateData = {};
    if (meetingDate !== undefined) updateData.meetingDate = new Date(meetingDate);
    if (meetingType !== undefined) updateData.meetingType = meetingType;
    if (location !== undefined) updateData.location = location || null;
    if (clientParticipants !== undefined) updateData.clientParticipants = clientParticipants || null;
    if (gazonParticipants !== undefined) updateData.gazonParticipants = gazonParticipants || null;
    if (actionItems !== undefined) updateData.actionItems = actionItems || null;

    const meeting = await prisma.sAMMeeting.update({
      where: { id },
      data: updateData,
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true } }
          }
        }
      }
    });

    res.json({
      message: 'MOM updated successfully.',
      meeting
    });
});

// updateMeetingOutcome and cancelMeeting removed - MOM is now captured at creation

// ==================== MOM EMAIL ====================

/**
 * MOM Email Template - Professional format with participants and action items tables
 */
const DEFAULT_MOM_BODY_TEXT = `Dear Sir,

Greetings from Gazon Communications India Ltd.!

I appreciate you taking the time to meet with us. It was a pleasure to discuss with you about our services, scope of improvement, and future collaboration opportunities.

Your insights and perspectives were incredibly valuable, and we are excited about the potential opportunities and collaborations discussed.

We look forward to working together and hope to have more productive meetings in the future.

Please find below the points which were discussed in the meeting.`;

const getMOMEmailTemplate = ({ companyName, meetingDate, meetingTime, meetingType, venue, clientParticipants, gazonParticipants, actionItems, executiveName, designation, phone, bodyText }) => {
  const defaultBodyText = DEFAULT_MOM_BODY_TEXT;
  const formattedDate = new Date(meetingDate).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });

  const monthYear = new Date(meetingDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

  const typeLabel = meetingType === 'ONLINE' || meetingType === 'VIRTUAL' ? 'Online' :
                    meetingType === 'PHYSICAL' || meetingType === 'IN_PERSON' ? 'Face to face' :
                    meetingType === 'PHONE_CALL' ? 'Phone Call' : meetingType;

  // Parse participants: handles JSON array [{name, position}] or legacy comma-separated string
  const parseParticipantsList = (val) => {
    if (!val) return [];
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return val.split(',').map(n => ({ name: n.trim(), position: '' })).filter(p => p.name);
  };

  const formatParticipantNames = (list) => list.map(p => p.name + (p.position ? ` (${p.position})` : '')).join(', ');

  const clientList = parseParticipantsList(clientParticipants);
  const gazonList = parseParticipantsList(gazonParticipants);
  const clientNames = formatParticipantNames(clientList);
  const gazonNames = formatParticipantNames(gazonList);

  const participantsHtml = (clientNames || gazonNames) ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;border:1px solid #e2e8f0;">
      <tr>
        <td rowspan="2" style="padding:10px 16px;font-size:13px;font-weight:600;color:#1e293b;border:1px solid #e2e8f0;width:100px;vertical-align:middle;background:#f8fafc;">Participants</td>
        <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#1e293b;border:1px solid #e2e8f0;background:#f8fafc;">${companyName}</td>
        <td style="padding:10px 16px;font-size:13px;color:#334155;border:1px solid #e2e8f0;background:#fff;"><strong>${clientNames || '-'}</strong></td>
      </tr>
      <tr>
        <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#1e293b;border:1px solid #e2e8f0;background:#f8fafc;">Gazon Communications India Limited.</td>
        <td style="padding:10px 16px;font-size:13px;color:#334155;border:1px solid #e2e8f0;background:#fff;"><strong>${gazonNames || '-'}</strong></td>
      </tr>
    </table>` : '';

  // Build action items table
  const items = Array.isArray(actionItems) ? actionItems : [];
  const actionItemsHtml = items.length > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;">
      <tr>
        <td style="background:#f97316;color:#fff;padding:10px 12px;font-size:12px;font-weight:600;border:1px solid #ea580c;width:40px;">SR no.</td>
        <td style="background:#f97316;color:#fff;padding:10px 12px;font-size:12px;font-weight:600;border:1px solid #ea580c;">Discussion Description</td>
        <td style="background:#f97316;color:#fff;padding:10px 12px;font-size:12px;font-weight:600;border:1px solid #ea580c;">Action Owner</td>
        <td style="background:#f97316;color:#fff;padding:10px 12px;font-size:12px;font-weight:600;border:1px solid #ea580c;">Plan of action</td>
        <td style="background:#f97316;color:#fff;padding:10px 12px;font-size:12px;font-weight:600;border:1px solid #ea580c;">Closure date</td>
        <td style="background:#f97316;color:#fff;padding:10px 12px;font-size:12px;font-weight:600;border:1px solid #ea580c;">Current status</td>
      </tr>
      ${items.map((item, i) => `
      <tr>
        <td style="padding:8px 12px;font-size:12px;color:#334155;border:1px solid #e2e8f0;background:${i % 2 === 0 ? '#fff' : '#f8fafc'};">${item.srNo || i + 1}</td>
        <td style="padding:8px 12px;font-size:12px;color:#334155;border:1px solid #e2e8f0;background:${i % 2 === 0 ? '#fff' : '#f8fafc'};">${item.discussionDescription || item.issueDescription || ''}</td>
        <td style="padding:8px 12px;font-size:12px;color:#334155;border:1px solid #e2e8f0;background:${i % 2 === 0 ? '#fff' : '#f8fafc'};">${item.actionOwner || ''}</td>
        <td style="padding:8px 12px;font-size:12px;color:#334155;border:1px solid #e2e8f0;background:${i % 2 === 0 ? '#fff' : '#f8fafc'};">${item.planOfAction || ''}</td>
        <td style="padding:8px 12px;font-size:12px;color:#334155;border:1px solid #e2e8f0;background:${i % 2 === 0 ? '#fff' : '#f8fafc'};">${item.closureDate || ''}</td>
        <td style="padding:8px 12px;font-size:12px;color:#334155;border:1px solid #e2e8f0;background:${i % 2 === 0 ? '#fff' : '#f8fafc'};">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;${item.currentStatus === 'Closed' ? 'background:#dcfce7;color:#166534;' : item.currentStatus === 'In Progress' ? 'background:#dbeafe;color:#1e40af;' : 'background:#fef9c3;color:#854d0e;'}">${item.currentStatus || 'Open'}</span>
        </td>
      </tr>`).join('')}
    </table>` : '';

  // Signature block
  const signatureDesignation = designation || 'Service Account Manager';
  const signaturePhone = phone ? `<br/>Mob:${phone}` : '';

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
      <tr>
        <td style="padding:24px 32px;">
          <!-- Email Body Text -->
          ${(bodyText || defaultBodyText).split('\n').map(line =>
            line.trim()
              ? `<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 8px;">${line}</p>`
              : `<p style="font-size:14px;line-height:0.8;margin:0;">&nbsp;</p>`
          ).join('\n          ')}

          <!-- MINUTES OF MEETING header -->
          <p style="text-align:right;margin:0 0 16px;">
            <span style="font-size:16px;font-weight:700;color:#1e293b;text-decoration:underline;">MINUTES OF MEETING</span>
          </p>

          <!-- Client Name -->
          <p style="font-size:14px;color:#1e293b;margin:0 0 16px;">
            <strong>Client Name: ${companyName.toUpperCase()}</strong>
          </p>

          <!-- Meeting Details -->
          <p style="font-size:14px;color:#1e293b;margin:0 0 8px;"><strong>Meeting Details:</strong></p>
          <ul style="margin:0 0 24px;padding-left:24px;font-size:14px;color:#334155;line-height:1.8;">
            <li><strong>Date:-</strong> ${formattedDate}</li>
            <li><strong>Meeting Type:-</strong> ${typeLabel}</li>
            ${venue ? `<li><strong>Venue:-</strong>${venue}</li>` : ''}
          </ul>

          <!-- Participants -->
          ${participantsHtml}

          <!-- Action Items -->
          ${actionItemsHtml}

          <!-- Warm Regards Signature -->
          <div style="margin-top:32px;">
            <p style="margin:0;font-size:14px;color:#c2410c;font-weight:700;line-height:1.6;">Warm Regards,</p>
            <p style="margin:0;font-size:14px;color:#1e293b;line-height:1.6;">
              ${executiveName}<br/>
              ${signatureDesignation}${signaturePhone}
            </p>
          </div>

          <!-- Separator -->
          <hr style="margin:24px 0;border:none;border-top:2px solid #2563eb;" />

          <!-- Company Details (hardcoded) -->
          <p style="margin:0;font-size:13px;color:#2563eb;font-weight:700;line-height:1.5;">Gazon Communications India Limited.</p>
          <p style="margin:0;font-size:13px;color:#334155;line-height:1.5;">
            1001, 10th Floor, City Avenue, Kolte Patil Developers,<br/>
            Near Jaguar Showroom, Bhumkar Chowk, Wakad-411057.<br/>
            Maharashtra, India.
          </p>
          <p style="margin:8px 0 0;font-size:13px;color:#2563eb;line-height:1.5;">
            <strong>GST No.:</strong> 27AAECG8392G1Z9 /<strong>TAN No.:</strong> NSKG04623D /<strong>PAN No.:</strong> AAECG8392G
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
};

/**
 * Send MOM email to customer
 */
/**
 * Helper to build MOM email HTML and subject for a meeting
 */
function buildMOMEmail(meeting, { designation, phone, bodyText } = {}) {
  const companyName = meeting.customer.campaignData.company || 'Customer';
  const executiveName = meeting.samExecutive.name;

  const monthYear = new Date(meeting.meetingDate).toLocaleDateString('en-IN', {
    month: 'short',
    year: 'numeric'
  });

  const subject = `Service Review Meeting |${companyName.toUpperCase()} || ${monthYear}.`;

  const htmlContent = getMOMEmailTemplate({
    companyName,
    meetingDate: meeting.meetingDate,
    meetingType: meeting.meetingType,
    venue: meeting.location,
    clientParticipants: meeting.clientParticipants,
    gazonParticipants: meeting.gazonParticipants,
    actionItems: meeting.actionItems,
    executiveName,
    designation,
    phone,
    bodyText
  });

  return { subject, htmlContent, companyName };
}

/**
 * Get MOM email preview (HTML) without sending
 */
export const getMOMEmailPreview = asyncHandler(async function getMOMEmailPreview(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const { designation, phone, bodyText } = req.body || {};

    const meeting = await prisma.sAMMeeting.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true, name: true, email: true } }
          }
        },
        samExecutive: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' });
    }

    if (userRole === 'SAM_EXECUTIVE' && meeting.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized.' });
    }

    const { subject, htmlContent } = buildMOMEmail(meeting, { designation, phone, bodyText });

    res.json({ subject, html: htmlContent });
});

export const sendMOMEmail = asyncHandler(async function sendMOMEmail(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { to, cc = [], subject: customSubject, designation, phone, bodyText } = req.body;

    // Get meeting with all required data
    const meeting = await prisma.sAMMeeting.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            campaignData: {
              select: { company: true, name: true, email: true }
            }
          }
        },
        samExecutive: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' });
    }

    const userRole = req.user.role;
    if (userRole !== 'SAM_HEAD' && userRole !== 'SUPER_ADMIN' && meeting.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized to send email for this meeting.' });
    }

    // Use custom "to" if provided, otherwise fall back to customer email
    const recipientEmail = to || meeting.customer.campaignData.email;
    if (!recipientEmail) {
      return res.status(400).json({ message: 'No recipient email address provided.' });
    }

    const { subject: generatedSubject, htmlContent, companyName } = buildMOMEmail(meeting, { designation, phone, bodyText });
    const subject = customSubject || generatedSubject;

    // Send email via Resend
    const resendClient = getResendClient();
    const emailOptions = {
      from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to: [recipientEmail],
      subject,
      html: htmlContent
    };

    if (cc.length > 0) {
      emailOptions.cc = cc;
    }

    const { data, error } = await resendClient.emails.send(emailOptions);

    if (error) {
      console.error('Resend API error:', error);
      return res.status(500).json({ message: 'Failed to send email: ' + error.message });
    }

    // Update meeting with email sent timestamp
    await prisma.sAMMeeting.update({
      where: { id },
      data: { momEmailSentAt: new Date() }
    });

    // Refresh sidebar to update pending email count
    emitSidebarRefresh(userId);

    // Log email in EmailLog table
    await prisma.emailLog.create({
      data: {
        referenceId: id,
        referenceType: 'SAM_MEETING',
        to: recipientEmail,
        cc: cc,
        subject,
        htmlSnapshot: htmlContent,
        emailData: {
          companyName,
          meetingDate: meeting.meetingDate,
          actionItems: meeting.actionItems
        },
        sentByUserId: userId,
        status: 'SENT',
        resendId: data?.id
      }
    });

    res.json({
      message: 'MOM email sent successfully.',
      emailId: data?.id
    });
});

/**
 * Get SAM Executive dashboard stats
 */
export const getSAMExecutiveDashboardStats = asyncHandler(async function getSAMExecutiveDashboardStats(req, res) {
    const samExecutiveId = req.user.id;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);

    // Get assigned customer IDs for this SAM
    const assignments = await prisma.sAMAssignment.findMany({
      where: { samExecutiveId },
      select: { customerId: true }
    });
    const customerIds = assignments.map(a => a.customerId);

    const [
      totalAssignedCustomers,
      pendingMomEmails,
      meetingsThisWeek,
      completedMeetings,
      arcData,
      orderCounts
    ] = await Promise.all([
      assignments.length,
      prisma.sAMMeeting.count({
        where: {
          samExecutiveId,
          status: 'COMPLETED',
          momEmailSentAt: null
        }
      }),
      prisma.sAMMeeting.count({
        where: {
          samExecutiveId,
          meetingDate: {
            gte: startOfWeek,
            lt: endOfWeek
          }
        }
      }),
      prisma.sAMMeeting.count({
        where: {
          samExecutiveId,
          status: 'COMPLETED'
        }
      }),
      // Sum ARC for assigned customers (active plans only)
      prisma.lead.aggregate({
        where: {
          id: { in: customerIds },
          actualPlanIsActive: true
        },
        _sum: {
          arcAmount: true,
          originalArcAmount: true
        },
        _count: true
      }),
      // Order type breakdown for assigned customers
      customerIds.length > 0
        ? prisma.serviceOrder.groupBy({
            by: ['orderType'],
            where: {
              customerId: { in: customerIds },
              status: { not: 'CANCELLED' }
            },
            _count: { orderType: true },
            _sum: { currentArc: true, newArc: true }
          })
        : []
    ]);

    // Build order stats
    const orderStats = {};
    for (const row of orderCounts) {
      orderStats[row.orderType] = {
        count: row._count.orderType,
        arcFrom: row._sum.currentArc || 0,
        arcTo: row._sum.newArc || 0
      };
    }

    res.json({
      totalAssignedCustomers,
      pendingMomEmails,
      meetingsThisWeek,
      completedMeetings,
      totalArc: arcData._sum.arcAmount || 0,
      originalArc: arcData._sum.originalArcAmount || 0,
      activeCustomers: arcData._count || 0,
      orderStats
    });
});

// ==================== CUSTOMER SERVICE DETAILS ====================

/**
 * Update customer service details (serviceType, IP, CPE, contract, escalation)
 */
export const updateCustomerServiceDetails = asyncHandler(async function updateCustomerServiceDetails(req, res) {
    const { customerId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const {
      serviceType,
      ipDetails,
      cpeDetails,
      contractStartDate,
      contractDurationMonths,
      escalationMatrix
    } = req.body;

    // Verify access
    if (userRole === 'SAM_EXECUTIVE') {
      const assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId, samExecutiveId: userId }
      });
      if (!assignment) {
        return res.status(403).json({ message: 'Not authorized to update this customer.' });
      }
    }

    // Calculate contract end date if start date and duration provided
    let contractEndDate = null;
    if (contractStartDate && contractDurationMonths) {
      contractEndDate = new Date(contractStartDate);
      contractEndDate.setMonth(contractEndDate.getMonth() + parseInt(contractDurationMonths));
    }

    const updateData = {};
    if (serviceType !== undefined) updateData.serviceType = serviceType;
    if (ipDetails !== undefined) updateData.ipDetails = ipDetails;
    if (cpeDetails !== undefined) updateData.cpeDetails = cpeDetails;
    if (contractStartDate !== undefined) updateData.contractStartDate = new Date(contractStartDate);
    if (contractDurationMonths !== undefined) updateData.contractDurationMonths = parseInt(contractDurationMonths);
    if (contractEndDate) updateData.contractEndDate = contractEndDate;
    if (escalationMatrix !== undefined) updateData.escalationMatrix = escalationMatrix;

    const customer = await prisma.lead.update({
      where: { id: customerId },
      data: updateData,
      select: {
        id: true,
        customerUsername: true,
        serviceType: true,
        ipDetails: true,
        cpeDetails: true,
        contractStartDate: true,
        contractDurationMonths: true,
        contractEndDate: true,
        escalationMatrix: true,
        campaignData: {
          select: { company: true }
        }
      }
    });

    res.json({
      message: 'Customer service details updated successfully.',
      customer
    });
});

/**
 * Get customer service details
 */
export const getCustomerServiceDetails = asyncHandler(async function getCustomerServiceDetails(req, res) {
    const { customerId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Verify access
    if (userRole === 'SAM_EXECUTIVE') {
      const assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId, samExecutiveId: userId }
      });
      if (!assignment) {
        return res.status(403).json({ message: 'Not authorized to view this customer.' });
      }
    }

    const customer = await prisma.lead.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        customerUsername: true,
        circuitId: true,
        serviceType: true,
        ipDetails: true,
        cpeDetails: true,
        contractStartDate: true,
        contractDurationMonths: true,
        contractEndDate: true,
        escalationMatrix: true,
        customerCreatedAt: true,
        actualPlanName: true,
        actualPlanPrice: true,
        actualPlanBandwidth: true,
        billingAddress: true,
        fullAddress: true,
        campaignData: {
          select: {
            company: true,
            name: true,
            phone: true,
            email: true,
            city: true,
            state: true
          }
        },
        samAssignment: {
          select: {
            samExecutive: {
              select: { id: true, name: true, email: true }
            }
          }
        }
      }
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    // Check if contract is expiring soon (within 30 days)
    let contractStatus = null;
    if (customer.contractEndDate) {
      const daysUntilExpiry = Math.ceil((new Date(customer.contractEndDate) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysUntilExpiry <= 0) {
        contractStatus = 'EXPIRED';
      } else if (daysUntilExpiry <= 30) {
        contractStatus = 'EXPIRING_SOON';
      } else {
        contractStatus = 'ACTIVE';
      }
    }

    res.json({
      customer: {
        ...customer,
        contractStatus
      }
    });
});

// ==================== VISIT TRACKING ====================

/**
 * Create a new visit
 */
export const createVisit = asyncHandler(async function createVisit(req, res) {
    const samExecutiveId = req.user.id;
    const { customerId, visitDate, visitType, purpose, location } = req.body;

    // Verify the executive is assigned to this customer
    const assignment = await prisma.sAMAssignment.findFirst({
      where: { customerId, samExecutiveId }
    });

    if (!assignment) {
      return res.status(403).json({ message: 'Not authorized to create visit for this customer.' });
    }

    const visit = await prisma.sAMVisit.create({
      data: {
        customerId,
        samExecutiveId,
        visitDate: new Date(visitDate),
        visitType: visitType || 'REGULAR',
        purpose,
        location
      },
      include: {
        customer: {
          select: {
            customerUsername: true,
            campaignData: { select: { company: true } }
          }
        }
      }
    });

    // Refresh SAM head sidebar for visit count updates
    emitSidebarRefreshByRole('SAM_HEAD');

    res.status(201).json({
      message: 'Visit scheduled successfully.',
      visit
    });
});

/**
 * Get visits (calendar view)
 */
export const getVisits = asyncHandler(async function getVisits(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { startDate, endDate, status, executiveId, customerId } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 100);

    const where = {};

    // Filter by role
    if (userRole === 'SAM_EXECUTIVE') {
      where.samExecutiveId = userId;
    } else if (userRole === 'SAM_HEAD' && executiveId) {
      where.samExecutiveId = executiveId;
    }

    // Filter by customer
    if (customerId) {
      where.customerId = customerId;
    }

    // Filter by date range
    if (startDate || endDate) {
      where.visitDate = {};
      if (startDate) {
        // Set start date to beginning of day (00:00:00.000)
        const startDateTime = new Date(startDate);
        startDateTime.setHours(0, 0, 0, 0);
        where.visitDate.gte = startDateTime;
      }
      if (endDate) {
        // Set end date to end of day (23:59:59.999)
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        where.visitDate.lte = endDateTime;
      }
    }

    // Filter by status
    if (status) {
      where.status = status;
    }

    const [visits, total] = await Promise.all([
      prisma.sAMVisit.findMany({
        where,
        select: {
          id: true,
          customerId: true,
          visitDate: true,
          visitType: true,
          status: true,
          purpose: true,
          location: true,
          outcome: true,
          nextVisitDate: true,
          completedAt: true,
          createdAt: true,
          customer: {
            select: {
              id: true,
              customerUsername: true,
              fullAddress: true,
              campaignData: {
                select: { company: true, name: true, phone: true }
              }
            }
          },
          samExecutive: {
            select: { id: true, name: true }
          }
        },
        orderBy: { visitDate: 'asc' },
        skip,
        take: limit
      }),
      prisma.sAMVisit.count({ where })
    ]);

    res.json({
      visits,
      total,
      page,
      limit
    });
});

/**
 * Get single visit by ID
 */
export const getVisitById = asyncHandler(async function getVisitById(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const visit = await prisma.sAMVisit.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            customerUsername: true,
            fullAddress: true,
            campaignData: {
              select: { company: true, name: true, phone: true, email: true }
            }
          }
        },
        samExecutive: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!visit) {
      return res.status(404).json({ message: 'Visit not found.' });
    }

    // Verify access
    if (userRole === 'SAM_EXECUTIVE' && visit.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized to view this visit.' });
    }

    res.json({ visit });
});

/**
 * Update visit details (before visit)
 */
export const updateVisit = asyncHandler(async function updateVisit(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { visitDate, visitType, purpose, location } = req.body;

    const existingVisit = await prisma.sAMVisit.findUnique({
      where: { id }
    });

    if (!existingVisit) {
      return res.status(404).json({ message: 'Visit not found.' });
    }

    if (existingVisit.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized to update this visit.' });
    }

    if (existingVisit.status === 'COMPLETED') {
      return res.status(400).json({ message: 'Cannot update a completed visit.' });
    }

    const visit = await prisma.sAMVisit.update({
      where: { id },
      data: {
        visitDate: visitDate ? new Date(visitDate) : undefined,
        visitType,
        purpose,
        location,
        status: visitDate ? 'RESCHEDULED' : undefined
      },
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true } }
          }
        }
      }
    });

    res.json({
      message: 'Visit updated successfully.',
      visit
    });
});

/**
 * Complete visit with outcome
 */
export const completeVisit = asyncHandler(async function completeVisit(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const {
      outcome,
      customerFeedback,
      issuesIdentified,
      actionRequired,
      nextVisitDate,
      nextVisitPurpose,
      attachments,
      notes
    } = req.body;

    const existingVisit = await prisma.sAMVisit.findUnique({
      where: { id }
    });

    if (!existingVisit) {
      return res.status(404).json({ message: 'Visit not found.' });
    }

    if (existingVisit.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized to complete this visit.' });
    }

    if (existingVisit.status === 'COMPLETED') {
      return res.status(400).json({ message: 'Visit is already completed.' });
    }

    const visit = await prisma.sAMVisit.update({
      where: { id },
      data: {
        outcome,
        customerFeedback,
        issuesIdentified,
        actionRequired,
        nextVisitDate: nextVisitDate ? new Date(nextVisitDate) : null,
        nextVisitPurpose,
        attachments,
        notes,
        status: 'COMPLETED',
        completedAt: new Date()
      },
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true, name: true } }
          }
        }
      }
    });

    res.json({
      message: 'Visit completed successfully.',
      visit
    });
});

/**
 * Cancel a visit
 */
export const cancelVisit = asyncHandler(async function cancelVisit(req, res) {
    const { id } = req.params;
    const userId = req.user.id;

    const existingVisit = await prisma.sAMVisit.findUnique({
      where: { id }
    });

    if (!existingVisit) {
      return res.status(404).json({ message: 'Visit not found.' });
    }

    if (existingVisit.samExecutiveId !== userId) {
      return res.status(403).json({ message: 'Not authorized to cancel this visit.' });
    }

    if (existingVisit.status === 'COMPLETED') {
      return res.status(400).json({ message: 'Cannot cancel a completed visit.' });
    }

    const visit = await prisma.sAMVisit.update({
      where: { id },
      data: { status: 'CANCELLED' }
    });

    res.json({
      message: 'Visit cancelled successfully.',
      visit
    });
});

/**
 * Get visit statistics for SAM Executive
 */
export const getVisitStats = asyncHandler(async function getVisitStats(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { executiveId } = req.query;

    const targetExecutiveId = userRole === 'SAM_EXECUTIVE' ? userId : (executiveId || null);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const endOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0);

    const baseWhere = targetExecutiveId ? { samExecutiveId: targetExecutiveId } : {};

    const [
      totalVisits,
      visitsThisMonth,
      visitsThisQuarter,
      completedVisits,
      pendingVisits,
      overdueVisits,
      visitsByType
    ] = await Promise.all([
      prisma.sAMVisit.count({ where: baseWhere }),
      prisma.sAMVisit.count({
        where: {
          ...baseWhere,
          visitDate: { gte: startOfMonth, lte: endOfMonth }
        }
      }),
      prisma.sAMVisit.count({
        where: {
          ...baseWhere,
          visitDate: { gte: startOfQuarter, lte: endOfQuarter }
        }
      }),
      prisma.sAMVisit.count({
        where: { ...baseWhere, status: 'COMPLETED' }
      }),
      prisma.sAMVisit.count({
        where: {
          ...baseWhere,
          status: 'SCHEDULED',
          visitDate: { gte: now }
        }
      }),
      prisma.sAMVisit.count({
        where: {
          ...baseWhere,
          status: 'SCHEDULED',
          visitDate: { lt: now }
        }
      }),
      prisma.sAMVisit.groupBy({
        by: ['visitType'],
        where: baseWhere,
        _count: { id: true }
      })
    ]);

    // Get upcoming visits
    const upcomingVisits = await prisma.sAMVisit.findMany({
      where: {
        ...baseWhere,
        status: { in: ['SCHEDULED', 'RESCHEDULED'] },
        visitDate: { gte: now }
      },
      select: {
        id: true,
        visitDate: true,
        visitType: true,
        purpose: true,
        customer: {
          select: {
            customerUsername: true,
            campaignData: { select: { company: true } }
          }
        }
      },
      orderBy: { visitDate: 'asc' },
      take: 5
    });

    res.json({
      totalVisits,
      visitsThisMonth,
      visitsThisQuarter,
      completedVisits,
      pendingVisits,
      overdueVisits,
      visitsByType: visitsByType.reduce((acc, item) => {
        acc[item.visitType] = item._count.id;
        return acc;
      }, {}),
      upcomingVisits
    });
});

/**
 * Get customers with contract renewal alerts
 */
export const getContractRenewalAlerts = asyncHandler(async function getContractRenewalAlerts(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { daysAhead = 30 } = req.query;

    const alertDate = new Date();
    alertDate.setDate(alertDate.getDate() + parseInt(daysAhead));

    let where = {
      contractEndDate: {
        lte: alertDate,
        gte: new Date()
      }
    };

    // SAM Executive sees only their customers
    if (userRole === 'SAM_EXECUTIVE') {
      where.samAssignment = {
        samExecutiveId: userId
      };
    }

    const customers = await prisma.lead.findMany({
      where,
      select: {
        id: true,
        customerUsername: true,
        circuitId: true,
        contractStartDate: true,
        contractEndDate: true,
        contractDurationMonths: true,
        actualPlanName: true,
        actualPlanPrice: true,
        campaignData: {
          select: { company: true, name: true, phone: true, email: true }
        },
        samAssignment: {
          select: {
            samExecutive: {
              select: { id: true, name: true }
            }
          }
        }
      },
      orderBy: { contractEndDate: 'asc' }
    });

    // Calculate days until expiry for each customer
    const customersWithDays = customers.map(customer => ({
      ...customer,
      daysUntilExpiry: Math.ceil((new Date(customer.contractEndDate) - new Date()) / (1000 * 60 * 60 * 24))
    }));

    res.json({
      alertCount: customers.length,
      customers: customersWithDays
    });
});

/**
 * Get customer payment summary (for SAM view)
 */
export const getCustomerPaymentSummary = asyncHandler(async function getCustomerPaymentSummary(req, res) {
    const { customerId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Verify access
    if (userRole === 'SAM_EXECUTIVE') {
      const assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId, samExecutiveId: userId }
      });
      if (!assignment) {
        return res.status(403).json({ message: 'Not authorized to view this customer.' });
      }
    }

    // Get all invoices for the customer
    const invoices = await prisma.invoice.findMany({
      where: { leadId: customerId },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        grandTotal: true,
        totalPaidAmount: true,
        remainingAmount: true,
        status: true
      },
      orderBy: { invoiceDate: 'desc' }
    });

    // Calculate aging buckets
    const now = new Date();
    const agingBuckets = {
      current: 0,      // Not yet due
      '1-30': 0,       // 1-30 days overdue
      '31-60': 0,      // 31-60 days overdue
      '61-90': 0,      // 61-90 days overdue
      '90+': 0         // 90+ days overdue
    };

    let totalOutstanding = 0;
    let totalPaid = 0;

    invoices.forEach(invoice => {
      const remaining = invoice.remainingAmount || (invoice.grandTotal - (invoice.totalPaidAmount || 0));

      if (remaining > 0) {
        totalOutstanding += remaining;

        if (invoice.status === 'PAID') return;

        const dueDate = new Date(invoice.dueDate);
        const daysOverdue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));

        if (daysOverdue <= 0) {
          agingBuckets.current += remaining;
        } else if (daysOverdue <= 30) {
          agingBuckets['1-30'] += remaining;
        } else if (daysOverdue <= 60) {
          agingBuckets['31-60'] += remaining;
        } else if (daysOverdue <= 90) {
          agingBuckets['61-90'] += remaining;
        } else {
          agingBuckets['90+'] += remaining;
        }
      }

      totalPaid += invoice.totalPaidAmount || 0;
    });

    res.json({
      totalInvoices: invoices.length,
      totalBilled: invoices.reduce((sum, inv) => sum + inv.grandTotal, 0),
      totalPaid,
      totalOutstanding,
      agingBuckets,
      recentInvoices: invoices.slice(0, 5)
    });
});

// ==================== COMMUNICATION HISTORY ====================

/**
 * Create a new customer communication
 */
export const createCommunication = asyncHandler(async function createCommunication(req, res) {
    const samExecutiveId = req.user.id;
    const userRole = req.user.role;
    const {
      customerId,
      communicationType,
      subject,
      content,
      channel,
      ticketNumber,
      isOutageRelated,
      etaRestoration,
      sentTo,
      ccTo,
      attachments
    } = req.body;

    // Verify access
    if (userRole === 'SAM_EXECUTIVE') {
      const assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId, samExecutiveId }
      });
      if (!assignment) {
        return res.status(403).json({ message: 'Not authorized to communicate with this customer.' });
      }
    }

    const communication = await prisma.customerCommunication.create({
      data: {
        customerId,
        samExecutiveId,
        communicationType: communicationType || 'GENERAL_UPDATE',
        subject,
        content,
        channel: channel || 'EMAIL',
        ticketNumber,
        isOutageRelated: isOutageRelated || false,
        etaRestoration: etaRestoration ? new Date(etaRestoration) : null,
        sentTo: sentTo || [],
        ccTo: ccTo || [],
        attachments,
        status: 'DRAFT'
      },
      include: {
        customer: {
          select: {
            customerUsername: true,
            campaignData: { select: { company: true } }
          }
        }
      }
    });

    res.status(201).json({
      message: 'Communication created successfully.',
      communication
    });
});

/**
 * Get communications for a customer
 */
export const getCommunications = asyncHandler(async function getCommunications(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { customerId, communicationType, isOutageRelated } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 50);

    const where = {};

    if (customerId) {
      where.customerId = customerId;

      // Verify access for SAM_EXECUTIVE
      if (userRole === 'SAM_EXECUTIVE') {
        const assignment = await prisma.sAMAssignment.findFirst({
          where: { customerId, samExecutiveId: userId }
        });
        if (!assignment) {
          return res.status(403).json({ message: 'Not authorized to view communications for this customer.' });
        }
      }
    } else if (userRole === 'SAM_EXECUTIVE') {
      // Only show communications for assigned customers
      const assignments = await prisma.sAMAssignment.findMany({
        where: { samExecutiveId: userId },
        select: { customerId: true }
      });
      where.customerId = { in: assignments.map(a => a.customerId) };
    }

    if (communicationType) {
      where.communicationType = communicationType;
    }

    if (isOutageRelated === 'true') {
      where.isOutageRelated = true;
    }

    const [communications, total] = await Promise.all([
      prisma.customerCommunication.findMany({
        where,
        select: {
          id: true,
          communicationType: true,
          subject: true,
          content: true,
          channel: true,
          ticketNumber: true,
          isOutageRelated: true,
          etaRestoration: true,
          sentTo: true,
          status: true,
          sentAt: true,
          createdAt: true,
          customer: {
            select: {
              id: true,
              customerUsername: true,
              campaignData: { select: { company: true, name: true } }
            }
          },
          samExecutive: {
            select: { id: true, name: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.customerCommunication.count({ where })
    ]);

    res.json({
      communications,
      total,
      page,
      limit
    });
});

/**
 * Get single communication by ID
 */
export const getCommunicationById = asyncHandler(async function getCommunicationById(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const communication = await prisma.customerCommunication.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            customerUsername: true,
            campaignData: { select: { company: true, name: true, phone: true, email: true } }
          }
        },
        samExecutive: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!communication) {
      return res.status(404).json({ message: 'Communication not found.' });
    }

    // Verify access
    if (userRole === 'SAM_EXECUTIVE') {
      const assignment = await prisma.sAMAssignment.findFirst({
        where: { customerId: communication.customerId, samExecutiveId: userId }
      });
      if (!assignment) {
        return res.status(403).json({ message: 'Not authorized to view this communication.' });
      }
    }

    res.json({ communication });
});

/**
 * Update communication (for drafts)
 */
export const updateCommunication = asyncHandler(async function updateCommunication(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const {
      subject,
      content,
      channel,
      ticketNumber,
      isOutageRelated,
      etaRestoration,
      sentTo,
      ccTo,
      attachments
    } = req.body;

    const existingComm = await prisma.customerCommunication.findUnique({
      where: { id }
    });

    if (!existingComm) {
      return res.status(404).json({ message: 'Communication not found.' });
    }

    const isManagerOrAdmin = ['SAM_HEAD', 'SUPER_ADMIN'].includes(req.user.role);
    if (existingComm.samExecutiveId !== userId && !isManagerOrAdmin) {
      return res.status(403).json({ message: 'Not authorized to update this communication.' });
    }

    if (existingComm.status === 'SENT') {
      return res.status(400).json({ message: 'Cannot update a sent communication.' });
    }

    const communication = await prisma.customerCommunication.update({
      where: { id },
      data: {
        subject,
        content,
        channel,
        ticketNumber,
        isOutageRelated,
        etaRestoration: etaRestoration ? new Date(etaRestoration) : undefined,
        sentTo,
        ccTo,
        attachments
      }
    });

    res.json({
      message: 'Communication updated successfully.',
      communication
    });
});

/**
 * Send communication (mark as sent and optionally send email)
 */
export const sendCommunication = asyncHandler(async function sendCommunication(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { sendEmail = false } = req.body;

    const communication = await prisma.customerCommunication.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            campaignData: { select: { company: true, name: true, email: true } }
          }
        },
        samExecutive: {
          select: { name: true, email: true }
        }
      }
    });

    if (!communication) {
      return res.status(404).json({ message: 'Communication not found.' });
    }

    const isManagerOrAdmin = ['SAM_HEAD', 'SUPER_ADMIN'].includes(req.user.role);
    if (communication.samExecutiveId !== userId && !isManagerOrAdmin) {
      return res.status(403).json({ message: 'Not authorized to send this communication.' });
    }

    if (communication.status === 'SENT') {
      return res.status(400).json({ message: 'Communication is already sent.' });
    }

    // If email channel and sendEmail is true, actually send the email
    if (sendEmail && communication.channel === 'EMAIL' && communication.sentTo.length > 0) {
      try {
        const resendClient = getResendClient();

        const emailOptions = {
          from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
          to: communication.sentTo,
          subject: communication.subject,
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
              <h2>${communication.subject}</h2>
              <div style="white-space: pre-line;">${communication.content}</div>
              ${communication.etaRestoration ? `<p><strong>ETA Restoration:</strong> ${new Date(communication.etaRestoration).toLocaleString()}</p>` : ''}
              ${communication.ticketNumber ? `<p><strong>Ticket #:</strong> ${communication.ticketNumber}</p>` : ''}
              <hr/>
              <p>Regards,<br/>${communication.samExecutive.name}</p>
            </div>
          `
        };

        if (communication.ccTo && communication.ccTo.length > 0) {
          emailOptions.cc = communication.ccTo;
        }

        await resendClient.emails.send(emailOptions);
      } catch (emailError) {
        console.error('Email send error:', emailError);
        // Continue with marking as sent even if email fails
      }
    }

    // Update communication status
    const updatedComm = await prisma.customerCommunication.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: new Date()
      }
    });

    res.json({
      message: 'Communication sent successfully.',
      communication: updatedComm
    });
});

/**
 * Delete a draft communication
 */
export const deleteCommunication = asyncHandler(async function deleteCommunication(req, res) {
    const { id } = req.params;
    const userId = req.user.id;

    const communication = await prisma.customerCommunication.findUnique({
      where: { id }
    });

    if (!communication) {
      return res.status(404).json({ message: 'Communication not found.' });
    }

    const isManagerOrAdmin = ['SAM_HEAD', 'SUPER_ADMIN'].includes(req.user.role);
    if (communication.samExecutiveId !== userId && !isManagerOrAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this communication.' });
    }

    if (communication.status === 'SENT') {
      return res.status(400).json({ message: 'Cannot delete a sent communication.' });
    }

    await prisma.customerCommunication.delete({
      where: { id }
    });

    res.json({ message: 'Communication deleted successfully.' });
});

/**
 * Get communication templates
 */
export const getCommunicationTemplates = asyncHandler(async function getCommunicationTemplates(req, res) {
    // Return predefined templates for common communication types
    const templates = [
      {
        type: 'INITIAL_OUTAGE',
        subject: 'Service Outage Notification - [Ticket #]',
        content: `Dear Customer,

We regret to inform you that we are currently experiencing a service outage affecting your connection.

Our technical team is actively working to resolve this issue. We will keep you updated on the progress.

Ticket Number: [TICKET_NUMBER]
Estimated Time of Restoration: [ETA]

We apologize for any inconvenience caused.

Regards,
Service Team`
      },
      {
        type: 'INTERIM_UPDATE',
        subject: 'Service Update - [Ticket #]',
        content: `Dear Customer,

This is an update regarding the ongoing service issue.

Status: [STATUS]
Current Progress: [PROGRESS]
New ETA: [ETA]

We appreciate your patience and will continue to keep you informed.

Regards,
Service Team`
      },
      {
        type: 'RESTORATION_CONFIRMED',
        subject: 'Service Restored - [Ticket #]',
        content: `Dear Customer,

We are pleased to inform you that your service has been restored.

Resolution: [RESOLUTION_DETAILS]
Ticket Number: [TICKET_NUMBER]

If you experience any further issues, please contact us immediately.

Thank you for your patience.

Regards,
Service Team`
      },
      {
        type: 'ETR_UPDATE',
        subject: 'Estimated Time of Restoration Update - [Ticket #]',
        content: `Dear Customer,

We have an update on the estimated time of restoration for your service.

Previous ETA: [OLD_ETA]
New ETA: [NEW_ETA]
Reason: [REASON]

We apologize for any inconvenience and thank you for your patience.

Regards,
Service Team`
      },
      {
        type: 'CONTRACT_RENEWAL',
        subject: 'Contract Renewal Reminder',
        content: `Dear Customer,

Your service contract is due for renewal on [DATE].

Current Plan: [PLAN_NAME]
Monthly Charge: [AMOUNT]

Please contact us at your earliest convenience to discuss renewal options.

Regards,
Service Team`
      }
    ];

    res.json({ templates });
});

// ==================== BUSINESS IMPACT ====================

export const getBusinessImpact = asyncHandler(async function getBusinessImpact(req, res) {
    const { fy, startDate, endDate, samExecutiveId, customerType, page = 1, limit = 20 } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    // Determine date boundaries
    const now = new Date();
    let fyStart, fyEnd;

    if (startDate && endDate) {
      // Custom date range
      fyStart = new Date(startDate);
      fyEnd = new Date(endDate);
      fyEnd.setHours(23, 59, 59, 999);
    } else if (fy) {
      const [startYear] = fy.split('-').map(Number);
      fyStart = new Date(startYear, 3, 1); // April 1
      fyEnd = new Date(startYear + 1, 2, 31, 23, 59, 59, 999); // March 31
    } else {
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();
      const fyStartYear = currentMonth < 3 ? currentYear - 1 : currentYear;
      fyStart = new Date(fyStartYear, 3, 1);
      fyEnd = new Date(fyStartYear + 1, 2, 31, 23, 59, 59, 999);
    }

    // Build where clause — show ALL SAM-assigned customers with originalArcAmount
    // Date range only filters plan change history and historical SAM attribution, not the customers themselves
    const where = {
      samAssignment: { isNot: null },
      originalArcAmount: { not: null }
    };

    // Role-based filtering
    // For SAM_EXECUTIVE or specific executive filter, include customers that were
    // historically assigned to them during the query period (not just currently assigned)
    const targetExecutiveId = (userRole === 'SAM_EXECUTIVE' || userRole === 'SAM') ? userId : samExecutiveId;

    if (targetExecutiveId) {
      // Find customer IDs historically assigned to this executive during the period
      const historicalAssignments = await prisma.sAMAssignmentHistory.findMany({
        where: {
          samExecutiveId: targetExecutiveId,
          assignedAt: { lte: fyEnd },
          removedAt: { gte: fyStart }
        },
        select: { customerId: true }
      });
      const historicalCustomerIds = [...new Set(historicalAssignments.map(h => h.customerId))];

      // Include customers currently assigned OR historically assigned during the period
      where.AND = [
        { originalArcAmount: { not: null } },
        {
          OR: [
            { samAssignment: { samExecutiveId: targetExecutiveId } },
            ...(historicalCustomerIds.length > 0 ? [{ id: { in: historicalCustomerIds } }] : [])
          ]
        }
      ];
      // Remove top-level duplicates now that they're in AND
      delete where.samAssignment;
      delete where.originalArcAmount;
    }

    // Get all matching customers
    const customers = await prisma.lead.findMany({
      where,
      select: {
        id: true,
        customerUsername: true,
        customerCreatedAt: true,
        actualPlanStartDate: true,
        arcAmount: true,
        originalArcAmount: true,
        actualPlanIsActive: true,
        actualPlanName: true,
        actualPlanBandwidth: true,
        campaignData: {
          select: { company: true, name: true }
        },
        samAssignment: {
          select: {
            assignedAt: true,
            samExecutive: {
              select: { id: true, name: true }
            }
          }
        },
        planUpgrades: {
          where: {
            createdAt: { gte: fyStart, lte: fyEnd }
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            actionType: true,
            previousArc: true,
            newArc: true,
            additionalArc: true,
            degradeArc: true,
            previousPlanName: true,
            newPlanName: true,
            upgradeDate: true,
            createdAt: true
          }
        }
      }
    });

    // Fetch assignment history for date-aware SAM attribution
    // History records have assignedAt (when assigned) and removedAt (when reassigned away)
    const customerIds = customers.map(c => c.id);
    const assignmentHistory = await prisma.sAMAssignmentHistory.findMany({
      where: {
        customerId: { in: customerIds },
        // Was active during the query period: assigned before period ends AND removed after period starts (or still active during)
        assignedAt: { lte: fyEnd },
        removedAt: { gte: fyStart }
      },
      select: {
        customerId: true,
        samExecutiveId: true,
        assignedAt: true,
        removedAt: true,
        originalArc: true,
        finalArc: true,
        samExecutive: { select: { id: true, name: true } }
      }
    });

    // Build lookup: customerId -> array of historical assignments overlapping the date range
    const historyByCustomer = new Map();
    assignmentHistory.forEach(h => {
      if (!historyByCustomer.has(h.customerId)) {
        historyByCustomer.set(h.customerId, []);
      }
      historyByCustomer.get(h.customerId).push(h);
    });

    /**
     * Determine which SAM executive should be attributed for a customer in the query period.
     * If the current assignment started AFTER the query period ends, use the historical
     * assignment that was active during the period. Otherwise, use current assignment.
     * Returns { id, name, historicalOriginalArc, historicalFinalArc } — historical values
     * are set only when attributing to a past executive (null means use current lead values).
     */
    const resolveExecutive = (customer) => {
      const currentAssignment = customer.samAssignment;
      const currentAssignedAt = currentAssignment?.assignedAt;

      // If current assignment started within or before the query period, use it
      if (currentAssignedAt && currentAssignedAt <= fyEnd) {
        return {
          id: currentAssignment.samExecutive?.id,
          name: currentAssignment.samExecutive?.name || 'Unassigned',
          historicalOriginalArc: null,
          historicalFinalArc: null
        };
      }

      // Otherwise, look for a historical assignment that overlaps the query period
      const history = historyByCustomer.get(customer.id);
      if (history && history.length > 0) {
        // Sort by removedAt desc to get the most recent one in the period
        const sorted = history.sort((a, b) => new Date(b.removedAt) - new Date(a.removedAt));
        return {
          id: sorted[0].samExecutive?.id,
          name: sorted[0].samExecutive?.name || 'Unassigned',
          historicalOriginalArc: sorted[0].originalArc,
          historicalFinalArc: sorted[0].finalArc
        };
      }

      // Fallback to current assignment
      return {
        id: currentAssignment?.samExecutive?.id,
        name: currentAssignment?.samExecutive?.name || 'Unassigned',
        historicalOriginalArc: null,
        historicalFinalArc: null
      };
    };

    // Process each customer — only include if their SAM assignment was active during the query period
    const processedCustomers = [];
    for (const customer of customers) {
      const executive = resolveExecutive(customer);
      const currentAssignedAt = customer.samAssignment?.assignedAt;

      // Skip customer if their assignment didn't exist during the query period
      // Current assignment must have started before period ends, OR historical assignment must overlap
      const hasCurrentDuringPeriod = currentAssignedAt && currentAssignedAt <= fyEnd;
      const hasHistoricalDuringPeriod = historyByCustomer.has(customer.id);
      if (!hasCurrentDuringPeriod && !hasHistoricalDuringPeriod) continue;

      // Use historical ARC values when viewing a past executive's tenure
      // Otherwise use current lead values
      const assignedArc = executive.historicalOriginalArc != null ? executive.historicalOriginalArc : (customer.originalArcAmount || 0);
      const finalArc = executive.historicalFinalArc != null ? executive.historicalFinalArc : (customer.actualPlanIsActive ? (customer.arcAmount || 0) : 0);
      const businessImpact = finalArc - assignedArc;
      const activationDate = customer.actualPlanStartDate || customer.customerCreatedAt;
      const isNew = activationDate && activationDate >= fyStart;

      processedCustomers.push({
        leadId: customer.id,
        companyName: customer.campaignData?.company || 'N/A',
        contactName: customer.campaignData?.name || 'N/A',
        customerUsername: customer.customerUsername,
        customerType: isNew ? 'NEW' : 'EXISTING',
        originalArc: assignedArc,
        currentArc: assignedArc,
        finalArc,
        businessImpact,
        isChurned: !customer.actualPlanIsActive,
        currentPlanName: customer.actualPlanName,
        currentBandwidth: customer.actualPlanBandwidth,
        samExecutiveId: executive.id,
        samExecutiveName: executive.name,
        planChanges: customer.planUpgrades.map(pu => ({
          id: pu.id,
          date: pu.upgradeDate || pu.createdAt,
          type: pu.actionType,
          previousArc: pu.previousArc,
          newArc: pu.newArc,
          change: pu.actionType === 'UPGRADE' ? pu.additionalArc : -(pu.degradeArc || 0),  // DOWNGRADE and RATE_REVISION both use degradeArc
          previousPlanName: pu.previousPlanName,
          newPlanName: pu.newPlanName
        }))
      });
    }

    // Filter by customer type if specified
    const filteredCustomers = customerType
      ? processedCustomers.filter(c => c.customerType === customerType)
      : processedCustomers;

    // Build executive breakdown
    const executiveMap = new Map();
    filteredCustomers.forEach(c => {
      const key = c.samExecutiveId || 'unassigned';
      if (!executiveMap.has(key)) {
        executiveMap.set(key, {
          executiveId: c.samExecutiveId,
          executiveName: c.samExecutiveName,
          originalArc: 0,
          currentArc: 0,
          finalArc: 0,
          businessImpact: 0,
          totalCustomers: 0,
          newCustomers: 0,
          existingCustomers: 0
        });
      }
      const exec = executiveMap.get(key);
      exec.originalArc += c.originalArc;
      exec.currentArc += c.currentArc;
      exec.finalArc += c.finalArc;
      exec.businessImpact += c.businessImpact;
      exec.totalCustomers++;
      if (c.customerType === 'NEW') exec.newCustomers++;
      else exec.existingCustomers++;
    });

    const executiveBreakdown = Array.from(executiveMap.values())
      .sort((a, b) => b.businessImpact - a.businessImpact);

    // Summary
    const summary = {
      totalOriginalArc: filteredCustomers.reduce((sum, c) => sum + c.originalArc, 0),
      totalCurrentArc: filteredCustomers.reduce((sum, c) => sum + c.currentArc, 0),
      totalFinalArc: filteredCustomers.reduce((sum, c) => sum + c.finalArc, 0),
      totalBusinessImpact: filteredCustomers.reduce((sum, c) => sum + c.businessImpact, 0),
      totalCustomers: filteredCustomers.length,
      newCustomers: filteredCustomers.filter(c => c.customerType === 'NEW').length,
      existingCustomers: filteredCustomers.filter(c => c.customerType === 'EXISTING').length
    };

    // Paginate customers (in-memory)
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const startIdx = (pageNum - 1) * limitNum;
    const paginatedCustomers = filteredCustomers
      .sort((a, b) => b.businessImpact - a.businessImpact)
      .slice(startIdx, startIdx + limitNum);

    // Build reassignment history — aggregate past executives who had customers reassigned away
    // Group by executive, sum their originalArc/finalArc, compute business impact at time of departure
    const reassignmentMap = new Map();
    assignmentHistory.forEach(h => {
      const key = h.samExecutiveId;
      if (!reassignmentMap.has(key)) {
        reassignmentMap.set(key, {
          executiveId: h.samExecutive?.id,
          executiveName: h.samExecutive?.name || 'Unknown',
          originalArc: 0,
          finalArc: 0,
          businessImpact: 0,
          customers: 0,
          reassignedAt: h.removedAt
        });
      }
      const entry = reassignmentMap.get(key);
      const oArc = h.originalArc || 0;
      const fArc = h.finalArc || 0;
      entry.originalArc += oArc;
      entry.finalArc += fArc;
      entry.businessImpact += (fArc - oArc);
      entry.customers++;
      // Use most recent reassignment date
      if (h.removedAt > entry.reassignedAt) entry.reassignedAt = h.removedAt;
    });
    // Only include executives who are NOT in the current executiveBreakdown (they left / were reassigned away)
    const activeExecIds = new Set(executiveBreakdown.map(e => e.executiveId));
    const reassignmentHistory = Array.from(reassignmentMap.values())
      .filter(r => !activeExecIds.has(r.executiveId))
      .sort((a, b) => new Date(b.reassignedAt) - new Date(a.reassignedAt));

    res.json({
      summary,
      executiveBreakdown,
      reassignmentHistory,
      customers: paginatedCustomers,
      typeCounts: {
        new: processedCustomers.filter(c => c.customerType === 'NEW').length,
        existing: processedCustomers.filter(c => c.customerType === 'EXISTING').length
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: filteredCustomers.length,
        totalPages: Math.ceil(filteredCustomers.length / limitNum)
      }
    });
});
