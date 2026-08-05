const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Add it to your .env file.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id UUID PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      dob TEXT NOT NULL DEFAULT '',
      employment_status TEXT NOT NULL DEFAULT '',
      annual_income TEXT NOT NULL DEFAULT '',
      loan_amount TEXT NOT NULL DEFAULT '',
      loan_purpose TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      files JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'New',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // client_info holds the full fact-find form (personal, address, employment,
  // additional income, real estate, assets, liabilities) as flexible JSON —
  // added after the initial schema, so it's a separate migration step.
  await pool.query(`
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS client_info JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // --- multi-tenancy -----------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      business_name TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Session store table for connect-pg-simple.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
  `);
  await pool.query(`
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  `);
}

// --- companies -------------------------------------------------------

function toCompany(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    businessName: row.business_name,
    senderName: row.sender_name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

async function createCompany(c) {
  const { rows } = await pool.query(
    `INSERT INTO companies (id, name, slug, business_name, sender_name)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [c.id, c.name, c.slug, c.businessName || c.name, c.senderName || ""]
  );
  return toCompany(rows[0]);
}

async function getCompanyBySlug(slug) {
  const { rows } = await pool.query("SELECT * FROM companies WHERE slug = $1", [slug]);
  return rows[0] ? toCompany(rows[0]) : null;
}

async function getCompanyById(id) {
  const { rows } = await pool.query("SELECT * FROM companies WHERE id = $1", [id]);
  return rows[0] ? toCompany(rows[0]) : null;
}

async function slugExists(slug) {
  const { rows } = await pool.query("SELECT 1 FROM companies WHERE slug = $1", [slug]);
  return rows.length > 0;
}

// --- users -------------------------------------------------------------

function toUser(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

async function createUser(u) {
  const { rows } = await pool.query(
    `INSERT INTO users (id, company_id, email, password_hash, role, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [u.id, u.companyId, u.email.toLowerCase(), u.passwordHash, u.role || "admin", u.status || "pending"]
  );
  return toUser(rows[0]);
}

async function getUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
  return rows[0] ? toUser(rows[0]) : null;
}

async function getUserById(id) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

async function activateUser(id) {
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [id]);
}

async function setUserPassword(id, passwordHash) {
  await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
}

// --- email verification -------------------------------------------------

async function createVerification(v) {
  await pool.query(
    `INSERT INTO email_verifications (id, user_id, code_hash, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [v.id, v.userId, v.codeHash, v.expiresAt]
  );
}

async function getLatestVerification(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM email_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    codeHash: row.code_hash,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

async function incrementVerificationAttempts(id) {
  await pool.query("UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1", [id]);
}

// --- password resets -----------------------------------------------------
// token_hash is a SHA-256 digest of a high-entropy random token (not a bcrypt
// hash) so a reset link can be looked up directly by its hash — the token
// itself, not a user id, is the only thing the requester has at that point.

async function createPasswordReset(r) {
  await pool.query(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [r.id, r.userId, r.tokenHash, r.expiresAt]
  );
}

async function getPasswordResetByTokenHash(tokenHash) {
  const { rows } = await pool.query(
    "SELECT * FROM password_resets WHERE token_hash = $1",
    [tokenHash]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    used: row.used,
    createdAt: row.created_at,
  };
}

async function markPasswordResetUsed(id) {
  await pool.query("UPDATE password_resets SET used = true WHERE id = $1", [id]);
}

// --- submissions (tenant-scoped) ----------------------------------------
// companyId is a required first argument on every function below so a
// route handler that forgets to scope a query fails loudly instead of
// silently returning another tenant's data.

function toSubmission(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    dob: row.dob,
    employmentStatus: row.employment_status,
    annualIncome: row.annual_income,
    loanAmount: row.loan_amount,
    loanPurpose: row.loan_purpose,
    notes: row.notes,
    files: row.files,
    clientInfo: row.client_info,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function listSubmissions(companyId) {
  if (!companyId) throw new Error("listSubmissions requires companyId");
  const { rows } = await pool.query(
    "SELECT * FROM submissions WHERE company_id = $1 ORDER BY submitted_at DESC",
    [companyId]
  );
  return rows.map(toSubmission);
}

async function getSubmission(companyId, id) {
  if (!companyId) throw new Error("getSubmission requires companyId");
  const { rows } = await pool.query(
    "SELECT * FROM submissions WHERE company_id = $1 AND id = $2",
    [companyId, id]
  );
  return rows[0] ? toSubmission(rows[0]) : null;
}

async function getPendingSubmissionByEmail(companyId, email) {
  if (!companyId) throw new Error("getPendingSubmissionByEmail requires companyId");
  const { rows } = await pool.query(
    `SELECT * FROM submissions
     WHERE company_id = $1 AND email = $2 AND status IN ('New', 'In Review')
     ORDER BY submitted_at DESC LIMIT 1`,
    [companyId, email]
  );
  return rows[0] ? toSubmission(rows[0]) : null;
}

async function insertSubmission(s) {
  if (!s.companyId) throw new Error("insertSubmission requires companyId");
  await pool.query(
    `INSERT INTO submissions
      (id, company_id, full_name, email, phone, files, client_info, status, submitted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      s.id,
      s.companyId,
      s.fullName,
      s.email,
      s.phone,
      JSON.stringify(s.files),
      JSON.stringify(s.clientInfo || {}),
      s.status,
      s.submittedAt,
      s.updatedAt,
    ]
  );
}

async function updateSubmissionStatus(companyId, id, status) {
  if (!companyId) throw new Error("updateSubmissionStatus requires companyId");
  const { rows } = await pool.query(
    "UPDATE submissions SET status = $3, updated_at = now() WHERE company_id = $1 AND id = $2 RETURNING *",
    [companyId, id, status]
  );
  return rows[0] ? toSubmission(rows[0]) : null;
}

async function deleteSubmission(companyId, id) {
  if (!companyId) throw new Error("deleteSubmission requires companyId");
  const { rowCount } = await pool.query(
    "DELETE FROM submissions WHERE company_id = $1 AND id = $2",
    [companyId, id]
  );
  return rowCount > 0;
}

module.exports = {
  pool,
  initSchema,
  // companies
  createCompany,
  getCompanyBySlug,
  getCompanyById,
  slugExists,
  // users
  createUser,
  getUserByEmail,
  getUserById,
  activateUser,
  setUserPassword,
  // verification
  createVerification,
  getLatestVerification,
  incrementVerificationAttempts,
  // password resets
  createPasswordReset,
  getPasswordResetByTokenHash,
  markPasswordResetUsed,
  // submissions
  listSubmissions,
  getSubmission,
  getPendingSubmissionByEmail,
  insertSubmission,
  updateSubmissionStatus,
  deleteSubmission,
};
