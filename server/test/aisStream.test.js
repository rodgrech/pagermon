var assert = require('node:assert/strict');
var EventEmitter = require('events');
var aisStream = require('../lib/aisStream');

describe('experimental AIS Stream vessel cache', function () {
  it('does not connect without enablement, a key, and valid bounds', function () {
    var connections = 0;
    function FakeSocket() { connections++; }
    var service = aisStream.createService({WebSocket: FakeSocket, cacheFile: '/not/a/real/cache.json'});
    assert.equal(service.configure({enabled: false, apiKey: 'secret'}), false);
    assert.equal(service.configure({enabled: true, apiKey: ''}), false);
    assert.equal(service.configure({enabled: true, apiKey: 'secret', southLatitude: 0, northLatitude: 20}), false);
    assert.equal(connections, 0);
  });

  it('opens one server-side subscription and retains recent positions', function () {
    var socket;
    function FakeSocket() { EventEmitter.call(this); socket = this; }
    FakeSocket.prototype = Object.create(EventEmitter.prototype);
    FakeSocket.prototype.send = function (value) { this.subscription = JSON.parse(value); };
    FakeSocket.prototype.close = function () {};
    var service = aisStream.createService({WebSocket: FakeSocket, cacheFile: '/not/a/real/cache.json'});
    assert.equal(service.configure({enabled: true, apiKey: 'secret'}), true);
    socket.emit('open');
    assert.equal(socket.subscription.APIKey, 'secret');
    assert.equal(socket.subscription.BoundingBoxes.length, 1);
    assert.equal(service.snapshot().connected, false);
    socket.emit('message', JSON.stringify({MessageType: 'SubscriptionConfirmation', Message: {CompressionEnabled: true}}));
    socket.emit('message', JSON.stringify({MessageType: 'PositionReport', MetaData: {MMSI: 503123456, ShipName: 'TEST BOAT', Latitude: -33, Longitude: 152}, Message: {PositionReport: {Valid: true, Sog: 10, Cog: 90}}}));
    var payload = service.snapshot();
    assert.equal(payload.connected, true);
    assert.equal(payload.vessels.length, 1);
    assert.equal(payload.vessels[0].name, 'TEST BOAT');
    assert.equal(payload.vessels[0].speed, 10);
    assert.equal(JSON.stringify(payload).includes('secret'), false);
    service.configure({enabled: false});
  });
});
