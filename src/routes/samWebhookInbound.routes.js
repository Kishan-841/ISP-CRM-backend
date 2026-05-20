import express from 'express';
import { receiveQuickDisconnectRequested, ping } from '../controllers/samWebhookInbound.controller.js';

// Public webhook receivers from the downstream SAM service. No staff auth —
// every handler verifies the X-SAM-Signature HMAC before reading the body.
// Mount this router AFTER express.json (which sets req.rawBody via its
// `verify` hook) so signature verification can use the literal request bytes.

const router = express.Router();

// Unauthenticated reachability check for SAM-side integration testing.
router.get('/ping', ping);

router.post('/quick-disconnect.requested', receiveQuickDisconnectRequested);

export default router;
