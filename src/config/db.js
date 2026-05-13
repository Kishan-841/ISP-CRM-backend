import { PrismaClient } from '@prisma/client';
import { auditExtension } from '../audit/prismaExtension.js';

// $extends returns a NEW client (immutable-extension pattern). All consumers
// of this module import the default export, so they automatically get the
// extended client without any call-site changes.
const prisma = new PrismaClient().$extends(auditExtension);

export default prisma;
