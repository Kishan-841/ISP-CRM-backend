import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { auditContext } from '../audit/context.js';
import { logAuthEvent } from '../audit/logAuthEvent.js';

// Detect bcrypt format from the stored value itself rather than relying on
// the passwordIsHashed flag — protects against flag drift (e.g. backfill
// SQL not run on a given environment) so a missing migration can't lock
// users out.
const isBcryptHash = (value) =>
  typeof value === 'string' &&
  (value.startsWith('$2a$') || value.startsWith('$2b$') || value.startsWith('$2y$'));

export const login = asyncHandler(async function login(req, res) {
  // `|| {}` so probes / malformed requests with no Content-Type return a
  // clean 400 instead of crashing on destructure. express.json() leaves
  // req.body undefined (not {}) when the request isn't JSON — usually a
  // health-check probe, a CORS preflight that slipped through, or an
  // upstream proxy that stripped the body.
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() }
  });

  if (!user) {
    await auditContext.run({
      actorId:    null,
      actorName:  null,
      actorRole:  null,
      actorType:  'SYSTEM',
      ipAddress:  req.ip || null,
      userAgent:  req.get('user-agent') ?? null,
      requestId:  req.get('x-request-id') ?? null,
      routePath:  '/api/auth/login',
      httpMethod: 'POST',
    }, async () => {
      await logAuthEvent({
        action:         'LOGIN',
        status:         'FAILURE',
        errorMessage:   'Invalid credentials',
        attemptedEmail: email,
      });
    });
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  if (!user.isActive) {
    return res.status(401).json({ message: 'Account is deactivated.' });
  }

  let isMatch = false;
  if (isBcryptHash(user.password)) {
    isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      // Transparent migration: store plaintext so admin/master can view it from now on.
      await prisma.user.update({
        where: { id: user.id },
        data: { password, passwordIsHashed: false }
      });
    }
  } else {
    isMatch = password === user.password;
  }

  if (!isMatch) {
    await auditContext.run({
      actorId:    null,
      actorName:  null,
      actorRole:  null,
      actorType:  'SYSTEM',
      ipAddress:  req.ip || null,
      userAgent:  req.get('user-agent') ?? null,
      requestId:  req.get('x-request-id') ?? null,
      routePath:  '/api/auth/login',
      httpMethod: 'POST',
    }, async () => {
      await logAuthEvent({
        action:         'LOGIN',
        status:         'FAILURE',
        errorMessage:   'Invalid credentials',
        attemptedEmail: email,
      });
    });
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  // Audit log: capture WHO logged in, from WHERE. We wrap in auditContext.run
  // because /api/auth/login runs before any auth middleware has populated
  // the ALS scope, so writer would otherwise see SYSTEM/null actor.
  await auditContext.run({
    actorId: user.id, actorName: user.name, actorRole: user.role,
    actorType: 'STAFF',
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.get('x-request-id') ?? null,
    routePath: '/api/auth/login', httpMethod: 'POST',
  }, async () => {
    await logAuthEvent({ action: 'LOGIN', userId: user.id, userName: user.name, userRole: user.role });
  });

  res.json({
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    }
  });
});

export const resetPassword = asyncHandler(async function resetPassword(req, res) {
  const { email, oldPassword, newPassword } = req.body || {};

  if (!email || !oldPassword || !newPassword) {
    return res.status(400).json({ message: 'Email, old password, and new password are required.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters.' });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() }
  });

  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  let oldMatches = false;
  if (isBcryptHash(user.password)) {
    oldMatches = await bcrypt.compare(oldPassword, user.password);
  } else {
    oldMatches = oldPassword === user.password;
  }

  if (!oldMatches) {
    return res.status(401).json({ message: 'Old password is incorrect.' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { password: newPassword, passwordIsHashed: false }
  });

  res.json({ message: 'Password reset successfully. Please login with your new password.' });
});

export const me = asyncHandler(async function me(req, res) {
  res.json({ user: req.user });
});

export const logout = asyncHandler(async function logout(req, res) {
  // The JWT model is stateless — the client just drops the token.
  // This endpoint exists so we can record the LOGOUT event for the audit log.
  // It runs AFTER the auth middleware, so the ALS context is already
  // populated — no need to wrap in auditContext.run.
  await logAuthEvent({
    action: 'LOGOUT',
    userId: req.user.id,
    userName: req.user.name,
    userRole: req.user.role,
  });
  res.json({ message: 'Logged out.' });
});

export const customerLogin = asyncHandler(async function customerLogin(req, res) {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  // Step 1: Find by username only
  const lead = await prisma.lead.findFirst({
    where: {
      customerUsername: username.trim(),
    },
    select: {
      id: true,
      customerUserId: true,
      customerUsername: true,
      customerPassword: true,
      actualPlanIsActive: true,
      actualPlanName: true,
      campaignData: {
        select: {
          company: true,
          name: true,
        }
      }
    }
  });

  if (!lead) {
    await auditContext.run({
      actorId:    null,
      actorName:  null,
      actorRole:  null,
      actorType:  'SYSTEM',
      ipAddress:  req.ip || null,
      userAgent:  req.get('user-agent') ?? null,
      requestId:  req.get('x-request-id') ?? null,
      routePath:  '/api/auth/customer-login',
      httpMethod: 'POST',
    }, async () => {
      await logAuthEvent({
        action:         'LOGIN',
        status:         'FAILURE',
        errorMessage:   'Invalid credentials',
        attemptedEmail: username,
      });
    });
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  // Step 2: Verify password
  let passwordValid = false;
  const isBcryptHash = lead.customerPassword && (lead.customerPassword.startsWith('$2a$') || lead.customerPassword.startsWith('$2b$'));

  if (isBcryptHash) {
    passwordValid = await bcrypt.compare(password, lead.customerPassword);
  } else if (lead.customerPassword && password === lead.customerPassword) {
    // Legacy plaintext match — hash it immediately so this path is never hit again
    passwordValid = true;
    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { customerPassword: hashedPassword }
    });
  }

  if (!passwordValid) {
    await auditContext.run({
      actorId:    null,
      actorName:  null,
      actorRole:  null,
      actorType:  'SYSTEM',
      ipAddress:  req.ip || null,
      userAgent:  req.get('user-agent') ?? null,
      requestId:  req.get('x-request-id') ?? null,
      routePath:  '/api/auth/customer-login',
      httpMethod: 'POST',
    }, async () => {
      await logAuthEvent({
        action:         'LOGIN',
        status:         'FAILURE',
        errorMessage:   'Invalid credentials',
        attemptedEmail: username,
      });
    });
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const token = jwt.sign(
    { leadId: lead.id, customerUserId: lead.customerUserId, type: 'customer' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  // Audit log: record customer-portal LOGIN. Like staff login, this runs
  // before any auth middleware has populated ALS scope, so we wrap the
  // log call in auditContext.run with actorType='CUSTOMER'.
  await auditContext.run({
    actorId:    lead.customerUserId || null,
    actorName:  lead.campaignData?.name || null,
    actorRole:  null,   // customers don't have a role
    actorType:  'CUSTOMER',
    ipAddress:  req.ip || null,
    userAgent:  req.get('user-agent') ?? null,
    requestId:  req.get('x-request-id') ?? null,
    routePath:  '/api/auth/customer-login',
    httpMethod: 'POST',
  }, async () => {
    await logAuthEvent({
      action:    'LOGIN',
      userId:    lead.customerUserId || null,
      userName:  lead.campaignData?.name || 'Customer',
      userRole:  null,
    });
  });

  res.json({
    message: 'Login successful',
    token,
    customer: {
      leadId: lead.id,
      customerUserId: lead.customerUserId,
      customerUsername: lead.customerUsername,
      company: lead.campaignData?.company,
      name: lead.campaignData?.name,
      planActive: lead.actualPlanIsActive,
      planName: lead.actualPlanName,
    }
  });
});
