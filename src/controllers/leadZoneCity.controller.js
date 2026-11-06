/**
 * Zone/city backfill for leads that predate the structured geography.
 *
 * Feasibility now picks a zone and city before a lead can be marked FEASIBLE,
 * so new leads arrive complete. Everything already past that point — including
 * live customers sitting in SAM with a blank CIRCLE / ZONE — has to be filled
 * in by hand, which is what this screen is for.
 *
 * Saving a lead that SAM already holds queues a fresh customer.activated, so
 * the person doing the work sees it land rather than waiting on someone to
 * remember the bulk sweep.
 */
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { isAdminOrTestUser, hasAnyRole } from '../utils/roleHelper.js';
import { checkZoneCity } from '../utils/zoneCity.js';
import {
  enqueueActivationWebhook,
  attemptDeliveryInBackground,
} from '../services/samWebhook.service.js';

function canBackfill(user) {
  return (
    isAdminOrTestUser(user) ||
    hasAnyRole(user, ['FEASIBILITY_TEAM', 'ADMIN', 'SUPER_ADMIN', 'MASTER'])
  );
}

/**
 * GET /api/leads/zone-city/queue
 *
 * Leads still missing a zone or a city. Defaults to the ones that matter most
 * — customers already live in SAM, where the gap is visible to a SAM operator
 * today. `scope=all` widens it to every lead in the pipeline.
 */
export const getZoneCityQueue = asyncHandler(async function getZoneCityQueue(req, res) {
  if (!canBackfill(req.user)) {
    return res.status(403).json({ message: 'You do not have access to this queue.' });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const { search, scope, state } = req.query;

  const where = {};
  // state=missing (the default) is the worklist: leads with nothing set yet.
  // state=all also returns leads that already have a zone and city, so a
  // wrong entry can be corrected — without it a mistake is unreachable the
  // moment it is saved.
  if (state !== 'all') where.OR = [{ zoneId: null }, { cityId: null }];
  if (scope !== 'all') where.actualPlanIsActive = true;

  if (search?.trim()) {
    const term = search.trim();
    // AND-wrap: the missing-geography OR above must survive the search OR.
    where.AND = [
      {
        OR: [
          { leadNumber: { contains: term, mode: 'insensitive' } },
          { campaignData: { company: { contains: term, mode: 'insensitive' } } },
          { campaignData: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
    ];
  }

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: {
        id: true,
        leadNumber: true,
        status: true,
        actualPlanIsActive: true,
        zoneId: true,
        cityId: true,
        zone: { select: { name: true } },
        city: { select: { name: true } },
        installationAddress: true,
        campaignData: { select: { company: true, name: true, city: true } },
      },
      // Unfilled first, then live customers — the work worth doing, in order.
      orderBy: [{ zoneId: 'asc' }, { actualPlanIsActive: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: (page - 1) * limit,
    }),
    prisma.lead.count({ where }),
  ]);

  res.json({
    items: leads.map((l) => ({
      id: l.id,
      leadNumber: l.leadNumber,
      company: l.campaignData?.company || null,
      contactName: l.campaignData?.name || null,
      // What the BDM typed. Shown as a hint so the backfiller has something to
      // go on rather than guessing from the company name alone.
      typedCity: l.campaignData?.city || null,
      address: l.installationAddress || null,
      status: l.status,
      isLiveCustomer: l.actualPlanIsActive,
      zoneId: l.zoneId,
      cityId: l.cityId,
      zoneName: l.zone?.name || null,
      cityName: l.city?.name || null,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

/**
 * PATCH /api/leads/:id/zone-city
 *
 * Sets both at once — a city without its zone is meaningless, and the pair is
 * validated together.
 */
export const setLeadZoneCity = asyncHandler(async function setLeadZoneCity(req, res) {
  if (!canBackfill(req.user)) {
    return res.status(403).json({ message: 'You do not have permission to set zone and city.' });
  }

  const { zoneId, cityId } = req.body || {};

  const city = cityId ? await prisma.city.findUnique({ where: { id: cityId } }) : null;
  const check = checkZoneCity(zoneId, cityId, city);
  if (!check.ok) return res.status(400).json({ message: check.message });

  const lead = await prisma.lead.findUnique({
    where: { id: req.params.id },
    select: { id: true, actualPlanIsActive: true },
  });
  if (!lead) return res.status(404).json({ message: 'Lead not found.' });

  await prisma.lead.update({
    where: { id: lead.id },
    data: { zoneId, cityId, updatedAt: new Date() },
  });

  // Only customers SAM already holds are worth pushing. Anything earlier in
  // the pipeline carries its geography across when it activates.
  let pushedToSam = false;
  if (lead.actualPlanIsActive) {
    const log = await enqueueActivationWebhook(prisma, lead);
    if (log) {
      attemptDeliveryInBackground(log.id);
      pushedToSam = true;
    }
  }

  const updated = await prisma.lead.findUnique({
    where: { id: lead.id },
    select: {
      id: true,
      zoneId: true,
      cityId: true,
      zone: { select: { name: true } },
      city: { select: { name: true } },
    },
  });

  res.json({
    message: pushedToSam
      ? `Saved. ${updated.zone?.name} / ${updated.city?.name} is on its way to SAM.`
      : 'Saved.',
    pushedToSam,
    data: updated,
  });
});
