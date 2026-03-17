import prisma from '../config/db.js';
import { isAdminOrTestUser, hasRole } from '../utils/roleHelper.js';
import { asyncHandler, buildDateFilter, buildSearchFilter } from '../utils/controllerHelper.js';

/**
 * Accounts Dashboard Controller
 *
 * Core Idea: Track how effectively accounts users convert generated bills into received payments
 *
 * All calculations derived from Invoices and Payments tables only (per CLAUDE.md spec)
 */

/**
 * Get dashboard summary and all data
 */
export const getAccountsDashboard = asyncHandler(async function getAccountsDashboard(req, res) {
  const { startDate, endDate, filter, fromDate, toDate } = req.query;

  // Build date filter for invoices
  const invoiceDateFilter = buildDateFilter(startDate, endDate) || {};

  // ===== 1. SUMMARY CARDS =====
  // Use count queries instead of fetching all customers
  const [totalUsers, activeUsers] = await Promise.all([
    prisma.lead.count({
      where: { customerUsername: { not: null } }
    }),
    prisma.lead.count({
      where: { customerUsername: { not: null }, actualPlanIsActive: true }
    })
  ]);

  const deactivatedUsers = totalUsers - activeUsers;

  // ===== 2. CUSTOMER BILLING TABLE DATA =====
  // Get detailed customer data with billing info
  const customersWithBilling = await prisma.lead.findMany({
    where: {
      customerUsername: { not: null },
      // Apply filter based on card clicked
      ...(filter === 'active' ? {
        actualPlanIsActive: true
      } : {}),
      ...(filter === 'deactivated' ? {
        actualPlanIsActive: { not: true }
      } : {})
    },
    include: {
      campaignData: {
        select: {
          company: true,
          name: true,
          phone: true,
          email: true
        }
      },
      invoices: {
        where: {
          status: { not: 'CANCELLED' },
          ...(Object.keys(invoiceDateFilter).length > 0 ? { invoiceDate: invoiceDateFilter } : {})
        },
        include: {
          payments: {
            select: {
              amount: true,
              tdsAmount: true,
              paymentDate: true
            }
          }
        }
      }
    }
  });

  // Calculate billing metrics for each customer
  const customerBillingData = customersWithBilling.map(customer => {
    const invoices = customer.invoices || [];

    // Total Bill Generated = Sum of all invoice grandTotal (excluding cancelled)
    const totalBillGenerated = invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);

    // Total Amount Received = Sum of all payments (amount + tdsAmount)
    const totalReceived = invoices.reduce((sum, inv) => {
      const payments = inv.payments || [];
      return sum + payments.reduce((pSum, p) => pSum + (p.amount || 0) + (p.tdsAmount || 0), 0);
    }, 0);

    // Outstanding = Total Bill Generated - Total Amount Received
    const outstanding = Math.max(0, totalBillGenerated - totalReceived);

    // ARC (Monthly Recurring Charge)
    const arc = customer.arcAmount || (customer.actualPlanPrice ? customer.actualPlanPrice : 0);

    return {
      id: customer.id,
      companyName: customer.campaignData?.company || customer.customerUsername || 'N/A',
      userName: customer.campaignData?.name || '-',
      mobileNo: customer.campaignData?.phone || '-',
      emailId: customer.campaignData?.email || '-',
      arc,
      totalBillGenerated,
      totalReceived,
      outstanding,
      isActive: customer.actualPlanIsActive,
      invoiceCount: invoices.length,
      customerCreatedAt: customer.customerCreatedAt || customer.nocConfiguredAt
    };
  });

  // Sort by outstanding (DESC) as per spec
  customerBillingData.sort((a, b) => b.outstanding - a.outstanding);

  // ===== 3. SALES & COLLECTION TRENDS =====
  const { timeFilter = 'monthly' } = req.query;
  const trendData = await getSalesCollectionTrends(timeFilter, invoiceDateFilter);

  // ===== 4. AVERAGE COLLECTION PERIOD (ACP) =====
  const acpData = await getAverageCollectionPeriod();

  // ===== 5. TOTAL OUTSTANDING SNAPSHOT =====
  const outstandingSnapshot = await getTotalOutstanding(fromDate, toDate);

  // ===== 6. AGEING REPORT DATA =====
  const ageingData = await getAgeingBuckets();

  // ===== 7. NEW USERS ADDED PER MONTH =====
  const newUsersData = await getNewUsersPerMonth();

  res.json({
    summary: {
      totalUsers,
      activeUsers,
      deactivatedUsers
    },
    customers: customerBillingData,
    trends: trendData,
    acp: acpData,
    outstanding: outstandingSnapshot,
    ageing: ageingData,
    newUsers: newUsersData
  });
});

/**
 * Get customers for billing table (with pagination and search)
 */
export const getCustomerBillingTable = asyncHandler(async function getCustomerBillingTable(req, res) {
  const {
    filter, // 'all' | 'active' | 'deactivated'
    search,
    page = 1,
    limit = 20,
    sortBy = 'outstanding',
    sortOrder = 'desc'
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const whereClause = {
    customerUsername: { not: null }
  };

  // Apply filter
  if (filter === 'active') {
    whereClause.actualPlanIsActive = true;
  } else if (filter === 'deactivated') {
    // Not active means false or null (never assigned)
    whereClause.actualPlanIsActive = { not: true };
  }

  // Apply search
  if (search) {
    whereClause.OR = buildSearchFilter(search, [
      'customerUsername',
      'campaignData.company',
      'campaignData.phone',
      'campaignData.email'
    ]);
  }

  const [customers, totalCount] = await Promise.all([
    prisma.lead.findMany({
      where: whereClause,
      include: {
        campaignData: {
          select: { company: true, name: true, phone: true, email: true }
        },
        invoices: {
          where: { status: { not: 'CANCELLED' } },
          include: {
            payments: {
              select: { amount: true, tdsAmount: true }
            }
          }
        }
      },
      skip,
      take: take + 50 // Fetch more to sort properly
    }),
    prisma.lead.count({ where: whereClause })
  ]);

  // Calculate billing metrics
  let customerData = customers.map(customer => {
    const invoices = customer.invoices || [];
    const totalBillGenerated = invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
    const totalReceived = invoices.reduce((sum, inv) => {
      return sum + (inv.payments || []).reduce((pSum, p) => pSum + (p.amount || 0) + (p.tdsAmount || 0), 0);
    }, 0);
    const outstanding = Math.max(0, totalBillGenerated - totalReceived);

    return {
      id: customer.id,
      companyName: customer.campaignData?.company || customer.customerUsername || 'N/A',
      userName: customer.campaignData?.name || '-',
      mobileNo: customer.campaignData?.phone || '-',
      emailId: customer.campaignData?.email || '-',
      arc: customer.arcAmount || customer.actualPlanPrice || 0,
      totalBillGenerated,
      totalReceived,
      outstanding,
      isActive: customer.actualPlanIsActive,
      customerCreatedAt: customer.customerCreatedAt || customer.nocConfiguredAt
    };
  });

  // Sort
  if (sortBy === 'outstanding') {
    customerData.sort((a, b) => sortOrder === 'desc' ? b.outstanding - a.outstanding : a.outstanding - b.outstanding);
  } else if (sortBy === 'totalBillGenerated') {
    customerData.sort((a, b) => sortOrder === 'desc' ? b.totalBillGenerated - a.totalBillGenerated : a.totalBillGenerated - b.totalBillGenerated);
  } else if (sortBy === 'companyName') {
    customerData.sort((a, b) => sortOrder === 'desc' ? b.companyName.localeCompare(a.companyName) : a.companyName.localeCompare(b.companyName));
  }

  // Apply pagination after sorting
  customerData = customerData.slice(0, take);

  res.json({
    customers: customerData,
    pagination: {
      page: parseInt(page),
      limit: take,
      total: totalCount,
      totalPages: Math.ceil(totalCount / take)
    }
  });
});

/**
 * Get ageing report with detailed invoice data
 */
export const getAgeingReport = asyncHandler(async function getAgeingReport(req, res) {
  const { bucket, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);
  const today = new Date();

  // Define bucket ranges (0 = not yet due, included in 1-30)
  const bucketRanges = {
    '1-30': { min: 0, max: 30 },
    '31-60': { min: 31, max: 60 },
    '61-90': { min: 61, max: 90 },
    '90+': { min: 91, max: 9999 }
  };

  // Get all invoices with outstanding balance
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'PAID'] }
    },
    include: {
      payments: {
        select: { amount: true, tdsAmount: true }
      },
      lead: {
        select: {
          campaignData: {
            select: { company: true, phone: true }
          }
        }
      },
      collectionCalls: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          outcome: true,
          promiseDate: true,
          createdAt: true
        }
      }
    },
    orderBy: { dueDate: 'asc' }
  });

  // Calculate outstanding and age for each invoice
  let ageingReport = invoices.map(inv => {
    const totalPaid = (inv.payments || []).reduce((sum, p) => sum + (p.amount || 0) + (p.tdsAmount || 0), 0);
    const outstanding = Math.max(0, inv.grandTotal - totalPaid);

    if (outstanding <= 0) return null;

    // Age = Today - Invoice Date (days since bill generation)
    const invoiceDate = new Date(inv.invoiceDate);
    const ageDays = Math.max(0, Math.floor((today - invoiceDate) / (1000 * 60 * 60 * 24)));

    // Determine age bucket based on days since invoice
    let ageBucket = '1-30';
    if (ageDays > 90) ageBucket = '90+';
    else if (ageDays > 60) ageBucket = '61-90';
    else if (ageDays > 30) ageBucket = '31-60';

    // Get last call info
    const lastCall = inv.collectionCalls?.[0] || null;

    return {
      id: inv.id,
      leadId: inv.leadId,
      companyName: inv.lead?.campaignData?.company || inv.companyName || 'N/A',
      phoneNumber: inv.lead?.campaignData?.phone || inv.contactPhone || null,
      invoiceNo: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      invoiceAmount: inv.grandTotal,
      receivedAmount: totalPaid,
      outstanding,
      ageDays,
      ageBucket,
      lastCall: lastCall ? {
        outcome: lastCall.outcome,
        promiseDate: lastCall.promiseDate,
        calledAt: lastCall.createdAt
      } : null
    };
  }).filter(Boolean);

  // Filter by bucket if specified
  if (bucket && bucketRanges[bucket]) {
    const range = bucketRanges[bucket];
    ageingReport = ageingReport.filter(inv => inv.ageDays >= range.min && inv.ageDays <= range.max);
  }

  // Sort by age (oldest first)
  ageingReport.sort((a, b) => b.ageDays - a.ageDays);

  const total = ageingReport.length;
  const paginatedData = ageingReport.slice(skip, skip + take);

  res.json({
    invoices: paginatedData,
    pagination: {
      page: parseInt(page),
      limit: take,
      total,
      totalPages: Math.ceil(total / take)
    }
  });
});

// ===== HELPER FUNCTIONS =====

/**
 * Get Sales & Collection Trends data
 */
async function getSalesCollectionTrends(timeFilter, dateFilter) {
  const today = new Date();
  let periods = [];
  let groupByFormat;

  if (timeFilter === 'daily') {
    // Last 30 days
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      periods.push({
        key: date.toISOString().split('T')[0],
        label: date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
      });
    }
  } else if (timeFilter === 'weekly') {
    // Last 12 weeks
    for (let i = 11; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - (i * 7));
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      periods.push({
        key: `${weekStart.getFullYear()}-W${Math.ceil((weekStart - new Date(weekStart.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000))}`,
        label: `W${Math.ceil((weekStart - new Date(weekStart.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000))}`,
        startDate: weekStart
      });
    }
  } else {
    // Monthly - last 12 months
    for (let i = 11; i >= 0; i--) {
      const date = new Date(today);
      date.setMonth(date.getMonth() - i);
      periods.push({
        key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        label: date.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
      });
    }
  }

  // Get start date for query
  const startDate = timeFilter === 'daily'
    ? new Date(today.setDate(today.getDate() - 30))
    : timeFilter === 'weekly'
      ? new Date(today.setDate(today.getDate() - 84))
      : new Date(today.setMonth(today.getMonth() - 12));

  // Get invoices (Bills Generated)
  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: startDate },
      status: { not: 'CANCELLED' }
    },
    select: {
      invoiceDate: true,
      grandTotal: true
    }
  });

  // Get payments (Amount Collected)
  const payments = await prisma.invoicePayment.findMany({
    where: {
      paymentDate: { gte: startDate }
    },
    select: {
      paymentDate: true,
      amount: true,
      tdsAmount: true
    }
  });

  // Aggregate data by period
  const trendData = periods.map(period => {
    let billsGenerated = 0;
    let amountCollected = 0;

    invoices.forEach(inv => {
      const invDate = new Date(inv.invoiceDate);
      let invKey;

      if (timeFilter === 'daily') {
        invKey = invDate.toISOString().split('T')[0];
      } else if (timeFilter === 'weekly') {
        const weekNum = Math.ceil((invDate - new Date(invDate.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));
        invKey = `${invDate.getFullYear()}-W${weekNum}`;
      } else {
        invKey = `${invDate.getFullYear()}-${String(invDate.getMonth() + 1).padStart(2, '0')}`;
      }

      if (invKey === period.key) {
        billsGenerated += inv.grandTotal || 0;
      }
    });

    payments.forEach(pay => {
      const payDate = new Date(pay.paymentDate);
      let payKey;

      if (timeFilter === 'daily') {
        payKey = payDate.toISOString().split('T')[0];
      } else if (timeFilter === 'weekly') {
        const weekNum = Math.ceil((payDate - new Date(payDate.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));
        payKey = `${payDate.getFullYear()}-W${weekNum}`;
      } else {
        payKey = `${payDate.getFullYear()}-${String(payDate.getMonth() + 1).padStart(2, '0')}`;
      }

      if (payKey === period.key) {
        amountCollected += (pay.amount || 0) + (pay.tdsAmount || 0);
      }
    });

    return {
      period: period.key,
      label: period.label,
      billsGenerated: Math.round(billsGenerated),
      amountCollected: Math.round(amountCollected)
    };
  });

  return trendData;
}

/**
 * Get Average Collection Period (ACP) data
 * Formula: For each fully paid invoice: (Last Payment Date - Invoice Generation Date)
 * Average across all paid invoices per month
 *
 * Note: We calculate "fully paid" based on actual payments vs grandTotal,
 * not just the status field, to be more robust.
 */
async function getAverageCollectionPeriod() {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  // Get all invoices with payments (not just status=PAID)
  // We'll calculate if they're fully paid based on actual amounts
  const invoicesWithPayments = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: twelveMonthsAgo },
      status: { not: 'CANCELLED' },
      payments: {
        some: {} // Has at least one payment
      }
    },
    include: {
      payments: {
        orderBy: { paymentDate: 'desc' }
      }
    }
  });

  // Calculate ACP per month
  const monthlyACP = {};

  invoicesWithPayments.forEach(inv => {
    if (!inv.payments || inv.payments.length === 0) return;

    // Calculate total paid amount (including TDS)
    const totalPaid = inv.payments.reduce((sum, p) => sum + (p.amount || 0) + (p.tdsAmount || 0), 0);

    // Check if invoice is fully paid (within 1 rupee tolerance for rounding)
    const isFullyPaid = totalPaid >= (inv.grandTotal - 1);

    if (!isFullyPaid) return; // Skip partially paid invoices per spec

    const invoiceDate = new Date(inv.invoiceDate);
    const lastPaymentDate = new Date(inv.payments[0].paymentDate); // payments are ordered desc
    const daysToCollect = Math.max(0, Math.floor((lastPaymentDate - invoiceDate) / (1000 * 60 * 60 * 24)));

    const monthKey = `${invoiceDate.getFullYear()}-${String(invoiceDate.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyACP[monthKey]) {
      monthlyACP[monthKey] = { total: 0, count: 0 };
    }
    monthlyACP[monthKey].total += daysToCollect;
    monthlyACP[monthKey].count++;
  });

  // Generate last 12 months
  const result = [];
  for (let i = 11; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const label = date.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

    const monthData = monthlyACP[key];
    const avgDays = monthData ? Math.round(monthData.total / monthData.count) : 0;

    result.push({
      month: key,
      label,
      avgDaysToCollect: avgDays,
      invoiceCount: monthData?.count || 0
    });
  }

  return result;
}

/**
 * Get Total Outstanding Snapshot
 * Total Bill Generated - Total Amount Received (across all non-cancelled invoices)
 * Optionally filtered by date range
 */
async function getTotalOutstanding(fromDate, toDate) {
  // Build date filter for invoices
  const invoiceDateFilter = { status: { not: 'CANCELLED' } };
  const dateRange = buildDateFilter(fromDate, toDate);
  if (dateRange) {
    invoiceDateFilter.invoiceDate = dateRange;
  }

  // Get sum of invoice grandTotals (excluding cancelled, filtered by date)
  const invoiceTotal = await prisma.invoice.aggregate({
    where: invoiceDateFilter,
    _sum: { grandTotal: true }
  });

  // Build date filter for payments
  const paymentDateFilter = {};
  const paymentDateRange = buildDateFilter(fromDate, toDate);
  if (paymentDateRange) {
    paymentDateFilter.paymentDate = paymentDateRange;
  }

  // Get sum of payments (filtered by date if specified)
  const paymentTotal = await prisma.invoicePayment.aggregate({
    where: Object.keys(paymentDateFilter).length > 0 ? paymentDateFilter : undefined,
    _sum: { amount: true, tdsAmount: true }
  });

  const totalBillGenerated = invoiceTotal._sum.grandTotal || 0;
  const totalReceived = (paymentTotal._sum.amount || 0) + (paymentTotal._sum.tdsAmount || 0);
  const totalOutstanding = Math.max(0, totalBillGenerated - totalReceived);

  return {
    totalBillGenerated,
    totalReceived,
    totalOutstanding
  };
}

/**
 * Get Ageing Buckets data
 * Buckets: 1-30, 31-60, 61-90, 90+ days
 * Age = Today - Invoice Date (days since bill generation)
 */
async function getAgeingBuckets() {
  const today = new Date();

  // Get all unpaid/partially paid invoices
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'PAID'] }
    },
    include: {
      payments: {
        select: { amount: true, tdsAmount: true }
      }
    }
  });

  const buckets = {
    '1-30': { count: 0, amount: 0 },
    '31-60': { count: 0, amount: 0 },
    '61-90': { count: 0, amount: 0 },
    '90+': { count: 0, amount: 0 }
  };

  invoices.forEach(inv => {
    const totalPaid = (inv.payments || []).reduce((sum, p) => sum + (p.amount || 0) + (p.tdsAmount || 0), 0);
    const outstanding = Math.max(0, inv.grandTotal - totalPaid);

    if (outstanding <= 0) return;

    // Age = Today - Invoice Date (days since bill generation)
    const invoiceDate = new Date(inv.invoiceDate);
    const ageDays = Math.floor((today - invoiceDate) / (1000 * 60 * 60 * 24));

    if (ageDays <= 30) {
      buckets['1-30'].count++;
      buckets['1-30'].amount += outstanding;
    } else if (ageDays <= 60) {
      buckets['31-60'].count++;
      buckets['31-60'].amount += outstanding;
    } else if (ageDays <= 90) {
      buckets['61-90'].count++;
      buckets['61-90'].amount += outstanding;
    } else {
      buckets['90+'].count++;
      buckets['90+'].amount += outstanding;
    }
  });

  return Object.entries(buckets).map(([bucket, data]) => ({
    bucket,
    count: data.count,
    amount: Math.round(data.amount)
  }));
}

/**
 * Get New Users Added Per Month
 * Tracks customer acquisition over the last 12 months
 */
async function getNewUsersPerMonth() {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  // Get all customers created in the last 12 months
  // Use nocConfiguredAt (when NOC creates username/password) as the creation date
  const customers = await prisma.lead.findMany({
    where: {
      customerUsername: { not: null },
      OR: [
        { customerCreatedAt: { gte: twelveMonthsAgo } },
        { nocConfiguredAt: { gte: twelveMonthsAgo } }
      ]
    },
    select: {
      id: true,
      customerCreatedAt: true,
      nocConfiguredAt: true
    }
  });

  // Group by month
  const monthlyData = {};

  // Initialize last 12 months
  for (let i = 11; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    monthlyData[key] = 0;
  }

  // Count customers per month (use customerCreatedAt or fall back to nocConfiguredAt)
  customers.forEach(customer => {
    const createdDate = customer.customerCreatedAt || customer.nocConfiguredAt;
    if (createdDate) {
      const date = new Date(createdDate);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyData.hasOwnProperty(key)) {
        monthlyData[key]++;
      }
    }
  });

  // Convert to array format for chart
  const result = Object.entries(monthlyData).map(([month, count]) => {
    const date = new Date(month + '-01');
    return {
      month,
      label: date.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
      count
    };
  });

  // Calculate total new users in the period
  const totalNewUsers = result.reduce((sum, m) => sum + m.count, 0);

  return {
    monthly: result,
    total: totalNewUsers
  };
}

/**
 * Create a collection call log
 */
export const createCollectionCall = asyncHandler(async function createCollectionCall(req, res) {
  const { invoiceId, leadId, startTime, endTime, outcome, promiseDate, remark } = req.body;
  const userId = req.user.id;

  // Calculate duration in seconds
  const start = new Date(startTime);
  const end = new Date(endTime);
  const duration = Math.floor((end - start) / 1000);

  const callLog = await prisma.collectionCallLog.create({
    data: {
      invoiceId,
      leadId,
      userId,
      startTime: start,
      endTime: end,
      duration,
      outcome,
      promiseDate: promiseDate ? new Date(promiseDate) : null,
      remark
    }
  });

  res.status(201).json({ callLog, message: 'Call log saved successfully' });
});

/**
 * Get collection call history for an invoice
 */
export const getCollectionCallHistory = asyncHandler(async function getCollectionCallHistory(req, res) {
  const { invoiceId } = req.params;

  const calls = await prisma.collectionCallLog.findMany({
    where: { invoiceId },
    include: {
      user: {
        select: { name: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.json({ calls });
});

/**
 * Get collection call statistics
 */
export const getCollectionCallStats = asyncHandler(async function getCollectionCallStats(req, res) {
  const { startDate, endDate } = req.query;
  const userId = req.user.id;
  const isAdmin = isAdminOrTestUser(req.user);

  const whereClause = {};

  // Filter by date range
  const dateRange = buildDateFilter(startDate, endDate);
  if (dateRange) {
    whereClause.createdAt = dateRange;
  }

  // Non-admin users can only see their own stats
  if (!isAdmin) {
    whereClause.userId = userId;
  }

  const [totalCalls, outcomeStats, todayCalls] = await Promise.all([
    // Total calls
    prisma.collectionCallLog.count({ where: whereClause }),

    // Calls grouped by outcome
    prisma.collectionCallLog.groupBy({
      by: ['outcome'],
      where: whereClause,
      _count: { outcome: true }
    }),

    // Today's calls
    prisma.collectionCallLog.count({
      where: {
        ...whereClause,
        createdAt: {
          gte: new Date(new Date().setHours(0, 0, 0, 0))
        }
      }
    })
  ]);

  res.json({
    totalCalls,
    todayCalls,
    outcomeStats: outcomeStats.map(s => ({
      outcome: s.outcome,
      count: s._count.outcome
    }))
  });
});

/**
 * Get all collection calls with pagination and filters
 */
export const getAllCollectionCalls = asyncHandler(async function getAllCollectionCalls(req, res) {
  const { page = 1, limit = 20, outcome, startDate, endDate, search } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const userId = req.user.id;
  const isAdmin = isAdminOrTestUser(req.user);

  // Build where clause
  const whereClause = {};

  // Non-admin users can only see their own calls
  if (!isAdmin) {
    whereClause.userId = userId;
  }

  // Filter by outcome
  if (outcome && outcome !== 'all') {
    whereClause.outcome = outcome;
  }

  // Filter by date range
  const dateRange = buildDateFilter(startDate, endDate);
  if (dateRange) {
    whereClause.createdAt = dateRange;
  }

  // Search by company name or invoice number
  if (search) {
    whereClause.OR = buildSearchFilter(search, [
      'invoice.companyName',
      'invoice.invoiceNumber'
    ]);
  }

  const [calls, totalCount] = await Promise.all([
    prisma.collectionCallLog.findMany({
      where: whereClause,
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            companyName: true,
            grandTotal: true,
            contactPhone: true,
            lead: {
              select: {
                id: true,
                campaignData: {
                  select: {
                    company: true,
                    phone: true
                  }
                }
              }
            }
          }
        },
        user: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take
    }),
    prisma.collectionCallLog.count({ where: whereClause })
  ]);

  // Format the response
  const formattedCalls = calls.map(call => ({
    id: call.id,
    invoiceId: call.invoiceId,
    invoiceNo: call.invoice?.invoiceNumber,
    companyName: call.invoice?.lead?.campaignData?.company || call.invoice?.companyName || 'N/A',
    phoneNumber: call.invoice?.lead?.campaignData?.phone || call.invoice?.contactPhone,
    invoiceAmount: call.invoice?.grandTotal,
    leadId: call.invoice?.lead?.id,
    calledBy: call.user?.name,
    calledById: call.user?.id,
    startTime: call.startTime,
    endTime: call.endTime,
    duration: call.duration,
    outcome: call.outcome,
    promiseDate: call.promiseDate,
    remark: call.remark,
    createdAt: call.createdAt
  }));

  // Get outcome summary for filters
  const outcomeSummary = await prisma.collectionCallLog.groupBy({
    by: ['outcome'],
    where: isAdmin ? {} : { userId },
    _count: { outcome: true }
  });

  res.json({
    calls: formattedCalls,
    pagination: {
      page: parseInt(page),
      limit: take,
      total: totalCount,
      totalPages: Math.ceil(totalCount / take)
    },
    outcomeSummary: outcomeSummary.map(s => ({
      outcome: s.outcome,
      count: s._count.outcome
    }))
  });
});

/**
 * Get business overview stats for admin dashboard
 * Returns: totals + per-customer breakdown of quotation, bills, collection
 */
export const getBusinessOverview = asyncHandler(async function getBusinessOverview(req, res) {
  if (!isAdminOrTestUser(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  // Fetch all OPS-approved leads with their invoices, payments, and delivery status
  const leads = await prisma.lead.findMany({
    where: { opsApprovalStatus: 'APPROVED' },
    select: {
      id: true,
      arcAmount: true,
      otcAmount: true,
      deliveryStatus: true,
      campaignData: {
        select: { company: true, name: true, phone: true }
      },
      invoices: {
        where: { status: { not: 'CANCELLED' } },
        select: {
          grandTotal: true,
          payments: {
            select: { amount: true, tdsAmount: true }
          }
        }
      }
    }
  });

  let totalDeliveredAmount = 0;
  let totalBillsGenerated = 0;
  let totalCollected = 0;

  const customers = leads.map(lead => {
    const quotationAmount = (lead.arcAmount || 0) + (lead.otcAmount || 0);
    const isDelivered = lead.deliveryStatus === 'COMPLETED';
    const billsGenerated = lead.invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
    const amountCollected = lead.invoices.reduce((sum, inv) => {
      return sum + (inv.payments || []).reduce((pSum, p) => pSum + (p.amount || 0) + (p.tdsAmount || 0), 0);
    }, 0);

    if (isDelivered) totalDeliveredAmount += quotationAmount;
    totalBillsGenerated += billsGenerated;
    totalCollected += amountCollected;

    return {
      id: lead.id,
      company: lead.campaignData?.company || 'N/A',
      contactName: lead.campaignData?.name || '-',
      phone: lead.campaignData?.phone || '-',
      quotationAmount,
      isDelivered,
      billsGenerated,
      amountCollected
    };
  });

  // Sort: delivered first, then by quotation amount descending
  customers.sort((a, b) => {
    if (a.isDelivered !== b.isDelivered) return a.isDelivered ? -1 : 1;
    return b.quotationAmount - a.quotationAmount;
  });

  res.json({
    totalDeliveredAmount,
    totalBillsGenerated,
    totalCollected,
    customers
  });
});

export default {
  getAccountsDashboard,
  getCustomerBillingTable,
  getAgeingReport,
  createCollectionCall,
  getCollectionCallHistory,
  getCollectionCallStats,
  getAllCollectionCalls,
  getBusinessOverview
};
