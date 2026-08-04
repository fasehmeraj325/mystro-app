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
}

function toSubmission(row) {
  return {
    id: row.id,
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

async function listSubmissions() {
  const { rows } = await pool.query(
    "SELECT * FROM submissions ORDER BY submitted_at DESC"
  );
  return rows.map(toSubmission);
}

async function getSubmission(id) {
  const { rows } = await pool.query("SELECT * FROM submissions WHERE id = $1", [id]);
  return rows[0] ? toSubmission(rows[0]) : null;
}

async function insertSubmission(s) {
  await pool.query(
    `INSERT INTO submissions
      (id, full_name, email, phone, files, client_info, status, submitted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      s.id,
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

async function updateSubmissionStatus(id, status) {
  const { rows } = await pool.query(
    "UPDATE submissions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, status]
  );
  return rows[0] ? toSubmission(rows[0]) : null;
}

async function deleteSubmission(id) {
  const { rowCount } = await pool.query("DELETE FROM submissions WHERE id = $1", [id]);
  return rowCount > 0;
}

module.exports = {
  pool,
  initSchema,
  listSubmissions,
  getSubmission,
  insertSubmission,
  updateSubmissionStatus,
  deleteSubmission,
};
