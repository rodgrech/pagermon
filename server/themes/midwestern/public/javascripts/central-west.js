(function (window) {
  'use strict';

  var towns = [
    ['Mudgee', -32.5943, 149.5871], ['Gulgong', -32.3627, 149.5325],
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
  var radarLayer;
  var layerGroups;

  function layerEnabled(name) {
    try { return JSON.parse(localStorage.getItem('cw-map-layers') || '{}')[name] !== false; }
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
    if (/PERSONS? TRAPPED|ENTRAP|STRUCTURE FIRE|HOUSE FIRE|RESCUE REQUIRED|MAYDAY|LIFE THREAT|EMERGENCY/.test(text)) return 'critical';
    if (/MVA|MVC|GRASS FIRE|BUSH FIRE|FLOOD RESCUE|MISSING PERSON|HAZMAT|URGENT|ASSIST AMBULANCE/.test(text)) return 'high';
    if (/TREE DOWN|FLOOD|STORM|SMOKE|ALARM|BACKUP|ASSIST|INCIDENT/.test(text)) return 'medium';
    return 'routine';
  }

  function location(text) {
    text = String(text || '').toLowerCase();
    for (var i = 0; i < towns.length; i++) {
      if (text.indexOf(towns[i][0].toLowerCase()) !== -1) return {name: towns[i][0], lat: towns[i][1], lng: towns[i][2]};
    }
    return null;
  }

  function decorateMessage(message) {
    message.cwPriority = priority(message.message);
    message.cwLocation = location(message.message + ' ' + (message.alias || ''));
    return message;
  }

  function groupIncidents(messages) {
    var groups = {};
    (messages || []).forEach(function (message) {
      decorateMessage(message);
      var bucket = Math.floor(Number(message.timestamp) / 10800);
      var loc = message.cwLocation ? message.cwLocation.name : '';
      var key = (message.agency || 'unknown') + '|' + (loc || message.address || 'unknown') + '|' + bucket;
      if (!groups[key]) groups[key] = {agency: message.agency, location: loc, coordinates: message.cwLocation, priority: message.cwPriority, messages: [], lastSeen: new Date(Number(message.timestamp) * 1000)};
      groups[key].messages.push(message);
      if (['routine', 'medium', 'high', 'critical'].indexOf(message.cwPriority) > ['routine', 'medium', 'high', 'critical'].indexOf(groups[key].priority)) groups[key].priority = message.cwPriority;
    });
    return Object.keys(groups).map(function (key) { return groups[key]; }).sort(function (a, b) { return b.lastSeen - a.lastSeen; }).slice(0, 50);
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

  function correlateIncidents(incidents, rfsIncidents) {
    (rfsIncidents || []).forEach(function (rfs) { rfs.pagerMatch = null; });
    (incidents || []).forEach(function (incident) {
      incident.rfsMatch = null;
      if (!incident.coordinates) return;
      (rfsIncidents || []).forEach(function (rfs) {
        var km = distanceKm({lat: incident.coordinates.lat, lng: incident.coordinates.lng}, {lat: rfs.latitude, lng: rfs.longitude});
        if (km <= 25 && (!incident.rfsMatch || km < incident.rfsMatch.distanceKm)) {
          incident.rfsMatch = {title: rfs.title, category: rfs.category, description: rfs.description, link: rfs.link, latitude: rfs.latitude, longitude: rfs.longitude, distanceKm: Math.round(km)};
        }
      });
      if (incident.rfsMatch) {
        (rfsIncidents || []).forEach(function (rfs) {
          if (rfs.link === incident.rfsMatch.link) rfs.pagerMatch = {location: incident.location, agency: incident.agency, pageCount: incident.messages.length, latestMessage: incident.messages[0] && incident.messages[0].message};
        });
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

  function escapeHtml(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMap(id, incidents, rfsIncidents, aircraft, dams, gauges, algaeSites) {
    if (!window.L) return;
    var element = document.getElementById(id);
    if (!element) return;
    if (!map) {
      map = L.map(id).setView([-32.65, 149.58], 8);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'}).addTo(map);
      layerGroups = {pager: L.layerGroup(), rfs: L.layerGroup(), aircraft: L.layerGroup(), dams: L.layerGroup(), gauges: L.layerGroup(), algae: L.layerGroup(), radar: L.layerGroup()};
      Object.keys(layerGroups).forEach(function (name) { if (layerEnabled(name)) layerGroups[name].addTo(map); });
      L.control.layers(null, {'Pager incidents': layerGroups.pager, 'NSW RFS incidents': layerGroups.rfs, 'Live aircraft': layerGroups.aircraft, 'WaterNSW dams': layerGroups.dams, 'River gauges': layerGroups.gauges, 'Algae alerts': layerGroups.algae, 'Weather radar': layerGroups.radar}, {collapsed: true, position: 'topright'}).addTo(map);
      map.on('overlayadd overlayremove', saveLayerState);
    }
    ['pager', 'rfs', 'aircraft', 'dams', 'gauges', 'algae'].forEach(function (name) { layerGroups[name].clearLayers(); });
    (incidents || []).forEach(function (incident) {
      if (!incident.coordinates) return;
      var combined = incident.rfsMatch ? '<hr><strong>Official RFS incident</strong><br>' + escapeHtml(incident.rfsMatch.title) + '<br>' + escapeHtml(incident.rfsMatch.category) + '<br>' + escapeHtml(incident.rfsMatch.description || '') + '<br><a href="' + escapeHtml(incident.rfsMatch.link) + '" target="_blank" rel="noopener">View official incident</a>' : '';
      L.marker([incident.coordinates.lat, incident.coordinates.lng]).addTo(layerGroups.pager).bindPopup('<strong>' + escapeHtml(incident.location) + '</strong><br>' + escapeHtml(incident.agency || 'Unknown agency') + '<br>' + incident.messages.length + ' page(s)<br><em>Approximate pager-derived location</em>' + combined);
    });
    (rfsIncidents || []).forEach(function (incident) {
      var hazard = incidentKind(incident);
      var severity = /emergency warning/i.test(incident.category) ? ' emergency' : /watch and act/i.test(incident.category) ? ' watch' : '';
      var incidentIcon = L.divIcon({className: 'cw-incident-marker cw-incident-' + hazard.kind + severity, html: '<span><i class="fa ' + hazard.icon + '"></i></span>', iconSize: [34, 31], iconAnchor: [17, 28]});
      var pagerDetail = incident.pagerMatch ? '<hr><strong>Matching pager traffic</strong><br>' + escapeHtml(incident.pagerMatch.location || incident.pagerMatch.agency) + '<br>' + incident.pagerMatch.pageCount + ' page(s)<br>' + escapeHtml(incident.pagerMatch.latestMessage) : '';
      L.marker([incident.latitude, incident.longitude], {icon: incidentIcon, zIndexOffset: 450}).addTo(layerGroups.rfs).bindPopup('<strong>' + escapeHtml(incident.title) + '</strong><br>' + escapeHtml(incident.category) + '<br>' + escapeHtml(incident.description) + pagerDetail + '<br><a href="' + escapeHtml(incident.link) + '" target="_blank" rel="noopener">View on NSW RFS</a>');
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
      var label = plane.flight || plane.registration || plane.hex || 'Aircraft';
      var kind = aircraftKind(plane);
      var icon = L.divIcon({className: 'cw-aircraft-marker cw-aircraft-' + kind + (emergency ? ' cw-plane-emergency' : ''), html: aircraftSvg(kind, plane.track), iconSize: [32, 32], iconAnchor: [16, 16]});
      L.marker([plane.latitude, plane.longitude], {icon: icon, zIndexOffset: 500}).addTo(layerGroups.aircraft).bindPopup('<strong>' + escapeHtml(label) + '</strong><br>Class: ' + escapeHtml(kind) + '<br>ICAO type: ' + escapeHtml(plane.aircraftType || 'Unknown') + '<br>Altitude: ' + escapeHtml(plane.altitude === null ? 'Unknown' : plane.altitude + ' ft') + '<br>Ground speed: ' + escapeHtml(plane.speed === null ? 'Unknown' : plane.speed + ' kt') + '<br>Track: ' + escapeHtml(plane.track === null ? 'Unknown' : plane.track + '°') + '<br>Seen: ' + escapeHtml(plane.seen) + ' sec ago');
    });
    map.invalidateSize();
  }

  function setRadar(id, config, enabled) {
    if (!window.L || !config || !config.tileUrl) return;
    if (!map) renderMap(id, [], [], [], [], [], []);
    if (radarLayer) {
      layerGroups.radar.removeLayer(radarLayer);
      radarLayer = null;
    }
    if (enabled) {
      radarLayer = L.tileLayer(config.tileUrl, {opacity: 0.62, maxNativeZoom: 7, maxZoom: 18, zIndex: 250, attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'});
      radarLayer.addTo(layerGroups.radar);
    }
  }

  function aircraftKind(plane) {
    var category = String(plane.category || '').toUpperCase();
    var type = String(plane.aircraftType || '').toUpperCase();
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
      glider: '<path d="M12 2l1.4 7 8.6 3-8.6 1.4L12 22l-1.4-8.6L2 12l8.6-3z"/>',
      drone: '<path d="M7 9h10v6H7zM3 5h6v2H3zm12 0h6v2h-6zM3 17h6v2H3zm12 0h6v2h-6zM6 7l3 3m9-3-3 3M6 17l3-3m9 3-3-3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      heavy: '<path d="M12 2l2 7 8 4v2l-8-2-1 7 3 2v1l-4-1-4 1v-1l3-2-1-7-8 2v-2l8-4z"/>',
      jet: '<path d="M12 2l2 8 7 4v2l-7-2-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-7 2v-2l7-4z"/>',
      plane: '<path d="M12 2l2 8 8 3v2l-8-1-1 6 3 2v1l-4-1-4 1v-1l3-2-1-6-8 1v-2l8-3z"/>'
    };
    return '<svg class="cw-aircraft-svg" viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(' + Number(track || 0) + 'deg)">' + paths[kind] + '</svg>';
  }

  window.CentralWestAlerts = {decorateMessage: decorateMessage, groupIncidents: groupIncidents, unknownCapcodes: unknownCapcodes, correlateIncidents: correlateIncidents, health: health, renderMap: renderMap, setRadar: setRadar};
})(window);
