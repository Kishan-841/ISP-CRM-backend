import prisma from '../config/db.js';

/**
 * Document Number Generation Service
 *
 * Format: PREFIX/DD/MM/YY-XXXX
 * Example: GLL/27/01/26-0001
 *
 * Rules:
 * - Sequence never resets (global counter per document type)
 * - Each document type has independent counter
 * - 4-digit padding (0001, 0002... 9999, 10000...)
 * - Date = document creation date (DD/MM/YY with 2-digit year)
 */

const DOCUMENT_CONFIG = {
  INVOICE: { prefix: 'GLL' },
  RECEIPT: { prefix: 'RCP' },
  CREDIT_NOTE: { prefix: 'CN' },
  OTC_INVOICE: { prefix: 'OTC' },
  ADVANCE_PAYMENT: { prefix: 'ADV' },
  VENDOR_PO: { prefix: 'PO-VEN' },
  COMPLAINT: { prefix: 'COMP' },
  ENQUIRY: { prefix: 'ENQ' },
  SERVICE_ORDER: { prefix: 'SO' },
  LEAD: { prefix: 'lead' },
  STORE_PO: { prefix: 'PO' },
  GIIRN: { prefix: 'G' },
  CUSTOMER_COMPLAINT: { prefix: 'CR' }
};

/**
 * Format date as DD/MM/YY
 */
const formatDate = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear().toString().slice(-2);
  return `${day}/${month}/${year}`;
};

/**
 * Generate the next document number
 * Uses database transaction with row-level locking to prevent race conditions
 *
 * @param {string} documentType - 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE'
 * @param {Date} documentDate - Optional date for the document (defaults to now)
 * @returns {Promise<string>} - The generated document number
 */
export const generateDocumentNumber = async (documentType, documentDate = new Date()) => {
  const config = DOCUMENT_CONFIG[documentType];
  if (!config) {
    throw new Error(`Unknown document type: ${documentType}`);
  }

  // Use raw SQL for atomic increment with row-level locking
  // This ensures no race conditions even with concurrent requests
  const result = await prisma.$queryRaw`
    INSERT INTO "DocumentSequence" ("id", "documentType", "prefix", "lastNumber", "updatedAt")
    VALUES (gen_random_uuid(), ${documentType}, ${config.prefix}, 1, NOW())
    ON CONFLICT ("documentType")
    DO UPDATE SET
      "lastNumber" = "DocumentSequence"."lastNumber" + 1,
      "updatedAt" = NOW()
    RETURNING "lastNumber"
  `;

  const nextNumber = result[0].lastNumber;

  // Format: PREFIX/DD/MM/YY-XXXX
  const dateStr = formatDate(documentDate);
  const numberStr = nextNumber.toString().padStart(4, '0');

  return `${config.prefix}/${dateStr}-${numberStr}`;
};

/**
 * Generate invoice number
 * Format: GLL/DD/MM/YY-XXXX
 */
export const generateInvoiceNumber = async (invoiceDate = new Date()) => {
  return generateDocumentNumber('INVOICE', invoiceDate);
};

/**
 * Generate receipt number
 * Format: RCP/DD/MM/YY-XXXX
 */
export const generateReceiptNumber = async (receiptDate = new Date()) => {
  return generateDocumentNumber('RECEIPT', receiptDate);
};

/**
 * Generate credit note number
 * Format: CN/DD/MM/YY-XXXX
 */
export const generateCreditNoteNumber = async (creditNoteDate = new Date()) => {
  return generateDocumentNumber('CREDIT_NOTE', creditNoteDate);
};

/**
 * Generate OTC invoice number
 * Format: OTC/DD/MM/YY-XXXX
 */
export const generateOTCInvoiceNumber = async (invoiceDate = new Date()) => {
  return generateDocumentNumber('OTC_INVOICE', invoiceDate);
};

/**
 * Generate advance payment receipt number
 * Format: ADV/DD/MM/YY-XXXX
 */
export const generateAdvancePaymentNumber = async (paymentDate = new Date()) => {
  return generateDocumentNumber('ADVANCE_PAYMENT', paymentDate);
};

/**
 * Generate vendor PO number
 * Format: PO-VEN/DD/MM/YY-XXXX
 */
export const generateVendorPONumber = async (poDate = new Date()) => {
  return generateDocumentNumber('VENDOR_PO', poDate);
};

/**
 * Generate complaint number
 * Format: COMP/DD/MM/YY-XXXX
 */
export const generateComplaintNumber = async (complaintDate = new Date()) => {
  return generateDocumentNumber('COMPLAINT', complaintDate);
};

/**
 * Generate enquiry number
 * Format: ENQ/DD/MM/YY-XXXX
 */
export const generateEnquiryNumber = async (enquiryDate = new Date()) => {
  return generateDocumentNumber('ENQUIRY', enquiryDate);
};

/**
 * Generate service order number
 * Format: SO/DD/MM/YY-XXXX
 */
export const generateServiceOrderNumber = async (orderDate = new Date()) => {
  return generateDocumentNumber('SERVICE_ORDER', orderDate);
};

/**
 * Generate lead number
 * Format: lead-XXXXX (no date component, just prefix + padded number)
 */
export const generateLeadNumber = async () => {
  const config = DOCUMENT_CONFIG['LEAD'];

  const result = await prisma.$queryRaw`
    INSERT INTO "DocumentSequence" ("id", "documentType", "prefix", "lastNumber", "updatedAt")
    VALUES (gen_random_uuid(), 'LEAD', ${config.prefix}, 1, NOW())
    ON CONFLICT ("documentType")
    DO UPDATE SET
      "lastNumber" = "DocumentSequence"."lastNumber" + 1,
      "updatedAt" = NOW()
    RETURNING "lastNumber"
  `;

  const nextNumber = result[0].lastNumber;
  const numberStr = nextNumber.toString().padStart(5, '0');

  return `${config.prefix}-${numberStr}`;
};

export default {
  generateDocumentNumber,
  generateInvoiceNumber,
  generateReceiptNumber,
  generateCreditNoteNumber,
  generateOTCInvoiceNumber,
  generateVendorPONumber,
  generateComplaintNumber,
  generateEnquiryNumber,
  generateServiceOrderNumber,
  generateLeadNumber
};
