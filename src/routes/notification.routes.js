import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications
} from '../controllers/notification.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Get all notifications (paginated)
router.get('/', getNotifications);

// Get unread count
router.get('/unread-count', getUnreadCount);

// Mark single notification as read
router.put('/:id/read', markAsRead);

// Mark all notifications as read
router.put('/read-all', markAllAsRead);

// Delete a notification
router.delete('/:id', deleteNotification);

// Clear all notifications
router.delete('/', clearAllNotifications);

export default router;
