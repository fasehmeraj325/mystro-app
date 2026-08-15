const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Add it to your .env file.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Configurable so a higher-traffic deployment can raise it without a code
  // change — stay mindful of the connection cap your Postgres plan allows.
  max: process.env.PGPOOL_MAX ? Number(process.env.PGPOOL_MAX) : 10,
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

  // --- company branding (white-label) ---------------------------------
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_color TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'dark';`);

  // --- indexes -------------------------------------------------------------
  // company_id isn't automatically indexed just by being a foreign key, and
  // it's the column every submissions query filters on — without this, the
  // dashboard table and the duplicate-application check both degrade to a
  // full table scan as submissions grow.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_submissions_company_submitted ON submissions (company_id, submitted_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_submissions_company_email_status ON submissions (company_id, email, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets (token_hash);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_verifications_user_created ON email_verifications (user_id, created_at DESC);`);
}

// --- companies -------------------------------------------------------

function toCompany(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    businessName: row.business_name,
    senderName: row.sender_name,
    logoUrl: row.logo_url,
    brandColor: row.brand_color,
    theme: row.theme,
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

// Partial update — only the fields present in `fields` are touched, so a
// caller can update just the logo without clobbering the business name, etc.
async function updateCompanyBranding(id, fields) {
  const columns = { businessName: "business_name", senderName: "sender_name", logoUrl: "logo_url", brandColor: "brand_color", theme: "theme" };
  const sets = [];
  const values = [id];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] === undefined) continue;
    values.push(fields[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return getCompanyById(id);
  const { rows } = await pool.query(`UPDATE companies SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
  return rows[0] ? toCompany(rows[0]) : null;
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

// Active users for a company — currently always exactly one (the admin
// created at signup), but written to return all of them so it keeps working
// unchanged if team accounts are added later.
async function getActiveUsersByCompany(companyId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE company_id = $1 AND status = 'active'", [companyId]);
  return rows.map(toUser);
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

// Draft-only helper: returns null if the submission doesn't exist, belongs
// to another company, or has already moved past the "Draft" (in-progress,
// pre-finalize) stage — callers use this to guard edits/uploads to a
// submission a client hasn't finished yet.
async function getDraftSubmission(companyId, id) {
  const submission = await getSubmission(companyId, id);
  if (!submission || submission.status !== "Draft") return null;
  return submission;
}

async function updateSubmissionClientInfo(companyId, id, { fullName, email, phone, clientInfo }) {
  if (!companyId) throw new Error("updateSubmissionClientInfo requires companyId");
  const { rows } = await pool.query(
    `UPDATE submissions
     SET full_name = $3, email = $4, phone = $5, client_info = $6, updated_at = now()
     WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, id, fullName, email, phone || "", JSON.stringify(clientInfo || {})]
  );
  return rows[0] ? toSubmission(rows[0]) : null;
}

async function appendSubmissionFile(companyId, id, field, fileMeta) {
  if (!companyId) throw new Error("appendSubmissionFile requires companyId");
  const { rows } = await pool.query(
    `UPDATE submissions
     SET files = jsonb_set(
           files,
           ARRAY[$3],
           COALESCE(files->$3, '[]'::jsonb) || $4::jsonb,
           true
         ),
         updated_at = now()
     WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, id, field, JSON.stringify([fileMeta])]
  );
  return rows[0] ? toSubmission(rows[0]) : null;
}

// Removes the file at `index` within `field`'s array and returns both the
// updated submission and the removed file's metadata (so the caller can
// also delete it from Cloudinary).
async function removeSubmissionFile(companyId, id, field, index) {
  if (!companyId) throw new Error("removeSubmissionFile requires companyId");
  const submission = await getSubmission(companyId, id);
  if (!submission) return { submission: null, removed: null };

  const entry = submission.files && submission.files[field];
  const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
  const removed = list[index];
  if (!removed) return { submission, removed: null };

  const nextList = list.filter((_, i) => i !== index);
  const nextFiles = { ...submission.files, [field]: nextList };

  const { rows } = await pool.query(
    `UPDATE submissions SET files = $3, updated_at = now()
     WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, id, JSON.stringify(nextFiles)]
  );
  return { submission: rows[0] ? toSubmission(rows[0]) : null, removed };
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
  updateCompanyBranding,
  // users
  createUser,
  getUserByEmail,
  getUserById,
  getActiveUsersByCompany,
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
  getDraftSubmission,
  getPendingSubmissionByEmail,
  insertSubmission,
  updateSubmissionStatus,
  updateSubmissionClientInfo,
  appendSubmissionFile,
  removeSubmissionFile,
  deleteSubmission,
};
