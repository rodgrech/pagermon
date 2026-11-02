var fs = require('fs');

function createService(options) {
  var axios = options.axios;
  var logger = options.logger;
  var cacheFile = options.cacheFile;
  var cache = {};
  var pending = {};
  var minute = {started: 0, count: 0};
  var day = {started: 0, count: 0};
  var retryAt = 0;
  try {
    var saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache = saved.cache || {};
    day = saved.day || day;
    retryAt = Number(saved.retryAt) || 0;
  } catch (error) { /* A fresh installation has no metadata cache. */ }

  function persist() {
    try { fs.writeFileSync(cacheFile, JSON.stringify({cache: cache, day: day, retryAt: retryAt})); }
    catch (error) { logger.warn('Unable to persist aircraft metadata cache: ' + error.message); }
  }

  function get(hex) {
    var key = String(hex || '').toUpperCase();
    if (!/^[A-F0-9]{6}$/.test(key)) return Promise.resolve({});
    var now = Date.now();
    var cached = cache[key];
    if (cached && now - cached.fetchedAt < (cached.missing ? 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000)) return Promise.resolve(cached.data);
    if (pending[key]) return pending[key];
    if (now - minute.started >= 60 * 1000) minute = {started: now, count: 0};
    if (now - day.started >= 24 * 60 * 60 * 1000) day = {started: now, count: 0};
    if (now < retryAt || minute.count >= 30 || day.count >= 500) return Promise.resolve(cached ? cached.data : {});
    minute.count++;
    day.count++;
    persist();
    pending[key] = axios.get('https://hexdb.io/api/v1/aircraft/' + key, {timeout: 4000}).then(function(response) {
      var data = response.data || {};
      var result = {registration: data.Registration || '', aircraftType: data.ICAOTypeCode || '', aircraftModel: data.Type || '', aircraftManufacturer: data.Manufacturer || '', aircraftOperator: data.RegisteredOwners || ''};
      cache[key] = {fetchedAt: Date.now(), data: result, missing: false};
      persist();
      return result;
    }).catch(function(error) {
      var status = error.response && error.response.status;
      if (status === 429) {
        var headers = error.response.headers || {};
        var retryAfter = Number(headers['retry-after']);
        var retryDate = Date.parse(String(headers['retry-after'] || ''));
        var reset = Number(headers['x-ratelimit-reset']);
        var delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 :
          Number.isFinite(retryDate) ? retryDate - Date.now() :
          Number.isFinite(reset) && reset > 0 ? (reset < 1e12 ? reset * 1000 : reset) - Date.now() : 15 * 60 * 1000;
        retryAt = Date.now() + Math.min(Math.max(delay, 60 * 1000), 60 * 60 * 1000);
        logger.warn('Aircraft metadata provider rate limited requests');
      }
      if (status !== 429) cache[key] = {fetchedAt: Date.now(), data: cached ? cached.data : {}, missing: true};
      persist();
      return cached ? cached.data : {};
    }).finally(function() { delete pending[key]; });
    return pending[key];
  }

  return {get: get};
}

module.exports = {createService: createService};
