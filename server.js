const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "submissions.json");

// --- bootstrap storage -------------------------------------------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");

function readSubmissions() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
}

function writeSubmissions(list) {
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
}

// --- file upload config -------------------------------------------------
const FILE_FIELDS = [
  { name: "idDocument", label: "Photo ID" },
  { name: "proofOfIncome", label: "Proof of Income" },
  { name: "bankStatement", label: "Bank Statement" },
  { name: "proofOfAddress", label: "Proof of Address" },
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
  upload.fields(FILE_FIELDS.map((f) => ({ name: f.name, maxCount: 1 }))),
  (req, res) => {
    const b = req.body;

    if (!b.fullName || !b.email) {
      return res.status(400).json({ error: "Full name and email are required." });
    }

    const files = {};
    for (const field of FILE_FIELDS) {
      const uploaded = req.files && req.files[field.name] && req.files[field.name][0];
      if (uploaded) {
        files[field.name] = {
          label: field.label,
          originalName: uploaded.originalname,
          storedName: uploaded.filename,
          size: uploaded.size,
          mime: uploaded.mimetype,
        };
      }
    }

    const submission = {
      id: req.submissionId,
      fullName: b.fullName,
      email: b.email,
      phone: b.phone || "",
      dob: b.dob || "",
      employmentStatus: b.employmentStatus || "",
      annualIncome: b.annualIncome || "",
      loanAmount: b.loanAmount || "",
      loanPurpose: b.loanPurpose || "",
      notes: b.notes || "",
      files,
      status: "New",
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const list = readSubmissions();
    list.unshift(submission);
    writeSubmissions(list);

    res.status(201).json({ ok: true, id: submission.id });
  }
);

// List submissions (summary, for dashboard table)
app.get("/api/submissions", (req, res) => {
  const list = readSubmissions().map((s) => ({
    id: s.id,
    fullName: s.fullName,
    email: s.email,
    phone: s.phone,
    loanAmount: s.loanAmount,
    loanPurpose: s.loanPurpose,
    status: s.status,
    fileCount: Object.keys(s.files || {}).length,
    submittedAt: s.submittedAt,
    updatedAt: s.updatedAt,
  }));
  res.json(list);
});

// Full detail for one submission
app.get("/api/submissions/:id", (req, res) => {
  const list = readSubmissions();
  const submission = list.find((s) => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });
  res.json(submission);
});

// Update status (New / In Review / Approved / Rejected)
app.patch("/api/submissions/:id", (req, res) => {
  const list = readSubmissions();
  const idx = list.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const allowed = ["New", "In Review", "Approved", "Rejected"];
  if (req.body.status && allowed.includes(req.body.status)) {
    list[idx].status = req.body.status;
    list[idx].updatedAt = new Date().toISOString();
    writeSubmissions(list);
  }
  res.json(list[idx]);
});

// Delete a submission and its files
app.delete("/api/submissions/:id", (req, res) => {
  const list = readSubmissions();
  const idx = list.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const dir = path.join(UPLOADS_DIR, req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  list.splice(idx, 1);
  writeSubmissions(list);
  res.json({ ok: true });
});

// Download / view an uploaded file
app.get("/api/submissions/:id/files/:field", (req, res) => {
  const list = readSubmissions();
  const submission = list.find((s) => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });

  const fileMeta = submission.files && submission.files[req.params.field];
  if (!fileMeta) return res.status(404).json({ error: "File not found" });

  const filePath = path.join(UPLOADS_DIR, req.params.id, fileMeta.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing on disk" });

  res.download(filePath, fileMeta.originalName);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mystro Lite running at http://localhost:${PORT}`);
  console.log(`Client intake form: http://localhost:${PORT}/`);
  console.log(`Dashboard:          http://localhost:${PORT}/dashboard.html`);
});
