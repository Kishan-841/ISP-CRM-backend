import prisma from '../config/db.js';
import { asyncHandler, parsePagination, paginatedResponse } from '../utils/controllerHelper.js';

// Get all notifications for current user
export const getNotifications = asyncHandler(async function getNotifications(req, res) {
  const userId = req.user.id;
  const { page, limit, skip } = parsePagination(req.query, 20);

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.notification.count({ where: { userId } })
  ]);

  res.json(paginatedResponse({ data: notifications, total, page, limit, dataKey: 'notifications' }));
});

// Get unread notification count
export const getUnreadCount = asyncHandler(async function getUnreadCount(req, res) {
  const userId = req.user.id;

  const count = await prisma.notification.count({
    where: {
      userId,
      read: false
    }
  });

  res.json({ unreadCount: count });
});

// Mark single notification as read
export const markAsRead = asyncHandler(async function markAsRead(req, res) {
  const userId = req.user.id;
  const { id } = req.params;

  const notification = await prisma.notification.updateMany({
    where: {
      id,
      userId
    },
    data: { read: true }
  });

  if (notification.count === 0) {
    return res.status(404).json({ message: 'Notification not found.' });
  }

  res.json({ message: 'Notification marked as read.' });
});

// Mark all notifications as read
export const markAllAsRead = asyncHandler(async function markAllAsRead(req, res) {
  const userId = req.user.id;

  await prisma.notification.updateMany({
    where: {
      userId,
      read: false
    },
    data: { read: true }
  });

  res.json({ message: 'All notifications marked as read.' });
});

// Delete a notification
export const deleteNotification = asyncHandler(async function deleteNotification(req, res) {
  const userId = req.user.id;
  const { id } = req.params;

  const notification = await prisma.notification.deleteMany({
    where: {
      id,
      userId
    }
  });

  if (notification.count === 0) {
    return res.status(404).json({ message: 'Notification not found.' });
  }

  res.json({ message: 'Notification deleted.' });
});

// Clear all notifications
export const clearAllNotifications = asyncHandler(async function clearAllNotifications(req, res) {
  const userId = req.user.id;

  await prisma.notification.deleteMany({
    where: { userId }
  });

  res.json({ message: 'All notifications cleared.' });
});
