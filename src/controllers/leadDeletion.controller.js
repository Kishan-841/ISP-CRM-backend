import { asyncHandler } from '../utils/controllerHelper.js';
import {
  previewLeadDeletion,
  deleteLeadEntirely,
  listDeletionAudits,
} from '../services/leadDeletion.service.js';

const MASTER_ROLES = new Set(['MASTER', 'SUPER_ADMIN']);

const requireMaster = (req) => {
  if (!MASTER_ROLES.has(req.user?.role)) {
    const err = new Error('Only Master or Super Admin can perform this action.');
    err.status = 403;
    throw err;
  }
};

// GET /api/leads/:id/deletion-preview
export const getDeletionPreview = asyncHandler(async function getDeletionPreview(req, res) {
  requireMaster(req);
  const { id } = req.params;
  const preview = await previewLeadDeletion(id);
  if (!preview) {
    return res.status(404).json({ message: 'Lead not found.' });
  }
  return res.json(preview);
});

// POST /api/leads/:id/delete-entirely
export const deleteLeadEntirelyHandler = asyncHandler(async function deleteLeadEntirelyHandler(req, res) {
  requireMaster(req);
  const { id } = req.params;
  const { reason, confirmText, alsoDeleteCampaignData } = req.body;

  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    return res.status(400).json({ message: 'Please provide a reason (at least 10 characters).' });
  }

  const preview = await previewLeadDeletion(id);
  if (!preview) {
    return res.status(404).json({ message: 'Lead not found.' });
  }

  // Typed-confirmation check — must match the contact name exactly (case-sensitive).
  // Falls back to company if contact name is missing.
  const expected = (preview.lead.contactName || preview.lead.company || '').trim();
  if (!expected) {
    return res.status(400).json({ message: 'Cannot verify this lead (no name or company on record).' });
  }
  if (!confirmText || confirmText.trim() !== expected) {
    return res.status(400).json({
      message: `Confirmation text does not match. You must type exactly: ${expected}`,
    });
  }

  try {
    const audit = await deleteLeadEntirely({
      leadId: id,
      deletedById: req.user.id,
      reason: reason.trim(),
      alsoDeleteCampaignData: !!alsoDeleteCampaignData,
    });
    return res.json({
      message: 'Lead and all related records deleted successfully.',
      audit,
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ message: err.message });
    }
    console.error('[leadDeletion] failure:', err);
    return res.status(500).json({
      message: 'Deletion failed. No records were removed (transaction rolled back).',
      error: err?.message,
    });
  }
});

// GET /api/leads/deletion-audit?page=&limit=
export const getDeletionAuditList = asyncHandler(async function getDeletionAuditList(req, res) {
  requireMaster(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const result = await listDeletionAudits({ page, limit });
  return res.json(result);
});
