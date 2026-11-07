const fs = require('fs');
const path = require('path');
const nconf = require('nconf');
const logger = require('../log');
const webPush = require('./webPush');

function start() {
  const configDir = path.dirname(fs.realpathSync('./config/config.json'));
  const healthFile = path.join(configDir, 'decoder-health.json');
  const stateFile = path.join(configDir, 'system-message-state.json');
  let lastErrorAt = 0;
  let sending = false;
  try {
    lastErrorAt = Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastErrorAt) || 0;
  } catch (error) {
    if (error.code !== 'ENOENT') logger.main.warn('Unable to read system message state: ' + error.message);
  }

  function check() {
    if (sending) return;
    nconf.load();
    if (!nconf.get('notifications:systemMessages:enabled')) return;
    let health;
    try {
      health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') logger.main.warn('Unable to read decoder health for push: ' + error.message);
      return;
    }
    const errorAt = Number(health.errorAt) || 0;
    if (!errorAt || errorAt <= lastErrorAt) return;
    // Do not notify about an old error if the feature was enabled later.
    if (Date.now() / 1000 - errorAt > 3600) {
      lastErrorAt = errorAt;
      return;
    }
    sending = true;
    webPush.sendSystemMessage('Pager decoder USB error', 'The receiver reported a USB transfer error. Automatic recovery will restart it after 30 seconds.', '/service-status', 'system-decoder-' + errorAt)
      .then(function () {
        lastErrorAt = errorAt;
        fs.writeFileSync(stateFile + '.tmp', JSON.stringify({lastErrorAt: errorAt}) + '\n', {mode: 0o600});
        fs.renameSync(stateFile + '.tmp', stateFile);
      })
      .catch(function (error) { logger.main.error('Unable to send decoder system push: ' + error.message); })
      .finally(function () { sending = false; });
  }

  check();
  const timer = setInterval(check, 15000);
  if (timer.unref) timer.unref();
}

module.exports = {start};
