var callsigns = require('./emergencyAircraftCalls.json');

function identity(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function classify(item, registry) {
  var flight = identity(item.flight);
  var registration = identity(item.registration || item.r);
  var operator = String(item.aircraftOperator || '').toUpperCase();
  var callsign = callsigns.find(function(entry) { return entry.prefix && flight && flight.indexOf(entry.prefix) === 0; });
  var nafc = (registry || []).find(function(candidate) {
    return (registration && identity(candidate.registration) === registration) ||
      (flight && identity(candidate.callsign) === flight);
  });
  if (nafc) return {fireAircraft: true, emergencyAircraft: true, emergencyCategory: 'fire', emergencyLabel: 'Fire aviation', emergencyCallsign: nafc.callsign, emergencyRole: nafc.role, emergencyMatchSource: 'NAFC registry', fireCallsign: nafc.callsign, fireRole: nafc.role, fireManufacturer: nafc.manufacturer, fireModel: nafc.model, fireMatchSource: 'NAFC registry'};
  if (callsign && callsign.category === 'fire')
    return {fireAircraft: true, emergencyAircraft: true, emergencyCategory: 'fire', emergencyLabel: 'Fire aviation', emergencyCallsign: String(item.flight || '').trim(), emergencyRole: 'Fire aviation', emergencyMatchSource: 'Operational callsign', fireCallsign: String(item.flight || '').trim(), fireRole: 'Fire aviation', fireMatchSource: 'Operational callsign'};

  var category, label;
  if (callsign && callsign.category !== 'fire') { category = callsign.category; label = callsign.label; }
  else if (/NSW POLICE FORCE|NSW POLICE AVIATION/.test(operator)) { category = 'police'; label = 'NSW Police aviation'; }
  else if (/CAREFLIGHT|TOLL HELICOPTERS|WESTPAC RESCUE HELICOPTER|NORTHERN NSW HELICOPTER RESCUE/.test(operator)) { category = 'rescue'; label = 'Rescue / aeromedical aviation'; }
  else if (/ROYAL FLYING DOCTOR SERVICE|NSW AMBULANCE/.test(operator)) { category = 'medical'; label = 'Aeromedical aviation'; }
  else if (/AUSTRALIAN MARITIME SAFETY AUTHORITY/.test(operator)) { category = 'rescue'; label = 'Search and rescue aviation'; }
  else if (/ROYAL AUSTRALIAN NAVY|ROYAL AUSTRALIAN AIR FORCE|AUSTRALIAN ARMY AVIATION/.test(operator)) { category = 'military'; label = 'Military aircraft'; }
  else if (Number(item.dbFlags) & 1) { category = 'military'; label = 'Military aircraft'; }
  if (!category) return {fireAircraft: false, emergencyAircraft: false};
  return {fireAircraft: false, emergencyAircraft: true, emergencyCategory: category, emergencyLabel: label, emergencyCallsign: String(item.flight || '').trim(), emergencyRole: label, emergencyMatchSource: callsign ? 'Curated callsign catalogue' : category === 'military' && (Number(item.dbFlags) & 1) ? 'ADS-B provider military flag' : 'Registered operator'};
}

module.exports = {classify: classify};
