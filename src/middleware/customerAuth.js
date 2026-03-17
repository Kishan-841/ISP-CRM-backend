import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

export const customerAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== 'customer') {
      return res.status(401).json({ message: 'Invalid token type.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id: decoded.leadId },
      select: {
        id: true,
        customerUserId: true,
        customerUsername: true,
        actualPlanIsActive: true,
        campaignData: {
          select: {
            company: true,
            name: true,
            phone: true,
            email: true,
          }
        }
      }
    });

    if (!lead) {
      return res.status(401).json({ message: 'Customer account not found.' });
    }

    req.customer = {
      leadId: lead.id,
      customerUserId: lead.customerUserId,
      customerUsername: lead.customerUsername,
      planActive: lead.actualPlanIsActive,
      company: lead.campaignData?.company,
      name: lead.campaignData?.name,
      phone: lead.campaignData?.phone,
      email: lead.campaignData?.email,
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token.' });
  }
};
