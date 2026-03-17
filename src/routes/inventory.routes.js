import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getInventoryItems,
  getInventoryItemById,
  createInventoryItem,
  updateInventoryItem,
  updateInventoryQuantity,
  deleteInventoryItem,
  getInventoryStats,
  getLowStockItems
} from '../controllers/inventory.controller.js';

const router = express.Router();

// All routes require authentication and SUPER_ADMIN or STORE_MANAGER role
router.use(auth);
router.use(requireRole('SUPER_ADMIN', 'STORE_MANAGER'));

// Get inventory stats
router.get('/stats', getInventoryStats);

// Get low stock items
router.get('/low-stock', getLowStockItems);

// Get all inventory items
router.get('/', getInventoryItems);

// Get single inventory item by ID
router.get('/:id', getInventoryItemById);

// Create new inventory item
router.post('/', createInventoryItem);

// Update inventory item
router.put('/:id', updateInventoryItem);

// Update inventory quantity (increment/decrement)
router.patch('/:id/quantity', updateInventoryQuantity);

// Delete inventory item
router.delete('/:id', deleteInventoryItem);

export default router;
