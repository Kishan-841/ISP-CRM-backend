// The 17 models the Prisma extension audits. Adding a model is a one-line
// change. Removing one is reversible — historical rows stay, only future
// writes stop being audited.
export const AUDITED_MODELS = new Set([
  'Lead', 'Invoice', 'InvoicePayment', 'CreditNote', 'AdvancePayment',
  'LedgerEntry', 'Complaint', 'ServiceOrder', 'DeliveryRequest',
  'StorePurchaseOrder', 'VendorPurchaseOrder', 'Vendor', 'User',
  'SAMAssignment', 'CustomerEnquiry',
  // New: bulk-import source (CampaignData) + complaint file attachments.
  // LeadDocument and ServiceOrderAttachment don't exist as separate models —
  // they're JSON columns on Lead / ServiceOrder so their changes are already
  // captured via the parent's update audit row.
  'CampaignData',
  'ComplaintAttachment',
]);

// Snapshot the human-readable label at write time so the audit row stays
// readable even if the entity is later renamed or deleted. Each branch picks
// the best identifier available; falls back to id.
export function entityLabelFor(model, record) {
  if (!record) return null;
  switch (model) {
    case 'Lead': {
      const company = record.campaignData?.company;
      const num = record.leadNumber;
      if (company && num) return `${company} · ${num}`;
      return company || num || record.id;
    }
    case 'Invoice':              return record.invoiceNumber  || record.id;
    case 'InvoicePayment':       return `Payment ${record.id}`;
    case 'CreditNote':           return record.creditNoteNumber || record.id;
    case 'AdvancePayment':       return `Advance ${record.id}`;
    case 'LedgerEntry':          return `Ledger ${record.id}`;
    case 'Complaint':            return record.complaintNumber || record.id;
    case 'ServiceOrder':         return record.orderNumber    || record.id;
    case 'DeliveryRequest':      return record.requestNumber  || record.id;
    case 'StorePurchaseOrder':   return record.poNumber       || record.id;
    case 'VendorPurchaseOrder':  return record.poNumber       || record.id;
    case 'Vendor':               return record.companyName    || record.id;
    case 'User':                 return record.name           || record.email || record.id;
    case 'SAMAssignment':        return `SAM ${record.id}`;
    case 'CustomerEnquiry':      return record.enquiryNumber  || record.id;
    case 'CampaignData': {
      return record.company || record.name || record.phone || record.id;
    }
    case 'ComplaintAttachment': {
      // ComplaintAttachment uses `fileName` (not `originalName`).
      return record.fileName || record.id;
    }
    default:                     return record.id || null;
  }
}
