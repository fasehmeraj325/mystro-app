# Mystro Lite

A self-hosted client onboarding tool: a client-facing intake form (contact info, financial details, document uploads) and a dashboard to review submissions, download documents, and track status.

## Requirements

- [Node.js](https://nodejs.org) 18 or later installed on your computer.

## Setup

1. Open a terminal in this folder.
2. Install dependencies:

   ```
   npm install
   ```

3. Set a dashboard password (required — without it, anyone can view client submissions):

   ```
   export DASHBOARD_USER=admin
   export DASHBOARD_PASSWORD=choose-a-strong-password
   ```

4. Start the app:

   ```
   npm start
   ```

5. Open in your browser:

   - Client intake form: http://localhost:3000/
   - Dashboard: http://localhost:3000/dashboard.html

## How it works

- Clients fill out the form at `/` — name, contact info, employment/income, loan amount and purpose, plus up to four document uploads (photo ID, proof of income, bank statement, proof of address).
- Every submission is saved to `data/submissions.json`; uploaded files are saved under `data/uploads/<submission-id>/`.
- The dashboard at `/dashboard.html` lists all submissions with quick stats, and clicking a row opens the full detail with document downloads and a status control (New / In Review / Approved / Rejected).
- No database server needed — everything is stored as plain files, so you can back it up by copying the `data/` folder.

## Sharing the form with clients

While `npm start` is running on your machine, the form only works on `localhost`. To let real clients submit from anywhere, deploy this app to a host (e.g. Render, Railway, Fly.io, a VPS) and share that public URL instead of `localhost:3000`.

- Set `DASHBOARD_USER` and `DASHBOARD_PASSWORD` in the host's environment variable settings (not in the code) so the dashboard is password-protected in production too.
- Make sure the host gives the app a **persistent disk/volume** mounted so it includes the `data/` folder. Submissions and uploaded documents are stored as files on disk — if the host's filesystem is ephemeral (wiped on every restart/redeploy), you'll lose client data.

## Customizing

- **Form fields**: edit `public/index.html` (the `<form>`) and the matching handling in `server.js` (`/api/submit`).
- **Document types**: change the `FILE_FIELDS` array near the top of `server.js`, and update the matching upload boxes in `public/index.html`.
- **Branding**: colors and layout live in `public/style.css` (see the `:root` variables at the top for the color palette).
- **Statuses**: the four statuses (New/In Review/Approved/Rejected) are defined in `server.js` (`PATCH /api/submissions/:id`) and `public/dashboard.html`.

## Known limitations (things to add before real client data goes through it)

- **No HTTPS** — set this up behind a reverse proxy (e.g. Caddy, Nginx, or your host's built-in TLS) before handling sensitive documents over the internet.
- **No encryption at rest** — uploaded documents are stored as plain files. If you're handling regulated financial data, consider encrypting the `data/` volume or moving uploads to encrypted cloud storage (S3 with SSE, etc.).
- **No e-signature** — not included in this version; can be added later if needed.
