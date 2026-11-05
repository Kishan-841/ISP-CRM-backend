/**
 * Service geography — Zone → City.
 *
 * Reads are open to any authenticated user because the dropdowns appear in the
 * feasibility form and the backfill screen. Writes are admin-only: this is
 * reference data that other records point at, not something a sales user
 * should be able to reshape mid-pipeline.
 *
 * Deletes are soft (isActive=false). A zone retired today is still the right
 * answer for every lead already pointing at it, and a hard delete would null
 * those out silently.
 */
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { isAdminOrTestUser, hasAnyRole } from '../utils/roleHelper.js';

function canManage(user) {
  return isAdminOrTestUser(user) || hasAnyRole(user, ['ADMIN', 'SUPER_ADMIN', 'MASTER']);
}

/**
 * GET /api/zones
 *
 * Every zone with its cities. `includeInactive=true` is for the admin screen,
 * which has to show a retired row in order to reactivate it; the dropdowns
 * everywhere else get active rows only.
 */
export const getZones = asyncHandler(async function getZones(req, res) {
  const includeInactive = req.query.includeInactive === 'true' && canManage(req.user);

  const zones = await prisma.zone.findMany({
    where: includeInactive ? {} : { isActive: true },
    include: {
      cities: {
        where: includeInactive ? {} : { isActive: true },
        orderBy: { name: 'asc' },
      },
      _count: { select: { leads: true } },
    },
    orderBy: { name: 'asc' },
  });

  res.json({
    message: 'Success',
    data: zones.map((z) => ({
      id: z.id,
      name: z.name,
      isActive: z.isActive,
      leadCount: z._count.leads,
      cities: z.cities.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive })),
    })),
  });
});

export const createZone = asyncHandler(async function createZone(req, res) {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: 'Only an admin can manage zones.' });
  }
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ message: 'Zone name is required.' });

  const existing = await prisma.zone.findUnique({ where: { name } });
  if (existing) {
    // Re-adding a retired zone is the common case — reactivate rather than
    // 409'ing and leaving the admin to find it among the inactive rows.
    if (!existing.isActive) {
      const revived = await prisma.zone.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
      return res.json({ message: 'Zone reactivated.', data: revived });
    }
    return res.status(400).json({ message: `Zone "${name}" already exists.` });
  }

  const zone = await prisma.zone.create({ data: { name } });
  res.status(201).json({ message: 'Zone created.', data: zone });
});

export const updateZone = asyncHandler(async function updateZone(req, res) {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: 'Only an admin can manage zones.' });
  }
  const { name, isActive } = req.body || {};
  const data = {};
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ message: 'Zone name cannot be empty.' });
    data.name = trimmed;
  }
  if (isActive !== undefined) data.isActive = isActive === true;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'Nothing to update.' });
  }

  const zone = await prisma.zone.update({ where: { id: req.params.id }, data });
  res.json({ message: 'Zone updated.', data: zone });
});

/**
 * DELETE /api/zones/:id — soft delete.
 *
 * Deactivates the zone and its cities together. Leaving the cities active
 * under a retired zone would let them keep appearing in a dropdown with no
 * parent to select first.
 */
export const deleteZone = asyncHandler(async function deleteZone(req, res) {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: 'Only an admin can manage zones.' });
  }
  const zone = await prisma.zone.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { leads: true } } },
  });
  if (!zone) return res.status(404).json({ message: 'Zone not found.' });

  await prisma.$transaction([
    prisma.zone.update({ where: { id: zone.id }, data: { isActive: false } }),
    prisma.city.updateMany({ where: { zoneId: zone.id }, data: { isActive: false } }),
  ]);

  res.json({
    message:
      zone._count.leads > 0
        ? `Zone deactivated. ${zone._count.leads} existing lead(s) keep it.`
        : 'Zone deactivated.',
  });
});

export const createCity = asyncHandler(async function createCity(req, res) {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: 'Only an admin can manage cities.' });
  }
  const name = req.body?.name?.trim();
  const { zoneId } = req.body || {};
  if (!zoneId) return res.status(400).json({ message: 'Zone is required.' });
  if (!name) return res.status(400).json({ message: 'City name is required.' });

  const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
  if (!zone) return res.status(404).json({ message: 'Zone not found.' });

  const existing = await prisma.city.findUnique({
    where: { zoneId_name: { zoneId, name } },
  });
  if (existing) {
    if (!existing.isActive) {
      const revived = await prisma.city.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
      return res.json({ message: 'City reactivated.', data: revived });
    }
    return res.status(400).json({ message: `"${name}" already exists in ${zone.name}.` });
  }

  const city = await prisma.city.create({ data: { zoneId, name } });
  res.status(201).json({ message: 'City created.', data: city });
});

export const updateCity = asyncHandler(async function updateCity(req, res) {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: 'Only an admin can manage cities.' });
  }
  const { name, isActive } = req.body || {};
  const data = {};
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ message: 'City name cannot be empty.' });
    data.name = trimmed;
  }
  if (isActive !== undefined) data.isActive = isActive === true;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'Nothing to update.' });
  }

  const city = await prisma.city.update({ where: { id: req.params.id }, data });
  res.json({ message: 'City updated.', data: city });
});

export const deleteCity = asyncHandler(async function deleteCity(req, res) {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: 'Only an admin can manage cities.' });
  }
  const city = await prisma.city.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { leads: true } } },
  });
  if (!city) return res.status(404).json({ message: 'City not found.' });

  await prisma.city.update({ where: { id: city.id }, data: { isActive: false } });
  res.json({
    message:
      city._count.leads > 0
        ? `City deactivated. ${city._count.leads} existing lead(s) keep it.`
        : 'City deactivated.',
  });
});
