import prisma from '../config/db.js';
import { attemptDelivery } from '../services/samWebhook.service.js';

// Dev/admin endpoints for the SAM webhook outbox. Behind staff auth +
// SUPER_ADMIN. Mainly used to (a) inspect what the cron is sweeping and
// (b) manually re-fire a row to confirm SAM-side idempotency end-to-end
// without faking eventIds in psql.

export const replaySamWebhook = async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.samWebhookLog.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ message: 'SamWebhookLog row not found.' });
  }

  // attemptDelivery is a no-op on rows that aren't PENDING (e.g. already
  // DELIVERED or FAILED). To support replaying a DELIVERED row through
  // SAM's idempotency check, flip it back to PENDING for one shot. This
  // is intentional — we want to prove the duplicate path.
  if (existing.status !== 'PENDING') {
    await prisma.samWebhookLog.update({
      where: { id },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    });
  }

  await attemptDelivery(id);

  const row = await prisma.samWebhookLog.findUnique({ where: { id } });
  res.json(row);
};

export const listSamWebhooks = async (req, res) => {
  const { status, leadId, limit } = req.query;
  const take = Math.min(Number(limit) || 50, 200);
  const where = {};
  if (status) where.status = status;
  if (leadId) where.leadId = leadId;

  const rows = await prisma.samWebhookLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json({ items: rows });
};
