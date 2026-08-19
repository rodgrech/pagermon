var logger = require('../log');

async function run(trigger, scope, data, config, callback) {
  var pConf = data.pluginconf.Prowl;
  if (!pConf || !pConf.enable) return callback();
  if (!pConf.group || pConf.group === '0') {
    logger.main.error('Prowl: ' + data.address + ' No User/Group key set. Please enter User/Group Key.');
    return callback();
  }
  var payload = new URLSearchParams({ apikey: pConf.group, application: config.application, event: data.agency + ' - ' + data.alias, description: data.message + ' \nTime: ' + new Date().toLocaleString() });
  if (pConf.url) payload.set('url', pConf.url);
  if (pConf.providerkey) payload.set('providerkey', pConf.providerkey);
  if (pConf.priority !== undefined) payload.set('priority', pConf.priority.value !== undefined ? pConf.priority.value : pConf.priority);
  try {
    var response = await fetch('https://api.prowlapp.com/publicapi/add', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: payload });
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text());
    logger.main.debug('Prowl: message sent');
  } catch (err) {
    logger.main.error('Prowl: ' + err);
  }
  callback();
}

module.exports = { run: run };
