import prisma from '../config/db.js';
import crypto from 'crypto';
import { DOCUMENT_TYPES, isValidDocumentType, getAllDocumentTypes, getRequiredDocumentTypes } from '../config/documentTypes.js';
import { deleteFromCloudinary, getResourceType } from '../config/cloudinary.js';
import { isAdminOrTestUser, hasRole } from '../utils/roleHelper.js';
import { emitToUser, emitSidebarRefresh } from '../sockets/index.js';
import { asyncHandler } from '../utils/controllerHelper.js';

// Generate a secure random token
const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// ==================== BDM ENDPOINTS ====================

// Generate upload link for customer
export const generateUploadLink = asyncHandler(async function generateUploadLink(req, res) {
  const { id: leadId } = req.params;
  const { expiresInDays = 7, customerNote, requiredDocuments } = req.body;

  // Validate lead exists and belongs to user (or user is admin)
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      campaignData: true,
      createdBy: { select: { id: true, name: true, email: true, role: true } }
    }
  });

  if (!lead) {
    return res.status(404).json({ message: 'Lead not found' });
  }

  // Check permission - creator, assigned BDM, or admin can generate links
  const isCreator = lead.createdById === req.user.id;
  const isAssigned = lead.assignedToId === req.user.id;
  const isAdmin = isAdminOrTestUser(req.user);
  const isBDM = hasRole(req.user, 'BDM');

  if (!isCreator && !isAssigned && !isAdmin && !isBDM) {
    return res.status(403).json({ message: 'Not authorized to generate upload link for this lead' });
  }

  // Validate requiredDocuments if provided
  let selectedDocs = [];
  if (requiredDocuments && Array.isArray(requiredDocuments) && requiredDocuments.length > 0) {
    // Validate each document type
    const allDocTypes = getAllDocumentTypes();
    const validDocIds = allDocTypes.map(d => d.id);

    for (const docId of requiredDocuments) {
      if (!validDocIds.includes(docId)) {
        return res.status(400).json({ message: `Invalid document type: ${docId}` });
      }
    }
    selectedDocs = requiredDocuments;
  } else {
    // If no documents specified, include all by default
    selectedDocs = getAllDocumentTypes().map(d => d.id);
  }

  // Deactivate any existing active links
  await prisma.documentUploadLink.updateMany({
    where: {
      leadId,
      isActive: true
    },
    data: {
      isActive: false
    }
  });

  // Calculate expiration date
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  // Generate new link
  const token = generateToken();
  const uploadLink = await prisma.documentUploadLink.create({
    data: {
      leadId,
      token,
      expiresAt,
      createdById: req.user.id,
      customerNote,
      requiredDocuments: selectedDocs
    }
  });

  // Update lead docUploadMethod
  await prisma.lead.update({
    where: { id: leadId },
    data: { docUploadMethod: 'customer' }
  });

  // Generate the full URL
  const baseUrl = req.headers.origin || process.env.FRONTEND_URL || 'https://crm.gazonindia.com';
  const uploadUrl = `${baseUrl}/upload/${token}`;

  res.json({
    success: true,
    uploadLink: {
      id: uploadLink.id,
      token: uploadLink.token,
      url: uploadUrl,
      expiresAt: uploadLink.expiresAt,
      customerNote: uploadLink.customerNote,
      requiredDocuments: uploadLink.requiredDocuments
    }
  });
});

// Get all upload links for a lead
export const getUploadLinks = asyncHandler(async function getUploadLinks(req, res) {
  const { id: leadId } = req.params;

  const links = await prisma.documentUploadLink.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: {
        select: { id: true, name: true }
      }
    }
  });

  const baseUrl = req.headers.origin || process.env.FRONTEND_URL || 'https://crm.gazonindia.com';
  const formattedLinks = links.map(link => ({
    id: link.id,
    token: link.token,
    url: `${baseUrl}/upload/${link.token}`,
    expiresAt: link.expiresAt,
    isActive: link.isActive,
    isExpired: new Date() > new Date(link.expiresAt),
    createdAt: link.createdAt,
    lastAccessedAt: link.lastAccessedAt,
    accessCount: link.accessCount,
    customerNote: link.customerNote,
    requiredDocuments: link.requiredDocuments || [],
    createdBy: link.createdBy
  }));

  res.json(formattedLinks);
});

// Revoke/deactivate an upload link
export const revokeUploadLink = asyncHandler(async function revokeUploadLink(req, res) {
  const { id: leadId, linkId } = req.params;

  const link = await prisma.documentUploadLink.findFirst({
    where: {
      id: linkId,
      leadId
    }
  });

  if (!link) {
    return res.status(404).json({ message: 'Upload link not found' });
  }

  await prisma.documentUploadLink.update({
    where: { id: linkId },
    data: { isActive: false }
  });

  res.json({ success: true, message: 'Upload link revoked' });
});

// Set upload method for lead (bdm or customer)
export const setUploadMethod = asyncHandler(async function setUploadMethod(req, res) {
  const { id: leadId } = req.params;
  const { method } = req.body; // 'bdm' or 'customer'

  if (!['bdm', 'customer'].includes(method)) {
    return res.status(400).json({ message: 'Invalid upload method. Use "bdm" or "customer"' });
  }

  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { docUploadMethod: method }
  });

  res.json({ success: true, docUploadMethod: lead.docUploadMethod });
});

// ==================== PUBLIC CUSTOMER ENDPOINTS ====================

// Validate token and get lead info (for customer upload page)
export const validateUploadToken = asyncHandler(async function validateUploadToken(req, res) {
  const { token } = req.params;

  const uploadLink = await prisma.documentUploadLink.findUnique({
    where: { token },
    include: {
      lead: {
        include: {
          campaignData: {
            select: {
              company: true,
              name: true,
              email: true
            }
          }
        }
      }
    }
  });

  if (!uploadLink) {
    return res.status(404).json({ message: 'Invalid upload link', valid: false });
  }

  if (!uploadLink.isActive) {
    return res.status(410).json({ message: 'This upload link has been revoked', valid: false });
  }

  if (new Date() > new Date(uploadLink.expiresAt)) {
    return res.status(410).json({ message: 'This upload link has expired', valid: false });
  }

  // Update access tracking
  await prisma.documentUploadLink.update({
    where: { id: uploadLink.id },
    data: {
      lastAccessedAt: new Date(),
      accessCount: { increment: 1 }
    }
  });

  // Get current documents
  const documents = uploadLink.lead.documents || {};

  // Get document types info - filter by requiredDocuments if specified
  const allDocTypes = getAllDocumentTypes();
  const selectedDocIds = uploadLink.requiredDocuments && uploadLink.requiredDocuments.length > 0
    ? uploadLink.requiredDocuments
    : allDocTypes.map(d => d.id); // Default to all documents if none specified

  // Filter to only show selected documents
  const filteredDocTypes = allDocTypes.filter(dt => selectedDocIds.includes(dt.id));

  const documentTypes = filteredDocTypes.map(dt => ({
    id: dt.id,
    label: dt.label,
    description: dt.description,
    required: dt.required,
    order: dt.order,
    uploaded: !!documents[dt.id]
  }));

  // Filter uploaded documents to only show selected ones
  const filteredUploadedDocuments = {};
  for (const docId of selectedDocIds) {
    if (documents[docId]) {
      filteredUploadedDocuments[docId] = documents[docId];
    }
  }

  // Calculate progress based on selected documents only
  const uploadedCount = Object.keys(filteredUploadedDocuments).length;
  const totalRequired = selectedDocIds.length;

  res.json({
    valid: true,
    leadId: uploadLink.leadId,
    companyName: uploadLink.lead.campaignData?.company || 'Customer',
    customerName: uploadLink.lead.campaignData?.name || '',
    customerNote: uploadLink.customerNote,
    expiresAt: uploadLink.expiresAt,
    documentTypes,
    uploadedDocuments: filteredUploadedDocuments,
    requiredDocuments: selectedDocIds,
    uploadProgress: {
      uploaded: uploadedCount,
      total: totalRequired
    }
  });
});

// Customer upload document (no auth required, token-based)
export const customerUploadDocument = asyncHandler(async function customerUploadDocument(req, res) {
  const { token, documentType } = req.params;

  // Validate token
  const uploadLink = await prisma.documentUploadLink.findUnique({
    where: { token },
    include: { lead: true }
  });

  if (!uploadLink || !uploadLink.isActive) {
    return res.status(403).json({ message: 'Invalid or revoked upload link' });
  }

  if (new Date() > new Date(uploadLink.expiresAt)) {
    return res.status(410).json({ message: 'Upload link has expired' });
  }

  // Validate document type
  if (!isValidDocumentType(documentType)) {
    return res.status(400).json({ message: 'Invalid document type' });
  }

  // Check if this document type is in the required documents list
  const selectedDocIds = uploadLink.requiredDocuments && uploadLink.requiredDocuments.length > 0
    ? uploadLink.requiredDocuments
    : getAllDocumentTypes().map(d => d.id);

  if (!selectedDocIds.includes(documentType)) {
    return res.status(400).json({ message: 'This document type is not required for this upload link' });
  }

  // Check if file was uploaded
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const lead = uploadLink.lead;
  const currentDocuments = lead.documents || {};

  // If replacing existing document, delete old one from Cloudinary
  if (currentDocuments[documentType]?.publicId) {
    try {
      const resourceType = getResourceType(currentDocuments[documentType].mimetype);
      await deleteFromCloudinary(currentDocuments[documentType].publicId, resourceType);
    } catch (deleteError) {
      console.error('Failed to delete old document:', deleteError);
    }
  }

  // Create new document entry
  const newDocument = {
    documentType,
    originalName: req.file.originalname,
    filename: req.file.filename,
    url: req.file.path,
    publicId: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedAt: new Date().toISOString(),
    uploadedBy: 'customer',
    uploadedVia: 'link'
  };

  // Add ADVANCE_OTC specific fields if provided
  if (documentType === 'ADVANCE_OTC') {
    if (req.body.paymentMethod) {
      newDocument.paymentMethod = req.body.paymentMethod; // 'cheque' | 'neft' | 'mail_approval'
    }
    if (req.body.referenceNumber) {
      newDocument.referenceNumber = req.body.referenceNumber; // cheque number or UTR
    }
    if (req.body.date) {
      newDocument.date = req.body.date; // cheque date or payment date
    }
    if (req.body.amount) {
      newDocument.amount = req.body.amount; // payment amount
    }
  }

  // Update documents
  const updatedDocuments = {
    ...currentDocuments,
    [documentType]: newDocument
  };

  // Determine upload method - if BDM uploaded some and customer uploads some, it's 'mixed'
  let docUploadMethod = 'customer';
  const existingDocs = Object.values(currentDocuments);
  const hasBdmUploads = existingDocs.some(d => d.uploadedBy !== 'customer');
  if (hasBdmUploads) {
    docUploadMethod = 'mixed';
  }

  // Update lead
  await prisma.lead.update({
    where: { id: uploadLink.leadId },
    data: {
      documents: updatedDocuments,
      docUploadMethod
    }
  });

  // Calculate progress based on selected documents only
  const uploadedSelectedCount = selectedDocIds.filter(id => updatedDocuments[id]).length;

  res.json({
    success: true,
    document: newDocument,
    uploadProgress: {
      uploaded: uploadedSelectedCount,
      total: selectedDocIds.length
    }
  });
});

// Customer remove document
export const customerRemoveDocument = asyncHandler(async function customerRemoveDocument(req, res) {
  const { token, documentType } = req.params;

  // Validate token
  const uploadLink = await prisma.documentUploadLink.findUnique({
    where: { token },
    include: { lead: true }
  });

  if (!uploadLink || !uploadLink.isActive) {
    return res.status(403).json({ message: 'Invalid or revoked upload link' });
  }

  if (new Date() > new Date(uploadLink.expiresAt)) {
    return res.status(410).json({ message: 'Upload link has expired' });
  }

  // Get selected document IDs
  const selectedDocIds = uploadLink.requiredDocuments && uploadLink.requiredDocuments.length > 0
    ? uploadLink.requiredDocuments
    : getAllDocumentTypes().map(d => d.id);

  const lead = uploadLink.lead;
  const currentDocuments = lead.documents || {};

  if (!currentDocuments[documentType]) {
    return res.status(404).json({ message: 'Document not found' });
  }

  // Delete from Cloudinary
  try {
    const resourceType = getResourceType(currentDocuments[documentType].mimetype);
    await deleteFromCloudinary(currentDocuments[documentType].publicId, resourceType);
  } catch (deleteError) {
    console.error('Failed to delete from Cloudinary:', deleteError);
  }

  // Remove document from lead
  const { [documentType]: removed, ...remainingDocuments } = currentDocuments;

  await prisma.lead.update({
    where: { id: uploadLink.leadId },
    data: { documents: remainingDocuments }
  });

  // Calculate progress based on selected documents only
  const uploadedSelectedCount = selectedDocIds.filter(id => remainingDocuments[id]).length;

  res.json({
    success: true,
    uploadProgress: {
      uploaded: uploadedSelectedCount,
      total: selectedDocIds.length
    }
  });
});

// Customer mark upload complete (optional notification to BDM)
export const customerCompleteUpload = asyncHandler(async function customerCompleteUpload(req, res) {
  const { token } = req.params;

  const uploadLink = await prisma.documentUploadLink.findUnique({
    where: { token },
    include: {
      lead: {
        include: {
          createdBy: { select: { id: true, name: true, email: true, role: true } }
        }
      }
    }
  });

  if (!uploadLink || !uploadLink.isActive) {
    return res.status(403).json({ message: 'Invalid or revoked upload link' });
  }

  const documents = uploadLink.lead.documents || {};

  // Get selected document IDs
  const selectedDocIds = uploadLink.requiredDocuments && uploadLink.requiredDocuments.length > 0
    ? uploadLink.requiredDocuments
    : getAllDocumentTypes().map(d => d.id);

  // Calculate progress based on selected documents only
  const uploadedCount = selectedDocIds.filter(id => documents[id]).length;
  const requiredCount = selectedDocIds.length;

  // Create notification for BDM
  const notification = await prisma.notification.create({
    data: {
      userId: uploadLink.lead.createdById,
      type: 'DATA_ASSIGNED', // Using existing type, could add DOCS_UPLOADED later
      title: 'Customer Documents Uploaded',
      message: `Customer has uploaded ${uploadedCount}/${requiredCount} documents for lead.`,
      metadata: {
        leadId: uploadLink.leadId,
        uploadedCount,
        requiredCount,
        isComplete: uploadedCount >= requiredCount
      }
    }
  });

  // Emit socket event so BDM receives real-time notification
  const targetUserId = uploadLink.lead.createdById;
  emitToUser(targetUserId, 'notification', notification);
  emitSidebarRefresh(targetUserId);

  res.json({
    success: true,
    message: 'Upload completion notified',
    uploadProgress: {
      uploaded: uploadedCount,
      total: requiredCount,
      isComplete: uploadedCount >= requiredCount
    }
  });
});

export default {
  generateUploadLink,
  getUploadLinks,
  revokeUploadLink,
  setUploadMethod,
  validateUploadToken,
  customerUploadDocument,
  customerRemoveDocument,
  customerCompleteUpload
};
