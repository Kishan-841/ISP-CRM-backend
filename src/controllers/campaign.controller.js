import prisma from '../config/db.js';
import { notifyDataAssigned } from '../services/notification.service.js';
import { isAdminOrTestUser, hasRole } from '../utils/roleHelper.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import { asyncHandler, parsePagination, paginatedResponse } from '../utils/controllerHelper.js';

// Generate unique campaign code
const generateCampaignCode = async () => {
  const prefix = 'CMP';

  // Get the highest campaign code with a single query instead of fetching all
  const latest = await prisma.campaign.findFirst({
    where: { code: { startsWith: prefix } },
    orderBy: { code: 'desc' },
    select: { code: true }
  });

  let maxNumber = 0;
  if (latest?.code) {
    const match = latest.code.match(/CMP(\d+)/);
    if (match) {
      maxNumber = parseInt(match[1], 10);
    }
  }

  return `${prefix}${String(maxNumber + 1).padStart(3, '0')}`;
};

// Get all campaigns (Admin only)
export const getCampaigns = asyncHandler(async function getCampaigns(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const isAdmin = isAdminOrTestUser(req.user);

    // Build role-based where clause, exclude SELF (shown in Self Data tab)
    const conditions = [{ type: { not: 'SELF' } }];

    if (!isAdmin) {
      if (userRole === 'BDM_TEAM_LEADER') {
        const teamMembers = await prisma.user.findMany({
          where: { teamLeaderId: userId, isActive: true },
          select: { id: true }
        });
        const hierarchyUserIds = [userId, ...teamMembers.map(u => u.id)];
        conditions.push({
          OR: [
            { createdById: userId },
            { assignments: { some: { userId: { in: hierarchyUserIds } } } }
          ]
        });
      } else if (userRole === 'BDM') {
        conditions.push({
          OR: [
            { createdById: userId },
            { assignments: { some: { userId } } }
          ]
        });
      }
    }

    const where = { AND: conditions };

    // Fetch campaigns without loading all campaignData rows
    const campaigns = await prisma.campaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { campaignData: true, assignments: true } },
        createdBy: { select: { id: true, name: true, role: true } },
        assignments: {
          include: {
            user: { select: { id: true, name: true, email: true, isActive: true } }
          }
        }
      }
    });

    const campaignIds = campaigns.map(c => c.id);

    if (campaignIds.length === 0) {
      return res.json({ campaigns: [] });
    }

    // Batch aggregation queries instead of loading all campaignData rows
    const [statusCounts, assigneeCounts, convertedCounts, selfCreators] = await Promise.all([
      // Status breakdown per campaign
      prisma.campaignData.groupBy({
        by: ['campaignId', 'status'],
        where: { campaignId: { in: campaignIds } },
        _count: { id: true }
      }),
      // Per-ISR data counts per campaign
      prisma.campaignData.groupBy({
        by: ['campaignId', 'assignedToId'],
        where: { campaignId: { in: campaignIds } },
        _count: { id: true }
      }),
      // Converted count per campaign (has a lead record)
      prisma.campaignData.groupBy({
        by: ['campaignId'],
        where: { campaignId: { in: campaignIds }, lead: { isNot: null } },
        _count: { id: true }
      }),
      // Self-generated creator info (one per campaign, if any)
      prisma.campaignData.findMany({
        where: { campaignId: { in: campaignIds }, isSelfGenerated: true },
        distinct: ['campaignId'],
        select: {
          campaignId: true,
          createdBy: { select: { id: true, name: true, role: true } }
        }
      })
    ]);

    // Build lookup maps
    const statusMap = new Map(); // campaignId -> { NEW: 5, INTERESTED: 3, ... }
    for (const row of statusCounts) {
      if (!statusMap.has(row.campaignId)) statusMap.set(row.campaignId, {});
      statusMap.get(row.campaignId)[row.status] = row._count.id;
    }

    const assigneeMap = new Map(); // campaignId -> { userId: count }
    for (const row of assigneeCounts) {
      if (!assigneeMap.has(row.campaignId)) assigneeMap.set(row.campaignId, {});
      assigneeMap.get(row.campaignId)[row.assignedToId] = row._count.id;
    }

    const convertedMap = new Map(convertedCounts.map(r => [r.campaignId, r._count.id]));
    const selfCreatorMap = new Map(selfCreators.map(r => [r.campaignId, r.createdBy]));

    // Build response with aggregated stats
    const campaignsWithStats = campaigns.map(campaign => {
      const statusData = statusMap.get(campaign.id) || {};
      const statusBreakdown = {
        NEW: statusData.NEW || 0,
        INTERESTED: statusData.INTERESTED || 0,
        NOT_INTERESTED: statusData.NOT_INTERESTED || 0,
        NOT_REACHABLE: statusData.NOT_REACHABLE || 0,
        CALL_LATER: statusData.CALL_LATER || 0,
        WRONG_NUMBER: statusData.WRONG_NUMBER || 0
      };

      const assigneeData = assigneeMap.get(campaign.id) || {};
      const assignmentsWithDataCount = campaign.assignments.map(assignment => ({
        ...assignment,
        dataCount: assigneeData[assignment.userId] || 0
      }));

      const isSelfGenerated = selfCreatorMap.has(campaign.id);
      const selfCreator = selfCreatorMap.get(campaign.id) || null;

      return {
        id: campaign.id,
        code: campaign.code,
        name: campaign.name,
        description: campaign.description,
        type: campaign.type,
        status: campaign.status,
        isActive: campaign.isActive,
        dataCount: campaign._count.campaignData,
        convertedCount: convertedMap.get(campaign.id) || 0,
        duplicateCount: 0,
        statusBreakdown,
        assignmentCount: campaign._count.assignments,
        assignments: assignmentsWithDataCount,
        isSelfGenerated,
        selfCreator,
        createdBy: campaign.createdBy || selfCreator || null,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt
      };
    });

    res.json({ campaigns: campaignsWithStats });
});

// Get single campaign
export const getCampaign = asyncHandler(async function getCampaign(req, res) {
    const { id } = req.params;

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: { id: true, name: true }
        },
        assignments: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          }
        },
        _count: {
          select: {
            campaignData: true
          }
        }
      }
    });

    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    res.json({ campaign });
});

// Create campaign
export const createCampaign = asyncHandler(async function createCampaign(req, res) {
    const { name, description, type, status, dataSource } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Campaign name is required.' });
    }

    // Retry logic for unique constraint errors
    let campaign;
    let retries = 3;

    while (retries > 0) {
      try {
        const code = await generateCampaignCode();

        campaign = await prisma.campaign.create({
          data: {
            code,
            name,
            description: description || null,
            type: type || 'CAMPAIGN',
            status: status || 'ACTIVE',
            dataSource: dataSource || null,
            createdById: req.user.id
          },
          include: {
            createdBy: {
              select: { id: true, name: true }
            }
          }
        });

        break; // Success, exit loop
      } catch (err) {
        if (err.code === 'P2002' && retries > 1) {
          // Unique constraint violation, retry with new code
          retries--;
          continue;
        }
        throw err; // Re-throw if not a unique constraint error or no retries left
      }
    }

    res.status(201).json({ campaign, message: 'Campaign created successfully.' });
});

// Update campaign (Admin only)
export const updateCampaign = asyncHandler(async function updateCampaign(req, res) {
    const { id } = req.params;
    const { name, description, type, status, isActive } = req.body;

    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    const campaign = await prisma.campaign.update({
      where: { id },
      data: {
        name: name !== undefined ? name : existing.name,
        description: description !== undefined ? description : existing.description,
        type: type !== undefined ? type : existing.type,
        status: status !== undefined ? status : existing.status,
        isActive: isActive !== undefined ? isActive : existing.isActive
      }
    });

    res.json({ campaign, message: 'Campaign updated successfully.' });
});

// Delete campaign (Admin only)
export const deleteCampaign = asyncHandler(async function deleteCampaign(req, res) {
    const { id } = req.params;

    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    // Check if any campaign data has been converted to leads that have dependent records
    const campaignDataIds = await prisma.campaignData.findMany({
      where: { campaignId: id },
      select: { id: true }
    });
    const dataIds = campaignDataIds.map(d => d.id);

    const convertedLeads = dataIds.length > 0 ? await prisma.lead.findMany({
      where: { campaignDataId: { in: dataIds } },
      select: { id: true }
    }) : [];

    if (convertedLeads.length > 0) {
      const leadIds = convertedLeads.map(l => l.id);

      // Check for delivery requests or other blocking relations
      const blockingDeliveryRequests = await prisma.deliveryRequest.count({
        where: { leadId: { in: leadIds } }
      });

      if (blockingDeliveryRequests > 0) {
        return res.status(400).json({
          message: `Cannot delete campaign. ${convertedLeads.length} lead(s) have been converted and ${blockingDeliveryRequests} delivery request(s) exist. Please delete associated delivery requests first.`
        });
      }
    }

    // Delete in order: call logs → leads → campaign data → assignments → campaign
    await prisma.$transaction(async (tx) => {
      // Delete call logs for campaign data
      if (dataIds.length > 0) {
        await tx.callLog.deleteMany({
          where: { campaignDataId: { in: dataIds } }
        });

        // Delete converted leads (cascade will handle lead's own relations)
        if (convertedLeads.length > 0) {
          await tx.lead.deleteMany({
            where: { campaignDataId: { in: dataIds } }
          });
        }
      }

      // Delete campaign data
      await tx.campaignData.deleteMany({ where: { campaignId: id } });

      // Delete assignments
      await tx.campaignAssignment.deleteMany({ where: { campaignId: id } });

      // Delete campaign
      await tx.campaign.delete({ where: { id } });
    });

    res.json({ message: 'Campaign deleted successfully.' });
});

// Assign ISRs to campaign (Admin only) with data distribution
export const assignUsersToCampaign = asyncHandler(async function assignUsersToCampaign(req, res) {
    const { id } = req.params;
    const { userIds, distributeData = true } = req.body;

    if (!Array.isArray(userIds)) {
      return res.status(400).json({ message: 'userIds must be an array.' });
    }

    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    // Remove existing assignments
    await prisma.campaignAssignment.deleteMany({
      where: { campaignId: id }
    });

    // Create new assignments
    if (userIds.length > 0) {
      await prisma.campaignAssignment.createMany({
        data: userIds.map(userId => ({
          userId,
          campaignId: id
        })),
        skipDuplicates: true
      });

      // Distribute campaign data equally among assigned ISRs
      if (distributeData && userIds.length > 0) {
        // Get all campaign data (prioritize unassigned, but include all for redistribution)
        const allCampaignData = await prisma.campaignData.findMany({
          where: { campaignId: id },
          select: { id: true },
          orderBy: { createdAt: 'asc' }
        });

        const totalData = allCampaignData.length;
        const numISRs = userIds.length;

        if (totalData > 0 && numISRs > 0) {
          // Calculate how many records each ISR gets
          const baseCount = Math.floor(totalData / numISRs);
          const remainder = totalData % numISRs;

          // Distribute data
          let currentIndex = 0;
          for (let i = 0; i < numISRs; i++) {
            // ISRs at the beginning get one extra if there's a remainder
            const countForThisISR = baseCount + (i < remainder ? 1 : 0);
            const dataIdsForThisISR = allCampaignData
              .slice(currentIndex, currentIndex + countForThisISR)
              .map(d => d.id);

            if (dataIdsForThisISR.length > 0) {
              const updateData = { assignedToId: userIds[i] };
              // If assigning user is a BDM or TL, set BDM binding
              if (req.user.role === 'BDM' || req.user.role === 'BDM_TEAM_LEADER') {
                updateData.assignedByBdmId = req.user.id;
              }
              await prisma.campaignData.updateMany({
                where: { id: { in: dataIdsForThisISR } },
                data: updateData
              });
            }

            currentIndex += countForThisISR;
          }
        }
      }
    } else {
      // If no ISRs assigned, clear all data assignments
      await prisma.campaignData.updateMany({
        where: { campaignId: id },
        data: { assignedToId: null, assignedByBdmId: null }
      });
    }

    const updatedCampaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        assignments: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          }
        },
        _count: {
          select: { campaignData: true }
        }
      }
    });

    // Get distribution info for response (single groupBy instead of N queries)
    const distributionInfo = [];
    if (userIds.length > 0) {
      const counts = await prisma.campaignData.groupBy({
        by: ['assignedToId'],
        where: { campaignId: id, assignedToId: { in: userIds } },
        _count: { id: true }
      });
      const countMap = new Map(counts.map(c => [c.assignedToId, c._count.id]));

      for (const userId of userIds) {
        const count = countMap.get(userId) || 0;
        const user = updatedCampaign.assignments.find(a => a.userId === userId)?.user;
        distributionInfo.push({
          userId,
          userName: user?.name || 'Unknown',
          dataCount: count
        });

        // Send notification to assigned ISR
        if (count > 0) {
          notifyDataAssigned(userId, updatedCampaign.name, count, id);
          emitSidebarRefresh(userId);
        }
      }
    }

    // Notify admins of assignment changes
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      campaign: updatedCampaign,
      distribution: distributionInfo,
      message: userIds.length > 0
        ? `Users assigned and ${updatedCampaign._count.campaignData} records distributed among ${userIds.length} ISR(s).`
        : 'All users unassigned from campaign.'
    });
});

// Get campaigns assigned to current ISR
export const getMyAssignedCampaigns = asyncHandler(async function getMyAssignedCampaigns(req, res) {
    const userId = req.user.id;
    const isMasterUser = req.user.role === 'MASTER' || req.user.role === 'SUPER_ADMIN';

    let assignments;

    if (isMasterUser) {
      // MASTER/SUPER_ADMIN: return ALL active campaigns with ALL data
      const allCampaigns = await prisma.campaign.findMany({
        where: { status: 'ACTIVE' },
        include: {
          createdBy: {
            select: { id: true, name: true, role: true }
          },
          _count: {
            select: { campaignData: true }
          },
          campaignData: {
            select: {
              status: true,
              lead: { select: { id: true } }
            }
          },
          assignments: {
            include: {
              user: {
                select: { id: true, name: true, email: true, isActive: true }
              }
            }
          }
        }
      });
      // Wrap in assignment-like structure for compatibility with the rest of the function
      assignments = allCampaigns.map(campaign => ({ campaign, userId }));
    } else {
      assignments = await prisma.campaignAssignment.findMany({
        where: { userId },
        include: {
          campaign: {
            include: {
              createdBy: {
                select: { id: true, name: true, role: true }
              },
              _count: {
                select: {
                  campaignData: true
                }
              },
              campaignData: {
                where: {
                  // Only show data specifically assigned to this ISR
                  assignedToId: userId
                },
                select: {
                  status: true,
                  lead: {
                    select: {
                      id: true
                    }
                  }
                }
              },
              // Include all assignments to show team members
              assignments: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                      isActive: true
                    }
                  }
                }
              }
            }
          }
        }
      });
    }

    // Single groupBy query to get per-ISR data counts across all campaigns (replaces N+1 individual count queries)
    const campaignIds = assignments.map(a => a.campaign.id);
    const isrDataCounts = campaignIds.length > 0
      ? await prisma.campaignData.groupBy({
          by: ['campaignId', 'assignedToId'],
          where: { campaignId: { in: campaignIds } },
          _count: true,
        })
      : [];

    // Build lookup: campaignId -> assignedToId -> count
    const isrCountMap = {};
    for (const row of isrDataCounts) {
      if (!isrCountMap[row.campaignId]) isrCountMap[row.campaignId] = {};
      isrCountMap[row.campaignId][row.assignedToId] = row._count;
    }

    const campaignsWithAssignments = assignments.map((a) => {
      const newCount = a.campaign.campaignData.filter(d => d.status === 'NEW').length;
      const totalAssigned = a.campaign.campaignData.length;
      const convertedCount = a.campaign.campaignData.filter(d => d.lead !== null).length;

      const statusBreakdown = {
        NEW: 0,
        INTERESTED: 0,
        NOT_INTERESTED: 0,
        NOT_REACHABLE: 0,
        CALL_LATER: 0,
        WRONG_NUMBER: 0
      };
      a.campaign.campaignData.forEach(d => {
        if (statusBreakdown.hasOwnProperty(d.status)) {
          statusBreakdown[d.status]++;
        }
      });

      const campaignCounts = isrCountMap[a.campaign.id] || {};
      const assignmentsWithDataCount = a.campaign.assignments.map((assignment) => ({
        ...assignment,
        dataCount: campaignCounts[assignment.userId] || 0,
      }));

      return {
        ...a.campaign,
        newDataCount: newCount,
        totalDataCount: totalAssigned,
        convertedCount,
        statusBreakdown,
        assignments: assignmentsWithDataCount,
        assignedAt: a.assignedAt
      };
    });

    res.json({ campaigns: campaignsWithAssignments });
});

// Add campaign data (Admin - bulk import)
export const addCampaignData = asyncHandler(async function addCampaignData(req, res) {
    const { id } = req.params;
    const { data } = req.body;

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Data array is required.' });
    }

    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    // Check for duplicates based on phone number — across ALL campaigns (global dedup)
    const existingPhones = await prisma.campaignData.findMany({
      where: {},
      select: { phone: true }
    });
    const existingPhoneSet = new Set(existingPhones.map(p => p.phone));

    const newRecords = [];
    let duplicateCount = 0;
    let duplicateInOtherCampaign = 0;

    let skippedNoPhone = 0;
    let skippedInvalidPhone = 0;
    let skippedNoName = 0;
    let skippedNoCompany = 0;
    let skippedNoTitle = 0;
    const invalidRecords = []; // Track invalid records for error display

    // Helper function to validate phone number - must have exactly 10 digits
    const validatePhone = (phone) => {
      if (!phone) return { valid: false, reason: 'empty' };
      const phoneStr = String(phone).trim();
      // Extract only digits
      const digitsOnly = phoneStr.replace(/\D/g, '');
      // Check if we have exactly 10 digits
      if (digitsOnly.length !== 10) {
        return { valid: false, reason: 'invalid_length', digits: digitsOnly.length };
      }
      // Check if it contains only valid characters (digits, spaces, dashes, parentheses, plus)
      const hasInvalidChars = /[^\d\s\-\(\)\+]/.test(phoneStr);
      if (hasInvalidChars) {
        return { valid: false, reason: 'invalid_chars' };
      }
      return { valid: true, cleaned: digitsOnly };
    };

    for (const item of data) {
      // Try multiple phone field names
      const phone = item.phone || item.Phone || item['Corporate Land Line Number'] ||
                    item['Phone Number'] || item['Mobile'] || item['mobile'] ||
                    item['Contact'] || item['contact'] || item['Telephone'] || '';

      if (!phone) {
        skippedNoPhone++;
        invalidRecords.push({
          ...item,
          errorReason: 'Missing phone number'
        });
        continue;
      }

      const phoneStr = String(phone).trim();
      if (!phoneStr) {
        skippedNoPhone++;
        invalidRecords.push({
          ...item,
          errorReason: 'Empty phone number'
        });
        continue;
      }

      // Validate phone number
      const phoneValidation = validatePhone(phoneStr);
      if (!phoneValidation.valid) {
        skippedInvalidPhone++;
        let errorReason = 'Invalid phone number';
        if (phoneValidation.reason === 'invalid_length') {
          errorReason = `Invalid phone: ${phoneValidation.digits} digits (need 10)`;
        } else if (phoneValidation.reason === 'invalid_chars') {
          errorReason = 'Invalid phone: contains special characters';
        }
        invalidRecords.push({
          company: item.company || item.Company || item['Company Name'] || '-',
          name: item.name || item.Name || `${item.firstName || ''} ${item.lastName || ''}`.trim() || '-',
          phone: phoneStr,
          errorReason
        });
        continue;
      }

      // Use the cleaned 10-digit phone number
      const cleanedPhone = phoneValidation.cleaned;

      // Get name fields
      const firstName = item.firstName || item['First Name'] || item['first_name'] || item.FirstName || null;
      const lastName = item.lastName || item['Last Name'] || item['last_name'] || item.LastName || null;
      const fullName = item.name || item.Name || `${firstName || ''} ${lastName || ''}`.trim() || null;

      // Name is required
      if (!fullName && !firstName && !lastName) {
        skippedNoName++;
        invalidRecords.push({
          company: item.company || item.Company || item['Company Name'] || '-',
          name: '-',
          phone: cleanedPhone,
          errorReason: 'Missing name'
        });
        continue;
      }

      // Company is required
      const company = item.company || item.Company || item['Company Name'] || '';
      if (!company.toString().trim()) {
        skippedNoCompany++;
        invalidRecords.push({
          company: '-',
          name: fullName || '-',
          phone: cleanedPhone,
          errorReason: 'Missing company'
        });
        continue;
      }

      // Title is required
      const title = item.title || item.Title || item.Designation || item.designation || '';
      if (!title.toString().trim()) {
        skippedNoTitle++;
        invalidRecords.push({
          company: company.toString().trim() || '-',
          name: fullName || '-',
          phone: cleanedPhone,
          errorReason: 'Missing title/designation'
        });
        continue;
      }

      if (existingPhoneSet.has(cleanedPhone)) {
        duplicateCount++;
        invalidRecords.push({
          company: company.toString().trim() || '-',
          name: fullName || '-',
          phone: cleanedPhone,
          errorReason: 'Duplicate phone number (already exists in system)'
        });
        continue;
      }

      existingPhoneSet.add(cleanedPhone);

      newRecords.push({
        campaignId: id,
        company: company.toString().trim(),
        firstName,
        lastName,
        title: title.toString().trim(),
        email: item.email || item.Email || item['Email Address'] || null,
        phone: cleanedPhone,
        industry: item.industry || item.Industry || null,
        city: item.city || item.City || item.Location || item.location || null,
        name: fullName,
        status: 'NEW'
      });
    }

    // If BDM or TL is uploading data, tag records with BDM binding
    if (req.user.role === 'BDM' || req.user.role === 'BDM_TEAM_LEADER') {
      newRecords.forEach(r => { r.assignedByBdmId = req.user.id; });
    }

    let createdCount = 0;
    if (newRecords.length > 0) {
      const result = await prisma.campaignData.createMany({
        data: newRecords,
        skipDuplicates: true
      });
      createdCount = result.count;

      // After uploading data, distribute it among assigned ISRs
      const assignments = await prisma.campaignAssignment.findMany({
        where: { campaignId: id },
        select: { userId: true }
      });

      if (assignments.length > 0) {
        // Get all campaign data (including newly uploaded)
        const allCampaignData = await prisma.campaignData.findMany({
          where: { campaignId: id },
          select: { id: true },
          orderBy: { createdAt: 'asc' }
        });

        const totalData = allCampaignData.length;
        const userIds = assignments.map(a => a.userId);
        const numISRs = userIds.length;

        if (totalData > 0 && numISRs > 0) {
          // Calculate how many records each ISR gets
          const baseCount = Math.floor(totalData / numISRs);
          const remainder = totalData % numISRs;

          // Distribute data
          let currentIndex = 0;
          for (let i = 0; i < numISRs; i++) {
            const countForThisISR = baseCount + (i < remainder ? 1 : 0);
            const dataIdsForThisISR = allCampaignData
              .slice(currentIndex, currentIndex + countForThisISR)
              .map(d => d.id);

            if (dataIdsForThisISR.length > 0) {
              await prisma.campaignData.updateMany({
                where: { id: { in: dataIdsForThisISR } },
                data: { assignedToId: userIds[i] }
              });

              // Send notification to assigned ISR
              notifyDataAssigned(userIds[i], campaign.name, countForThisISR, id);
              emitSidebarRefresh(userIds[i]);
            }

            currentIndex += countForThisISR;
          }
        }
      }
    }

    // Store rejected count on campaign
    const totalRejected = invalidRecords.length;
    if (totalRejected > 0) {
      await prisma.campaign.update({
        where: { id },
        data: { rejectedRecords: { increment: totalRejected } }
      });
    }

    // Notify admins of bulk import assignments
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      count: createdCount,
      duplicateCount,
      skippedNoPhone,
      skippedInvalidPhone,
      skippedNoName,
      skippedNoCompany,
      skippedNoTitle,
      totalReceived: data.length,
      invalidRecords,
      message: `${createdCount} records added. ${duplicateCount} duplicates, ${skippedNoPhone} no phone, ${skippedInvalidPhone} invalid phone, ${skippedNoName} no name, ${skippedNoCompany} no company, ${skippedNoTitle} no title skipped.`
    });
});

// Get campaign data for ISR (with phone masking)
export const getCampaignData = asyncHandler(async function getCampaignData(req, res) {
    const { id } = req.params;
    const { page, limit, skip } = parsePagination(req.query, 10);
    const { status, type } = req.query;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    // Check if user has access to this campaign
    if (!isAdmin) {
      // Allow access if user is assigned to the campaign OR is the campaign creator
      const [assignment, campaign] = await Promise.all([
        prisma.campaignAssignment.findUnique({
          where: {
            userId_campaignId: {
              userId,
              campaignId: id
            }
          }
        }),
        prisma.campaign.findUnique({
          where: { id },
          select: { createdById: true }
        })
      ]);

      if (!assignment && campaign?.createdById !== userId) {
        return res.status(403).json({ message: 'You do not have access to this campaign.' });
      }
    }

    // Build status filter based on type or specific status
    let statusFilter = {};
    if (status) {
      statusFilter = { status };
    } else if (type === 'working') {
      // Working data = all data with status != NEW (has been called/worked on)
      statusFilter = { status: { not: 'NEW' } };
    }

    // Campaign creators see all data; assigned ISRs see only their data
    const campaignInfo = isAdmin ? null : await prisma.campaign.findUnique({
      where: { id },
      select: { createdById: true }
    });
    const isCreator = !isAdmin && campaignInfo?.createdById === userId;

    const where = {
      campaignId: id,
      ...statusFilter,
      // ISRs only see data assigned to them, but creators see all
      ...(!isAdmin && !isCreator && { assignedToId: userId })
    };

    // Base filter for stats (same campaign + user scope, but without status filter)
    const statsWhere = {
      campaignId: id,
      ...(!isAdmin && !isCreator && { assignedToId: userId })
    };

    const [data, total, statusStats] = await Promise.all([
      prisma.campaignData.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          callLogs: {
            orderBy: { createdAt: 'desc' },
            take: 1
          },
          lead: {
            select: {
              id: true,
              status: true,
              createdAt: true
            }
          },
          assignedByBdm: {
            select: { id: true, name: true }
          },
          lastEditedBy: {
            select: { id: true, name: true, role: true }
          }
        }
      }),
      prisma.campaignData.count({ where }),
      // Stats: count by status for the entire campaign (not filtered by status param)
      prisma.campaignData.groupBy({
        by: ['status'],
        where: statsWhere,
        _count: { id: true }
      })
    ]);

    // Also get converted count
    const convertedCount = await prisma.campaignData.count({
      where: { ...statsWhere, lead: { isNot: null } }
    });

    // Mask phone numbers for ISR (show only last 4 digits) unless status is not NEW (has been called)
    const maskedData = data.map(item => {
      // Show real phone if: admin, or status is not NEW (has been called before)
      const showRealPhone = isAdmin || item.status !== 'NEW';
      return {
        ...item,
        phone: showRealPhone ? item.phone : `XXXXXX${item.phone.slice(-4)}`,
        lastCall: item.callLogs[0] || null,
        isConverted: !!item.lead,
        leadInfo: item.lead || null
      };
    });

    // Build stats from groupBy
    const statusMap = new Map(statusStats.map(s => [s.status, s._count.id]));
    const totalAssigned = statusStats.reduce((sum, s) => sum + s._count.id, 0);
    const pendingCount = statusMap.get('NEW') || 0;

    res.json(paginatedResponse({
      data: maskedData,
      total,
      page,
      limit,
      dataKey: 'data',
      extra: {
        stats: {
          totalAssigned,
          called: totalAssigned - pendingCount,
          pending: pendingCount,
          leadsGenerated: convertedCount
        }
      }
    }));
});

// Start a call (reveals phone number and starts timer)
export const startCall = asyncHandler(async function startCall(req, res) {
    const { dataId } = req.params;
    const userId = req.user.id;

    const campaignData = await prisma.campaignData.findUnique({
      where: { id: dataId },
      include: { campaign: true }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Data not found.' });
    }

    // Check if user is assigned to this campaign
    if (!isAdminOrTestUser(req.user)) {
      const assignment = await prisma.campaignAssignment.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: campaignData.campaignId
          }
        }
      });

      if (!assignment) {
        return res.status(403).json({ message: 'You are not assigned to this campaign.' });
      }
    }

    // Create call log entry
    const callLog = await prisma.callLog.create({
      data: {
        campaignDataId: dataId,
        userId,
        startTime: new Date(),
        status: 'CALLED'
      }
    });

    // Update campaign data to mark as being worked on
    await prisma.campaignData.update({
      where: { id: dataId },
      data: { assignedToId: userId }
    });

    res.json({
      callLog,
      phone: campaignData.phone, // Reveal full phone number
      data: campaignData
    });
});

// End call and update status
export const endCall = asyncHandler(async function endCall(req, res) {
    const { callLogId } = req.params;
    const { status, notes, callLaterAt } = req.body;
    const userId = req.user.id;

    if (!status) {
      return res.status(400).json({ message: 'Status is required.' });
    }

    // Validate callLaterAt for CALL_LATER status
    if (status === 'CALL_LATER' && !callLaterAt) {
      return res.status(400).json({ message: 'Callback date/time is required for Call Later status.' });
    }

    const callLog = await prisma.callLog.findUnique({
      where: { id: callLogId },
      include: { campaignData: true }
    });

    if (!callLog) {
      return res.status(404).json({ message: 'Call log not found.' });
    }

    if (callLog.userId !== userId && !isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Not authorized to update this call.' });
    }

    const endTime = new Date();
    const duration = Math.round((endTime - new Date(callLog.startTime)) / 1000);

    // Update call log
    const updatedCallLog = await prisma.callLog.update({
      where: { id: callLogId },
      data: {
        endTime,
        duration,
        status,
        notes: notes || null
      }
    });

    // Update campaign data status and callLaterAt if applicable
    await prisma.campaignData.update({
      where: { id: callLog.campaignDataId },
      data: {
        status,
        notes: notes || callLog.campaignData.notes,
        callLaterAt: status === 'CALL_LATER' && callLaterAt ? new Date(callLaterAt) : null
      }
    });

    res.json({
      callLog: updatedCallLog,
      duration,
      message: 'Call ended and status updated.'
    });
});

// Get call history for a campaign data
export const getCallHistory = asyncHandler(async function getCallHistory(req, res) {
    const { dataId } = req.params;

    const callLogs = await prisma.callLog.findMany({
      where: { campaignDataId: dataId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    res.json({ callLogs });
});

// Update campaign data status directly (ISR)
export const updateDataStatus = asyncHandler(async function updateDataStatus(req, res) {
    const { dataId } = req.params;
    const { status } = req.body;
    const userId = req.user.id;

    if (!status) {
      return res.status(400).json({ message: 'Status is required.' });
    }

    const campaignData = await prisma.campaignData.findUnique({
      where: { id: dataId },
      include: { campaign: true }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Data not found.' });
    }

    // Check if user is assigned to this campaign
    if (!isAdminOrTestUser(req.user)) {
      const assignment = await prisma.campaignAssignment.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: campaignData.campaignId
          }
        }
      });

      if (!assignment) {
        return res.status(403).json({ message: 'You are not assigned to this campaign.' });
      }
    }

    const updatedData = await prisma.campaignData.update({
      where: { id: dataId },
      data: { status, assignedToId: userId }
    });

    res.json({ data: updatedData, message: 'Status updated successfully.' });
});

// Add/update remark for campaign data (ISR)
export const addRemark = asyncHandler(async function addRemark(req, res) {
    const { dataId } = req.params;
    const { remark } = req.body;
    const userId = req.user.id;

    const campaignData = await prisma.campaignData.findUnique({
      where: { id: dataId },
      include: { campaign: true }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Data not found.' });
    }

    // Check if user is assigned to this campaign
    if (!isAdminOrTestUser(req.user)) {
      const assignment = await prisma.campaignAssignment.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: campaignData.campaignId
          }
        }
      });

      if (!assignment) {
        return res.status(403).json({ message: 'You are not assigned to this campaign.' });
      }
    }

    const updatedData = await prisma.campaignData.update({
      where: { id: dataId },
      data: { notes: remark }
    });

    res.json({ data: updatedData, message: 'Remark added successfully.' });
});

// Edit campaign data contact details (only creator of the campaign or admin can edit)
export const editCampaignData = asyncHandler(async function editCampaignData(req, res) {
    const { dataId } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    const { name, firstName, lastName, phone, email, company, title, city, state, address, whatsapp, industry, companySize, linkedinUrl } = req.body;

    // At least one field must be provided
    if (!name && !firstName && !lastName && !phone && !email && !company && !title && !city && !state && !address && !whatsapp && !industry && !companySize && !linkedinUrl) {
      return res.status(400).json({ message: 'At least one field is required to update.' });
    }

    const campaignData = await prisma.campaignData.findUnique({
      where: { id: dataId },
      include: {
        campaign: {
          select: { id: true, createdById: true }
        }
      }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Data not found.' });
    }

    // Permission: campaign creator, assigned ISR, or admin can edit
    const isAssignedISR = campaignData.assignedToId === userId;
    if (!isAdmin && campaignData.campaign.createdById !== userId && !isAssignedISR) {
      return res.status(403).json({ message: 'You do not have permission to edit this data.' });
    }

    // Build update data - only include fields that were provided
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (company !== undefined) updateData.company = company;
    if (title !== undefined) updateData.title = title;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (address !== undefined) updateData.address = address;
    if (whatsapp !== undefined) updateData.whatsapp = whatsapp;
    if (industry !== undefined) updateData.industry = industry;
    if (companySize !== undefined) updateData.companySize = companySize;
    if (linkedinUrl !== undefined) updateData.linkedinUrl = linkedinUrl;

    // Track who edited
    updateData.lastEditedById = userId;
    updateData.lastEditedAt = new Date();

    const updatedData = await prisma.campaignData.update({
      where: { id: dataId },
      data: updateData,
      include: {
        lastEditedBy: { select: { id: true, name: true, role: true } }
      }
    });

    res.json({ data: updatedData, message: 'Data updated successfully.' });
});

// Create self-campaign (ISR, BDM, and SAM)
export const createSelfCampaign = asyncHandler(async function createSelfCampaign(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { name, dataSource, data, assignToId } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Campaign name is required.' });
    }

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Data array is required.' });
    }

    // Determine the actual user to assign the data to
    // If BDM provides assignToId, use that; otherwise assign to creator
    const dataAssigneeId = assignToId || userId;

    // Verify assignToId user exists if provided
    if (assignToId && assignToId !== userId) {
      const assignee = await prisma.user.findUnique({
        where: { id: assignToId },
        select: { id: true, role: true, isActive: true }
      });
      if (!assignee) {
        return res.status(400).json({ message: 'Selected assignee not found.' });
      }
      if (!assignee.isActive) {
        return res.status(400).json({ message: 'Selected assignee is not active.' });
      }
    }

    // Determine prefix and description based on role
    let prefix = '[Self]';
    let description = 'Self-created campaign by ISR';
    if (userRole === 'BDM') {
      prefix = '[BDM Self]';
      description = assignToId && assignToId !== userId
        ? 'Self-created campaign by BDM (assigned to ISR)'
        : 'Self-created campaign by BDM';
    } else if (userRole === 'BDM_TEAM_LEADER') {
      prefix = '[TL Self]';
      description = assignToId && assignToId !== userId
        ? 'Self-created campaign by Team Leader (assigned to ISR)'
        : 'Self-created campaign by Team Leader';
    } else if (userRole === 'SAM') {
      prefix = '[SAM Self]';
      description = 'Self-created campaign by SAM';
    }

    // Create campaign with retry logic for unique constraint errors
    let campaign;
    let retries = 3;

    while (retries > 0) {
      try {
        const code = await generateCampaignCode();

        campaign = await prisma.campaign.create({
          data: {
            code,
            name: `${prefix} ${name}`,
            description,
            type: 'SELF',
            status: 'ACTIVE',
            dataSource: dataSource || 'Self Upload',
            createdById: userId
          }
        });

        break; // Success, exit loop
      } catch (err) {
        if (err.code === 'P2002' && retries > 1) {
          // Unique constraint violation, retry with new code
          retries--;
          continue;
        }
        throw err;
      }
    }

    // Auto-assign campaign to the data assignee only
    // If BDM assigns to ISR, only ISR will see the campaign (not BDM)
    await prisma.campaignAssignment.create({
      data: {
        userId: dataAssigneeId,
        campaignId: campaign.id
      }
    });

    // Process and add campaign data — check duplicates across ALL campaigns (global dedup)
    const allExistingPhones = await prisma.campaignData.findMany({
      where: {},
      select: { phone: true }
    });
    const existingPhoneSet = new Set(allExistingPhones.map(p => p.phone));
    const newRecords = [];
    let skippedNoPhone = 0;
    let skippedInvalidPhone = 0;
    let skippedNoName = 0;
    let skippedNoCompany = 0;
    let skippedNoTitle = 0;
    let duplicateCount = 0;
    const invalidRecords = [];

    // Helper function to validate phone number - must have exactly 10 digits
    const validatePhone = (phone) => {
      if (!phone) return { valid: false, reason: 'empty' };
      const phoneStr = String(phone).trim();
      const digitsOnly = phoneStr.replace(/\D/g, '');
      if (digitsOnly.length !== 10) {
        return { valid: false, reason: 'invalid_length', digits: digitsOnly.length };
      }
      const hasInvalidChars = /[^\d\s\-\(\)\+]/.test(phoneStr);
      if (hasInvalidChars) {
        return { valid: false, reason: 'invalid_chars' };
      }
      return { valid: true, cleaned: digitsOnly };
    };

    for (const item of data) {
      // Try multiple phone field names
      const phone = item.phone || item.Phone || item['Corporate Land Line Number'] ||
                    item['Phone Number'] || item['Mobile'] || item['mobile'] ||
                    item['Contact'] || item['contact'] || item['Telephone'] || '';

      if (!phone) {
        skippedNoPhone++;
        invalidRecords.push({
          ...item,
          errorReason: 'Missing phone number'
        });
        continue;
      }

      const phoneStr = String(phone).trim();
      if (!phoneStr) {
        skippedNoPhone++;
        invalidRecords.push({
          ...item,
          errorReason: 'Empty phone number'
        });
        continue;
      }

      // Validate phone number (must have exactly 10 digits)
      const phoneValidation = validatePhone(phoneStr);
      if (!phoneValidation.valid) {
        skippedInvalidPhone++;
        let errorReason = 'Invalid phone number';
        if (phoneValidation.reason === 'invalid_length') {
          errorReason = `Invalid phone: ${phoneValidation.digits} digits (need 10)`;
        } else if (phoneValidation.reason === 'invalid_chars') {
          errorReason = 'Invalid phone: contains special characters';
        }
        invalidRecords.push({
          company: item.company || item.Company || item['Company Name'] || '-',
          name: item.name || item.Name || `${item.firstName || ''} ${item.lastName || ''}`.trim() || '-',
          phone: phoneStr,
          errorReason
        });
        continue;
      }

      // Use the cleaned 10-digit phone number
      const cleanedPhone = phoneValidation.cleaned;

      // Get name fields
      const firstName = item.firstName || item['First Name'] || item['first_name'] || item.FirstName || null;
      const lastName = item.lastName || item['Last Name'] || item['last_name'] || item.LastName || null;
      const fullName = item.name || item.Name || `${firstName || ''} ${lastName || ''}`.trim() || null;

      // Name is required
      if (!fullName && !firstName && !lastName) {
        skippedNoName++;
        invalidRecords.push({
          company: item.company || item.Company || item['Company Name'] || '-',
          name: '-',
          phone: cleanedPhone,
          errorReason: 'Missing name'
        });
        continue;
      }

      // Company is required
      const company = item.company || item.Company || item['Company Name'] || '';
      if (!company.toString().trim()) {
        skippedNoCompany++;
        invalidRecords.push({
          company: '-',
          name: fullName || '-',
          phone: cleanedPhone,
          errorReason: 'Missing company'
        });
        continue;
      }

      // Title is required
      const title = item.title || item.Title || item.Designation || item.designation || '';
      if (!title.toString().trim()) {
        skippedNoTitle++;
        invalidRecords.push({
          company: company.toString().trim() || '-',
          name: fullName || '-',
          phone: cleanedPhone,
          errorReason: 'Missing title/designation'
        });
        continue;
      }

      if (existingPhoneSet.has(cleanedPhone)) {
        duplicateCount++;
        invalidRecords.push({
          company: company.toString().trim() || '-',
          name: fullName || '-',
          phone: cleanedPhone,
          errorReason: 'Duplicate phone number (already exists in system)'
        });
        continue;
      }

      existingPhoneSet.add(cleanedPhone);

      newRecords.push({
        campaignId: campaign.id,
        company: company.toString().trim(),
        firstName,
        lastName,
        title: title.toString().trim(),
        email: item.email || item.Email || item['Email Address'] || null,
        phone: cleanedPhone,
        industry: item.industry || item.Industry || null,
        city: item.city || item.City || item.Location || item.location || null,
        name: fullName,
        status: 'NEW',
        assignedToId: dataAssigneeId,  // Assign to selected user (ISR if BDM chose, otherwise self)
        createdById: userId,            // Track who created the data (always the BDM/ISR who uploaded)
        isSelfGenerated: true,          // Mark as self-generated
        // If BDM assigns to ISR, set BDM binding for lead conversion
        ...((userRole === 'BDM' || userRole === 'BDM_TEAM_LEADER') && assignToId && assignToId !== userId ? { assignedByBdmId: userId } : {})
      });
    }

    let createdCount = 0;
    if (newRecords.length > 0) {
      const result = await prisma.campaignData.createMany({
        data: newRecords,
        skipDuplicates: true
      });
      createdCount = result.count;
    }

    // Store rejected count on campaign
    const totalRejected = invalidRecords.length;
    if (totalRejected > 0) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { rejectedRecords: { increment: totalRejected } }
      });
    }

    res.status(201).json({
      campaign,
      count: createdCount,
      duplicateCount,
      skippedNoPhone,
      skippedInvalidPhone,
      skippedNoName,
      skippedNoCompany,
      skippedNoTitle,
      totalReceived: data.length,
      invalidRecords,
      message: `Campaign created with ${createdCount} records. ${duplicateCount} duplicates, ${skippedNoPhone} no phone, ${skippedInvalidPhone} invalid phone, ${skippedNoName} no name, ${skippedNoCompany} no company, ${skippedNoTitle} no title skipped.`
    });
});

// Get ISR Dashboard Stats
export const getISRDashboardStats = asyncHandler(async function getISRDashboardStats(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const { period = 'last7days', fromDate, toDate } = req.query;

    // Get start of today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate date range based on period
    const getDateRange = () => {
      const now = new Date();
      switch (period) {
        case 'last7days':
          const last7 = new Date();
          last7.setDate(last7.getDate() - 7);
          last7.setHours(0, 0, 0, 0);
          return { start: last7, days: 7 };
        case 'monthly':
          const last30 = new Date();
          last30.setDate(last30.getDate() - 30);
          last30.setHours(0, 0, 0, 0);
          return { start: last30, days: 30 };
        case 'yearly':
          const last365 = new Date();
          last365.setDate(last365.getDate() - 365);
          last365.setHours(0, 0, 0, 0);
          return { start: last365, days: 365 };
        case 'alltime':
          return { start: new Date('2000-01-01'), days: null };
        case 'custom':
          if (fromDate && toDate) {
            const start = new Date(fromDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(toDate);
            end.setHours(23, 59, 59, 999);
            const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
            return { start, end, days: diffDays };
          }
          return { start: new Date('2000-01-01'), days: null };
        default:
          const defaultLast7 = new Date();
          defaultLast7.setDate(defaultLast7.getDate() - 7);
          defaultLast7.setHours(0, 0, 0, 0);
          return { start: defaultLast7, days: 7 };
      }
    };

    const dateRange = getDateRange();

    // Get all campaigns (admin sees all, ISR sees only assigned)
    const assignmentWhere = isAdmin ? {} : { userId };
    const assignments = await prisma.campaignAssignment.findMany({
      where: assignmentWhere,
      select: { campaignId: true }
    });

    const campaignIds = isAdmin
      ? (await prisma.campaign.findMany({ select: { id: true } })).map(c => c.id)
      : assignments.map(a => a.campaignId);

    if (campaignIds.length === 0) {
      return res.json({
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
        }
      });
    }

    // Get all data for assigned campaigns (admin sees all, ISR sees only data assigned to them)
    const whereClause = {
      campaignId: { in: campaignIds },
      ...(isAdmin ? {} : { assignedToId: userId })
    };

    // Period-filtered where clause for stats (alltime = no date filter)
    const isAllTime = period === 'alltime';
    const periodWhereClause = isAllTime
      ? { ...whereClause }
      : { ...whereClause, updatedAt: { gte: dateRange.start } };

    // Total stats (filtered by period)
    const [totalAssigned, workingData, pendingData, convertedToLead] = await Promise.all([
      prisma.campaignData.count({ where: periodWhereClause }),
      prisma.campaignData.count({ where: { ...periodWhereClause, status: { not: 'NEW' } } }),
      prisma.campaignData.count({ where: { ...periodWhereClause, status: 'NEW' } }),
      prisma.campaignData.count({ where: { ...periodWhereClause, status: 'INTERESTED' } })
    ]);

    // Call activity stats (filtered by period)
    const callLogWhere = {
      ...(isAdmin ? {} : { userId }),
      campaignData: { campaignId: { in: campaignIds } }
    };
    if (!isAllTime) callLogWhere.createdAt = { gte: dateRange.start };

    const periodCallLogs = await prisma.callLog.findMany({
      where: callLogWhere,
      include: {
        campaignData: {
          include: {
            lead: { select: { id: true } }
          }
        }
      }
    });

    // Today's subset from period call logs
    const todayCallLogs = periodCallLogs.filter(log => new Date(log.createdAt) >= today);
    const todayCallsMade = todayCallLogs.length;
    const todayConvertedToLead = todayCallLogs.filter(log => log.campaignData?.lead !== null).length;

    // Count today's call outcomes
    const todayOutcomes = {
      interested: todayCallLogs.filter(log => log.status === 'INTERESTED').length,
      notInterested: todayCallLogs.filter(log => log.status === 'NOT_INTERESTED').length,
      notReachable: todayCallLogs.filter(log => log.status === 'NOT_REACHABLE').length,
      callLater: todayCallLogs.filter(log => log.status === 'CALL_LATER').length,
      wrongNumber: todayCallLogs.filter(log => log.status === 'WRONG_NUMBER').length
    };

    // Status distribution for pie chart (filtered by period)
    const statusCounts = await prisma.campaignData.groupBy({
      by: ['status'],
      where: periodWhereClause,
      _count: { status: true }
    });

    const statusDistribution = statusCounts.map(s => ({
      status: s.status,
      count: s._count.status
    }));

    // Recent activity (filtered by period)
    const recentActivity = await prisma.campaignData.findMany({
      where: { ...periodWhereClause, status: { not: 'NEW' } },
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

    // Call stats (filtered by period)
    const callLogs = periodCallLogs;
    const todayCallCount = todayCallLogs.length;
    const totalDuration = callLogs.reduce((sum, c) => sum + (c.duration || 0), 0);

    // Progress based on selected period - single query approach
    const progressData = [];

    // Build date ranges for the selected period
    const ranges = [];
    if (period === 'alltime' || period === 'yearly') {
      for (let i = 11; i >= 0; i--) {
        const monthStart = new Date();
        monthStart.setMonth(monthStart.getMonth() - i);
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        const monthLabel = `${monthStart.toLocaleDateString('en-US', { month: 'short' })} '${String(monthStart.getFullYear()).slice(2)}`;
        ranges.push({ start: monthStart, end: monthEnd, date: monthStart.toISOString().split('T')[0], label: monthLabel });
      }
    } else if (period === 'monthly') {
      for (let i = 3; i >= 0; i--) {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - (i * 7) - 6);
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        ranges.push({ start: weekStart, end: weekEnd, date: weekStart.toISOString().split('T')[0], label: `Week ${4 - i}` });
      }
    } else {
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        date.setHours(0, 0, 0, 0);
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + 1);
        ranges.push({ start: date, end: nextDate, date: date.toISOString().split('T')[0], label: date.toLocaleDateString('en-US', { weekday: 'short' }) });
      }
    }

    // Single query: get all data in the full time range, grouped by status and date
    const fullRangeStart = ranges[0].start;
    const fullRangeEnd = ranges[ranges.length - 1].end;

    const periodRecords = await prisma.campaignData.findMany({
      where: {
        ...whereClause,
        updatedAt: { gte: fullRangeStart, lt: fullRangeEnd }
      },
      select: { status: true, updatedAt: true }
    });

    // Bucket records into ranges
    for (const range of ranges) {
      let total = 0, working = 0, converted = 0;
      for (const rec of periodRecords) {
        if (rec.updatedAt >= range.start && rec.updatedAt < range.end) {
          total++;
          if (rec.status !== 'NEW') working++;
          if (rec.status === 'INTERESTED') converted++;
        }
      }
      progressData.push({ date: range.date, label: range.label, total, working, converted });
    }

    // Get follow-up counts for next 7 days + overdue in a single query
    const followUpStart = new Date();
    followUpStart.setHours(0, 0, 0, 0);
    const followUpEnd = new Date(followUpStart);
    followUpEnd.setDate(followUpEnd.getDate() + 7);

    const followUpRecords = await prisma.campaignData.findMany({
      where: {
        ...whereClause,
        status: 'CALL_LATER',
        callLaterAt: { lt: followUpEnd }
      },
      select: { callLaterAt: true }
    });

    // Bucket into days
    const followUpCounts = [];
    let overdueCount = 0;
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(followUpStart);
      dayStart.setDate(dayStart.getDate() + i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const count = followUpRecords.filter(r => r.callLaterAt >= dayStart && r.callLaterAt < dayEnd).length;
      followUpCounts.push({
        date: dayStart.toISOString().split('T')[0],
        day: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        count
      });
    }
    overdueCount = followUpRecords.filter(r => r.callLaterAt < today).length;

    res.json({
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
        todayCalls: todayCallCount,
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

// Delete self-campaign (ISR, BDM, SAM, or SUPER_ADMIN)
export const deleteSelfCampaign = asyncHandler(async function deleteSelfCampaign(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        assignments: {
          where: { userId }
        }
      }
    });

    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    // Only allow deletion if campaign is SELF type
    if (campaign.type !== 'SELF') {
      return res.status(403).json({ message: 'You can only delete self-created campaigns.' });
    }

    // Admin can delete any SELF campaign, others can only delete their own
    if (!isAdmin && campaign.assignments.length === 0) {
      return res.status(403).json({ message: 'You are not authorized to delete this campaign.' });
    }

    // Check for converted leads with blocking relations
    const convertedData = await prisma.campaignData.findMany({
      where: { campaignId: id, lead: { isNot: null } },
      select: { id: true, lead: { select: { id: true } } }
    });

    if (convertedData.length > 0) {
      const leadIds = convertedData.map(d => d.lead?.id).filter(Boolean);
      const blockingDeliveryRequests = await prisma.deliveryRequest.count({
        where: { leadId: { in: leadIds } }
      });
      if (blockingDeliveryRequests > 0) {
        return res.status(400).json({
          message: `Cannot delete campaign. ${convertedData.length} lead(s) have been converted and ${blockingDeliveryRequests} delivery request(s) exist. Please delete associated delivery requests first.`
        });
      }
    }

    // Delete in order: leads → call logs → campaign data → assignments → campaign
    await prisma.$transaction(async (tx) => {
      // Delete leads that reference this campaign's data
      const campaignDataIds = await tx.campaignData.findMany({
        where: { campaignId: id },
        select: { id: true }
      });
      const dataIds = campaignDataIds.map(d => d.id);
      if (dataIds.length > 0) {
        await tx.lead.deleteMany({ where: { campaignDataId: { in: dataIds } } });
      }
      await tx.callLog.deleteMany({
        where: { campaignData: { campaignId: id } }
      });
      await tx.campaignData.deleteMany({ where: { campaignId: id } });
      await tx.campaignAssignment.deleteMany({ where: { campaignId: id } });
      await tx.campaign.delete({ where: { id } });
    });

    res.json({ message: 'Campaign deleted successfully.' });
});

// Delete single campaign data (for self campaigns)
export const deleteCampaignData = asyncHandler(async function deleteCampaignData(req, res) {
    const { dataId } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    const campaignData = await prisma.campaignData.findUnique({
      where: { id: dataId },
      include: {
        campaign: {
          include: {
            assignments: {
              where: { userId }
            }
          }
        }
      }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Data not found.' });
    }

    // Check if user has permission to delete
    if (!isAdmin) {
      // For self campaigns, check if user is assigned and data belongs to them
      if (campaignData.campaign.type === 'SELF') {
        if (campaignData.campaign.assignments.length === 0) {
          return res.status(403).json({ message: 'You are not authorized to delete this data.' });
        }
        if (campaignData.assignedToId !== userId) {
          return res.status(403).json({ message: 'You can only delete data assigned to you.' });
        }
      } else {
        return res.status(403).json({ message: 'You can only delete data from self-created campaigns.' });
      }
    }

    // Delete the campaign data
    await prisma.campaignData.delete({ where: { id: dataId } });

    res.json({ message: 'Data deleted successfully.' });
});

// Add single campaign data (Admin or assigned ISR)
export const addSingleCampaignData = asyncHandler(async function addSingleCampaignData(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const { company, firstName, lastName, name, title, email, phone, industry, city, address, notes } = req.body;

    // Validate required fields
    if (!phone) {
      return res.status(400).json({ message: 'Phone number is required.' });
    }

    const fullName = name || `${firstName || ''} ${lastName || ''}`.trim();
    if (!fullName && !firstName && !lastName) {
      return res.status(400).json({ message: 'Name is required (either name, firstName, or lastName).' });
    }

    if (!company || !company.toString().trim()) {
      return res.status(400).json({ message: 'Company is required.' });
    }

    if (!title || !title.toString().trim()) {
      return res.status(400).json({ message: 'Title is required.' });
    }

    // Check if campaign exists
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    // Check if user has access to this campaign (Admin or assigned ISR)
    if (!isAdmin) {
      const assignment = await prisma.campaignAssignment.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: id
          }
        }
      });

      if (!assignment) {
        return res.status(403).json({ message: 'You are not assigned to this campaign.' });
      }
    }

    // Check for duplicate phone number in this campaign
    const existingData = await prisma.campaignData.findFirst({
      where: {
        campaignId: id,
        phone: phone.trim()
      }
    });

    if (existingData) {
      return res.status(400).json({ message: 'A record with this phone number already exists in this campaign.' });
    }

    // Create the campaign data
    const campaignData = await prisma.campaignData.create({
      data: {
        campaignId: id,
        company: company.toString().trim(),
        firstName: firstName || null,
        lastName: lastName || null,
        name: fullName,
        title: title.toString().trim(),
        email: email || null,
        phone: phone.trim(),
        industry: industry || null,
        city: city || null,
        address: address || null,
        notes: notes || null,
        status: 'NEW',
        assignedToId: isAdmin ? null : userId  // Auto-assign to ISR if they added it
      }
    });

    res.status(201).json({
      data: campaignData,
      message: 'Data added successfully.'
    });
});

// Get single campaign data details (ISR)
export const getCampaignDataDetail = asyncHandler(async function getCampaignDataDetail(req, res) {
    const { dataId } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    const campaignData = await prisma.campaignData.findUnique({
      where: { id: dataId },
      include: {
        campaign: true,
        callLogs: {
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: { id: true, name: true }
            }
          }
        },
        assignedByBdm: {
          select: { id: true, name: true }
        }
      }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Data not found.' });
    }

    // Check if user is assigned to this campaign
    if (!isAdmin) {
      const assignment = await prisma.campaignAssignment.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: campaignData.campaignId
          }
        }
      });

      if (!assignment) {
        return res.status(403).json({ message: 'You are not assigned to this campaign.' });
      }
    }

    // Mask phone for non-admin users (show real phone if status is not NEW - has been called before)
    const showRealPhone = isAdmin || campaignData.status !== 'NEW';
    const responseData = {
      ...campaignData,
      phone: showRealPhone ? campaignData.phone : `XXXXXX${campaignData.phone.slice(-4)}`
    };

    res.json({ data: responseData });
});

// Get follow-ups (CALL_LATER data) for ISR
export const getFollowUps = asyncHandler(async function getFollowUps(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    // Get all campaigns assigned to this user
    let campaignIds = [];
    if (!isAdmin) {
      const assignments = await prisma.campaignAssignment.findMany({
        where: { userId },
        select: { campaignId: true }
      });
      campaignIds = assignments.map(a => a.campaignId);

      if (campaignIds.length === 0) {
        return res.json({ followUps: [], counts: { dueToday: 0, overdue: 0, upcoming: 0 } });
      }
    }

    // Build where clause for CALL_LATER data
    const whereClause = {
      status: 'CALL_LATER',
      callLaterAt: { not: null },
      ...(isAdmin ? {} : {
        campaignId: { in: campaignIds },
        OR: [
          { assignedToId: null },
          { assignedToId: userId }
        ]
      })
    };

    // Get all follow-ups
    const followUps = await prisma.campaignData.findMany({
      where: whereClause,
      orderBy: { callLaterAt: 'asc' },
      include: {
        campaign: {
          select: {
            id: true,
            code: true,
            name: true,
            createdById: true
          }
        },
        callLogs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            user: {
              select: { id: true, name: true }
            }
          }
        }
      }
    });

    // Get today's date at midnight for comparison
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Categorize follow-ups
    const categorized = followUps.map(item => {
      const callLaterAt = new Date(item.callLaterAt);
      callLaterAt.setHours(0, 0, 0, 0);

      let category;
      if (callLaterAt < today) {
        category = 'overdue';
      } else if (callLaterAt >= today && callLaterAt < tomorrow) {
        category = 'dueToday';
      } else {
        category = 'upcoming';
      }

      return {
        id: item.id,
        company: item.company,
        name: item.name || `${item.firstName || ''} ${item.lastName || ''}`.trim(),
        firstName: item.firstName,
        lastName: item.lastName,
        title: item.title,
        email: item.email,
        phone: item.phone,
        industry: item.industry,
        city: item.city,
        notes: item.notes,
        status: item.status,
        callLaterAt: item.callLaterAt,
        campaign: item.campaign,
        lastCall: item.callLogs[0] || null,
        category
      };
    });

    // Count by category
    const counts = {
      dueToday: categorized.filter(f => f.category === 'dueToday').length,
      overdue: categorized.filter(f => f.category === 'overdue').length,
      upcoming: categorized.filter(f => f.category === 'upcoming').length
    };

    res.json({ followUps: categorized, counts });
});

// Mark follow-up as complete (change status from CALL_LATER to CALLED)
export const markFollowUpComplete = asyncHandler(async function markFollowUpComplete(req, res) {
    const { dataId } = req.params;
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    const campaignData = await prisma.campaignData.findUnique({
      where: { id: dataId }
    });

    if (!campaignData) {
      return res.status(404).json({ message: 'Data not found.' });
    }

    if (campaignData.status !== 'CALL_LATER') {
      return res.status(400).json({ message: 'This data is not a follow-up.' });
    }

    // Authorization: admin or the ISR assigned to this data/campaign
    if (!isAdmin) {
      if (campaignData.assignedToId && campaignData.assignedToId !== userId) {
        return res.status(403).json({ message: 'You are not assigned to this data.' });
      }

      const assignment = await prisma.campaignAssignment.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: campaignData.campaignId
          }
        }
      });

      if (!assignment) {
        return res.status(403).json({ message: 'You are not assigned to this campaign.' });
      }
    }

    // Update status and clear callLaterAt
    const updatedData = await prisma.campaignData.update({
      where: { id: dataId },
      data: {
        status: 'CALLED',
        callLaterAt: null,
        assignedToId: userId
      }
    });

    res.json({ data: updatedData, message: 'Follow-up marked as complete.' });
});

// Get pending follow-up count for sidebar badge
export const getFollowUpCount = asyncHandler(async function getFollowUpCount(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    // Get campaigns assigned to user
    const assignments = await prisma.campaignAssignment.findMany({
      where: { userId },
      select: { campaignId: true }
    });
    const campaignIds = assignments.map(a => a.campaignId);

    if (!isAdmin && campaignIds.length === 0) {
      return res.json({ total: 0, overdue: 0, dueToday: 0, pending: 0 });
    }

    // Build where clause
    const whereClause = {
      status: 'CALL_LATER',
      callLaterAt: { not: null },
      ...(isAdmin ? {} : {
        campaignId: { in: campaignIds },
        OR: [
          { assignedToId: null },
          { assignedToId: userId }
        ]
      })
    };

    // Get counts
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalCount, overdueCount, dueTodayCount] = await Promise.all([
      prisma.campaignData.count({ where: whereClause }),
      prisma.campaignData.count({
        where: {
          ...whereClause,
          callLaterAt: { lt: today }
        }
      }),
      prisma.campaignData.count({
        where: {
          ...whereClause,
          callLaterAt: {
            gte: today,
            lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
          }
        }
      })
    ]);

    res.json({
      total: totalCount,
      overdue: overdueCount,
      dueToday: dueTodayCount,
      pending: overdueCount + dueTodayCount
    });
});

// Get unanswered calls (RINGING_NOT_PICKED status) for retry
export const getUnansweredCalls = asyncHandler(async function getUnansweredCalls(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    // Get all campaigns assigned to this user
    let campaignIds = [];
    if (!isAdmin) {
      const assignments = await prisma.campaignAssignment.findMany({
        where: { userId },
        select: { campaignId: true }
      });
      campaignIds = assignments.map(a => a.campaignId);

      if (campaignIds.length === 0) {
        return res.json({
          data: [],
          stats: { total: 0, today: 0, yesterday: 0, older: 0 }
        });
      }
    }

    // Build where clause for RINGING_NOT_PICKED and NOT_REACHABLE data (not converted to lead)
    const whereClause = {
      status: { in: ['RINGING_NOT_PICKED', 'NOT_REACHABLE'] },
      lead: null, // Not converted to lead
      ...(isAdmin ? {} : {
        campaignId: { in: campaignIds },
        OR: [
          { assignedToId: null },
          { assignedToId: userId }
        ]
      })
    };

    // Get all unanswered calls
    const unansweredCalls = await prisma.campaignData.findMany({
      where: whereClause,
      orderBy: { updatedAt: 'desc' },
      include: {
        campaign: {
          select: {
            id: true,
            code: true,
            name: true,
            createdById: true
          }
        },
        callLogs: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          include: {
            user: {
              select: { id: true, name: true }
            }
          }
        }
      }
    });

    // Get date boundaries
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Categorize and format data
    const formattedData = unansweredCalls.map(item => {
      const lastUpdated = new Date(item.updatedAt);
      const lastUpdatedDate = new Date(lastUpdated.getFullYear(), lastUpdated.getMonth(), lastUpdated.getDate());

      let category;
      if (lastUpdatedDate >= today) {
        category = 'today';
      } else if (lastUpdatedDate >= yesterday) {
        category = 'yesterday';
      } else {
        category = 'older';
      }

      // Count total attempts (number of call logs with RINGING_NOT_PICKED or NOT_REACHABLE status)
      const retryAttempts = item.callLogs.filter(log =>
        log.status === 'RINGING_NOT_PICKED' || log.status === 'NOT_REACHABLE'
      ).length;

      return {
        id: item.id,
        company: item.company,
        name: item.name || `${item.firstName || ''} ${item.lastName || ''}`.trim(),
        firstName: item.firstName,
        lastName: item.lastName,
        title: item.title,
        email: item.email,
        phone: item.phone,
        whatsapp: item.whatsapp,
        industry: item.industry,
        city: item.city,
        state: item.state,
        notes: item.notes,
        status: item.status,
        campaign: item.campaign,
        lastCall: item.callLogs[0] || null,
        callLogs: item.callLogs,
        attemptCount: retryAttempts || 1,
        lastAttempt: item.updatedAt,
        category
      };
    });

    // Calculate stats
    const stats = {
      total: formattedData.length,
      today: formattedData.filter(d => d.category === 'today').length,
      yesterday: formattedData.filter(d => d.category === 'yesterday').length,
      older: formattedData.filter(d => d.category === 'older').length
    };

    res.json({ data: formattedData, stats });
});

// Get unanswered calls count for sidebar badge
export const getUnansweredCallsCount = asyncHandler(async function getUnansweredCallsCount(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    // Get campaigns assigned to user
    const assignments = await prisma.campaignAssignment.findMany({
      where: { userId },
      select: { campaignId: true }
    });
    const campaignIds = assignments.map(a => a.campaignId);

    // Build where clause for RINGING_NOT_PICKED and NOT_REACHABLE (not converted to lead)
    const whereClause = {
      status: { in: ['RINGING_NOT_PICKED', 'NOT_REACHABLE'] },
      lead: null, // Not converted to lead
      ...(isAdmin ? {} : {
        campaignId: { in: campaignIds },
        OR: [
          { assignedToId: null },
          { assignedToId: userId }
        ]
      })
    };

    const count = await prisma.campaignData.count({ where: whereClause });

    res.json({ count });
});

// Get reports data for ISR dashboard
export const getReportsData = asyncHandler(async function getReportsData(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const { period = 'this_week' } = req.query;

    // Calculate date ranges based on period
    const now = new Date();
    let startDate, prevStartDate, prevEndDate;

    switch (period) {
      case 'today':
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        prevStartDate = new Date(startDate);
        prevStartDate.setDate(prevStartDate.getDate() - 1);
        prevEndDate = new Date(startDate);
        break;
      case 'this_week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - startDate.getDay()); // Start of week
        startDate.setHours(0, 0, 0, 0);
        prevStartDate = new Date(startDate);
        prevStartDate.setDate(prevStartDate.getDate() - 7);
        prevEndDate = new Date(startDate);
        break;
      case 'this_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        prevStartDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        prevEndDate = new Date(startDate);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        prevStartDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        prevEndDate = new Date(startDate);
        break;
      case 'this_quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        prevStartDate = new Date(now.getFullYear(), (quarter - 1) * 3, 1);
        prevEndDate = new Date(startDate);
        break;
      default:
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
        prevStartDate = new Date(startDate);
        prevStartDate.setDate(prevStartDate.getDate() - 7);
        prevEndDate = new Date(startDate);
    }

    // Get campaigns for this user
    let campaignIds = [];
    if (!isAdmin) {
      const assignments = await prisma.campaignAssignment.findMany({
        where: { userId },
        select: { campaignId: true }
      });
      campaignIds = assignments.map(a => a.campaignId);

      if (campaignIds.length === 0) {
        return res.json({
          stats: {
            totalCalls: 0,
            totalCallsChange: 0,
            leadsGenerated: 0,
            leadsChange: 0,
            conversionRate: 0,
            conversionChange: 0,
            avgCallDuration: 0
          },
          campaignPerformance: []
        });
      }
    }

    // Build where clause for call logs
    const callLogWhere = {
      createdAt: { gte: startDate },
      ...(isAdmin ? {} : { userId })
    };

    const prevCallLogWhere = {
      createdAt: { gte: prevStartDate, lt: prevEndDate },
      ...(isAdmin ? {} : { userId })
    };

    // Get current period call logs
    const currentCalls = await prisma.callLog.findMany({
      where: callLogWhere,
      include: {
        campaignData: {
          include: {
            campaign: true,
            lead: true
          }
        }
      }
    });

    // Get previous period call logs for comparison
    const prevCalls = await prisma.callLog.findMany({
      where: prevCallLogWhere,
      include: {
        campaignData: {
          include: {
            lead: true
          }
        }
      }
    });

    // Calculate stats
    const totalCalls = currentCalls.length;
    const prevTotalCalls = prevCalls.length;
    const totalCallsChange = prevTotalCalls > 0
      ? Math.round(((totalCalls - prevTotalCalls) / prevTotalCalls) * 100)
      : 0;

    // Leads generated (INTERESTED status calls)
    const leadsGenerated = currentCalls.filter(c => c.campaignData?.lead).length;
    const prevLeadsGenerated = prevCalls.filter(c => c.campaignData?.lead).length;
    const leadsChange = prevLeadsGenerated > 0
      ? Math.round(((leadsGenerated - prevLeadsGenerated) / prevLeadsGenerated) * 100)
      : 0;

    // Conversion rate
    const conversionRate = totalCalls > 0
      ? Math.round((leadsGenerated / totalCalls) * 100 * 10) / 10
      : 0;
    const prevConversionRate = prevTotalCalls > 0
      ? Math.round((prevLeadsGenerated / prevTotalCalls) * 100 * 10) / 10
      : 0;
    const conversionChange = Math.round((conversionRate - prevConversionRate) * 10) / 10;

    // Average call duration
    const totalDuration = currentCalls.reduce((sum, c) => sum + (c.duration || 0), 0);
    const avgCallDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;

    // Campaign performance data
    const campaignMap = new Map();
    for (const call of currentCalls) {
      if (call.campaignData?.campaign) {
        const campaignName = call.campaignData.campaign.name;
        if (!campaignMap.has(campaignName)) {
          campaignMap.set(campaignName, { name: campaignName, calls: 0, conversions: 0 });
        }
        const data = campaignMap.get(campaignName);
        data.calls++;
        if (call.campaignData.lead) {
          data.conversions++;
        }
      }
    }

    const campaignPerformance = Array.from(campaignMap.values())
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10); // Top 10 campaigns

    res.json({
      stats: {
        totalCalls,
        totalCallsChange,
        leadsGenerated,
        leadsChange,
        conversionRate,
        conversionChange,
        avgCallDuration
      },
      campaignPerformance
    });
});

// Get data batches for Data Management tab
export const getDataBatches = asyncHandler(async function getDataBatches(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    // Get campaigns based on role
    let campaigns;
    if (isAdmin) {
      campaigns = await prisma.campaign.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              campaignData: true
            }
          },
          campaignData: {
            select: {
              id: true,
              status: true,
              phone: true
            }
          }
        }
      });
    } else {
      // Get campaigns assigned to this ISR
      const assignments = await prisma.campaignAssignment.findMany({
        where: { userId },
        include: {
          campaign: {
            include: {
              _count: {
                select: {
                  campaignData: true
                }
              },
              campaignData: {
                select: {
                  id: true,
                  status: true,
                  phone: true
                }
              }
            }
          }
        }
      });
      campaigns = assignments.map(a => a.campaign);
    }

    // Calculate statistics for each campaign (batch)
    const batches = campaigns.map(campaign => {
      const totalRecords = campaign._count.campaignData;

      // For duplicates, we would need to check across all campaigns
      // For now, we'll set it to 0 (this can be enhanced later)
      const duplicates = 0;

      // Valid records = total records - duplicates
      const validRecords = totalRecords - duplicates;

      // Determine status based on data
      let status = 'Pending';
      if (totalRecords > 0 && validRecords > 0) {
        status = 'Validated';
      } else if (totalRecords > 0) {
        status = 'Pending';
      }

      // Determine source type based on campaign type or dataSource
      let source = 'Manual';
      if (campaign.dataSource) {
        const ds = campaign.dataSource.toLowerCase();
        if (ds.includes('purchase') || ds.includes('bought')) {
          source = 'Purchased';
        } else if (ds.includes('website') || ds.includes('web') || ds.includes('inquiry')) {
          source = 'Website';
        } else if (ds.includes('referral') || ds.includes('refer')) {
          source = 'Referral';
        } else if (ds.includes('self') || campaign.type === 'SELF') {
          source = 'Self Upload';
        } else {
          source = campaign.dataSource;
        }
      } else if (campaign.type === 'SELF') {
        source = 'Self Upload';
      }

      return {
        id: campaign.id,
        batchName: campaign.name,
        source,
        totalRecords,
        validRecords,
        duplicates,
        status,
        campaignName: campaign.name,
        campaignCode: campaign.code,
        uploadedAt: campaign.createdAt,
        isActive: campaign.isActive
      };
    });

    // Calculate overall statistics
    const stats = {
      totalBatches: batches.length,
      totalRecords: batches.reduce((sum, b) => sum + b.totalRecords, 0),
      totalValid: batches.reduce((sum, b) => sum + b.validRecords, 0),
      totalDuplicates: batches.reduce((sum, b) => sum + b.duplicates, 0),
      validatedBatches: batches.filter(b => b.status === 'Validated').length,
      pendingBatches: batches.filter(b => b.status === 'Pending').length
    };

    res.json({ batches, stats });
});

// Get call disposition data for pie chart
export const getCallDispositionData = asyncHandler(async function getCallDispositionData(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const { period = 'this_week' } = req.query;

    // Calculate date range based on period
    const now = new Date();
    let startDate;

    switch (period) {
      case 'today':
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - startDate.getDay());
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        break;
      case 'this_quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      default:
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
    }

    // Build where clause for call logs
    const callLogWhere = {
      createdAt: { gte: startDate },
      ...(isAdmin ? {} : { userId })
    };

    // Get call logs grouped by status
    const callLogs = await prisma.callLog.groupBy({
      by: ['status'],
      where: callLogWhere,
      _count: {
        status: true
      }
    });

    // Define all possible statuses with their display names and colors
    const statusConfig = {
      'NEW': { name: 'New', color: '#94a3b8' },
      'CALLED': { name: 'Called', color: '#60a5fa' },
      'INTERESTED': { name: 'Interested', color: '#34d399' },
      'NOT_INTERESTED': { name: 'Not Interested', color: '#fbbf24' },
      'NOT_REACHABLE': { name: 'Not Reachable', color: '#f87171' },
      'WRONG_NUMBER': { name: 'Wrong Number', color: '#a78bfa' },
      'CALL_LATER': { name: 'Callback', color: '#fb923c' },
      'RINGING_NOT_PICKED': { name: 'Ringing Not Picked', color: '#f97316' },
      'DND': { name: 'DND', color: '#f472b6' },
      'DISCONNECTED': { name: 'Disconnected', color: '#6b7280' }
    };

    // Calculate total calls
    const totalCalls = callLogs.reduce((sum, item) => sum + item._count.status, 0);

    // Build disposition data with percentages
    const disposition = callLogs.map(item => {
      const config = statusConfig[item.status] || { name: item.status, color: '#94a3b8' };
      const percentage = totalCalls > 0
        ? Math.round((item._count.status / totalCalls) * 100)
        : 0;

      return {
        status: item.status,
        name: config.name,
        value: item._count.status,
        percentage,
        color: config.color
      };
    });

    // Sort by value descending
    disposition.sort((a, b) => b.value - a.value);

    res.json({
      disposition,
      totalCalls,
      statusConfig
    });
});

// Get ISR leaderboard data
export const getLeaderboardData = asyncHandler(async function getLeaderboardData(req, res) {
    const { period = 'this_week' } = req.query;

    // Calculate date range based on period
    const now = new Date();
    let startDate;

    switch (period) {
      case 'today':
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - startDate.getDay());
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        break;
      case 'this_quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      default:
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
    }

    // Get all ISR users
    const isrUsers = await prisma.user.findMany({
      where: {
        role: 'ISR',
        isActive: true
      },
      select: {
        id: true,
        name: true,
        email: true
      }
    });

    // Get call stats for each ISR
    const leaderboardData = await Promise.all(
      isrUsers.map(async (user) => {
        // Get call logs for this user in the period
        const callLogs = await prisma.callLog.findMany({
          where: {
            userId: user.id,
            createdAt: { gte: startDate }
          },
          include: {
            campaignData: {
              include: {
                lead: true
              }
            }
          }
        });

        const totalCalls = callLogs.length;
        const leadsGenerated = callLogs.filter(c => c.campaignData?.lead).length;
        const conversionRate = totalCalls > 0
          ? Math.round((leadsGenerated / totalCalls) * 100 * 10) / 10
          : 0;

        return {
          id: user.id,
          name: user.name,
          calls: totalCalls,
          leads: leadsGenerated,
          conversionRate
        };
      })
    );

    // Sort by calls (descending), then by conversion rate
    const sortedLeaderboard = leaderboardData
      .filter(isr => isr.calls > 0) // Only include ISRs with calls
      .sort((a, b) => {
        if (b.calls !== a.calls) return b.calls - a.calls;
        return b.conversionRate - a.conversionRate;
      })
      .slice(0, 10); // Top 10

    res.json({ leaderboard: sortedLeaderboard });
});

// Get all call history for ISR (Call History page)
export const getAllCallHistory = asyncHandler(async function getAllCallHistory(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const { page, limit, skip } = parsePagination(req.query, 50);
    const { search, startDate, endDate } = req.query;

    // Build where clause based on role
    let whereClause = {};
    if (!isAdmin) {
      whereClause = { userId };
    }

    // Add date filtering
    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) {
        whereClause.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        whereClause.createdAt.lte = new Date(endDate);
      }
    }

    // Add search filtering at DB level
    if (search) {
      whereClause.campaignData = {
        OR: [
          { company: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { campaign: { name: { contains: search, mode: 'insensitive' } } }
        ]
      };
    }

    // Get paginated call logs and total count in parallel
    const [callLogs, totalCount] = await Promise.all([
      prisma.callLog.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          },
          campaignData: {
            include: {
              campaign: {
                select: {
                  id: true,
                  code: true,
                  name: true
                }
              },
              lead: {
                include: {
                  products: {
                    include: {
                      product: {
                        select: {
                          id: true,
                          title: true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }),
      prisma.callLog.count({ where: whereClause })
    ]);

    // Calculate stats using groupBy + aggregate instead of fetching all records
    const [statusCounts, durationAgg] = await Promise.all([
      prisma.callLog.groupBy({
        by: ['status'],
        where: whereClause,
        _count: { id: true }
      }),
      prisma.callLog.aggregate({
        where: whereClause,
        _sum: { duration: true },
        _count: { id: true }
      })
    ]);

    const totalCalls = durationAgg._count.id;
    const totalDuration = durationAgg._sum.duration || 0;
    const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;

    const outcomeDistribution = {};
    let connectedCalls = 0;
    let callbacks = 0;
    for (const row of statusCounts) {
      outcomeDistribution[row.status] = row._count.id;
      if (row.status === 'INTERESTED') connectedCalls = row._count.id;
      if (row.status === 'CALL_LATER') callbacks = row._count.id;
    }

    // Format call logs for response
    const formattedLogs = callLogs.map(log => {
      const campaignData = log.campaignData;
      const lead = campaignData?.lead;
      const products = lead?.products?.map(lp => lp.product) || [];

      return {
        id: log.id,
        company: campaignData?.company || 'Unknown',
        name: campaignData?.name || `${campaignData?.firstName || ''} ${campaignData?.lastName || ''}`.trim() || 'Unknown',
        phone: campaignData?.phone || 'N/A',
        campaign: campaignData?.campaign?.name || 'Unknown Campaign',
        campaignCode: campaignData?.campaign?.code || '',
        outcome: log.status,
        products: products,
        duration: log.duration || 0,
        isrName: log.user?.name || 'Unknown',
        isrId: log.user?.id,
        dateTime: log.createdAt,
        notes: log.notes || '',
        startTime: log.startTime,
        endTime: log.endTime
      };
    });

    res.json(paginatedResponse({
      data: formattedLogs,
      total: totalCount,
      page,
      limit,
      dataKey: 'callLogs',
      extra: {
        stats: {
          totalCalls,
          connectedCalls,
          avgDuration,
          callbacks,
          outcomeDistribution
        }
      }
    }));
});

// Get Data Source ROI data for reports
export const getDataSourceROI = asyncHandler(async function getDataSourceROI(req, res) {
    // Get all campaigns with their data counts and rejected records
    const campaigns = await prisma.campaign.findMany({
      select: {
        id: true,
        name: true,
        dataSource: true,
        type: true,
        rejectedRecords: true,
        _count: {
          select: {
            campaignData: true
          }
        },
        campaignData: {
          select: {
            id: true,
            status: true,
            lead: {
              select: { id: true }
            }
          }
        }
      }
    });

    // Group by data source
    const sourceMap = new Map();

    for (const campaign of campaigns) {
      // Determine source type
      let source = campaign.dataSource || 'Other';
      if (campaign.dataSource) {
        const ds = campaign.dataSource.toLowerCase();
        if (ds.includes('purchase') || ds.includes('bought')) {
          source = 'Purchased';
        } else if (ds.includes('website') || ds.includes('web') || ds.includes('inquiry')) {
          source = 'Website';
        } else if (ds.includes('referral') || ds.includes('refer')) {
          source = 'Referral';
        } else if (ds.includes('self') || campaign.type === 'SELF') {
          source = 'Self Upload';
        } else if (ds.includes('customer')) {
          source = 'Customer Portal';
        } else {
          source = campaign.dataSource;
        }
      } else if (campaign.type === 'SELF') {
        source = 'Self Upload';
      }

      if (!sourceMap.has(source)) {
        sourceMap.set(source, {
          source,
          totalRecords: 0,
          validRecords: 0,
          invalidRecords: 0,
          convertedRecords: 0,
          campaigns: 0
        });
      }

      const data = sourceMap.get(source);
      data.campaigns++;
      const savedRecords = campaign._count.campaignData;
      const rejected = campaign.rejectedRecords || 0;
      data.totalRecords += savedRecords + rejected; // Total = saved + rejected during upload
      data.validRecords += savedRecords;
      data.invalidRecords += rejected;

      // Converted records = records that became leads
      const converted = campaign.campaignData.filter(d => d.lead !== null).length;
      data.convertedRecords += converted;
    }

    // Convert to array and calculate percentages
    const dataSourceROI = Array.from(sourceMap.values()).map(item => ({
      ...item,
      conversionRate: item.totalRecords > 0
        ? Math.round((item.convertedRecords / item.totalRecords) * 100 * 10) / 10
        : 0,
      validRate: item.totalRecords > 0
        ? Math.round((item.validRecords / item.totalRecords) * 100 * 10) / 10
        : 0
    }));

    // Sort by total records descending
    dataSourceROI.sort((a, b) => b.totalRecords - a.totalRecords);

    // Calculate totals
    const totals = {
      totalRecords: dataSourceROI.reduce((sum, d) => sum + d.totalRecords, 0),
      validRecords: dataSourceROI.reduce((sum, d) => sum + d.validRecords, 0),
      invalidRecords: dataSourceROI.reduce((sum, d) => sum + d.invalidRecords, 0),
      convertedRecords: dataSourceROI.reduce((sum, d) => sum + d.convertedRecords, 0),
      campaigns: dataSourceROI.reduce((sum, d) => sum + d.campaigns, 0)
    };

    res.json({ dataSourceROI, totals });
});

// Get Weekly Activity Trends data
export const getWeeklyTrends = asyncHandler(async function getWeeklyTrends(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);

    // Get start of current week (Monday)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Adjust for Monday start
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diff);
    weekStart.setHours(0, 0, 0, 0);

    // Build where clause for call logs
    const callLogWhere = {
      createdAt: { gte: weekStart },
      ...(isAdmin ? {} : { userId })
    };

    // Get all call logs for this week
    const callLogs = await prisma.callLog.findMany({
      where: callLogWhere,
      select: {
        id: true,
        createdAt: true,
        campaignData: {
          select: {
            lead: {
              select: { id: true }
            }
          }
        }
      }
    });

    // Group by day of week
    const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const weeklyData = daysOfWeek.map((day, index) => {
      const dayDate = new Date(weekStart);
      dayDate.setDate(weekStart.getDate() + index);
      const nextDay = new Date(dayDate);
      nextDay.setDate(dayDate.getDate() + 1);

      const dayLogs = callLogs.filter(log => {
        const logDate = new Date(log.createdAt);
        return logDate >= dayDate && logDate < nextDay;
      });

      const calls = dayLogs.length;
      const leads = dayLogs.filter(log => log.campaignData?.lead !== null).length;

      return {
        day,
        date: dayDate.toISOString().split('T')[0],
        calls,
        leads
      };
    });

    // Calculate totals
    const totals = {
      totalCalls: weeklyData.reduce((sum, d) => sum + d.calls, 0),
      totalLeads: weeklyData.reduce((sum, d) => sum + d.leads, 0)
    };

    res.json({ weeklyData, totals });
});

// Get My Campaign Performance data (with filters)
export const getMyCampaignPerformance = asyncHandler(async function getMyCampaignPerformance(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const { campaignId, isrId, period = 'this_week' } = req.query;

    // Calculate date range based on period
    const now = new Date();
    let startDate = new Date();

    switch (period) {
      case 'today':
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_week':
        const dayOfWeek = now.getDay();
        const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        startDate.setDate(now.getDate() - diff);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        now.setDate(0); // Last day of previous month
        break;
      case 'this_quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      default:
        startDate.setDate(now.getDate() - 7);
    }

    // Determine which user to query for
    let targetUserId = userId;
    if (isAdmin && isrId) {
      targetUserId = isrId;
    }

    // Build campaign filter
    let campaignFilter = {};
    if (campaignId && campaignId !== 'all') {
      campaignFilter = { campaignId };
    }

    // Get user's assigned campaigns (or all for admin)
    let campaignsQuery;
    if (isAdmin && !isrId) {
      // Admin viewing all - get all campaigns
      campaignsQuery = await prisma.campaign.findMany({
        where: campaignId && campaignId !== 'all' ? { id: campaignId } : {},
        select: { id: true, name: true, code: true }
      });
    } else {
      // ISR or admin viewing specific ISR
      const assignments = await prisma.campaignAssignment.findMany({
        where: { userId: targetUserId },
        include: {
          campaign: {
            select: { id: true, name: true, code: true }
          }
        }
      });
      campaignsQuery = assignments.map(a => a.campaign);
      if (campaignId && campaignId !== 'all') {
        campaignsQuery = campaignsQuery.filter(c => c.id === campaignId);
      }
    }

    // Get campaign IDs
    const campaignIds = campaignsQuery.map(c => c.id);

    // Build where clause for call logs
    const callLogWhere = {
      createdAt: { gte: startDate },
      campaignData: {
        campaignId: { in: campaignIds }
      }
    };

    // Add user filter (not for admin viewing all)
    if (!isAdmin || isrId) {
      callLogWhere.userId = targetUserId;
    }

    // Get call logs with campaign data
    const callLogs = await prisma.callLog.findMany({
      where: callLogWhere,
      include: {
        campaignData: {
          include: {
            campaign: {
              select: { id: true, name: true, code: true }
            },
            lead: {
              select: { id: true }
            }
          }
        }
      }
    });

    // Group by campaign
    const campaignStats = {};
    for (const campaign of campaignsQuery) {
      campaignStats[campaign.id] = {
        campaignId: campaign.id,
        campaignName: campaign.name,
        campaignCode: campaign.code,
        totalCalls: 0,
        totalDuration: 0,
        leadsGenerated: 0,
        interested: 0,
        notInterested: 0,
        notReachable: 0,
        callLater: 0,
        wrongNumber: 0
      };
    }

    // Process call logs
    for (const log of callLogs) {
      const cId = log.campaignData?.campaign?.id;
      if (cId && campaignStats[cId]) {
        campaignStats[cId].totalCalls++;
        campaignStats[cId].totalDuration += log.duration || 0;

        if (log.campaignData?.lead) {
          campaignStats[cId].leadsGenerated++;
        }

        // Count by status
        const status = log.status;
        if (status === 'INTERESTED') campaignStats[cId].interested++;
        else if (status === 'NOT_INTERESTED') campaignStats[cId].notInterested++;
        else if (status === 'NOT_REACHABLE') campaignStats[cId].notReachable++;
        else if (status === 'CALL_LATER') campaignStats[cId].callLater++;
        else if (status === 'WRONG_NUMBER') campaignStats[cId].wrongNumber++;
      }
    }

    // Convert to array and calculate rates
    const performanceData = Object.values(campaignStats).map(stats => ({
      ...stats,
      avgDuration: stats.totalCalls > 0 ? Math.round(stats.totalDuration / stats.totalCalls) : 0,
      conversionRate: stats.totalCalls > 0 ? Math.round((stats.leadsGenerated / stats.totalCalls) * 100 * 10) / 10 : 0
    }));

    // Calculate totals
    const totals = {
      totalCalls: performanceData.reduce((sum, d) => sum + d.totalCalls, 0),
      totalDuration: performanceData.reduce((sum, d) => sum + d.totalDuration, 0),
      leadsGenerated: performanceData.reduce((sum, d) => sum + d.leadsGenerated, 0),
      interested: performanceData.reduce((sum, d) => sum + d.interested, 0),
      notInterested: performanceData.reduce((sum, d) => sum + d.notInterested, 0),
      notReachable: performanceData.reduce((sum, d) => sum + d.notReachable, 0),
      callLater: performanceData.reduce((sum, d) => sum + d.callLater, 0),
      wrongNumber: performanceData.reduce((sum, d) => sum + d.wrongNumber, 0)
    };
    totals.avgDuration = totals.totalCalls > 0 ? Math.round(totals.totalDuration / totals.totalCalls) : 0;
    totals.conversionRate = totals.totalCalls > 0 ? Math.round((totals.leadsGenerated / totals.totalCalls) * 100 * 10) / 10 : 0;

    // Get list of campaigns for dropdown
    let campaignsList;
    if (isAdmin && !isrId) {
      campaignsList = await prisma.campaign.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' }
      });
    } else {
      const userAssignments = await prisma.campaignAssignment.findMany({
        where: { userId: targetUserId },
        include: {
          campaign: {
            select: { id: true, name: true, code: true }
          }
        }
      });
      campaignsList = userAssignments.map(a => a.campaign);
    }

    // Get list of ISRs for admin dropdown
    let isrList = [];
    if (isAdmin) {
      isrList = await prisma.user.findMany({
        where: { role: 'ISR', isActive: true },
        select: { id: true, name: true, email: true },
        orderBy: { name: 'asc' }
      });
    }

    res.json({
      performanceData,
      totals,
      campaigns: campaignsList,
      isrList
    });
});

// Get all campaign data - campaign-level summaries (name, created by, assigned to, data count)
export const getAllCampaignData = asyncHandler(async function getAllCampaignData(req, res) {
    const userId = req.user.id;
    const userRole = req.user.role;
    const isAdmin = isAdminOrTestUser(req.user);

    // Only admins, BDM, ISR, BDM_TEAM_LEADER can access
    if (!isAdmin && userRole !== 'BDM' && userRole !== 'ISR' && userRole !== 'BDM_TEAM_LEADER') {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { page, limit, skip } = parsePagination(req.query, 25);
    const search = req.query.search?.trim() || '';
    const tabType = req.query.tabType || 'all';

    // Validate tabType
    const validTabs = ['campaign', 'self', 'assigned_self', 'social_media', 'all'];
    if (!validTabs.includes(tabType)) {
      return res.status(400).json({ message: 'Invalid tabType.' });
    }

    // assigned_self is ISR-only
    if (tabType === 'assigned_self' && userRole !== 'ISR') {
      return res.status(403).json({ message: 'This tab is only available for ISR role.' });
    }

    // Pre-fetch hierarchy user IDs for TL
    let hierarchyUserIds = [userId];
    if (!isAdmin && userRole === 'BDM_TEAM_LEADER') {
      const teamMembers = await prisma.user.findMany({
        where: { teamLeaderId: userId, isActive: true },
        select: { id: true }
      });
      hierarchyUserIds = [userId, ...teamMembers.map(u => u.id)];
    }

    // Type mapping
    const typeMap = { campaign: 'CAMPAIGN', self: 'SELF', assigned_self: 'SELF', social_media: 'SOCIAL_MEDIA' };

    // Build where clause using AND array for safe composition
    const conditions = [];

    // Type filter (not for 'all' tab)
    if (typeMap[tabType]) {
      conditions.push({ type: typeMap[tabType] });
    }

    // Tab-specific + role-based filtering
    if (tabType === 'self') {
      // Self tab: only campaigns created by current user
      conditions.push({ createdById: userId });
    } else if (tabType === 'assigned_self') {
      // Assigned Self: assigned to me but NOT created by me
      conditions.push({ NOT: { createdById: userId } });
      conditions.push({ assignments: { some: { userId } } });
    } else if (!isAdmin && tabType !== 'all') {
      // campaign, social_media tabs need role-based filtering (all tab shows everything to everyone)
      if (userRole === 'ISR') {
        conditions.push({
          OR: [
            { assignments: { some: { userId } } },
            { createdById: userId }
          ]
        });
      } else if (userRole === 'BDM') {
        conditions.push({
          OR: [
            { createdById: userId },
            { assignments: { some: { userId } } }
          ]
        });
      } else if (userRole === 'BDM_TEAM_LEADER') {
        conditions.push({
          OR: [
            { createdById: userId },
            { assignments: { some: { userId: { in: hierarchyUserIds } } } }
          ]
        });
      }
    }

    // Search by campaign name
    if (search) {
      conditions.push({ name: { contains: search, mode: 'insensitive' } });
    }

    const where = conditions.length > 0 ? { AND: conditions } : {};

    // Get campaigns with data count
    const [total, campaigns] = await Promise.all([
      prisma.campaign.count({ where }),
      prisma.campaign.findMany({
        where,
        select: {
          id: true,
          name: true,
          code: true,
          type: true,
          createdAt: true,
          createdBy: {
            select: { id: true, name: true }
          },
          assignments: {
            select: {
              user: { select: { id: true, name: true } }
            }
          },
          _count: {
            select: { campaignData: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      })
    ]);

    // Map to clean response
    const mappedData = campaigns.map(c => ({
      id: c.id,
      name: c.name,
      code: c.code,
      type: c.type,
      createdAt: c.createdAt,
      createdBy: c.createdBy || null,
      assignedTo: c.assignments.map(a => a.user),
      dataCount: c._count.campaignData,
    }));

    res.json(paginatedResponse({ data: mappedData, total, page, limit, dataKey: 'data' }));
});

// ISR Pipeline Funnel — tracks converted leads through entire pipeline
export const getISRPipelineFunnel = asyncHandler(async function getISRPipelineFunnel(req, res) {
    const { userId, period = 'this_month' } = req.query;
    const isAdmin = isAdminOrTestUser(req.user);
    const isISR = req.user.role === 'ISR';

    const isTL = req.user.role === 'BDM_TEAM_LEADER';

    // Allow admin, TL to see any ISR's funnel, or ISR to see their own
    if (!isAdmin && !isISR && !isTL) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Calculate date range based on period
    const now = new Date();
    let startDate;

    switch (period) {
      case 'today':
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - startDate.getDay());
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        break;
      case 'this_quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    let endDate = now;
    if (period === 'last_month') {
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    }

    // Build where clause
    const whereClause = {
      createdAt: { gte: startDate, ...(period === 'last_month' ? { lte: endDate } : {}) },
    };

    if (isISR && !isAdmin) {
      // ISR can only see their own funnel
      whereClause.createdById = req.user.id;
    } else if (userId) {
      whereClause.createdById = userId;
    } else {
      const isrUsers = await prisma.user.findMany({
        where: { role: 'ISR', isActive: true },
        select: { id: true }
      });
      whereClause.createdById = { in: isrUsers.map(u => u.id) };
    }

    const leads = await prisma.lead.findMany({
      where: whereClause,
      select: {
        id: true,
        status: true,
        sharedVia: true,
        feasibilityReviewedAt: true,
        opsApprovalStatus: true,
        docsVerifiedAt: true,
        docsRejectedReason: true,
        accountsVerifiedAt: true,
        accountsStatus: true,
        pushedToInstallationAt: true,
        customerUsername: true,
        installationCompletedAt: true,
        customerAcceptanceAt: true,
        actualPlanIsActive: true,
      }
    });

    const totalConverted = leads.length;

    // Pipeline: Feasible → Quote Sent → Docs Upload → Docs Review → Accounts Review → Push to Delivery → At NOC → Delivered/Installed → Live
    // Check from end of pipeline backward. A field being set = that stage is DONE, lead is PAST it.
    const getCurrentStage = (lead) => {
      // 9. Live — actual plan running
      if (lead.actualPlanIsActive) return 'live';
      // 8. Delivered/Installed — customer accepted or installation done, plan not yet active
      if (lead.customerAcceptanceAt || lead.installationCompletedAt) return 'installed';
      // 7. At NOC — customer username created by NOC, delivery in progress
      if (lead.customerUsername) return 'atNOC';
      // 6. Push to Delivery — pushed to installation, NOC creating customer account
      if (lead.pushedToInstallationAt) return 'pushToDelivery';
      // Also push to delivery if accounts approved but BDM hasn't pushed yet
      if (lead.accountsVerifiedAt && lead.accountsStatus === 'ACCOUNTS_APPROVED') return 'pushToDelivery';
      // 5. Accounts Review — docs verified+approved, waiting for accounts team
      if (lead.docsVerifiedAt && !lead.docsRejectedReason) return 'accountsReview';
      // 4. Docs Review — pushed to docs verification, docs team reviewing
      if (lead.sharedVia && lead.sharedVia.includes('docs_verification')) return 'docsReview';
      // 3. Docs Upload — OPS approved, BDM needs to collect and push docs
      if (lead.opsApprovalStatus === 'APPROVED') return 'docsUpload';
      // 2. Quote Sent — quotation submitted to OPS (pending or approved but not yet at docs stage)
      if (lead.opsApprovalStatus === 'PENDING') return 'quoteSent';
      // 1. Feasible — feasibility done, before OPS
      if (lead.status === 'FEASIBLE' || lead.feasibilityReviewedAt) return 'feasible';
      // Dropped at any stage
      if (lead.status === 'DROPPED' || lead.status === 'NOT_FEASIBLE' || lead.opsApprovalStatus === 'REJECTED' || lead.accountsStatus === 'ACCOUNTS_REJECTED') return 'dropped';
      // Default: at BDM qualification
      return 'assignedBDM';
    };

    const distribution = {};
    leads.forEach(lead => {
      const stage = getCurrentStage(lead);
      distribution[stage] = (distribution[stage] || 0) + 1;
    });

    const stageLabels = {
      assignedBDM: 'Assigned to BDM',
      feasible: 'Feasible',
      quoteSent: 'Quote Sent',
      docsUpload: 'Docs Upload',
      docsReview: 'Docs Review',
      accountsReview: 'Accounts Review',
      pushToDelivery: 'Push to Delivery',
      atNOC: 'At NOC',
      installed: 'Delivered / Installed',
      live: 'Live',
      dropped: 'Dropped'
    };

    const pipelineOrder = [
      'assignedBDM', 'feasible', 'quoteSent', 'docsUpload', 'docsReview',
      'accountsReview', 'pushToDelivery', 'atNOC', 'installed', 'live', 'dropped'
    ];

    const stages = pipelineOrder
      .filter(stage => (distribution[stage] || 0) > 0)
      .map(stage => ({
        stage,
        label: stageLabels[stage] || stage,
        count: distribution[stage] || 0,
        percentage: totalConverted > 0 ? Math.round(((distribution[stage] || 0) / totalConverted) * 1000) / 10 : 0
      }));

    const liveCount = distribution.live || 0;
    const droppedCount = distribution.dropped || 0;

    res.json({
      totalConverted,
      stages,
      liveCount,
      droppedCount,
      trueConversionRate: totalConverted > 0 ? Math.round((liveCount / totalConverted) * 1000) / 10 : 0
    });
});

// ISR Pipeline Comparison — per-ISR breakdown for overview page
export const getISRPipelineComparison = asyncHandler(async function getISRPipelineComparison(req, res) {
    const isAdmin = isAdminOrTestUser(req.user);
    const isTL = req.user.role === 'BDM_TEAM_LEADER';
    if (!isAdmin && !isTL) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { period = 'this_month' } = req.query;

    const now = new Date();
    let startDate;

    switch (period) {
      case 'today':
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - startDate.getDay());
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        break;
      case 'this_quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    let endDate = now;
    if (period === 'last_month') {
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    }

    const isrUsers = await prisma.user.findMany({
      where: { role: 'ISR', isActive: true },
      select: { id: true, name: true }
    });

    const leads = await prisma.lead.findMany({
      where: {
        createdById: { in: isrUsers.map(u => u.id) },
        createdAt: { gte: startDate, ...(period === 'last_month' ? { lte: endDate } : {}) },
      },
      select: {
        id: true,
        createdById: true,
        status: true,
        opsApprovalStatus: true,
        accountsStatus: true,
        actualPlanIsActive: true,
        docsVerifiedAt: true,
        accountsVerifiedAt: true,
        customerUsername: true,
        installationCompletedAt: true,
        speedTestUploadedAt: true,
        demoPlanIsActive: true,
        customerAcceptanceAt: true,
      }
    });

    const leadsByISR = {};
    isrUsers.forEach(u => { leadsByISR[u.id] = []; });
    leads.forEach(lead => {
      if (leadsByISR[lead.createdById]) {
        leadsByISR[lead.createdById].push(lead);
      }
    });

    const isrs = isrUsers.map(isr => {
      const isrLeads = leadsByISR[isr.id] || [];
      const converted = isrLeads.length;
      let live = 0;
      let dropped = 0;

      isrLeads.forEach(lead => {
        if (lead.actualPlanIsActive) {
          live++;
        } else if (lead.status === 'DROPPED' || lead.status === 'NOT_FEASIBLE' || lead.opsApprovalStatus === 'REJECTED' || lead.accountsStatus === 'ACCOUNTS_REJECTED') {
          dropped++;
        }
      });

      const inProgress = converted - live - dropped;

      return {
        userId: isr.id,
        name: isr.name,
        converted,
        live,
        trueConversionRate: converted > 0 ? Math.round((live / converted) * 1000) / 10 : 0,
        dropped,
        inProgress
      };
    })
    .filter(isr => isr.converted > 0)
    .sort((a, b) => b.trueConversionRate - a.trueConversionRate);

    res.json({ isrs });
});

// Export campaign-wise data with call outcomes (ISR + Admin)
export const exportCampaignData = asyncHandler(async function exportCampaignData(req, res) {
    const userId = req.user.id;
    const isAdmin = isAdminOrTestUser(req.user);
    const { campaignId, isrId, period = 'this_month' } = req.query;

    // Calculate date range
    const now = new Date();
    let startDate = new Date();

    switch (period) {
      case 'today':
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_week':
        const dayOfWeek = now.getDay();
        const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        startDate.setDate(now.getDate() - diff);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'this_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        now.setDate(0);
        break;
      case 'this_quarter':
        const quarter = Math.floor(now.getMonth() / 3);
        startDate = new Date(now.getFullYear(), quarter * 3, 1);
        break;
      case 'all':
        startDate = new Date(2000, 0, 1);
        break;
      default:
        startDate.setDate(now.getDate() - 7);
    }

    // Determine target user
    let targetUserId = userId;
    if (isAdmin && isrId) {
      targetUserId = isrId;
    }

    // Get campaigns for this user
    let campaignIds = [];
    if (isAdmin && !isrId) {
      if (campaignId && campaignId !== 'all') {
        campaignIds = [campaignId];
      } else {
        const allCampaigns = await prisma.campaign.findMany({ select: { id: true } });
        campaignIds = allCampaigns.map(c => c.id);
      }
    } else {
      const assignments = await prisma.campaignAssignment.findMany({
        where: { userId: targetUserId },
        include: { campaign: { select: { id: true } } }
      });
      campaignIds = assignments.map(a => a.campaign.id);
      if (campaignId && campaignId !== 'all') {
        campaignIds = campaignIds.filter(id => id === campaignId);
      }
    }

    if (campaignIds.length === 0) {
      return res.json({ data: [] });
    }

    // Fetch all campaign data with their latest call log
    const campaignData = await prisma.campaignData.findMany({
      where: {
        campaignId: { in: campaignIds },
        ...((!isAdmin || isrId) ? { assignedToId: targetUserId } : {})
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        name: true,
        phone: true,
        email: true,
        company: true,
        city: true,
        state: true,
        status: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        callLaterAt: true,
        campaign: {
          select: { id: true, name: true, code: true }
        },
        assignedToId: true,
        lead: {
          select: { id: true, status: true }
        },
        callLogs: {
          select: {
            status: true,
            duration: true,
            notes: true,
            createdAt: true
          },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: [
        { campaign: { name: 'asc' } },
        { updatedAt: 'desc' }
      ]
    });

    // Fetch assigned user names
    const assignedUserIds = [...new Set(campaignData.map(d => d.assignedToId).filter(Boolean))];
    const assignedUsers = assignedUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: assignedUserIds } },
          select: { id: true, name: true }
        })
      : [];
    const userNameMap = new Map(assignedUsers.map(u => [u.id, u.name]));

    // Format for export
    const exportData = campaignData.map(item => ({
      campaignName: item.campaign?.name || '',
      campaignCode: item.campaign?.code || '',
      contactName: item.firstName && item.lastName
        ? `${item.firstName} ${item.lastName}`
        : item.name || '',
      phone: item.phone || '',
      email: item.email || '',
      company: item.company || '',
      city: item.city || '',
      state: item.state || '',
      status: item.status || 'NEW',
      lastCallOutcome: item.callLogs?.[0]?.status || 'Not Called',
      lastCallDuration: item.callLogs?.[0]?.duration || 0,
      lastCallNotes: item.callLogs?.[0]?.notes || '',
      lastCallDate: item.callLogs?.[0]?.createdAt || null,
      notes: item.notes || '',
      assignedTo: userNameMap.get(item.assignedToId) || '',
      leadConverted: item.lead ? 'Yes' : 'No',
      leadStatus: item.lead?.status || '',
      callLaterAt: item.callLaterAt || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));

    res.json({ data: exportData });
});
