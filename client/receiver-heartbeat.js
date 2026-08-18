'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

const receiverId = process.argv[2];
if (!receiverId) throw new Error('Receiver id is required.');

const config = JSON.parse(fs.readFileSync('config/config.json', 'utf8'));
const endpoint = new URL(String(config.hostname).replace(/\/$/, '') + '/api/central-west/receiver-heartbeat');
const payload = JSON.stringify({ id: receiverId, identifier: config.identifier || receiverId });
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
