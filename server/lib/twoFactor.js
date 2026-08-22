const crypto = require('crypto');

function key() {
  const nconf = require('nconf');
  return crypto.createHash('sha256').update(String(nconf.get('global:sessionSecret'))).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join('.');
}

function decrypt(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted TOTP secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString('utf8');
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) {
  let bits = 0; let value = 0; let output = '';
  for (let i = 0; i < buffer.length; i += 1) {
    value = (value << 8) | buffer[i]; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  let bits = 0; let value = 0; const output = [];
  String(input).replace(/=+$/, '').toUpperCase().split('').forEach(function(character) {
    const index = alphabet.indexOf(character);
    if (index < 0) return;
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  });
  return Buffer.from(output);
}

function token(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function verify(secret, supplied) {
  const clean = String(supplied || '').replace(/\s/g, '');
  const counter = Math.floor(Date.now() / 30000);
  for (let drift = -1; drift <= 1; drift += 1) {
    const expected = token(secret, counter + drift);
    if (clean.length === expected.length && crypto.timingSafeEqual(Buffer.from(clean), Buffer.from(expected))) return true;
  }
  return false;
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function recoveryCodes() {
  return Array.from({length: 10}, function() { return crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'); });
}

module.exports = { encrypt, decrypt, verify, hash, recoveryCodes, newSecret: function() { return base32Encode(crypto.randomBytes(20)); } };
