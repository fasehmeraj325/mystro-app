require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const db = require("./db");
const { buildClientPdf } = require("./pdf");

const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

// --- bootstrap storage -------------------------------------------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- file upload config -------------------------------------------------
// Each field accepts up to `maxCount` files; applicability notes (PAYG,
// self-employed, mortgaged, etc.) are shown to the client but not enforced
// here, since not every client needs every document.
const FILE_FIELDS = [
  { name: "driversLicence", label: "Valid Driver's Licence", maxCount: 2 },
  { name: "passport", label: "Valid Passport", maxCount: 2 },
  { name: "payslips", label: "Most recent 2 consecutive payslips (if PAYG)", maxCount: 4 },
  {
    name: "incomeProof",
    label: "Latest 3-month bank statement (salary credits) or latest FY income statement (if PAYG)",
    maxCount: 6,
  },
  {
    name: "homeLoanStatements",
    label: "Latest 6-month home loan statement(s) (for any mortgaged property)",
    maxCount: 6,
  },
  {
    name: "rentalIncomeStatements",
    label: "Latest rental income statement(s) (for investment properties)",
    maxCount: 6,
  },
  {
    name: "councilRatesNotices",
    label: "Most recent Council Rates Notice + payment proof (for owned properties)",
    maxCount: 6,
  },
  {
    name: "taxReturn",
    label: "Most recent Individual Tax Return FY25 or FY26 (if self-employed)",
    maxCount: 4,
  },
  {
    name: "liabilityStatements",
    label: "Latest 1-month statement(s) for liabilities (credit cards, loans, etc.)",
    maxCount: 10,
  },
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, req.submissionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${file.fieldname}__${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
});

// assign a submission id before multer runs so files land in the right folder
function assignSubmissionId(req, res, next) {
  req.submissionId = randomUUID();
  next();
}

// --- dashboard auth -------------------------------------------------
// Protects the dashboard page and everything that lists/reveals submissions
// or documents. The public intake form and /api/submit stay open so clients
// can apply without a login.
const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

if (!DASHBOARD_PASSWORD) {
  console.warn(
    "WARNING: DASHBOARD_PASSWORD is not set. Set DASHBOARD_USER and DASHBOARD_PASSWORD " +
      "environment variables before deploying, or the dashboard has no real password."
  );
}

function requireDashboardAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const sepIndex = decoded.indexOf(":");
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);

    if (user === DASHBOARD_USER && pass === DASHBOARD_PASSWORD && DASHBOARD_PASSWORD) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Mystro Dashboard"');
  return res.status(401).send("Authentication required.");
}

const app = express();
app.use(express.json());

// Dashboard page and its data must be authenticated before the static
// file handler / API routes below can serve them.
app.get("/dashboard.html", requireDashboardAuth);
app.use("/api/submissions", requireDashboardAuth);

app.use(express.static(path.join(APP_DIR, "public")));

// --- API ---------------------------------------------------------------

// Create a new submission (client intake)
app.post(
  "/api/submit",
  assignSubmissionId,
  upload.fields(FILE_FIELDS.map((f) => ({ name: f.name, maxCount: f.maxCount }))),
  async (req, res) => {
    let clientInfo;
    try {
      clientInfo = JSON.parse(req.body.clientInfo || "{}");
    } catch (e) {
      return res.status(400).json({ error: "Invalid form data." });
    }

    const personal = clientInfo.personal || {};
    const fullName = [personal.firstName, personal.surname].filter(Boolean).join(" ").trim();
    const email = personal.email || "";
    const phone = personal.mobilePhone || "";

    if (!fullName || !email) {
      return res.status(400).json({ error: "First name, surname, and email are required." });
    }

    const files = {};
    for (const field of FILE_FIELDS) {
      const uploaded = (req.files && req.files[field.name]) || [];
      if (uploaded.length) {
        files[field.name] = uploaded.map((f) => ({
          label: field.label,
          originalName: f.originalname,
          storedName: f.filename,
          size: f.size,
          mime: f.mimetype,
        }));
      }
    }

    const now = new Date().toISOString();
    const submission = {
      id: req.submissionId,
      fullName,
      email,
      phone,
      files,
      clientInfo,
      status: "New",
      submittedAt: now,
      updatedAt: now,
    };

    await db.insertSubmission(submission);

    res.status(201).json({ ok: true, id: submission.id });
  }
);

// List submissions (summary, for dashboard table)
app.get("/api/submissions", async (req, res) => {
  const list = await db.listSubmissions();
  res.json(
    list.map((s) => ({
      id: s.id,
      fullName: s.fullName,
      email: s.email,
      phone: s.phone,
      occupation: (s.clientInfo && s.clientInfo.employment && s.clientInfo.employment.occupation) || "",
      status: s.status,
      fileCount: Object.values(s.files || {}).reduce(
        (sum, entry) => sum + (Array.isArray(entry) ? entry.length : entry ? 1 : 0),
        0
      ),
      submittedAt: s.submittedAt,
      updatedAt: s.updatedAt,
    }))
  );
});

// Full detail for one submission
app.get("/api/submissions/:id", async (req, res) => {
  const submission = await db.getSubmission(req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });
  res.json(submission);
});

// Update status (New / In Review / Approved / Rejected)
app.patch("/api/submissions/:id", async (req, res) => {
  const allowed = ["New", "In Review", "Approved", "Rejected"];
  if (!req.body.status || !allowed.includes(req.body.status)) {
    const submission = await db.getSubmission(req.params.id);
    if (!submission) return res.status(404).json({ error: "Not found" });
    return res.json(submission);
  }

  const submission = await db.updateSubmissionStatus(req.params.id, req.body.status);
  if (!submission) return res.status(404).json({ error: "Not found" });
  res.json(submission);
});

// Delete a submission and its files
app.delete("/api/submissions/:id", async (req, res) => {
  const deleted = await db.deleteSubmission(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });

  const dir = path.join(UPLOADS_DIR, req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  res.json({ ok: true });
});

// Download the full client information form as a PDF
app.get("/api/submissions/:id/pdf", async (req, res) => {
  const submission = await db.getSubmission(req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });
  buildClientPdf(res, submission);
});

// Download / view an uploaded file. :index selects which file when a field
// has multiple uploads (older submissions stored a single object per field
// instead of an array, so both shapes are handled here).
app.get("/api/submissions/:id/files/:field/:index", async (req, res) => {
  const submission = await db.getSubmission(req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });

  const entry = submission.files && submission.files[req.params.field];
  const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
  const fileMeta = list[Number(req.params.index)];
  if (!fileMeta) return res.status(404).json({ error: "File not found" });

  const filePath = path.join(UPLOADS_DIR, req.params.id, fileMeta.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing on disk" });

  res.download(filePath, fileMeta.originalName);
});

const PORT = process.env.PORT || 3000;

db.initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Mystro Lite running at http://localhost:${PORT}`);
      console.log(`Client intake form: http://localhost:${PORT}/`);
      console.log(`Dashboard:          http://localhost:${PORT}/dashboard.html`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err.message);
    process.exit(1);
  });
