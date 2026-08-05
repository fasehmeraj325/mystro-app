require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcrypt");
const dns = require("dns");
const disposableDomains = require("disposable-email-domains");
const path = require("path");
const { randomUUID, randomInt, randomBytes, createHash } = require("crypto");
const db = require("./db");
const { buildClientPdf } = require("./pdf");
const { sendClientInvite, sendVerificationCode, sendPasswordReset, APP_URL } = require("./mail");

const APP_DIR = __dirname;
const DISPOSABLE_DOMAINS = new Set(disposableDomains);

// --- cloud file storage --------------------------------------------------
// Uploaded documents go straight to Cloudinary rather than local disk, so
// they survive redeploys/restarts on hosts with ephemeral disks (e.g. free
// tiers). type: "authenticated" means Cloudinary won't serve a file from its
// public_id alone — every download must go through a short-lived signed URL
// we generate ourselves, only after our own session-auth check passes.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

// Custom multer storage engine that streams each upload straight to
// Cloudinary instead of local disk — see the cloud file storage note above.
class CloudinaryStorage {
  _handleFile(req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `docklio/${req.submissionId}`,
        public_id: `${file.fieldname}__${Date.now()}__${safeName}`,
        resource_type: "auto",
        type: "authenticated",
      },
      (err, result) => {
        if (err) return cb(err);
        cb(null, {
          publicId: result.public_id,
          resourceType: result.resource_type,
          format: result.format,
          size: result.bytes,
        });
      }
    );
    file.stream.pipe(uploadStream);
  }

  _removeFile(req, file, cb) {
    if (!file.publicId) return cb(null);
    cloudinary.uploader
      .destroy(file.publicId, { resource_type: file.resourceType, type: "authenticated" })
      .then(() => cb(null))
      .catch(cb);
  }
}

const storage = new CloudinaryStorage();

// Cleans up files multer already uploaded to Cloudinary when a submission
// turns out to be invalid/rejected (bad slug, honeypot trip, duplicate) —
// otherwise those documents would sit in Cloudinary forever, orphaned.
async function destroyUploadedFiles(req) {
  const allFiles = Object.values(req.files || {}).flat();
  await Promise.all(
    allFiles.map((f) =>
      cloudinary.uploader
        .destroy(f.publicId, { resource_type: f.resourceType, type: "authenticated" })
        .catch((err) => console.error("Failed to remove orphaned upload:", err.message))
    )
  );
}

// Client documents are always images or PDFs in practice (IDs, payslips,
// statements) — rejecting anything else (executables, HTML, etc.) up front
// costs nothing and closes off a whole class of malicious-upload mischief.
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
]);

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
      const err = new Error("Only PDF and image files (JPG, PNG, HEIC, WEBP) are accepted.");
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

// assign a submission id before multer runs so files land in the right folder
function assignSubmissionId(req, res, next) {
  req.submissionId = randomUUID();
  next();
}

// --- abuse protection -------------------------------------------------
// Caps how many applications a single IP can submit per hour, so a script
// (or an over-eager client) can't flood a company's dashboard with submissions.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many applications submitted from this network. Please try again later." },
});

// Slows down password-guessing on the actual login endpoint specifically —
// not the whole authenticated API surface, since a real admin's normal
// dashboard use (loading submissions, opening records, updating statuses)
// can easily exceed a tight login-guessing limit within 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// General ceiling on the already-authenticated dashboard API surface — a
// basic DoS/abuse guard, not a brute-force guard (that's loginLimiter's job).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts from this network. Please try again later." },
});

const verifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// --- dashboard auth -----------------------------------------------------
// Every company logs in via session now (see /api/auth/login below).

function requireCompanyAuthApi(req, res, next) {
  if (req.session && req.session.companyId) {
    req.companyId = req.session.companyId;
    return next();
  }
  return res.status(401).json({ error: "Authentication required." });
}

function requireCompanyAuthPage(req, res, next) {
  if (req.session && req.session.companyId) {
    req.companyId = req.session.companyId;
    return next();
  }
  return res.redirect("/login.html");
}

// Wraps an async route handler so a rejected promise (e.g. a Postgres error
// from a malformed id) reaches Express's error handler instead of becoming
// an unhandled rejection — which crashes the whole process for every company.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const app = express();

// Exactly one reverse proxy hop is assumed (Render/Railway/Fly/etc. style
// hosting) — needed so express-rate-limit reads the real client IP from
// X-Forwarded-For instead of the proxy's own address.
app.set("trust proxy", 1);

// contentSecurityPolicy is off because every page here uses inline <script>
// tags; enabling helmet's default CSP would silently block them. Everything
// else (X-Content-Type-Options, X-Frame-Options, HSTS once behind HTTPS,
// etc.) stays on.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json());
app.use(
  session({
    store: new PgSession({ pool: db.pool, tableName: "session" }),
    secret: process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

if (!process.env.SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set — using an insecure default. Set it before deploying.");
}

// The dashboard page and everything under /api/submissions & /api/send-invite
// require a logged-in company. The public intake form and its submit
// endpoint stay open — clients apply
// without an account.
app.get("/dashboard.html", apiLimiter, requireCompanyAuthPage);
app.use("/api/submissions", apiLimiter, requireCompanyAuthApi);
app.use("/api/send-invite", apiLimiter, requireCompanyAuthApi);

// Serve the intake form template at /apply/:slug (same physical file as
// public/index.html — an inline script reads the slug from the URL).
app.get("/apply/:slug", (req, res) => {
  res.sendFile(path.join(APP_DIR, "public", "index.html"));
});

// No bare "/" landing page yet — send visitors to log in.
app.get("/", (req, res) => res.redirect("/login.html"));

app.use(express.static(path.join(APP_DIR, "public")));

// --- auth: signup / verify / login / logout -----------------------------

function slugify(name) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "company"
  );
}

async function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (await db.slugExists(slug)) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}

async function isDisposableOrInvalidEmail(email) {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain) return true;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  try {
    const records = await dns.promises.resolveMx(domain);
    if (!records || records.length === 0) return true;
  } catch (e) {
    return true; // domain doesn't resolve at all
  }
  return false;
}

async function issueVerificationCode(userId, email) {
  const code = String(randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await db.createVerification({ id: randomUUID(), userId, codeHash, expiresAt });
  await sendVerificationCode({ toEmail: email, code });
}

app.post("/api/auth/signup", signupLimiter, async (req, res) => {
  const { companyName, email, password } = req.body || {};
  if (!companyName || !email || !password) {
    return res.status(400).json({ error: "Company name, email, and password are required." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const existing = await db.getUserByEmail(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  if (await isDisposableOrInvalidEmail(normalizedEmail)) {
    return res.status(400).json({
      error: "Please sign up with your real work email address — disposable or unreachable email domains aren't accepted.",
    });
  }

  try {
    const slug = await uniqueSlug(companyName);
    const company = await db.createCompany({
      id: randomUUID(),
      name: companyName,
      slug,
      businessName: companyName,
      senderName: "",
    });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({
      id: randomUUID(),
      companyId: company.id,
      email: normalizedEmail,
      passwordHash,
      role: "admin",
      status: "pending",
    });

    // Account creation must succeed for the request to succeed; the email
    // itself is best-effort so a misconfigured/down SMTP server doesn't
    // orphan the account with no way to resend the code once fixed.
    try {
      await issueVerificationCode(user.id, normalizedEmail);
    } catch (mailErr) {
      console.error("Signup succeeded but the verification email failed to send:", mailErr.message);
    }

    res.status(201).json({ ok: true, email: normalizedEmail });
  } catch (err) {
    console.error("Signup failed:", err.message);
    res.status(500).json({ error: "Something went wrong creating your account. Please try again." });
  }
});

app.post("/api/auth/resend-code", verifyLimiter, async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const user = await db.getUserByEmail(email);
  if (!user || user.status === "active") {
    // Don't reveal whether the account exists.
    return res.json({ ok: true });
  }
  try {
    await issueVerificationCode(user.id, email);
  } catch (err) {
    console.error("Failed to resend verification code:", err.message);
  }
  res.json({ ok: true });
});

app.post("/api/auth/verify", verifyLimiter, async (req, res) => {
  try {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const code = String((req.body || {}).code || "").trim();

    const user = await db.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: "Invalid email or code." });
    if (user.status === "active") return res.status(400).json({ error: "This account is already verified." });

    const verification = await db.getLatestVerification(user.id);
    if (!verification) return res.status(400).json({ error: "No verification code found. Request a new one." });
    if (verification.attempts >= 5) {
      return res.status(429).json({ error: "Too many incorrect attempts. Request a new code." });
    }
    if (new Date(verification.expiresAt) < new Date()) {
      return res.status(400).json({ error: "This code has expired. Request a new one." });
    }

    const match = await bcrypt.compare(code, verification.codeHash);
    if (!match) {
      await db.incrementVerificationAttempts(verification.id);
      return res.status(400).json({ error: "Incorrect code." });
    }

    await db.activateUser(user.id);
    req.session.userId = user.id;
    req.session.companyId = user.companyId;
    res.json({ ok: true });
  } catch (err) {
    console.error("Verify failed:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const password = String((req.body || {}).password || "");

    const user = await db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: "Incorrect email or password." });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: "Incorrect email or password." });

    if (user.status !== "active") {
      return res.status(403).json({ error: "Please verify your email first.", needsVerification: true, email: user.email });
    }

    req.session.userId = user.id;
    req.session.companyId = user.companyId;
    res.json({ ok: true });
  } catch (err) {
    console.error("Login failed:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function hashResetToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

app.post("/api/auth/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const user = await db.getUserByEmail(email);

  // Only active accounts get a reset link, but the response never reveals
  // whether the email matched — otherwise this endpoint becomes a way to
  // enumerate registered accounts.
  if (user && user.status === "active") {
    try {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await db.createPasswordReset({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt,
      });
      await sendPasswordReset({ toEmail: email, resetUrl: `${APP_URL}/reset-password.html?token=${token}` });
    } catch (err) {
      console.error("Failed to send password reset email:", err.message);
    }
  }

  res.json({ ok: true });
});

app.post("/api/auth/reset-password", resetPasswordLimiter, async (req, res) => {
  try {
    const token = String((req.body || {}).token || "").trim();
    const password = String((req.body || {}).password || "");

    if (!token) return res.status(400).json({ error: "This reset link is invalid or has expired." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const reset = await db.getPasswordResetByTokenHash(hashResetToken(token));
    if (!reset || reset.used || new Date(reset.expiresAt) < new Date()) {
      return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await db.setUserPassword(reset.userId, passwordHash);
    await db.markPasswordResetUsed(reset.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Reset password failed:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Public: look up a company by its application-link slug.
app.get("/api/public/companies/:slug", asyncHandler(async (req, res) => {
  const company = await db.getCompanyBySlug(req.params.slug);
  if (!company || company.status !== "active") return res.status(404).json({ error: "Not found" });
  res.json({ name: company.name, businessName: company.businessName });
}));

// The logged-in company's own info (for showing its /apply/:slug link etc.)
app.get("/api/company", requireCompanyAuthApi, asyncHandler(async (req, res) => {
  const company = await db.getCompanyById(req.companyId);
  if (!company) return res.status(404).json({ error: "Not found" });
  res.json({
    name: company.name,
    slug: company.slug,
    businessName: company.businessName,
    senderName: company.senderName,
    applyUrl: `${APP_URL}/apply/${company.slug}`,
  });
}));

// --- API ---------------------------------------------------------------

// Create a new submission (client intake) for a specific company.
app.post(
  "/api/public/:slug/submit",
  submitLimiter,
  assignSubmissionId,
  upload.fields(FILE_FIELDS.map((f) => ({ name: f.name, maxCount: f.maxCount }))),
  asyncHandler(async (req, res) => {
    const company = await db.getCompanyBySlug(req.params.slug);
    if (!company || company.status !== "active") {
      await destroyUploadedFiles(req);
      return res.status(404).json({ error: "This application link is no longer valid." });
    }

    // Honeypot: a field named "company" is hidden from real clients via CSS,
    // so only bots that auto-fill every input tend to populate it. Pretend
    // to succeed rather than telling the bot what tripped it.
    if (req.body.company) {
      await destroyUploadedFiles(req);
      return res.status(201).json({ ok: true, id: req.submissionId });
    }

    let clientInfo;
    try {
      clientInfo = JSON.parse(req.body.clientInfo || "{}");
    } catch (e) {
      return res.status(400).json({ error: "Invalid form data." });
    }

    const personal = clientInfo.personal || {};
    // Surname is optional now that Last name exists as its own field — prefer
    // Last name when present, falling back to Surname for older submissions.
    const fullName = [personal.firstName, personal.lastName || personal.surname].filter(Boolean).join(" ").trim();
    const email = personal.email || "";
    const phone = personal.mobilePhone || "";

    if (!fullName || !email) {
      return res.status(400).json({ error: "First name, surname, and email are required." });
    }

    const pending = await db.getPendingSubmissionByEmail(company.id, email);
    if (pending) {
      await destroyUploadedFiles(req);
      return res.status(409).json({
        error: "You already have an application in progress with this email address. We'll be in touch soon — no need to submit again.",
      });
    }

    const files = {};
    for (const field of FILE_FIELDS) {
      const uploaded = (req.files && req.files[field.name]) || [];
      if (uploaded.length) {
        files[field.name] = uploaded.map((f) => ({
          label: field.label,
          originalName: f.originalname,
          publicId: f.publicId,
          resourceType: f.resourceType,
          format: f.format,
          size: f.size,
          mime: f.mimetype,
        }));
      }
    }

    const now = new Date().toISOString();
    const submission = {
      id: req.submissionId,
      companyId: company.id,
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
  })
);

// Email a client the intake form link (admin-only)
app.post("/api/send-invite", async (req, res) => {
  const { email, name } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "A client email address is required." });
  }

  const company = await db.getCompanyById(req.companyId);
  if (!company) return res.status(404).json({ error: "Company not found." });

  try {
    await sendClientInvite({
      toEmail: email,
      toName: name,
      businessName: company.businessName || company.name,
      senderName: company.senderName,
      applyUrl: `${APP_URL}/apply/${company.slug}`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send invite email:", err.message);
    res.status(500).json({ error: "Something went wrong sending that email. Please try again." });
  }
});

// List submissions (summary, for dashboard table)
app.get("/api/submissions", asyncHandler(async (req, res) => {
  const list = await db.listSubmissions(req.companyId);
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
}));

// Full detail for one submission
app.get("/api/submissions/:id", asyncHandler(async (req, res) => {
  const submission = await db.getSubmission(req.companyId, req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });
  res.json(submission);
}));

// Update status (New / In Review / Approved / Rejected)
app.patch("/api/submissions/:id", asyncHandler(async (req, res) => {
  const allowed = ["New", "In Review", "Approved", "Rejected"];
  if (!req.body.status || !allowed.includes(req.body.status)) {
    const submission = await db.getSubmission(req.companyId, req.params.id);
    if (!submission) return res.status(404).json({ error: "Not found" });
    return res.json(submission);
  }

  const submission = await db.updateSubmissionStatus(req.companyId, req.params.id, req.body.status);
  if (!submission) return res.status(404).json({ error: "Not found" });
  res.json(submission);
}));

// Delete a submission and its files
app.delete("/api/submissions/:id", asyncHandler(async (req, res) => {
  const submission = await db.getSubmission(req.companyId, req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });

  const deleted = await db.deleteSubmission(req.companyId, req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });

  const allFiles = Object.values(submission.files || {}).flatMap((entry) =>
    Array.isArray(entry) ? entry : entry ? [entry] : []
  );
  await Promise.all(
    allFiles
      .filter((f) => f.publicId)
      .map((f) =>
        cloudinary.uploader
          .destroy(f.publicId, { resource_type: f.resourceType, type: "authenticated" })
          .catch((err) => console.error("Failed to remove upload on delete:", err.message))
      )
  );

  res.json({ ok: true });
}));

// Download the full client information form as a PDF
app.get("/api/submissions/:id/pdf", asyncHandler(async (req, res) => {
  const submission = await db.getSubmission(req.companyId, req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });
  buildClientPdf(res, submission);
}));

// Download / view an uploaded file. :index selects which file when a field
// has multiple uploads (older submissions stored a single object per field
// instead of an array, so both shapes are handled here).
app.get("/api/submissions/:id/files/:field/:index", asyncHandler(async (req, res) => {
  const submission = await db.getSubmission(req.companyId, req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });

  const entry = submission.files && submission.files[req.params.field];
  const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
  const fileMeta = list[Number(req.params.index)];
  if (!fileMeta || !fileMeta.publicId) return res.status(404).json({ error: "File not found" });

  // Freshly generated per request, only reachable after requireCompanyAuthApi
  // above has already verified this company owns the submission — so this
  // never hands out a durable, guessable link to the file.
  const downloadUrl = cloudinary.utils.private_download_url(fileMeta.publicId, fileMeta.format, {
    resource_type: fileMeta.resourceType,
    type: "authenticated",
    attachment: true,
  });

  res.redirect(downloadUrl);
}));

// Catches anything forwarded via next(err) (every asyncHandler-wrapped route
// above) so a bad request — a malformed id, a Postgres error, anything —
// returns a normal 500 to that one request instead of crashing the process
// for every company. Must be defined last, after all routes.
app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return next(err);
  // err.statusCode marks a deliberate, safe-to-show validation error (e.g.
  // the upload file-type filter) — anything else stays a generic message so
  // internal error details (DB errors, stack traces, etc.) never reach the client.
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Final safety net: log and keep running instead of crashing on anything
// that still slips past Express (a bug in a future route, a stray callback).
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const PORT = process.env.PORT || 3000;

db.initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Docklio running at http://localhost:${PORT}`);
      console.log(`Sign up / log in:   http://localhost:${PORT}/login.html`);
      console.log(`Dashboard:          http://localhost:${PORT}/dashboard.html`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err.message);
    process.exit(1);
  });
