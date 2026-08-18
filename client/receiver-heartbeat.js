'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

const receiverId = process.argv[2];
if (!receiverId) throw new Error('Receiver id is required.');

const config = JSON.parse(fs.readFileSync('config/config.json', 'utf8'));
const endpoint = new URL(String(config.hostname).replace(/\/$/, '') + '/api/central-west/receiver-heartbeat');
const ipCacheFile = '/tmp/central-west-alerts-' + receiverId.replace(/[^a-z0-9_-]/gi, '') + '-public-ip.json';

function cachedPublicIp() {
  try {
    const cached = JSON.parse(fs.readFileSync(ipCacheFile, 'utf8'));
    if (cached.ip && Date.now() - Number(cached.fetchedAt) < 6 * 60 * 60 * 1000) return Promise.resolve(cached.ip);
  } catch (error) {}
  return new Promise(function (resolve) {
    const request = https.get('https://api.ipify.org?format=json', {timeout: 5000, headers: {'User-Agent': 'CentralWestAlerts receiver heartbeat'}}, function (response) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', function (chunk) { if (body.length < 1024) body += chunk; });
      response.on('end', function () {
        try {
          const ip = JSON.parse(body).ip;
          if (!ip) throw new Error('No public IP returned');
          fs.writeFileSync(ipCacheFile, JSON.stringify({ip: ip, fetchedAt: Date.now()}), {mode: 0o600});
          resolve(ip);
        } catch (error) { resolve(null); }
      });
    });
    request.on('timeout', function () { request.destroy(); resolve(null); });
    request.on('error', function () { resolve(null); });
  });
}

cachedPublicIp().then(function (externalIp) {
  const payload = JSON.stringify({ id: receiverId, identifier: config.identifier || receiverId, externalIp: externalIp });
  const transport = endpoint.protocol === 'https:' ? https : http;
  const request = transport.request(endpoint, {
    method: 'POST',
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'CentralWestAlerts receiver heartbeat',
      apikey: config.apikey
    }
  }, function (response) {
    response.resume();
    response.on('end', function () {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        console.error('Heartbeat rejected with HTTP ' + response.statusCode);
        process.exitCode = 1;
      }
    });
  });
  request.on('timeout', function () { request.destroy(new Error('Heartbeat timed out')); });
  request.on('error', function (error) { console.error(error.message); process.exitCode = 1; });
  request.end(payload);
});
