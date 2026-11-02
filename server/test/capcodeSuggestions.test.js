'use strict';

var assert = require('assert');
var suggestions = require('../lib/capcodeSuggestions');

describe('capcode discovery suggestions', function () {
  var reference = suggestions.makeReference([
    {address: '1510000', agency: 'NSW RFS', alias: 'Broadcast - Canobolas'},
    {address: '1510008', agency: 'NSW RFS', alias: 'Orange Brigade - Canobolas'},
    {address: '1510016', agency: 'NSW RFS', alias: 'Borenore Brigade - Canobolas'},
    {address: '1510024', agency: 'NSW RFS', alias: 'Mullion Creek Brigade - Canobolas'},
    {address: '0520008', agency: 'NSW RFS', alias: 'Lithgow Brigade - Chifley/Lithgow'},
    {address: '0520016', agency: 'NSW RFS', alias: 'Hartley Brigade - Chifley/Lithgow'},
    {address: '0520024', agency: 'NSW RFS', alias: 'Bell Brigade - Chifley/Lithgow'},
    {address: '1029001', agency: 'NSW SES', alias: 'Bathurst Unit - Western Zone'},
    {address: '1029002', agency: 'NSW SES', alias: 'Molong Unit - Western Zone'},
    {address: '1029003', agency: 'NSW RFS', alias: 'Bathurst Brigade - Chifley/Lithgow'}
  ]);

  it('uses a supported prefix and pager callsign for a tentative brigade', function () {
    var result = suggestions.suggest([{address: '1510099', samples: ['CZORANG1 - 26-123456 - GRASS FIRE - ORANGE']}], reference)['1510099'];
    assert.strictEqual(result.agency, 'NSW RFS');
    assert.strictEqual(result.district, 'Canobolas');
    assert.strictEqual(result.brigade, 'Orange');
    assert.strictEqual(result.callsign, 'CZORANG1');
  });

  it('does not invent a brigade when the page lacks an identifiable callsign', function () {
    var result = suggestions.suggest([{address: '0520099', samples: ['GRASS FIRE NEAR LITHGOW']}], reference)['0520099'];
    assert.strictEqual(result.district, 'Chifley/Lithgow');
    assert.strictEqual(result.brigade, '');
  });

  it('does not treat a mixed prefix as a reliable district', function () {
    var result = suggestions.suggest([{address: '1029009', samples: ['UNKNOWN PAGE']}], reference);
    assert.strictEqual(result['1029009'], undefined);
  });

  it('does not guess on an unsupported capcode prefix', function () {
    assert.deepStrictEqual(suggestions.suggest([{address: '9999999', samples: []}], reference), {});
  });
});
