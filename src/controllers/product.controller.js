import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';

// Get all products with hierarchy (All users)
export const getProducts = asyncHandler(async function getProducts(req, res) {
  const products = await prisma.product.findMany({
    orderBy: [
      { parentId: 'asc' }, // Parents first (null values first)
      { title: 'asc' }
    ],
    include: {
      parent: {
        select: { id: true, title: true }
      },
      children: {
        select: { id: true, title: true, status: true },
        orderBy: { title: 'asc' }
      },
      _count: {
        select: { children: true, leadProducts: true }
      }
    }
  });

  res.json({ products });
});

// Get only parent products (for dropdown)
export const getParentProducts = asyncHandler(async function getParentProducts(req, res) {
  const products = await prisma.product.findMany({
    where: {
      parentId: null, // Only root-level products
      status: 'ACTIVE'
    },
    orderBy: { title: 'asc' },
    select: {
      id: true,
      title: true
    }
  });

  res.json({ products });
});

// Get single product with children
export const getProduct = asyncHandler(async function getProduct(req, res) {
  const { id } = req.params;

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      parent: {
        select: { id: true, title: true }
      },
      children: {
        orderBy: { title: 'asc' },
        include: {
          _count: { select: { leadProducts: true } }
        }
      }
    }
  });

  if (!product) {
    return res.status(404).json({ message: 'Product not found.' });
  }

  res.json({ product });
});

// Create product (Admin only)
export const createProduct = asyncHandler(async function createProduct(req, res) {
  const { title, code, isSerialized, status, parentId } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ message: 'Product title is required.' });
  }

  // Validate parent exists if provided
  if (parentId) {
    const parent = await prisma.product.findUnique({ where: { id: parentId } });
    if (!parent) {
      return res.status(400).json({ message: 'Parent product not found.' });
    }
    // Prevent nested hierarchy (only 2 levels allowed)
    if (parent.parentId) {
      return res.status(400).json({ message: 'Cannot create sub-product under another sub-product. Only 2 levels allowed.' });
    }
  }

  const product = await prisma.product.create({
    data: {
      title: title.trim(),
      code: code?.trim() || null,
      isSerialized: isSerialized === true,
      status: status || 'ACTIVE',
      parentId: parentId || null
    },
    include: {
      parent: {
        select: { id: true, title: true }
      }
    }
  });

  res.status(201).json({ product, message: 'Product created successfully.' });
});

// Update product (Admin only)
export const updateProduct = asyncHandler(async function updateProduct(req, res) {
  const { id } = req.params;
  const { title, code, isSerialized, status, parentId } = req.body;

  const existing = await prisma.product.findUnique({
    where: { id },
    include: { children: true }
  });

  if (!existing) {
    return res.status(404).json({ message: 'Product not found.' });
  }

  // Validate parent change
  if (parentId !== undefined && parentId !== existing.parentId) {
    if (parentId) {
      // Cannot set parent if this product has children
      if (existing.children.length > 0) {
        return res.status(400).json({ message: 'Cannot move a parent product under another product. Remove children first.' });
      }

      const parent = await prisma.product.findUnique({ where: { id: parentId } });
      if (!parent) {
        return res.status(400).json({ message: 'Parent product not found.' });
      }
      // Prevent nested hierarchy
      if (parent.parentId) {
        return res.status(400).json({ message: 'Cannot create sub-product under another sub-product. Only 2 levels allowed.' });
      }
      // Prevent circular reference
      if (parentId === id) {
        return res.status(400).json({ message: 'Product cannot be its own parent.' });
      }
    }
  }

  const product = await prisma.product.update({
    where: { id },
    data: {
      title: title !== undefined ? title.trim() : existing.title,
      code: code !== undefined ? (code?.trim() || null) : existing.code,
      isSerialized: isSerialized !== undefined ? isSerialized === true : existing.isSerialized,
      status: status !== undefined ? status : existing.status,
      parentId: parentId !== undefined ? (parentId || null) : existing.parentId
    },
    include: {
      parent: {
        select: { id: true, title: true }
      },
      children: {
        select: { id: true, title: true, status: true }
      }
    }
  });

  res.json({ product, message: 'Product updated successfully.' });
});

// Delete product (Admin only)
export const deleteProduct = asyncHandler(async function deleteProduct(req, res) {
  const { id } = req.params;

  const existing = await prisma.product.findUnique({
    where: { id },
    include: {
      children: true,
      _count: { select: { leadProducts: true } }
    }
  });

  if (!existing) {
    return res.status(404).json({ message: 'Product not found.' });
  }

  // Prevent deletion if has children
  if (existing.children.length > 0) {
    return res.status(400).json({
      message: 'Cannot delete product with sub-products. Delete sub-products first.',
      childrenCount: existing.children.length
    });
  }

  // Warn if product is associated with leads
  if (existing._count.leadProducts > 0) {
    // Still allow deletion but warn
    console.log(`Deleting product ${id} which is associated with ${existing._count.leadProducts} leads`);
  }

  await prisma.product.delete({ where: { id } });

  res.json({ message: 'Product deleted successfully.' });
});
