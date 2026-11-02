var assert = require('node:assert/strict');
var classify = require('../lib/emergencyAircraft').classify;

describe('emergency aircraft classification', function() {
it('NAFC registry has priority over other aircraft identities', function() {
  var result = classify({flight: 'OTHER', registration: 'VH-ABC'}, [{callsign: 'BOMBER 123', registration: 'VH-ABC', role: 'SEAT'}]);
  assert.equal(result.emergencyCategory, 'fire');
  assert.equal(result.fireAircraft, true);
});

it('a Lifesaver rescue callsign overrides a NAFC registration match', function() {
  var result = classify({flight: 'LIFESAVER 21', registration: 'VH-ABC'}, [{callsign: 'FIREBIRD 217', registration: 'VH-ABC', role: 'Fire operations'}]);
  assert.equal(result.emergencyCategory, 'rescue');
  assert.equal(result.fireAircraft, false);
  assert.equal(result.emergencyCallsign, 'LIFESAVER 21');
});

it('a Parkair operational callsign is not replaced by a NAFC registration callsign', function() {
  var result = classify({flight: 'PARKAIR 3', registration: 'VH-ABC'}, [{callsign: 'FIREBIRD 217', registration: 'VH-ABC', role: 'Fire operations'}]);
  assert.equal(result.emergencyCategory, 'fire');
  assert.equal(result.emergencyCallsign, 'PARKAIR 3');
  assert.equal(result.fireCallsign, 'PARKAIR 3');
  assert.equal(result.emergencyMatchSource, 'Operational callsign');
});

it('curated rescue, police and medical callsigns classify separately', function() {
  assert.equal(classify({flight: 'TOLLRESCUE1'}).emergencyCategory, 'rescue');
  assert.equal(classify({flight: 'RSCU206', registration: 'VH-TJI'}).emergencyCategory, 'rescue');
  assert.equal(classify({flight: 'POLAIR3'}).emergencyCategory, 'police');
  assert.equal(classify({flight: 'POL24'}).emergencyCategory, 'police');
  assert.equal(classify({flight: 'POLAR24'}).emergencyCategory, 'police');
  assert.equal(classify({flight: 'POLARIS24'}).emergencyAircraft, false);
  assert.equal(classify({flight: 'POLAIRTEST'}).emergencyAircraft, false);
  assert.equal(classify({flight: 'RFDS4'}).emergencyCategory, 'medical');
  assert.equal(classify({flight: 'RFDS4'}).emergencyLabel, 'Royal Flying Doctor Service');
  assert.equal(classify({flight: 'JST438'}).emergencyAircraft, false);
});

it('registered operator matches and provider military flag', function() {
  assert.equal(classify({aircraftOperator: 'NSW Police Force'}).emergencyCategory, 'police');
  assert.equal(classify({aircraftOperator: 'Toll Helicopters'}).emergencyCategory, 'rescue');
  assert.equal(classify({dbFlags: 1}).emergencyCategory, 'military');
  assert.equal(classify({dbFlags: 2}).emergencyAircraft, false);
});
});
