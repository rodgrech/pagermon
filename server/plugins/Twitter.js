var TwitterApi = require('twitter-api-v2').TwitterApi;
var logger = require('../log');

async function run(trigger, scope, data, config, callback) {
  var tConf = data.pluginconf.Twitter;
  if (!tConf || !tConf.enable) return callback();
  if (!config.consKey || !config.consSecret || !config.accToken || !config.accSecret) {
    logger.main.error('Twitter: ' + data.address + ' No API keys set. Please check API keys.');
    return callback();
  }
  var text = data.agency + ' - ' + data.alias + '\n' + data.message + '\n' + (tConf.hashtag || '') + ' ' + (config.globalHashtags || '');
  try {
    var client = new TwitterApi({ appKey: config.consKey, appSecret: config.consSecret, accessToken: config.accToken, accessSecret: config.accSecret });
    await client.v2.tweet(text.slice(0, 280));
    logger.main.info('Twitter: Tweet posted');
  } catch (err) {
    logger.main.error('Twitter: ' + err);
  }
  callback();
}

module.exports = { run: run };
