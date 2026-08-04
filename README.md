# Mystro Lite

A self-hosted client onboarding tool: a client-facing intake form (a full financial fact-find — personal details, address, employment & income, additional income, real estate assets, other assets, liabilities, and document uploads) and a dashboard to review submissions, download a PDF of the full client form, download individual documents, and track status.

## Requirements

- [Node.js](https://nodejs.org) 18 or later installed on your computer.
- A Postgres database (e.g. a free [Neon](https://neon.tech) project) — submissions are stored there.

## Setup

1. Open a terminal in this folder.
2. Install dependencies:

   ```
   npm install
   ```

3. Create a `.env` file in this folder with:

   ```
   DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
   DASHBOARD_USER=admin
   DASHBOARD_PASSWORD=choose-a-strong-password
   ```

   `DATABASE_URL` is your Postgres connection string. `DASHBOARD_USER`/`DASHBOARD_PASSWORD` are required — without them, anyone can view client submissions. `.env` is already in `.gitignore` — never commit it.

4. Start the app:

   ```
   npm start
   ```

   On first run it creates the `submissions` table automatically.

5. Open in your browser:

   - Client intake form: http://localhost:3000/
   - Dashboard: http://localhost:3000/dashboard.html

## How it works

- Clients fill out the form at `/` — personal details, address (current + previous), employment & income, additional income sources, real estate assets (existing home + any number of investment properties), other assets (including multiple savings accounts), liabilities (multiple personal loans and credit cards), plus up to four document uploads (photo ID, proof of income, bank statement, proof of address). Scoped to a single applicant for now — no joint-applicant support yet.
- The structured form data is stored as JSON in Postgres (the `client_info` column — see `db.js`), alongside plain columns for name/email/phone/status used by the dashboard table. Uploaded files are saved under `data/uploads/<submission-id>/` on disk, with their metadata stored in Postgres.
- The dashboard at `/dashboard.html` lists all submissions with quick stats, and clicking a row opens the full detail broken into the same sections as the intake form, a **Download Client Form (PDF)** button that generates a formatted PDF of everything, individual document blocks (each with its own heading and download link), and a status control (New / In Review / Approved / Rejected).
- `pdf.js` generates the client-form PDF on demand (via `pdfkit`) — no data is pre-rendered or cached.
- `migrate-data.js` is a one-time script used to move data from the old `data/submissions.json` file format into Postgres — you shouldn't need to run it again unless restoring from an old backup.

## Sharing the form with clients

While `npm start` is running on your machine, the form only works on `localhost`. To let real clients submit from anywhere, deploy this app to a host (e.g. Render, Railway, Fly.io, a VPS) and share that public URL instead of `localhost:3000`.

- Set `DATABASE_URL`, `DASHBOARD_USER`, and `DASHBOARD_PASSWORD` in the host's environment variable settings (not in the code) so the dashboard is password-protected in production too.
- Submission data itself now lives in Postgres, so it survives redeploys regardless of the host's disk. Uploaded **documents** are still saved to local disk under `data/uploads/`, so the host still needs a **persistent disk/volume** mounted there — otherwise document files (though not the submission records) are lost on restart/redeploy.

## Customizing

- **Form fields**: edit `public/index.html` (the `<form>` and the `buildClientInfo()` function that assembles the submitted JSON). The dashboard's detail view (`renderSections()` in `public/dashboard.html`) and the PDF (`pdf.js`) both read from that same `clientInfo` shape, so add matching sections in both when you add fields.
- **Document types**: change the `FILE_FIELDS` array near the top of `server.js`, and update the matching upload boxes in `public/index.html`.
- **Branding**: colors and layout live in `public/style.css` (see the `:root` variables at the top for the color palette).
- **Statuses**: the four statuses (New/In Review/Approved/Rejected) are defined in `server.js` (`PATCH /api/submissions/:id`) and `public/dashboard.html`.

## Known limitations (things to add before real client data goes through it)

- **No HTTPS** — set this up behind a reverse proxy (e.g. Caddy, Nginx, or your host's built-in TLS) before handling sensitive documents over the internet.
- **No encryption at rest** — uploaded documents are stored as plain files. If you're handling regulated financial data, consider encrypting the `data/` volume or moving uploads to encrypted cloud storage (S3 with SSE, etc.).
- **No e-signature** — not included in this version; can be added later if needed.
