process.env.NODE_ENV = 'test';

const chai = require('chai');
const chaiHttp = require('chai-http');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../knex/knex');
const mailer = require('../lib/passwordResetMailer');
const server = require('../app');

chai.use(chaiHttp);

describe('Self-service password reset', function() {
  let token;
  const originalConfigured = mailer.configured;
  const originalSend = mailer.send;

  beforeEach(function() {
    token = null;
    mailer.configured = function() { return true; };
    mailer.send = function(user, rawToken) { token = rawToken; return Promise.resolve(true); };
    return db.migrate.rollback().then(function() { return db.migrate.latest(); }).then(function() { return db.seed.run(); });
  });

  afterEach(function() {
    mailer.configured = originalConfigured;
    mailer.send = originalSend;
    return db.migrate.rollback();
  });

  it('returns the same response for known and unknown identities', function() {
    return chai.request(server).post('/auth/forgot-password').set('X-Forwarded-For', '198.51.100.11').send({identity: 'useractive'}).then(function(known) {
      chai.expect(known.status).to.equal(200);
      chai.expect(token).to.match(/^[0-9a-f]{64}$/);
      return db('password_reset_tokens').first().then(function(row) {
        chai.expect(row.token_hash).to.equal(crypto.createHash('sha256').update(token).digest('hex'));
        return chai.request(server).post('/auth/forgot-password').set('X-Forwarded-For', '198.51.100.11').send({identity: 'nobody@example.com'});
      }).then(function(unknown) {
        chai.expect(unknown.status).to.equal(200);
        chai.expect(unknown.body).to.deep.equal(known.body);
      });
    });
  });

  it('accepts a link once and changes the password', function() {
    return chai.request(server).post('/auth/forgot-password').set('X-Forwarded-For', '198.51.100.12').send({identity: 'useractive'}).then(function() {
      const linkToken = token;
      return chai.request(server).post('/auth/password-reset/' + linkToken).set('X-Forwarded-For', '198.51.100.12').send({password: 'A strong new password 123'}).then(function(result) {
        chai.expect(result.status).to.equal(200);
        return db('users').where('username', 'useractive').first();
      }).then(function(user) {
        chai.expect(bcrypt.compareSync('A strong new password 123', user.password)).to.equal(true);
        chai.expect(user.password_reset_at).to.exist;
        return chai.request(server).post('/auth/password-reset/' + linkToken).set('X-Forwarded-For', '198.51.100.12').send({password: 'Another strong password 123'});
      }).then(function(reuse) { chai.expect(reuse.status).to.equal(400); });
    });
  });

  it('rejects an expired link', function() {
    return chai.request(server).post('/auth/forgot-password').set('X-Forwarded-For', '198.51.100.13').send({identity: 'useractive'}).then(function() {
      const linkToken = token;
      return db('password_reset_tokens').update({expires_at: '2000-01-01 00:00:00'}).then(function() {
        return chai.request(server).post('/auth/password-reset/' + linkToken).set('X-Forwarded-For', '198.51.100.13').send({password: 'A strong new password 123'});
      }).then(function(result) { chai.expect(result.status).to.equal(400); });
    });
  });
});
