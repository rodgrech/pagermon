var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var serviceModule = require('../lib/adsbLol');

describe('adsb.lol aircraft service', function() {
  var directory;
  beforeEach(function() { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagermon-adsb-lol-')); });
  afterEach(function() { fs.rmSync(directory, {recursive: true, force: true}); });

  function service(get) {
    return serviceModule.createService({
      axios: {get: get}, logger: {warn: function() {}},
      cacheFile: path.join(directory, 'aircraft.json')
    });
  }

  it('shares one provider request and filters unusable or old positions', function() {
    var calls = 0;
    var client = service(function() {
      calls++;
      return Promise.resolve({data: {ac: [
        {hex: 'abc123', lat: -32.5, lon: 149.5, seen: 1, flight: 'TEST  '},
        {hex: 'bad', lat: null, lon: 149.5, seen: 1},
        {hex: 'old', lat: -32.5, lon: 149.5, seen: 500}
      ]}});
    });
    var config = {latitude: -32.65, longitude: 149.58, radiusNm: 100};
    return Promise.all([client.get(config), client.get(config)]).then(function(results) {
      assert.strictEqual(calls, 1);
      assert.strictEqual(results[0].aircraft.length, 1);
      assert.strictEqual(results[0].aircraft[0].flight, 'TEST');
      return client.get(config);
    }).then(function() { assert.strictEqual(calls, 1); });
  });

  it('backs off after a rate limit and reports unavailable data', function() {
    var calls = 0;
    var client = service(function() {
      calls++;
      return Promise.reject({response: {status: 429, headers: {'retry-after': '120'}}});
    });
    return client.get({}).then(function(first) {
      assert.strictEqual(first.unavailable, true);
      return client.get({});
    }).then(function(second) {
      assert.strictEqual(second.stale, true);
      assert.strictEqual(calls, 1);
    });
  });
});
