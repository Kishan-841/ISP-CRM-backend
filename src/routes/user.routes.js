import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUsersByRole,
  getUserDashboardStats,
  getSidebarCounts,
  getISRUsersForAssignment
} from '../controllers/user.controller.js';

const router = Router();

// All routes require authentication
router.use(auth);

// Sidebar counts - accessible by all authenticated users (before SUPER_ADMIN check)
router.get('/sidebar-counts', getSidebarCounts);

// ISR users list for assignment - accessible by BDM, BDM Team Leader, SAM, and Admin
router.get('/isr-list', requireRole('BDM', 'BDM_TEAM_LEADER', 'SAM', 'SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'), getISRUsersForAssignment);

// Users by role - accessible by BDM (for delivery user assignment), complaint-handling roles, and SUPER_ADMIN
router.get('/by-role', requireRole('BDM', 'BDM_TEAM_LEADER', 'SAM', 'SAM_HEAD', 'SAM_EXECUTIVE', 'NOC', 'SUPPORT_TEAM', 'OPS_TEAM', 'SUPER_ADMIN'), getUsersByRole);

// Routes below require SUPER_ADMIN or BDM_TEAM_LEADER role
router.use(requireRole('SUPER_ADMIN', 'BDM_TEAM_LEADER'));

router.get('/', getUsers);
router.get('/:id', getUserById);
router.get('/:userId/dashboard', getUserDashboardStats);
router.post('/', createUser);
router.put('/:id', updateUser);
router.delete('/:id', requireRole('SUPER_ADMIN'), deleteUser);

export default router;
