import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { uploadToCloudinary } from '../config/cloudinary.js';
import multer from 'multer';
import {
  // Product APIs
  getProducts,
  getAllProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductCategories,
  getBrands,
  getWarehouses,
  // PO APIs
  createPurchaseOrder,
  getPurchaseOrders,
  getPurchaseOrder,
  getAvailableItems,
  addToStore,
  generateSerialTemplate,
  uploadSerialsAndAddToStore,
  getStoreInventory,
  getStoreStats,
  getVendors,
  createVendor,
  // PO Approval APIs
  getPendingApprovalPOs,
  getAdminPurchaseOrders,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  getPOApprovalStats,
  updatePurchaseOrder,
  deletePurchaseOrder,
  // Goods Receipt Verification APIs
  getPendingReceiptPOs,
  getReceiptStats,
  verifyGoodsReceipt,
  getReceiptVerifiedPOs,
  uploadSignedPO,
  // Follow-up Receipt APIs (for partially received POs)
  getPartiallyReceivedPOs,
  updatePartialReceipt,
  getReceiptBatchHistory,
  // PO-Scoped Inventory APIs
  getPOInventoryItems,
  generatePOSerialTemplate,
  uploadPOSerialsAndAddToStore,
  addPOItemsToStore
} from '../controllers/store.controller.js';

const router = express.Router();

// Multer for Excel file uploads (memory storage)
const excelUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel') {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files are allowed'), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// All routes require authentication
router.use(auth);

// Store Manager and Admin can access these routes
const storeAccess = requireRole('STORE_MANAGER', 'SUPER_ADMIN');

// Delivery Team can also view products for material requests
const productViewAccess = requireRole('STORE_MANAGER', 'SUPER_ADMIN', 'DELIVERY_TEAM', 'ADMIN', 'AREA_HEAD', 'FEASIBILITY_TEAM');

// ========== PRODUCT (ITEM) ROUTES ==========

// Get product categories for dropdown
router.get('/product-categories', storeAccess, getProductCategories);

// Get brand options for dropdown
router.get('/brands', storeAccess, getBrands);

// Get warehouse options for dropdown
router.get('/warehouses', storeAccess, getWarehouses);

// Get products for dropdown (active only) - Allow delivery team to view for material requests
router.get('/products', productViewAccess, getProducts);

// Get all products with full details
router.get('/products/all', storeAccess, getAllProducts);

// Create new product
router.post('/products', storeAccess, createProduct);

// Update product
router.put('/products/:id', storeAccess, updateProduct);

// Delete product
router.delete('/products/:id', storeAccess, deleteProduct);

// ========== PURCHASE ORDER ROUTES ==========

// Get vendors for dropdown
router.get('/vendors', storeAccess, getVendors);

// Create new vendor
router.post('/vendors', storeAccess, createVendor);

// Create new Purchase Order
router.post('/purchase-orders', storeAccess, createPurchaseOrder);

// Get all Purchase Orders
router.get('/purchase-orders', storeAccess, getPurchaseOrders);

// Get single Purchase Order
router.get('/purchase-orders/:id', storeAccess, getPurchaseOrder);

// Get available items (purchased but not in store)
router.get('/available-items', storeAccess, getAvailableItems);

// Add items to store from PO
router.post('/add-to-store', storeAccess, addToStore);

// Generate Excel template for serial numbers
router.post('/add-to-store/template', storeAccess, generateSerialTemplate);

// Upload Excel with serial numbers and add to store
router.post('/add-to-store/upload-serials', storeAccess, excelUpload.single('file'), uploadSerialsAndAddToStore);

// ========== PO-SCOPED INVENTORY ROUTES ==========

// Get items for a specific PO that can be added to inventory
router.get('/purchase-orders/:id/inventory-items', storeAccess, getPOInventoryItems);

// Add all PO items to store without serials (fiber/bulk)
router.post('/purchase-orders/:id/add-to-inventory', storeAccess, addPOItemsToStore);

// Generate Excel template for a specific PO's receivable items
router.post('/purchase-orders/:id/add-to-inventory/template', storeAccess, generatePOSerialTemplate);

// Upload Excel with serials for a specific PO
router.post('/purchase-orders/:id/add-to-inventory/upload', storeAccess, excelUpload.single('file'), uploadPOSerialsAndAddToStore);

// ========== STORE INVENTORY ROUTES ==========

// Get store inventory (only items IN_STORE)
router.get('/inventory', storeAccess, getStoreInventory);

// Get store stats
router.get('/stats', storeAccess, getStoreStats);

// ========== PO APPROVAL ROUTES (Super Admin & Admin) ==========

const approverAccess = requireRole('SUPER_ADMIN', 'ADMIN');

// Get PO approval stats
router.get('/po-approval/stats', approverAccess, getPOApprovalStats);

// Get all POs pending approval (filtered by role in controller)
router.get('/po-approval/pending', approverAccess, getPendingApprovalPOs);

// Get all POs for admin (with optional status filter)
router.get('/po-approval/all', approverAccess, getAdminPurchaseOrders);

// Approve a PO (2-level approval handled in controller)
router.post('/po-approval/:id/approve', approverAccess, approvePurchaseOrder);

// Reject a PO
router.post('/po-approval/:id/reject', approverAccess, rejectPurchaseOrder);

// Update/Edit a PO (only Super Admin can edit)
router.put('/po-approval/:id', requireRole('SUPER_ADMIN'), updatePurchaseOrder);

// Delete a PO (only Super Admin can delete)
router.delete('/po-approval/:id', requireRole('SUPER_ADMIN'), deletePurchaseOrder);

// ========== GOODS RECEIPT VERIFICATION ROUTES (Admin only) ==========

const adminAccess = requireRole('ADMIN', 'SUPER_ADMIN');

// Get receipt verification stats
router.get('/goods-receipt/stats', adminAccess, getReceiptStats);

// Get POs pending receipt verification
router.get('/goods-receipt/pending', adminAccess, getPendingReceiptPOs);

// Get all receipt verified POs (history)
router.get('/goods-receipt/verified', adminAccess, getReceiptVerifiedPOs);

// Verify goods receipt
router.post('/goods-receipt/:id/verify', adminAccess, verifyGoodsReceipt);

// Upload signed PO document
router.post('/goods-receipt/upload-signed-po', adminAccess, uploadToCloudinary.single('file'), uploadSignedPO);

// ========== FOLLOW-UP RECEIPT ROUTES (For Partially Received POs) ==========

// Get all partially received POs awaiting next batch
router.get('/goods-receipt/partial', adminAccess, getPartiallyReceivedPOs);

// Update partially received PO with new batch
router.post('/goods-receipt/:id/update-batch', adminAccess, updatePartialReceipt);

// Get receipt batch history for a PO
router.get('/goods-receipt/:id/batch-history', adminAccess, getReceiptBatchHistory);

export default router;
