import prisma from '../config/db.js';
import {
  answerQuestion,
  invalidateCacheForKnowledge,
  getUserQuotaStatus,
} from '../services/nexus.service.js';

const sendError = (res, err) => {
  if (err?.status === 429) return res.status(429).json({ message: err.message });
  console.error('[nexus] controller error:', err);
  return res.status(500).json({ message: 'Server error.' });
};

// =====================
// ASK
// =====================

export const askStaff = async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length < 2) {
      return res.status(400).json({ message: 'Message is required.' });
    }
    const result = await answerQuestion({
      question: message.trim(),
      conversationId,
      audience: 'STAFF',
      userId: req.user.id,
      userRole: req.user.role,
    });
    const quota = await getUserQuotaStatus({ userId: req.user.id });
    return res.json({ ...result, quota });
  } catch (err) {
    if (err?.status === 429) {
      const quota = await getUserQuotaStatus({ userId: req.user.id }).catch(() => null);
      return res.status(429).json({ message: err.message, quota });
    }
    return sendError(res, err);
  }
};

export const askCustomer = async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length < 2) {
      return res.status(400).json({ message: 'Message is required.' });
    }
    const result = await answerQuestion({
      question: message.trim(),
      conversationId,
      audience: 'CUSTOMER',
      customerUserId: req.customer.customerUserId,
    });
    const quota = await getUserQuotaStatus({ customerUserId: req.customer.customerUserId });
    return res.json({ ...result, quota });
  } catch (err) {
    if (err?.status === 429) {
      const quota = await getUserQuotaStatus({ customerUserId: req.customer.customerUserId }).catch(() => null);
      return res.status(429).json({ message: err.message, quota });
    }
    return sendError(res, err);
  }
};

export const getQuotaStaff = async (req, res) => {
  try {
    const quota = await getUserQuotaStatus({ userId: req.user.id });
    return res.json({ quota });
  } catch (err) {
    return sendError(res, err);
  }
};

export const getQuotaCustomer = async (req, res) => {
  try {
    const quota = await getUserQuotaStatus({ customerUserId: req.customer.customerUserId });
    return res.json({ quota });
  } catch (err) {
    return sendError(res, err);
  }
};

// =====================
// CONVERSATIONS
// =====================

export const getMyConversations = async (req, res) => {
  try {
    const conversations = await prisma.nexusConversation.findMany({
      where: { userId: req.user.id },
      orderBy: { lastMessageAt: 'desc' },
      take: 20,
      select: {
        id: true,
        startedAt: true,
        lastMessageAt: true,
        _count: { select: { messages: true } },
      },
    });
    return res.json({ conversations });
  } catch (err) {
    return sendError(res, err);
  }
};

export const getConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const conversation = await prisma.nexusConversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });

    // Ownership check
    const isStaff = !!req.user;
    if (isStaff && conversation.userId !== req.user.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (!isStaff && req.customer && conversation.customerUserId !== req.customer.customerUserId) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    return res.json({ conversation });
  } catch (err) {
    return sendError(res, err);
  }
};

// =====================
// KB ADMIN (SUPER_ADMIN)
// =====================

export const listKnowledge = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const search = (req.query.search || '').trim();
    const audience = req.query.audience; // optional filter

    const where = {};
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (audience && ['STAFF', 'CUSTOMER', 'BOTH'].includes(audience)) {
      where.audience = audience;
    }

    const [total, items] = await Promise.all([
      prisma.nexusKnowledge.count({ where }),
      prisma.nexusKnowledge.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { createdBy: { select: { id: true, name: true, email: true } } },
      }),
    ]);

    return res.json({
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return sendError(res, err);
  }
};

export const createKnowledge = async (req, res) => {
  try {
    const { title, content, audience = 'BOTH', roles = [], tags = [], isActive = true } = req.body;
    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required.' });
    }
    if (!['STAFF', 'CUSTOMER', 'BOTH'].includes(audience)) {
      return res.status(400).json({ message: 'Invalid audience.' });
    }
    const entry = await prisma.nexusKnowledge.create({
      data: {
        title: title.trim(),
        content: content.trim(),
        audience,
        roles: Array.isArray(roles) ? roles : [],
        tags: Array.isArray(tags) ? tags : [],
        isActive: !!isActive,
        createdById: req.user.id,
      },
    });
    return res.status(201).json({ message: 'Created', data: entry });
  } catch (err) {
    return sendError(res, err);
  }
};

export const updateKnowledge = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.nexusKnowledge.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: 'Not found.' });

    const { title, content, audience, roles, tags, isActive } = req.body;
    const data = {};
    if (title !== undefined) data.title = title.trim();
    if (content !== undefined) data.content = content.trim();
    if (audience !== undefined) {
      if (!['STAFF', 'CUSTOMER', 'BOTH'].includes(audience)) {
        return res.status(400).json({ message: 'Invalid audience.' });
      }
      data.audience = audience;
    }
    if (roles !== undefined) data.roles = Array.isArray(roles) ? roles : [];
    if (tags !== undefined) data.tags = Array.isArray(tags) ? tags : [];
    if (isActive !== undefined) data.isActive = !!isActive;

    const entry = await prisma.nexusKnowledge.update({ where: { id }, data });
    await invalidateCacheForKnowledge(id);
    return res.json({ message: 'Updated', data: entry });
  } catch (err) {
    return sendError(res, err);
  }
};

export const deleteKnowledge = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.nexusKnowledge.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: 'Not found.' });

    await invalidateCacheForKnowledge(id);
    await prisma.nexusKnowledge.delete({ where: { id } });
    return res.json({ message: 'Deleted' });
  } catch (err) {
    return sendError(res, err);
  }
};
