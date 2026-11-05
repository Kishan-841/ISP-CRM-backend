/**
 * Seeds the service geography from the operations sheet.
 *
 * Idempotent — safe to re-run on prod. Zones upsert on name, cities on
 * (zoneId, name), so running it twice changes nothing and adding a row to the
 * list below is all it takes to roll a new one out.
 *
 * Note: the source sheet listed "Sangali" twice under Kolhapur. It appears
 * once here; the (zoneId, name) unique constraint would have collapsed it
 * anyway.
 *
 *   node prisma/seedZones.js
 */
import prisma from '../src/config/db.js';

const GEOGRAPHY = {
  Kolhapur: ['Kolhapur', 'Satara', 'Sangali', 'Karad'],
  Pune: [
    'Pune',
    'Pune- Chakan',
    'Pune- Ranjangaon',
    'Pune- Khed City',
    'Pune- Talegon',
    'Pune - Rest of Pune',
  ],
  'Shambhaji Nagar': ['Shambhaji Nagar city', 'Walunj', 'Shendra', 'Ahilya Nagar'],
  Nashik: ['Nashik City'],
  Nagpur: ['Nagpur City', 'Nagpur Buttibori', 'Nagpur Hingana MIDC'],
  Mumbai: ['Mumbai City'],
  Ahemadabad: ['Ahemadabad city'],
  Surat: ['Surat City'],
  Kolkota: ['Kolkota'],
  Gujrat: ['Rest of Gujrat'],
  Chennai: ['Chennai City'],
  Hyderabad: ['Hyderbad City'],
};

async function main() {
  let zoneCount = 0;
  let cityCount = 0;

  for (const [zoneName, cities] of Object.entries(GEOGRAPHY)) {
    const zone = await prisma.zone.upsert({
      where: { name: zoneName },
      update: { isActive: true },
      create: { name: zoneName },
    });
    zoneCount += 1;

    for (const cityName of cities) {
      await prisma.city.upsert({
        where: { zoneId_name: { zoneId: zone.id, name: cityName } },
        update: { isActive: true },
        create: { zoneId: zone.id, name: cityName },
      });
      cityCount += 1;
    }
  }

  console.log(`Seeded ${zoneCount} zones and ${cityCount} cities.`);
}

main()
  .catch((err) => {
    console.error('Zone seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
