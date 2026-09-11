import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import {
  productVisibilityWhere,
  PRODUCT_RESTRICTED_ROLES,
} from '../utils/productVisibility.js';

/**
 * Validate an incoming `bdmIds` list and return the rows to create.
 * Rejects anything that is not an active user in a restricted role — an
 * assignment on an ISR or an admin can never have an effect, so silently
 * storing one would just be a lie in the table.
 *
 * Returns null when the caller omitted the key (meaning "leave unchanged").
 */
const validateBdmIds = async (bdmIds) => {
  if (bdmIds === undefined) return null;
  if (!Array.isArray(bdmIds)) {
    throw Object.assign(new Error('bdmIds must be an array of user ids.'), { statusCode: 400 });
  }
  const unique = [...new Set(bdmIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: unique }, isActive: true, role: { in: PRODUCT_RESTRICTED_ROLES } },
    select: { id: true },
  });
  if (users.length !== unique.length) {
    const found = new Set(users.map((u) => u.id));
    const bad = unique.filter((id) => !found.has(id));
    const rows = await prisma.user.findMany({
      where: { id: { in: bad } },
      select: { name: true, role: true, isActive: true },
    });
    const label = rows.length
      ? rows.map((r) => `${r.name} (${r.isActive ? r.role : 'inactive'})`).join(', ')
      : 'one or more selected users';
    throw Object.assign(
      new Error(`Cannot assign ${label} — only active BDM, BDM(CP) and BDM Team Leader users can be given product access.`),
      { statusCode: 400 }
    );
  }
  return unique;
};

// Get all products with hierarchy (All users)
// BDM-family callers see only products they may sell — see utils/productVisibility.js.
export const getProducts = asyncHandler(async function getProducts(req, res) {
  const products = await prisma.product.findMany({
    where: productVisibilityWhere(req.user),
    orderBy: [
      { parentId: 'asc' }, // Parents first (null values first)
      { title: 'asc' }
    ],
    include: {
      // Drives the "All BDMs" / "N BDMs" badge on the admin list.
      assignments: {
        select: { userId: true, user: { select: { id: true, name: true, role: true } } },
      },
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
      status: 'ACTIVE',
      ...productVisibilityWhere(req.user)
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

  // findFirst, not findUnique: the visibility fragment is an OR clause, which
  // findUnique's where does not accept. A product the caller may not see
  // returns 404 rather than 403 — a 403 would confirm it exists.
  const product = await prisma.product.findFirst({
    where: { id, ...productVisibilityWhere(req.user) },
    include: {
      parent: {
        select: { id: true, title: true }
      },
      children: {
        orderBy: { title: 'asc' },
        include: {
          _count: { select: { leadProducts: true } }
        }
      },
      assignments: {
        select: { userId: true, user: { select: { id: true, name: true, role: true } } }
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
  const { title, code, isSerialized, status, parentId, bdmIds } = req.body;

  // Validate before creating so a bad bdmIds list cannot leave an orphan product.
  const assignedBdmIds = await validateBdmIds(bdmIds);

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
      parentId: parentId || null,
      // No rows means visible to every BDM — restriction is opt-in.
      ...(assignedBdmIds?.length
        ? { assignments: { create: assignedBdmIds.map((userId) => ({ userId })) } }
        : {})
    },
    include: {
      parent: {
        select: { id: true, title: true }
      },
      assignments: {
        select: { userId: true, user: { select: { id: true, name: true, role: true } } }
      }
    }
  });

  res.status(201).json({ product, message: 'Product created successfully.' });
});

// Update product (Admin only)
export const updateProduct = asyncHandler(async function updateProduct(req, res) {
  const { id } = req.params;
  const { title, code, isSerialized, status, parentId, bdmIds } = req.body;

  // null => key omitted, leave assignments alone. [] => clear them, which
  // returns the product to "visible to all BDMs".
  const assignedBdmIds = await validateBdmIds(bdmIds);

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

  // Replace the assignment set rather than merging: removing a BDM has to be
  // possible, and a partial failure must not leave a half-changed access list.
  const product = await prisma.$transaction(async (tx) => {
    if (assignedBdmIds !== null) {
      await tx.productAssignment.deleteMany({ where: { productId: id } });
      if (assignedBdmIds.length > 0) {
        await tx.productAssignment.createMany({
          data: assignedBdmIds.map((userId) => ({ userId, productId: id }))
        });
      }
    }

    return tx.product.update({
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
        },
        assignments: {
          select: { userId: true, user: { select: { id: true, name: true, role: true } } }
        }
      }
    });
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
