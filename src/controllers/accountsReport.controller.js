import prisma from '../config/db.js';
import { asyncHandler, parsePagination, buildDateFilter, buildSearchFilter } from '../utils/controllerHelper.js';

/**
 * Get Accounts Reports with detailed metrics
 * Shows customer data, billing info, invoices generated vs received
 */
export const getAccountsReport = asyncHandler(async function getAccountsReport(req, res) {
    const { startDate, endDate } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 50);

    // Build date filter
    const dateFilter = buildDateFilter(startDate, endDate);

    const reportWhere = {
      customerUsername: { not: null },
      ...(dateFilter ? { createdAt: dateFilter } : {})
    };

    // Get customers with billing info - paginated
    const [customers, reportTotal] = await Promise.all([
      prisma.lead.findMany({
        where: reportWhere,
        include: {
          campaignData: {
            select: { company: true, name: true, phone: true, email: true }
          },
          invoices: {
            include: {
              payments: true,
              creditNotes: true
            }
          },
          createdBy: {
            select: { id: true, name: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip
      }),
      prisma.lead.count({ where: reportWhere })
    ]);

    // Calculate metrics for each customer
    const customerData = customers.map(customer => {
      const invoices = customer.invoices || [];
      const totalInvoiced = invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
      const totalReceived = invoices.reduce((sum, inv) => {
        const payments = inv.payments || [];
        return sum + payments.reduce((pSum, p) => pSum + (p.amount || 0) + (p.tdsAmount || 0), 0);
      }, 0);
      const totalCreditNotes = invoices.reduce((sum, inv) => sum + (inv.totalCreditAmount || 0), 0);
      const pendingAmount = totalInvoiced - totalReceived - totalCreditNotes;

      // Calculate OTC info
      const otcInvoice = invoices.find(inv => inv.invoiceNumber?.startsWith('OTC/'));
      const regularInvoices = invoices.filter(inv => !inv.invoiceNumber?.startsWith('OTC/'));

      return {
        id: customer.id,
        companyName: customer.campaignData?.company || customer.customerUsername,
        customerUsername: customer.customerUsername,
        contactName: customer.campaignData?.name,
        phone: customer.campaignData?.phone,
        email: customer.campaignData?.email,
        createdAt: customer.createdAt,
        billingStartDate: customer.actualPlanStartDate,
        planName: customer.actualPlanName,
        planPrice: customer.actualPlanPrice,
        billingCycle: customer.actualPlanBillingCycle,
        arc: customer.arcAmount || (customer.actualPlanPrice ? customer.actualPlanPrice * 12 : 0),
        otcAmount: customer.otcAmount || 0,
        otcPaid: otcInvoice ? (otcInvoice.status === 'PAID') : null,
        totalInvoices: invoices.length,
        regularInvoices: regularInvoices.length,
        totalInvoiced,
        totalReceived,
        totalCreditNotes,
        pendingAmount: Math.max(0, pendingAmount),
        collectionRate: totalInvoiced > 0 ? Math.round((totalReceived / totalInvoiced) * 100) : 0,
        isActive: customer.actualPlanIsActive === true,
        status: customer.status,
        createdBy: customer.createdBy?.name
      };
    });

    // Calculate summary metrics from aggregate queries (not from paginated data)
    const [totalCustomerCount, activeCustomerCount, invoiceAgg, paymentAgg, creditNoteAgg] = await Promise.all([
      prisma.lead.count({ where: reportWhere }),
      prisma.lead.count({ where: { ...reportWhere, actualPlanIsActive: true } }),
      prisma.invoice.aggregate({
        where: { lead: reportWhere },
        _sum: { grandTotal: true }
      }),
      prisma.invoicePayment.aggregate({
        where: { invoice: { lead: reportWhere } },
        _sum: { amount: true, tdsAmount: true }
      }),
      prisma.invoice.aggregate({
        where: { lead: reportWhere },
        _sum: { totalCreditAmount: true }
      })
    ]);

    const totalInvoicedAll = invoiceAgg._sum.grandTotal || 0;
    const totalReceivedAll = (paymentAgg._sum.amount || 0) + (paymentAgg._sum.tdsAmount || 0);
    const totalCreditNotesAll = creditNoteAgg._sum.totalCreditAmount || 0;

    const summary = {
      totalCustomers: totalCustomerCount,
      activeCustomers: activeCustomerCount,
      totalARC: customerData.reduce((sum, c) => sum + (c.arc || 0), 0),
      totalOTC: customerData.reduce((sum, c) => sum + (c.otcAmount || 0), 0),
      totalInvoiced: totalInvoicedAll,
      totalReceived: totalReceivedAll,
      totalCreditNotes: totalCreditNotesAll,
      totalPending: Math.max(0, totalInvoicedAll - totalReceivedAll - totalCreditNotesAll),
      avgCollectionRate: totalInvoicedAll > 0
        ? Math.round((totalReceivedAll / totalInvoicedAll) * 100)
        : 0
    };

    // Monthly trend data (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyInvoices = await prisma.invoice.groupBy({
      by: ['invoiceDate'],
      where: {
        invoiceDate: { gte: sixMonthsAgo }
      },
      _sum: {
        grandTotal: true
      },
      _count: {
        id: true
      }
    });

    const monthlyPayments = await prisma.invoicePayment.groupBy({
      by: ['createdAt'],
      where: {
        createdAt: { gte: sixMonthsAgo }
      },
      _sum: {
        amount: true,
        tdsAmount: true
      },
      _count: {
        id: true
      }
    });

    // Aggregate by month
    const monthlyData = {};
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months.push(key);
      monthlyData[key] = { invoiced: 0, received: 0, invoiceCount: 0, paymentCount: 0 };
    }

    monthlyInvoices.forEach(item => {
      const d = new Date(item.invoiceDate);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyData[key]) {
        monthlyData[key].invoiced += item._sum.grandTotal || 0;
        monthlyData[key].invoiceCount += item._count.id || 0;
      }
    });

    monthlyPayments.forEach(item => {
      const d = new Date(item.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyData[key]) {
        monthlyData[key].received += (item._sum.amount || 0) + (item._sum.tdsAmount || 0);
        monthlyData[key].paymentCount += item._count.id || 0;
      }
    });

    const trendData = months.map(month => ({
      month,
      label: new Date(month + '-01').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
      invoiced: Math.round(monthlyData[month].invoiced),
      received: Math.round(monthlyData[month].received),
      invoiceCount: monthlyData[month].invoiceCount,
      paymentCount: monthlyData[month].paymentCount
    }));

    // Invoice status distribution
    const statusDistribution = await prisma.invoice.groupBy({
      by: ['status'],
      _count: { id: true },
      _sum: { grandTotal: true }
    });

    // Billing cycle distribution
    const billingCycleDistribution = customerData.reduce((acc, c) => {
      const cycle = c.billingCycle || 'Unknown';
      if (!acc[cycle]) acc[cycle] = { count: 0, arc: 0 };
      acc[cycle].count++;
      acc[cycle].arc += c.arc || 0;
      return acc;
    }, {});

    res.json({
      summary,
      customers: customerData,
      trendData,
      statusDistribution: statusDistribution.map(s => ({
        status: s.status,
        count: s._count.id,
        amount: s._sum.grandTotal || 0
      })),
      billingCycleDistribution: Object.entries(billingCycleDistribution).map(([cycle, data]) => ({
        cycle,
        count: data.count,
        arc: data.arc
      })),
      pagination: { page, limit, total: reportTotal, totalPages: Math.ceil(reportTotal / limit) }
    });
});

/**
 * Get daily collection report
 * Payment-driven report - each row represents one payment transaction
 * Supports date range, pagination, and search
 */
export const getDailyCollectionReport = asyncHandler(async function getDailyCollectionReport(req, res) {
    const {
      fromDate,
      toDate,
      search = '',
      sortBy = 'paymentDate',
      sortOrder = 'desc'
    } = req.query;
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query, 50);

    // Default to today if no dates provided
    const startDate = fromDate ? new Date(fromDate) : new Date();
    startDate.setHours(0, 0, 0, 0);

    const endDate = toDate ? new Date(toDate) : new Date();
    endDate.setHours(23, 59, 59, 999);

    // Build where clause
    const whereClause = {
      paymentDate: {
        gte: startDate,
        lte: endDate
      }
    };

    // Add search filter if provided
    const searchOR = buildSearchFilter(search?.trim(), [
      'receiptNumber',
      'bankAccount',
      'invoice.companyName',
      'invoice.invoiceNumber',
      'invoice.customerUsername'
    ]);
    if (searchOR) {
      whereClause.OR = searchOR;
    }

    // Get total count for pagination
    const totalCount = await prisma.invoicePayment.count({ where: whereClause });

    // Determine sort order
    let orderBy = {};
    if (sortBy === 'paymentDate') {
      orderBy = { paymentDate: sortOrder === 'asc' ? 'asc' : 'desc' };
    } else if (sortBy === 'receiptNumber') {
      orderBy = { receiptNumber: sortOrder === 'asc' ? 'asc' : 'desc' };
    } else if (sortBy === 'amount') {
      orderBy = { amount: sortOrder === 'asc' ? 'asc' : 'desc' };
    } else {
      orderBy = [{ paymentDate: 'desc' }, { receiptNumber: 'asc' }];
    }

    // Get payments with full invoice and customer details
    const payments = await prisma.invoicePayment.findMany({
      where: whereClause,
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            companyName: true,
            customerUsername: true,
            grandTotal: true,
            totalPaidAmount: true,
            totalCreditAmount: true,
            remainingAmount: true,
            contactPhone: true,
            lead: {
              select: {
                id: true,
                campaignData: {
                  select: {
                    name: true,
                    phone: true,
                    email: true
                  }
                }
              }
            }
          }
        },
        createdBy: {
          select: { id: true, name: true }
        }
      },
      orderBy,
      skip,
      take: limitNum
    });

    // Calculate summary
    const summaryData = await prisma.invoicePayment.aggregate({
      where: whereClause,
      _sum: {
        amount: true,
        tdsAmount: true
      },
      _count: {
        id: true
      }
    });

    // Format payments data with all required columns
    const formattedPayments = payments.map(payment => {
      const invoice = payment.invoice;
      const pendingAmount = invoice ?
        Math.max(0, (invoice.grandTotal || 0) - (invoice.totalPaidAmount || 0) - (invoice.totalCreditAmount || 0)) :
        0;

      return {
        id: payment.id,
        // Customer info
        customerName: invoice?.companyName || '-',
        userName: invoice?.customerUsername || invoice?.lead?.campaignData?.name || '-',
        // Invoice info
        invoiceNumber: invoice?.invoiceNumber || '-',
        invoiceAmount: invoice?.grandTotal || 0,
        // Payment info
        paymentMode: payment.paymentMode || '-',
        receiptNumber: payment.receiptNumber || '-',
        transactionId: payment.bankAccount || payment.provisionalReceiptNo || null,
        paymentDate: payment.paymentDate || payment.transactionDate || payment.createdAt,
        receivedAmount: payment.amount || 0,
        tdsAmount: payment.tdsAmount || 0,
        pendingAmount: pendingAmount,
        // Additional info
        remark: payment.remark || null,
        createdBy: payment.createdBy?.name || '-',
        createdAt: payment.createdAt,
        // For drill-down
        invoiceId: invoice?.id,
        leadId: invoice?.lead?.id
      };
    });

    // Summary calculations
    const totalReceived = (summaryData._sum.amount || 0);
    const totalTds = (summaryData._sum.tdsAmount || 0);
    const totalCollection = totalReceived + totalTds;

    res.json({
      payments: formattedPayments,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      summary: {
        totalPayments: summaryData._count.id || 0,
        totalReceived: totalReceived,
        totalTds: totalTds,
        totalCollection: totalCollection
      },
      filters: {
        fromDate: startDate.toISOString().split('T')[0],
        toDate: endDate.toISOString().split('T')[0],
        search: search || null
      }
    });
});

/**
 * Get Invoice Report
 * Invoice-driven report - each row represents one invoice
 * Supports date range, pagination, and search
 * Excludes cancelled and draft invoices
 */
export const getInvoiceReport = asyncHandler(async function getInvoiceReport(req, res) {
    const {
      fromDate,
      toDate,
      search = ''
    } = req.query;
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query, 50);

    // Default to current month if no dates provided
    const now = new Date();
    const startDate = fromDate ? new Date(fromDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = toDate ? new Date(toDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59, 999);

    // Build where clause - exclude CANCELLED invoices
    const whereClause = {
      invoiceDate: {
        gte: startDate,
        lte: endDate
      },
      status: {
        notIn: ['CANCELLED']
      }
    };

    // Add search filter if provided
    const searchOR = buildSearchFilter(search?.trim(), [
      'invoiceNumber',
      'companyName',
      'customerUsername',
      'planName',
      'billingAddress',
      'installationAddress'
    ]);
    if (searchOR) {
      whereClause.OR = searchOR;
    }

    // Get total count for pagination
    const totalCount = await prisma.invoice.count({ where: whereClause });

    // Get invoices with lead details
    const invoices = await prisma.invoice.findMany({
      where: whereClause,
      include: {
        lead: {
          select: {
            id: true,
            arcAmount: true,
            otcAmount: true,
            billingAddress: true,
            billingPincode: true,
            installationAddress: true,
            installationPincode: true,
            campaignData: {
              select: {
                name: true,
                company: true,
                phone: true,
                email: true
              }
            }
          }
        }
      },
      orderBy: [
        { invoiceDate: 'desc' },
        { invoiceNumber: 'asc' }
      ],
      skip,
      take: limitNum
    });

    // Calculate summary
    const summaryData = await prisma.invoice.aggregate({
      where: whereClause,
      _sum: {
        baseAmount: true,
        taxableAmount: true,
        sgstAmount: true,
        cgstAmount: true,
        grandTotal: true
      },
      _count: {
        id: true
      }
    });

    // Extract pincode from address (last 6 digits)
    const extractPincode = (address) => {
      if (!address) return '-';
      const match = address.match(/\d{6}/);
      return match ? match[0] : '-';
    };

    // Format invoices data with all required columns
    const formattedInvoices = invoices.map(invoice => {
      const lead = invoice.lead;

      return {
        id: invoice.id,
        leadId: lead?.id,
        // Customer info
        userName: invoice.customerUsername || lead?.campaignData?.name || invoice.companyName || '-',
        companyName: invoice.companyName || lead?.campaignData?.company || '-',
        // Address details
        billingAddress: lead?.billingAddress || invoice.billingAddress || '-',
        billingPincode: lead?.billingPincode || extractPincode(invoice.billingAddress),
        installationAddress: lead?.installationAddress || invoice.installationAddress || '-',
        installationPincode: lead?.installationPincode || extractPincode(invoice.installationAddress),
        // Invoice info
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        // Plan & Charges
        arc: lead?.arcAmount || 0,
        otc: lead?.otcAmount || 0,
        planName: invoice.planName || '-',
        // Amounts
        planAmount: invoice.taxableAmount || invoice.baseAmount || 0, // Excl. GST
        cgst: invoice.cgstAmount || 0,
        sgst: invoice.sgstAmount || 0,
        totalAmount: invoice.grandTotal || 0,
        // Additional info
        status: invoice.status,
        billingPeriodStart: invoice.billingPeriodStart,
        billingPeriodEnd: invoice.billingPeriodEnd
      };
    });

    // Summary calculations
    const totalBaseAmount = summaryData._sum.taxableAmount || summaryData._sum.baseAmount || 0;
    const totalCgst = summaryData._sum.cgstAmount || 0;
    const totalSgst = summaryData._sum.sgstAmount || 0;
    const totalGrandTotal = summaryData._sum.grandTotal || 0;

    res.json({
      invoices: formattedInvoices,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      summary: {
        totalInvoices: summaryData._count.id || 0,
        totalBaseAmount: totalBaseAmount,
        totalCgst: totalCgst,
        totalSgst: totalSgst,
        totalGst: totalCgst + totalSgst,
        totalAmount: totalGrandTotal
      },
      filters: {
        fromDate: startDate.toISOString().split('T')[0],
        toDate: endDate.toISOString().split('T')[0],
        search: search || null
      }
    });
});

/**
 * Get Outstanding Report
 * Invoice-balance-driven report - shows unpaid and partially paid invoices
 * Each row = one invoice with Outstanding > 0
 */
export const getOutstandingReport = asyncHandler(async function getOutstandingReport(req, res) {
    const {
      asOnDate,
      fromDate,
      toDate,
      search = '',
      ageBucket = ''
    } = req.query;

    // Support both old (asOnDate) and new (fromDate/toDate) parameter formats
    // For outstanding report, we calculate outstanding as of the "toDate" or "asOnDate"
    const reportDate = toDate ? new Date(toDate) : (asOnDate ? new Date(asOnDate) : new Date());
    reportDate.setHours(23, 59, 59, 999);

    // Optional: filter invoices created after fromDate
    const invoiceStartDate = fromDate ? new Date(fromDate) : null;
    if (invoiceStartDate) {
      invoiceStartDate.setHours(0, 0, 0, 0);
    }

    // Build where clause - only invoices with remaining amount > 0
    const whereClause = {
      invoiceDate: {
        lte: reportDate
      },
      status: {
        notIn: ['CANCELLED', 'PAID']
      },
      OR: [
        { remainingAmount: { gt: 0 } },
        { remainingAmount: null } // Include invoices where remainingAmount hasn't been calculated
      ]
    };

    // Add fromDate filter if provided
    if (invoiceStartDate) {
      whereClause.invoiceDate.gte = invoiceStartDate;
    }

    // Add search filter if provided
    const searchOR = buildSearchFilter(search?.trim(), [
      'invoiceNumber',
      'companyName',
      'customerUsername'
    ]);
    if (searchOR) {
      whereClause.AND = [{ OR: searchOR }];
    }

    // Get all matching invoices first to calculate age and filter by bucket
    const allInvoices = await prisma.invoice.findMany({
      where: whereClause,
      include: {
        lead: {
          select: {
            id: true,
            campaignData: {
              select: {
                name: true,
                company: true,
                phone: true,
                email: true
              }
            }
          }
        },
        payments: {
          select: {
            amount: true,
            tdsAmount: true,
            paymentDate: true
          },
          where: {
            paymentDate: {
              lte: reportDate
            }
          }
        }
      },
      orderBy: [
        { invoiceDate: 'desc' }
      ]
    });

    // Calculate outstanding and age for each invoice
    const calculateAgeBucket = (days) => {
      if (days <= 30) return '1-30';
      if (days <= 60) return '31-60';
      if (days <= 90) return '61-90';
      return '90+';
    };

    let processedInvoices = allInvoices.map(invoice => {
      // Calculate received amount and TDS from payments up to reportDate
      const receivedAmount = invoice.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
      const tdsAmount = invoice.payments.reduce((sum, p) => sum + (p.tdsAmount || 0), 0);

      // Calculate outstanding
      const creditAmount = invoice.totalCreditAmount || 0;
      const outstanding = Math.max(0, (invoice.grandTotal || 0) - receivedAmount - tdsAmount - creditAmount);

      // Calculate age in days from invoice generation date
      const invoiceDateObj = new Date(invoice.invoiceDate);
      const ageDays = invoiceDateObj && !isNaN(invoiceDateObj.getTime())
        ? Math.max(0, Math.floor((reportDate - invoiceDateObj) / (1000 * 60 * 60 * 24)))
        : 0;
      const bucket = calculateAgeBucket(ageDays);

      return {
        id: invoice.id,
        leadId: invoice.lead?.id,
        customerName: invoice.companyName || invoice.lead?.campaignData?.company || '-',
        userName: invoice.customerUsername || invoice.lead?.campaignData?.name || '-',
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        invoiceAmount: invoice.grandTotal || 0,
        receivedAmount: receivedAmount,
        tdsAmount: tdsAmount,
        outstandingAmount: outstanding,
        ageDays: ageDays,
        ageBucket: bucket
      };
    });

    // Filter out fully paid invoices (outstanding = 0)
    processedInvoices = processedInvoices.filter(inv => inv.outstandingAmount > 0);

    // Filter by age bucket if specified
    if (ageBucket && ageBucket.trim()) {
      processedInvoices = processedInvoices.filter(inv => inv.ageBucket === ageBucket);
    }

    // Sort by outstanding DESC, then age DESC
    processedInvoices.sort((a, b) => {
      if (b.outstandingAmount !== a.outstandingAmount) {
        return b.outstandingAmount - a.outstandingAmount;
      }
      return b.ageDays - a.ageDays;
    });

    // Calculate totals
    const totalOutstanding = processedInvoices.reduce((sum, inv) => sum + inv.outstandingAmount, 0);
    const totalInvoiceAmount = processedInvoices.reduce((sum, inv) => sum + inv.invoiceAmount, 0);
    const totalReceived = processedInvoices.reduce((sum, inv) => sum + inv.receivedAmount, 0);
    const totalTds = processedInvoices.reduce((sum, inv) => sum + inv.tdsAmount, 0);

    // Pagination
    const totalCount = processedInvoices.length;
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query, 50);

    const paginatedInvoices = processedInvoices.slice(skip, skip + limitNum);

    res.json({
      invoices: paginatedInvoices,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      summary: {
        totalInvoices: totalCount,
        totalInvoiceAmount: totalInvoiceAmount,
        totalReceived: totalReceived,
        totalTds: totalTds,
        totalOutstanding: totalOutstanding
      },
      filters: {
        fromDate: invoiceStartDate ? invoiceStartDate.toISOString().split('T')[0] : null,
        toDate: reportDate.toISOString().split('T')[0],
        asOnDate: reportDate.toISOString().split('T')[0], // For backward compatibility
        search: search || null,
        ageBucket: ageBucket || null
      }
    });
});

/**
 * Get Tax Report (TDS-Centric)
 * Customer-wise summary of TDS deductions
 * Each row = one customer (aggregated)
 */
export const getTaxReport = asyncHandler(async function getTaxReport(req, res) {
    const {
      fromDate,
      toDate,
      search = ''
    } = req.query;

    // Default to current month if no dates provided
    const now = new Date();
    const startDate = fromDate ? new Date(fromDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = toDate ? new Date(toDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59, 999);

    // Get all payments with TDS in the date range
    const payments = await prisma.invoicePayment.findMany({
      where: {
        paymentDate: {
          gte: startDate,
          lte: endDate
        },
        tdsAmount: {
          gt: 0
        }
      },
      include: {
        invoice: {
          select: {
            leadId: true,
            companyName: true,
            customerUsername: true,
            buyerGstNo: true,
            contactPhone: true,
            contactEmail: true,
            lead: {
              select: {
                id: true,
                customerGstNo: true,
                tanNumber: true,
                campaignData: {
                  select: {
                    name: true,
                    company: true,
                    phone: true,
                    email: true
                  }
                }
              }
            }
          }
        }
      }
    });

    // Aggregate by customer (leadId)
    const customerMap = new Map();

    payments.forEach(payment => {
      const invoice = payment.invoice;
      const lead = invoice?.lead;
      const leadId = invoice?.leadId;

      if (!leadId) return;

      if (!customerMap.has(leadId)) {
        customerMap.set(leadId, {
          leadId: leadId,
          userName: invoice.customerUsername || lead?.campaignData?.name || invoice.companyName || '-',
          companyName: invoice.companyName || lead?.campaignData?.company || '-',
          mobileNumber: invoice.contactPhone || lead?.campaignData?.phone || '-',
          emailId: invoice.contactEmail || lead?.campaignData?.email || '-',
          gstNumber: invoice.buyerGstNo || lead?.customerGstNo || '-',
          tanNumber: lead?.tanNumber || '-',
          totalTdsCollected: 0
        });
      }

      const customer = customerMap.get(leadId);
      customer.totalTdsCollected += payment.tdsAmount || 0;
    });

    // Convert to array and filter by search
    let customers = Array.from(customerMap.values());

    if (search && search.trim()) {
      const searchTerm = search.trim().toLowerCase();
      customers = customers.filter(c =>
        c.userName.toLowerCase().includes(searchTerm) ||
        c.companyName.toLowerCase().includes(searchTerm) ||
        c.mobileNumber.includes(searchTerm) ||
        c.emailId.toLowerCase().includes(searchTerm) ||
        c.gstNumber.toLowerCase().includes(searchTerm)
      );
    }

    // Sort by TDS DESC
    customers.sort((a, b) => b.totalTdsCollected - a.totalTdsCollected);

    // Calculate totals
    const totalTdsCollected = customers.reduce((sum, c) => sum + c.totalTdsCollected, 0);

    // Pagination
    const totalCount = customers.length;
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query, 50);

    const paginatedCustomers = customers.slice(skip, skip + limitNum);

    res.json({
      customers: paginatedCustomers,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      summary: {
        totalCustomers: totalCount,
        totalTdsCollected: totalTdsCollected
      },
      filters: {
        fromDate: startDate.toISOString().split('T')[0],
        toDate: endDate.toISOString().split('T')[0],
        search: search || null
      }
    });
});

/**
 * Get Credit Note Report
 * Shows all credit notes with invoice details
 * Each row = one credit note
 */
export const getCreditNoteReport = asyncHandler(async function getCreditNoteReport(req, res) {
    const {
      fromDate,
      toDate,
      search = '',
      status = '',
      reason = ''
    } = req.query;

    // Default to current month if no dates provided
    const now = new Date();
    const startDate = fromDate ? new Date(fromDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = toDate ? new Date(toDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59, 999);

    // Build where clause
    const whereClause = {
      creditNoteDate: {
        gte: startDate,
        lte: endDate
      }
    };

    // Filter by status
    if (status && status !== 'all') {
      whereClause.status = status;
    }

    // Filter by reason
    if (reason && reason !== 'all') {
      whereClause.reason = reason;
    }

    // Add search filter if provided
    const searchOR = buildSearchFilter(search?.trim(), [
      'creditNoteNumber',
      'invoice.invoiceNumber',
      'invoice.companyName',
      'invoice.customerUsername'
    ]);
    if (searchOR) {
      whereClause.OR = searchOR;
    }

    // Get total count for pagination
    const totalCount = await prisma.creditNote.count({ where: whereClause });

    // Calculate pagination
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query, 50);

    // Get credit notes with full details
    const creditNotes = await prisma.creditNote.findMany({
      where: whereClause,
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
            invoiceDate: true,
            companyName: true,
            customerUsername: true,
            grandTotal: true,
            lead: {
              select: {
                id: true,
                campaignData: {
                  select: {
                    name: true,
                    company: true,
                    phone: true,
                    email: true
                  }
                }
              }
            }
          }
        },
        adjustedAgainstInvoice: {
          select: {
            invoiceNumber: true,
            invoiceDate: true
          }
        },
        createdBy: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: [
        { creditNoteDate: 'desc' },
        { creditNoteNumber: 'desc' }
      ],
      skip,
      take: limitNum
    });

    // Calculate summary
    const summaryData = await prisma.creditNote.aggregate({
      where: whereClause,
      _sum: {
        baseAmount: true,
        totalGstAmount: true,
        totalAmount: true
      },
      _count: {
        id: true
      }
    });

    // Format credit notes data
    const formattedCreditNotes = creditNotes.map(cn => {
      const invoice = cn.invoice;

      return {
        id: cn.id,
        // Credit Note Details
        creditNoteNumber: cn.creditNoteNumber,
        creditNoteDate: cn.creditNoteDate,
        // Invoice Details
        invoiceNumber: invoice?.invoiceNumber || '-',
        invoiceDate: invoice?.invoiceDate,
        invoiceAmount: invoice?.grandTotal || 0,
        // Customer Details
        customerName: invoice?.companyName || invoice?.lead?.campaignData?.company || '-',
        userName: invoice?.customerUsername || invoice?.lead?.campaignData?.name || '-',
        // Amounts
        baseAmount: cn.baseAmount,
        sgstAmount: cn.sgstAmount,
        cgstAmount: cn.cgstAmount,
        totalGstAmount: cn.totalGstAmount,
        totalAmount: cn.totalAmount,
        // Credit Note Info
        reason: cn.reason,
        status: cn.status,
        remarks: cn.remarks || '-',
        // Adjustment/Refund Details
        adjustedAgainstInvoice: cn.adjustedAgainstInvoice?.invoiceNumber || null,
        adjustedAt: cn.adjustedAt,
        refundedAt: cn.refundedAt,
        refundReference: cn.refundReference || null,
        refundMode: cn.refundMode || null,
        // Audit
        createdBy: cn.createdBy?.name || '-',
        createdAt: cn.createdAt,
        // For drill-down
        leadId: invoice?.lead?.id
      };
    });

    res.json({
      creditNotes: formattedCreditNotes,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      summary: {
        totalCreditNotes: summaryData._count.id || 0,
        totalBaseAmount: summaryData._sum.baseAmount || 0,
        totalGstAmount: summaryData._sum.totalGstAmount || 0,
        totalCreditAmount: summaryData._sum.totalAmount || 0
      },
      filters: {
        fromDate: startDate.toISOString().split('T')[0],
        toDate: endDate.toISOString().split('T')[0],
        search: search || null,
        status: status || null,
        reason: reason || null
      }
    });
});

/**
 * Get Business Impact Report
 * Shows ARC changes due to upgrades/downgrades
 * Tracks revenue impact per customer
 */
export const getBusinessImpactReport = asyncHandler(async function getBusinessImpactReport(req, res) {
    const {
      fromDate,
      toDate,
      search = '',
      actionType = ''
    } = req.query;

    // Default to current year if no dates provided
    const now = new Date();
    const startDate = fromDate ? new Date(fromDate) : new Date(now.getFullYear(), 0, 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = toDate ? new Date(toDate) : new Date();
    endDate.setHours(23, 59, 59, 999);

    // Get all customers with plan changes (in selected date range or any time)
    const customers = await prisma.lead.findMany({
      where: {
        customerUsername: { not: null },
        actualPlanIsActive: true
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
        planUpgrades: {
          where: {
            ...(actionType && actionType !== 'all' ? { actionType } : {})
          },
          orderBy: {
            upgradeDate: 'asc'
          },
          include: {
            createdBy: {
              select: {
                name: true
              }
            }
          }
        }
      }
    });

    // Also get customers without plan changes (to show original ARC)
    const allActiveCustomers = await prisma.lead.findMany({
      where: {
        customerUsername: { not: null },
        actualPlanIsActive: true
      },
      select: {
        id: true,
        campaignData: {
          select: {
            company: true
          }
        },
        actualPlanName: true,
        actualPlanPrice: true,
        actualPlanStartDate: true,
        arcAmount: true,
        actualPlanIsActive: true
      }
    });

    // Process customers with plan changes
    let businessImpactData = customers.map(customer => {
      const allPlanChanges = customer.planUpgrades || [];

      // Filter plan changes within the date range
      const planChanges = allPlanChanges.filter(change => {
        const changeDate = new Date(change.upgradeDate);
        return changeDate >= startDate && changeDate <= endDate;
      });

      // Get first plan change (all time) to determine initial ARC
      const firstChange = allPlanChanges[0];
      const lastChange = allPlanChanges[allPlanChanges.length - 1];

      // Calculate totals ONLY for changes in date range
      const totalUpgradeArc = planChanges
        .filter(p => p.actionType === 'UPGRADE')
        .reduce((sum, p) => sum + (p.additionalArc || 0), 0);

      const totalDegradeArc = planChanges
        .filter(p => p.actionType === 'DOWNGRADE')
        .reduce((sum, p) => sum + (p.degradeArc || 0), 0);

      // Initial ARC (from first ever change or current ARC)
      const initialArc = firstChange?.previousArc || customer.arcAmount || customer.actualPlanPrice || 0;
      // Current ARC (from last change or current ARC)
      const currentArc = lastChange?.newArc || customer.arcAmount || customer.actualPlanPrice || 0;

      // Net change in the selected date range
      const netChange = totalUpgradeArc - totalDegradeArc;

      return {
        id: customer.id,
        companyName: customer.campaignData?.company || customer.customerUsername || '-',
        userName: customer.customerUsername,
        contactName: customer.campaignData?.name || '-',
        // Initial Plan
        initialPlanName: firstChange?.previousPlanName || customer.actualPlanName || '-',
        initialArc: initialArc,
        activationDate: firstChange?.previousPlanStartDate || customer.actualPlanStartDate,
        // Plan Changes
        planChanges: planChanges.map(change => ({
          id: change.id,
          actionType: change.actionType,
          newPlanName: change.newPlanName,
          changeDate: change.upgradeDate,
          previousArc: change.previousArc,
          newArc: change.newArc,
          arcChange: change.actionType === 'UPGRADE' ? change.additionalArc : -Math.abs(change.degradeArc || 0),
          createdBy: change.createdBy?.name || '-'
        })),
        totalChanges: planChanges.length,
        upgradeCount: planChanges.filter(p => p.actionType === 'UPGRADE').length,
        degradeCount: planChanges.filter(p => p.actionType === 'DOWNGRADE').length,
        // Current Status
        currentPlanName: lastChange?.newPlanName || customer.actualPlanName || '-',
        currentArc: currentArc,
        totalUpgradeArc: totalUpgradeArc,
        totalDegradeArc: totalDegradeArc,
        netArcChange: netChange,
        netChangePercentage: initialArc > 0 ? ((netChange / initialArc) * 100).toFixed(2) : 0,
        isActive: customer.actualPlanIsActive || false,
        lastChangeDate: lastChange?.upgradeDate
      };
    });

    // Apply search filter
    if (search && search.trim()) {
      const searchTerm = search.trim().toLowerCase();
      businessImpactData = businessImpactData.filter(item =>
        item.companyName.toLowerCase().includes(searchTerm) ||
        item.userName?.toLowerCase().includes(searchTerm) ||
        item.initialPlanName.toLowerCase().includes(searchTerm) ||
        item.currentPlanName.toLowerCase().includes(searchTerm)
      );
    }

    // Sort by net ARC change (highest impact first)
    businessImpactData.sort((a, b) => Math.abs(b.netArcChange) - Math.abs(a.netArcChange));

    // Calculate summary metrics
    // Filter to only customers with changes in date range for "with changes" metrics
    const customersWithChanges = businessImpactData.filter(c => c.totalChanges > 0);

    // Get count of all active customers for context
    const totalActiveCustomers = allActiveCustomers.length;
    const totalActiveArc = allActiveCustomers.reduce((sum, c) => sum + (c.arcAmount || c.actualPlanPrice || 0), 0);

    // When there are no changes, show all active customers as the baseline
    const totalCustomers = customersWithChanges.length > 0
      ? customersWithChanges.length
      : totalActiveCustomers;

    const customersWithUpgrade = customersWithChanges.filter(c => c.upgradeCount > 0).length;
    const customersWithDegrade = customersWithChanges.filter(c => c.degradeCount > 0).length;

    // Calculate ARC metrics
    // If there are no changes in the date range, use totalActiveArc as the baseline
    const totalInitialArc = customersWithChanges.length > 0
      ? customersWithChanges.reduce((sum, c) => sum + c.initialArc, 0)
      : totalActiveArc;

    const totalUpgradeArc = businessImpactData.reduce((sum, c) => sum + c.totalUpgradeArc, 0);
    const totalDegradeArc = businessImpactData.reduce((sum, c) => sum + c.totalDegradeArc, 0);
    const netRevenueImpact = totalUpgradeArc - totalDegradeArc;

    // Calculate current ARC for customers with changes
    const totalCurrentArc = customersWithChanges.reduce((sum, c) => sum + c.currentArc, 0);

    // Pagination
    const totalCount = businessImpactData.length;
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query, 50);

    const paginatedData = businessImpactData.slice(skip, skip + limitNum);

    res.json({
      businessImpact: paginatedData,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      summary: {
        // Customers with plan changes
        totalCustomers,
        customersWithUpgrade,
        customersWithDegrade,
        // ARC metrics for customers with changes
        totalInitialArc,
        totalCurrentArc,
        totalUpgradeArc,
        totalDegradeArc,
        netRevenueImpact,
        averageArcChange: totalCustomers > 0 ? netRevenueImpact / totalCustomers : 0,
        // Overall business context
        totalActiveCustomers,
        totalActiveArc,
        impactPercentage: totalActiveArc > 0 ? ((netRevenueImpact / totalActiveArc) * 100).toFixed(2) : 0
      },
      filters: {
        fromDate: startDate.toISOString().split('T')[0],
        toDate: endDate.toISOString().split('T')[0],
        search: search || null,
        actionType: actionType || null
      }
    });
});

export default {
  getAccountsReport,
  getDailyCollectionReport,
  getInvoiceReport,
  getOutstandingReport,
  getTaxReport,
  getCreditNoteReport,
  getBusinessImpactReport
};
