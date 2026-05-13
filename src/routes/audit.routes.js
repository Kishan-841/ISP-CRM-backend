import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import {
  listEvents, getEvent, getFilters, getEntityTimeline,
} from '../controllers/audit.controller.js';

const router = Router();
router.use(auth);

router.get('/events',                  listEvents);
// /events/filters MUST come before /events/:id or Express routes it into the :id handler.
router.get('/events/filters',          getFilters);
router.get('/events/:id',              getEvent);
router.get('/entity/:type/:id',        getEntityTimeline);

export default router;
