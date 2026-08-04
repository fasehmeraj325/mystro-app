const nodemailer = require("nodemailer");

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Mystro Lite";
const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD) {
    throw new Error(
      "Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD in .env."
    );
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

async function sendClientInvite({ toEmail, toName }) {
  const transporter = getTransporter();
  const greeting = toName ? `Hi ${toName},` : "Hi,";

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #1a1d29;">
      <p style="font-size:15px;">${greeting}</p>
      <p style="font-size:15px; line-height:1.5;">
        Please complete your application with ${BUSINESS_NAME} using the secure link below.
        It takes about 5 minutes and lets you upload your documents directly.
      </p>
      <p style="margin: 28px 0;">
        <a href="${APP_URL}/" style="background:#3a3aff; color:#fff; text-decoration:none; padding:12px 22px; border-radius:8px; font-weight:600; font-size:15px; display:inline-block;">
          Start my application
        </a>
      </p>
      <p style="font-size:13px; color:#6b7080;">
        If the button doesn't work, copy and paste this link into your browser:<br />
        <a href="${APP_URL}/" style="color:#3a3aff;">${APP_URL}/</a>
      </p>
      <p style="font-size:15px; margin-top:28px;">Thanks,<br />${BUSINESS_NAME}</p>
    </div>
  `;

  const text = `${greeting}\n\nPlease complete your application with ${BUSINESS_NAME} using the link below. It takes about 5 minutes.\n\n${APP_URL}/\n\nThanks,\n${BUSINESS_NAME}`;

  await transporter.sendMail({
    from: `"${BUSINESS_NAME}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Complete your application — ${BUSINESS_NAME}`,
    text,
    html,
  });
}

module.exports = { sendClientInvite };
