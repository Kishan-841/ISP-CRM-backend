import prisma from '../config/db.js';
import { asyncHandler, parsePagination } from '../utils/controllerHelper.js';
import { notifyAllAdmins } from '../services/notification.service.js';

// ─── Contact form intake ─────────────────────────────────────────────────────
//
// POST /api/public/contact-messages — the public website's "Send us a
// message" form. Same x-api-key as the website-leads intake (checked in the
// route middleware). Stored as ContactMessage rows, read on
// /dashboard/contact-messages.
export const submitContactMessage = asyncHandler(async function submitContactMessage(req, res) {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const message = String(body.message || '').trim();
  const phoneDigits = String(body.phone ?? '').replace(/\D/g, '');
  const email = body.email ? String(body.email).trim() : '';

  if (!name) return res.status(400).json({ success: false, message: 'Name is required.' });
  if (!message) return res.status(400).json({ success: false, message: 'Message is required.' });
  if (!phoneDigits && !email) return res.status(400).json({ success: false, message: 'Provide a phone number or an email address.' });
  if (phoneDigits && phoneDigits.length !== 10) return res.status(400).json({ success: false, message: 'Phone number must have exactly 10 digits.' });
  if (email && !email.includes('@')) return res.status(400).json({ success: false, message: 'Email address is invalid.' });

  const saved = await prisma.contactMessage.create({
    data: {
      name,
      company: body.company ? String(body.company).trim() : null,
      phone: phoneDigits || null,
      email: email || null,
      subject: body.subject ? String(body.subject).trim() : null,
      message
    }
  });

  await notifyAllAdmins(
    'CONTACT_MESSAGE',
    'New contact message',
    `${name}${saved.company ? ` (${saved.company})` : ''}: ${saved.subject || message.slice(0, 80)}`,
    { contactMessageId: saved.id }
  );

  res.status(201).json({ success: true, id: saved.id });
});

// ─── Management side (role-gated at the route) ───────────────────────────────

// GET /api/contact-messages/list?read=unread|all&page=&limit=
export const listContactMessages = asyncHandler(async function listContactMessages(req, res) {
  const { page, limit, skip } = parsePagination(req.query, 20);
  const where = req.query.read === 'unread' ? { isRead: false } : {};
  const [items, total, unread, all] = await Promise.all([
    prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip }),
    prisma.contactMessage.count({ where }),
    prisma.contactMessage.count({ where: { isRead: false } }),
    prisma.contactMessage.count()
  ]);
  res.json({ items, stats: { unread, all }, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// POST /api/contact-messages/:id/read
export const markContactMessageRead = asyncHandler(async function markContactMessageRead(req, res) {
  const existing = await prisma.contactMessage.findUnique({ where: { id: req.params.id }, select: { id: true, isRead: true } });
  if (!existing) return res.status(404).json({ message: 'Message not found.' });
  const updated = existing.isRead
    ? existing
    : await prisma.contactMessage.update({ where: { id: existing.id }, data: { isRead: true, readAt: new Date() } });
  res.json({ message: 'Marked as read.', contactMessage: updated });
});
