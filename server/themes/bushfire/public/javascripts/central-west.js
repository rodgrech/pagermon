(function (window) {
  'use strict';

  var towns = [
    ['Mudgee', -32.5943, 149.5871], ['Gulgong', -32.3627, 149.5325],
    ['Crudine', -32.93166, 149.70111],
    ['Rylstone', -32.7972, 149.9690], ['Kandos', -32.8575, 149.9683],
    ['Wellington', -32.5559, 148.9455], ['Dubbo', -32.2429, 148.6048],
    ['Bathurst', -33.4193, 149.5775], ['Orange', -33.2833, 149.1000],
    ['Lithgow', -33.4801, 150.1570], ['Oberon', -33.7049, 149.8592],
    ['Dunedoo', -32.0167, 149.4000], ['Coolah', -31.8275, 149.7167],
    ['Cudgegong', -32.7000, 149.7500], ['Lue', -32.6500, 149.8333],
    ['Hargraves', -32.7833, 149.4667], ['Hill End', -33.0333, 149.4167],
    ['Ilford', -32.9667, 149.8500], ['Sofala', -33.0800, 149.6900],
    ['Blayney', -33.5323, 149.2537], ['Cowra', -33.8355, 148.6966],
    ['Parkes', -33.1373, 148.1751], ['Forbes', -33.3858, 148.0076],
    ['Molong', -33.0923, 148.8695], ['Canowindra', -33.5626, 148.6608],
    ['Grenfell', -33.8958, 148.1646], ['Eugowra', -33.4278, 148.3719],
    ['Coonabarabran', -31.2775, 149.2790], ['Narromine', -32.2314, 148.2405],
    ['Trangie', -32.0328, 147.9837], ['Gilgandra', -31.7117, 148.6625],
    ['Warren', -31.7004, 147.8375], ['Coonamble', -30.9537, 148.3888],
    ['Merriwa', -32.1394, 150.3556], ['Binnaway', -31.5521, 149.3794],
    ['Ulan', -32.2847, 149.7431], ['Bylong', -32.4110, 150.1130],
    ['Windeyer', -32.7727, 149.5493], ['Wollar', -32.3543, 149.9468],
    ['Goolma', -32.3700, 149.2700], ['Mullamuddy', -32.6500, 149.6500]
  ];
  var map;
  var baseLayer;
  var radarLayer;
  var layerGroups;
  var forestryClosures = [];
  var mapWheelPxPerZoomLevel = 360;
  var mapCenter = [-32.65, 149.58];
  var mapInitialZoom = 8;
  var stopMessageWindowMinutes = 30;
  var hideTestPages = false;
  var additionalPriorityKeywords = {critical: [], high: [], medium: []};
  var lastRender;
  var lastRadarConfig;
  var lastRadarEnabled = false;
  var recoveryTimer;
  var satelliteHotspots = [];
  var fireDangerDistricts = [];
  var fireDangerBoundaries = null;

  if (window.fetch) {
    window.fetch('/api/central-west/dashboard-config', {credentials: 'same-origin'})
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (config) {
        if (!config) return;
        mapWheelPxPerZoomLevel = Number(config.wheelPxPerZoomLevel) || 360;
        mapCenter = [Number(config.mapCenterLatitude) || -32.65, Number(config.mapCenterLongitude) || 149.58];
        mapInitialZoom = Number(config.mapInitialZoom) || 8;
        stopMessageWindowMinutes = Math.min(Math.max(Number(config.stopMessageWindowMinutes) || 30, 1), 1440);
        hideTestPages = config.hideTestPages === true;
        additionalPriorityKeywords.critical = parseKeywordList(config.additionalCriticalKeywords);
        additionalPriorityKeywords.high = parseKeywordList(config.additionalHighKeywords);
        additionalPriorityKeywords.medium = parseKeywordList(config.additionalMediumKeywords);
        if (config.fireDangerEnabled) {
          window.fetch('/api/central-west/fire-danger', {credentials: 'same-origin'}).then(function (response) { return response.ok ? response.json() : null; }).then(function (data) {
            fireDangerDistricts = data && data.districts || [];
            if (map) renderFireDangerLayer();
          }).catch(function () {});
        }
        if (map) {
          map.options.wheelPxPerZoomLevel = mapWheelPxPerZoomLevel;
          map.setView(mapCenter, mapInitialZoom);
        }
      }).catch(function () {});
  }

  function layerEnabled(name) {
    try {
      var saved = JSON.parse(localStorage.getItem('cw-map-layers') || '{}');
      if (Object.prototype.hasOwnProperty.call(saved, name)) return saved[name] !== false;
      if (name === 'hotspots') return !!(window.CentralWestMapFeatures && window.CentralWestMapFeatures.nasaFirmsDefaultVisible);
      if (name === 'forestry') return false;
      return true;
    }
    catch (err) { return true; }
  }

  function saveLayerState() {
    if (!map || !layerGroups) return;
    var state = {};
    Object.keys(layerGroups).forEach(function (name) { state[name] = map.hasLayer(layerGroups[name]); });
    localStorage.setItem('cw-map-layers', JSON.stringify(state));
  }

  function priority(message) {
    var text = String(message || '').toUpperCase();
    if (/PERSONS? TRAPPED|ENTRAP|STRUCTURE FIRE|HOUSE FIRE|RESCUE REQUIRED|MAYDAY|LIFE THREAT|EMERGENCY/.test(text) || matchesAdditionalKeyword(text, 'critical')) return 'critical';
    if (/MVA|MVC|GRASS FIRE|BUSH FIRE|BACKYARD FIRE|FIRECALL|FLOOD RESCUE|MISSING PERSON|HAZMAT|URGENT|ASSIST AMBULANCE/.test(text) || matchesAdditionalKeyword(text, 'high')) return 'high';
    if (/TREE DOWN|FLOOD|STORM|SMOKE|ALARM|BACKUP|ASSIST|INCIDENT/.test(text) || matchesAdditionalKeyword(text, 'medium')) return 'medium';
    return 'routine';
  }

  function fireDangerColour(rating) {
    var value = String(rating || '').toUpperCase();
    return value === 'CATASTROPHIC' ? '#8e1b1b' : value === 'EXTREME' ? '#d02b20' : value === 'HIGH' ? '#e58d16' : value === 'MODERATE' ? '#e6c229' : '#8aa0ad';
  }

  function fireDangerGauge(rating) {
    var value = String(rating || 'NO RATING').toUpperCase();
    var labels = ['NO RATING', 'MODERATE', 'HIGH', 'EXTREME', 'CATASTROPHIC'];
    var active = labels.indexOf(value); if (active < 0) active = 0;
    var colours = ['#e5e5e5', '#f6df3f', '#ef9a1a', '#d84b24', '#9f201b'];
    var paths = ['M12 74 A48 48 0 0 1 28 39 L39 50 A32 32 0 0 0 28 74 Z', 'M28 39 A48 48 0 0 1 50 27 L54 43 A32 32 0 0 0 39 50 Z', 'M50 27 A48 48 0 0 1 74 28 L65 43 A32 32 0 0 0 54 43 Z', 'M74 28 A48 48 0 0 1 92 44 L76 51 A32 32 0 0 0 65 43 Z', 'M92 44 A48 48 0 0 1 100 74 L84 74 A32 32 0 0 0 76 51 Z'];
    return '<div class="cw-fire-gauge"><svg viewBox="0 0 112 82" role="img" aria-label="' + escapeHtml(value) + '">' + paths.map(function (path, index) { return '<path d="' + path + '" fill="' + colours[index] + '" opacity="' + (index === active ? '1' : '.3') + '" stroke="#fff" stroke-width="1"/>'; }).join('') + '<text x="56" y="71" text-anchor="middle" font-size="8" font-weight="bold" fill="#ffffff" stroke="#263238" stroke-width=".7" paint-order="stroke">' + escapeHtml(value) + '</text></svg></div>';
  }

  function renderFireDangerLayer() {
    if (!map || !layerGroups || !window.L) return;
    layerGroups.fireDanger.clearLayers();
    var ratings = {};
    fireDangerDistricts.forEach(function (item) { ratings[String(item.name || '').toUpperCase()] = item; });
    function draw(geojson) {
      fireDangerBoundaries = geojson;
      if (layerEnabled('fireDanger') && !map.hasLayer(layerGroups.fireDanger)) layerGroups.fireDanger.addTo(map);
      L.geoJSON(geojson, {style: function (feature) {
        var name = String(feature.properties && (feature.properties.FIREAREA || feature.properties.firearea || feature.properties.district || feature.properties.DISTRICT || feature.properties.name || '')).toUpperCase();
        var rating = ratings[name] || fireDangerDistricts.filter(function (item) { return (item.councils || []).some(function (council) { var c = String(council || '').toUpperCase(); return name === c || name.indexOf(c) >= 0 || c.indexOf(name) >= 0; }) || name.indexOf(String(item.name || '').toUpperCase()) >= 0 || String(item.name || '').toUpperCase().indexOf(name) >= 0; })[0];
        var colour = fireDangerColour(rating && rating.today);
        return {color: colour, weight: 2, opacity: .9, fillColor: colour, fillOpacity: .18};
      }, onEachFeature: function (feature, layer) {
        var name = String(feature.properties && (feature.properties.FIREAREA || feature.properties.firearea || feature.properties.district || feature.properties.DISTRICT || feature.properties.name || 'RFS fire area'));
        var rating = ratings[name.toUpperCase()] || fireDangerDistricts.filter(function (item) { return (item.councils || []).some(function (council) { var c = String(council || '').toUpperCase(); return name.toUpperCase() === c || name.toUpperCase().indexOf(c) >= 0 || c.indexOf(name.toUpperCase()) >= 0; }) || name.toUpperCase().indexOf(String(item.name || '').toUpperCase()) >= 0 || String(item.name || '').toUpperCase().indexOf(name.toUpperCase()) >= 0; })[0];
        if (rating) {
          var today = String(rating.today || 'NO RATING');
          var tomorrow = String(rating.tomorrow || 'NO RATING');
          var advice = { 'NO RATING': 'No rating issued', MODERATE: 'Plan and prepare', HIGH: 'Be ready to act', EXTREME: 'Take action now to protect your life and property', CATASTROPHIC: 'For your survival, leave bush fire risk areas' }[today.toUpperCase()] || '';
          var ban = rating.fireBanToday || rating.fireBanTomorrow ? '<div class="cw-popup-description cw-fire-ban"><i class="fa fa-ban"></i> Total Fire Ban' + (rating.fireBanToday ? ' today' : '') + (rating.fireBanToday && rating.fireBanTomorrow ? ' and' : '') + (rating.fireBanTomorrow ? ' tomorrow' : '') + '</div>' : '';
          layer.bindPopup('<div class="cw-incident-popup cw-fire-danger-popup"><div class="cw-popup-heading"><i class="fa fa-fire"></i><strong>FIRE DANGER RATING</strong></div><div class="cw-popup-title">' + escapeHtml(name) + '</div>' + fireDangerGauge(today) + '<div class="cw-popup-pills"><span><small>Today</small>' + escapeHtml(today) + '</span><span><small>Tomorrow</small>' + escapeHtml(tomorrow) + '</span></div><div class="cw-popup-description"><strong>' + escapeHtml(advice) + '</strong></div>' + ban + '<div class="cw-popup-agency">NSW Rural Fire Service<small>Official fire danger area rating</small></div><a class="cw-popup-action" href="https://www.rfs.nsw.gov.au/fire-information/fdr-and-tobans" target="_blank" rel="noopener"><i class="fa fa-external-link-alt"></i> Official details</a></div>', {maxWidth: 390, className: 'cw-popup-shell'});
        }
      }}).addTo(layerGroups.fireDanger);
    }
    if (fireDangerBoundaries) return draw(fireDangerBoundaries);
    window.fetch('/api/central-west/fire-danger-boundaries', {credentials: 'same-origin'}).then(function (response) { return response.ok ? response.json() : null; }).then(function (data) { if (data) draw(data); }).catch(function () {});
  }

  function parseKeywordList(value) {
    return String(value || '').split(/[,\n]/).map(function (keyword) { return keyword.trim().toUpperCase(); }).filter(Boolean);
  }

  function matchesAdditionalKeyword(text, level) {
    return additionalPriorityKeywords[level].some(function (keyword) { return text.indexOf(keyword) !== -1; });
  }

  function isStopPage(message) {
    return /\b(?:STOP|STAND\s*DOWN|CANCEL(?:LED)?|NO NEED TO ATTEND)\b/i.test(String(message || ''));
  }

  function location(text) {
    text = String(text || '').toLowerCase();
    for (var i = 0; i < towns.length; i++) {
      if (text.indexOf(towns[i][0].toLowerCase()) !== -1) return {name: towns[i][0], lat: towns[i][1], lng: towns[i][2]};
    }
    return null;
  }

  function cleanPagerField(value) {
    return String(value || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  function titleCase(value) {
    return cleanPagerField(value).toLowerCase().replace(/\b[a-z]/g, function (letter) { return letter.toUpperCase(); });
  }

  function brigadeName(callsign) {
    var value = cleanPagerField(callsign).toUpperCase();
    var known = {CGCOMMS1: 'CG Comms 1', CGDO: 'Cudgegong Duty', CGLAWSO7A: 'Lawson 7', CGMUDGE1: 'Mudgee 1', CGMUDGE: 'Mudgee'};
    if (known[value]) return known[value];
    return value || '';
  }

  function responseUnitName(callsign) {
    var value = cleanPagerField(callsign).toUpperCase();
    var known = {'WTZSOF CFR': 'Western Zone Sofala CFA Unit', 'WTZSOE CFR': 'Western Zone Sofala CFA Unit'};
    return known[value] || cleanPagerField(callsign);
  }

  function brigadeSort(a, b) {
    var order = {'Mudgee': 10, 'Mudgee 1': 20, 'Lawson 7': 30, 'Cudgegong Duty': 40, 'CG Comms 1': 50};
    return (order[a] || 100) - (order[b] || 100) || a.localeCompare(b);
  }

  function isSharedFireNetworkAgency(agency) {
    var value = String(agency || '').toUpperCase();
    return value.indexOf('RFS') !== -1 || value.indexOf('VRA') !== -1;
  }

  function normalizedIncidentAddress(value) {
    return cleanPagerField(value).toUpperCase()
      .replace(/\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\]\s*$/, '')
      .replace(/\bNSW\b/g, '')
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/^\s+|\s+$/g, '');
  }

  function incidentGroupKey(message, details, loc, bucket) {
    var agency = message.agency || 'unknown';
    if (isSharedFireNetworkAgency(agency)) {
      if (details.incidentId) return 'rfs-vra|incident|' + details.incidentId;
      var address = normalizedIncidentAddress(details.address);
      if (address) return 'rfs-vra|address|' + address + '|' + bucket;
      if (details.coordinates) return 'rfs-vra|coordinates|' + Number(details.coordinates.lat).toFixed(4) + '|' + Number(details.coordinates.lng).toFixed(4) + '|' + bucket;
    }
    return details.incidentId ? agency + '|incident|' + details.incidentId : agency + '|' + (loc || message.address || 'unknown') + '|' + bucket;
  }

  function parsePagerIncident(message) {
    var text = cleanPagerField(message && message.message);
    var agency = String(message && message.agency || '').toUpperCase();
    var details = {raw: text};
    var coordinateMatch = text.match(/\[\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,2}(?:\.\d+)?)\s*\]\s*$/);
    if (coordinateMatch) {
      var longitude = Number(coordinateMatch[1]);
      var latitude = Number(coordinateMatch[2]);
      if (longitude >= 140 && longitude <= 155 && latitude >= -39 && latitude <= -27) details.coordinates = {lat: latitude, lng: longitude, exact: true};
    }
    var parts = text.split(/\s+-\s+/).map(cleanPagerField);
    var incidentIndex = -1;
    for (var i = 0; i < parts.length; i++) if (/^\d{2}-\d{5,}$/.test(parts[i])) { incidentIndex = i; break; }
    if (incidentIndex >= 0 && (isSharedFireNetworkAgency(agency) || details.coordinates)) {
      details.format = 'rfs';
      details.callsign = parts[incidentIndex - 1] || '';
      details.brigade = brigadeName(details.callsign);
      details.incidentId = parts[incidentIndex];
      details.type = parts[incidentIndex + 1] || '';
      details.subtype = parts[incidentIndex + 2] || '';
      details.address = parts[incidentIndex + 3] || '';
      var addressParts = details.address.split(',').map(cleanPagerField);
      details.locality = titleCase(addressParts[1] || addressParts[0]);
      details.title = cleanPagerField(details.type || details.subtype || 'RFS incident') + (details.locality ? ' — ' + details.locality : '');
      return details;
    }
    var sesMatch = text.match(/^(.+?)\s+AT\s+([^,]+),\s*([^,]+),\s*([^,]+),\s*NSW\.?\s*(.*)$/i);
    if (sesMatch && (agency.indexOf('SES') !== -1 || /\bCFR\b/i.test(sesMatch[1]))) {
      details.format = 'ses'; details.callsign = cleanPagerField(sesMatch[1]); details.unit = responseUnitName(details.callsign); details.place = titleCase(sesMatch[2]);
      details.street = titleCase(sesMatch[3]); details.locality = titleCase(sesMatch[4]);
      details.address = [details.place, details.street, details.locality + ', NSW'].join(', ');
      details.geocodeAddress = [details.street, details.locality + ', NSW'].join(', ');
      details.description = cleanPagerField(sesMatch[5]); details.title = 'SES response — ' + details.locality;
    }
    return details;
  }

  function decorateMessage(message) {
    message.cwIncident = parsePagerIncident(message);
    message.cwPriority = priority(message.message);
    message.cwLocation = message.cwIncident.coordinates || location((message.cwIncident.locality || '') + ' ' + message.message + ' ' + (message.alias || ''));
    if (message.cwLocation && !message.cwLocation.name) message.cwLocation.name = message.cwIncident.locality || 'Incident location';
    return message;
  }

  function groupIncidents(messages) {
    var groups = {};
    var stopPages = [];
    (messages || []).forEach(function (message) {
      decorateMessage(message);
      if (isStopPage(message.message)) {
        stopPages.push(message);
        return;
      }
      var bucket = Math.floor(Number(message.timestamp) / 10800);
      var loc = message.cwLocation ? message.cwLocation.name : '';
      var details = message.cwIncident || {};
      var key = incidentGroupKey(message, details, loc, bucket);
      if (!groups[key]) groups[key] = {agency: message.agency, agencies: [], location: loc, coordinates: message.cwLocation, coordinateAccuracy: details.coordinates && details.coordinates.exact ? 'exact' : 'approximate', details: details, brigades: [], priority: message.cwPriority, messages: [], lastSeen: new Date(Number(message.timestamp) * 1000)};
      groups[key].messages.push(message);
      if (message.agency && groups[key].agencies.indexOf(message.agency) === -1) groups[key].agencies.push(message.agency);
      if (details.brigade && groups[key].brigades.indexOf(details.brigade) === -1) groups[key].brigades.push(details.brigade);
      if (['routine', 'medium', 'high', 'critical'].indexOf(message.cwPriority) > ['routine', 'medium', 'high', 'critical'].indexOf(groups[key].priority)) groups[key].priority = message.cwPriority;
    });
    stopPages.forEach(function (message) {
      var stopTime = Number(message.timestamp);
      var best = null;
      Object.keys(groups).forEach(function (key) {
        var group = groups[key];
        var sameCapcode = group.messages.some(function (candidate) { return String(candidate.address) === String(message.address); });
        if (!sameCapcode) return;
        var priorTimes = group.messages.map(function (candidate) { return Number(candidate.timestamp); }).filter(function (timestamp) { return timestamp <= stopTime; });
        if (!priorTimes.length) return;
        var latestPrior = Math.max.apply(Math, priorTimes);
        var age = stopTime - latestPrior;
        if (age <= stopMessageWindowMinutes * 60 && (!best || age < best.age)) best = {group: group, age: age};
      });
      if (best) {
        best.group.messages.push(message);
        var stopDetails = message.cwIncident || {};
        var stoppedUnit = stopDetails.brigade || stopDetails.unit || stopDetails.callsign || message.alias || String(message.address || 'Unit');
        best.group.stoppedBrigades = best.group.stoppedBrigades || [];
        if (best.group.stoppedBrigades.indexOf(stoppedUnit) === -1) best.group.stoppedBrigades.push(stoppedUnit);
        best.group.status = best.group.brigades.length && best.group.brigades.every(function (brigade) { return best.group.stoppedBrigades.indexOf(brigade) !== -1; }) ? 'stopped' : 'partial-stop';
        best.group.stoppedAt = new Date(stopTime * 1000);
        best.group.lastSeen = new Date(Math.max(best.group.lastSeen.getTime(), stopTime * 1000));
        if (message.agency && best.group.agencies.indexOf(message.agency) === -1) best.group.agencies.push(message.agency);
        return;
      }
      var details = message.cwIncident || {};
      var loc = message.cwLocation ? message.cwLocation.name : '';
      var bucket = Math.floor(stopTime / 10800);
      var key = (message.agency || 'unknown') + '|unmatched-stop|' + (loc || message.address || 'unknown') + '|' + bucket;
      groups[key] = {agency: message.agency, agencies: message.agency ? [message.agency] : [], location: loc, coordinates: message.cwLocation, coordinateAccuracy: 'approximate', details: details, brigades: [], priority: message.cwPriority, messages: [message], lastSeen: new Date(stopTime * 1000), status: 'unmatched-stop', stoppedAt: new Date(stopTime * 1000)};
    });
    return Object.keys(groups).map(function (key) {
      groups[key].brigades.sort(brigadeSort);
      if (groups[key].agencies.length) groups[key].agency = groups[key].agencies.join(' + ');
      return groups[key];
    }).sort(function (a, b) { return b.lastSeen - a.lastSeen; }).slice(0, 50);
  }

  function unknownCapcodes(messages) {
    var found = {};
    (messages || []).forEach(function (message) {
      if (message.alias_id || message.alias || message.agency) return;
      var key = message.address || 'hidden';
      if (!found[key]) found[key] = {address: message.address, count: 0, sample: message.message, samples: [], lastSeen: new Date(Number(message.timestamp) * 1000)};
      found[key].count++;
      if (found[key].samples.length < 20) found[key].samples.push(message.message);
    });
    return Object.keys(found).map(function (key) {
      var item = found[key];
      var text = item.samples.join(' ').toUpperCase();
      var scores = {
        'NSW RFS': (text.match(/\b(BRIGADE|BUSH FIRE|GRASS FIRE|RFS|TANKER|CAT ?[147]|FIREGROUND|STRIKE TEAM)\b/g) || []).length,
        'NSW SES': (text.match(/\b(SES|FLOOD|STORM|TREE DOWN|ROOF|SANDBAG|EVACUAT|FLASH FLOOD)\b/g) || []).length,
        'NSW VRA': (text.match(/\b(VRA|RESCUE SQUAD|MVA|MVC|PERSONS? TRAPPED|ROAD CRASH|VERTICAL RESCUE)\b/g) || []).length
      };
      var ranked = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a]; });
      if (scores[ranked[0]] > 0) {
        item.suggestedAgency = ranked[0];
        item.confidence = Math.min(95, 45 + scores[ranked[0]] * 12);
      } else {
        item.suggestedAgency = 'Insufficient evidence';
        item.confidence = 0;
      }
      delete item.samples;
      return item;
    }).sort(function (a, b) { return b.count - a.count; });
  }

  function distanceKm(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lng - a.lng) * rad;
    var lat1 = a.lat * rad;
    var lat2 = b.lat * rad;
    var value = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function correlationText(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function isTestPagerIncident(incident) {
    return (incident.messages || []).some(function (message) {
      return /\b(?:TEST(?:ING)?|TEST\s+PAGE|TEST\s+MESSAGE|SYSTEM\s+UNDER\s+TEST|DRILL|TRAINING|EXERCISE)\b/i.test(String(message.message || ''));
    });
  }

  function hasIncidentLocationEvidence(incident, rfs) {
    var official = correlationText((rfs.title || '') + ' ' + (rfs.description || ''));
    var locality = correlationText(incident.location || '');
    if (locality.length >= 4 && official.indexOf(locality) !== -1) return true;
    var ignored = /^(NSW|MID|WESTERN|ROAD|STREET|DRIVE|LANE|HIGHWAY|HWY|RD|ST|DR|FIRE|GRASS|BUSH|INCIDENT|ALERT|RFS)$/;
    return correlationText((incident.messages && incident.messages[0] && incident.messages[0].message) || '').split(' ').some(function (token) {
      return token.length >= 5 && !ignored.test(token) && official.indexOf(token) !== -1;
    });
  }

  function incidentReference(value) {
    var match = String(value || '').match(/\b\d{2}-\d{5,}\b/);
    return match ? match[0] : '';
  }

  function isCurrentRfsLifecycleMatch(incident, rfs) {
    var pagerReference = incidentReference(incident.details && incident.details.incidentId);
    var officialReference = incidentReference((rfs.incidentId || '') + ' ' + (rfs.title || '') + ' ' + (rfs.description || '') + ' ' + (rfs.link || ''));
    if (pagerReference && officialReference && pagerReference !== officialReference) return false;

    var pagerTime = incident.lastSeen instanceof Date ? incident.lastSeen.getTime() / 1000 : 0;
    var firstSeenAt = Number(rfs.firstSeenAt || 0);
    if (!pagerTime || !firstSeenAt) return true;

    // RSS incidents normally appear within minutes of the initial page. Keep a
    // modest allowance for delayed polling, but never attach an old retained
    // pager group to a newly published nearby incident.
    return pagerTime >= firstSeenAt - 21600 && pagerTime <= firstSeenAt + 86400;
  }

  function isDefensibleRfsMatch(incident, rfs, km) {
    if (!isCurrentRfsLifecycleMatch(incident, rfs)) return false;
    var textEvidence = hasIncidentLocationEvidence(incident, rfs);
    if (incident.coordinateAccuracy === 'exact') return km <= 5 && textEvidence;
    return km <= 25 && textEvidence;
  }

  function correlateIncidents(incidents, rfsIncidents, removedRfsIncidents) {
    (rfsIncidents || []).forEach(function (rfs) { rfs.pagerMatch = null; });
    (incidents || []).forEach(function (incident) {
      incident.rfsMatch = null;
      incident.rfsLifecycle = [];
      if (String(incident.agency || '').toUpperCase().indexOf('RFS') === -1) return;
      if (!incident.coordinates) return;
      (rfsIncidents || []).forEach(function (rfs) {
        var km = distanceKm({lat: incident.coordinates.lat, lng: incident.coordinates.lng}, {lat: rfs.latitude, lng: rfs.longitude});
        if (isDefensibleRfsMatch(incident, rfs, km) && (!incident.rfsMatch || km < incident.rfsMatch.distanceKm)) {
          incident.rfsMatch = {title: rfs.title, category: rfs.category, description: rfs.description, link: rfs.link, latitude: rfs.latitude, longitude: rfs.longitude, distanceKm: Math.round(km), firstSeenAt: rfs.firstSeenAt};
        }
      });
      if (incident.rfsMatch) {
        if (incident.rfsMatch.firstSeenAt) incident.rfsLifecycle.push({timestamp: incident.rfsMatch.firstSeenAt, label: 'Loaded into public RSS/ICON', state: 'loaded'});
        (rfsIncidents || []).forEach(function (rfs) {
          if (!rfs.pagerMatch && rfs.link && incident.rfsMatch.link && rfs.link === incident.rfsMatch.link && hasIncidentLocationEvidence(incident, rfs)) rfs.pagerMatch = {location: incident.location, agency: incident.agency, pageCount: incident.messages.length, latestMessage: incident.messages[0] && incident.messages[0].message, brigades: incident.brigades || [], timelineKey: (incident.details && incident.details.incidentId) || incident.location || ''};
        });
      } else {
        var removedMatch = null;
        (removedRfsIncidents || []).forEach(function (rfs) {
          var km = distanceKm({lat: incident.coordinates.lat, lng: incident.coordinates.lng}, {lat: rfs.latitude, lng: rfs.longitude});
          var pagerTime = incident.lastSeen ? incident.lastSeen.getTime() / 1000 : 0;
          var inLifecycleWindow = pagerTime >= Number(rfs.firstSeenAt || 0) - 21600 && pagerTime <= Number(rfs.removedAt || 0) + 21600;
          if (inLifecycleWindow && isDefensibleRfsMatch(incident, rfs, km) && (!removedMatch || km < removedMatch.distanceKm)) removedMatch = Object.assign({}, rfs, {distanceKm: km});
        });
        if (removedMatch) {
          incident.rfsLifecycle.push({timestamp: removedMatch.firstSeenAt, label: 'Loaded into public RSS/ICON', state: 'loaded'});
          incident.rfsLifecycle.push({timestamp: removedMatch.removedAt, label: 'Removed from public RSS/ICON', state: 'removed'});
        }
      }
    });
    return incidents;
  }

  function incidentKind(incident) {
    var text = String((incident.title || '') + ' ' + (incident.description || '')).toUpperCase();
    if (/MVA|MVC|VEHICLE|CAR |TRUCK|CRASH|COLLISION/.test(text)) return {kind: 'vehicle', icon: 'fa-car'};
    if (/FLOOD|WATER RESCUE|INUNDAT/.test(text)) return {kind: 'flood', icon: 'fa-water'};
    if (/TREE|BRANCH/.test(text)) return {kind: 'tree', icon: 'fa-tree'};
    if (/RESCUE|TRAPPED|MISSING PERSON/.test(text)) return {kind: 'rescue', icon: 'fa-life-ring'};
    if (/FIRE|BURN|SMOKE|BLAZE/.test(text)) return {kind: 'fire', icon: 'fa-fire'};
    return {kind: 'warning', icon: 'fa-exclamation'};
  }

  function humanDuration(seconds) {
    if (seconds === null || isNaN(seconds)) return 'Never';
    if (seconds < 60) return Math.floor(seconds) + ' sec ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' hr ago';
    return Math.floor(seconds / 86400) + ' day(s) ago';
  }

  function health(age, uptime) {
    var state = age === null ? 'quiet' : age < 3600 ? 'online' : age < 86400 ? 'quiet' : 'stale';
    var label = state === 'online' ? 'Receiver active' : state === 'quiet' ? 'Receiver quiet' : 'No recent traffic';
    return {state: state, label: label, lastSeen: humanDuration(age), uptime: humanDuration(uptime).replace(' ago', '')};
  }

  function receiverHealth(receiver) {
    var copy = Object.assign({}, receiver || {});
    var state = copy.state || 'offline';
    copy.statusLabel = state === 'online' ? 'Online' : state === 'stale' ? 'Beacon delayed' : 'Offline';
    copy.lastSeenLabel = copy.age === null || typeof copy.age === 'undefined' ? 'Never reported' : humanDuration(Number(copy.age));
    return copy;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mapIsAttached(element) {
    if (!map || !element) return false;
    try {
      return map.getContainer() === element &&
        document.documentElement.contains(element) &&
        !!element.querySelector('.leaflet-map-pane');
    } catch (err) {
      return false;
    }
  }

  function discardStaleMap() {
    if (map) {
      try { map.off(); map.remove(); } catch (err) {}
    }
    map = null;
    baseLayer = null;
    radarLayer = null;
    layerGroups = null;
  }

  function refreshMapLayout(redrawTiles) {
    if (!lastRender) return;
    var element = document.getElementById(lastRender.id);
    if (!element || element.offsetWidth === 0 || element.offsetHeight === 0) return;
    if (!mapIsAttached(element)) {
      discardStaleMap();
      renderMap(lastRender.id, lastRender.incidents, lastRender.rfsIncidents, lastRender.aircraft, lastRender.dams, lastRender.gauges, lastRender.algaeSites);
      return;
    }
    map.invalidateSize({pan: false, animate: false});
    if (redrawTiles && baseLayer) baseLayer.redraw();
  }

  function queueMapRecovery(redrawTiles) {
    window.clearTimeout(recoveryTimer);
    window.requestAnimationFrame(function () { refreshMapLayout(redrawTiles); });
    recoveryTimer = window.setTimeout(function () { refreshMapLayout(redrawTiles); }, 350);
  }

  function pagerPopup(incident) {
    var details = incident.details || {};
    var level = incident.rfsMatch && incident.rfsMatch.category || (incident.priority === 'critical' ? 'Critical' : incident.priority === 'high' ? 'High priority' : 'Pager incident');
    var hazard = incidentKind({title: details.title, category: details.type, description: details.subtype || details.description});
    var updated = incident.lastSeen instanceof Date ? incident.lastSeen.toLocaleString([], {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'}) : '';
    var units = (incident.brigades || []).slice();
    if (!units.length && details.unit) units.push(details.unit);
    if (!units.length && details.callsign) units.push(details.callsign);
    var chips = units.length ? '<div class="cw-popup-label">Units paged</div><div class="cw-popup-units">' + units.map(function(unit) { return '<span>' + escapeHtml(unit) + '</span>'; }).join('') + '</div>' : '';
    var timelineKey = details.incidentId || incident.location || '';
    return '<div class="cw-incident-popup">' +
      '<div class="cw-popup-heading"><i class="fa ' + hazard.icon + '"></i><strong>' + escapeHtml(String(level).toUpperCase()) + '</strong></div>' +
      '<div class="cw-popup-title">' + escapeHtml(details.title || incident.location || incident.agency || 'Pager incident') + '</div>' +
      '<div class="cw-popup-pills">' + (updated ? '<span><small>Updated</small>' + escapeHtml(updated) + '</span>' : '') + (details.incidentId ? '<span><small>Incident</small>' + escapeHtml(details.incidentId) + '</span>' : '') + '<span><small>Pages</small>' + incident.messages.length + '</span></div>' +
      (details.address ? '<div class="cw-popup-address"><i class="fa fa-map-marker-alt"></i>' + escapeHtml(details.address) + '</div>' : '') + chips +
      '<div class="cw-popup-agency">' + escapeHtml(incident.agency || 'Unknown agency') + '<small>' + (incident.coordinateAccuracy === 'exact' ? 'Coordinates supplied by pager' : incident.coordinateAccuracy === 'address' ? 'Position geocoded from address' : 'Approximate locality position') + '</small></div>' +
      '<a class="cw-popup-action" href="/?view=incidents&incident=' + encodeURIComponent(timelineKey) + '"><i class="fa fa-stream"></i> View full incident timeline</a></div>';
  }

  function renderMap(id, incidents, rfsIncidents, aircraft, dams, gauges, algaeSites) {
    if (!window.L) return;
    var features = window.CentralWestMapFeatures || {};
    var element = document.getElementById(id);
    if (!element) return;
    lastRender = {id: id, incidents: incidents || [], rfsIncidents: rfsIncidents || [], aircraft: aircraft || [], dams: dams || [], gauges: gauges || [], algaeSites: algaeSites || []};
    if (map && !mapIsAttached(element)) discardStaleMap();
    if (!map) {
      // Angular/PWA navigation can replace the map element without unloading this
      // script. Clear Leaflet's orphaned container id before rebuilding the map.
      if (element._leaflet_id) delete element._leaflet_id;
      map = L.map(element, {wheelDebounceTime: 80, wheelPxPerZoomLevel: mapWheelPxPerZoomLevel, zoomSnap: 0.5, zoomDelta: 0.5}).setView(mapCenter, mapInitialZoom);
      baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'}).addTo(map);
      layerGroups = {pager: L.layerGroup(), rfs: L.layerGroup(), forestry: L.layerGroup(), fireDanger: L.layerGroup(), hotspots: L.layerGroup(), aircraft: L.layerGroup(), dams: L.layerGroup(), gauges: L.layerGroup(), algae: L.layerGroup(), radar: L.layerGroup()};
      Object.keys(layerGroups).forEach(function (name) { if (layerEnabled(name)) layerGroups[name].addTo(map); });
      var overlays = {'Pager incidents': layerGroups.pager, 'NSW RFS / NPWS incidents': layerGroups.rfs};
      overlays['Forestry closures and notices'] = layerGroups.forestry;
      overlays['Fire danger districts'] = layerGroups.fireDanger;
      if (features.nasaFirms !== false) overlays['Satellite hotspots (NASA FIRMS)'] = layerGroups.hotspots;
      if (features.piaware !== false) overlays['Live aircraft'] = layerGroups.aircraft;
      if (features.waterNsw !== false) {
        overlays['WaterNSW dams'] = layerGroups.dams;
        overlays['River gauges'] = layerGroups.gauges;
        overlays['Algae alerts'] = layerGroups.algae;
      }
      if (features.weatherRadar !== false) overlays['Weather radar'] = layerGroups.radar;
      L.control.layers(null, overlays, {collapsed: true, position: 'topright'}).addTo(map);
      map.on('overlayadd overlayremove', saveLayerState);
      if (lastRadarEnabled && lastRadarConfig && lastRadarConfig.tileUrl && features.weatherRadar !== false) {
        radarLayer = L.tileLayer(lastRadarConfig.tileUrl, {opacity: Number(lastRadarConfig.opacity) || 0.62, maxNativeZoom: 7, maxZoom: 18, zIndex: 250, attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'});
        radarLayer.addTo(layerGroups.radar);
      }
    }
    ['pager', 'rfs', 'forestry', 'fireDanger', 'hotspots', 'aircraft', 'dams', 'gauges', 'algae'].forEach(function (name) { layerGroups[name].clearLayers(); });
    renderFireDangerLayer();
    (incidents || []).forEach(function (incident) {
      if (!incident.coordinates) return;
      if (hideTestPages && isTestPagerIncident(incident)) return;
      // A confirmed official match represents the same job. Keep its pager
      // details on the official marker instead of drawing a duplicate pin.
      if (incident.rfsMatch) return;
      L.marker([incident.coordinates.lat, incident.coordinates.lng]).addTo(layerGroups.pager).bindPopup(pagerPopup(incident), {maxWidth: 390, className: 'cw-popup-shell'});
    });
    (rfsIncidents || []).forEach(function (incident) {
      var hazard = incidentKind(incident);
      var severity = /emergency warning/i.test(incident.category) ? ' emergency' : /watch and act/i.test(incident.category) ? ' watch' : '';
      var incidentIcon = L.divIcon({className: 'cw-incident-marker cw-incident-' + hazard.kind + severity, html: '<span><i class="fa ' + hazard.icon + '"></i></span>', iconSize: [34, 31], iconAnchor: [17, 28]});
      var pagerUnits = incident.pagerMatch && incident.pagerMatch.brigades && incident.pagerMatch.brigades.length ? '<br><strong>Units paged:</strong> ' + incident.pagerMatch.brigades.map(escapeHtml).join(', ') : '';
      var pagerDetail = incident.pagerMatch && !(hideTestPages && /\b(?:TEST(?:ING)?|TEST\s+PAGE|TEST\s+MESSAGE|SYSTEM\s+UNDER\s+TEST|DRILL|TRAINING|EXERCISE)\b/i.test(String(incident.pagerMatch.latestMessage || ''))) ? '<hr><strong>Matching pager traffic</strong><br>' + escapeHtml(incident.pagerMatch.location || incident.pagerMatch.agency) + '<br>' + incident.pagerMatch.pageCount + ' page(s)' + pagerUnits + '<br>' + escapeHtml(incident.pagerMatch.latestMessage) : '';
      var npwsDetail = incident.npwsMatches && incident.npwsMatches.length ? '<div class="cw-popup-source-match"><i class="fa fa-tree"></i><strong> Combined with NSW NPWS</strong><br>' + incident.npwsMatches.map(function(item) { return escapeHtml(item.title); }).join('<br>') + '</div>' : '';
      var officialPopup = '<div class="cw-incident-popup"><div class="cw-popup-heading"><i class="fa ' + hazard.icon + '"></i><strong>' + escapeHtml(String(incident.category || 'Official incident').toUpperCase()) + '</strong></div><div class="cw-popup-title">' + escapeHtml(incident.title) + '</div><div class="cw-popup-pills"><span><small>Status</small>' + escapeHtml(incident.category || 'Published') + '</span><span><small>Type</small>' + escapeHtml(hazard.kind) + '</span></div><div class="cw-popup-description">' + escapeHtml(incident.description || '') + '</div>' + npwsDetail + pagerDetail + '<div class="cw-popup-actions"><a href="/?view=incidents&incident=' + encodeURIComponent((incident.pagerMatch && incident.pagerMatch.timelineKey) || incident.title || incident.link || '') + '"><i class="fa fa-stream"></i> Timeline</a><a href="' + escapeHtml(incident.link) + '" target="_blank" rel="noopener">Official details</a></div></div>';
      L.marker([incident.latitude, incident.longitude], {icon: incidentIcon, zIndexOffset: 450}).addTo(layerGroups.rfs).bindPopup(officialPopup, {maxWidth: 390, className: 'cw-popup-shell'});
    });
    (forestryClosures || []).forEach(function(feature) {
      if (!feature || !feature.geometry) return;
      var title = feature.properties && feature.properties.title || 'Forestry closure or notice';
      L.geoJSON(feature, {style: {color: '#8b4f2b', weight: 2, opacity: .9, fillColor: '#c97a42', fillOpacity: .18}}).addTo(layerGroups.forestry).bindPopup('<div class="cw-incident-popup"><div class="cw-popup-heading"><i class="fa fa-tree"></i><strong>FORESTRY NOTICE</strong></div><div class="cw-popup-title">' + escapeHtml(title) + '</div><p>Forestry Corporation of NSW closure or access notice. Check the official notice before entering the area.</p><a class="cw-popup-action" href="https://www.forestrycorporation.com.au/visiting/closures" target="_blank" rel="noopener">View official closures</a></div>', {maxWidth: 360, className: 'cw-popup-shell'});
    });
    (satelliteHotspots || []).forEach(function(hotspot) {
      var confidence = String(hotspot.confidence || 'unknown');
      var colour = confidence === 'h' || confidence === 'high' ? '#d94335' : confidence === 'l' || confidence === 'low' ? '#f0a52b' : '#ef6c32';
      var popup = '<div class="cw-incident-popup cw-hotspot-popup"><div class="cw-popup-heading"><i class="fa fa-satellite"></i><strong>UNCONFIRMED SATELLITE HOTSPOT</strong></div><div class="cw-popup-title">NASA FIRMS thermal detection</div><div class="cw-popup-pills"><span><small>Detected</small>' + escapeHtml(hotspot.acquiredAt || 'Unknown') + '</span><span><small>Sensor</small>' + escapeHtml((hotspot.satellite || '') + ' ' + (hotspot.instrument || 'VIIRS')) + '</span></div><p>Satellite thermal anomaly only—not confirmation of a fire.</p><a class="cw-popup-action" href="https://firms.modaps.eosdis.nasa.gov/map/" target="_blank" rel="noopener">Open NASA FIRMS</a></div>';
      L.circleMarker([hotspot.latitude, hotspot.longitude], {radius: 7, color: '#fff', weight: 2, fillColor: colour, fillOpacity: .92}).addTo(layerGroups.hotspots).bindPopup(popup, {maxWidth: 360, className: 'cw-popup-shell'});
    });
    (dams || []).forEach(function (dam) {
      var colour = dam.possibleSpill ? '#bd3e4b' : dam.status === 'full' ? '#dc6b28' : dam.status === 'near-capacity' ? '#e49b21' : '#1683a6';
      var damSvg = '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="cw-dam-water" d="M3 22c3-2 5-2 8 0s5 2 8 0 5-2 10 0v5H3z"/><path class="cw-dam-wall" d="M8 7h16l3 15c-3-2-5-2-8 0s-5 2-8 0c-1.2-.8-2.3-1.2-3.4-1.3L8 7zm4 3v8m4-8v10m4-10v8"/></svg>';
      var icon = L.divIcon({className: 'cw-dam-marker' + (dam.possibleSpill ? ' cw-dam-spill' : ''), html: '<span style="--dam-colour:' + colour + '">' + damSvg + '</span>', iconSize: [34, 34], iconAnchor: [17, 17]});
      var status = dam.status === 'level-unavailable' ? 'Current level is not published in the public feed' : dam.possibleSpill ? 'Possible spill/release - verify with the operator' : dam.status === 'full' ? 'At published capacity' : dam.status === 'near-capacity' ? 'Near capacity' : 'Normal storage range';
      var trend = dam.dailyChange === null || typeof dam.dailyChange === 'undefined' ? '' : '<br>Since yesterday: ' + (dam.dailyChange > 0 ? '+' : '') + Number(dam.dailyChange).toFixed(2) + ' percentage points';
      var storage = dam.percentage === null ? 'Capacity: ' + Math.round(Number(dam.capacityMl)).toLocaleString() + ' ML' : 'Storage: ' + Number(dam.percentage).toFixed(2) + '% (' + Math.round(Number(dam.volumeMl)).toLocaleString() + ' ML)' + trend + '<br>Observed: ' + (dam.observedAt || 'Unavailable') + (dam.observedAt ? ' AEST' : '');
      var algae = '';
      if (dam.algaeAlert) {
        var damAlgaeSitesHtml = (dam.algaeAlert.sites || []).map(function (site) {
          return '<br><strong>' + escapeHtml(site.status || 'Unknown') + ':</strong> ' + escapeHtml(site.name || site.siteCode || 'Monitoring site') + (site.species ? ' · ' + escapeHtml(site.species) : '') + (site.comments ? '<br><small>' + escapeHtml(site.comments) + '</small>' : '');
        }).join('');
        algae = '<hr><strong>Nearby algae monitoring: ' + escapeHtml(dam.algaeAlert.status) + '</strong><br>' + escapeHtml(dam.algaeAlert.siteCount) + ' site(s)' + (dam.algaeAlert.types ? '<br>Published algae: ' + escapeHtml(dam.algaeAlert.types) : '') + damAlgaeSitesHtml + '<br><a href="https://www.waternsw.com.au/water-services/water-quality/algae-alerts" target="_blank" rel="noopener">Official algae alert map</a>';
      }
      L.marker([dam.latitude, dam.longitude], {icon: icon, zIndexOffset: 350}).addTo(layerGroups.dams).bindPopup('<strong>' + escapeHtml(dam.name) + '</strong><br>' + escapeHtml(storage).replace(/&lt;br&gt;/g, '<br>') + '<br><strong>' + escapeHtml(status) + '</strong>' + algae + '<br>' + escapeHtml(dam.operator || 'WaterNSW') + '<br><a href="' + escapeHtml(dam.link) + '" target="_blank" rel="noopener">Official information</a>', {maxWidth: 380});
    });
    (gauges || []).forEach(function (gauge) {
      var level = gauge.readings && gauge.readings.StreamWaterLevel;
      var flow = gauge.readings && gauge.readings.FlowRate;
      var details = (level ? 'River level: <strong>' + escapeHtml(level.value) + ' ' + escapeHtml(level.unit) + '</strong><br>' : '') + (flow ? 'Flow: <strong>' + escapeHtml(flow.value) + ' ' + escapeHtml(flow.unit) + '</strong><br>' : '');
      var popup = '<strong>' + escapeHtml(gauge.name) + '</strong><br>' + escapeHtml(gauge.position) + '<br>' + details + 'Observed: ' + escapeHtml(gauge.observedAt || 'Unavailable') + (gauge.observedAt ? ' AEST' : '') + '<br><small>' + escapeHtml(gauge.quality || 'WaterNSW telemetry') + '</small>';
      L.circleMarker([gauge.latitude, gauge.longitude], {radius: 6, color: '#fff', weight: 1.5, fillColor: '#7249a8', fillOpacity: .92, className: 'cw-river-gauge-marker'}).addTo(layerGroups.gauges).bindPopup(popup);
    });
    (algaeSites || []).forEach(function (site) {
      var colours = {Green: '#2c9b59', Amber: '#e49b21', Red: '#bd3e4b'};
      var colour = colours[site.status] || '#778894';
      var popup = '<strong>' + escapeHtml(site.name) + '</strong><br>Algae alert: <strong>' + escapeHtml(site.status) + '</strong><br>Site ' + escapeHtml(site.siteCode) + (site.dominantToxicSpecies ? '<br>Dominant toxic species: ' + escapeHtml(site.dominantToxicSpecies) : '') + (site.comments ? '<br>' + escapeHtml(site.comments) : '') + '<br><a href="https://www.waternsw.com.au/water-services/water-quality/algae-alerts" target="_blank" rel="noopener">Official WaterNSW alert map</a>';
      L.circleMarker([site.latitude, site.longitude], {radius: site.status === 'Red' ? 10 : 8, color: '#fff', weight: 2, fillColor: colour, fillOpacity: .95, className: 'cw-algae-marker cw-algae-' + String(site.status || '').toLowerCase()}).addTo(layerGroups.algae).bindPopup(popup);
    });
    (aircraft || []).forEach(function (plane) {
      var emergency = plane.emergency && plane.emergency !== 'none';
      var label = plane.fireCallsign || plane.flight || plane.registration || plane.hex || 'Aircraft';
      var kind = aircraftKind(plane);
      var icon = L.divIcon({className: 'cw-aircraft-marker cw-aircraft-' + kind + (plane.fireAircraft ? ' cw-aircraft-fire' : '') + (emergency ? ' cw-plane-emergency' : ''), html: aircraftSvg(kind, plane.track), iconSize: [32, 32], iconAnchor: [16, 16]});
      var fireInfo = plane.fireAircraft ? '<br><strong>Fire aviation asset</strong>' + (plane.fireRole ? '<br>Role: ' + escapeHtml(plane.fireRole) : '') + (plane.fireManufacturer ? '<br>Manufacturer: ' + escapeHtml(plane.fireManufacturer) : '') + (plane.fireModel ? '<br>Model: ' + escapeHtml(plane.fireModel) : '') + '<br><small>Matched using ' + escapeHtml(plane.fireMatchSource || 'aircraft identity') + '</small>' : ((plane.aircraftManufacturer || plane.aircraftModel || plane.aircraftOperator) ? '<br>' + (plane.aircraftManufacturer ? escapeHtml(plane.aircraftManufacturer) + ' ' : '') + escapeHtml(plane.aircraftModel || '') + (plane.aircraftOperator ? '<br>Operator: ' + escapeHtml(plane.aircraftOperator) : '') : '');
      L.marker([plane.latitude, plane.longitude], {icon: icon, zIndexOffset: plane.fireAircraft ? 650 : 500}).addTo(layerGroups.aircraft).bindPopup('<strong>' + escapeHtml(label) + '</strong>' + (plane.fireCallsign && plane.flight && plane.fireCallsign !== plane.flight ? '<br>Transmitted callsign: ' + escapeHtml(plane.flight) : '') + '<br>Registration: ' + escapeHtml(plane.registration || 'Unknown') + '<br>Class: ' + escapeHtml(kind.replace(/-/g, ' ')) + '<br>ICAO type: ' + escapeHtml(plane.aircraftType || 'Unknown') + fireInfo + '<br>Altitude: ' + escapeHtml(plane.altitude === null ? 'Unknown' : plane.altitude + ' ft') + '<br>Ground speed: ' + escapeHtml(plane.speed === null ? 'Unknown' : plane.speed + ' kt') + '<br>Track: ' + escapeHtml(plane.track === null ? 'Unknown' : plane.track + '°') + '<br>Seen: ' + escapeHtml(plane.seen) + ' sec ago');
    });
    queueMapRecovery(false);
  }

  function setRadar(id, config, enabled) {
    if (!window.L) return;
    lastRadarConfig = config || null;
    lastRadarEnabled = !!enabled;
    if (radarLayer) {
      layerGroups.radar.removeLayer(radarLayer);
      radarLayer = null;
    }
    if (!config || !config.tileUrl || !enabled || !map) return;
    radarLayer = L.tileLayer(config.tileUrl, {opacity: Number(config.opacity) || 0.62, maxNativeZoom: 7, maxZoom: 18, zIndex: 250, attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'});
    radarLayer.addTo(layerGroups.radar);
  }

  function setSatelliteHotspots(hotspots) {
    satelliteHotspots = Array.isArray(hotspots) ? hotspots : [];
    if (lastRender) renderMap(lastRender.id, lastRender.incidents, lastRender.rfsIncidents, lastRender.aircraft, lastRender.dams, lastRender.gauges, lastRender.algaeSites);
  }

  window.addEventListener('resize', function () { queueMapRecovery(false); });
  window.addEventListener('online', function () { queueMapRecovery(true); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) queueMapRecovery(true);
  });

  function aircraftKind(plane) {
    var category = String(plane.category || '').toUpperCase();
    var type = String(plane.aircraftType || '').toUpperCase();
    var role = String(plane.fireRole || '').toUpperCase();
    if (plane.fireAircraft && /\bRW\b|HELICOPTER/.test(role)) return 'fire-helicopter';
    if (plane.fireAircraft && /SEAT|LAT|FIREBOMB/.test(role)) return 'air-tanker';
    if (plane.fireAircraft && /AAS|RECCE|BIRDDOG|FIRESPOTTER|LEAD/.test(role)) return 'air-attack';
    if (plane.fireAircraft) return 'fire-plane';
    if (category === 'A7' || /^(R22|R44|B06|B407|EC35|EC45|AS50|AS55|S76|A139|BK17|H125|H135|H145|H160|H175)/.test(type)) return 'helicopter';
    if (category === 'B1') return 'glider';
    if (category === 'B6') return 'drone';
    if (category === 'A5' || category === 'A4') return 'heavy';
    if (category === 'A6') return 'jet';
    return 'plane';
  }

  function aircraftSvg(kind, track) {
    var paths = {
      helicopter: '<path d="M3 11h7l2-3h5l2 3h2v2h-7l-2 5h-2l1-5H3zm8-5V3h2v3h5v1H6V6z"/>',
      'fire-helicopter': '<path d="M3 11h7l2-3h5l2 3h2v2h-7l-2 5h-2l1-5H3zm8-5V3h2v3h5v1H6V6zm9 10c1.5 1.6 1.5 3.1 0 4.4-1.5-1.3-1.5-2.8 0-4.4z"/>',
      'air-tanker': '<path d="M12 2l2.2 7.2L22 12v2.5l-7.7-.9-1 5.7 3.2 2.2V23L12 21.8 7.5 23v-1.5l3.2-2.2-1-5.7-7.7.9V12l7.8-2.8zM5 16h3v2H5zm11 0h3v2h-3z"/>',
      'air-attack': '<path d="M12 2l1.7 7.6L22 13v2l-8-1.4-.8 6 3 2V23L12 22l-4.2 1v-1.4l3-2-.8-6L2 15v-2l8.3-3.4zM4 7h5v1H4zm11 0h5v1h-5z"/>',
      'fire-plane': '<path d="M12 2l2 8 8 3v2l-8-1-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-8 1v-2l8-3zm7 15c1.3 1.4 1.3 2.7 0 3.9-1.3-1.2-1.3-2.5 0-3.9z"/>',
      glider: '<path d="M12 2l1.4 7 8.6 3-8.6 1.4L12 22l-1.4-8.6L2 12l8.6-3z"/>',
      drone: '<path d="M7 9h10v6H7zM3 5h6v2H3zm12 0h6v2h-6zM3 17h6v2H3zm12 0h6v2h-6zM6 7l3 3m9-3-3 3M6 17l3-3m9 3-3-3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      heavy: '<path d="M12 2l2 7 8 4v2l-8-2-1 7 3 2v1l-4-1-4 1v-1l3-2-1-7-8 2v-2l8-4z"/>',
      jet: '<path d="M12 2l2 8 7 4v2l-7-2-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-7 2v-2l7-4z"/>',
      plane: '<path d="M12 2l2 8 8 3v2l-8-1-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-8 1v-2l8-3z"/>'
    };
    return '<svg class="cw-aircraft-svg" viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(' + Number(track || 0) + 'deg)">' + paths[kind] + '</svg>';
  }

  function setForestryClosures(features) { forestryClosures = features || []; queueMapRecovery(false); }
  window.CentralWestAlerts = {decorateMessage: decorateMessage, parsePagerIncident: parsePagerIncident, groupIncidents: groupIncidents, unknownCapcodes: unknownCapcodes, correlateIncidents: correlateIncidents, health: health, receiverHealth: receiverHealth, renderMap: renderMap, setRadar: setRadar, setSatelliteHotspots: setSatelliteHotspots, setForestryClosures: setForestryClosures};
})(window);
