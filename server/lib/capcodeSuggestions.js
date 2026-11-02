'use strict';

function districtFromAlias(alias) {
  var parts = String(alias || '').split(/\s+-\s+/);
  return parts.length > 1 ? parts[parts.length - 1].trim() : '';
}

function brigadeFromAlias(alias) {
  var name = String(alias || '').split(/\s+-\s+/)[0].trim()
    .replace(/\s+(?:RFB|RURAL FIRE BRIGADE|FIRE BRIGADE|BRIGADE|STATION)\b.*$/i, '').trim();
  if (!name || /\b(?:GROUP|OFFICER|CAPTAIN|ADMIN|BROADCAST|COMMS|DUTY|ZONE|DISTRICT|BASE|OPS)\b/i.test(name)) return '';
  return name;
}

function callsignFromPage(text) {
  var match = String(text || '').toUpperCase().match(/(?:^|\s)([A-Z]{2}[A-Z]{2,12}\d{0,2}[A-Z]?)\s*-\s*\d{2}-\d{5,}\b/);
  return match ? match[1] : '';
}

function makeReference(aliases) {
  var prefixes = {};
  var brigades = {};
  (aliases || []).forEach(function (row) {
    var address = String(row.address || '');
    var agency = String(row.agency || '').trim();
    var district = districtFromAlias(row.alias);
    if (!/^\d{4,}$/.test(address) || !agency || !district) return;
    [3, 4].forEach(function (length) {
      var key = address.slice(0, length);
      var group = prefixes[key] || (prefixes[key] = {total: 0, counts: {}});
      var label = agency + ' | ' + district;
      group.total++;
      group.counts[label] = (group.counts[label] || 0) + 1;
    });
    if (agency !== 'NSW RFS') return;
    var brigade = brigadeFromAlias(row.alias);
    if (brigade) {
      var key = district.toUpperCase();
      if (!brigades[key]) brigades[key] = [];
      if (brigades[key].indexOf(brigade) === -1) brigades[key].push(brigade);
    }
  });
  return {prefixes: prefixes, brigades: brigades};
}

function prefixHint(address, reference) {
  var candidates = [4, 3].map(function (length) {
    var prefix = String(address || '').slice(0, length);
    var group = reference.prefixes[prefix];
    if (!group || group.total < 3) return null;
    var labels = Object.keys(group.counts).sort(function (a, b) { return group.counts[b] - group.counts[a]; });
    var winner = labels[0];
    var count = group.counts[winner];
    if (count / group.total < 0.8 || count < 3) return null;
    var parts = winner.split(' | ');
    return {agency: parts[0], district: parts.slice(1).join(' | '), prefix: prefix, matching: count, total: group.total};
  }).filter(Boolean);
  return candidates[0] || null;
}

function brigadeHint(samples, district, reference) {
  var names = reference.brigades[String(district || '').toUpperCase()] || [];
  var callsigns = (samples || []).map(callsignFromPage).filter(Boolean);
  if (!names.length || !callsigns.length) return null;
  var matches = [];
  callsigns.forEach(function (callsign) {
    var unit = callsign.slice(2).replace(/\d{1,2}[A-Z]?$/, '');
    if (unit.length < 4) return;
    names.forEach(function (name) {
      var normalized = name.toUpperCase().replace(/[^A-Z]/g, '');
      if (normalized.indexOf(unit) === 0 && !matches.some(function (match) { return match.name === name; })) matches.push({name: name, callsign: callsign});
    });
  });
  return matches.length === 1 ? matches[0] : null;
}

function suggest(entries, reference) {
  var result = {};
  (entries || []).forEach(function (entry) {
    var address = String(entry.address || '').trim();
    if (!/^\d{4,16}$/.test(address)) return;
    var prefix = prefixHint(address, reference);
    if (!prefix) return;
    var samples = Array.isArray(entry.samples) ? entry.samples.slice(0, 20) : [];
    var brigade = prefix.agency === 'NSW RFS' ? brigadeHint(samples, prefix.district, reference) : null;
    result[address] = {
      agency: prefix.agency,
      district: prefix.district,
      prefix: prefix.prefix,
      matching: prefix.matching,
      total: prefix.total,
      brigade: brigade && brigade.name || '',
      callsign: brigade && brigade.callsign || ''
    };
  });
  return result;
}

module.exports = {makeReference: makeReference, suggest: suggest};
