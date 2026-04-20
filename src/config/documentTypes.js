/**
 * Document Types Configuration
 *
 * Defines the mandatory documents required for BDM document verification workflow.
 * This configuration is flexible and can be extended for company-type specific requirements.
 */

export const DOCUMENT_TYPES = {
  PO: {
    id: 'PO',
    label: 'Purchase Order',
    description: 'Signed purchase order document',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024, // 10MB
    order: 1
  },
  ADVANCE_OTC: {
    id: 'ADVANCE_OTC',
    label: 'Advance OTC',
    description: 'Advance one-time charges receipt',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 2
  },
  GST_DETAILS: {
    id: 'GST_DETAILS',
    label: 'GST Details',
    description: 'GST registration certificate',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 3
  },
  IIL_PROTOCOL_SHEET: {
    id: 'IIL_PROTOCOL_SHEET',
    label: 'IIL Protocol Sheet',
    description: 'Internet Information Link protocol document',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 4
  },
  CAF: {
    id: 'CAF',
    label: 'CAF',
    description: 'Customer Application Form',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 5
  },
  INSTALLATION_ADDRESS_PROOF: {
    id: 'INSTALLATION_ADDRESS_PROOF',
    label: 'Installation Address Proof',
    description: 'Proof of installation location address',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 6
  },
  COMPANY_REGISTRATION: {
    id: 'COMPANY_REGISTRATION',
    label: 'Company Registration Docs',
    description: 'Certificate of incorporation or registration',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 7
  },
  NETWORK_DIAGRAM: {
    id: 'NETWORK_DIAGRAM',
    label: 'Network Diagram',
    description: 'Network architecture/topology diagram',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 8
  },
  TAN_DETAILS: {
    id: 'TAN_DETAILS',
    label: 'TAN Details',
    description: 'Tax Deduction Account Number details',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 9
  },
  COMPANY_PAN: {
    id: 'COMPANY_PAN',
    label: 'Company PAN Card',
    description: 'Company Permanent Account Number card',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 10
  },
  AUTHORIZED_PERSON_ID: {
    id: 'AUTHORIZED_PERSON_ID',
    label: 'Authorized Person ID Proof',
    description: 'ID proof of authorized signatory',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 11
  },
  SLA: {
    id: 'SLA',
    label: 'Service Level Agreement (SLA)',
    description: 'Signed service level agreement document',
    required: true,
    acceptedFormats: ['pdf', 'jpg', 'jpeg', 'png'],
    maxSize: 10 * 1024 * 1024,
    order: 12
  }
};

/**
 * Get all required document types sorted by order
 */
export const getRequiredDocumentTypes = () => {
  return Object.values(DOCUMENT_TYPES)
    .filter(doc => doc.required)
    .sort((a, b) => a.order - b.order);
};

/**
 * Get all document types sorted by order
 */
export const getAllDocumentTypes = () => {
  return Object.values(DOCUMENT_TYPES).sort((a, b) => a.order - b.order);
};

/**
 * Get document type by ID
 */
export const getDocumentTypeById = (id) => {
  return DOCUMENT_TYPES[id] || null;
};

/**
 * Validate if a document type ID is valid
 */
export const isValidDocumentType = (id) => {
  return id in DOCUMENT_TYPES;
};

/**
 * Get document types for specific company type (future use)
 * Can be extended to return different required documents per company type
 * e.g., sole proprietor vs. partnership vs. private limited
 */
export const getDocumentTypesForCompanyType = (companyType = 'default') => {
  // For now, return all document types
  // In future, this can filter based on company type
  return getAllDocumentTypes();
};

/**
 * Validate documents against required types
 * @param {Object} documents - Object with document type keys
 * @param {boolean} testMode - If true, bypass validation (0 documents required)
 * @returns {Object} - { valid: boolean, missing: string[], uploadedCount: number, requiredCount: number }
 */
export const validateDocuments = (documents, testMode = false) => {
  const requiredTypes = getRequiredDocumentTypes();
  const requiredCount = testMode ? 0 : requiredTypes.length;
  const uploadedCount = Object.keys(documents || {}).length;

  if (testMode) {
    // Test mode: allow bypass with 0 documents
    return {
      valid: true,
      missing: [],
      uploadedCount,
      requiredCount
    };
  }

  const missing = [];
  for (const docType of requiredTypes) {
    if (!documents?.[docType.id]) {
      missing.push(docType.label);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    uploadedCount,
    requiredCount
  };
};
