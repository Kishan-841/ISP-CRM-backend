import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getZones,
  createZone,
  updateZone,
  deleteZone,
  createCity,
  updateCity,
  deleteCity,
} from '../controllers/zone.controller.js';

const router = express.Router();

// Everything needs a logged-in user. Reads stay open to all staff because the
// dropdowns appear in the feasibility form and the backfill screen; writes are
// gated inside the controller so the 403 message can say why.
router.use(auth);

router.get('/', getZones);
router.post('/', createZone);
router.patch('/:id', updateZone);
router.delete('/:id', deleteZone);

router.post('/cities', createCity);
router.patch('/cities/:id', updateCity);
router.delete('/cities/:id', deleteCity);

export default router;
