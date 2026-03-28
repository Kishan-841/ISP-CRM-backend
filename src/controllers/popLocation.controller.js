import prisma from '../config/db.js';
import { hasAnyRole } from '../utils/roleHelper.js';

/**
 * GET /api/pop-locations
 * List all active POP locations (searchable)
 */
export const getPopLocations = async (req, res) => {
  try {
    const { search } = req.query;

    const where = { isActive: true };
    if (search && search.trim()) {
      where.name = { contains: search.trim(), mode: 'insensitive' };
    }

    const locations = await prisma.popLocation.findMany({
      where,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        address: true,
      }
    });

    res.json({ locations });
  } catch (error) {
    console.error('getPopLocations error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

/**
 * POST /api/pop-locations
 * Create a new POP location
 */
export const createPopLocation = async (req, res) => {
  try {
    const { name, latitude, longitude, address } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'POP location name is required.' });
    }

    // Check duplicate
    const existing = await prisma.popLocation.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' } }
    });
    if (existing) {
      return res.status(409).json({ message: 'POP location with this name already exists.', location: existing });
    }

    const location = await prisma.popLocation.create({
      data: {
        name: name.trim(),
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        address: address?.trim() || null,
        createdById: req.user.id,
      },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        address: true,
      }
    });

    res.json({ message: 'POP location created.', location });
  } catch (error) {
    console.error('createPopLocation error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};
