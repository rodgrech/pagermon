var logger = require('../log');

async function run(trigger, scope, data, config, callback) {
  var tConf = data.pluginconf.Telegram;
  if (!tConf || !tConf.enable) return callback();
  if (!tConf.chat) {
    logger.main.error('Telegram: ' + data.address + ' No ChatID key set. Please enter ChatID.');
    return callback();
  }
  try {
    var response = await fetch('https://api.telegram.org/bot' + encodeURIComponent(config.teleAPIKEY) + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: tConf.chat, text: '*' + data.agency + ' - ' + data.alias + '*\nMessage: ' + data.message, parse_mode: 'Markdown' })
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text());
    logger.main.debug('Telegram: message sent');
  } catch (err) {
    logger.main.error('Telegram: ' + err);
  }
  callback();
}

module.exports = { run: run };
