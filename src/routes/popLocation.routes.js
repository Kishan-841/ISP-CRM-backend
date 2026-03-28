import express from 'express';
import { auth } from '../middleware/auth.js';
import { getPopLocations, createPopLocation } from '../controllers/popLocation.controller.js';

const router = express.Router();

router.get('/', auth, getPopLocations);
router.post('/', auth, createPopLocation);

export default router;
