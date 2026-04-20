import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

let io = null;

// Map to store userId -> Set of socketIds (user can have multiple tabs/devices)
const userSockets = new Map();
const MAX_CONNECTIONS_PER_USER = 5;

export const initializeSocket = (httpServer) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (origin.endsWith('.vercel.app') && origin.includes('isp-crm-frontend')) {
          return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
      },
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true
        }
      });

      if (!user || !user.isActive) {
        return next(new Error('User not found or inactive'));
      }

      socket.user = user;
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    console.log(`User connected: ${socket.user.name} (${userId})`);

    // Add socket to user's set, enforcing connection limit
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }

    const existingConnections = userSockets.get(userId);
    if (existingConnections.size >= MAX_CONNECTIONS_PER_USER) {
      // Disconnect oldest connection to make room
      const oldestSocketId = existingConnections.values().next().value;
      const oldSocket = io.sockets.sockets.get(oldestSocketId);
      if (oldSocket) {
        oldSocket.disconnect(true);
      }
      existingConnections.delete(oldestSocketId);
    }

    existingConnections.add(socket.id);

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.user.name} (${userId})`);

      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(userId);
        }
      }
    });

    // Handle marking notification as read via socket
    socket.on('notification:read', async (notificationId) => {
      try {
        await prisma.notification.updateMany({
          where: {
            id: notificationId,
            userId: userId
          },
          data: { read: true }
        });
      } catch (error) {
        console.error('Error marking notification as read:', error);
      }
    });
  });

  return io;
};

// Emit notification to a specific user (all their connected devices)
export const emitToUser = (userId, event, data) => {
  if (!io) {
    console.warn('Socket.io not initialized');
    return;
  }

  const sockets = userSockets.get(userId);
  if (sockets && sockets.size > 0) {
    sockets.forEach(socketId => {
      io.to(socketId).emit(event, data);
    });
    return true;
  }
  return false;
};

// Emit notification to multiple users
export const emitToUsers = (userIds, event, data) => {
  userIds.forEach(userId => {
    emitToUser(userId, event, data);
  });
};

// Get socket.io instance
export const getIO = () => io;

// Check if user is online
export const isUserOnline = (userId) => {
  const sockets = userSockets.get(userId);
  return sockets && sockets.size > 0;
};

// Emit sidebar refresh signal to a specific user (fire-and-forget)
export const emitSidebarRefresh = (userId) => {
  emitToUser(userId, 'sidebar:refresh', {});
};

// Emit sidebar refresh to all active users of a given role.
// Chunked + async-yielded so we don't block the event loop with a tight loop
// when the role has hundreds of users, and we don't pile a large set of
// synchronous socket.emit calls onto the event queue at once.
const SIDEBAR_BROADCAST_CHUNK = 50;
const SIDEBAR_BROADCAST_DELAY_MS = 10;   // yield between chunks
export const emitSidebarRefreshByRole = async (role) => {
  try {
    // Only fetch ids of users who actually have an active socket right now —
    // emitting to offline users wastes cycles and fills the room map.
    const users = await prisma.user.findMany({
      where: { role, isActive: true },
      select: { id: true },
    });
    const onlineIds = users.map((u) => u.id).filter((id) => isUserOnline(id));

    for (let i = 0; i < onlineIds.length; i += SIDEBAR_BROADCAST_CHUNK) {
      const slice = onlineIds.slice(i, i + SIDEBAR_BROADCAST_CHUNK);
      slice.forEach((id) => emitToUser(id, 'sidebar:refresh', {}));
      // Yield to the event loop between chunks so other requests can progress.
      if (i + SIDEBAR_BROADCAST_CHUNK < onlineIds.length) {
        await new Promise((r) => setTimeout(r, SIDEBAR_BROADCAST_DELAY_MS));
      }
    }
  } catch (error) {
    console.error('emitSidebarRefreshByRole error:', error);
  }
};
