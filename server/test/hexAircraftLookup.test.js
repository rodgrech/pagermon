var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var createService = require('../lib/hexAircraftLookup').createService;

describe('shared aircraft metadata lookup', function() {
  var directory;
  beforeEach(function() { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagermon-aircraft-')); });
  afterEach(function() { fs.rmSync(directory, {recursive: true, force: true}); });

  it('coalesces lookups and reuses a persisted owner across feed requests', function() {
    var calls = 0;
    var cacheFile = path.join(directory, 'hex.json');
    function options() { return {axios: {get: function() { calls++; return Promise.resolve({data: {Registration: 'VH-ABC', RegisteredOwners: 'NSW Police Force'}}); }}, logger: {warn: function() {}}, cacheFile: cacheFile}; }
    var first = createService(options());
    return Promise.all([first.get('7c1234'), first.get('7c1234')]).then(function(results) {
      assert.strictEqual(calls, 1);
      assert.strictEqual(results[0].aircraftOperator, 'NSW Police Force');
      return createService(options()).get('7c1234');
    }).then(function(result) {
      assert.strictEqual(calls, 1);
      assert.strictEqual(result.registration, 'VH-ABC');
    });
  });

  it('bounds new provider requests in one minute', function() {
    var calls = 0;
    var service = createService({axios: {get: function() { calls++; return Promise.resolve({data: {}}); }}, logger: {warn: function() {}}, cacheFile: path.join(directory, 'hex.json')});
    return Promise.all(Array.from({length: 35}, function(_, index) { return service.get((0x7c0000 + index).toString(16)); })).then(function() {
      assert.strictEqual(calls, 30);
    });
  });
});
