const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const configPath = path.resolve(__dirname, '../config/config.json');
const temporaryPath = configPath + '.web-push-new';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.notifications = config.notifications || {};
config.notifications.webPush = config.notifications.webPush || {};

if (!config.notifications.webPush.publicKey || !config.notifications.webPush.privateKey) {
  const keys = webpush.generateVAPIDKeys();
  config.notifications.webPush.publicKey = keys.publicKey;
  config.notifications.webPush.privateKey = keys.privateKey;
}

config.notifications.webPush.enabled = true;
config.notifications.webPush.subject = process.argv[2] || config.notifications.webPush.subject || 'mailto:admin@localhost';
fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2), {mode: 0o600});
fs.renameSync(temporaryPath, configPath);
console.log('Web Push configured and enabled.');
