import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';

// Parse ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD into a Prisma range. endDate
// is treated as inclusive — we push to end-of-day so a "today" filter actually
// catches events that happened later in the day.
function parseDateRange(req) {
  const { startDate, endDate } = req.query;
  const range = {};
  if (startDate) {
    const d = new Date(startDate);
    if (!isNaN(d)) range.gte = d;
  }
  if (endDate) {
    const d = new Date(endDate);
    if (!isNaN(d)) {
      d.setHours(23, 59, 59, 999);
      range.lte = d;
    }
  }
  return Object.keys(range).length ? range : undefined;
}

const SERIALISED_DELIVERY_STATUSES = ['ASSIGNED', 'DISPATCHED', 'COMPLETED'];

// Inward: every PO item that has had material received against it, joined
// with vendor + PO + warehouse. Serials are reconstructed as the union of
// what's still on the PO item AND what has already been dispatched out —
// otherwise items that have already gone to customers would look empty.
export const getInwardReport = asyncHandler(async function getInwardReport(req, res) {
  const range = parseDateRange(req);

  const items = await prisma.storePurchaseOrderItem.findMany({
    where: {
      receivedQuantity: { gt: 0 },
      purchaseOrder: {
        is: {
          status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED', 'COMPLETED'] },
          ...(range && { receiptVerifiedAt: range })
        }
      }
    },
    include: {
      product: true,
      purchaseOrder: {
        include: {
          vendor: { select: { companyName: true, gstNumber: true } },
          receiptVerifiedBy: { select: { name: true } }
        }
      },
      deliveryRequestItems: {
        where: {
          isAssigned: true,
          deliveryRequest: { is: { status: { in: SERIALISED_DELIVERY_STATUSES } } }
        },
        select: { assignedSerialNumbers: true, assignedQuantity: true }
      }
    },
    orderBy: { purchaseOrder: { receiptVerifiedAt: 'desc' } }
  });

  // Receipt batches surface per-batch damaged counts — we sum them per PO so
  // the inward row can show how much was rejected on the way in.
  const poIds = [...new Set(items.map(i => i.poId).filter(Boolean))];
  const damagedByPO = {};
  if (poIds.length) {
    const batches = await prisma.receiptBatchLog.findMany({
      where: { poId: { in: poIds } },
      select: { poId: true, totalDamaged: true }
    });
    batches.forEach(b => {
      damagedByPO[b.poId] = (damagedByPO[b.poId] || 0) + (b.totalDamaged || 0);
    });
  }

  const rows = items.map(item => {
    const isFiber = item.product.category === 'FIBER' || item.product.unit === 'mtrs';
    const dispatchedSerials = item.deliveryRequestItems.flatMap(d => d.assignedSerialNumbers || []);
    const dispatchedQty = item.deliveryRequestItems.reduce((s, d) => s + (d.assignedQuantity || 0), 0);
    const allSerials = isFiber ? [] : [...(item.serialNumbers || []), ...dispatchedSerials];
    const originalReceived = (item.receivedQuantity || 0) + (isFiber ? dispatchedQty : 0);

    return {
      receivedAt: item.purchaseOrder?.receiptVerifiedAt,
      poNumber: item.purchaseOrder?.poNumber,
      poStatus: item.purchaseOrder?.status,
      vendor: item.purchaseOrder?.vendor?.companyName || '—',
      vendorGstin: item.purchaseOrder?.vendor?.gstNumber || '',
      warehouse: item.purchaseOrder?.warehouse || '—',
      product: item.product.modelNumber,
      category: item.product.category,
      brand: item.product.brandName,
      unit: isFiber ? 'mtrs' : 'pcs',
      receivedQty: originalReceived,
      inStockQty: item.receivedQuantity || 0,
      dispatchedQty,
      damagedQty: damagedByPO[item.poId] || 0,
      serialCount: allSerials.length,
      serials: allSerials,
      receivedBy: item.purchaseOrder?.receiptVerifiedBy?.name || '—'
    };
  });

  res.json({
    rows,
    summary: {
      totalRows: rows.length,
      totalReceivedUnits: rows.reduce((s, r) => s + (r.unit === 'pcs' ? r.receivedQty : 0), 0),
      totalReceivedMeters: rows.reduce((s, r) => s + (r.unit === 'mtrs' ? r.receivedQty : 0), 0),
      totalDispatched: rows.reduce((s, r) => s + r.dispatchedQty, 0),
      totalDamaged: rows.reduce((s, r) => s + r.damagedQty, 0)
    }
  });
});

// Outward: each delivery-request item that has been assigned to a lead.
// Carries the source PO so the reader can trace any serial back to where
// it came from.
export const getOutwardReport = asyncHandler(async function getOutwardReport(req, res) {
  const range = parseDateRange(req);

  const items = await prisma.deliveryRequestItem.findMany({
    where: {
      isAssigned: true,
      ...(range && { assignedAt: range })
    },
    include: {
      product: true,
      deliveryRequest: {
        include: {
          lead: {
            select: {
              id: true,
              leadNumber: true,
              customerUsername: true,
              campaignData: { select: { name: true, company: true, phone: true } }
            }
          },
          assignedToStoreManager: { select: { name: true } }
        }
      },
      assignedFromPOItem: {
        include: { purchaseOrder: { select: { poNumber: true, warehouse: true } } }
      }
    },
    orderBy: { assignedAt: 'desc' }
  });

  const rows = items.map(item => {
    const isFiber = item.product.category === 'FIBER' || item.product.unit === 'mtrs';
    const serials = isFiber ? [] : (item.assignedSerialNumbers || []);
    return {
      assignedAt: item.assignedAt,
      deliveryRequestNumber: item.deliveryRequest?.requestNumber,
      deliveryStatus: item.deliveryRequest?.status,
      dispatchedAt: item.deliveryRequest?.dispatchedAt,
      completedAt: item.deliveryRequest?.completedAt,
      leadId: item.deliveryRequest?.lead?.id,
      leadNumber: item.deliveryRequest?.lead?.leadNumber || '',
      customerName: item.deliveryRequest?.lead?.campaignData?.name || '—',
      company: item.deliveryRequest?.lead?.campaignData?.company || '',
      customerUsername: item.deliveryRequest?.lead?.customerUsername || '',
      phone: item.deliveryRequest?.lead?.campaignData?.phone || '',
      product: item.product.modelNumber,
      category: item.product.category,
      brand: item.product.brandName,
      unit: isFiber ? 'mtrs' : 'pcs',
      assignedQty: item.assignedQuantity || 0,
      serialCount: serials.length,
      serials,
      sourcePO: item.assignedFromPOItem?.purchaseOrder?.poNumber || '—',
      sourceWarehouse: item.assignedFromPOItem?.purchaseOrder?.warehouse || '—',
      assignedBy: item.deliveryRequest?.assignedToStoreManager?.name || '—'
    };
  });

  res.json({
    rows,
    summary: {
      totalRows: rows.length,
      totalUnits: rows.reduce((s, r) => s + (r.unit === 'pcs' ? r.assignedQty : 0), 0),
      totalMeters: rows.reduce((s, r) => s + (r.unit === 'mtrs' ? r.assignedQty : 0), 0),
      totalSerials: rows.reduce((s, r) => s + r.serialCount, 0),
      uniqueLeads: new Set(rows.map(r => r.leadId).filter(Boolean)).size
    }
  });
});

// Stock-on-hand: live snapshot — never date-filtered, the user wants to know
// what's sitting in the store right now. Anything that's been assigned out
// has already had its serials removed from the PO item.
export const getStockOnHandReport = asyncHandler(async function getStockOnHandReport(req, res) {
  const items = await prisma.storePurchaseOrderItem.findMany({
    where: {
      status: 'IN_STORE',
      quantity: { gt: 0 }
    },
    include: {
      product: true,
      purchaseOrder: {
        include: { vendor: { select: { companyName: true } } }
      }
    },
    orderBy: [
      { product: { modelNumber: 'asc' } },
      { addedToStoreAt: 'asc' }
    ]
  });

  const rows = items.map(item => {
    const isFiber = item.product.category === 'FIBER' || item.product.unit === 'mtrs';
    const serials = isFiber ? [] : (item.serialNumbers || []);
    return {
      warehouse: item.purchaseOrder?.warehouse || '—',
      product: item.product.modelNumber,
      category: item.product.category,
      brand: item.product.brandName,
      unit: isFiber ? 'mtrs' : 'pcs',
      quantity: item.quantity,
      serialCount: serials.length,
      serials,
      sourcePO: item.purchaseOrder?.poNumber || '—',
      vendor: item.purchaseOrder?.vendor?.companyName || '—',
      addedToStoreAt: item.addedToStoreAt
    };
  });

  // Per-product totals across warehouses are useful for quick reorder calls.
  const productTotals = {};
  rows.forEach(r => {
    const key = `${r.product}|${r.unit}`;
    if (!productTotals[key]) {
      productTotals[key] = { product: r.product, category: r.category, brand: r.brand, unit: r.unit, quantity: 0 };
    }
    productTotals[key].quantity += r.quantity;
  });

  res.json({
    rows,
    productTotals: Object.values(productTotals).sort((a, b) => a.product.localeCompare(b.product)),
    summary: {
      totalLots: rows.length,
      totalUnits: rows.reduce((s, r) => s + (r.unit === 'pcs' ? r.quantity : 0), 0),
      totalMeters: rows.reduce((s, r) => s + (r.unit === 'mtrs' ? r.quantity : 0), 0),
      warehouses: [...new Set(rows.map(r => r.warehouse))].length
    }
  });
});

// Damaged + rejected: per-batch view. A batch can be partially damaged
// (totalDamaged > 0) or wholesale rejected (resultStatus = RECEIPT_REJECTED).
// Either is useful for vendor-quality conversations.
export const getDamagedRejectedReport = asyncHandler(async function getDamagedRejectedReport(req, res) {
  const range = parseDateRange(req);

  const batches = await prisma.receiptBatchLog.findMany({
    where: {
      OR: [
        { totalDamaged: { gt: 0 } },
        { resultStatus: 'RECEIPT_REJECTED' }
      ],
      ...(range && { verifiedAt: range })
    },
    include: {
      purchaseOrder: {
        include: { vendor: { select: { companyName: true, gstNumber: true } } }
      },
      verifiedBy: { select: { name: true } }
    },
    orderBy: { verifiedAt: 'desc' }
  });

  const rows = batches.map(b => {
    const snapshot = Array.isArray(b.itemsSnapshot) ? b.itemsSnapshot : [];
    const damagedItems = snapshot.filter(s => (s.damagedInBatch || 0) > 0);
    return {
      verifiedAt: b.verifiedAt,
      poNumber: b.purchaseOrder?.poNumber,
      vendor: b.purchaseOrder?.vendor?.companyName || '—',
      vendorGstin: b.purchaseOrder?.vendor?.gstNumber || '',
      warehouse: b.purchaseOrder?.warehouse || '—',
      batchNumber: b.batchNumber,
      resultStatus: b.resultStatus,
      totalReceived: b.totalReceived,
      totalDamaged: b.totalDamaged,
      remark: b.remark || '',
      verifiedBy: b.verifiedBy?.name || '—',
      damagedBreakdown: damagedItems
        .map(i => `${i.productName}: ${i.damagedInBatch}`)
        .join('; ')
    };
  });

  res.json({
    rows,
    summary: {
      totalBatches: rows.length,
      totalDamagedUnits: rows.reduce((s, r) => s + (r.totalDamaged || 0), 0),
      rejectedBatches: rows.filter(r => r.resultStatus === 'RECEIPT_REJECTED').length,
      uniqueVendors: new Set(rows.map(r => r.vendor)).size
    }
  });
});
