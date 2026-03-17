import bcrypt from 'bcryptjs';
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';

export const getUsers = asyncHandler(async function getUsers(req, res) {
  const isTL = req.user.role === 'BDM_TEAM_LEADER';

  // Team Leader only sees BDMs assigned to them
  const whereClause = isTL
    ? { role: 'BDM', teamLeaderId: req.user.id }
    : {};

  const users = await prisma.user.findMany({
    where: whereClause,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      teamLeaderId: true,
      teamLeader: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.json({ users });
});

export const getUserById = asyncHandler(async function getUserById(req, res) {
  const { id } = req.params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      assignedCampaigns: {
        include: {
          campaign: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }
    }
  });

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  res.json({ user });
});

export const createUser = asyncHandler(async function createUser(req, res) {
  const { email, password, name, role, teamLeaderId } = req.body;
  const isTL = req.user.role === 'BDM_TEAM_LEADER';

  if (!email || !password || !name) {
    return res.status(400).json({ message: 'Email, password, and name are required.' });
  }

  // Team Leader can only create BDM users
  if (isTL && role && role !== 'BDM') {
    return res.status(403).json({ message: 'You can only create BDM users.' });
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true }
  });

  if (existingUser) {
    return res.status(400).json({ message: 'User with this email already exists.' });
  }

  // For Team Leader, auto-assign themselves; otherwise validate provided teamLeaderId
  const effectiveTeamLeaderId = isTL ? req.user.id : teamLeaderId || null;
  if (effectiveTeamLeaderId && !isTL) {
    const tl = await prisma.user.findUnique({ where: { id: effectiveTeamLeaderId }, select: { role: true, isActive: true } });
    if (!tl || tl.role !== 'BDM_TEAM_LEADER' || !tl.isActive) {
      return res.status(400).json({ message: 'Invalid team leader.' });
    }
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      password: hashedPassword,
      name,
      role: isTL ? 'BDM' : (role || 'ISR'),
      ...(effectiveTeamLeaderId && { teamLeaderId: effectiveTeamLeaderId })
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

  res.status(201).json({ message: 'User created successfully.', user });
});

export const updateUser = asyncHandler(async function updateUser(req, res) {
  const { id } = req.params;
  const { email, password, name, role, isActive, teamLeaderId } = req.body;
  const isTL = req.user.role === 'BDM_TEAM_LEADER';

  const existingUser = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, teamLeaderId: true }
  });

  if (!existingUser) {
    return res.status(404).json({ message: 'User not found.' });
  }

  // Team Leader can only edit BDMs assigned to them
  if (isTL) {
    if (existingUser.role !== 'BDM' || existingUser.teamLeaderId !== req.user.id) {
      return res.status(403).json({ message: 'You can only edit BDMs in your team.' });
    }
    // TL cannot change role or team leader assignment
    if (role && role !== 'BDM') {
      return res.status(403).json({ message: 'You can only manage BDM users.' });
    }
  }

  if (email && email.toLowerCase() !== existingUser.email) {
    const emailExists = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true }
    });

    if (emailExists) {
      return res.status(400).json({ message: 'Email already in use.' });
    }
  }

  // Validate teamLeaderId if provided (only admins can change team leader)
  if (teamLeaderId && !isTL) {
    const tl = await prisma.user.findUnique({ where: { id: teamLeaderId }, select: { role: true, isActive: true } });
    if (!tl || tl.role !== 'BDM_TEAM_LEADER' || !tl.isActive) {
      return res.status(400).json({ message: 'Invalid team leader.' });
    }
  }

  const updateData = {};
  if (email) updateData.email = email.toLowerCase();
  if (name) updateData.name = name;
  if (role && !isTL) updateData.role = role;
  if (typeof isActive === 'boolean') updateData.isActive = isActive;
  if (password) updateData.password = await bcrypt.hash(password, 10);
  if (teamLeaderId !== undefined && !isTL) updateData.teamLeaderId = teamLeaderId || null;

  const user = await prisma.user.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true
    }
  });

  res.json({ message: 'User updated successfully.', user });
});

export const deleteUser = asyncHandler(async function deleteUser(req, res) {
  const { id } = req.params;

  const existingUser = await prisma.user.findUnique({
    where: { id },
    select: { id: true }
  });

  if (!existingUser) {
    return res.status(404).json({ message: 'User not found.' });
  }

  if (req.user.id === id) {
    return res.status(400).json({ message: 'Cannot delete your own account.' });
  }

  await prisma.user.delete({
    where: { id }
  });

  res.json({ message: 'User deleted successfully.' });
});

// Get users by role (for admin dropdowns)
export const getUsersByRole = asyncHandler(async function getUsersByRole(req, res) {
  const { role } = req.query;

  const whereClause = {
    isActive: true
  };

  // Only exclude SUPER_ADMIN when fetching ALL roles
  if (role && role !== 'ALL') {
    whereClause.role = role;
  } else {
    whereClause.role = { not: 'SUPER_ADMIN' };
  }

  const users = await prisma.user.findMany({
    where: whereClause,
    select: {
      id: true,
      name: true,
      email: true,
      role: true
    },
    orderBy: { name: 'asc' }
  });

  res.json({ users });
});

// Get ISR users for assignment (accessible by BDM and SAM)
export const getISRUsersForAssignment = asyncHandler(async function getISRUsersForAssignment(req, res) {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      role: 'ISR'
    },
    select: {
      id: true,
      name: true,
      email: true
    },
    orderBy: { name: 'asc' }
  });

  res.json({ users });
});

// Get dashboard stats for a specific user (admin only)
export const getUserDashboardStats = asyncHandler(async function getUserDashboardStats(req, res) {
  const { userId } = req.params;
  const { period = 'last7days' } = req.query;

  // Verify the user exists
  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true }
  });

  if (!targetUser) {
    return res.status(404).json({ message: 'User not found.' });
  }

  // Get start of today
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get all campaigns assigned to this user
  const assignments = await prisma.campaignAssignment.findMany({
    where: { userId },
    select: { campaignId: true }
  });

  const campaignIds = assignments.map(a => a.campaignId);

  if (campaignIds.length === 0) {
    return res.json({
      user: targetUser,
      stats: {
        totalAssigned: 0,
        workingData: 0,
        pendingData: 0,
        convertedToLead: 0
      },
      todayCallStats: {
        callsMade: 0,
        convertedToLead: 0,
        outcomes: {
          interested: 0,
          notInterested: 0,
          notReachable: 0,
          callLater: 0,
          wrongNumber: 0
        }
      },
      statusDistribution: [],
      recentActivity: [],
      callStats: {
        totalCalls: 0,
        todayCalls: 0,
        avgCallDuration: 0
      },
      weeklyProgress: [],
      followUpSchedule: {
        overdue: 0,
        upcoming: []
      },
      period
    });
  }

  // For ISR users, only show data assigned to them or unassigned
  // For BDM users, show leads assigned to them
  const whereClause = targetUser.role === 'ISR' ? {
    campaignId: { in: campaignIds },
    OR: [
      { assignedToId: null },
      { assignedToId: userId }
    ]
  } : {
    campaignId: { in: campaignIds }
  };

  // Total stats
  const [totalAssigned, workingData, pendingData, convertedToLead] = await Promise.all([
    prisma.campaignData.count({ where: whereClause }),
    prisma.campaignData.count({ where: { ...whereClause, status: { not: 'NEW' } } }),
    prisma.campaignData.count({ where: { ...whereClause, status: 'NEW' } }),
    prisma.campaignData.count({ where: { ...whereClause, status: 'INTERESTED' } })
  ]);

  // Today's call stats with outcomes
  const todayCallLogsDetailed = await prisma.callLog.findMany({
    where: {
      userId,
      createdAt: { gte: today },
      campaignData: { campaignId: { in: campaignIds } }
    },
    include: {
      campaignData: {
        include: {
          lead: { select: { id: true } }
        }
      }
    }
  });

  const todayCallsMade = todayCallLogsDetailed.length;
  const todayConvertedToLead = todayCallLogsDetailed.filter(log => log.campaignData?.lead !== null).length;

  // Count today's call outcomes
  const todayOutcomes = {
    interested: todayCallLogsDetailed.filter(log => log.status === 'INTERESTED').length,
    notInterested: todayCallLogsDetailed.filter(log => log.status === 'NOT_INTERESTED').length,
    notReachable: todayCallLogsDetailed.filter(log => log.status === 'NOT_REACHABLE').length,
    callLater: todayCallLogsDetailed.filter(log => log.status === 'CALL_LATER').length,
    wrongNumber: todayCallLogsDetailed.filter(log => log.status === 'WRONG_NUMBER').length
  };

  // Status distribution
  const statusCounts = await prisma.campaignData.groupBy({
    by: ['status'],
    where: whereClause,
    _count: { status: true }
  });

  const statusDistribution = statusCounts.map(s => ({
    status: s.status,
    count: s._count.status
  }));

  // Recent activity
  const recentActivity = await prisma.campaignData.findMany({
    where: { ...whereClause, status: { not: 'NEW' } },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      name: true,
      firstName: true,
      lastName: true,
      company: true,
      status: true,
      updatedAt: true
    }
  });

  // Call stats
  const callLogs = await prisma.callLog.findMany({
    where: {
      userId,
      campaignData: { campaignId: { in: campaignIds } }
    },
    select: { duration: true, createdAt: true }
  });

  const todayCallLogs = callLogs.filter(c => new Date(c.createdAt) >= today);
  const totalDuration = callLogs.reduce((sum, c) => sum + (c.duration || 0), 0);

  // Progress based on period - with Total, Working, Converted for each period
  const progressData = [];

  if (period === 'yearly') {
    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);

      const periodWhere = {
        ...whereClause,
        updatedAt: { gte: monthStart, lt: monthEnd }
      };

      const [total, working, converted] = await Promise.all([
        prisma.campaignData.count({ where: periodWhere }),
        prisma.campaignData.count({ where: { ...periodWhere, status: { not: 'NEW' } } }),
        prisma.campaignData.count({ where: { ...periodWhere, status: 'INTERESTED' } })
      ]);

      const monthLabel = `${monthStart.toLocaleDateString('en-US', { month: 'short' })}-${monthStart.getFullYear()}`;

      progressData.push({
        date: monthStart.toISOString().split('T')[0],
        label: monthLabel,
        total,
        working,
        converted
      });
    }
  } else if (period === 'monthly') {
    for (let i = 3; i >= 0; i--) {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - (i * 7) - 6);
      weekStart.setHours(0, 0, 0, 0);

      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const periodWhere = {
        ...whereClause,
        updatedAt: { gte: weekStart, lt: weekEnd }
      };

      const [total, working, converted] = await Promise.all([
        prisma.campaignData.count({ where: periodWhere }),
        prisma.campaignData.count({ where: { ...periodWhere, status: { not: 'NEW' } } }),
        prisma.campaignData.count({ where: { ...periodWhere, status: 'INTERESTED' } })
      ]);

      progressData.push({
        date: weekStart.toISOString().split('T')[0],
        label: `Week ${4 - i}`,
        total,
        working,
        converted
      });
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const periodWhere = {
        ...whereClause,
        updatedAt: { gte: date, lt: nextDate }
      };

      const [total, working, converted] = await Promise.all([
        prisma.campaignData.count({ where: periodWhere }),
        prisma.campaignData.count({ where: { ...periodWhere, status: { not: 'NEW' } } }),
        prisma.campaignData.count({ where: { ...periodWhere, status: 'INTERESTED' } })
      ]);

      progressData.push({
        date: date.toISOString().split('T')[0],
        label: date.toLocaleDateString('en-US', { weekday: 'short' }),
        total,
        working,
        converted
      });
    }
  }

  // Get follow-up counts for next 7 days
  const followUpCounts = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = new Date();
    dayStart.setDate(dayStart.getDate() + i);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const count = await prisma.campaignData.count({
      where: {
        ...whereClause,
        status: 'CALL_LATER',
        callLaterAt: {
          gte: dayStart,
          lt: dayEnd
        }
      }
    });

    followUpCounts.push({
      date: dayStart.toISOString().split('T')[0],
      day: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      count
    });
  }

  // Get overdue follow-ups count
  const overdueCount = await prisma.campaignData.count({
    where: {
      ...whereClause,
      status: 'CALL_LATER',
      callLaterAt: {
        lt: today
      }
    }
  });

  res.json({
    user: targetUser,
    stats: {
      totalAssigned,
      workingData,
      pendingData,
      convertedToLead
    },
    todayCallStats: {
      callsMade: todayCallsMade,
      convertedToLead: todayConvertedToLead,
      outcomes: todayOutcomes
    },
    statusDistribution,
    recentActivity: recentActivity.map(r => ({
      ...r,
      name: r.name || `${r.firstName || ''} ${r.lastName || ''}`.trim() || 'Unknown'
    })),
    callStats: {
      totalCalls: callLogs.length,
      todayCalls: todayCallLogs.length,
      avgCallDuration: callLogs.length > 0 ? Math.round(totalDuration / callLogs.length) : 0
    },
    weeklyProgress: progressData,
    followUpSchedule: {
      overdue: overdueCount,
      upcoming: followUpCounts
    },
    period
  });
});

// Get sidebar counts for current user based on role
export const getSidebarCounts = asyncHandler(async function getSidebarCounts(req, res) {
  const userId = req.user.id;
  const userRole = req.user.role;

  // Calculate end of today
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  let counts = {};

  switch (userRole) {
    case 'ISR': {
      // ISR counts: follow-ups, calling queue, retry queue
      const [followUps, callingQueue, retryQueue] = await Promise.all([
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: 'CALL_LATER',
            callLaterAt: { not: null, lte: endOfToday }
          }
        }),
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: 'NEW'
          }
        }),
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: { in: ['RINGING_NOT_PICKED', 'NOT_REACHABLE'] },
            lead: null // Not converted to lead
          }
        })
      ]);
      counts = { followUps, callingQueue, retryQueue };
      break;
    }

    case 'SAM': {
      // SAM counts: follow-ups, calling queue, retry queue
      const [followUps, callingQueue, retryQueue] = await Promise.all([
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: 'CALL_LATER',
            callLaterAt: { not: null, lte: endOfToday }
          }
        }),
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: 'NEW'
          }
        }),
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: { in: ['RINGING_NOT_PICKED', 'NOT_REACHABLE'] },
            lead: null // Not converted to lead
          }
        })
      ]);
      counts = { followUps, callingQueue, retryQueue };
      break;
    }

    case 'BDM': {
      // BDM counts: queue, calling queue, retry queue, meetings, follow-ups, delivery completed, lead pipeline
      const [queue, callingQueue, retryQueue, meetings, followUps, deliveryCompleted, leadPipeline] = await Promise.all([
        prisma.lead.count({
          where: { assignedToId: userId, status: 'NEW' }
        }),
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: 'NEW',
            campaign: { status: 'ACTIVE' }
          }
        }),
        prisma.campaignData.count({
          where: {
            assignedToId: userId,
            status: { in: ['RINGING_NOT_PICKED', 'NOT_REACHABLE'] },
            lead: null
          }
        }),
        prisma.lead.count({
          where: {
            assignedToId: userId,
            meetingDate: { not: null, lte: endOfToday },
            status: 'MEETING_SCHEDULED'
          }
        }),
        prisma.lead.count({
          where: {
            assignedToId: userId,
            status: 'FOLLOW_UP',
            callLaterAt: { not: null, lte: endOfToday }
          }
        }),
        prisma.lead.count({
          where: {
            assignedToId: userId,
            deliveryStatus: 'COMPLETED',
            deliveryCompletedViewedAt: null // Only count unviewed completed deliveries
          }
        }),
        prisma.lead.count({
          where: { assignedToId: userId, status: 'FEASIBLE', pushedToInstallationAt: null }
        })
      ]);
      counts = { queue, callingQueue, retryQueue, meetings, followUps, deliveryCompleted, leadPipeline };
      break;
    }

    case 'BDM_TEAM_LEADER': {
      // Team leader counts: only their own assigned leads
      const [queue, meetings, followUps] = await Promise.all([
        prisma.lead.count({
          where: { assignedToId: userId, status: 'NEW' }
        }),
        prisma.lead.count({
          where: {
            assignedToId: userId,
            meetingDate: { not: null, lte: endOfToday },
            status: 'MEETING_SCHEDULED'
          }
        }),
        prisma.lead.count({
          where: {
            assignedToId: userId,
            status: 'FOLLOW_UP',
            callLaterAt: { not: null, lte: endOfToday }
          }
        })
      ]);
      counts = { queue, meetings, followUps };
      break;
    }

    case 'FEASIBILITY_TEAM': {
      // Feasibility Team counts: pending reviews + vendor docs pending upload + complaints assigned
      const [pending, vendorDocsPending, complaintsAssigned] = await Promise.all([
        prisma.lead.count({
          where: {
            feasibilityAssignedToId: userId,
            feasibilityReviewedAt: null,
            status: 'QUALIFIED'
          }
        }),
        prisma.vendor.count({
          where: {
            createdById: userId,
            approvalStatus: { in: ['PENDING_ACCOUNTS', 'APPROVED'] },
            docsStatus: { in: ['PENDING', 'REJECTED'] }
          }
        }),
        prisma.complaint.count({
          where: {
            assignments: { some: { userId, isActive: true } },
            status: 'OPEN'
          }
        })
      ]);
      counts = { pending, vendorDocsPending, complaintsAssigned };
      break;
    }

    case 'OPS_TEAM': {
      // OPS Team counts: pending quotation approvals
      const pending = await prisma.lead.count({
        where: {
          opsApprovalStatus: 'PENDING',
          status: 'FEASIBLE'
        }
      });
      counts = { pending };
      break;
    }

    case 'DOCS_TEAM': {
      // Docs Team counts: pending verifications (only OPS approved) + service order docs review
      const [pending, docsOrderReviewPending] = await Promise.all([
        prisma.lead.count({
          where: {
            sharedVia: { contains: 'docs_verification' },
            opsApprovalStatus: 'APPROVED',
            docsVerifiedAt: null
          }
        }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_DOCS_REVIEW', orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] } }
        })
      ]);
      counts = { pending, docsOrderReviewPending };
      break;
    }

    case 'ACCOUNTS_TEAM': {
      // Accounts Team counts: pending verifications, demo plan pending, create plan pending, vendor approval, vendor docs to verify, order requests, complaints assigned
      const [pending, demoPlanPending, createPlanPending, vendorsPendingAccounts, vendorDocsToVerify, orderRequestsPending, complaintsAssigned] = await Promise.all([
        prisma.lead.count({
          where: {
            docsVerifiedAt: { not: null },
            docsRejectedReason: null,
            accountsVerifiedAt: null
          }
        }),
        prisma.lead.count({
          where: {
            deliveryStatus: 'DEMO_PLAN_PENDING'
          }
        }),
        prisma.lead.count({
          where: {
            deliveryStatus: 'COMPLETED',
            customerAcceptanceStatus: 'ACCEPTED',
            actualPlanCreatedAt: null
          }
        }),
        prisma.vendor.count({ where: { approvalStatus: 'PENDING_ACCOUNTS' } }),
        prisma.vendor.count({ where: { docsStatus: 'UPLOADED' } }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_ACCOUNTS', orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] } }
        }),
        prisma.complaint.count({
          where: {
            assignments: { some: { userId, isActive: true } },
            status: 'OPEN'
          }
        })
      ]);
      counts = { pending, demoPlanPending, createPlanPending, vendorsPendingAccounts, vendorDocsToVerify, orderRequestsPending, complaintsAssigned };
      break;
    }

    case 'DELIVERY_TEAM': {
      // Delivery Team counts: pending deliveries (leads pushed to installation)
      const deliveryPending = await prisma.lead.count({
        where: {
          pushedToInstallationAt: { not: null },
          OR: [
            { deliveryStatus: null },
            { deliveryStatus: 'PENDING' }
          ]
        }
      });
      counts = { deliveryPending };
      break;
    }

    case 'STORE_MANAGER': {
      // Store Manager counts: approved delivery requests awaiting assignment
      const storeRequests = await prisma.deliveryRequest.count({
        where: { status: 'APPROVED' }
      });
      counts = { storeRequests };
      break;
    }

    case 'AREA_HEAD': {
      // Area Head counts: delivery requests pending their approval
      const deliveryRequestPending = await prisma.deliveryRequest.count({
        where: { status: 'PENDING_APPROVAL' }
      });
      counts = { deliveryRequestPending };
      break;
    }

    case 'NOC': {
      // NOC Team counts: leads pushed to NOC and customer accounts created
      // First get all lead IDs that have been pushed to NOC
      const nocDeliveryRequests = await prisma.deliveryRequest.findMany({
        where: { pushedToNocAt: { not: null } },
        select: { leadId: true }
      });
      const nocLeadIds = nocDeliveryRequests.map(dr => dr.leadId);

      if (nocLeadIds.length === 0) {
        counts = { nocPending: 0, nocUserCreated: 0 };
      } else {
        const [nocPending, nocUserCreated] = await Promise.all([
          // Pending: pushed to NOC but no customer user created
          prisma.lead.count({
            where: {
              id: { in: nocLeadIds },
              customerUserId: null
            }
          }),
          // User Created: all leads where customer user has been created (cumulative)
          prisma.lead.count({
            where: {
              id: { in: nocLeadIds },
              customerUserId: { not: null }
            }
          })
        ]);
        counts = { nocPending, nocUserCreated };
      }

      // Add service order NOC queue count
      const nocOrdersPending = await prisma.serviceOrder.count({
        where: { status: 'PENDING_NOC', orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] } }
      });
      counts.nocOrdersPending = nocOrdersPending;

      // Add complaint counts + customer requests to NOC
      const [nocComplaintCount, customerRequestsPending] = await Promise.all([
        prisma.complaint.count({
          where: {
            assignments: { some: { userId, isActive: true } },
            status: 'OPEN',
          }
        }),
        prisma.customerComplaintRequest.count({
          where: { status: 'PENDING' }
        })
      ]);
      counts.complaintsAssigned = nocComplaintCount;
      counts.customerRequestsPending = customerRequestsPending;

      break;
    }

    case 'SUPPORT_TEAM': {
      const [complaintsAssigned, complaintsCreated] = await Promise.all([
        prisma.complaint.count({
          where: {
            assignments: { some: { userId, isActive: true } },
            status: 'OPEN',
          }
        }),
        prisma.complaint.count({
          where: {
            createdById: userId,
            status: 'OPEN',
          }
        }),
      ]);
      counts = { complaintsAssigned, complaintsCreated };
      break;
    }

    case 'ADMIN': {
      // Admin counts: POs pending admin approval (level 1)
      const poApprovalPending = await prisma.storePurchaseOrder.count({
        where: { status: 'PENDING_ADMIN' }
      });
      counts = { poApprovalPending };
      break;
    }

    case 'SAM_HEAD': {
      const [unassignedCustomers, contractExpiring, allOrdersPending, pendingEnquiries, samActivationPending] = await Promise.all([
        prisma.lead.count({
          where: {
            customerUserId: { not: null },
            samAssignment: null
          }
        }),
        prisma.lead.count({
          where: {
            customerUserId: { not: null },
            contractEndDate: { not: null, lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
            samAssignment: { isNot: null }
          }
        }),
        prisma.serviceOrder.count({
          where: { status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }
        }),
        prisma.customerEnquiry.count({
          where: { status: 'SUBMITTED' }
        }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_SAM_ACTIVATION' }
        }),
      ]);
      counts = { unassignedCustomers, contractExpiring, allOrdersPending, pendingEnquiries, samActivationPending };
      break;
    }

    case 'SAM_EXECUTIVE': {
      const [pendingMomEmails, overdueVisits, contractExpiring, ordersPending, samActivationPending] = await Promise.all([
        prisma.sAMMeeting.count({
          where: {
            samExecutiveId: userId,
            status: 'COMPLETED',
            momEmailSentAt: null
          }
        }),
        prisma.sAMVisit.count({
          where: {
            samExecutiveId: userId,
            status: 'SCHEDULED',
            visitDate: { lt: new Date() }
          }
        }),
        prisma.lead.count({
          where: {
            customerUserId: { not: null },
            contractEndDate: { not: null, lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
            samAssignment: { samExecutiveId: userId }
          }
        }),
        prisma.serviceOrder.count({
          where: { createdById: userId, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }
        }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_SAM_ACTIVATION', createdById: userId }
        }),
      ]);
      counts = { pendingMomEmails, overdueVisits, contractExpiring, ordersPending, samActivationPending };
      break;
    }

    case 'SUPER_ADMIN_2': {
      // Super Admin 2 counts: pending quotation approvals (after OPS approval)
      const sa2Pending = await prisma.lead.count({
        where: {
          superAdmin2ApprovalStatus: 'PENDING',
          opsApprovalStatus: 'APPROVED',
          status: 'FEASIBLE'
        }
      });
      counts = { pending: sa2Pending };
      break;
    }

    case 'SUPER_ADMIN': {
      // Super Admin counts: overview of all queues + POs pending super admin approval (level 2) + delivery request approval + vendor approval
      const [
        isrQueue,
        bdmQueue,
        feasibilityQueue,
        docsQueue,
        accountsQueue,
        deliveryQueue,
        poApprovalPending,
        deliveryRequestPending,
        vendorsPendingAdmin,
        complaintsOpen,
        orderApprovalPending,
        docsOrderReviewPending,
        nocOrdersPending,
        accountsOrdersPending,
        samActivationPending,
        sa2Pending
      ] = await Promise.all([
        prisma.campaignData.count({ where: { status: 'NEW' } }),
        prisma.lead.count({ where: { status: 'NEW' } }),
        prisma.lead.count({
          where: { feasibilityAssignedToId: { not: null }, feasibilityReviewedAt: null, status: 'QUALIFIED' }
        }),
        prisma.lead.count({
          where: { sharedVia: { contains: 'docs_verification' }, docsVerifiedAt: null }
        }),
        prisma.lead.count({
          where: { docsVerifiedAt: { not: null }, docsRejectedReason: null, accountsVerifiedAt: null }
        }),
        prisma.lead.count({
          where: {
            pushedToInstallationAt: { not: null },
            OR: [
              { deliveryStatus: null },
              { deliveryStatus: 'PENDING' }
            ]
          }
        }),
        prisma.storePurchaseOrder.count({ where: { status: 'PENDING_SUPER_ADMIN' } }),
        prisma.deliveryRequest.count({ where: { status: 'PENDING_APPROVAL' } }),
        prisma.vendor.count({ where: { approvalStatus: 'PENDING_ADMIN' } }),
        prisma.complaint.count({
          where: { status: { notIn: ['CLOSED'] } }
        }),
        prisma.serviceOrder.count({ where: { status: 'PENDING_APPROVAL' } }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_DOCS_REVIEW', orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] } }
        }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_NOC', orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] } }
        }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_ACCOUNTS', orderType: { in: ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION'] } }
        }),
        prisma.serviceOrder.count({
          where: { status: 'PENDING_SAM_ACTIVATION' }
        }),
        prisma.lead.count({
          where: { superAdmin2ApprovalStatus: 'PENDING', opsApprovalStatus: 'APPROVED', status: 'FEASIBLE' }
        })
      ]);
      counts = { isrQueue, bdmQueue, feasibilityQueue, docsQueue, accountsQueue, deliveryQueue, poApprovalPending, deliveryRequestPending, vendorsPendingAdmin, complaintsOpen, orderApprovalPending, docsOrderReviewPending, nocOrdersPending, accountsOrdersPending, samActivationPending, sa2Pending };
      break;
    }

    default:
      counts = {};
  }

  res.json(counts);
});
