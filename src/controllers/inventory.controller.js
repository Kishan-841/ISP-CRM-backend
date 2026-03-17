import prisma from '../config/db.js';
import { asyncHandler, buildSearchFilter } from '../utils/controllerHelper.js';

// Get all inventory items
export const getInventoryItems = asyncHandler(async function getInventoryItems(req, res) {
  const { search, isActive } = req.query;

  const where = {};

  // Filter by active status
  if (isActive !== undefined) {
    where.isActive = isActive === 'true';
  }

  // Search filter
  if (search) {
    where.OR = buildSearchFilter(search, ['name', 'description']);
  }

  const items = await prisma.inventoryItem.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  res.json(items);
});

// Get single inventory item by ID
export const getInventoryItemById = asyncHandler(async function getInventoryItemById(req, res) {
  const { id } = req.params;

  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  if (!item) {
    return res.status(404).json({ message: 'Inventory item not found' });
  }

  res.json(item);
});

// Create new inventory item
export const createInventoryItem = asyncHandler(async function createInventoryItem(req, res) {
  const {
    name,
    category,
    description,
    quantity,
    unit,
    minStock
  } = req.body;

  // Validate required fields
  if (!name?.trim()) {
    return res.status(400).json({ message: 'Product name is required' });
  }

  const item = await prisma.inventoryItem.create({
    data: {
      name: name.trim(),
      category: category?.trim() || null,
      description: description?.trim() || null,
      quantity: parseInt(quantity) || 0,
      unit: unit?.trim() || 'pcs',
      minStock: parseInt(minStock) || 0,
      createdById: req.user.id
    },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  res.status(201).json({
    success: true,
    message: 'Inventory item created successfully',
    item
  });
});

// Update inventory item
export const updateInventoryItem = asyncHandler(async function updateInventoryItem(req, res) {
  const { id } = req.params;
  const {
    name,
    category,
    description,
    quantity,
    unit,
    minStock,
    isActive
  } = req.body;

  // Check if item exists
  const existingItem = await prisma.inventoryItem.findUnique({
    where: { id }
  });

  if (!existingItem) {
    return res.status(404).json({ message: 'Inventory item not found' });
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name.trim();
  if (category !== undefined) updateData.category = category?.trim() || null;
  if (description !== undefined) updateData.description = description?.trim() || null;
  if (quantity !== undefined) updateData.quantity = parseInt(quantity) || 0;
  if (unit !== undefined) updateData.unit = unit?.trim() || 'pcs';
  if (minStock !== undefined) updateData.minStock = parseInt(minStock) || 0;
  if (isActive !== undefined) updateData.isActive = isActive;

  const item = await prisma.inventoryItem.update({
    where: { id },
    data: updateData,
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  res.json({
    success: true,
    message: 'Inventory item updated successfully',
    item
  });
});

// Update inventory quantity (increment/decrement)
export const updateInventoryQuantity = asyncHandler(async function updateInventoryQuantity(req, res) {
  const { id } = req.params;
  const { adjustment } = req.body;

  if (adjustment === undefined || adjustment === 0) {
    return res.status(400).json({ message: 'Adjustment value is required' });
  }

  const existingItem = await prisma.inventoryItem.findUnique({
    where: { id }
  });

  if (!existingItem) {
    return res.status(404).json({ message: 'Inventory item not found' });
  }

  const newQuantity = existingItem.quantity + parseInt(adjustment);

  if (newQuantity < 0) {
    return res.status(400).json({ message: 'Quantity cannot be negative' });
  }

  const item = await prisma.inventoryItem.update({
    where: { id },
    data: { quantity: newQuantity },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  res.json({
    success: true,
    message: `Inventory quantity ${adjustment > 0 ? 'increased' : 'decreased'} successfully`,
    item
  });
});

// Delete inventory item (permanently)
export const deleteInventoryItem = asyncHandler(async function deleteInventoryItem(req, res) {
  const { id } = req.params;

  const item = await prisma.inventoryItem.findUnique({
    where: { id }
  });

  if (!item) {
    return res.status(404).json({ message: 'Inventory item not found' });
  }

  // Hard delete
  await prisma.inventoryItem.delete({
    where: { id }
  });

  res.json({
    success: true,
    message: 'Inventory item deleted successfully'
  });
});

// Get inventory stats
export const getInventoryStats = asyncHandler(async function getInventoryStats(req, res) {
  const [total, active, inactive] = await Promise.all([
    prisma.inventoryItem.count(),
    prisma.inventoryItem.count({ where: { isActive: true } }),
    prisma.inventoryItem.count({ where: { isActive: false } })
  ]);

  // Get low stock items separately with proper comparison
  const allActiveItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      quantity: true,
      minStock: true
    }
  });

  const lowStockCount = allActiveItems.filter(item => item.quantity <= item.minStock).length;

  res.json({
    total,
    active,
    inactive,
    lowStock: lowStockCount
  });
});

// Get low stock items
export const getLowStockItems = asyncHandler(async function getLowStockItems(req, res) {
  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true
    },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true }
      }
    }
  });

  // Filter items where quantity <= minStock
  const lowStockItems = items.filter(item => item.quantity <= item.minStock);

  res.json(lowStockItems);
});

export default {
  getInventoryItems,
  getInventoryItemById,
  createInventoryItem,
  updateInventoryItem,
  updateInventoryQuantity,
  deleteInventoryItem,
  getInventoryStats,
  getLowStockItems
};
