var fs = require('fs');
var WebSocket = require('ws');

var MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];

function coordinate(value, fallback, minimum, maximum) {
  var number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function settings(config) {
  var south = coordinate(config.southLatitude, -34.5, -90, 90);
  var north = coordinate(config.northLatitude, -31.5, -90, 90);
  var west = coordinate(config.westLongitude, 150.5, -180, 180);
  var east = coordinate(config.eastLongitude, 153, -180, 180);
  if (north <= south || east <= west || north - south > 10 || east - west > 10) return null;
  return {south: south, north: north, west: west, east: east};
}

function createService(options) {
  var Socket = options.WebSocket || WebSocket;
  var logger = options.logger;
  var cacheFile = options.cacheFile;
  var vessels = new Map();
  var socket = null;
  var reconnectTimer = null;
  var signature = '';
  var active = false;
  var connected = false;
  var retryCount = 0;
  var lastSaved = 0;
  var lastMessage = 0;
  var bounds = null;
  var key = '';
  try {
    var saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    (saved.vessels || []).forEach(function (vessel) {
      if (vessel && /^\d{9}$/.test(String(vessel.mmsi)) && Number.isFinite(Number(vessel.updatedAt))) vessels.set(String(vessel.mmsi), vessel);
    });
  } catch (error) { /* Empty cache on first use. */ }

  function persist() {
    if (Date.now() - lastSaved < 60000) return;
    lastSaved = Date.now();
    fs.writeFile(cacheFile, JSON.stringify({vessels: Array.from(vessels.values())}), function (error) {
      if (error && logger) logger.warn('Unable to persist AIS Stream cache: ' + error.message);
    });
  }

  function processMessage(raw) {
    var envelope;
    try { envelope = JSON.parse(String(raw)); } catch (error) { return; }
    var type = envelope.MessageType;
    if (type === 'SubscriptionConfirmation') {
      connected = true;
      retryCount = 0;
      return;
    }
    if (MESSAGE_TYPES.indexOf(type) === -1) return;
    var metadata = envelope.MetaData || {};
    var message = (envelope.Message || {})[type] || {};
    var mmsi = String(metadata.MMSI || message.UserID || '');
    if (!/^\d{9}$/.test(mmsi)) return;
    var existing = vessels.get(mmsi) || {mmsi: mmsi};
    var name = String(metadata.ShipName || message.Name || message.NameExtension || '').trim();
    if (name) existing.name = name.slice(0, 100);
    if (message.CallSign) existing.callsign = String(message.CallSign).trim().slice(0, 30);
    if (message.Type != null) existing.shipType = Number(message.Type);
    var latitude = Number(metadata.Latitude != null ? metadata.Latitude : message.Latitude);
    var longitude = Number(metadata.Longitude != null ? metadata.Longitude : message.Longitude);
    var positionType = /PositionReport$/.test(type);
    if (positionType && message.Valid !== false && Number.isFinite(latitude) && Number.isFinite(longitude) &&
        latitude >= bounds.south && latitude <= bounds.north && longitude >= bounds.west && longitude <= bounds.east) {
      existing.latitude = latitude;
      existing.longitude = longitude;
      if (Number.isFinite(Number(message.Sog)) && Number(message.Sog) >= 0 && Number(message.Sog) < 102.3) existing.speed = Number(message.Sog);
      if (Number.isFinite(Number(message.Cog)) && Number(message.Cog) >= 0 && Number(message.Cog) < 360) existing.course = Number(message.Cog);
      existing.updatedAt = Date.now();
      lastMessage = existing.updatedAt;
    }
    vessels.set(mmsi, existing);
    if (vessels.size > 2000) {
      var oldest = Array.from(vessels.values()).sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); }).slice(0, 500);
      oldest.forEach(function (vessel) { vessels.delete(vessel.mmsi); });
    }
    persist();
  }

  function closeSocket() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connected = false;
    if (socket) {
      var previous = socket;
      socket = null;
      previous.removeAllListeners();
      previous.close();
    }
  }

  function connect() {
    if (!active || socket || reconnectTimer) return;
    try {
      socket = new Socket('wss://stream.aisstream.io/v0/stream', {perMessageDeflate: true, handshakeTimeout: 10000});
    } catch (error) {
      scheduleReconnect();
      return;
    }
    var current = socket;
    current.on('open', function () {
      if (current !== socket) return;
      current.send(JSON.stringify({
        APIKey: key,
        BoundingBoxes: [[[bounds.north, bounds.west], [bounds.south, bounds.east]]],
        FilterMessageTypes: MESSAGE_TYPES
      }));
    });
    current.on('message', processMessage);
    current.on('error', function () { /* Close event handles reconnect. Never log credentials. */ });
    current.on('close', function () {
      if (current !== socket) return;
      socket = null;
      connected = false;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (!active || reconnectTimer) return;
    var delay = Math.min(300000, 5000 * Math.pow(2, Math.min(retryCount++, 6))) + Math.floor(Math.random() * 2000);
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function configure(config) {
    config = config || {};
    var nextBounds = settings(config);
    var nextKey = String(config.apiKey || '').trim();
    var enabled = config.enabled === true && !!nextKey && !!nextBounds;
    var nextSignature = enabled ? [nextKey, nextBounds.south, nextBounds.north, nextBounds.west, nextBounds.east].join('|') : '';
    if (signature !== nextSignature) {
      closeSocket();
      signature = nextSignature;
      retryCount = 0;
    }
    active = enabled;
    bounds = nextBounds;
    key = nextKey;
    if (active) connect();
    return enabled;
  }

  function snapshot() {
    var now = Date.now();
    var list = Array.from(vessels.values()).filter(function (vessel) {
      return bounds && vessel.updatedAt && now - vessel.updatedAt <= 30 * 60 * 1000 &&
        vessel.latitude >= bounds.south && vessel.latitude <= bounds.north &&
        vessel.longitude >= bounds.west && vessel.longitude <= bounds.east;
    }).sort(function (a, b) { return b.updatedAt - a.updatedAt; }).slice(0, 500);
    return {source: 'AIS Stream', experimental: true, connected: connected, stale: !connected || now - lastMessage > 5 * 60 * 1000,
      vessels: list};
  }

  return {configure: configure, snapshot: snapshot, processMessage: processMessage};
}

module.exports = {createService: createService, settings: settings};
