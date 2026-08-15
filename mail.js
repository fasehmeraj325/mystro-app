const nodemailer = require("nodemailer");

// A bare domain (no http(s):// prefix) here isn't just cosmetic — every link
// built from APP_URL (invite emails, "share your link", the notification
// email, password reset) becomes a *relative* URL instead of absolute, so
// clicking one from within the app doubles the current page's origin into
// the path (e.g. yourapp.com/yourapp.com/apply/slug, 404). Default the
// scheme to https rather than fail outright, since a bare domain almost
// always means someone pasted just the host into the env var.
function normalizeAppUrl(raw) {
  const trimmed = (raw || "http://localhost:3000").trim().replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
const APP_URL = normalizeAppUrl(process.env.APP_URL);
const PLATFORM_NAME = "Docklio";

// businessName/senderName/toName are company-entered text (signup form, invite
// form) reaching an HTML email template — escape before interpolating so a
// company name like "<img onerror=...>" can't inject markup into an email
// sent to their own clients.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD) {
    throw new Error(
      "Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD in .env."
    );
  }
  const port = Number(SMTP_PORT);
  const isImplicitTls = port === 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: isImplicitTls,
    // Port 587 (Office 365, and most providers other than Gmail's 465) uses
    // STARTTLS instead of implicit TLS — require it rather than negotiating
    // silently, so a misconfigured server fails loudly instead of sending
    // over an unencrypted connection.
    requireTLS: !isImplicitTls,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

// toEmail/toName: the client being invited. businessName/senderName: the
// tenant company's branding (from the companies table). applyUrl: the
// company's own /apply/:slug link.
async function sendClientInvite({ toEmail, toName, businessName, senderName, applyUrl }) {
  const transporter = getTransporter();
  const safeName = escapeHtml(businessName);
  const safeSender = escapeHtml(senderName);
  const greetingText = toName ? `Hi ${toName},` : "Hi there,";
  const greeting = toName ? `Hi ${escapeHtml(toName)},` : "Hi there,";
  const signOff = senderName ? `${safeSender}<br />${safeName}` : safeName;
  const signOffText = senderName ? `${senderName}\n${businessName}` : businessName;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; color: #1a1d29;">
      <p style="font-size:15px;">${greeting}</p>

      <p style="font-size:15px; line-height:1.6;">
        Thank you for choosing ${safeName} for your application. To get started, please complete
        our secure online client information form — it covers your personal details, employment and
        income, assets, and liabilities, and lets you upload your supporting documents directly.
      </p>

      <p style="font-size:15px; line-height:1.6;">
        It takes about 10&ndash;15 minutes. You can save time by having your ID, recent payslips, and
        bank statements on hand before you start.
      </p>

      <p style="margin: 28px 0;">
        <a href="${applyUrl}" style="background:#3a3aff; color:#fff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600; font-size:15px; display:inline-block;">
          Start my application
        </a>
      </p>

      <p style="font-size:13px; color:#6b7080; line-height:1.5;">
        If the button above doesn't work, copy and paste this link into your browser:<br />
        <a href="${applyUrl}" style="color:#3a3aff;">${applyUrl}</a>
      </p>

      <p style="font-size:15px; line-height:1.6;">
        This link is unique to your application and your information is submitted securely. If you have
        any questions along the way, just reply to this email and we'll be happy to help.
      </p>

      <p style="font-size:15px; margin-top:28px;">
        Kind regards,<br />${signOff}
      </p>
    </div>
  `;

  const text = [
    greetingText,
    "",
    `Thank you for choosing ${businessName} for your application. To get started, please complete our secure online client information form — it covers your personal details, employment and income, assets, and liabilities, and lets you upload your supporting documents directly.`,
    "",
    "It takes about 10-15 minutes. You can save time by having your ID, recent payslips, and bank statements on hand before you start.",
    "",
    applyUrl,
    "",
    "If you have any questions along the way, just reply to this email and we'll be happy to help.",
    "",
    "Kind regards,",
    signOffText,
  ].join("\n");

  await transporter.sendMail({
    from: `"${businessName}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Your ${businessName} application — complete your details online`,
    text,
    html,
  });
}

// Signup email-verification code, sent from the platform itself (not a
// tenant company) since the company doesn't exist/isn't verified yet.
async function sendVerificationCode({ toEmail, code }) {
  const transporter = getTransporter();

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1d29;">
      <p style="font-size:15px;">Welcome to ${PLATFORM_NAME},</p>
      <p style="font-size:15px; line-height:1.6;">
        Use this code to verify your email address and finish creating your account:
      </p>
      <p style="font-size:32px; font-weight:700; letter-spacing:6px; margin:28px 0; color:#3a3aff;">${code}</p>
      <p style="font-size:13px; color:#6b7080;">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
    </div>
  `;

  const text = `Welcome to ${PLATFORM_NAME}.\n\nUse this code to verify your email address: ${code}\n\nThis code expires in 15 minutes. If you didn't request this, you can ignore this email.`;

  await transporter.sendMail({
    from: `"${PLATFORM_NAME}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `${code} is your ${PLATFORM_NAME} verification code`,
    text,
    html,
  });
}

// Password-reset link, sent from the platform itself (not a tenant company).
async function sendPasswordReset({ toEmail, resetUrl }) {
  const transporter = getTransporter();

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1d29;">
      <p style="font-size:15px;">Hi there,</p>
      <p style="font-size:15px; line-height:1.6;">
        We received a request to reset your ${PLATFORM_NAME} password. Click below to choose a new one:
      </p>
      <p style="margin: 28px 0;">
        <a href="${resetUrl}" style="background:#3a3aff; color:#fff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600; font-size:15px; display:inline-block;">
          Reset my password
        </a>
      </p>
      <p style="font-size:13px; color:#6b7080; line-height:1.5;">
        If the button above doesn't work, copy and paste this link into your browser:<br />
        <a href="${resetUrl}" style="color:#3a3aff;">${resetUrl}</a>
      </p>
      <p style="font-size:13px; color:#6b7080;">This link expires in 30 minutes. If you didn't request this, you can ignore this email — your password won't be changed.</p>
    </div>
  `;

  const text = [
    "Hi there,",
    "",
    `We received a request to reset your ${PLATFORM_NAME} password. Use this link to choose a new one:`,
    "",
    resetUrl,
    "",
    "This link expires in 30 minutes. If you didn't request this, you can ignore this email — your password won't be changed.",
  ].join("\n");

  await transporter.sendMail({
    from: `"${PLATFORM_NAME}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Reset your ${PLATFORM_NAME} password`,
    text,
    html,
  });
}

// Sent to the company's own admin(s) when a client finishes an application —
// so they don't have to keep refreshing the dashboard to notice new leads.
// flaggedDocs (optional): plain-text notes from the document sanity-check
// (e.g. "Driver's Licence: image looks blurry") to surface right in the
// email instead of only after opening the dashboard.
async function sendNewApplicationNotification({ toEmail, businessName, clientName, clientEmail, dashboardUrl, flaggedDocs }) {
  const transporter = getTransporter();
  const safeClientName = escapeHtml(clientName);
  const safeClientEmail = escapeHtml(clientEmail);

  const flagsHtml =
    flaggedDocs && flaggedDocs.length
      ? `
      <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:14px 16px; margin:20px 0;">
        <p style="margin:0 0 6px; font-size:13px; font-weight:700; color:#92400e;">Worth a look before you review:</p>
        <ul style="margin:0; padding-left:18px; font-size:13px; color:#92400e;">
          ${flaggedDocs.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}
        </ul>
      </div>`
      : "";
  const flagsText = flaggedDocs && flaggedDocs.length ? `\nWorth a look before you review:\n${flaggedDocs.map((f) => `- ${f}`).join("\n")}\n` : "";

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; color: #1a1d29;">
      <p style="font-size:15px;">Hi,</p>
      <p style="font-size:15px; line-height:1.6;">
        <strong>${safeClientName}</strong> (${safeClientEmail}) just finished their application to ${escapeHtml(businessName)}.
      </p>
      ${flagsHtml}
      <p style="margin: 28px 0;">
        <a href="${dashboardUrl}" style="background:#3a3aff; color:#fff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600; font-size:15px; display:inline-block;">
          View application
        </a>
      </p>
      <p style="font-size:13px; color:#6b7080; line-height:1.5;">
        If the button above doesn't work, copy and paste this link into your browser:<br />
        <a href="${dashboardUrl}" style="color:#3a3aff;">${dashboardUrl}</a>
      </p>
    </div>
  `;

  const text = [
    "Hi,",
    "",
    `${clientName} (${clientEmail}) just finished their application to ${businessName}.`,
    flagsText,
    dashboardUrl,
  ].join("\n");

  await transporter.sendMail({
    from: `"${PLATFORM_NAME}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `New application from ${clientName}`,
    text,
    html,
  });
}

module.exports = { sendClientInvite, sendVerificationCode, sendPasswordReset, sendNewApplicationNotification, APP_URL };
