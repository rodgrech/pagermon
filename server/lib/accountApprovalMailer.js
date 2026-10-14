const nodemailer = require('nodemailer');
const nconf = require('nconf');
const logger = require('../log');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function settings() {
  nconf.load();
  return {
    enabled: Boolean(nconf.get('auth:approvalEmailsEnabled')),
    admins: String(nconf.get('auth:approvalAdminRecipients') || '').trim(),
    siteName: nconf.get('global:monitorName') || 'PagerMon',
    smtp: nconf.get('plugins:SMTP') || {}
  };
}

function transporterFor(smtp) {
  if (!smtp.server || !smtp.port || !smtp.mailFrom) return null;
  const options = {
    host: smtp.server,
    port: Number(smtp.port),
    secure: Boolean(smtp.secure),
    tls: { rejectUnauthorized: smtp.rejectUnauthorized !== false }
  };
  if (smtp.username) options.auth = { user: smtp.username, pass: smtp.password || '' };
  return nodemailer.createTransport(options);
}

function send(to, subject, text, html) {
  const config = settings();
  if (!config.enabled || !to) return Promise.resolve({ skipped: true });
  const transporter = transporterFor(config.smtp);
  if (!transporter) {
    logger.auth.warn('Approval email skipped: SMTP plugin settings are incomplete');
    return Promise.resolve({ skipped: true });
  }
  const fromName = config.smtp.mailFromName || config.siteName;
  return transporter.sendMail({
    from: `"${fromName}" <${config.smtp.mailFrom}>`,
    to: to,
    subject: subject,
    text: text,
    html: html
  }).then(function (info) {
    logger.auth.info('Approval email sent: ' + info.messageId);
    return info;
  }).catch(function (error) {
    logger.auth.error('Approval email failed: ' + error.message);
    return { error: error.message };
  });
}

function applicantName(user) {
  return String(user.givenname || user.username || 'there').trim();
}

function registrationReceived(user) {
  const config = settings();
  const name = applicantName(user);
  const subject = `${config.siteName}: application received`;
  const text = `Hi ${name},\n\nWe have received your account application for ${config.siteName}. It is awaiting administrator approval. We will email you when a decision has been made.\n`;
  return send(user.email, subject, text, `<p>Hi ${escapeHtml(name)},</p><p>We have received your account application for <strong>${escapeHtml(config.siteName)}</strong>. It is awaiting administrator approval.</p><p>We will email you when a decision has been made.</p>`);
}

function adminApprovalNeeded(user) {
  const config = settings();
  const subject = `${config.siteName}: new user awaiting approval`;
  const identity = `${user.givenname || ''} ${user.surname || ''}`.trim() || user.username;
  const text = `A new user is awaiting approval.\n\nName: ${identity}\nUsername: ${user.username}\nEmail: ${user.email}\n\nOpen Admin > Users to review the application.\n`;
  return send(config.admins, subject, text, `<p>A new user is awaiting approval.</p><dl><dt>Name</dt><dd>${escapeHtml(identity)}</dd><dt>Username</dt><dd>${escapeHtml(user.username)}</dd><dt>Email</dt><dd>${escapeHtml(user.email)}</dd></dl><p>Open <strong>Admin &gt; Users</strong> to review the application.</p>`);
}

function approved(user) {
  const config = settings();
  const name = applicantName(user);
  const subject = `${config.siteName}: application approved`;
  const text = `Hi ${name},\n\nYour account application for ${config.siteName} has been approved. You can now sign in.\n`;
  return send(user.email, subject, text, `<p>Hi ${escapeHtml(name)},</p><p>Your account application for <strong>${escapeHtml(config.siteName)}</strong> has been approved. You can now sign in.</p>`);
}

function denied(user, reason) {
  const config = settings();
  const name = applicantName(user);
  const subject = `${config.siteName}: application not approved`;
  const text = `Hi ${name},\n\nYour account application for ${config.siteName} was not approved.\n\nReason: ${reason}\n`;
  return send(user.email, subject, text, `<p>Hi ${escapeHtml(name)},</p><p>Your account application for <strong>${escapeHtml(config.siteName)}</strong> was not approved.</p><p><strong>Reason:</strong><br>${escapeHtml(reason).replace(/\n/g, '<br>')}</p>`);
}

module.exports = { registrationReceived, adminApprovalNeeded, approved, denied };
