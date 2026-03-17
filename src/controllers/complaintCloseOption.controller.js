import prisma from '../config/db.js';
import { isAdmin } from '../utils/roleHelper.js';
import { asyncHandler } from '../utils/controllerHelper.js';

// GET /api/complaint-close-options
// Returns active options grouped by type (no auth required beyond login)
export const getCloseOptions = asyncHandler(async function getCloseOptions(req, res) {
  const options = await prisma.complaintCloseOption.findMany({
    where: { isActive: true },
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    select: { id: true, type: true, label: true, sortOrder: true },
  });

  // Group by type
  const grouped = {
    REASON_FOR_OUTAGE: options.filter(o => o.type === 'REASON_FOR_OUTAGE'),
    RESOLUTION: options.filter(o => o.type === 'RESOLUTION'),
    RESOLUTION_TYPE: options.filter(o => o.type === 'RESOLUTION_TYPE'),
  };

  res.json({ data: grouped });
});

// GET /api/complaint-close-options/all (admin - includes inactive)
export const getAllCloseOptions = asyncHandler(async function getAllCloseOptions(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const options = await prisma.complaintCloseOption.findMany({
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
  });

  res.json({ data: options });
});

// POST /api/complaint-close-options (admin only)
export const createCloseOption = asyncHandler(async function createCloseOption(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { type, label, sortOrder } = req.body;
  if (!type || !label?.trim()) {
    return res.status(400).json({ message: 'Type and label are required.' });
  }

  const validTypes = ['REASON_FOR_OUTAGE', 'RESOLUTION', 'RESOLUTION_TYPE'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ message: 'Invalid type.' });
  }

  try {
    const option = await prisma.complaintCloseOption.create({
      data: {
        type,
        label: label.trim(),
        sortOrder: sortOrder || 0,
      },
    });

    res.status(201).json({ message: 'Option created.', data: option });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ message: 'An option with this type and label already exists.' });
    }
    throw error;
  }
});

// PUT /api/complaint-close-options/:id (admin only)
export const updateCloseOption = asyncHandler(async function updateCloseOption(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const { label, isActive, sortOrder } = req.body;

  const existing = await prisma.complaintCloseOption.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: 'Option not found.' });

  const data = {};
  if (label !== undefined) data.label = label.trim();
  if (isActive !== undefined) data.isActive = isActive;
  if (sortOrder !== undefined) data.sortOrder = sortOrder;

  try {
    const updated = await prisma.complaintCloseOption.update({
      where: { id },
      data,
    });

    res.json({ message: 'Option updated.', data: updated });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ message: 'An option with this type and label already exists.' });
    }
    throw error;
  }
});
