const webpush = require('web-push');
const nconf = require('nconf');
const db = require('../knex/knex.js');
const logger = require('../log');

function configure() {
  nconf.load();
  const config = nconf.get('notifications:webPush') || {};
  if (!config.enabled || !config.publicKey || !config.privateKey) return null;
  webpush.setVapidDetails(config.subject || 'mailto:admin@localhost', config.publicKey, config.privateKey);
  return config;
}

function removeExpired(endpoint, error) {
  if (error && (error.statusCode === 404 || error.statusCode === 410)) {
    return db('push_subscriptions').where('endpoint', endpoint).del();
  }
  logger.main.error('Web push delivery failed: ' + (error && error.message ? error.message : error));
  return Promise.resolve();
}

function sendSubscriptions(subscriptions, payload) {
  if (!configure()) return Promise.resolve([]);
  return Promise.all(subscriptions.map(function(row) {
    return webpush.sendNotification({
      endpoint: row.endpoint,
      keys: {p256dh: row.p256dh, auth: row.auth}
    }, JSON.stringify(payload), {TTL: 300}).catch(function(error) {
      return removeExpired(row.endpoint, error);
    });
  }));
}

function sendForMessage(message) {
  if (!configure() || !message || !message.address) return Promise.resolve([]);
  return db('push_subscriptions')
    .join('users', 'users.id', 'push_subscriptions.user_id')
    .select('push_subscriptions.endpoint', 'push_subscriptions.p256dh', 'push_subscriptions.auth')
    .where('users.status', 'active')
    .where('users.approvalpending', false)
    .where('users.pushcapcode', String(message.address))
    .then(function(subscriptions) {
      return sendSubscriptions(subscriptions, {
        title: message.alias || message.agency || ('Capcode ' + message.address),
        body: message.message,
        url: '/?address=' + encodeURIComponent(message.address),
        feedUrl: '/',
        messageId: message.id,
        capcode: String(message.address),
        tag: 'capcode-' + message.address,
        timestamp: Number(message.timestamp) * 1000 || Date.now()
      });
    });
}

function sendTestForUser(userId) {
  if (!configure()) return Promise.resolve(0);
  return db('push_subscriptions')
    .select('endpoint', 'p256dh', 'auth')
    .where('user_id', userId)
    .then(function(subscriptions) {
      return sendSubscriptions(subscriptions, {
        title: 'Central West Alerts',
        body: 'Push notifications are working.',
        url: '/auth/profile',
        tag: 'push-test'
      }).then(function() { return subscriptions.length; });
    });
}

module.exports = {sendForMessage, sendTestForUser};
