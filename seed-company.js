require("dotenv").config();

const { randomUUID, randomBytes } = require("crypto");
const bcrypt = require("bcrypt");
const db = require("./db");

const COMPANY_NAME = "Burj";
const COMPANY_SLUG = "burj";
const ADMIN_EMAIL = "khan.faseh@gmail.com";

async function main() {
  await db.initSchema();

  let company = await db.getCompanyBySlug(COMPANY_SLUG);
  if (!company) {
    company = await db.createCompany({
      id: randomUUID(),
      name: COMPANY_NAME,
      slug: COMPANY_SLUG,
      businessName: COMPANY_NAME,
      senderName: "",
    });
    console.log(`Created company "${company.name}" (slug: ${company.slug}, id: ${company.id})`);
  } else {
    console.log(`Company "${company.name}" already exists (id: ${company.id})`);
  }

  let user = await db.getUserByEmail(ADMIN_EMAIL);
  if (!user) {
    const password = process.argv[2] || randomBytes(9).toString("base64url");
    const passwordHash = await bcrypt.hash(password, 12);
    user = await db.createUser({
      id: randomUUID(),
      companyId: company.id,
      email: ADMIN_EMAIL,
      passwordHash,
      role: "admin",
      status: "active",
    });
    console.log(`Created admin user ${user.email}`);
    console.log(`\nLogin password: ${password}\n(save this now — it is not stored anywhere else)`);
  } else {
    console.log(`Admin user ${user.email} already exists`);
  }

  const { rowCount } = await db.pool.query(
    "UPDATE submissions SET company_id = $1 WHERE company_id IS NULL",
    [company.id]
  );
  console.log(`Backfilled ${rowCount} existing submission(s) onto "${company.name}"`);

  await db.pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
