import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function fixAdmin() {
  const email = 'admin@email.com';
  const password = '123456';

  console.log('\n=== Checking Admin User ===\n');

  // Check if user exists
  const existingUser = await prisma.user.findUnique({
    where: { email: email.toLowerCase() }
  });

  if (existingUser) {
    console.log('User found:');
    console.log('  ID:', existingUser.id);
    console.log('  Email:', existingUser.email);
    console.log('  Name:', existingUser.name);
    console.log('  Role:', existingUser.role);
    console.log('  isActive:', existingUser.isActive);

    // Reset password and ensure user is active
    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { email: email.toLowerCase() },
      data: {
        password: hashedPassword,
        isActive: true
      }
    });

    console.log('\n✅ Password reset to "123456" and user activated!');
  } else {
    console.log('❌ User with email "admin@email.com" NOT FOUND');
    console.log('\nCreating new admin user...');

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        password: hashedPassword,
        name: 'Admin User',
        role: 'ADMIN',
        isActive: true
      }
    });

    console.log('\n✅ Admin user created!');
    console.log('  Email:', newUser.email);
    console.log('  Password: 123456');
    console.log('  Role:', newUser.role);
  }

  // List all users for reference
  console.log('\n=== All Users in Database ===\n');
  const allUsers = await prisma.user.findMany({
    select: {
      email: true,
      name: true,
      role: true,
      isActive: true
    }
  });

  allUsers.forEach(u => {
    console.log(`  ${u.email} | ${u.name} | ${u.role} | Active: ${u.isActive}`);
  });

  console.log('\n');
}

fixAdmin()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
