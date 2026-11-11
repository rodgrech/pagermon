const nodemailer = require('nodemailer');
const nconf = require('nconf');
const logger = require('../log');

function configured() {
  nconf.load();
  const smtp = nconf.get('plugins:SMTP') || {};
  const baseUrl = String(nconf.get('auth:passwordResetBaseUrl') || '').trim().replace(/\/$/, '');
  return Boolean(nconf.get('auth:passwordResetEnabled') && /^https:\/\/[^/]+$/i.test(baseUrl) && smtp.server && smtp.port && smtp.mailFrom);
}

function send(user, token) {
  if (!configured()) return Promise.resolve(false);
  const smtp = nconf.get('plugins:SMTP');
  const baseUrl = String(nconf.get('auth:passwordResetBaseUrl')).trim().replace(/\/$/, '');
  const link = baseUrl + '/auth/password-reset/' + encodeURIComponent(token);
  const siteName = String(nconf.get('global:monitorName') || 'PagerMon');
  const transportOptions = {
    host: smtp.server, port: Number(smtp.port), secure: Boolean(smtp.secure),
    tls: {rejectUnauthorized: smtp.rejectUnauthorized !== false}
  };
  if (smtp.username) transportOptions.auth = {user: smtp.username, pass: smtp.password || ''};
  const transporter = nodemailer.createTransport(transportOptions);
  return transporter.sendMail({
    from: {name: smtp.mailFromName || siteName, address: smtp.mailFrom},
    to: user.email,
    subject: siteName + ': password reset',
    text: 'A password reset was requested for your ' + siteName + ' account.\n\nOpen this link within 30 minutes: ' + link + '\n\nIf you did not request this, you can ignore this email.\n'
  }).then(function() { return true; }).catch(function(error) {
    logger.auth.error('Password reset email failed: ' + error.message);
    return false;
  });
}

module.exports = {configured, send};
