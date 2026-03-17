import prisma from '../config/db.js';
import { cloudinary } from '../config/cloudinary.js';
import * as XLSX from 'xlsx';
import { isAdminOrTestUser, hasRole } from '../utils/roleHelper.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { generateDocumentNumber } from '../services/documentNumber.service.js';

// Generate PO number (atomic, race-condition safe)
const generatePONumber = async () => {
  return generateDocumentNumber('STORE_PO');
};

// Generate GIIRN number (atomic, race-condition safe)
const generateGIIRNNumber = async () => {
  return generateDocumentNumber('GIIRN');
};

// ========== STORE PRODUCT (ITEM) APIs ==========

// Get all products for dropdown
export const getProducts = asyncHandler(async function getProducts(req, res) {
    const products = await prisma.storeProduct.findMany({
      where: { isActive: true },
      select: {
        id: true,
        category: true,
        modelNumber: true,
        serialNumber: true,
        brandName: true,
        price: true,
        description: true,
        unit: true
      },
      orderBy: { modelNumber: 'asc' }
    });

    res.json(products);
});

// Get all products with full details
export const getAllProducts = asyncHandler(async function getAllProducts(req, res) {
    const products = await prisma.storeProduct.findMany({
      include: {
        createdBy: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(products);
});

// Create a new product
export const createProduct = asyncHandler(async function createProduct(req, res) {
    const userId = req.user.id;
    const { category, modelNumber, brandName, price, description, unit } = req.body;

    // Validate required fields
    if (!category || !modelNumber || !brandName) {
      return res.status(400).json({ message: 'Category, model number, and brand name are required' });
    }

    // Validate category
    const validCategories = ['SWITCH', 'SFP', 'CLOSURE', 'RF', 'PATCH_CORD', 'FIBER'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ message: 'Invalid product category' });
    }

    // Validate unit
    const validUnits = ['pcs', 'mtrs'];
    if (unit && !validUnits.includes(unit)) {
      return res.status(400).json({ message: 'Unit must be pcs or mtrs' });
    }

    // Check if model number already exists
    const existing = await prisma.storeProduct.findUnique({
      where: { modelNumber: modelNumber.trim() }
    });

    if (existing) {
      return res.status(400).json({ message: 'Model number already exists' });
    }

    // Create product
    const product = await prisma.storeProduct.create({
      data: {
        category,
        modelNumber: modelNumber.trim(),
        brandName: brandName.trim(),
        price: price ? parseFloat(price) : null,
        description: description?.trim() || null,
        unit: unit || 'pcs',
        createdById: userId
      },
      include: {
        createdBy: { select: { id: true, name: true } }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      product
    });
});

// Update a product
export const updateProduct = asyncHandler(async function updateProduct(req, res) {
    const { id } = req.params;
    const { category, modelNumber, brandName, price, description, unit, isActive } = req.body;

    // Check if product exists
    const existing = await prisma.storeProduct.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // If model number is being changed, check for duplicates
    if (modelNumber && modelNumber.trim() !== existing.modelNumber) {
      const duplicate = await prisma.storeProduct.findUnique({
        where: { modelNumber: modelNumber.trim() }
      });
      if (duplicate) {
        return res.status(400).json({ message: 'Model number already exists' });
      }
    }

    const product = await prisma.storeProduct.update({
      where: { id },
      data: {
        ...(category && { category }),
        ...(modelNumber && { modelNumber: modelNumber.trim() }),
        ...(brandName && { brandName: brandName.trim() }),
        ...(price !== undefined && { price: price ? parseFloat(price) : null }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(unit && { unit }),
        ...(isActive !== undefined && { isActive })
      },
      include: {
        createdBy: { select: { id: true, name: true } }
      }
    });

    res.json({
      success: true,
      message: 'Product updated successfully',
      product
    });
});

// Delete a product (soft delete)
export const deleteProduct = asyncHandler(async function deleteProduct(req, res) {
    const { id } = req.params;

    const existing = await prisma.storeProduct.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Check if product is used in any PO
    const usedInPO = await prisma.storePurchaseOrderItem.findFirst({
      where: { productId: id }
    });

    if (usedInPO) {
      // Soft delete if used
      await prisma.storeProduct.update({
        where: { id },
        data: { isActive: false }
      });
      return res.json({
        success: true,
        message: 'Product deactivated (used in existing POs)'
      });
    }

    // Hard delete if not used
    await prisma.storeProduct.delete({ where: { id } });
    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
});

// Get product categories for dropdown
export const getProductCategories = asyncHandler(async function getProductCategories(req, res) {
    const categories = [
      { value: 'SWITCH', label: 'Switch', isSerialized: true },
      { value: 'SFP', label: 'SFP', isSerialized: true },
      { value: 'CLOSURE', label: 'Closure', isSerialized: false },
      { value: 'RF', label: 'RF', isSerialized: false },
      { value: 'PATCH_CORD', label: 'Patch Cord', isSerialized: false },
      { value: 'FIBER', label: 'Fiber', isSerialized: false }
    ];
    res.json(categories);
});

// Get brand options for dropdown
export const getBrands = asyncHandler(async function getBrands(req, res) {
    const brands = [
      { value: 'Leased Line', label: 'Leased Line' }
    ];
    res.json(brands);
});

// Get warehouse options for dropdown
export const getWarehouses = asyncHandler(async function getWarehouses(req, res) {
    const warehouses = [
      { value: 'Pune', label: 'Pune' },
      { value: 'Sambhaji Nagar', label: 'Sambhaji Nagar' },
      { value: 'Ahilya Nagar', label: 'Ahilya Nagar' }
    ];
    res.json(warehouses);
});

// ========== PURCHASE ORDER APIs ==========

// Get vendors for dropdown
export const getVendors = asyncHandler(async function getVendors(req, res) {
    const vendors = await prisma.vendor.findMany({
      where: { isActive: true },
      select: {
        id: true,
        companyName: true,
        contactPerson: true,
        phone: true,
        category: true
      },
      orderBy: { companyName: 'asc' }
    });

    res.json(vendors);
});

// Create a new Vendor (Store Manager)
export const createVendor = asyncHandler(async function createVendor(req, res) {
    const userId = req.user.id;
    const {
      companyName,
      gstNumber,
      contactPerson,
      email,
      phone,
      panNumber,
      address,
      city,
      state
    } = req.body;

    // Validate required fields
    if (!companyName?.trim()) {
      return res.status(400).json({ message: 'Company name is required' });
    }

    if (!panNumber?.trim()) {
      return res.status(400).json({ message: 'PAN number is required' });
    }

    // Validate PAN format (10 characters: 5 letters, 4 digits, 1 letter)
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!panRegex.test(panNumber.trim().toUpperCase())) {
      return res.status(400).json({ message: 'Invalid PAN format. Must be like ABCDE1234F' });
    }

    // Check for duplicate company name
    const existingVendor = await prisma.vendor.findFirst({
      where: {
        companyName: {
          equals: companyName.trim(),
          mode: 'insensitive'
        }
      }
    });

    if (existingVendor) {
      return res.status(400).json({ message: 'A vendor with this company name already exists' });
    }

    // Create vendor
    const vendor = await prisma.vendor.create({
      data: {
        companyName: companyName.trim(),
        gstNumber: gstNumber?.trim() || null,
        contactPerson: contactPerson?.trim() || null,
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        panNumber: panNumber?.trim() || null,
        address: address?.trim() || null,
        city: city?.trim() || null,
        state: state?.trim() || null,
        createdById: userId
      },
      select: {
        id: true,
        companyName: true,
        contactPerson: true,
        phone: true
      }
    });

    res.status(201).json({
      success: true,
      message: 'Vendor created successfully',
      vendor
    });
});

// Create a new Purchase Order
export const createPurchaseOrder = asyncHandler(async function createPurchaseOrder(req, res) {
    const userId = req.user.id;
    const { vendorId, warehouse, brandType, remark, items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'At least one item is required' });
    }

    // Validate vendor if provided
    if (vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(400).json({ message: 'Vendor not found' });
      }
    }

    // Validate and process items
    let totalAmount = 0;
    const processedItems = [];

    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({ message: 'Each item must have productId and quantity > 0' });
      }

      // Fetch product
      const product = await prisma.storeProduct.findUnique({
        where: { id: item.productId }
      });

      if (!product) {
        return res.status(400).json({ message: `Product not found: ${item.productId}` });
      }

      // Calculate item total
      const unitPrice = item.unitPrice || product.price || 0;
      const itemTotal = unitPrice * item.quantity;
      totalAmount += itemTotal;

      processedItems.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: unitPrice || null,
        serialNumbers: [], // Serial numbers will be added during delivery
        status: 'PURCHASED'
      });
    }

    // Generate PO number
    const poNumber = await generatePONumber();

    // Create PO with items - status is PENDING_ADMIN (first approval level)
    const po = await prisma.storePurchaseOrder.create({
      data: {
        poNumber,
        vendorId: vendorId || null,
        warehouse: warehouse || null,
        brandType: brandType || null,
        remark: remark?.trim() || null,
        totalAmount,
        status: 'PENDING_ADMIN',
        createdById: userId,
        items: {
          create: processedItems
        }
      },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true } },
        createdBy: { select: { id: true, name: true } }
      }
    });

    // Notify ADMIN about new PO pending approval
    emitSidebarRefreshByRole('ADMIN');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      success: true,
      message: 'Purchase Order created successfully',
      purchaseOrder: po
    });
});

// Get all Purchase Orders
export const getPurchaseOrders = asyncHandler(async function getPurchaseOrders(req, res) {
    const pos = await prisma.storePurchaseOrder.findMany({
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true } },
        createdBy: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(pos);
});

// Get single Purchase Order
export const getPurchaseOrder = asyncHandler(async function getPurchaseOrder(req, res) {
    const { id } = req.params;

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true, contactPerson: true, phone: true } },
        createdBy: { select: { id: true, name: true } }
      }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    res.json(po);
});

// Get available items (purchased but not in store - only from RECEIVED/PARTIALLY_RECEIVED POs)
export const getAvailableItems = asyncHandler(async function getAvailableItems(req, res) {
    const items = await prisma.storePurchaseOrderItem.findMany({
      where: {
        status: 'PURCHASED',
        purchaseOrder: {
          status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] }
        }
      },
      include: {
        product: true,
        purchaseOrder: {
          select: {
            id: true,
            poNumber: true,
            giirnNumber: true,
            warehouse: true,
            createdAt: true,
            status: true,
            vendor: { select: { companyName: true } },
            items: {
              select: {
                quantity: true,
                receivedQuantity: true,
                receiptStatus: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate PO-level tally for each item
    const itemsWithTally = items.map(item => {
      const poItems = item.purchaseOrder.items;
      const totalOrdered = poItems.reduce((sum, i) => sum + i.quantity, 0);
      const totalReceived = poItems.reduce((sum, i) => sum + (i.receivedQuantity || 0), 0);

      return {
        ...item,
        purchaseOrder: {
          ...item.purchaseOrder,
          // Add tally info
          totalOrdered,
          totalReceived,
          isPartiallyReceived: item.purchaseOrder.status === 'PARTIALLY_RECEIVED',
          tallyMessage: item.purchaseOrder.status === 'PARTIALLY_RECEIVED'
            ? `${item.purchaseOrder.poNumber}: Received ${totalReceived}/${totalOrdered} items`
            : null,
          items: undefined // Remove items array from response (we only needed it for calculation)
        }
      };
    });

    res.json(itemsWithTally);
});

// Helper: Check if all items in affected POs are IN_STORE, and auto-complete them
async function checkAndCompletePOs(itemIds) {
  const items = await prisma.storePurchaseOrderItem.findMany({
    where: { id: { in: itemIds } },
    select: { poId: true }
  });
  const poIds = [...new Set(items.map(i => i.poId))];

  for (const poId of poIds) {
    const allItems = await prisma.storePurchaseOrderItem.findMany({
      where: { poId },
      select: { status: true }
    });
    if (allItems.every(i => i.status === 'IN_STORE')) {
      await prisma.storePurchaseOrder.update({
        where: { id: poId },
        data: { status: 'COMPLETED' }
      });
    }
  }
}

// Add items to store (from purchased PO items - only RECEIVED/PARTIALLY_RECEIVED POs)
export const addToStore = asyncHandler(async function addToStore(req, res) {
    const { itemIds } = req.body;

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ message: 'Select at least one item to add' });
    }

    // Fetch items with PO status check
    const items = await prisma.storePurchaseOrderItem.findMany({
      where: {
        id: { in: itemIds },
        status: 'PURCHASED',
        purchaseOrder: {
          status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] }
        }
      },
      include: {
        purchaseOrder: { select: { status: true } }
      }
    });

    if (items.length === 0) {
      return res.status(400).json({ message: 'No valid items found. Items must be from receipt-verified POs.' });
    }

    if (items.length !== itemIds.length) {
      return res.status(400).json({ message: 'Some items are already in store, not found, or PO not receipt-verified' });
    }

    // Update items status to IN_STORE
    await prisma.storePurchaseOrderItem.updateMany({
      where: { id: { in: itemIds } },
      data: {
        status: 'IN_STORE',
        addedToStoreAt: new Date()
      }
    });

    // Auto-complete POs if all items are now IN_STORE
    await checkAndCompletePOs(itemIds);

    res.json({
      success: true,
      message: `${items.length} item(s) added to store`,
      count: items.length
    });
});

// Generate Excel template for serial number entry
export const generateSerialTemplate = asyncHandler(async function generateSerialTemplate(req, res) {
    const { itemIds } = req.body;

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ message: 'Select at least one item' });
    }

    // Fetch items with product details
    const items = await prisma.storePurchaseOrderItem.findMany({
      where: {
        id: { in: itemIds },
        status: 'PURCHASED',
        purchaseOrder: {
          status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] }
        }
      },
      include: {
        product: true,
        purchaseOrder: { select: { poNumber: true } }
      }
    });

    if (items.length === 0) {
      return res.status(400).json({ message: 'No valid items found' });
    }

    // Create worksheet data - one row per unit quantity
    const wsData = [['Item ID', 'PO Number', 'Product Model', 'Category', 'Brand', 'Unit #', 'Serial Number']];

    items.forEach(item => {
      const actualQty = item.receivedQuantity ?? item.quantity;
      // For fiber (measured in mtrs), we don't need individual serial numbers
      const isFiber = item.product.category === 'FIBER' || item.product.unit === 'mtrs';

      if (isFiber) {
        // For fiber, just one row with quantity
        wsData.push([
          item.id,
          item.purchaseOrder.poNumber,
          item.product.modelNumber,
          item.product.category,
          item.product.brandName,
          `${actualQty} mtrs`,
          '' // No serial for fiber
        ]);
      } else {
        // For other items, one row per unit
        for (let i = 1; i <= actualQty; i++) {
          wsData.push([
            item.id,
            item.purchaseOrder.poNumber,
            item.product.modelNumber,
            item.product.category,
            item.product.brandName,
            `${i} of ${actualQty}`,
            '' // Serial number to be filled
          ]);
        }
      }
    });

    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Set column widths
    ws['!cols'] = [
      { wch: 40 }, // Item ID
      { wch: 12 }, // PO Number
      { wch: 30 }, // Product Model
      { wch: 15 }, // Category
      { wch: 20 }, // Brand
      { wch: 10 }, // Unit #
      { wch: 25 }  // Serial Number
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Serial Numbers');

    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Send as downloadable file
    res.setHeader('Content-Disposition', 'attachment; filename=serial_numbers_template.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Upload Excel with serial numbers and add to store
export const uploadSerialsAndAddToStore = asyncHandler(async function uploadSerialsAndAddToStore(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Parse Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    // Skip header row
    const rows = data.slice(1).filter(row => row.length > 0);

    if (rows.length === 0) {
      return res.status(400).json({ message: 'No data found in Excel file' });
    }

    // Group serial numbers by item ID
    const serialsByItem = {};
    rows.forEach(row => {
      const itemId = row[0];
      const serialNumber = row[6]?.toString().trim();

      if (itemId && serialNumber) {
        if (!serialsByItem[itemId]) {
          serialsByItem[itemId] = [];
        }
        serialsByItem[itemId].push(serialNumber);
      }
    });

    const itemIds = Object.keys(serialsByItem);

    if (itemIds.length === 0) {
      return res.status(400).json({ message: 'No serial numbers found in the file' });
    }

    // Validate items exist and are valid
    const items = await prisma.storePurchaseOrderItem.findMany({
      where: {
        id: { in: itemIds },
        status: 'PURCHASED',
        purchaseOrder: {
          status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] }
        }
      },
      include: {
        product: true
      }
    });

    if (items.length === 0) {
      return res.status(400).json({ message: 'No valid items found' });
    }

    // Validate serial number counts match quantities
    const errors = [];
    items.forEach(item => {
      const isFiber = item.product.category === 'FIBER' || item.product.unit === 'mtrs';
      if (!isFiber) {
        const expectedQty = item.receivedQuantity ?? item.quantity;
        const actualSerials = serialsByItem[item.id]?.length || 0;
        if (actualSerials !== expectedQty) {
          errors.push(`${item.product.modelNumber}: Expected ${expectedQty} serial numbers, got ${actualSerials}`);
        }
      }
    });

    if (errors.length > 0) {
      return res.status(400).json({
        message: 'Serial number count mismatch',
        errors
      });
    }

    // Update each item with serial numbers and mark as IN_STORE
    const updatePromises = items.map(item =>
      prisma.storePurchaseOrderItem.update({
        where: { id: item.id },
        data: {
          serialNumbers: serialsByItem[item.id] || [],
          status: 'IN_STORE',
          addedToStoreAt: new Date()
        }
      })
    );

    await Promise.all(updatePromises);

    // Auto-complete POs if all items are now IN_STORE
    const processedItemIds = items.map(i => i.id);
    await checkAndCompletePOs(processedItemIds);

    res.json({
      success: true,
      message: `${items.length} item(s) added to store with serial numbers`,
      count: items.length
    });
});

// ========== STORE INVENTORY APIs ==========

// Get store inventory (only items that are IN_STORE)
export const getStoreInventory = asyncHandler(async function getStoreInventory(req, res) {
    const items = await prisma.storePurchaseOrderItem.findMany({
      where: { status: 'IN_STORE' },
      include: {
        product: true,
        purchaseOrder: {
          select: {
            poNumber: true,
            giirnNumber: true,
            warehouse: true,
            vendor: { select: { companyName: true } }
          }
        }
      },
      orderBy: { addedToStoreAt: 'desc' }
    });

    // Group by product
    const grouped = {};
    for (const item of items) {
      const key = item.productId;
      // Use receivedQuantity if available, otherwise fall back to quantity
      const actualQuantity = item.receivedQuantity ?? item.quantity;

      if (!grouped[key]) {
        grouped[key] = {
          productId: item.productId,
          category: item.product.category,
          modelNumber: item.product.modelNumber,
          brandName: item.product.brandName,
          unit: item.product.unit,
          serialNumber: item.product.serialNumber,
          totalQuantity: 0,
          serialNumbers: [],
          items: []
        };
      }
      grouped[key].totalQuantity += actualQuantity;
      grouped[key].serialNumbers.push(...item.serialNumbers);
      grouped[key].items.push({
        id: item.id,
        quantity: actualQuantity,
        orderedQuantity: item.quantity,
        receivedQuantity: item.receivedQuantity,
        unitPrice: item.unitPrice,
        serialNumbers: item.serialNumbers,
        poNumber: item.purchaseOrder.poNumber,
        giirnNumber: item.purchaseOrder.giirnNumber,
        warehouse: item.purchaseOrder.warehouse,
        vendorName: item.purchaseOrder.vendor?.companyName,
        addedAt: item.addedToStoreAt
      });
    }

    const inventory = Object.values(grouped);
    res.json(inventory);
});

// ========== PO APPROVAL APIs (Single-Level Admin Approval) ==========

// Get POs pending approval (Admin only)
export const getPendingApprovalPOs = asyncHandler(async function getPendingApprovalPOs(req, res) {
    const userRole = req.user.role;

    // Only Admin/Super Admin/Test User can approve POs
    if (!isAdminOrTestUser(req.user) && userRole !== 'ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Both Admin and Super Admin see PENDING_ADMIN POs
    const pos = await prisma.storePurchaseOrder.findMany({
      where: { status: 'PENDING_ADMIN' },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true, contactPerson: true, phone: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        adminApprovedBy: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(pos);
});

// Get all POs for admin (all statuses)
export const getAdminPurchaseOrders = asyncHandler(async function getAdminPurchaseOrders(req, res) {
    const { status } = req.query;

    const where = status ? { status } : {};

    const pos = await prisma.storePurchaseOrder.findMany({
      where,
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true, contactPerson: true, phone: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        superAdminApprovedBy: { select: { id: true, name: true, email: true } },
        adminApprovedBy: { select: { id: true, name: true, email: true } },
        rejectedBy: { select: { id: true, name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(pos);
});

// Approve a PO (Single-level Admin approval)
export const approvePurchaseOrder = asyncHandler(async function approvePurchaseOrder(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Only Admin/Super Admin/Test User can approve
    if (!isAdminOrTestUser(req.user) && userRole !== 'ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      include: { items: true }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    // Check if PO is pending approval
    if (po.status !== 'PENDING_ADMIN') {
      return res.status(400).json({
        message: `Cannot approve. PO is not pending approval. Current status: ${po.status}`
      });
    }

    // Single-level approval: Admin approves directly to PENDING_RECEIPT
    const updateData = {
      status: 'PENDING_RECEIPT',
      adminApprovedById: userId,
      adminApprovedAt: new Date(),
      sentToVendorAt: new Date()
    };
    const message = 'Purchase Order approved and sent to vendor. Pending goods receipt verification.';

    const updatedPO = await prisma.storePurchaseOrder.update({
      where: { id },
      data: updateData,
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true } },
        createdBy: { select: { id: true, name: true } },
        adminApprovedBy: { select: { id: true, name: true } }
      }
    });

    // Notify admins of PO approval
    emitSidebarRefreshByRole('ADMIN');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      success: true,
      message,
      purchaseOrder: updatedPO
    });
});

// Reject a PO (Admin or Super Admin can reject)
export const rejectPurchaseOrder = asyncHandler(async function rejectPurchaseOrder(req, res) {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Only Admin/Super Admin/Test User can reject
    if (!isAdminOrTestUser(req.user) && userRole !== 'ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    // Can only reject POs that are pending approval
    if (po.status !== 'PENDING_ADMIN') {
      return res.status(400).json({
        message: `Cannot reject. PO is not pending approval. Current status: ${po.status}`
      });
    }

    const updatedPO = await prisma.storePurchaseOrder.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectedById: userId,
        rejectedAt: new Date(),
        rejectedReason: reason.trim()
      },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true } },
        createdBy: { select: { id: true, name: true } },
        rejectedBy: { select: { id: true, name: true } }
      }
    });

    res.json({
      success: true,
      message: 'Purchase Order rejected',
      purchaseOrder: updatedPO
    });
});

// Get PO approval stats (Single-level approval)
export const getPOApprovalStats = asyncHandler(async function getPOApprovalStats(req, res) {
    const pendingAdmin = await prisma.storePurchaseOrder.count({
      where: { status: 'PENDING_ADMIN' }
    });

    const approvedCount = await prisma.storePurchaseOrder.count({
      where: { status: { in: ['APPROVED', 'PENDING_RECEIPT', 'RECEIVED', 'PARTIALLY_RECEIVED', 'COMPLETED'] } }
    });

    const rejectedCount = await prisma.storePurchaseOrder.count({
      where: { status: 'REJECTED' }
    });

    res.json({
      pendingAdmin,
      myPending: pendingAdmin,
      approved: approvedCount,
      rejected: rejectedCount,
      total: pendingAdmin + approvedCount + rejectedCount
    });
});

// Update/Edit a PO (Admin only)
export const updatePurchaseOrder = asyncHandler(async function updatePurchaseOrder(req, res) {
    const { id } = req.params;
    const { vendorId, warehouse, brandType, remark } = req.body;

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      include: { items: true }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    // Check if any items are already in store - cannot edit if items moved to store
    const inStoreItems = po.items.filter(item => item.status === 'IN_STORE');
    if (inStoreItems.length > 0) {
      return res.status(400).json({
        message: 'Cannot edit PO - some items have already been added to store inventory'
      });
    }

    // Status changes must go through dedicated approval/rejection endpoints
    const updatedPO = await prisma.storePurchaseOrder.update({
      where: { id },
      data: {
        ...(vendorId !== undefined && { vendorId: vendorId || null }),
        ...(warehouse !== undefined && { warehouse: warehouse || null }),
        ...(brandType !== undefined && { brandType: brandType || null }),
        ...(remark !== undefined && { remark: remark || null })
      },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true } },
        createdBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } }
      }
    });

    res.json({
      success: true,
      message: 'Purchase Order updated successfully',
      purchaseOrder: updatedPO
    });
});

// Delete a PO (Admin only)
export const deletePurchaseOrder = asyncHandler(async function deletePurchaseOrder(req, res) {
    const { id } = req.params;

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      include: { items: true }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    // Check if any items are already in store - cannot delete if items moved to store
    const inStoreItems = po.items.filter(item => item.status === 'IN_STORE');
    if (inStoreItems.length > 0) {
      return res.status(400).json({
        message: 'Cannot delete PO - some items have already been added to store inventory'
      });
    }

    // Delete PO (items will be cascade deleted due to onDelete: Cascade in schema)
    await prisma.storePurchaseOrder.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Purchase Order deleted successfully'
    });
});

// Get store stats
export const getStoreStats = asyncHandler(async function getStoreStats(req, res) {
    // Get all in-store items with product info to separate fiber from non-fiber
    const inStoreItemsWithProduct = await prisma.storePurchaseOrderItem.findMany({
      where: { status: 'IN_STORE' },
      include: { product: { select: { category: true, unit: true } } }
    });

    // Separate fiber and non-fiber quantities
    let inStorePcsQuantity = 0;
    let inStoreMtrsQuantity = 0;
    let inStorePcsCount = 0;
    let inStoreMtrsCount = 0;

    inStoreItemsWithProduct.forEach(item => {
      const isFiber = item.product?.category === 'FIBER' || item.product?.unit === 'mtrs';
      // Use receivedQuantity if available, otherwise fall back to quantity
      const actualQuantity = item.receivedQuantity ?? item.quantity ?? 0;
      if (isFiber) {
        inStoreMtrsQuantity += actualQuantity;
        inStoreMtrsCount++;
      } else {
        inStorePcsQuantity += actualQuantity;
        inStorePcsCount++;
      }
    });

    // Get pending items with product info
    const pendingItemsWithProduct = await prisma.storePurchaseOrderItem.findMany({
      where: {
        status: 'PURCHASED',
        purchaseOrder: {
          status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] }
        }
      },
      include: { product: { select: { category: true, unit: true } } }
    });

    let pendingPcsQuantity = 0;
    let pendingMtrsQuantity = 0;
    let pendingPcsCount = 0;
    let pendingMtrsCount = 0;

    pendingItemsWithProduct.forEach(item => {
      const isFiber = item.product?.category === 'FIBER' || item.product?.unit === 'mtrs';
      // Use receivedQuantity if available, otherwise fall back to quantity
      const actualQuantity = item.receivedQuantity ?? item.quantity ?? 0;
      if (isFiber) {
        pendingMtrsQuantity += actualQuantity;
        pendingMtrsCount++;
      } else {
        pendingPcsQuantity += actualQuantity;
        pendingPcsCount++;
      }
    });

    // Count receipt-verified POs only
    const totalPOs = await prisma.storePurchaseOrder.count({
      where: { status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] } }
    });

    // Count distinct products actually IN STORE
    const productsInStore = await prisma.storePurchaseOrderItem.findMany({
      where: { status: 'IN_STORE' },
      select: { productId: true },
      distinct: ['productId']
    });
    const totalProducts = productsInStore.length;

    // Today's activity
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayPOs = await prisma.storePurchaseOrder.count({
      where: { createdAt: { gte: today } }
    });

    res.json({
      // Legacy fields (total of all)
      inStoreQuantity: inStorePcsQuantity + inStoreMtrsQuantity,
      inStoreItems: inStorePcsCount + inStoreMtrsCount,
      pendingQuantity: pendingPcsQuantity + pendingMtrsQuantity,
      pendingItems: pendingPcsCount + pendingMtrsCount,
      // New separated fields
      inStorePcsQuantity,
      inStoreMtrsQuantity,
      inStorePcsCount,
      inStoreMtrsCount,
      pendingPcsQuantity,
      pendingMtrsQuantity,
      pendingPcsCount,
      pendingMtrsCount,
      totalPOs,
      totalProducts,
      todayPOs
    });
});

// ========== GOODS RECEIPT VERIFICATION APIs ==========

// Get POs pending receipt verification (Admin only)
export const getPendingReceiptPOs = asyncHandler(async function getPendingReceiptPOs(req, res) {
    const pos = await prisma.storePurchaseOrder.findMany({
      where: { status: 'PENDING_RECEIPT' },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true, contactPerson: true, phone: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        superAdminApprovedBy: { select: { id: true, name: true } },
        adminApprovedBy: { select: { id: true, name: true } }
      },
      orderBy: { sentToVendorAt: 'desc' }
    });

    res.json(pos);
});

// Get receipt verification stats
export const getReceiptStats = asyncHandler(async function getReceiptStats(req, res) {
    const [pendingReceipt, received, partiallyReceived, receiptRejected] = await Promise.all([
      prisma.storePurchaseOrder.count({ where: { status: 'PENDING_RECEIPT' } }),
      prisma.storePurchaseOrder.count({ where: { status: 'RECEIVED' } }),
      prisma.storePurchaseOrder.count({ where: { status: 'PARTIALLY_RECEIVED' } }),
      prisma.storePurchaseOrder.count({ where: { status: 'RECEIPT_REJECTED' } })
    ]);

    res.json({
      pendingReceipt,
      received,
      partiallyReceived, // POs awaiting next batch
      receiptRejected,
      awaitingNextBatch: partiallyReceived, // Alias for clarity in UI
      total: pendingReceipt + received + partiallyReceived + receiptRejected
    });
});

// Verify goods receipt (Admin only)
export const verifyGoodsReceipt = asyncHandler(async function verifyGoodsReceipt(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { receiptStatus, receiptRemark, verificationStatement, items, signedPOUrl, testBypass } = req.body;

    // Validate receipt status
    const validStatuses = ['RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIPT_REJECTED'];
    if (!validStatuses.includes(receiptStatus)) {
      return res.status(400).json({ message: 'Invalid receipt status. Must be RECEIVED, PARTIALLY_RECEIVED, or RECEIPT_REJECTED' });
    }

    // Check if remark is provided
    if (!receiptRemark || !receiptRemark.trim()) {
      return res.status(400).json({ message: 'Receipt remark is required' });
    }

    // Check invoice upload (unless test bypass is enabled)
    const isTestBypass = testBypass === true || process.env.TEST_BYPASS_MODE === 'true';
    if (!isTestBypass && receiptStatus !== 'RECEIPT_REJECTED' && !signedPOUrl) {
      return res.status(400).json({ message: 'Vendor invoice with signature is required for verification' });
    }

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      include: { items: true }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    if (po.status !== 'PENDING_RECEIPT') {
      return res.status(400).json({
        message: `Cannot verify receipt. PO is not pending receipt verification. Current status: ${po.status}`
      });
    }

    // Update item-level receipt info if provided
    if (items && Array.isArray(items)) {
      for (const item of items) {
        if (item.id && (item.receivedQuantity !== undefined || item.receiptRemark || item.receiptStatus)) {
          // Validate: receivedQuantity cannot exceed ordered quantity
          const poItem = po.items.find(i => i.id === item.id);
          if (poItem && item.receivedQuantity > poItem.quantity) {
            return res.status(400).json({
              message: `Cannot receive more than ordered for item. Ordered: ${poItem.quantity}, Entered: ${item.receivedQuantity}`
            });
          }

          await prisma.storePurchaseOrderItem.update({
            where: { id: item.id },
            data: {
              receivedQuantity: item.receivedQuantity,
              receiptRemark: item.receiptRemark || null,
              receiptStatus: item.receiptStatus || null
            }
          });
        }
      }
    }

    // CRITICAL: Check if ALL items are actually fully received
    // This prevents the loophole where user selects "Partial" but enters full quantities
    const updatedItems = await prisma.storePurchaseOrderItem.findMany({
      where: { poId: id }
    });

    const allItemsFullyReceived = updatedItems.every(
      item => (item.receivedQuantity || 0) >= item.quantity
    );

    const anyItemsReceived = updatedItems.some(
      item => (item.receivedQuantity || 0) > 0
    );

    // Determine final status based on ACTUAL received quantities, not just user selection
    let finalStatus;
    let actualReceiptStatus = receiptStatus;

    if (receiptStatus === 'RECEIPT_REJECTED') {
      finalStatus = 'RECEIPT_REJECTED';
    } else if (allItemsFullyReceived) {
      // Auto-correct: if all items fully received, status MUST be RECEIVED
      finalStatus = 'RECEIVED';
      actualReceiptStatus = 'RECEIVED';
    } else if (anyItemsReceived) {
      // Some items received but not all - must be partial
      finalStatus = 'PARTIALLY_RECEIVED';
      actualReceiptStatus = 'PARTIALLY_RECEIVED';
    } else {
      // No items received at all - reject this
      return res.status(400).json({
        message: 'At least one item must have received quantity greater than 0'
      });
    }

    // Generate GIIRN number only when PO is FULLY RECEIVED
    let giirnNumber = null;
    if (finalStatus === 'RECEIVED') {
      giirnNumber = await generateGIIRNNumber();
    }

    // Update PO with receipt verification
    const updatedPO = await prisma.storePurchaseOrder.update({
      where: { id },
      data: {
        status: finalStatus,
        receiptStatus: actualReceiptStatus,
        receiptRemark: receiptRemark.trim(),
        verificationStatement: verificationStatement?.trim() || null,
        receiptVerifiedById: userId,
        receiptVerifiedAt: new Date(),
        signedPOUrl: signedPOUrl || null,
        signedPOUploadedAt: signedPOUrl ? new Date() : null,
        ...(giirnNumber && { giirnNumber }) // Only set if generated
      },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true } },
        createdBy: { select: { id: true, name: true } },
        receiptVerifiedBy: { select: { id: true, name: true } }
      }
    });

    // Create first batch log entry (for audit trail)
    if (actualReceiptStatus !== 'RECEIPT_REJECTED') {
      const totalReceived = updatedPO.items.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0);
      const totalDamaged = updatedPO.items.reduce((sum, item) => {
        const ordered = item.quantity || 0;
        const received = item.receivedQuantity || 0;
        return sum + Math.max(0, ordered - received);
      }, 0);

      const itemsSnapshot = updatedPO.items.map(item => ({
        itemId: item.id,
        productId: item.productId,
        productName: item.product.modelNumber,
        category: item.product.category,
        orderedQty: item.quantity,
        previousReceived: 0,
        quantityInBatch: item.receivedQuantity || 0,
        damagedInBatch: 0,
        totalReceivedNow: item.receivedQuantity || 0,
        remark: item.receiptRemark || null
      }));

      await prisma.receiptBatchLog.create({
        data: {
          poId: id,
          batchNumber: 1, // First batch
          totalReceived,
          totalDamaged: 0,
          resultStatus: finalStatus,
          remark: receiptRemark.trim(),
          verifiedById: userId,
          itemsSnapshot
        }
      });
    }

    const statusMessages = {
      RECEIVED: `All items received successfully. GIIRN: ${giirnNumber}. Items can now be added to store.`,
      PARTIALLY_RECEIVED: 'Partial receipt recorded. Some items are pending. GIIRN will be generated when fully received.',
      RECEIPT_REJECTED: 'Receipt rejected. Please coordinate with vendor.'
    };

    // Inform user if status was auto-corrected
    let message = statusMessages[actualReceiptStatus] || 'Receipt verification completed.';
    if (actualReceiptStatus !== receiptStatus) {
      message = `Status auto-corrected to "${actualReceiptStatus}" based on quantities. ` + message;
    }

    res.json({
      success: true,
      message,
      purchaseOrder: updatedPO,
      giirnNumber: giirnNumber,
      statusCorrected: actualReceiptStatus !== receiptStatus
    });
});

// Get all receipt verified POs (for history view)
export const getReceiptVerifiedPOs = asyncHandler(async function getReceiptVerifiedPOs(req, res) {
    const { status } = req.query;

    const where = status ? { status } : {
      status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIPT_REJECTED'] }
    };

    const pos = await prisma.storePurchaseOrder.findMany({
      where,
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true, contactPerson: true, phone: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        superAdminApprovedBy: { select: { id: true, name: true } },
        adminApprovedBy: { select: { id: true, name: true } },
        receiptVerifiedBy: { select: { id: true, name: true } }
      },
      orderBy: { receiptVerifiedAt: 'desc' }
    });

    res.json(pos);
});

// Upload signed PO document
export const uploadSignedPO = asyncHandler(async function uploadSignedPO(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // File was uploaded to Cloudinary by multer middleware
    res.json({
      success: true,
      url: req.file.path,
      publicId: req.file.filename,
      originalName: req.file.originalname
    });
});

// ========== FOLLOW-UP RECEIPT APIs (For Partially Received POs) ==========

// Get all partially received POs awaiting next batch
export const getPartiallyReceivedPOs = asyncHandler(async function getPartiallyReceivedPOs(req, res) {
    const pos = await prisma.storePurchaseOrder.findMany({
      where: { status: 'PARTIALLY_RECEIVED' },
      include: {
        items: {
          include: {
            product: true
          }
        },
        vendor: { select: { id: true, companyName: true, contactPerson: true, phone: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        superAdminApprovedBy: { select: { id: true, name: true } },
        adminApprovedBy: { select: { id: true, name: true } },
        receiptVerifiedBy: { select: { id: true, name: true } },
        receiptBatches: {
          orderBy: { batchNumber: 'desc' },
          include: {
            verifiedBy: { select: { id: true, name: true } }
          }
        }
      },
      orderBy: { receiptVerifiedAt: 'desc' }
    });

    // Add computed fields for each PO
    const posWithSummary = pos.map(po => {
      const totalOrdered = po.items.reduce((sum, item) => sum + item.quantity, 0);
      const totalReceived = po.items.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0);
      const totalPending = totalOrdered - totalReceived;
      const batchCount = po.receiptBatches.length;

      return {
        ...po,
        summary: {
          totalOrdered,
          totalReceived,
          totalPending,
          batchCount,
          percentReceived: Math.round((totalReceived / totalOrdered) * 100)
        }
      };
    });

    res.json(posWithSummary);
});

// Update partially received PO with new batch
export const updatePartialReceipt = asyncHandler(async function updatePartialReceipt(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const { receiptStatus, items, remark } = req.body;

    // Validate receipt status
    const validStatuses = ['RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIPT_REJECTED'];
    if (!validStatuses.includes(receiptStatus)) {
      return res.status(400).json({
        message: 'Please select a receipt status (All Received, Partial, or Reject)'
      });
    }

    // Validate remark
    if (!remark || !remark.trim()) {
      return res.status(400).json({ message: 'Receipt remark is required' });
    }

    // Validate items array
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Items array is required with quantity updates' });
    }

    // Get the PO
    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        receiptBatches: true
      }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    if (po.status !== 'PARTIALLY_RECEIVED') {
      return res.status(400).json({
        message: `Cannot update. PO status is ${po.status}. Only PARTIALLY_RECEIVED POs can be updated.`
      });
    }

    // Handle rejection - don't update quantities, just mark as rejected
    if (receiptStatus === 'RECEIPT_REJECTED') {
      const batchNumber = po.receiptBatches.length + 1;

      await prisma.receiptBatchLog.create({
        data: {
          poId: id,
          batchNumber,
          totalReceived: 0,
          totalDamaged: 0,
          resultStatus: 'RECEIPT_REJECTED',
          remark: remark.trim(),
          verifiedById: userId,
          itemsSnapshot: []
        }
      });

      await prisma.storePurchaseOrder.update({
        where: { id },
        data: {
          status: 'RECEIPT_REJECTED',
          receiptStatus: 'RECEIPT_REJECTED',
          receiptRemark: remark.trim(),
          receiptVerifiedById: userId,
          receiptVerifiedAt: new Date()
        }
      });

      return res.json({
        success: true,
        message: 'Batch delivery rejected. PO marked as rejected.',
        status: 'RECEIPT_REJECTED'
      });
    }

    // Calculate batch number (next in sequence)
    const batchNumber = po.receiptBatches.length + 1;

    // Process item updates and create snapshot
    const itemsSnapshot = [];
    let totalReceivedInBatch = 0;
    let totalDamagedInBatch = 0;

    for (const update of items) {
      const item = po.items.find(i => i.id === update.itemId);
      if (!item) continue;

      const previousReceived = item.receivedQuantity || 0;
      const quantityInBatch = update.receivedInBatch || 0;
      const damagedInBatch = update.damagedInBatch || 0;
      const newTotalReceived = previousReceived + quantityInBatch;

      // Validate: can't receive more than ordered
      if (newTotalReceived > item.quantity) {
        return res.status(400).json({
          message: `Cannot receive more than ordered for ${item.product.modelNumber}. Ordered: ${item.quantity}, Already received: ${previousReceived}, Trying to add: ${quantityInBatch}`
        });
      }

      totalReceivedInBatch += quantityInBatch;
      totalDamagedInBatch += damagedInBatch;

      // Update item received quantity
      await prisma.storePurchaseOrderItem.update({
        where: { id: item.id },
        data: {
          receivedQuantity: newTotalReceived,
          receiptRemark: update.remark || item.receiptRemark,
          receiptStatus: newTotalReceived >= item.quantity ? 'RECEIVED' : 'PARTIAL'
        }
      });

      // Add to snapshot
      itemsSnapshot.push({
        itemId: item.id,
        productId: item.productId,
        productName: item.product.modelNumber,
        category: item.product.category,
        orderedQty: item.quantity,
        previousReceived,
        quantityInBatch,
        damagedInBatch,
        totalReceivedNow: newTotalReceived,
        remark: update.remark || null
      });
    }

    // CRITICAL: Check if ALL items are actually fully received after this batch
    // This prevents loophole where user selects wrong status
    const updatedItems = await prisma.storePurchaseOrderItem.findMany({
      where: { poId: id }
    });

    const allFullyReceived = updatedItems.every(
      item => (item.receivedQuantity || 0) >= item.quantity
    );

    const anyItemsReceivedInBatch = totalReceivedInBatch > 0;

    // Determine final status based on ACTUAL quantities, not just user selection
    let finalStatus;
    let actualReceiptStatus = receiptStatus;

    if (allFullyReceived) {
      // Auto-correct: if all items fully received, status MUST be RECEIVED
      finalStatus = 'RECEIVED';
      actualReceiptStatus = 'RECEIVED';
    } else if (anyItemsReceivedInBatch) {
      // Some items received but not all - must stay partial
      finalStatus = 'PARTIALLY_RECEIVED';
      actualReceiptStatus = 'PARTIALLY_RECEIVED';
    } else {
      // No items received in this batch
      return res.status(400).json({
        message: 'At least one item must have received quantity greater than 0'
      });
    }

    // Generate GIIRN only when fully received
    let giirnNumber = null;
    if (finalStatus === 'RECEIVED') {
      giirnNumber = await generateGIIRNNumber();
    }

    // Create batch log entry
    await prisma.receiptBatchLog.create({
      data: {
        poId: id,
        batchNumber,
        totalReceived: totalReceivedInBatch,
        totalDamaged: totalDamagedInBatch,
        resultStatus: finalStatus,
        remark: remark.trim(),
        verifiedById: userId,
        itemsSnapshot
      }
    });

    // Update PO status
    const updateData = {
      status: finalStatus,
      receiptStatus: actualReceiptStatus,
      receiptVerifiedById: userId,
      receiptVerifiedAt: new Date(),
      receiptRemark: remark.trim()
    };

    if (giirnNumber) {
      updateData.giirnNumber = giirnNumber;
    }

    const updatedPO = await prisma.storePurchaseOrder.update({
      where: { id },
      data: updateData,
      include: {
        items: { include: { product: true } },
        vendor: { select: { id: true, companyName: true } },
        createdBy: { select: { id: true, name: true } },
        receiptVerifiedBy: { select: { id: true, name: true } },
        receiptBatches: {
          orderBy: { batchNumber: 'desc' },
          include: { verifiedBy: { select: { id: true, name: true } } }
        }
      }
    });

    // Calculate summary
    const totalOrdered = updatedPO.items.reduce((sum, item) => sum + item.quantity, 0);
    const totalReceived = updatedPO.items.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0);

    let message = allFullyReceived
      ? `All items received! GIIRN: ${giirnNumber}. PO is now complete.`
      : `Batch #${batchNumber} recorded. ${totalReceived}/${totalOrdered} items received so far.`;

    // Inform if status was auto-corrected
    if (actualReceiptStatus !== receiptStatus) {
      message = `Status auto-corrected to "${actualReceiptStatus}" based on quantities. ` + message;
    }

    res.json({
      success: true,
      message,
      isComplete: allFullyReceived,
      giirnNumber,
      batchNumber,
      statusCorrected: actualReceiptStatus !== receiptStatus,
      summary: {
        totalOrdered,
        totalReceived,
        totalPending: totalOrdered - totalReceived,
        percentReceived: Math.round((totalReceived / totalOrdered) * 100)
      },
      purchaseOrder: updatedPO
    });
});

// Get receipt batch history for a PO
export const getReceiptBatchHistory = asyncHandler(async function getReceiptBatchHistory(req, res) {
    const { id } = req.params;

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        vendor: { select: { id: true, companyName: true } },
        receiptBatches: {
          orderBy: { batchNumber: 'asc' },
          include: {
            verifiedBy: { select: { id: true, name: true } }
          }
        }
      }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }

    // Calculate current summary
    const totalOrdered = po.items.reduce((sum, item) => sum + item.quantity, 0);
    const totalReceived = po.items.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0);

    res.json({
      poNumber: po.poNumber,
      giirnNumber: po.giirnNumber,
      status: po.status,
      vendor: po.vendor,
      summary: {
        totalOrdered,
        totalReceived,
        totalPending: totalOrdered - totalReceived,
        percentReceived: Math.round((totalReceived / totalOrdered) * 100),
        batchCount: po.receiptBatches.length
      },
      items: po.items.map(item => ({
        id: item.id,
        productName: item.product.modelNumber,
        category: item.product.category,
        ordered: item.quantity,
        received: item.receivedQuantity || 0,
        pending: item.quantity - (item.receivedQuantity || 0),
        status: item.receiptStatus
      })),
      batches: po.receiptBatches
    });
});

// ========== PO-SCOPED INVENTORY APIs ==========

// Get inventory items for a specific PO (items that can be added to store)
export const getPOInventoryItems = asyncHandler(async function getPOInventoryItems(req, res) {
    const { id } = req.params;

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true, poNumber: true }
    });

    if (!po) {
      return res.status(404).json({ message: 'Purchase order not found' });
    }

    const items = await prisma.storePurchaseOrderItem.findMany({
      where: { poId: id },
      include: {
        product: true
      },
      orderBy: { createdAt: 'asc' }
    });

    const pendingItems = items.filter(i => i.status === 'PURCHASED' && (i.receivedQuantity || 0) > 0);
    const inStoreItems = items.filter(i => i.status === 'IN_STORE');

    res.json({
      poNumber: po.poNumber,
      poStatus: po.status,
      pendingItems,
      inStoreItems,
      totalItems: items.length,
      pendingCount: pendingItems.length,
      inStoreCount: inStoreItems.length
    });
});

// Generate Excel template for a specific PO's items
export const generatePOSerialTemplate = asyncHandler(async function generatePOSerialTemplate(req, res) {
    const { id } = req.params;

    const items = await prisma.storePurchaseOrderItem.findMany({
      where: {
        poId: id,
        status: 'PURCHASED',
        receivedQuantity: { gt: 0 }
      },
      include: {
        product: true,
        purchaseOrder: { select: { poNumber: true } }
      }
    });

    if (items.length === 0) {
      return res.status(400).json({ message: 'No items available for inventory in this PO' });
    }

    // Create worksheet data
    const wsData = [['Item ID', 'PO Number', 'Product Model', 'Category', 'Brand', 'Unit #', 'Serial Number']];

    items.forEach(item => {
      const actualQty = item.receivedQuantity ?? item.quantity;
      const isFiber = item.product.category === 'FIBER' || item.product.unit === 'mtrs';

      if (isFiber) {
        wsData.push([
          item.id,
          item.purchaseOrder.poNumber,
          item.product.modelNumber,
          item.product.category,
          item.product.brandName,
          `${actualQty} mtrs`,
          ''
        ]);
      } else {
        for (let i = 1; i <= actualQty; i++) {
          wsData.push([
            item.id,
            item.purchaseOrder.poNumber,
            item.product.modelNumber,
            item.product.category,
            item.product.brandName,
            `${i} of ${actualQty}`,
            ''
          ]);
        }
      }
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 40 }, { wch: 12 }, { wch: 30 }, { wch: 15 }, { wch: 20 }, { wch: 10 }, { wch: 25 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Serial Numbers');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename=serial_template_${id.slice(0, 8)}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Upload Excel with serials for a specific PO and add to store
export const uploadPOSerialsAndAddToStore = asyncHandler(async function uploadPOSerialsAndAddToStore(req, res) {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    const rows = data.slice(1).filter(row => row.length > 0);

    if (rows.length === 0) {
      return res.status(400).json({ message: 'No data found in Excel file' });
    }

    // Group serial numbers by item ID
    const serialsByItem = {};
    rows.forEach(row => {
      const itemId = row[0];
      const serialNumber = row[6]?.toString().trim();
      if (itemId && serialNumber) {
        if (!serialsByItem[itemId]) serialsByItem[itemId] = [];
        serialsByItem[itemId].push(serialNumber);
      }
    });

    const itemIds = Object.keys(serialsByItem);
    if (itemIds.length === 0) {
      return res.status(400).json({ message: 'No serial numbers found in the file' });
    }

    // Validate items belong to this PO
    const items = await prisma.storePurchaseOrderItem.findMany({
      where: {
        id: { in: itemIds },
        poId: id,
        status: 'PURCHASED'
      },
      include: { product: true }
    });

    if (items.length === 0) {
      return res.status(400).json({ message: 'No valid items found for this PO' });
    }

    // Validate serial number counts
    const errors = [];
    items.forEach(item => {
      const isFiber = item.product.category === 'FIBER' || item.product.unit === 'mtrs';
      if (!isFiber) {
        const expectedQty = item.receivedQuantity ?? item.quantity;
        const actualSerials = serialsByItem[item.id]?.length || 0;
        if (actualSerials !== expectedQty) {
          errors.push(`${item.product.modelNumber}: Expected ${expectedQty} serial numbers, got ${actualSerials}`);
        }
      }
    });

    if (errors.length > 0) {
      return res.status(400).json({ message: 'Serial number count mismatch', errors });
    }

    // Update items
    const updatePromises = items.map(item =>
      prisma.storePurchaseOrderItem.update({
        where: { id: item.id },
        data: {
          serialNumbers: serialsByItem[item.id] || [],
          status: 'IN_STORE',
          addedToStoreAt: new Date()
        }
      })
    );
    await Promise.all(updatePromises);

    // Auto-complete PO if all items are now IN_STORE
    await checkAndCompletePOs(items.map(i => i.id));

    res.json({
      success: true,
      message: `${items.length} item(s) added to store with serial numbers`,
      count: items.length
    });
});

// Add PO items to store without serial numbers (fiber/bulk)
export const addPOItemsToStore = asyncHandler(async function addPOItemsToStore(req, res) {
    const { id } = req.params;

    const items = await prisma.storePurchaseOrderItem.findMany({
      where: {
        poId: id,
        status: 'PURCHASED',
        receivedQuantity: { gt: 0 }
      }
    });

    if (items.length === 0) {
      return res.status(400).json({ message: 'No items available to add to store for this PO' });
    }

    const itemIds = items.map(i => i.id);

    await prisma.storePurchaseOrderItem.updateMany({
      where: { id: { in: itemIds } },
      data: {
        status: 'IN_STORE',
        addedToStoreAt: new Date()
      }
    });

    await checkAndCompletePOs(itemIds);

    res.json({
      success: true,
      message: `${items.length} item(s) added to store`,
      count: items.length
    });
});
