import prisma from '../config/db.js';
import { hasAnyRole } from '../utils/roleHelper.js';
import { generateLeadNumber } from '../services/documentNumber.service.js';

const REQUIRED_FIELDS = [
  'name', 'firstName', 'lastName', 'phone', 'email', 'companyName',
  'city', 'state', 'arcAmount', 'otcAmount', 'gstNumber', 'legalName',
  'panNumber', 'tanNumber', 'installationAddress', 'installationPincode',
  'billingAddress', 'billingPincode', 'poNumber', 'poExpiryDate',
  'billDate', 'billingCycle', 'techInchargeMobile', 'techInchargeEmail',
  'accountsInchargeMobile', 'accountsInchargeEmail', 'bdmName',
  'serviceManager', 'numberOfIPs', 'ipAddresses', 'samExecutiveName',
  'bandwidth', 'username'
];

const VALID_BILLING_CYCLES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];

/**
 * Clean phone number to 10 digits
 */
const cleanPhone = (phone) => {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').slice(-10);
};

/**
 * Validate a single row of customer data
 * @returns {{ valid: boolean, errors: string[], cleaned: object }}
 */
const validateRow = (row, rowIndex) => {
  const errors = [];
  const cleaned = {};

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      errors.push(`Row ${rowIndex}: Missing required field "${field}"`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, cleaned };
  }

  // Phone validation
  const phone = cleanPhone(row.phone);
  if (phone.length !== 10) {
    errors.push(`Row ${rowIndex}: Phone must be exactly 10 digits, got "${row.phone}"`);
  }
  cleaned.phone = phone;

  // Numeric validations
  const arcAmount = parseFloat(row.arcAmount);
  if (isNaN(arcAmount)) {
    errors.push(`Row ${rowIndex}: arcAmount must be a valid number, got "${row.arcAmount}"`);
  }
  cleaned.arcAmount = arcAmount;

  const otcAmount = parseFloat(row.otcAmount);
  if (isNaN(otcAmount)) {
    errors.push(`Row ${rowIndex}: otcAmount must be a valid number, got "${row.otcAmount}"`);
  }
  cleaned.otcAmount = otcAmount;

  const numberOfIPs = parseInt(row.numberOfIPs, 10);
  if (isNaN(numberOfIPs)) {
    errors.push(`Row ${rowIndex}: numberOfIPs must be a number, got "${row.numberOfIPs}"`);
  }
  cleaned.numberOfIPs = numberOfIPs;

  // Bandwidth validation
  const bandwidth = parseInt(row.bandwidth, 10);
  if (isNaN(bandwidth)) {
    errors.push(`Row ${rowIndex}: bandwidth must be a number (in Mbps), got "${row.bandwidth}"`);
  }
  cleaned.bandwidth = bandwidth;

  // Billing cycle validation
  const billingCycle = String(row.billingCycle).trim().toUpperCase();
  if (!VALID_BILLING_CYCLES.includes(billingCycle)) {
    errors.push(`Row ${rowIndex}: billingCycle must be one of ${VALID_BILLING_CYCLES.join(', ')}, got "${row.billingCycle}"`);
  }
  cleaned.billingCycle = billingCycle;

  // IP addresses validation
  const ipList = String(row.ipAddresses).split(',').map(ip => ip.trim()).filter(Boolean);
  if (!isNaN(numberOfIPs) && ipList.length !== numberOfIPs) {
    errors.push(`Row ${rowIndex}: IP count (${ipList.length}) does not match numberOfIPs (${numberOfIPs})`);
  }
  cleaned.ipAddresses = ipList;

  // Copy remaining string fields
  cleaned.name = String(row.name).trim();
  cleaned.firstName = String(row.firstName).trim();
  cleaned.lastName = String(row.lastName).trim();
  cleaned.email = String(row.email).trim();
  cleaned.companyName = String(row.companyName).trim();
  cleaned.city = String(row.city).trim();
  cleaned.state = String(row.state).trim();
  cleaned.gstNumber = String(row.gstNumber).trim();
  cleaned.legalName = String(row.legalName).trim();
  cleaned.panNumber = String(row.panNumber).trim();
  cleaned.tanNumber = String(row.tanNumber).trim();
  cleaned.installationAddress = String(row.installationAddress).trim();
  cleaned.installationPincode = String(row.installationPincode).trim();
  cleaned.billingAddress = String(row.billingAddress).trim();
  cleaned.billingPincode = String(row.billingPincode).trim();
  cleaned.poNumber = String(row.poNumber).trim();
  cleaned.poExpiryDate = new Date(row.poExpiryDate);
  cleaned.billDate = new Date(row.billDate);
  cleaned.techInchargeMobile = String(row.techInchargeMobile).trim();
  cleaned.techInchargeEmail = String(row.techInchargeEmail).trim();
  cleaned.accountsInchargeMobile = String(row.accountsInchargeMobile).trim();
  cleaned.accountsInchargeEmail = String(row.accountsInchargeEmail).trim();
  cleaned.bdmName = String(row.bdmName).trim();
  cleaned.serviceManager = String(row.serviceManager).trim();
  cleaned.samExecutiveName = String(row.samExecutiveName).trim();
  cleaned.username = String(row.username).trim();

  // Date validations
  if (isNaN(cleaned.poExpiryDate.getTime())) {
    errors.push(`Row ${rowIndex}: poExpiryDate is not a valid date, got "${row.poExpiryDate}"`);
  }
  if (isNaN(cleaned.billDate.getTime())) {
    errors.push(`Row ${rowIndex}: billDate is not a valid date, got "${row.billDate}"`);
  }

  return { valid: errors.length === 0, errors, cleaned };
};

/**
 * Get or create the "Imported Customers" campaign
 */
const getOrCreateImportCampaign = async (tx) => {
  let campaign = await tx.campaign.findFirst({
    where: { name: 'Imported Customers' }
  });

  if (!campaign) {
    campaign = await tx.campaign.create({
      data: {
        name: 'Imported Customers',
        code: 'IMPORTED-CUSTOMERS',
        type: 'INBOUND',
        status: 'ACTIVE',
        description: 'Auto-created campaign for imported customers'
      }
    });
  }

  return campaign;
};

/**
 * Generate the next customer user ID serial number
 * Looks at existing Lead records for the latest customerUserId
 */
const getNextCustomerSerial = async (tx) => {
  const latest = await tx.lead.findFirst({
    where: { customerUserId: { not: null } },
    orderBy: { customerCreatedAt: 'desc' },
    select: { customerUserId: true }
  });

  if (!latest || !latest.customerUserId) return 1;

  const match = latest.customerUserId.match(/CUST-(\d+)/);
  if (!match) return 1;

  return parseInt(match[1], 10) + 1;
};

/**
 * Generate the next circuit ID serial number
 */
const getNextCircuitSerial = async (tx) => {
  const latest = await tx.lead.findFirst({
    where: { circuitId: { not: null } },
    orderBy: { nocConfiguredAt: 'desc' },
    select: { circuitId: true }
  });

  if (!latest || !latest.circuitId) return 1;

  const match = latest.circuitId.match(/CIRCUIT-(\d+)/);
  if (!match) return 1;

  return parseInt(match[1], 10) + 1;
};

/**
 * Create a single customer import (CampaignData + Lead + optional SAMAssignment)
 * Returns { lead, samWarning }
 */
const createImportedCustomer = async (tx, cleaned, campaign, leadNumber, customerSerial, circuitSerial, userId) => {
  const now = new Date();

  // Create CampaignData
  const campaignData = await tx.campaignData.create({
    data: {
      campaignId: campaign.id,
      name: cleaned.name,
      firstName: cleaned.firstName,
      lastName: cleaned.lastName,
      phone: cleaned.phone,
      email: cleaned.email,
      company: cleaned.companyName,
      city: cleaned.city,
      state: cleaned.state,
      title: cleaned.companyName,
      status: 'INTERESTED',
      isSelfGenerated: false
    }
  });

  const customerUserId = `CUST-${String(customerSerial).padStart(5, '0')}`;
  const customerUsername = cleaned.username;
  const circuitId = `CIRCUIT-${String(circuitSerial).padStart(5, '0')}`;

  // Create Lead
  const lead = await tx.lead.create({
    data: {
      leadNumber,
      campaignDataId: campaignData.id,
      createdById: userId,
      isImported: true,
      status: 'QUALIFIED',
      type: 'QUALIFIED',
      // Legacy import — admin bulk-imported customer. Journey stages are
      // retrofitted (all timestamps = now), so "BULK_UPLOAD_ADMIN" is the
      // closest fit for the origin banner.
      creationSource: 'BULK_UPLOAD_ADMIN',
      deliveryStatus: 'COMPLETED',
      customerAcceptanceStatus: 'ACCEPTED',
      customerAcceptanceAt: now,
      accountsStatus: 'ACCOUNTS_APPROVED',
      accountsVerifiedAt: now,
      accountsVerifiedById: userId,
      opsApprovalStatus: 'APPROVED',
      opsApprovedAt: now,
      opsApprovedById: userId,
      docsVerifiedAt: now,
      docsVerifiedById: userId,
      pushedToInstallationAt: now,
      loginCompletedAt: now,
      customerCreatedAt: now,
      customerCreatedById: userId,
      nocConfiguredAt: now,
      nocConfiguredById: userId,
      customerUserId,
      customerUsername,
      circuitId,
      arcAmount: cleaned.arcAmount,
      otcAmount: cleaned.otcAmount,
      customerGstNo: cleaned.gstNumber,
      customerLegalName: cleaned.legalName,
      panCardNo: cleaned.panNumber,
      tanNumber: cleaned.tanNumber,
      installationAddress: cleaned.installationAddress,
      installationPincode: cleaned.installationPincode,
      billingAddress: cleaned.billingAddress,
      billingPincode: cleaned.billingPincode,
      poNumber: cleaned.poNumber,
      poExpiryDate: cleaned.poExpiryDate,
      billDate: cleaned.billDate,
      actualPlanBillingCycle: cleaned.billingCycle,
      technicalInchargeMobile: cleaned.techInchargeMobile,
      technicalInchargeEmail: cleaned.techInchargeEmail,
      accountsInchargeMobile: cleaned.accountsInchargeMobile,
      accountsInchargeEmail: cleaned.accountsInchargeEmail,
      bdmName: cleaned.bdmName,
      serviceManager: cleaned.serviceManager,
      numberOfIPs: cleaned.numberOfIPs,
      customerIpAddresses: cleaned.ipAddresses,
      customerIpAssigned: cleaned.ipAddresses[0] || null,
      bandwidthRequirement: String(cleaned.bandwidth) + ' Mbps'
    }
  });

  // SAM Assignment
  let samWarning = null;
  if (cleaned.samExecutiveName) {
    const samUser = await tx.user.findFirst({
      where: {
        name: { equals: cleaned.samExecutiveName, mode: 'insensitive' },
        role: { in: ['SAM_EXECUTIVE', 'SAM_HEAD'] },
        isActive: true
      }
    });

    if (samUser) {
      await tx.sAMAssignment.create({
        data: {
          customerId: lead.id,
          samExecutiveId: samUser.id,
          assignedById: userId
        }
      });
    } else {
      samWarning = `SAM executive "${cleaned.samExecutiveName}" not found`;
    }
  }

  return { lead, customerUserId, customerUsername, circuitId, samWarning };
};

/**
 * POST /api/customer-import/bulk
 * Bulk import customers from Excel data
 */
export const bulkImportCustomers = async (req, res) => {
  try {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { rows } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'No data provided. Expected { rows: [...] }' });
    }

    const invalidRows = [];
    const duplicateRows = [];
    const validRows = [];

    // Phase 1: Validate all rows
    for (let i = 0; i < rows.length; i++) {
      const rowIndex = i + 1;
      const { valid, errors, cleaned } = validateRow(rows[i], rowIndex);

      if (!valid) {
        invalidRows.push({ row: rowIndex, errors });
        continue;
      }

      validRows.push({ rowIndex, cleaned });
    }

    // Phase 2: Check for duplicate phones in CampaignData
    const phonesToCheck = validRows.map(r => r.cleaned.phone);
    const existingPhones = await prisma.campaignData.findMany({
      where: { phone: { in: phonesToCheck } },
      select: { phone: true }
    });
    const existingPhoneSet = new Set(existingPhones.map(p => p.phone));

    const importableRows = [];
    for (const row of validRows) {
      if (existingPhoneSet.has(row.cleaned.phone)) {
        duplicateRows.push({
          row: row.rowIndex,
          phone: row.cleaned.phone,
          reason: 'Phone already exists'
        });
      } else {
        importableRows.push(row);
      }
    }

    if (importableRows.length === 0) {
      return res.json({
        message: 'No customers to import.',
        invalidRows,
        duplicateRows,
        samAssignmentErrors: [],
        imported: [],
        summary: {
          total: rows.length,
          valid: validRows.length,
          invalid: invalidRows.length,
          duplicates: duplicateRows.length,
          imported: 0,
          samWarnings: 0
        }
      });
    }

    // Phase 3: Generate lead numbers BEFORE the transaction
    const leadNumbers = [];
    for (let i = 0; i < importableRows.length; i++) {
      const leadNumber = await generateLeadNumber();
      leadNumbers.push(leadNumber);
    }

    // Phase 4: Import inside transaction
    const imported = [];
    const samAssignmentErrors = [];

    await prisma.$transaction(async (tx) => {
      const campaign = await getOrCreateImportCampaign(tx);

      let customerSerial = await getNextCustomerSerial(tx);
      let circuitSerial = await getNextCircuitSerial(tx);

      for (let i = 0; i < importableRows.length; i++) {
        const { rowIndex, cleaned } = importableRows[i];
        const leadNumber = leadNumbers[i];

        const result = await createImportedCustomer(
          tx, cleaned, campaign, leadNumber, customerSerial, circuitSerial, req.user.id
        );

        imported.push({
          row: rowIndex,
          customerUserId: result.customerUserId,
          customerUsername: result.customerUsername,
          circuitId: result.circuitId,
          company: cleaned.companyName
        });

        if (result.samWarning) {
          samAssignmentErrors.push({
            row: rowIndex,
            samName: cleaned.samExecutiveName,
            reason: result.samWarning
          });
        }

        customerSerial++;
        circuitSerial++;
      }
    }, { isolationLevel: 'Serializable', timeout: 60000 });

    res.json({
      message: `Successfully imported ${imported.length} customers.`,
      invalidRows,
      duplicateRows,
      samAssignmentErrors,
      imported,
      summary: {
        total: rows.length,
        valid: validRows.length,
        invalid: invalidRows.length,
        duplicates: duplicateRows.length,
        imported: imported.length,
        samWarnings: samAssignmentErrors.length
      }
    });
  } catch (error) {
    console.error('bulkImportCustomers error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

/**
 * POST /api/customer-import/single
 * Import a single customer
 */
export const importSingleCustomer = async (req, res) => {
  try {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const row = req.body;
    const { valid, errors, cleaned } = validateRow(row, 1);

    if (!valid) {
      return res.status(400).json({ message: 'Validation failed.', errors });
    }

    // Check duplicate phone
    const existingPhone = await prisma.campaignData.findFirst({
      where: { phone: cleaned.phone }
    });

    if (existingPhone) {
      return res.status(409).json({ message: `Phone ${cleaned.phone} already exists.` });
    }

    // Generate lead number before transaction
    const leadNumber = await generateLeadNumber();

    let result;

    await prisma.$transaction(async (tx) => {
      const campaign = await getOrCreateImportCampaign(tx);
      const customerSerial = await getNextCustomerSerial(tx);
      const circuitSerial = await getNextCircuitSerial(tx);

      result = await createImportedCustomer(
        tx, cleaned, campaign, leadNumber, customerSerial, circuitSerial, req.user.id
      );
    }, { isolationLevel: 'Serializable', timeout: 60000 });

    const response = {
      message: 'Customer imported successfully.',
      data: {
        customerUserId: result.customerUserId,
        customerUsername: result.customerUsername,
        circuitId: result.circuitId,
        samAssigned: !result.samWarning,
        samWarning: result.samWarning || undefined
      }
    };

    res.json(response);
  } catch (error) {
    console.error('importSingleCustomer error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

/**
 * GET /api/customer-import/template
 * Returns the template headers and field mapping info
 */
export const getTemplateHeaders = async (req, res) => {
  try {
    if (!hasAnyRole(req.user, ['ACCOUNTS_TEAM', 'SUPER_ADMIN'])) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    res.json({
      message: 'Template headers retrieved.',
      data: {
        headers: REQUIRED_FIELDS,
        fieldMapping: {
          name: 'Contact full name',
          firstName: 'First name',
          lastName: 'Last name',
          phone: 'Phone number (10 digits)',
          email: 'Email address',
          companyName: 'Company name',
          city: 'City',
          state: 'State',
          arcAmount: 'Annual Recurring Charge amount',
          otcAmount: 'One Time Charge amount',
          gstNumber: 'GST number',
          legalName: 'Legal name as per GST',
          panNumber: 'PAN card number',
          tanNumber: 'TAN number',
          installationAddress: 'Installation address',
          installationPincode: 'Installation pincode',
          billingAddress: 'Billing address',
          billingPincode: 'Billing pincode',
          poNumber: 'Purchase order number',
          poExpiryDate: 'PO expiry date (YYYY-MM-DD)',
          billDate: 'Bill date (YYYY-MM-DD)',
          billingCycle: 'Billing cycle (MONTHLY, QUARTERLY, HALF_YEARLY, YEARLY)',
          techInchargeMobile: 'Technical incharge mobile',
          techInchargeEmail: 'Technical incharge email',
          accountsInchargeMobile: 'Accounts incharge mobile',
          accountsInchargeEmail: 'Accounts incharge email',
          bdmName: 'BDM name',
          serviceManager: 'Service manager name',
          numberOfIPs: 'Number of IP addresses',
          ipAddresses: 'Comma-separated IP addresses',
          samExecutiveName: 'SAM executive name',
          bandwidth: 'Bandwidth in Mbps (e.g. 100)',
          username: 'Customer username (from old software)'
        },
        notes: [
          'All 32 fields are required — rows with missing fields will be rejected.',
          'Phone must be exactly 10 digits (non-digit characters are stripped automatically).',
          'arcAmount and otcAmount must be valid numbers.',
          'numberOfIPs must be a number and must match the count of comma-separated ipAddresses.',
          'billingCycle must be one of: MONTHLY, QUARTERLY, HALF_YEARLY, YEARLY.',
          'poExpiryDate and billDate must be valid date strings (recommended format: YYYY-MM-DD).',
          'Duplicate rows (phone already exists in the system) will be skipped.',
          'samExecutiveName is matched case-insensitively against active SAM_EXECUTIVE or SAM_HEAD users.',
          'If SAM executive is not found, the customer is still imported but without SAM assignment.'
        ]
      }
    });
  } catch (error) {
    console.error('getTemplateHeaders error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};
