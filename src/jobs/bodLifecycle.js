import cron from 'node-cron';
import prisma from '../config/db.js';
import { createNotification, notifyAllByRole } from '../services/notification.service.js';

// Bandwidth on Demand lifecycle — runs daily at 00:30.
//   BILLED  whose startDate has arrived → ACTIVE   (NOC: "starts today")
//   ACTIVE  whose endDate is today       → reminder (NOC: "ends today, revert tomorrow")
//   ACTIVE/BILLED whose endDate passed   → EXPIRED  (NOC: "revert now"; BDM informed)

const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const BOD_SELECT = {
  id: true, bodNumber: true, requestedBandwidthMbps: true, currentPlanBandwidth: true,
  startDate: true, endDate: true, createdById: true,
  lead: { select: { leadNumber: true, customerUsername: true, campaignData: { select: { company: true } } } }
};

const label = (b) => `${b.lead.campaignData?.company} (${b.lead.customerUsername || b.lead.leadNumber})`;
const notifyNoc = (type, title, message, bod) => Promise.all(
  ['NOC', 'NOC_HEAD'].map(role => notifyAllByRole(role, type, title, message, { bodId: bod.id }))
);

export async function runBodLifecycle(now = new Date()) {
  const today = startOfDay(now);
  const todayEnd = endOfDay(now);
  const summary = { activated: 0, reminded: 0, expired: 0 };

  // 1. Expire anything whose window has fully passed (ACTIVE, or BILLED that was never activated)
  const toExpire = await prisma.bandwidthOnDemand.findMany({
    where: { status: { in: ['ACTIVE', 'BILLED'] }, endDate: { lt: today } },
    select: BOD_SELECT
  });
  for (const bod of toExpire) {
    await prisma.bandwidthOnDemand.update({ where: { id: bod.id }, data: { status: 'EXPIRED' } });
    const revert = bod.currentPlanBandwidth ? `revert to ${bod.currentPlanBandwidth} Mbps` : 'revert to the regular plan bandwidth';
    await notifyNoc('BOD_EXPIRED', 'Bandwidth on Demand ended — revert',
      `${label(bod)}: the ${bod.requestedBandwidthMbps} Mbps window ended on ${fmtDate(bod.endDate)} — ${revert} now. Ref ${bod.bodNumber}.`, bod);
    await createNotification(bod.createdById, 'BOD_EXPIRED', 'BOD window ended',
      `${bod.bodNumber} (${label(bod)}) ended on ${fmtDate(bod.endDate)}; NOC has been asked to revert.`, { bodId: bod.id });
    summary.expired++;
  }

  // 2. Activate billed requests whose start date has arrived
  const toActivate = await prisma.bandwidthOnDemand.findMany({
    where: { status: 'BILLED', startDate: { lte: todayEnd } },
    select: BOD_SELECT
  });
  for (const bod of toActivate) {
    await prisma.bandwidthOnDemand.update({ where: { id: bod.id }, data: { status: 'ACTIVE' } });
    await notifyNoc('BOD_ACTIVE', 'Bandwidth on Demand starts today',
      `${label(bod)}: ${bod.requestedBandwidthMbps} Mbps should be live from today until ${fmtDate(bod.endDate)}. Ref ${bod.bodNumber}.`, bod);
    summary.activated++;
  }

  // 3. Remind NOC on the last day of the window
  const endingToday = await prisma.bandwidthOnDemand.findMany({
    where: { status: 'ACTIVE', endDate: { gte: today, lte: todayEnd } },
    select: BOD_SELECT
  });
  for (const bod of endingToday) {
    const revert = bod.currentPlanBandwidth ? `revert to ${bod.currentPlanBandwidth} Mbps` : 'revert to the regular plan bandwidth';
    await notifyNoc('BOD_ENDING', 'Bandwidth on Demand ends today',
      `${label(bod)}: ${bod.requestedBandwidthMbps} Mbps window ends today — ${revert} tomorrow morning. Ref ${bod.bodNumber}.`, bod);
    summary.reminded++;
  }

  return summary;
}

export function startBodLifecycleJob() {
  cron.schedule('30 0 * * *', async () => {
    try {
      const s = await runBodLifecycle();
      console.log(`[BOD lifecycle] activated=${s.activated} reminded=${s.reminded} expired=${s.expired}`);
    } catch (err) {
      console.error('[BOD lifecycle] failed:', err);
    }
  });
  console.log('⏰ BOD lifecycle job scheduled (daily 00:30)');
}
