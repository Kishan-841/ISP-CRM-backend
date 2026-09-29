// Verifies the SAM-as-solo-BDM feature end-to-end against the LOCAL API.
// Usage: backend running on :5001 (npm run dev), then:
//   node scripts/verify-sam-role.js
// Creates/refreshes fixture users (emails @verify.local) — never run against prod.
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.VERIFY_BASE_URL || 'http://localhost:5001/api';
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing to run: DATABASE_URL is not local.');
  process.exit(2);
}

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${extra}`}`);
  if (!cond) failures.push(name);
};

async function upsertUser(email, role, extra = {}) {
  return prisma.user.upsert({
    where: { email },
    update: { role, isActive: true, teamLeaderId: null, ...extra },
    create: { email, name: email.split('@')[0], password: 'x', passwordIsHashed: false, role, ...extra },
  });
}
const tokenFor = (u) => jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
async function call(user, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokenFor(user)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function main() {
  const admin = await upsertUser('verify-admin@verify.local', 'SUPER_ADMIN');
  const bdm = await upsertUser('verify-solo-bdm@verify.local', 'BDM');
  const sam = await upsertUser('verify-sam@verify.local', 'SAM');
  // Role 'SAM_INTEGRATION' does not exist until the enum change lands; do not crash the run.
  let integ = null;
  let integErr = '';
  try {
    integ = await upsertUser('verify-integration@verify.local', 'SAM_INTEGRATION');
  } catch (e) {
    integErr = `enum missing (${String(e.message).split('\n').pop().slice(0, 120)})`;
  }
  const other = await upsertUser('verify-other-bdm@verify.local', 'BDM');

  // A campaign owned by someone else — SAM must NOT see it (fail-open guard).
  const foreign = await prisma.campaign.upsert({
    where: { code: 'VERIFY-FOREIGN' },
    update: { createdById: other.id },
    create: { code: 'VERIFY-FOREIGN', name: 'VERIFY foreign campaign', type: 'ALL', createdById: other.id },
  });
  await prisma.campaignAssignment.deleteMany({ where: { campaignId: foreign.id, userId: sam.id } });

  // Positive control: a campaign created by SAM must be visible to SAM.
  const own = await prisma.campaign.upsert({
    where: { code: 'VERIFY-SAM-OWN' },
    update: { createdById: sam.id },
    create: { code: 'VERIFY-SAM-OWN', name: 'VERIFY SAM own campaign', type: 'ALL', createdById: sam.id },
  });

  // Foreign lead: created by and assigned to the other BDM, in the foreign campaign.
  const FOREIGN_COMPANY = 'VERIFY Foreign Lead Co';
  let fData = await prisma.campaignData.findFirst({ where: { campaignId: foreign.id, company: FOREIGN_COMPANY } });
  if (!fData) {
    fData = await prisma.campaignData.create({
      data: { campaignId: foreign.id, name: 'VERIFY Foreign Lead', phone: '9000000099', company: FOREIGN_COMPANY,
              title: 'Owner', createdById: other.id, assignedToId: other.id },
    });
  }
  let foreignLead = await prisma.lead.findUnique({ where: { campaignDataId: fData.id } });
  if (!foreignLead) {
    foreignLead = await prisma.lead.create({
      data: { campaignDataId: fData.id, createdById: other.id, assignedToId: other.id, status: 'NEW', isColdLead: false },
    });
  } else {
    foreignLead = await prisma.lead.update({ where: { id: foreignLead.id }, data: { createdById: other.id, assignedToId: other.id } });
  }
  const mentions = (r, lead) => {
    const t = JSON.stringify(r.json || {});
    return t.includes(lead.id) || t.includes(FOREIGN_COMPANY);
  };

  // 1. SAM has the same BDM endpoints as a solo BDM
  for (const path of ['/leads/bdm/queue', '/leads/bdm/dashboard-stats', '/leads/bdm/meetings',
                      '/leads/bdm/follow-ups', '/leads/bdm/sidebar-counts', '/campaigns',
                      '/campaigns/self-leads/stats', '/users/by-role?role=ISR']) {
    const b = await call(bdm, 'GET', path);
    const s = await call(sam, 'GET', path);
    check(`SAM status matches solo BDM on ${path}`, b.status === s.status && s.status === 200, `bdm=${b.status} sam=${s.status}`);
  }

  // 2. Sidebar counts: SAM gets the BDM key set
  const bc = await call(bdm, 'GET', '/users/sidebar-counts');
  const sc = await call(sam, 'GET', '/users/sidebar-counts');
  const bb = await call(bdm, 'GET', '/leads/bdm/sidebar-counts');
  const sb = await call(sam, 'GET', '/leads/bdm/sidebar-counts');
  check('SAM /leads/bdm/sidebar-counts status 200', bb.status === 200 && sb.status === 200, `bdm=${bb.status} sam=${sb.status}`);
  check('SAM and BDM /users/sidebar-counts status 200', bc.status === 200 && sc.status === 200, `bdm=${bc.status} sam=${sc.status}`);
  const bKeys = Object.keys(bc.json?.counts || bc.json || {}).sort().join(',');
  const sKeys = Object.keys(sc.json?.counts || sc.json || {}).sort().join(',');
  check('SAM sidebar-count keys equal solo BDM keys', bKeys === sKeys && bKeys.length > 0, `bdm=[${bKeys}] sam=[${sKeys}]`);

  // 3. Fail-open guard: SAM does not see a foreign campaign
  const camps = await call(sam, 'GET', '/campaigns');
  const list = camps.json?.campaigns || camps.json?.data || [];
  check('SAM sees a campaign it created (positive control)', camps.status === 200 && list.some((c) => c.id === own.id), `status=${camps.status} saw ${list.length} campaigns`);
  check('SAM cannot see other users\' campaigns (200 and not listed)', camps.status === 200 && !list.some((c) => c.id === foreign.id), `status=${camps.status} saw ${list.length} campaigns`);

  // 3b. Fail-open guard on leads: SAM must not see another BDM's lead
  const sq = await call(sam, 'GET', '/leads/bdm/queue?limit=500');
  check('SAM /leads/bdm/queue is 200 and excludes foreign lead', sq.status === 200 && !mentions(sq, foreignLead), `status=${sq.status}`);
  const sl = await call(sam, 'GET', '/leads?limit=500');
  check('SAM /leads is 200 and excludes foreign lead', sl.status === 200 && !mentions(sl, foreignLead), `status=${sl.status}`);

  // 3c. Fail-open guard on campaign data: SAM must not see CampaignData of the foreign campaign
  const ad = await call(sam, 'GET', '/campaigns/all-data?limit=500');
  const adText = JSON.stringify(ad.json || {});
  check('SAM /campaigns/all-data is 200 and excludes foreign campaign data',
    ad.status === 200 && !adText.includes(fData.id) && !adText.includes(FOREIGN_COMPANY) && !adText.includes(foreign.id), `status=${ad.status}`);

  // 4. GPS mandatory on direct add for SAM
  const uniq = String(Date.now()).slice(-8);
  const fullBody = {
    name: 'VERIFY Direct', company: `VERIFY Direct Co ${uniq}`, phone: `98${uniq}`, email: `verify-direct-${uniq}@verify.local`,
    existingIsp: 'VerifyNet', existingBandwidth: '100 Mbps', existingPlanExpiryDate: '2027-01-31',
  };
  const noGps = await call(sam, 'POST', '/leads/bdm/direct-add', fullBody);
  check('SAM direct-add without GPS is rejected (400, location message)',
    noGps.status === 400 && /location/i.test(noGps.json?.message || ''), `status=${noGps.status} msg=${noGps.json?.message}`);
  const withGps = await call(sam, 'POST', '/leads/bdm/direct-add', { ...fullBody, createdLatitude: 12.9716, createdLongitude: 77.5946, locationAccuracy: 10 });
  check('SAM direct-add with GPS succeeds (2xx)', withGps.status >= 200 && withGps.status < 300, `status=${withGps.status} msg=${withGps.json?.message}`);
  // Positive control: SAM's own new lead must appear in SAM's own queue
  const sq2 = await call(sam, 'GET', '/leads/bdm/queue?limit=500');
  check("SAM's own new lead appears in SAM's /leads/bdm/queue (positive control)",
    sq2.status === 200 && JSON.stringify(sq2.json || {}).includes(fullBody.company), `status=${sq2.status}`);

  // 5. SAM is an assignment target next to solo BDMs
  const tls = await call(admin, 'GET', '/leads/team-leaders');
  const samRow = (tls.json?.users || []).find((u) => u.id === sam.id);
  check('team-leaders lists SAM with kind SAM', samRow?.kind === 'SAM', JSON.stringify(samRow));
  const pool = await call(admin, 'GET', '/leads/bdm-users');
  check('bdm-users (admin pool) includes SAM', (pool.json?.users || []).some((u) => u.id === sam.id));

  // 6. Admin can open SAM's individual dashboard
  const ds = await call(admin, 'GET', `/leads/bdm/dashboard-stats?userId=${sam.id}`);
  check('admin dashboard-stats accepts SAM target', ds.status === 200, `status=${ds.status}`);

  // 7. Solo enforcement: admin cannot give SAM a team leader
  const tl = await upsertUser('verify-tl@verify.local', 'BDM_TEAM_LEADER');
  const put1 = await call(admin, 'PUT', `/users/${sam.id}`, { teamLeaderId: tl.id });
  const samAfter = await prisma.user.findUnique({ where: { id: sam.id }, select: { teamLeaderId: true } });
  check('admin PUT teamLeaderId onto SAM returns 200', put1.status === 200, `status=${put1.status} msg=${put1.json?.message}`);
  check('SAM teamLeaderId stays null after admin update', samAfter.teamLeaderId === null, `got ${samAfter.teamLeaderId}`);

  // 7b. BDM with a team leader changed to SAM must lose the TL
  const conv = await upsertUser('verify-converted@verify.local', 'BDM', { teamLeaderId: tl.id });
  const put2 = await call(admin, 'PUT', `/users/${conv.id}`, { role: 'SAM' });
  const convAfter = await prisma.user.findUnique({ where: { id: conv.id }, select: { role: true, teamLeaderId: true } });
  check('admin PUT role SAM on BDM-with-TL returns 200', put2.status === 200, `status=${put2.status} msg=${put2.json?.message}`);
  check('BDM changed to SAM loses its team leader', convAfter.role === 'SAM' && convAfter.teamLeaderId === null, `role=${convAfter.role} tl=${convAfter.teamLeaderId}`);

  // 8. Old SAM feature is gone
  const old = await call(admin, 'GET', '/sam/my-customers');
  check('/api/sam/* returns 404', old.status === 404, `status=${old.status}`);

  // 9. Integration login
  // 7c. A team leader with an active member cannot be changed to SAM
  const tl2 = await upsertUser('verify-tl2@verify.local', 'BDM_TEAM_LEADER');
  await upsertUser('verify-tl2-member@verify.local', 'BDM', { teamLeaderId: tl2.id });
  const put3 = await call(admin, 'PUT', `/users/${tl2.id}`, { role: 'SAM' });
  const tl2After = await prisma.user.findUnique({ where: { id: tl2.id }, select: { role: true } });
  check('admin PUT role SAM on TL with active members returns 400', put3.status === 400, `status=${put3.status} msg=${put3.json?.message}`);
  check('TL role unchanged after rejected SAM change', tl2After.role === 'BDM_TEAM_LEADER', `got ${tl2After.role}`);

  // 7d. SAM_INTEGRATION is never listed by /users/by-role
  const allUsers = await call(admin, 'GET', '/users/by-role?role=ALL');
  check('by-role ALL excludes SAM_INTEGRATION fixture',
    allUsers.status === 200 && !(allUsers.json?.users || []).some((u) => u.role === 'SAM_INTEGRATION' || (integ && u.id === integ.id)), `status=${allUsers.status}`);
  const integList = await call(admin, 'GET', '/users/by-role?role=SAM_INTEGRATION');
  check('by-role SAM_INTEGRATION returns empty list', integList.status === 200 && (integList.json?.users || []).length === 0, `status=${integList.status}`);

  const ig = integ ? await call(integ, 'GET', '/integrations/sam/bdms') : { status: 'n/a' };
  check('SAM_INTEGRATION can call integration API', ig.status === 200, integ ? `status=${ig.status}` : integErr);
  const igSam = await call(sam, 'GET', '/integrations/sam/bdms');
  check('SAM (sales) cannot call integration API', igSam.status === 403, `status=${igSam.status}`);

  console.log(failures.length ? `\n${failures.length} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  await prisma.$disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
