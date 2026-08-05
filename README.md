# Docklio

A multi-tenant client onboarding platform: any number of companies can create their own account, each with an isolated dashboard, their own client-facing application link, and their own submissions. The intake form is a full financial fact-find — personal details, address, employment & income, additional income, real estate assets, other assets, liabilities, and document uploads. Companies review submissions, download a PDF of the full client form, download individual documents, track status, and email clients their application link directly from the dashboard.

## Requirements

- [Node.js](https://nodejs.org) 18 or later installed on your computer.
- A Postgres database (e.g. a free [Neon](https://neon.tech) project).

## Setup

1. Open a terminal in this folder.
2. Install dependencies:

   ```
   npm install
   ```

3. Create a `.env` file in this folder with:

   ```
   DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
   SESSION_SECRET=a-long-random-string

   CLOUDINARY_CLOUD_NAME=your-cloud-name
   CLOUDINARY_API_KEY=your-api-key
   CLOUDINARY_API_SECRET=your-api-secret

   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=you@gmail.com
   SMTP_PASSWORD=your-16-character-app-password
   APP_URL=http://localhost:3000
   ```

   `DATABASE_URL` is your Postgres connection string. `SESSION_SECRET` signs login sessions — any long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` generates one). `CLOUDINARY_*` is a free [Cloudinary](https://cloudinary.com) account — uploaded client documents (licences, passports, statements) stream straight there instead of local disk, so they survive redeploys/restarts even on hosts with ephemeral disks; find these three values on your Cloudinary dashboard home page after signing up. The `SMTP_*`/`APP_URL` vars power emailing clients their application link (see [Emailing clients](#emailing-clients) below) — leave them out if you don't need that yet. `.env` is already in `.gitignore` — never commit it.

4. Start the app:

   ```
   npm start
   ```

   On first run it creates all tables automatically (`companies`, `users`, `email_verifications`, `session`, `submissions`).

5. Open in your browser:

   - Sign up / log in: http://localhost:3000/login.html
   - Dashboard (after logging in): http://localhost:3000/dashboard.html

## How it works

- **Company accounts**: anyone can create an account at `/signup.html` (company name, work email, password). Disposable/throwaway email domains and domains with no valid mail server are rejected (`disposable-email-domains` package + a DNS MX-record check — see `isDisposableOrInvalidEmail()` in `server.js`). Signup sends a 6-digit code to the email via `mail.js`; entering it at `/verify.html` activates the account and logs them in. Login is a normal email/password form (`bcrypt`-hashed passwords, `express-session` with a Postgres-backed store via `connect-pg-simple`).
- **Isolation**: every company gets a unique slug (from its name) and its own application link at `/apply/:slug`. All submission data is scoped by `company_id` in Postgres — every query in `db.js` requires a `companyId` argument, so a route that forgets to scope a query fails loudly instead of silently leaking another company's data. A company can never see, download, or modify another company's submissions, documents, or PDFs, even by guessing IDs directly.
- **Clients** fill out the form at a company's `/apply/:slug` link — personal details, address (current + previous), employment & income (a dedicated PAYG block or a Self Employed block depending on employment type), additional income sources, real estate assets (existing home + any number of investment properties), other assets (description + value per asset type, plus multiple savings accounts), liabilities (multiple personal loans and credit cards), ongoing expenses (school fees, child care, insurances, etc.), and the required documents (driver's licence, passport, payslips, income proof, home loan/rental/council rates statements, tax return, liability statements — several accept multiple files, each starting with one upload slot and revealing another once filled). Scoped to a single applicant for now — no joint-applicant support yet.
- The structured form data is stored as JSON in Postgres (the `client_info` column), alongside plain columns for name/email/phone/status/company_id used by the dashboard table. Uploaded files stream directly to Cloudinary (folder `docklio/<submission-id>`, `type: authenticated`), with their metadata (an array per document field, supporting multiple files) stored in Postgres.
- The dashboard at `/dashboard.html` shows only the logged-in company's submissions, with quick stats, a "Send application link to a client" box (also shows the direct `/apply/:slug` link with a copy button), a client-name search box, and a table where clicking a row opens the full detail — broken into the same sections as the intake form, a **Download Client Form (PDF)** button, individual document blocks (each with its own heading and download link), and a status control (New / In Review / Approved / Rejected).
- `pdf.js` generates the client-form PDF on demand (via `pdfkit`) — no data is pre-rendered or cached.
- `seed-company.js` was a one-time script used to migrate the original single-tenant deployment into the first company account ("Burj"). `migrate-data.js` was an earlier one-time script that moved data from a pre-Postgres JSON-file format. Neither needs to be run again in normal use.

## Abuse protection

- **Rate limiting**: an IP can submit at most 5 applications per hour per company (`submitLimiter`), signup is capped at 5/hour/IP (`signupLimiter`), login attempts at 20/15min/IP (`loginLimiter`), verification-code attempts at 10/hour/IP plus a 5-wrong-guess lock per code (`verifyLimiter` + the `attempts` column), and the general authenticated dashboard API surface at 300/15min/IP (`apiLimiter`, a basic abuse ceiling — not a brute-force guard, since those routes already require a valid session).
- **Honeypot field**: the intake form has a hidden `company` field real clients never see or fill in. If it's filled, the submission is silently discarded (the client still sees a normal success message, so bots aren't tipped off).
- **Duplicate detection**: if an email already has a submission with status New or In Review *for that company*, a new submission from that email is rejected with a friendly message instead of creating another row. Once that submission is Approved or Rejected, the same email can submit again.
- **Signup validation**: disposable email domains and domains with no MX record are rejected; passwords must be 8+ characters; duplicate account emails are rejected.

## Emailing clients

The dashboard's **"Send application link to a client"** box emails them a link to that company's own `/apply/:slug` — no copy-pasting URLs. This uses your own email account via SMTP (Gmail shown here; Outlook/Office 365 and other providers work too with different `SMTP_HOST`/`SMTP_PORT` values — Office 365 is `smtp.office365.com:587` and needs "Authenticated SMTP" enabled on the mailbox, which is off by default on many business tenants):

1. Turn on 2-Step Verification on the Google account you want to send from (Google Account → Security).
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create an app password, and copy the 16-character code it gives you.
3. In `.env`, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` (the app password, not your normal one), and `APP_URL` (update to your real deployed URL once hosted).
4. Restart the app. Each company's emails show that company's own name as the sender display name (from the `companies.business_name` column, editable per-company), sent through the one shared SMTP account.

If `SMTP_*` isn't set, signup/invite emails just fail with a clear error (signup still succeeds — the account isn't lost, the code can be resent later once SMTP is fixed) — nothing else breaks.

## Deploying

While `npm start` is running on your machine, everything only works on `localhost`. To let real companies and their clients use this from anywhere, deploy to a host (e.g. Render, Railway, Fly.io, a VPS):

- **Render**: this repo includes a `render.yaml` Blueprint. On [render.com](https://render.com), New → Blueprint → select this repo, and Render provisions the web service and prompts for each env var below automatically.
- Set `DATABASE_URL`, `SESSION_SECRET`, `CLOUDINARY_*`, and the `SMTP_*`/`APP_URL` vars in the host's environment variable settings (not in the code).
- Submission, company, and user data all live in Postgres, and uploaded documents live in Cloudinary — nothing is written to local disk, so no persistent disk/volume is needed even on hosts with ephemeral storage (e.g. a free tier).
- Set `NODE_ENV=production` so session cookies are marked `secure` (HTTPS-only).

## Customizing

- **Form fields**: edit `public/index.html` (the `<form>` and the `buildClientInfo()` function that assembles the submitted JSON). The dashboard's detail view (`renderSections()` in `public/dashboard.html`) and the PDF (`pdf.js`) both read from that same `clientInfo` shape, so add matching sections in both when you add fields.
- **Document types**: change the `FILE_FIELDS` array near the top of `server.js` (each entry's `maxCount` controls how many files that field accepts), and update the matching upload boxes in `public/index.html`.
- **Branding**: colors and layout live in `public/style.css` (see the `:root` variables at the top for the color palette). Per-company branding (name shown to clients, sender name in emails) lives in the `companies` table (`business_name`, `sender_name` columns) — there's no settings UI for these yet, they're set from the company name at signup.
- **Statuses**: the four statuses (New/In Review/Approved/Rejected) are defined in `server.js` (`PATCH /api/submissions/:id`) and `public/dashboard.html`.

## Known limitations (things to add before real client data goes through it)

- **No HTTPS locally** — set this up behind a reverse proxy (e.g. Caddy, Nginx, or your host's built-in TLS) before handling sensitive documents over the internet; `NODE_ENV=production` handles the cookie side once you do.
- **Uploaded documents are stored in Cloudinary** under `type: authenticated`, so they're not publicly reachable by URL guessing — every download is a short-lived signed link generated only after a company logs in. Encryption at rest is handled by Cloudinary's infrastructure, not this app.
- **No e-signature** — not included in this version.
- **No billing** — company accounts are free/unlimited right now; there's no subscription/payment layer yet (planned as a future addition on top of the `companies` table).
- **Single applicant per submission** — no joint-applicant support yet.
- **No company settings UI** — business name/sender name/password changes currently require direct database access.
