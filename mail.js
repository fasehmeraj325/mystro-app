const nodemailer = require("nodemailer");

const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const PLATFORM_NAME = "Mystro Lite";

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
  const greeting = toName ? `Hi ${toName},` : "Hi there,";
  const signOff = senderName ? `${senderName}<br />${businessName}` : businessName;
  const signOffText = senderName ? `${senderName}\n${businessName}` : businessName;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; color: #1a1d29;">
      <p style="font-size:15px;">${greeting}</p>

      <p style="font-size:15px; line-height:1.6;">
        Thank you for choosing ${businessName} for your application. To get started, please complete
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
    greeting,
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

module.exports = { sendClientInvite, sendVerificationCode, APP_URL };
