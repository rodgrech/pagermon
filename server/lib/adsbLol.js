var fs = require('fs');

function bounded(value, fallback, minimum, maximum) {
  var number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

function retryDelay(headers, now) {
  var raw = headers && (headers['retry-after'] || headers['x-ratelimit-reset']);
  var seconds = Number(raw);
  var date = Date.parse(String(raw || ''));
  var delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(date) ? date - now : 15 * 60 * 1000;
  return bounded(delay, 15 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
}

function createService(options) {
  var axios = options.axios;
  var logger = options.logger;
  var cacheFile = options.cacheFile;
  var state = {fetchedAt: 0, signature: '', data: null};
  var pending = null;
  var retryAt = 0;
  try {
    var saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (saved && saved.data && Array.isArray(saved.data.aircraft)) state = saved;
  } catch (error) { /* First request will populate the cache. */ }

  function get(config) {
    var lat = bounded(config.latitude, -32.65, -90, 90);
    var lon = bounded(config.longitude, 149.58, -180, 180);
    var radius = Math.round(bounded(config.radiusNm, 100, 1, 250));
    var cacheMs = Math.round(bounded(config.cacheSeconds, 300, 10, 3600)) * 1000;
    var maximumAge = bounded(config.maximumAgeSeconds, 120, 5, 300);
    var signature = [lat, lon, radius, maximumAge].join('|');
    var now = Date.now();
    if (state.data && state.signature === signature && now - state.fetchedAt < cacheMs) return Promise.resolve(state.data);
    if (pending && pending.signature === signature) return pending.promise;
    if (now < retryAt) return Promise.resolve(fallback(signature));

    var url = 'https://api.adsb.lol/v2/lat/' + lat + '/lon/' + lon + '/dist/' + radius;
    var request = axios.get(url, {timeout: 10000, headers: {'Accept': 'application/json', 'User-Agent': 'Central West Alerts aircraft map'}}).then(function(response) {
      var body = response.data || {};
      if (!Array.isArray(body.ac)) throw new Error('Unexpected aircraft response');
      var aircraft = body.ac.filter(function(item) {
        return item && item.lat != null && item.lon != null && item.seen != null &&
          Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)) && Number.isFinite(Number(item.seen)) &&
          Math.abs(Number(item.lat)) <= 90 && Math.abs(Number(item.lon)) <= 180 && Number(item.seen) <= maximumAge;
      }).map(function(item) {
        return {
          hex: String(item.hex || ''), flight: String(item.flight || '').trim(), registration: String(item.r || ''),
          aircraftType: String(item.t || ''), latitude: Number(item.lat), longitude: Number(item.lon),
          altitude: item.alt_baro === 'ground' ? 'ground' : (item.alt_baro != null && Number.isFinite(Number(item.alt_baro)) ? Number(item.alt_baro) : null),
          speed: item.gs != null && Number.isFinite(Number(item.gs)) ? Number(item.gs) : null,
          track: item.track != null && Number.isFinite(Number(item.track)) ? Number(item.track) : null,
          category: String(item.category || ''), dbFlags: Number(item.dbFlags) || 0, seen: Number(item.seen) || 0
        };
      });
      var payload = {source: 'adsb.lol', fetchedAt: Math.floor(Date.now() / 1000), stale: false, unavailable: false, aircraft: aircraft};
      state = {fetchedAt: Date.now(), signature: signature, data: payload};
      retryAt = 0;
      fs.writeFile(cacheFile, JSON.stringify(state), function(error) {
        if (error) logger.warn('Unable to persist adsb.lol aircraft cache: ' + error.message);
      });
      return payload;
    }).catch(function(error) {
      var status = error.response && error.response.status;
      retryAt = Date.now() + (status === 429 ? retryDelay(error.response.headers, Date.now()) : 60 * 1000);
      logger.warn('adsb.lol aircraft feed unavailable (HTTP ' + (status || 'network') + ')');
      return fallback(signature);
    }).finally(function() { pending = null; });
    pending = {signature: signature, promise: request};
    return request;
  }

  function fallback(signature) {
    var data = state.signature === signature && state.data ? state.data : {source: 'adsb.lol', fetchedAt: 0, aircraft: []};
    return Object.assign({}, data, {stale: true, unavailable: true, retryAt: Math.floor(retryAt / 1000)});
  }

  return {get: get};
}

module.exports = {createService: createService};
