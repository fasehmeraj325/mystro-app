require("dotenv").config();

const express = require("express");
const compression = require("compression");
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
const { FILE_FIELDS, REQUIRED_FILE_FIELDS, computeFormProgress, computeDocProgress } = require("./public/progress");

const APP_DIR = __dirname;
const DISPOSABLE_DOMAINS = new Set(disposableDomains);

// Fixed bcrypt hash of an arbitrary string, compared against on login when
// the email doesn't match any account — see the timing note at the login
// route below. Precomputed so it costs nothing at startup.
const DUMMY_PASSWORD_HASH = "$2b$12$.hF31o3YF5gCV1JVHnTL1uh6J9pe/vSUIElsVXYs1eyangzGYYi7u";

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
// FILE_FIELDS/REQUIRED_FILE_FIELDS live in ./public/progress.js, shared with
// the browser, so the document checklist and its applicability rules can't
// drift between server and client.

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

// The draft's own id doubles as the Cloudinary folder key — set it on the
// request before multer's storage engine runs so uploads for a given
// document endpoint land in that draft's folder.
function useSubmissionIdParam(req, res, next) {
  req.submissionId = req.params.id;
  next();
}

// --- abuse protection -------------------------------------------------
// Caps how many NEW applications a single IP can start per hour, so a
// script (or an over-eager client) can't flood a company's dashboard with
// drafts. Only guards draft creation — editing or finishing an application
// you already started must not eat into this budget (see draftActionLimiter
// below), or a client who revises their own answers a couple of times could
// lock everyone on their network out of starting new applications.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many applications submitted from this network. Please try again later." },
});

// Edits and the final "finish" step, for a draft that already passed the
// submitLimiter gate at creation — much more headroom since these are
// continuing one application, not starting new ones.
const draftActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this network. Please try again later." },
});

// Individual document uploads happen many times over the course of one
// application (one request per file), so this needs a much higher ceiling
// than submitLimiter — it's just a sanity cap against runaway scripts.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads from this network. Please try again later." },
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

// Gzip everything — the intake form's HTML/CSS/JS compress heavily, and
// this costs nothing under load since it's a fixed per-response CPU cost,
// not something that scales with concurrent traffic.
app.use(compression());

// Cheap liveness check for load balancers/uptime monitors — no DB round
// trip, so it stays fast and answers even if the database is briefly down.
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// scriptSrc/styleSrc allow 'unsafe-inline' because every page here uses
// inline <script> tags and inline style="" attributes — a stricter policy
// would need those moved into external files or a per-request nonce, which
// is a larger refactor than this policy is worth blocking on. Everything
// else is locked down: no plugins/objects, no <base> tag hijacking, forms
// can only submit back to this origin, this site can't be framed by another
// origin, and mixed-content requests get upgraded to https once behind TLS.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  })
);

// Public form submissions carry a large nested clientInfo object (joint
// applicants, repeatable investment properties/loans/cards, etc.) — 100kb
// default is enough headroom for that while still bounding request size.
app.use(express.json({ limit: "512kb" }));
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

// Step 1 — client information form. Step 2 (document upload) is a separate
// page/URL, keyed by the draft submission's id, so a client always lands on
// a page that's unambiguously "just the form" or "just the documents".
app.get("/apply/:slug", (req, res) => {
  res.sendFile(path.join(APP_DIR, "public", "apply-form.html"));
});

app.get("/apply/:slug/upload/:id", (req, res) => {
  res.sendFile(path.join(APP_DIR, "public", "apply-upload.html"));
});

// No bare "/" landing page yet — send visitors to log in.
app.get("/", (req, res) => res.sendFile(path.join(APP_DIR, "public", "index.html")));

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
    // Always run a bcrypt compare, even for an email that doesn't exist —
    // otherwise a missing account short-circuits instantly while a real one
    // takes the full bcrypt round-trip, and that timing gap is enough to
    // enumerate registered emails from the response time alone.
    const match = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
    if (!user || !match) return res.status(401).json({ error: "Incorrect email or password." });

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

  // Respond immediately, before the (only-if-the-account-exists) DB write and
  // SMTP send below — otherwise a real, active account takes visibly longer
  // to respond than one that doesn't exist, and that timing gap is itself
  // enough to enumerate registered emails even though the JSON body never
  // reveals whether the email matched.
  res.json({ ok: true });

  try {
    const user = await db.getUserByEmail(email);
    if (user && user.status === "active") {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await db.createPasswordReset({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt,
      });
      await sendPasswordReset({ toEmail: email, resetUrl: `${APP_URL}/reset-password.html?token=${token}` });
    }
  } catch (err) {
    console.error("Failed to send password reset email:", err.message);
  }
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

// --- API: public two-step intake (draft -> upload docs -> finish) ------

function extractContact(clientInfo) {
  const personal = (clientInfo && clientInfo.personal) || {};
  // Surname is optional now that Last name exists as its own field — prefer
  // Last name when present, falling back to Surname for older submissions.
  const fullName = [personal.firstName, personal.lastName || personal.surname].filter(Boolean).join(" ").trim();
  return { fullName, email: personal.email || "", phone: personal.mobilePhone || "" };
}

// The public-facing shape never includes Cloudinary internals (publicId,
// resourceType, format) — a client only needs to see what they uploaded,
// not the storage details a signed download would require.
function publicFileMeta(entry) {
  const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
  return list.map((f) => ({ label: f.label, originalName: f.originalName, size: f.size, mime: f.mime }));
}

function submissionResponse(submission) {
  const files = {};
  for (const field of FILE_FIELDS) {
    if (submission.files && submission.files[field.name]) {
      files[field.name] = publicFileMeta(submission.files[field.name]);
    }
  }
  return {
    id: submission.id,
    fullName: submission.fullName,
    email: submission.email,
    status: submission.status,
    clientInfo: submission.clientInfo,
    files,
    finalized: submission.status !== "Draft",
    formProgress: computeFormProgress(submission.clientInfo),
    docProgress: computeDocProgress(submission.clientInfo, submission.files),
  };
}

// Step 1: create the draft from the client-information form (no files yet).
app.post(
  "/api/public/:slug/submissions",
  submitLimiter,
  asyncHandler(async (req, res) => {
    const company = await db.getCompanyBySlug(req.params.slug);
    if (!company || company.status !== "active") {
      return res.status(404).json({ error: "This application link is no longer valid." });
    }

    // Honeypot: hp_confirm is hidden from real clients via CSS and named
    // away from anything a browser's autofill would recognize (an earlier
    // version was named "company", which some browsers' address/business
    // autofill would actually fill in for a real visitor, wrongly tripping
    // this check and stranding them). Pretend to succeed rather than
    // telling a bot what tripped it.
    if (req.body.hp_confirm) {
      return res.status(201).json({ ok: true, id: randomUUID() });
    }

    const clientInfo = req.body.clientInfo || {};
    const { fullName, email, phone } = extractContact(clientInfo);
    if (!fullName || !email) {
      return res.status(400).json({ error: "First name, surname, and email are required." });
    }

    const pending = await db.getPendingSubmissionByEmail(company.id, email);
    if (pending) {
      return res.status(409).json({
        error: "You already have an application in progress with this email address. We'll be in touch soon — no need to submit again.",
      });
    }

    const now = new Date().toISOString();
    const submission = {
      id: randomUUID(),
      companyId: company.id,
      fullName,
      email,
      phone,
      files: {},
      clientInfo,
      status: "Draft",
      submittedAt: now,
      updatedAt: now,
    };
    await db.insertSubmission(submission);

    res.status(201).json({ id: submission.id });
  })
);

// Fetch a draft/submission's own data — used by the upload page and by the
// "edit your details" prefill flow on the form page.
app.get(
  "/api/public/:slug/submissions/:id",
  asyncHandler(async (req, res) => {
    const company = await db.getCompanyBySlug(req.params.slug);
    if (!company || company.status !== "active") return res.status(404).json({ error: "Not found" });
    const submission = await db.getSubmission(company.id, req.params.id);
    if (!submission) return res.status(404).json({ error: "Application not found." });
    res.json(submissionResponse(submission));
  })
);

// Step 1 (edit): update a draft's client-info answers before it's finalized.
app.patch(
  "/api/public/:slug/submissions/:id",
  draftActionLimiter,
  asyncHandler(async (req, res) => {
    const company = await db.getCompanyBySlug(req.params.slug);
    if (!company || company.status !== "active") return res.status(404).json({ error: "Not found" });
    const draft = await db.getDraftSubmission(company.id, req.params.id);
    if (!draft) return res.status(409).json({ error: "This application has already been submitted and can no longer be edited." });

    const clientInfo = req.body.clientInfo || {};
    const { fullName, email, phone } = extractContact(clientInfo);
    if (!fullName || !email) {
      return res.status(400).json({ error: "First name, surname, and email are required." });
    }

    const updated = await db.updateSubmissionClientInfo(company.id, req.params.id, { fullName, email, phone, clientInfo });
    res.json(submissionResponse(updated));
  })
);

// Step 2: upload one document. The multipart field is always named "file" —
// which document type it is comes from the :field URL segment, validated
// against the shared FILE_FIELDS list.
app.post(
  "/api/public/:slug/submissions/:id/files/:field",
  uploadLimiter,
  asyncHandler(async (req, res, next) => {
    const company = await db.getCompanyBySlug(req.params.slug);
    if (!company || company.status !== "active") return res.status(404).json({ error: "Not found" });
    const draft = await db.getDraftSubmission(company.id, req.params.id);
    if (!draft) return res.status(409).json({ error: "This application has already been submitted." });

    const field = FILE_FIELDS.find((f) => f.name === req.params.field);
    if (!field) return res.status(400).json({ error: "Unknown document type." });

    const currentCount = Array.isArray(draft.files[field.name]) ? draft.files[field.name].length : 0;
    if (currentCount >= field.maxCount) {
      return res.status(400).json({ error: `You can upload up to ${field.maxCount} files for ${field.label}.` });
    }

    req.company = company;
    req.field = field;
    next();
  }),
  useSubmissionIdParam,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file received." });

    const fileMeta = {
      label: req.field.label,
      originalName: req.file.originalname,
      publicId: req.file.publicId,
      resourceType: req.file.resourceType,
      format: req.file.format,
      size: req.file.size,
      mime: req.file.mimetype,
    };
    const updated = await db.appendSubmissionFile(req.company.id, req.params.id, req.field.name, fileMeta);
    res.status(201).json(submissionResponse(updated));
  })
);

// Step 2: remove one previously uploaded document (a client fixing a
// mis-upload) — mirrors the existing "remove slot" UX.
app.delete(
  "/api/public/:slug/submissions/:id/files/:field/:index",
  asyncHandler(async (req, res) => {
    const company = await db.getCompanyBySlug(req.params.slug);
    if (!company || company.status !== "active") return res.status(404).json({ error: "Not found" });
    const draft = await db.getDraftSubmission(company.id, req.params.id);
    if (!draft) return res.status(409).json({ error: "This application has already been submitted." });

    const { submission, removed } = await db.removeSubmissionFile(
      company.id,
      req.params.id,
      req.params.field,
      Number(req.params.index)
    );
    if (!removed) return res.status(404).json({ error: "File not found." });

    if (removed.publicId) {
      await cloudinary.uploader
        .destroy(removed.publicId, { resource_type: removed.resourceType, type: "authenticated" })
        .catch((err) => console.error("Failed to remove upload:", err.message));
    }

    res.json(submissionResponse(submission));
  })
);

// Step 2: finish — the same minimum the old one-shot submit enforced
// (driver's licence + passport present), then flips the draft into the
// normal review pipeline the dashboard already understands.
app.post(
  "/api/public/:slug/submissions/:id/finish",
  draftActionLimiter,
  asyncHandler(async (req, res) => {
    const company = await db.getCompanyBySlug(req.params.slug);
    if (!company || company.status !== "active") return res.status(404).json({ error: "Not found" });
    const draft = await db.getDraftSubmission(company.id, req.params.id);
    if (!draft) return res.status(409).json({ error: "This application has already been submitted." });

    const missing = REQUIRED_FILE_FIELDS.filter((name) => {
      const entry = draft.files[name];
      return !(Array.isArray(entry) && entry.length > 0);
    });
    if (missing.length) {
      return res.status(400).json({ error: "Please upload a valid Driver's Licence and Passport before finishing." });
    }

    const updated = await db.updateSubmissionStatus(company.id, req.params.id, "New");
    res.json({ ok: true, id: updated.id });
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
      formProgress: computeFormProgress(s.clientInfo),
      docProgress: computeDocProgress(s.clientInfo, s.files),
      submittedAt: s.submittedAt,
      updatedAt: s.updatedAt,
    }))
  );
}));

// Full detail for one submission
app.get("/api/submissions/:id", asyncHandler(async (req, res) => {
  const submission = await db.getSubmission(req.companyId, req.params.id);
  if (!submission) return res.status(404).json({ error: "Not found" });
  res.json({
    ...submission,
    formProgress: computeFormProgress(submission.clientInfo),
    docProgress: computeDocProgress(submission.clientInfo, submission.files),
  });
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

// Friendly text for multer's own error codes (file too large, wrong field,
// etc.) — without this they'd fall through to the generic 500 below, which
// looks like a broken upload rather than "that file's too big".
const MULTER_ERROR_MESSAGES = {
  LIMIT_FILE_SIZE: "That file is too large. Files must be 15MB or smaller.",
  LIMIT_UNEXPECTED_FILE: "Unexpected file field.",
};

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
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: MULTER_ERROR_MESSAGES[err.code] || "That file couldn't be uploaded. Please try a different file." });
  }
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

const readyPromise = db.initSchema().catch((err) => {
  console.error("Failed to initialize database:", err.message);
  throw err;
});

if (require.main === module) {
  // Run directly (npm start / node server.js): bind a real port for local dev
  // or a traditional host (Render, Railway, a VPS, etc.).
  readyPromise
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Docklio running at http://localhost:${PORT}`);
        console.log(`Sign up / log in:   http://localhost:${PORT}/login.html`);
        console.log(`Dashboard:          http://localhost:${PORT}/dashboard.html`);
      });
    })
    .catch(() => process.exit(1));
}

// Serverless entry point (Vercel): api/index.js requires this file instead of
// running it directly, so require.main !== module here and no port gets
// bound — Vercel's runtime calls this exported handler per request instead.
// Awaiting readyPromise makes the first (cold-start) request wait for the
// schema-init check; later warm invocations reuse the already-resolved promise.
module.exports = async (req, res) => {
  await readyPromise;
  app(req, res);
};
