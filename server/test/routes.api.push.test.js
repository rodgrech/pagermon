process.env.NODE_ENV = 'test';

const chai = require('chai');
const chaiHttp = require('chai-http');
chai.use(chaiHttp);
const should = chai.should();
const nconf = require('nconf');
const server = require('../app');
const db = require('../knex/knex.js');
const passportStub = require('passport-stub');
passportStub.install(server);

beforeEach(() => db.migrate.rollback().then(() => db.migrate.latest()).then(() => db.seed.run()));
afterEach(() => {
  nconf.set('notifications:webPush:enabled', false);
  nconf.save();
  return db.migrate.rollback().then(() => passportStub.logout());
});

describe('Web Push API', () => {
  it('requires a logged-in browser session', done => {
    chai.request(server).get('/api/push/config').end((err, res) => {
      should.not.exist(err);
      res.status.should.eql(401);
      done();
    });
  });

  it('stores one capcode preference and a device subscription', done => {
    passportStub.login({id: 2, username: 'useractive', role: 'user'});
    nconf.set('notifications:webPush:enabled', true);
    nconf.set('notifications:webPush:publicKey', 'test-public-key');
    nconf.save();
    chai.request(server).post('/api/push/subscription').send({
      capcode: '9999999',
      subscription: {endpoint: 'https://push.example/device', keys: {p256dh: 'key', auth: 'secret'}}
    }).end((err, res) => {
      should.not.exist(err);
      res.status.should.eql(200);
      db('users').where('id', 2).first().then(user => {
        user.pushcapcode.should.eql('9999999');
        return db('push_subscriptions').where('user_id', 2).first();
      }).then(subscription => {
        subscription.endpoint.should.eql('https://push.example/device');
        done();
      }).catch(done);
    });
  });
});
