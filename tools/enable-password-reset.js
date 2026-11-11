#!/usr/bin/env node
// One-time instance configuration after SMTP has been set up.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const baseUrl = String(process.argv[3] || '').replace(/\/$/, '');
if (!file || !/^https:\/\/[^/]+$/i.test(baseUrl)) {
  throw new Error('Usage: node enable-password-reset.js /path/to/config.json https://public.example.com');
}
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const smtp = config.plugins && config.plugins.SMTP;
if (!smtp || !smtp.server || !smtp.port || !smtp.mailFrom) throw new Error('SMTP must be configured first');
config.auth = config.auth || {};
config.auth.passwordResetEnabled = true;
config.auth.passwordResetBaseUrl = baseUrl;
const temporary = path.join(path.dirname(file), '.password-reset-config-' + process.pid + '.json');
fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', {mode: fs.statSync(file).mode});
fs.renameSync(temporary, file);
console.log('Self-service password reset enabled.');
