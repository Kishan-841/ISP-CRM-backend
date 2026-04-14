import { Router } from 'express';
import { Readable } from 'stream';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

const router = Router();

// Auth that accepts token from query param (iframes can't send headers)
const authFromHeaderOrQuery = async (req, res, next) => {
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = req.query.token;
  const token = headerToken || queryToken;
  if (!token) return res.status(401).send('No token provided');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, role: true, isActive: true }
    });
    if (!user || !user.isActive) return res.status(401).send('Invalid user');
    req.user = user;
    next();
  } catch {
    return res.status(401).send('Invalid or expired token');
  }
};

/**
 * File proxy — fetches a Cloudinary file server-side and re-serves it with
 * Content-Disposition: inline so iframes render PDFs instead of downloading.
 *
 * Also overrides helmet's X-Frame-Options / Cross-Origin-Resource-Policy so
 * the response can actually be embedded in an iframe from the frontend origin.
 *
 * GET /api/proxy/file?url=<cloudinary_url>&token=<jwt>
 */
router.get('/file', authFromHeaderOrQuery, async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).send('url query param required');
  }

  let parsed;
  try {
    parsed = new URL(url);
    if (!parsed.hostname.endsWith('cloudinary.com')) {
      return res.status(400).send('Only Cloudinary URLs are allowed');
    }
  } catch {
    return res.status(400).send('Invalid URL');
  }

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream ${upstream.status}`);
    }

    // Strip helmet's restrictive headers so the iframe can render the response.
    // Most critical: CSP frame-ancestors blocks iframe embedding entirely,
    // and nosniff + octet-stream forces download even with inline disposition.
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('X-Download-Options');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Override content type — Cloudinary raw uploads come back as
    // application/octet-stream which browsers refuse to render inline.
    // Infer real type from file extension in the URL.
    const ext = parsed.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    const extTypeMap = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
      txt: 'text/plain',
    };
    const upstreamCT = upstream.headers.get('content-type') || '';
    const contentType = extTypeMap[ext]
      || (upstreamCT && upstreamCT !== 'application/octet-stream' ? upstreamCT : 'application/pdf');

    const contentLength = upstream.headers.get('content-length');
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');

    // Pipe the upstream stream to the response
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    console.error('File proxy error:', err);
    res.status(500).send('Failed to proxy file');
  }
});

export default router;
