import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';

export const login = asyncHandler(async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() }
  });

  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  if (!user.isActive) {
    return res.status(401).json({ message: 'Account is deactivated.' });
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

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

export const me = asyncHandler(async function me(req, res) {
  res.json({ user: req.user });
});

export const customerLogin = asyncHandler(async function customerLogin(req, res) {
  const { username, password } = req.body;

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
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const token = jwt.sign(
    { leadId: lead.id, customerUserId: lead.customerUserId, type: 'customer' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

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
