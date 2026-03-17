import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const ADMIN_ID = '6aad07c8-48d2-4ed8-9dc9-97c2f1eac18e';

const products = [
  // ═══════════════════════════════════════
  // SWITCHES
  // ═══════════════════════════════════════
  { category: 'SWITCH', modelNumber: 'TL-SG1005D', brandName: 'TP-Link', price: 1200, description: '5-Port Gigabit Desktop Switch' },
  { category: 'SWITCH', modelNumber: 'TL-SG1008D', brandName: 'TP-Link', price: 2200, description: '8-Port Gigabit Desktop Switch' },
  { category: 'SWITCH', modelNumber: 'TL-SG1008MP', brandName: 'TP-Link', price: 6500, description: '8-Port Gigabit PoE+ Switch' },
  { category: 'SWITCH', modelNumber: 'TL-SG1016D', brandName: 'TP-Link', price: 5500, description: '16-Port Gigabit Desktop Switch' },
  { category: 'SWITCH', modelNumber: 'TL-SG1024D', brandName: 'TP-Link', price: 8500, description: '24-Port Gigabit Rackmount Switch' },
  { category: 'SWITCH', modelNumber: 'TL-SG2210MP', brandName: 'TP-Link', price: 15000, description: '10-Port Gigabit PoE+ Smart Switch' },
  { category: 'SWITCH', modelNumber: 'TL-SG3428', brandName: 'TP-Link', price: 18000, description: '24-Port Gigabit L2+ Managed Switch with 4 SFP Slots' },
  { category: 'SWITCH', modelNumber: 'DGS-1210-10', brandName: 'D-Link', price: 8000, description: '10-Port Gigabit Smart Managed Switch' },
  { category: 'SWITCH', modelNumber: 'DGS-1210-28', brandName: 'D-Link', price: 18000, description: '28-Port Gigabit Smart Managed Switch' },
  { category: 'SWITCH', modelNumber: 'DGS-1210-52', brandName: 'D-Link', price: 28000, description: '52-Port Gigabit Smart Managed Switch' },
  { category: 'SWITCH', modelNumber: 'CBS250-8T-D', brandName: 'Cisco', price: 12000, description: '8-Port Gigabit Smart Switch' },
  { category: 'SWITCH', modelNumber: 'CBS250-24T-4G', brandName: 'Cisco', price: 25000, description: '24-Port Gigabit Smart Switch with 4 SFP' },
  { category: 'SWITCH', modelNumber: 'CBS350-24T-4G', brandName: 'Cisco', price: 35000, description: '24-Port Gigabit Managed Switch with 4 SFP' },
  { category: 'SWITCH', modelNumber: 'GS308-300PES', brandName: 'Netgear', price: 2000, description: '8-Port Gigabit Unmanaged Switch' },
  { category: 'SWITCH', modelNumber: 'GS324-200INS', brandName: 'Netgear', price: 7500, description: '24-Port Gigabit Unmanaged Switch' },
  { category: 'SWITCH', modelNumber: 'USW-24', brandName: 'Ubiquiti', price: 20000, description: '24-Port Managed Gigabit Switch' },
  { category: 'SWITCH', modelNumber: 'USW-24-POE', brandName: 'Ubiquiti', price: 32000, description: '24-Port PoE Managed Gigabit Switch' },
  { category: 'SWITCH', modelNumber: 'CRS326-24G-2S+RM', brandName: 'MikroTik', price: 14000, description: '24-Port Gigabit Switch with 2 SFP+' },
  { category: 'SWITCH', modelNumber: 'CRS328-24P-4S+RM', brandName: 'MikroTik', price: 28000, description: '24-Port PoE Gigabit Switch with 4 SFP+' },

  // ═══════════════════════════════════════
  // SFP MODULES
  // ═══════════════════════════════════════
  // 1G SFP
  { category: 'SFP', modelNumber: 'SFP-1G-SX', brandName: 'Generic', price: 500, description: '1G SFP SX Multi-mode 850nm 550m LC' },
  { category: 'SFP', modelNumber: 'SFP-1G-LX-20', brandName: 'Generic', price: 800, description: '1G SFP LX Single-mode 1310nm 20km LC' },
  { category: 'SFP', modelNumber: 'SFP-1G-LX-40', brandName: 'Generic', price: 1200, description: '1G SFP LX Single-mode 1310nm 40km LC' },
  { category: 'SFP', modelNumber: 'SFP-1G-LX-80', brandName: 'Generic', price: 2500, description: '1G SFP LX Single-mode 1550nm 80km LC' },
  { category: 'SFP', modelNumber: 'TL-SM311LS', brandName: 'TP-Link', price: 1500, description: '1G SFP LX Single-mode 10km LC' },
  { category: 'SFP', modelNumber: 'TL-SM311LM', brandName: 'TP-Link', price: 1200, description: '1G SFP SX Multi-mode 550m LC' },
  { category: 'SFP', modelNumber: 'GLC-SX-MMD', brandName: 'Cisco', price: 3500, description: '1G SFP SX Multi-mode 550m LC' },
  { category: 'SFP', modelNumber: 'GLC-LH-SMD', brandName: 'Cisco', price: 4500, description: '1G SFP LX Single-mode 10km LC' },
  { category: 'SFP', modelNumber: 'UF-MM-1G', brandName: 'Ubiquiti', price: 800, description: '1G SFP Multi-mode 550m LC' },
  { category: 'SFP', modelNumber: 'UF-SM-1G-S', brandName: 'Ubiquiti', price: 1000, description: '1G SFP Single-mode 3km LC' },
  // 10G SFP+
  { category: 'SFP', modelNumber: 'SFP-10G-SR', brandName: 'Generic', price: 2500, description: '10G SFP+ SR Multi-mode 850nm 300m LC' },
  { category: 'SFP', modelNumber: 'SFP-10G-LR-20', brandName: 'Generic', price: 4000, description: '10G SFP+ LR Single-mode 1310nm 20km LC' },
  { category: 'SFP', modelNumber: 'SFP-10G-LR-40', brandName: 'Generic', price: 6000, description: '10G SFP+ LR Single-mode 1310nm 40km LC' },
  { category: 'SFP', modelNumber: 'SFP-10G-LR-80', brandName: 'Generic', price: 12000, description: '10G SFP+ LR Single-mode 1550nm 80km LC' },
  { category: 'SFP', modelNumber: 'SFP-10G-SR-CISCO', brandName: 'Cisco', price: 15000, description: '10G SFP+ SR Multi-mode 300m LC' },
  { category: 'SFP', modelNumber: 'SFP-10G-LR-CISCO', brandName: 'Cisco', price: 20000, description: '10G SFP+ LR Single-mode 10km LC' },
  { category: 'SFP', modelNumber: 'UF-MM-10G', brandName: 'Ubiquiti', price: 2500, description: '10G SFP+ Multi-mode 300m LC' },
  { category: 'SFP', modelNumber: 'UF-SM-10G', brandName: 'Ubiquiti', price: 4500, description: '10G SFP+ Single-mode 10km LC' },
  // 25G SFP28
  { category: 'SFP', modelNumber: 'SFP28-25G-SR', brandName: 'Generic', price: 5000, description: '25G SFP28 SR Multi-mode 100m LC' },
  { category: 'SFP', modelNumber: 'SFP28-25G-LR', brandName: 'Generic', price: 10000, description: '25G SFP28 LR Single-mode 10km LC' },

  // ═══════════════════════════════════════
  // CLOSURES
  // ═══════════════════════════════════════
  { category: 'CLOSURE', modelNumber: 'FJC-2WAY', brandName: 'Generic', price: 350, description: '2-Way Fiber Joint Closure - Dome Type' },
  { category: 'CLOSURE', modelNumber: 'FJC-4WAY', brandName: 'Generic', price: 500, description: '4-Way Fiber Joint Closure - Dome Type' },
  { category: 'CLOSURE', modelNumber: 'FJC-6WAY', brandName: 'Generic', price: 700, description: '6-Way Fiber Joint Closure - Dome Type' },
  { category: 'CLOSURE', modelNumber: 'FJC-8WAY', brandName: 'Generic', price: 900, description: '8-Way Fiber Joint Closure - Dome Type' },
  { category: 'CLOSURE', modelNumber: 'FJC-12WAY', brandName: 'Generic', price: 1200, description: '12-Way Fiber Joint Closure - Dome Type' },
  { category: 'CLOSURE', modelNumber: 'FJC-24WAY', brandName: 'Generic', price: 1800, description: '24-Way Fiber Joint Closure - Dome Type' },
  { category: 'CLOSURE', modelNumber: 'FJC-48WAY', brandName: 'Generic', price: 2800, description: '48-Way Fiber Joint Closure - Inline Type' },
  { category: 'CLOSURE', modelNumber: 'FTTH-NAP-8', brandName: 'Generic', price: 600, description: '8-Port FTTH NAP Box (Network Access Point)' },
  { category: 'CLOSURE', modelNumber: 'FTTH-NAP-16', brandName: 'Generic', price: 900, description: '16-Port FTTH NAP Box (Network Access Point)' },
  { category: 'CLOSURE', modelNumber: 'ODB-4', brandName: 'Generic', price: 250, description: '4-Port Outdoor Distribution Box' },
  { category: 'CLOSURE', modelNumber: 'ODB-8', brandName: 'Generic', price: 400, description: '8-Port Outdoor Distribution Box' },
  { category: 'CLOSURE', modelNumber: 'ODB-16', brandName: 'Generic', price: 650, description: '16-Port Outdoor Distribution Box' },

  // ═══════════════════════════════════════
  // RF EQUIPMENT
  // ═══════════════════════════════════════
  { category: 'RF', modelNumber: 'LAP-GPS', brandName: 'Ubiquiti', price: 5500, description: 'LiteAP GPS 5GHz 17dBi 120° Sector' },
  { category: 'RF', modelNumber: 'LBE-5AC-Gen2', brandName: 'Ubiquiti', price: 5500, description: 'LiteBeam 5AC Gen2 23dBi CPE' },
  { category: 'RF', modelNumber: 'NS-5ACL', brandName: 'Ubiquiti', price: 5000, description: 'NanoStation 5AC Loco 13dBi CPE' },
  { category: 'RF', modelNumber: 'PBE-5AC-Gen2', brandName: 'Ubiquiti', price: 8500, description: 'PowerBeam 5AC Gen2 25dBi CPE' },
  { category: 'RF', modelNumber: 'PBE-5AC-620', brandName: 'Ubiquiti', price: 14000, description: 'PowerBeam 5AC 620mm 29dBi Long Range' },
  { category: 'RF', modelNumber: 'R5AC-Lite', brandName: 'Ubiquiti', price: 7500, description: 'Rocket 5AC Lite BaseStation' },
  { category: 'RF', modelNumber: 'R5AC-PTMP', brandName: 'Ubiquiti', price: 12000, description: 'Rocket 5AC PTMP BaseStation' },
  { category: 'RF', modelNumber: 'AM-5G17-90', brandName: 'Ubiquiti', price: 8000, description: 'airMAX 5GHz 17dBi 90° Sector Antenna' },
  { category: 'RF', modelNumber: 'AM-5G20-90', brandName: 'Ubiquiti', price: 10000, description: 'airMAX 5GHz 20dBi 90° Sector Antenna' },
  { category: 'RF', modelNumber: 'ePMP-F300-25', brandName: 'Cambium', price: 15000, description: 'ePMP Force 300-25 5GHz 25dBi CPE' },
  { category: 'RF', modelNumber: 'ePMP-F300-16', brandName: 'Cambium', price: 12000, description: 'ePMP Force 300-16 5GHz 16dBi CPE' },
  { category: 'RF', modelNumber: 'ePMP-3000', brandName: 'Cambium', price: 35000, description: 'ePMP 3000 5GHz Access Point' },
  { category: 'RF', modelNumber: 'SXTsq-5-ac', brandName: 'MikroTik', price: 4500, description: 'SXTsq 5 ac 16dBi 5GHz CPE' },
  { category: 'RF', modelNumber: 'LHG-XL-5-ac', brandName: 'MikroTik', price: 7000, description: 'LHG XL 5 ac 27dBi 5GHz CPE' },
  { category: 'RF', modelNumber: 'SXT-SA5-ac', brandName: 'MikroTik', price: 5000, description: 'SXT SA5 ac 13dBi CPE' },
  { category: 'RF', modelNumber: 'mANTBox-52-15s', brandName: 'MikroTik', price: 12000, description: 'mANTBox 52 15s Dual-band Sector' },

  // ═══════════════════════════════════════
  // PATCH CORDS
  // ═══════════════════════════════════════
  // LC-LC
  { category: 'PATCH_CORD', modelNumber: 'PC-LC-LC-SM-1M', brandName: 'Generic', price: 150, description: 'LC-LC Single-mode Patch Cord 1 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-LC-LC-SM-2M', brandName: 'Generic', price: 180, description: 'LC-LC Single-mode Patch Cord 2 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-LC-LC-SM-3M', brandName: 'Generic', price: 200, description: 'LC-LC Single-mode Patch Cord 3 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-LC-LC-SM-5M', brandName: 'Generic', price: 250, description: 'LC-LC Single-mode Patch Cord 5 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-LC-LC-SM-10M', brandName: 'Generic', price: 350, description: 'LC-LC Single-mode Patch Cord 10 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-LC-LC-MM-1M', brandName: 'Generic', price: 120, description: 'LC-LC Multi-mode OM3 Patch Cord 1 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-LC-LC-MM-3M', brandName: 'Generic', price: 180, description: 'LC-LC Multi-mode OM3 Patch Cord 3 Meter' },
  // SC-SC
  { category: 'PATCH_CORD', modelNumber: 'PC-SC-SC-SM-1M', brandName: 'Generic', price: 120, description: 'SC-SC Single-mode Patch Cord 1 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-SC-SC-SM-3M', brandName: 'Generic', price: 180, description: 'SC-SC Single-mode Patch Cord 3 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-SC-SC-SM-5M', brandName: 'Generic', price: 220, description: 'SC-SC Single-mode Patch Cord 5 Meter' },
  // SC-LC
  { category: 'PATCH_CORD', modelNumber: 'PC-SC-LC-SM-1M', brandName: 'Generic', price: 150, description: 'SC-LC Single-mode Patch Cord 1 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-SC-LC-SM-3M', brandName: 'Generic', price: 200, description: 'SC-LC Single-mode Patch Cord 3 Meter' },
  { category: 'PATCH_CORD', modelNumber: 'PC-SC-LC-SM-5M', brandName: 'Generic', price: 250, description: 'SC-LC Single-mode Patch Cord 5 Meter' },

  // ═══════════════════════════════════════
  // FIBER CABLE
  // ═══════════════════════════════════════
  { category: 'FIBER', modelNumber: 'FC-2C-SM', brandName: 'Generic', price: 8, unit: 'mtr', description: '2-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'FC-4C-SM', brandName: 'Generic', price: 12, unit: 'mtr', description: '4-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'FC-6C-SM', brandName: 'Generic', price: 16, unit: 'mtr', description: '6-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'FC-8C-SM', brandName: 'Generic', price: 20, unit: 'mtr', description: '8-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'FC-12C-SM', brandName: 'Generic', price: 28, unit: 'mtr', description: '12-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'FC-24C-SM', brandName: 'Generic', price: 45, unit: 'mtr', description: '24-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'FC-48C-SM', brandName: 'Generic', price: 80, unit: 'mtr', description: '48-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'FC-96C-SM', brandName: 'Generic', price: 140, unit: 'mtr', description: '96-Core Single-mode Fiber Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'DROP-1C-SM', brandName: 'Generic', price: 5, unit: 'mtr', description: '1-Core FTTH Drop Cable (per meter)' },
  { category: 'FIBER', modelNumber: 'DROP-2C-SM', brandName: 'Generic', price: 7, unit: 'mtr', description: '2-Core FTTH Drop Cable (per meter)' },
];

async function main() {
  console.log(`Seeding ${products.length} store products...\n`);

  let created = 0;
  let skipped = 0;

  for (const p of products) {
    try {
      await prisma.storeProduct.create({
        data: {
          category: p.category,
          modelNumber: p.modelNumber,
          brandName: p.brandName,
          price: p.price,
          description: p.description,
          unit: p.unit || 'pcs',
          createdById: ADMIN_ID
        }
      });
      created++;
      console.log(`  ✓ ${p.category.padEnd(12)} ${p.modelNumber.padEnd(25)} ${p.brandName.padEnd(12)} ₹${p.price}`);
    } catch (err) {
      if (err.code === 'P2002') {
        skipped++;
        console.log(`  ⊘ SKIPPED (exists): ${p.modelNumber}`);
      } else {
        console.error(`  ✗ ERROR: ${p.modelNumber} — ${err.message}`);
      }
    }
  }

  console.log(`\nDone! Created: ${created}, Skipped: ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
