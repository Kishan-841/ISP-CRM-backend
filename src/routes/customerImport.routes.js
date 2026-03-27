import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  bulkImportCustomers,
  importSingleCustomer,
  getTemplateHeaders,
} from '../controllers/customerImport.controller.js';

const router = express.Router();

router.get('/template', auth, getTemplateHeaders);
router.post('/bulk', auth, bulkImportCustomers);
router.post('/single', auth, importSingleCustomer);

export default router;
