import prisma from '../config/db.js';
import { isAdmin } from '../utils/roleHelper.js';
import { asyncHandler } from '../utils/controllerHelper.js';

// GET /api/complaint-categories
export const getCategories = asyncHandler(async function getCategories(req, res) {
  const categories = await prisma.complaintCategory.findMany({
    where: { isActive: true },
    include: {
      subCategories: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          description: true,
          defaultTATHours: true,
          isActive: true,
        }
      }
    },
    orderBy: { name: 'asc' }
  });

  res.json({ message: 'Success', data: categories });
});

// GET /api/complaint-categories/all (admin - includes inactive)
export const getAllCategories = asyncHandler(async function getAllCategories(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const categories = await prisma.complaintCategory.findMany({
    include: {
      subCategories: {
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          description: true,
          defaultTATHours: true,
          isActive: true,
        }
      },
      _count: { select: { complaints: true } }
    },
    orderBy: { name: 'asc' }
  });

  res.json({ message: 'Success', data: categories });
});

// POST /api/complaint-categories
export const createCategory = asyncHandler(async function createCategory(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { name, description } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ message: 'Category name is required.' });
  }

  const existing = await prisma.complaintCategory.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return res.status(400).json({ message: 'Category with this name already exists.' });
  }

  const category = await prisma.complaintCategory.create({
    data: {
      name: name.trim(),
      description: description?.trim() || null
    }
  });

  res.status(201).json({ message: 'Category created.', data: category });
});

// PUT /api/complaint-categories/:id
export const updateCategory = asyncHandler(async function updateCategory(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const { name, description, isActive } = req.body;

  const category = await prisma.complaintCategory.findUnique({ where: { id } });
  if (!category) {
    return res.status(404).json({ message: 'Category not found.' });
  }

  if (name && name.trim() !== category.name) {
    const existing = await prisma.complaintCategory.findUnique({ where: { name: name.trim() } });
    if (existing) {
      return res.status(400).json({ message: 'Category with this name already exists.' });
    }
  }

  const updated = await prisma.complaintCategory.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(isActive !== undefined && { isActive })
    }
  });

  res.json({ message: 'Category updated.', data: updated });
});

// POST /api/complaint-categories/:id/sub-categories
export const createSubCategory = asyncHandler(async function createSubCategory(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id: categoryId } = req.params;
  const { name, description, defaultTATHours } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ message: 'Sub-category name is required.' });
  }

  const category = await prisma.complaintCategory.findUnique({ where: { id: categoryId } });
  if (!category) {
    return res.status(404).json({ message: 'Category not found.' });
  }

  const existing = await prisma.complaintSubCategory.findUnique({
    where: { categoryId_name: { categoryId, name: name.trim() } }
  });
  if (existing) {
    return res.status(400).json({ message: 'Sub-category with this name already exists in this category.' });
  }

  const subCategory = await prisma.complaintSubCategory.create({
    data: {
      categoryId,
      name: name.trim(),
      description: description?.trim() || null,
      defaultTATHours: defaultTATHours ? parseInt(defaultTATHours) : 24
    }
  });

  res.status(201).json({ message: 'Sub-category created.', data: subCategory });
});

// PUT /api/complaint-categories/sub-categories/:id
export const updateSubCategory = asyncHandler(async function updateSubCategory(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const { name, description, defaultTATHours, isActive } = req.body;

  const subCategory = await prisma.complaintSubCategory.findUnique({ where: { id } });
  if (!subCategory) {
    return res.status(404).json({ message: 'Sub-category not found.' });
  }

  if (name && name.trim() !== subCategory.name) {
    const existing = await prisma.complaintSubCategory.findUnique({
      where: { categoryId_name: { categoryId: subCategory.categoryId, name: name.trim() } }
    });
    if (existing) {
      return res.status(400).json({ message: 'Sub-category with this name already exists in this category.' });
    }
  }

  const updated = await prisma.complaintSubCategory.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(defaultTATHours !== undefined && { defaultTATHours: parseInt(defaultTATHours) }),
      ...(isActive !== undefined && { isActive })
    }
  });

  res.json({ message: 'Sub-category updated.', data: updated });
});
