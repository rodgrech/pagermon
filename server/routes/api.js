var express = require('express');
var bodyParser = require('body-parser');
var router = express.Router();
var basicAuth = require('express-basic-auth');
var bcrypt = require('bcryptjs');
var util = require('util');
var _ = require('underscore');
var pluginHandler = require('../plugins/pluginHandler');
var logger = require('../log');
var db = require('../knex/knex.js');
var converter = require('json-2-csv');
var axios = require('axios');
var sqlite3 = require('sqlite3');
var path = require('path');
var fs = require('fs');
var net = require('net');
var webPushNotifications = require('../lib/webPush');

function returningId(result) {
  var first = Array.isArray(result) ? result[0] : result;
  return first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'id')
    ? first.id
    : first;
}

function redactAustralianPhoneNumbers(message) {
  if (typeof message !== 'string') return message;

  var phonePatterns = [
    /(^|[^\d])(?:\+61|0061)[\s().-]*4(?:[\s().-]*\d){8}(?!\d)/g,
    /(^|[^\d])04(?:[\s().-]*\d){8}(?!\d)/g,
    /(^|[^\d])(?:\+61|0061)[\s().-]*[2378](?:[\s().-]*\d){8}(?!\d)/g,
    /(^|[^\d])(?:0[\s.-]*[2378]|\(0[2378]\))(?:[\s().-]*\d){8}(?!\d)/g
  ];

  return phonePatterns.reduce(function (redacted, pattern) {
    return redacted.replace(pattern, '$1XXXXXXXXXX');
  }, message);
}

var nconf = require('nconf');

var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

router.use(bodyParser.json());       // to support JSON-encoded bodies
router.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));

const passport = require('../auth/local');
var authHelper = require('../middleware/authhelper')

router.use(function (req, res, next) {
  res.locals.login = req.isAuthenticated();
  res.locals.user = req.user || false;
  next();
});

// defaults
var initData = {};
initData.limit = nconf.get('messages:defaultLimit');
initData.replaceText = nconf.get('messages:replaceText');
initData.currentPage = 0;
initData.pageCount = 0;
initData.msgCount = 0;
initData.offset = 0;

// auth variables
var HideCapcode = nconf.get('messages:HideCapcode');
var apiSecurity = nconf.get('messages:apiSecurity');
var dbtype = nconf.get('database:type');

// dupe init
var msgBuffer = [];
var bomWarningCache = { fetchedAt: 0, data: null };
var rfsIncidentCache = { fetchedAt: 0, data: null };
var radarCache = { fetchedAt: 0, data: null };
var waterNswCache = { fetchedAt: 0, data: null };
var waterNswAttemptSlot = null;
var waterNswGaugeCache = { fetchedAt: 0, data: null };
var waterNswGaugeAttemptSlot = null;
var waterNswAlgaeCache = { fetchedAt: 0, data: null };
var receiverHeartbeatFile = path.join(path.dirname(fs.realpathSync(confFile)), 'receiver-heartbeats.json');
var receiverHeartbeats = {};
var centralWestGaugeMetadata = require('./central-west-gauges.json');
var waterNswCacheFile = path.resolve('/home/rodgrech/Applications/pagermon/server/cache/waternsw-dams.json');
var waterNswGaugeCacheFile = path.resolve('/home/rodgrech/Applications/pagermon/server/cache/waternsw-gauges.json');
try {
  receiverHeartbeats = JSON.parse(fs.readFileSync(receiverHeartbeatFile, 'utf8')) || {};
} catch (receiverHeartbeatError) {
  receiverHeartbeats = {};
}
try {
  var persistedDamData = JSON.parse(fs.readFileSync(waterNswCacheFile, 'utf8'));
  waterNswCache = { fetchedAt: Number(persistedDamData.fetchedAt || 0) * 1000, data: persistedDamData };
} catch (damCacheError) {
  // A successful API request will create the persistent cache.
}
try {
  var persistedGaugeData = JSON.parse(fs.readFileSync(waterNswGaugeCacheFile, 'utf8'));
  waterNswGaugeCache = { fetchedAt: Number(persistedGaugeData.fetchedAt || 0) * 1000, data: persistedGaugeData };
} catch (gaugeCacheError) {
  // A successful API request will create the persistent cache.
}
function integrationConfig(name, defaults) {
  nconf.load();
  return Object.assign({}, defaults || {}, nconf.get('integrations:' + name) || {});
}

function receiverDefinitions() {
  nconf.load();
  var config = nconf.get('monitoring:receiverMonitoring') || {};
  var definitions = {};
  (Array.isArray(config.remotes) ? config.remotes : []).forEach(function (receiver) {
    var id = String(receiver.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return;
    definitions[id] = {
      id: id,
      label: String(receiver.label || id).slice(0, 100),
      location: String(receiver.location || 'Remote receiver').slice(0, 100),
      frequency: String(receiver.frequency || '').slice(0, 100)
    };
  });
  return definitions;
}

function isPrivateReceiverAddress(address) {
  return /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(String(address || ''));
}

function receiverStatusList(nowSeconds) {
  var definitions = receiverDefinitions();
  return Object.keys(definitions).map(function (id) {
    var definition = definitions[id];
    var heartbeat = receiverHeartbeats[id] || {};
    var lastSeen = Number(heartbeat.lastSeen) || null;
    var age = lastSeen ? nowSeconds - lastSeen : null;
    return {
      id: definition.id,
      label: definition.label,
      location: definition.location,
      frequency: definition.frequency,
      state: age === null ? 'offline' : age <= 180 ? 'online' : age <= 600 ? 'stale' : 'offline',
      lastSeen: lastSeen,
      age: age,
      externalIp: net.isIP(String(heartbeat.externalIp || '')) ? heartbeat.externalIp : null,
      internalIp: net.isIP(String(heartbeat.internalIp || '')) ? heartbeat.internalIp : null
    };
  });
}

function configuredWaterSlot(timestamp, refreshHours) {
  var parts = sydneyDayParts(timestamp);
  var hours = String(refreshHours || '0,12').split(',').map(function (hour) {
    return parseInt(hour.trim(), 10);
  }).filter(function (hour) { return Number.isInteger(hour) && hour >= 0 && hour <= 23; }).sort(function (a, b) { return a - b; });
  if (!hours.length) hours = [0, 12];
  var selected = hours[0];
  hours.forEach(function (hour) { if (hour <= parts.hour) selected = hour; });
  return parts.key + '-' + String(selected).padStart(2, '0');
}

function keywordPattern(value) {
  var terms = String(value || '').split(',').map(function (term) { return term.trim(); }).filter(Boolean);
  if (!terms.length) return /$a/;
  return new RegExp(terms.map(function (term) { return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'i');
}

function isSessionUser(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'A logged-in PageMon session is required.' });
}

function sydneyDayParts(timestamp) {
  var parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
  var values = {};
  parts.forEach(function (part) { values[part.type] = part.value; });
  return { key: values.year + '-' + values.month + '-' + values.day, hour: Number(values.hour) };
}

function waterNswDateTime(timestamp) {
  var date = new Date(timestamp);
  var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  var values = {};
  parts.forEach(function (part) { values[part.type] = part.value; });
  return values.day + '-' + values.month + '-' + values.year + ' ' + values.hour + ':' + values.minute;
}

function radioAgency(groupLabel, tagLabel) {
  var source = String(groupLabel || '').trim();
  var tag = String(tagLabel || '').trim();
  if (/rural fire|\brfs\b/i.test(source + ' ' + tag)) return { name: 'NSW Rural Fire Service', code: 'rfs' };
  if (/fire and rescue|\bfrnsw\b/i.test(source + ' ' + tag)) return { name: 'Fire and Rescue NSW', code: 'frnsw' };
  if (/state emergency|\bses\b/i.test(source + ' ' + tag)) return { name: 'NSW State Emergency Service', code: 'ses' };
  if (/ambulance|\bnswas\b/i.test(source + ' ' + tag)) return { name: 'NSW Ambulance', code: 'ambulance' };
  if (/national parks|\bnpws\b/i.test(source + ' ' + tag)) return { name: 'NSW National Parks and Wildlife Service', code: 'npws' };
  if (/volunteer rescue|\bvra\b/i.test(source + ' ' + tag)) return { name: 'NSW Volunteer Rescue Association', code: 'vra' };
  if (source) return { name: source, code: 'other' };
  if (tag && !/^untagged$/i.test(tag)) return { name: tag, code: 'other' };
  return { name: '', code: 'unknown' };
}


router.route('/messages')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    console.time('init');
    var pdwMode = nconf.get('messages:pdwMode');
    var adminShow = nconf.get('messages:adminShow');
    var maxLimit = nconf.get('messages:maxLimit');
    var defaultLimit = nconf.get('messages:defaultLimit');
    var HideCapcode = nconf.get('messages:HideCapcode');

    initData.replaceText = nconf.get('messages:replaceText');
    if (typeof req.query.page !== 'undefined') {
      var page = parseInt(req.query.page, 10);
      if (page > 0) {
        initData.currentPage = page - 1;
      } else {
        initData.currentPage = 0;
      }
    }
    if (req.query.limit && req.query.limit <= maxLimit) {
      initData.limit = parseInt(req.query.limit, 10);
    } else {
      initData.limit = parseInt(defaultLimit, 10);
    }
    if (pdwMode) {
      if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
        var subquery = db.from('capcodes').where('ignore', '=', 1).select('id')
      } else {
        var subquery = db.from('capcodes').where('ignore', '=', 0).select('id')
      }
    } else {
      var subquery = db.from('capcodes').where('ignore', '=', 1).select('id')
    }
    db.from('messages').where(function () {
      if (pdwMode) {
        if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
          this.from('messages').where('alias_id', 'not in', subquery).orWhereNull('alias_id')
        } else {
          this.from('messages').where('alias_id', 'in', subquery)
        }
      } else {
        this.from('messages').where('alias_id', 'not in', subquery).orWhereNull('alias_id')
      }
    }).count('* as msgcount')
      .then(function (initcount) {
        var count = initcount[0]
        if (count) {
          initData.msgCount = count.msgcount;
          initData.pageCount = Math.ceil(initData.msgCount / initData.limit);
          if (initData.currentPage > initData.pageCount) {
            initData.currentPage = 0;
          }
          initData.offset = initData.limit * initData.currentPage;
          if (initData.offset < 0) {
            initData.offset = 0;
          }
          initData.offsetEnd = initData.offset + initData.limit;
          console.timeEnd('init');
          console.time('sql');

          var result = [];
          var rowCount

          db.from('messages')
            .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
            .modify(function (queryBuilder) {
              if (pdwMode) {
                if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
                  queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).orWhereNull('capcodes.ignore')
                } else {
                  queryBuilder.innerJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0)
                }
              } else {
                queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).orWhereNull('capcodes.ignore')
              }
            })
            .orderBy('messages.timestamp', 'desc')
            .limit(initData.limit)
            .offset(initData.offset)
            .then(rows => {
              rowCount = rows.length
              for (row of rows) {
                //outRow = JSON.parse(newrow);
                if (HideCapcode) {
                  if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role == 'user')) {
                    row = {
                      "id": row.id,
                      "message": row.message,
                      "source": row.source,
                      "timestamp": row.timestamp,
                      "alias_id": row.alias_id,
                      "alias": row.alias,
                      "agency": row.agency,
                      "icon": row.icon,
                      "color": row.color,
                      "ignore": row.ignore
                    };
                  }
                }
                if (row) {
                  result.push(row);
                } else {
                  logger.main.info('empty results');
                }
              }
            })
            .catch(err => {
              logger.main.error(err);
            })
            .finally(() => {
              if (rowCount > 0) {
                console.timeEnd('sql');
                //var limitResults = result.slice(initData.offset, initData.offsetEnd);
                console.time('send');
                res.status(200).json({ 'init': initData, 'messages': result });
                console.timeEnd('send');
              } else {
                res.status(200).json({ 'init': {}, 'messages': [] });
              }
            });
        }
      });
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    if (req.body.address && req.body.message) {
      var dbtype = nconf.get('database:type');
      var filterDupes = nconf.get('messages:duplicateFiltering');
      var dupeLimit = nconf.get('messages:duplicateLimit') || 0; // default 0
      var dupeTime = nconf.get('messages:duplicateTime') || 0; // default 0
      var pdwMode = nconf.get('messages:pdwMode');
      var adminShow = nconf.get('messages:adminShow');
      var data = req.body;
      data.pluginData = {};

      if (nconf.get('messages:redactPhoneNumbers')) {
        data.message = redactAustralianPhoneNumbers(data.message);
      }

      if (filterDupes) {
        // this is a bad solution and tech debt that will bite us in the ass if we ever go HA, but that's a problem for future me and that guy's a dick
        var datetime = data.datetime || 1;
        var timeDiff = datetime - dupeTime;
        // if duplicate filtering is enabled, we want to populate the message buffer and check for duplicates within the limits
        var matches = _.where(msgBuffer, { message: data.message, address: data.address });
        if (matches.length > 0) {
          if (dupeTime != 0) {
            // search the matching messages and see if any match the time constrain
            var timeFind = _.find(matches, function (msg) { return msg.datetime > timeDiff; });
            if (timeFind) {
              logger.main.info(util.format('Ignoring duplicate: %o', data.message));
              res.status(200);
              return res.send('Ignoring duplicate');
            }
          } else {
            // if no dupeTime then just end the search now, we have matches
            logger.main.info(util.format('Ignoring duplicate: %o', data.message));
            res.status(200);
            return res.send('Ignoring duplicate');
          }
        }
        // no matches, maintain the array
        var dupeArrayLimit = dupeLimit;
        if (dupeArrayLimit == 0) {
          dupeArrayLimit == 25; // should provide sufficient buffer, consider increasing if duplicates appear when users have no dupeLimit
        }
        if (msgBuffer.length > dupeArrayLimit) {
          msgBuffer.shift();
        }
        msgBuffer.push({ message: data.message, datetime: data.datetime, address: data.address });
      }

      // send data to pluginHandler before proceeding
      logger.main.debug('beforeMessage start');
      pluginHandler.handle('message', 'before', data, function (response) {
        logger.main.debug(util.format('%o', response));
        logger.main.debug('beforeMessage done');
        if (response && response.pluginData) {
          // only set data to the response if it's non-empty and still contains the pluginData object
          data = response;
        }
        if (data.pluginData.ignore) {
          // stop processing
          res.status(200);
          return res.send('Ignoring filtered');
        }
        var address = data.address || '0000000';
        var message = data.message || 'null';
        var datetime = data.datetime || 1;
        var timeDiff = datetime - dupeTime;
        var source = data.source || 'UNK';
        db.from('messages')
          .select('*')
          .modify(function (queryBuilder) {
            if ((dupeLimit != 0) && (dupeTime != 0)) {
              queryBuilder.where('id', 'in', function () {
                this.select('*')
                  //this wierd subquery is to keep mysql happy
                  .from(function () {
                    this.select('id')
                      .from('messages')
                      .where('timestamp', '>', timeDiff)
                      .orderBy('id', 'desc')
                      .limit(dupeLimit)
                      .as('temp_tab')
                  })
              })
                .andWhere('message', '=', message)
                .andWhere('address', '=', address)
            } else if ((dupeLimit != 0) && (dupeTime == 0)) {
              queryBuilder.where('id', 'in', function () {
                this.select('*')
                  //this wierd subquery is to keep mysql happy
                  .from(function () {
                    this.select('id')
                      .from('messages')
                      .orderBy('id', 'desc')
                      .limit(dupeLimit)
                      .as('temp_tab')
                  })
              })
                .andWhere('message', '=', message)
                .andWhere('address', '=', address)
            } else if ((dupeLimit == 0) && (dupeTime != 0)) {
              queryBuilder.where('id', 'in', function () {
                this.select('id')
                  .from('messages')
                  .where('timestamp', '>', timeDiff)
              })
                .andWhere('message', '=', message)
                .andWhere('address', '=', address)
            } else {
              queryBuilder.where('message', '=', message)
                .andWhere('address', '=', address)
            }
          })
          .then((row) => {
            if (row.length > 0 && filterDupes) {
              logger.main.info(util.format('Ignoring duplicate: %o', message));
              res.status(200);
              res.send('Ignoring duplicate');
            } else {
              db.from('capcodes')
                .select('id', 'ignore')
                // TODO: test this doesn't break other DBs - there's a lot of quote changes here
                .modify(function (queryBuilder) {
                  if (dbtype == 'oracledb') {
                    queryBuilder.whereRaw(`'${address}' LIKE "address"`)
                    queryBuilder.orderByRaw(`REPLACE("address", '_', '%') DESC`);
                  } else {
                    queryBuilder.whereRaw(`"${address}" LIKE address`)
                    queryBuilder.orderByRaw(`REPLACE(address, '_', '%') DESC`)
                  }
                })
                .then((row) => {
                  var insert;
                  var alias_id = null;
                  if (row.length > 0) {
                    row = row[0]
                    if (row.ignore == 1) {
                      insert = false;
                      logger.main.info('Ignoring filtered address: ' + address + ' alias: ' + row.id);
                    } else {
                      insert = true;
                      alias_id = row.id;
                    }
                  } else {
                    insert = true;
                  }

                  // overwrite alias_id if set from plugin
                  if (data.pluginData.aliasId) {
                    alias_id = data.pluginData.aliasId;
                  }

                  if (insert == true) {
                    var insertmsg = { address: address, message: message, timestamp: datetime, source: source, alias_id: alias_id }
                    db('messages').insert(insertmsg).returning('id')
                      .then((result) => {
                        // emit the full message
                        var msgId = returningId(result);
                        logger.main.debug(result);

                        if (dbtype == 'oracledb') {
                          // oracle requires update of search index after insert, can't be trigger for some reason
                          db.raw(`BEGIN CTX_DDL.SYNC_INDEX('search_idx'); END;`)
                            .then((resp) => {
                              logger.main.debug('search_idx sync complete');
                              logger.main.debug(resp);
                            }).catch((err) => {
                              logger.main.error('search_idx sync failed');
                              logger.main.error(err)
                            });
                        }

                        db.from('messages')
                          .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', 'capcodes.pluginconf')
                          .modify(function (queryBuilder) {
                            queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
                          })
                          .where('messages.id', '=', msgId)
                          .then((row) => {
                            if (row.length > 0) {
                              row = row[0]
                              // send data to pluginHandler after processing
                              row.pluginData = data.pluginData;

                              if (row.pluginconf) {
                                row.pluginconf = parseJSON(row.pluginconf);
                              } else {
                                row.pluginconf = {};
                              }
                              webPushNotifications.sendForMessage(row).catch(function(error) {
                                logger.main.error('Unable to queue web push: ' + error);
                              });
                              logger.main.debug('afterMessage start');
                              pluginHandler.handle('message', 'after', row, function (response) {
                                logger.main.debug(util.format('%o', response));
                                logger.main.debug('afterMessage done');
                                // remove the pluginconf object before firing socket message
                                delete row.pluginconf;
                                //begin socket handling - this is the most horrible block of spaghetti code i've seen in my life and i hate myself for being involved in it
                                if (HideCapcode) {
                                  if (pdwMode) {
                                    if (adminShow) {
                                      //If PDWMode on and AdminShow is on send always
                                      req.io.of('adminio').emit('messagePost', row);
                                      if (row.alias_id != null) {
                                        // send to normal user as well if not null alias_id
                                        rowuser = {
                                          "id": row.id,
                                          "message": row.message,
                                          "source": row.source,
                                          "timestamp": row.timestamp,
                                          "alias_id": row.alias_id,
                                          "alias": row.alias,
                                          "agency": row.agency,
                                          "icon": row.icon,
                                          "color": row.color,
                                          "ignore": row.ignore
                                        };
                                        req.io.emit('messagePost', rowuser);
                                      }
                                    } else {
                                      // if AdminShow not on only send if not null alias_id
                                      if (row.alias_id != null) {
                                        req.io.of('adminio').emit('messagePost', row);
                                        rowuser = {
                                          "id": row.id,
                                          "message": row.message,
                                          "source": row.source,
                                          "timestamp": row.timestamp,
                                          "alias_id": row.alias_id,
                                          "alias": row.alias,
                                          "agency": row.agency,
                                          "icon": row.icon,
                                          "color": row.color,
                                          "ignore": row.ignore
                                        };
                                        req.io.emit('messagePost', rowuser);
                                      }
                                    }
                                  } else {
                                    req.io.of('adminio').emit('messagePost', row);
                                    rowuser = {
                                      "id": row.id,
                                      "message": row.message,
                                      "source": row.source,
                                      "timestamp": row.timestamp,
                                      "alias_id": row.alias_id,
                                      "alias": row.alias,
                                      "agency": row.agency,
                                      "icon": row.icon,
                                      "color": row.color,
                                      "ignore": row.ignore
                                    };
                                    req.io.emit('messagePost', rowuser);
                                  }
                                } else {
                                  if (pdwMode) {
                                    if (adminShow) {
                                      //If PDWMode on and AdminShow is on send always
                                      req.io.of('adminio').emit('messagePost', row);
                                      if (row.alias_id != null) {
                                        // send to normal user as well if not null alias_id
                                        req.io.emit('messagePost', row);
                                      }
                                    } else {
                                      // if AdminShow not on only send if not null alias_id
                                      if (row.alias_id != null) {
                                        req.io.of('adminio').emit('messagePost', row);
                                        req.io.emit('messagePost', row);
                                      }
                                    }
                                  } else {
                                    req.io.of('adminio').emit('messagePost', row);
                                    req.io.emit('messagePost', row);
                                  }
                                }
                              });
                            }
                            res.status(200).send('' + msgId);
                          })
                          .catch((err) => {
                            res.status(500).send(err);
                            logger.main.error(err)
                          })
                      })
                      .catch((err) => {
                        res.status(500).send(err);
                        logger.main.error(err)
                      })
                  } else {
                    res.status(200);
                    res.send('Ignoring filtered');
                  }
                })
                .catch((err) => {
                  res.status(500).send(err);
                  logger.main.error(err)
                })
            }
          })
          .catch((err) => {
            res.status(500).send(err);
            logger.main.error(err)
          })
      })
    } else {
      res.status(500).json({ message: 'Error - address or message missing' });
    }
  });


router.route('/push/config')
  .get(isSessionUser, function(req, res, next) {
    nconf.load();
    var config = nconf.get('notifications:webPush') || {};
    db('users').select('pushcapcode').where('id', req.user.id).first()
      .then(function(user) {
        return db('push_subscriptions').where('user_id', req.user.id).count({count: '*'}).first()
          .then(function(count) {
            res.json({
              enabled: Boolean(config.enabled && config.publicKey),
              publicKey: config.enabled ? (config.publicKey || '') : '',
              capcode: user && user.pushcapcode ? user.pushcapcode : '',
              deviceCount: Number(count && count.count || 0)
            });
          });
      }).catch(next);
  });

router.route('/push/capcodes')
  .get(isSessionUser, function(req, res, next) {
    db('capcodes').select('address', 'alias', 'agency').whereNotNull('address').orderBy('agency').orderBy('alias')
      .then(function(rows) { res.json(rows.filter(function(row) { return /^\d{1,32}$/.test(String(row.address)); })); }).catch(next);
  });

router.route('/push/subscription')
  .post(isSessionUser, function(req, res, next) {
    nconf.load();
    var config = nconf.get('notifications:webPush') || {};
    var subscription = req.body.subscription || {};
    var capcode = String(req.body.capcode || '').trim();
    if (!config.enabled) return res.status(503).json({error: 'Web push is disabled by the administrator.'});
    if (!/^\d{1,32}$/.test(capcode) || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
      return res.status(400).json({error: 'A valid capcode and push subscription are required.'});
    }
    return db.transaction(function(trx) {
      return trx('users').where('id', req.user.id).update({pushcapcode: capcode}).then(function() {
        return trx('push_subscriptions').where('endpoint', subscription.endpoint).first();
      }).then(function(existing) {
        var values = {user_id: req.user.id, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, updated_at: trx.fn.now()};
        if (existing) return trx('push_subscriptions').where('id', existing.id).update(values);
        values.created_at = trx.fn.now();
        return trx('push_subscriptions').insert(values);
      });
    }).then(function() { res.json({status: 'ok', capcode: capcode}); }).catch(next);
  })
  .delete(isSessionUser, function(req, res, next) {
    var endpoint = (req.body && req.body.endpoint) || req.query.endpoint;
    var query = db('push_subscriptions').where('user_id', req.user.id);
    if (endpoint) query.andWhere('endpoint', endpoint);
    query.del().then(function() { res.json({status: 'ok'}); }).catch(next);
  });

router.route('/push/test')
  .post(isSessionUser, function(req, res, next) {
    webPushNotifications.sendTestForUser(req.user.id).then(function(count) {
      if (!count) return res.status(400).json({error: 'No push-enabled device is registered.'});
      res.json({status: 'ok', devices: count});
    }).catch(next);
  });

router.route('/messages/:id')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    var pdwMode = nconf.get('messages:pdwMode');
    var HideCapcode = nconf.get('messages:HideCapcode');
    var apiSecurity = nconf.get('messages:apiSecurity');
    var id = req.params.id;

    db.from('messages')
      .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
      .leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
      .where('messages.id', id)
      .then((row) => {
        if (HideCapcode) {
          if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role == 'user')) {
            row = {
              "id": row[0].id,
              "message": row[0].message,
              "source": row[0].source,
              "timestamp": row[0].timestamp,
              "alias_id": row[0].alias_id,
              "alias": row[0].alias,
              "agency": row[0].agency,
              "icon": row[0].icon,
              "color": row[0].color,
              "ignore": row[0].ignore
            };
          }
        }
        if (row.ignore == 1) {
          res.status(200).json({});
        } else {
          if (pdwMode && !row.alias) {
            res.status(200).json({});
          } else {
            res.status(200).json(row);
          }
        }
      })
      .catch((err) => {
        res.status(500).send(err);
      })
  });

router.route('/messageSearch')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    console.time('init');
    var dbtype = nconf.get('database:type');
    var pdwMode = nconf.get('messages:pdwMode');
    var adminShow = nconf.get('messages:adminShow');
    var maxLimit = nconf.get('messages:maxLimit');
    var HideCapcode = nconf.get('messages:HideCapcode');
    var apiSecurity = nconf.get('messages:apiSecurity');
    var defaultLimit = nconf.get('messages:defaultLimit');
    initData.replaceText = nconf.get('messages:replaceText');

    if (typeof req.query.page !== 'undefined') {
      var page = parseInt(req.query.page, 10);
      if (page > 0) {
        initData.currentPage = page - 1;
      } else {
        initData.currentPage = 0;
      }
    }
    if (req.query.limit && req.query.limit <= maxLimit) {
      initData.limit = parseInt(req.query.limit, 10);
    } else {
      initData.limit = parseInt(defaultLimit, 10);
    }

    var rowCount;
    var query;
    var agency;
    var address;
    var alias;
    // dodgy handling for unexpected results
    if (typeof req.query.q !== 'undefined') {
      query = req.query.q;
    } else { query = ''; }
    if (typeof req.query.agency !== 'undefined') {
      agency = req.query.agency;
    } else { agency = ''; }
    if (typeof req.query.address !== 'undefined') {
      address = req.query.address;
    } else { address = ''; }
    if (typeof req.query.alias !== 'undefined') {
      alias = req.query.alias;
    } else { alias = ''; }

    // set select commands based on query type

    var data = []
    console.time('sql')
    db.select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
      .modify(function (qb) {
        if (dbtype == 'sqlite3' && query != '') {
          qb.from('messages_search_index')
            .leftJoin('messages', 'messages.id', '=', 'messages_search_index.rowid')
        } else {
          qb.from('messages');
        }
        if (pdwMode) {
          if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
            qb.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id');
          } else {
            qb.innerJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id');
          }
        } else {
          qb.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id');
        }
        if (dbtype == 'sqlite3' && query != '') {
          qb.whereRaw('messages_search_index MATCH ?', query)
        } else if (dbtype == 'mysql' && query != '') {
          //This wraps the search query in quotes so MySQL searches for the complete term rather than individual words.
          query = '"' + query + '"'
          qb.whereRaw(`MATCH(messages.message, messages.address, messages.source) AGAINST (? IN BOOLEAN MODE)`, query)
        } else if (dbtype == 'oracledb' && query != '') {
          qb.whereRaw(`CONTAINS("messages"."message", ?, 1) > 0`, query)
        } else {
          if (address != '')
            qb.where('messages.address', 'LIKE', address).orWhere('messages.source', address);
          if (agency != '')
            qb.whereIn('messages.alias_id', function (qb2) {
              qb2.select('id').from('capcodes').where('agency', agency).where('ignore', 0);
          })
          if (alias != '')
            qb.where('messages.alias_id',alias);
        }
      }).orderBy('messages.timestamp', 'desc')
      .then((rows) => {
        if (rows) {
          for (row of rows) {
            if (HideCapcode) {
              if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role == 'user')) {
                row = {
                  "id": row.id,
                  "message": row.message,
                  "source": row.source,
                  "timestamp": row.timestamp,
                  "alias_id": row.alias_id,
                  "alias": row.alias,
                  "agency": row.agency,
                  "icon": row.icon,
                  "color": row.color,
                  "ignore": row.ignore
                };
              }
            }
            if (pdwMode) {
              if (adminShow && req.isAuthenticated() && req.user.role == 'admin' && !row.ignore || row.ignore == 0) {
                data.push(row);
              } else {
                if (row.ignore == 0)
                  data.push(row);
              }
            } else {
              if (!row.ignore || row.ignore == 0)
                data.push(row);
            }
          }
        } else {
          logger.main.info('empty results');
        }
        rowCount = data.length
        if (rowCount > 0) {
          console.timeEnd('sql');
          var result = data;
          console.time('initEnd');
          initData.msgCount = result.length;
          initData.pageCount = Math.ceil(initData.msgCount / initData.limit);
          if (initData.currentPage > initData.pageCount) {
            initData.currentPage = 0;
          }
          initData.offset = initData.limit * initData.currentPage;
          if (initData.offset < 0) {
            initData.offset = 0;
          }
          initData.offsetEnd = initData.offset + initData.limit;
          var limitResults = result.slice(initData.offset, initData.offsetEnd);
          console.timeEnd('initEnd');
          res.json({ 'init': initData, 'messages': limitResults });
        } else {
          console.timeEnd('sql');
          res.status(200).json({ 'init': {}, 'messages': [] });
        }
      })
      .catch((err) => {
        console.timeEnd('sql');
        logger.main.error(err);
        res.status(500).send(err);
      })
  });

router.route('/capcodes/init')
// DISABLED - UNKNOWN WHAT THIS WAS USED FOR 
/*  
  .get(authHelper.isAdmin, function (req, res, next) {
    //set current page if specifed as get variable (eg: /?page=2)
    if (typeof req.query.page !== 'undefined') {
      var page = parseInt(req.query.page, 10);
      if (page > 0)
        initData.currentPage = page - 1;
    }
    db.from('capcodes')
      .select('id')
      .orderBy('id', 'desc')
      .limit(1)
      .then((row) => {
        initData.msgCount = parseInt(row['id'], 10);
        //console.log(initData.msgCount);
        initData.pageCount = Math.ceil(initData.msgCount / initData.limit);
        var offset = initData.limit * initData.currentPage;
        initData.offset = initData.msgCount - offset;
        if (initData.offset < 0) {
          initData.offset = 0;
        }
        res.json(initData);
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });
*/
router.route('/capcodes')
  .get(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    var dbtype = nconf.get('database:type');
    db.from('capcodes')
      .select('*')
      .modify(function (queryBuilder) {
        if (dbtype == 'oracledb')
          queryBuilder.orderByRaw(`REPLACE("address", '_', '%')`);
        else
          queryBuilder.orderByRaw(`REPLACE(address, '_', '%')`)
      })
      .then((rows) => {
        res.json(rows);
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    var updateRequired = nconf.get('database:aliasRefreshRequired');
    if (req.body.address && req.body.alias) {
      var id = req.body.id || null;
      var address = req.body.address || 0;
      var alias = req.body.alias || 'null';
      var agency = req.body.agency || 'null';
      var color = req.body.color || 'black';
      var icon = req.body.icon || 'question';
      var ignore = req.body.ignore || 0;
      var pluginconf = JSON.stringify(req.body.pluginconf) || "{}";
      db.from('capcodes')
        .where('id', '=', id)
        .modify(function (queryBuilder) {
          if (id == null) {
            queryBuilder.insert({
              id: id,
              address: address,
              alias: alias,
              agency: agency,
              color: color,
              icon: icon,
              ignore: ignore,
              pluginconf: pluginconf
            })
          } else {
            queryBuilder.update({
              id: id,
              address: address,
              alias: alias,
              agency: agency,
              color: color,
              icon: icon,
              ignore: ignore,
              pluginconf: pluginconf
            })
          }
        })
        .returning('id')
        .then((result) => {
          res.status(200);
          res.send('' + returningId(result));
          if (!updateRequired || updateRequired == 0) {
            nconf.set('database:aliasRefreshRequired', 1);
            nconf.save();
          }
        })
        .catch((err) => {
          logger.main.error(err)
            .status(500).send(err);
        })
      logger.main.debug(util.format('%o', req.body || 'no request body'));
    } else {
      res.status(500).json({ message: 'Error - address or alias missing' });
    }
  });

router.route('/capcodes/agency')
  .get(authHelper.isAdmin, function (req, res, next) {
    db.from('capcodes')
      .distinct('agency')
      .then((rows) => {
        res.status(200);
        res.json(rows);
      })
      .catch((err) => {
        res.status(500);
        res.send(err);
      })
  });

router.route('/capcodes/agency/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    var id = req.params.id;
    db.from('capcodes')
      .select('*')
      .where('agency', 'like', id)
      .then((rows) => {
        res.status(200);
        res.json(rows);
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/capcodes/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    var id = req.params.id;
    var defaults = {
      "id": "",
      "address": "",
      "alias": "",
      "agency": "",
      "icon": "question",
      "color": "black",
      "ignore": 0,
      "pluginconf": {}
    };
    if (id == 'new') {
      res.status(200);
      res.json(defaults);
    } else {
      db.from('capcodes')
        .select('*')
        .where('id', id)
        .then(function (row) {
          if (row.length > 0) {
            row = row[0]
            row.pluginconf = parseJSON(row.pluginconf);
            res.status(200);
            res.json(row);
          } else {
            res.status(200);
            res.json(defaults);
          }
        })
        .catch((err) => {
          logger.main.error(err);
          return next(err);
        })
    }
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    var dbtype = nconf.get('database:type');
    var id = req.params.id || req.body.id || null;
    nconf.load();
    var updateRequired = nconf.get('database:aliasRefreshRequired');
    if (id == 'deleteMultiple') {
      // do delete multiple
      var idList = req.body.deleteList || [0, 0];
      if (!idList.some(isNaN)) {
        logger.main.info('Deleting: ' + idList);
        db.from('capcodes')
          .del()
          .where('id', 'in', idList)
          .then((result) => {
            res.status(200).send({ 'status': 'ok' });
            if (!updateRequired || updateRequired == 0) {
              nconf.set('database:aliasRefreshRequired', 1);
              nconf.save();
            }
          }).catch((err) => {
            res.status(500).send(err);
          })
      } else {
        res.status(500).send({ 'status': 'id list contained non-numbers' });
      }
    } else {
      if (req.body.address && req.body.alias) {
        if (id == 'new') {
          id = null;
        }
        var address = req.body.address || 0;
        var alias = req.body.alias || 'null';
        var agency = req.body.agency || 'null';
        var color = req.body.color || 'black';
        var icon = req.body.icon || 'question';
        var ignore = req.body.ignore || 0;
        var pluginconf = JSON.stringify(req.body.pluginconf) || "{}";
        var updateAlias = req.body.updateAlias || 0;

        console.time('insert');
        db.from('capcodes')
          .returning('id')
          .where('id', '=', id)
          .modify(function (queryBuilder) {
            if (id == null) {
              queryBuilder.insert({
                id: id,
                address: address,
                alias: alias,
                agency: agency,
                color: color,
                icon: icon,
                ignore: ignore,
                pluginconf: pluginconf
              })
            } else {
              queryBuilder.update({
                id: id,
                address: address,
                alias: alias,
                agency: agency,
                color: color,
                icon: icon,
                ignore: ignore,
                pluginconf: pluginconf
              })
            }
          })
          .then((result) => {
            console.timeEnd('insert');
            if (updateAlias == 1) {
              console.time('updateMap');
              db('messages')
                .update('alias_id', function () {
                  this.select('id')
                    .from('capcodes')
                    .where('messages.address', 'like', 'address')
                    .modify(function (queryBuilder) {
                      if (dbtype == 'oracledb')
                        queryBuilder.orderByRaw(`REPLACE("address", '_', '%') DESC`);
                      else
                        queryBuilder.orderByRaw(`REPLACE(address, '_', '%') DESC`)
                    })
                    .limit(1)
                })
                .catch((err) => {
                  logger.main.error(err);
                })
                .finally(() => {
                  console.timeEnd('updateMap');
                })
            } else {
              //Check if we can refresh just this specific alias
              var specificRefresh = nconf.get('global:SpecificAliasRefresh');
              if (specificRefresh && /^\d+$/.test(req.body.address)) {
                //Refresh this specific Alias
                console.time('updateMap');
                db('messages').update('alias_id', function () {
                  this.select('id')
                    .from('capcodes')
                    .where(db.ref('messages.address'), 'like', db.ref('capcodes.address'))
                    .modify(function (queryBuilder) {
                      if (dbtype == 'oracledb')
                        queryBuilder.orderByRaw(`REPLACE("address", '_', '%') DESC`);
                      else
                        queryBuilder.orderByRaw(`REPLACE(address, '_', '%') DESC`)
                  })
                  .limit(1)
                })
                .where(db.ref('messages.address'), '=', req.body.address)
                .catch((err) => {
                  logger.main.error(err);
                })
                .finally(() => {
                  console.timeEnd('updateMap');
                })
              } else {
                //We cannot update this specific Alias, so inform of required Alias Refresh
                if (!updateRequired || updateRequired == 0) {
                  nconf.set('database:aliasRefreshRequired', 1);
                  nconf.save();
                }
              }
            }
            res.status(200).send({ 'status': 'ok', 'id': returningId(result) })
          })
          .catch((err) => {
            console.timeEnd('insert');
            logger.main.error(err)
            res.status(500).send(err);
          })
        logger.main.debug(util.format('%o', req.body || 'request body empty'));
      } else {
        res.status(500).json({ message: 'Error - address or alias missing' });
      }
    }
  })
  .delete(authHelper.isAdmin, function (req, res, next) {
    // delete single alias
    var id = parseInt(req.params.id, 10);
    nconf.load();
    var updateRequired = nconf.get('database:aliasRefreshRequired');
    logger.main.info('Deleting ' + id);
    db.from('capcodes')
      .del()
      .where('id', id)
      .then((result) => {
        res.status(200).send({ 'status': 'ok' });
        if (!updateRequired || updateRequired == 0) {
          nconf.set('database:aliasRefreshRequired', 1);
          nconf.save();
        }
      })
      .catch((err) => {
        res.status(500).send(err);
      })
    logger.main.debug(util.format('%o', req.body || 'request body empty'));
  });

router.route('/capcodeCheck/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    var id = req.params.id;
    db.from('capcodes')
      .select('*')
      .where('address', id)
      .then((row) => {
        if (row.length > 0) {
          row = row[0]
          row.pluginconf = parseJSON(row.pluginconf);
          res.status(200);
          res.json(row);
        } else {
          row = {
            "id": "",
            "address": "",
            "alias": "",
            "agency": "",
            "icon": "question",
            "color": "black",
            "ignore": 0,
            "pluginconf": {}
          };
          res.status(200);
          res.json(row);
        }
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/capcodeRefresh')
  .post(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    var dbtype = nconf.get('database:type');
    console.time('updateMap');
    db('messages').update('alias_id', function () {
      this.select('id')
        .from('capcodes')
        .where(db.ref('messages.address'), 'like', db.ref('capcodes.address'))
        .modify(function (queryBuilder) {
          if (dbtype == 'oracledb')
            queryBuilder.orderByRaw(`REPLACE("address", '_', '%') DESC`);
          else
            queryBuilder.orderByRaw(`REPLACE(address, '_', '%') DESC`)
        })
        .limit(1)
    })
      .then((result) => {
        console.timeEnd('updateMap');
        nconf.set('database:aliasRefreshRequired', 0);
        nconf.save();
        res.status(200).send({ 'status': 'ok' });
      })
      .catch((err) => {
        logger.main.error(err);
        console.timeEnd('updateMap');
      })
  });

router.route('/capcodeExport')
  .post(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    var dbtype = nconf.get('database:type');
    var filename = 'export.csv'
    db.from('capcodes')
      .select('*')
      .modify(function (queryBuilder) {
        if (dbtype == 'oracledb')
          queryBuilder.orderByRaw(`REPLACE("address", '_', '%')`);
        else
          queryBuilder.orderByRaw(`REPLACE(address, '_', '%')`)
      })
      .then((rows) => {
        converter.json2csv(rows, function (err, data) {
          if (err) {
            res.status(500).send(err);
          } else {
            res.status(200).send({ 'status': 'ok', 'data': data })
          }
        })
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/capcodeImport')
  .post(authHelper.isAdmin, function (req, res, next) {
    for (var key in req.body) {
      //remove newline chars from dataset - yes i realise we are adding them in admin.main.js, it doesn't submit without them.
      req.body[key] = req.body[key].replace(/[\r\n]/g, '');
    }
    // join data but remove the last newline to prevent the last one being malformed. 
    var importdata = req.body.join('\n').slice(0, -1);
    var importresults = [];
    converter.csv2jsonAsync(importdata)
      .then(async (data) => {
        var header = data[0]
        if (('address' in header) && ('alias' in header)) {
          //this checks if the csv has the required headings, should replace this with some form of proper validation
          for await (capcode of data) {
            var address = capcode.address || 0;
            var alias = capcode.alias || 'null';
            var agency = capcode.agency || 'null';
            var color = capcode.color || 'black';
            var icon = capcode.icon || 'question';
            var ignore = capcode.ignore || 0;
            var pluginconf = JSON.stringify(capcode.pluginconf) || "{}";
            await db('capcodes')
              .returning('id')
              .where('address', '=', address)
              .first()
              .then((rows) => {
                if (rows) {
                  //Update the existing alias if one is found.
                  return db('capcodes')
                    .where('id', '=', rows.id)
                    .update({
                      address: address,
                      alias: alias,
                      agency: agency,
                      color: color,
                      icon: icon,
                      ignore: ignore,
                      pluginconf: pluginconf
                    })
                    .then((result) => {
                      importresults.push({
                        address: address,
                        alias: alias,
                        result: 'updated'
                      })
                    })
                    .catch((err) => {
                      importresults.push({
                        address: address,
                        alias: alias,
                        result: 'failed' + err
                      })
                    })
                } else {
                  //Create new alias if one didn't get returned.
                  return db('capcodes').insert({
                    id: null,
                    address: address,
                    alias: alias,
                    agency: agency,
                    color: color,
                    icon: icon,
                    ignore: ignore,
                    pluginconf: pluginconf
                  })
                    .then((result) => {
                      importresults.push({
                        address: address,
                        alias: alias,
                        result: 'created'
                      })
                    })
                    .catch((err) => {
                      importresults.push({
                        address: address,
                        alias: alias,
                        result: 'failed' + err
                      })
                    })
                }
              })
              .catch((err) => {
                importresults.push({
                  'address': address,
                  'alias': alias,
                  'result': 'failed' + err
                })
              });
          };
          //Gather all the results, format for the frontend and send it back.
          let results = { "results": importresults }
          res.status(200)
          res.json(results)
          logger.main.debug('Import:' + JSON.stringify(importresults))
          nconf.set('database:aliasRefreshRequired', 1);
          nconf.save();
        } else {
          throw 'Error parasing CSV header'
        }
      })
      .catch((err) => {
        res.status(500).send(err)
        logger.main.error(err)
      })
  });

router.route('/user')
  .get(authHelper.isAdmin, function (req, res, next) {
    db.from('users')
      .select('id','givenname','surname','username','email','role','status','approvalpending','lastlogondate')
      .then((rows) => {
        res.json(rows);
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  }) 
  .post(authHelper.isAdmin, function (req, res, next) {
    if (req.body.username && req.body.email && req.body.givenname && req.body.password && req.body.status && req.body.role) {
      var username = req.body.username
      var email = req.body.email
      db.table('users')
        .where('username', '=', username)
        .orWhere('email', '=', email)
        .first()
        .then((row) => {
          if (row) {
            //add logging
            res.status(400).send({ 'status': 'error', 'error': 'Username or Email exists' });
          } else {
            const salt = bcrypt.genSaltSync();
            const hash = bcrypt.hashSync(req.body.password, salt);

            return db('users')
              .insert({
                username: req.body.username,
                password: hash,
                givenname: req.body.givenname,
                surname: req.body.surname,
                email: req.body.email,
                role: req.body.role,
                status: req.body.status,
                approvalpending: false,
                lastlogondate: null
              })
              .returning('id')
              .then((response) => {
                //add logging
                logger.main.debug('created user id: ' + response)
                res.status(200).send({ 'status': 'ok', 'id': returningId(response) });
              })
              .catch((err) => {
                logger.main.error(err)
                res.status(500).send({ 'status': 'error' });
              });
          }
        })
    } else {
      res.status(400).send({ 'status': 'error', 'error': 'Invalid request body' });
    }
  });

router.route('/userCheck/username/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    var id = req.params.id;
    db.from('users')
      .select('id','givenname','surname','username','email','role','status','approvalpending','lastlogondate')
      .where('username', id)
      .then((row) => {
        if (row.length > 0) {
          row = row[0]
          res.status(200);
          res.json(row);
        } else {
          row = {
            "username": "",
            "password": "",
            "givenname": "",
            "surname": "",
            "email": "",
            "role": "user",
            "status": "active",
            "approvalpending": false
          };
          res.status(200);
          res.json(row);
        }
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

  router.route('/userCheck/email/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    var id = req.params.id;
    db.from('users')
      .select('id','givenname','surname','username','email','role','status','approvalpending','lastlogondate')
      .where('email', id)
      .then((row) => {
        if (row.length > 0) {
          row = row[0]
          res.status(200);
          res.json(row);
        } else {
          row = {
            "username": "",
            "password": "",
            "givenname": "",
            "surname": "",
            "email": "",
            "role": "user",
            "status": "active",
            "approvalpending": false
          };
          res.status(200);
          res.json(row);
        }
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/user/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    var id = req.params.id;
    var defaults = {
      "username": "",
      "password": "",
      "givenname": "",
      "surname": "",
      "email": "",
      "role": "user",
      "status": "active",
      "approvalpending": false
    };
    if (id == 'new') {
      res.status(200);
      res.json(defaults);
    } else {
      db.from('users')
        .select('id','givenname','surname','username','email','role','status','approvalpending','lastlogondate','totp_enabled','totp_enrolled_at')
        .where('id', id)
        .then(function (row) {
          if (row.length > 0) {
            row = row[0]
            res.status(200);
            res.json(row);
          } else {
            res.status(200);
            res.json(defaults);
          }
        })
        .catch((err) => {
          logger.main.error(err);
          return next(err);
        })
    }
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    var id = req.params.id || req.body.id || null;
    if (id == 'deleteMultiple') {
      // do delete multiple
      var idList = req.body.deleteList || [0, 0];
      if (!idList.some(isNaN)) {
        //ADD CHECK TO NOT ALLOW DELETION OF USERID 1
        logger.main.info('Deleting: ' + idList);
        db.from('users')
          .del()
          .where('id', 'in', idList)
          .then((result) => {
            res.status(200).send({ 'status': 'ok' });

          }).catch((err) => {
            res.status(500).send(err);
          })
      } else {
        res.status(400).send({ 'status': 'error', 'error': 'id list contained non-numbers' });
      }
    } else {
      if (req.body.username && req.body.email && req.body.givenname) {
        var password = req.body.newpassword || req.body.password||  null;
        if (id == 'new') {
          // Password is a required field if this is a new account check for that
          if (!req.body.password) {
            return res.status(400).send({'status': 'error', 'error': 'Error - required field missing' });
          } else {
            id = null;
          }
        }
        console.time('insert');
        db.from('users')
          .returning('id')
          .where('id', '=', id)
          .modify(function (queryBuilder) {
            const userobj ={
              id: id,
              username: req.body.username,
              givenname: req.body.givenname,
              surname: req.body.surname || '',
              email: req.body.email,
              role: req.body.role || 'user',
              status: req.body.status || 'disabled',
              approvalpending: req.body.status === 'active' ? false : Boolean(req.body.approvalpending),
            }
            if (password != null) {
              const salt = bcrypt.genSaltSync();
              const hash = bcrypt.hashSync(password, salt);
              userobj.password = hash
              if (id == null) {
                userobj.lastlogondate = null
                queryBuilder.insert(userobj)
              } else {
                queryBuilder.update(userobj)
              }
            } else {
              queryBuilder.update(userobj)
            }
          })
          .returning('id')
          .then((result) => {
            console.timeEnd('insert');
            res.status(200).send({ 'status': 'ok', 'id': returningId(result) })
          })
          .catch((err) => {
            console.timeEnd('insert');
            logger.main.error(err)
            res.status(500).send(err);
          })
      } else {
        res.status(400).send({'status': 'error', 'error': 'Error - required field missing' });
      }
    }
  })
  .delete(authHelper.isAdmin, function (req, res, next) {
    var id = parseInt(req.params.id, 10);
    if (id != 1) {
      logger.main.info('Deleting User ' + id);
      db.from('users')
        .del()
        .where('id', id)
        .then((result) => {
          res.status(200).send({ 'status': 'ok' });
        })
        .catch((err) => {
          res.status(500).send(err);
          logger.main.error(err)
        })
    } else {
      res.status(400).json({ 'error': 'User ID 1 is protected' });
      logger.main.error('Unable to delete user ID 1')
    }
  });

// Central West dashboard data. This is deliberately read-only and derives its
// state from the existing messages/capcodes tables, so no database migration is
// required and upgrades remain easy to roll back.
router.route('/central-west/dashboard')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    var hideAddresses = HideCapcode && (!req.isAuthenticated() || req.user.role !== 'admin');

    db.from('messages')
      .leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
      .select('messages.id', 'messages.timestamp', 'messages.message', 'messages.source',
        'messages.address', 'messages.alias_id', 'capcodes.alias', 'capcodes.agency',
        'capcodes.icon', 'capcodes.color')
      .orderBy('messages.timestamp', 'desc')
      .limit(limit)
      .then(function (rows) {
        if (hideAddresses) {
          rows.forEach(function (row) { delete row.address; });
        }
        var latest = rows.length ? Number(rows[0].timestamp) : null;
        var nowSeconds = Math.floor(Date.now() / 1000);
        var receivers = receiverStatusList(nowSeconds);
        res.status(200).json({
          serverTime: Math.floor(Date.now() / 1000),
          uptime: Math.floor(process.uptime()),
          latestTimestamp: latest,
          receiverState: latest && (Date.now() / 1000 - latest) < 86400 ? 'receiving' : 'quiet',
          receivers: receivers,
          messages: rows
        });
      })
      .catch(function (err) {
        logger.main.error(err);
        res.status(500).send(err);
      });
  });

router.route('/central-west/receiver-heartbeat')
  .post(authHelper.isAdmin, function (req, res) {
    var id = String(req.body.id || '').trim();
    if (!Object.prototype.hasOwnProperty.call(receiverDefinitions(), id)) {
      return res.status(400).json({ error: 'Unknown receiver id.' });
    }
    var externalIp = String(req.body.externalIp || '').trim();
    if (!net.isIP(externalIp)) {
      var reportedAddress = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
      externalIp = net.isIP(reportedAddress) && !isPrivateReceiverAddress(reportedAddress) ? reportedAddress : '';
    }
    var internalIp = String(req.body.internalIp || '').trim();
    receiverHeartbeats[id] = {
      lastSeen: Math.floor(Date.now() / 1000),
      identifier: String(req.body.identifier || '').slice(0, 100),
      externalIp: net.isIP(externalIp) ? externalIp : (receiverHeartbeats[id] && receiverHeartbeats[id].externalIp) || '',
      internalIp: net.isIP(internalIp) ? internalIp : (receiverHeartbeats[id] && receiverHeartbeats[id].internalIp) || ''
    };
    try {
      fs.mkdirSync(path.dirname(receiverHeartbeatFile), { recursive: true });
      fs.writeFileSync(receiverHeartbeatFile + '.tmp', JSON.stringify(receiverHeartbeats, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(receiverHeartbeatFile + '.tmp', receiverHeartbeatFile);
    } catch (err) {
      logger.main.error(err);
      return res.status(500).json({ error: 'Unable to persist receiver heartbeat.' });
    }
    return res.status(200).json({ status: 'ok', id: id, lastSeen: receiverHeartbeats[id].lastSeen });
  });

router.route('/central-west/receiver-status')
  .get(isSessionUser, function (req, res) {
    var nowSeconds = Math.floor(Date.now() / 1000);
    return res.status(200).json({
      serverTime: nowSeconds,
      uptime: Math.floor(process.uptime()),
      local: { id: 'pagermon', label: nconf.get('global:monitorName') || 'PagerMon', state: 'online' },
      receivers: receiverStatusList(nowSeconds)
    });
  });

router.post('/user/:id/two-factor-reset', authHelper.isAdmin, function(req, res) {
  var id = Number(req.params.id);
  if (!id) return res.status(400).send({error: 'Invalid user.'});
  db.transaction(function(trx) {
    return trx('two_factor_devices').where('user_id', id).del().then(function() {
      return trx('users').where('id', id).update({totp_enabled: false, totp_secret: null, totp_recovery_codes: null, totp_enrolled_at: null});
    });
  }).then(function() {
    logger.auth.info(`Administrator ${req.user.username} reset two-factor authentication for user ${id}`);
    res.send({status: 'ok'});
  }).catch(function(err) { logger.main.error(err); res.status(500).send({error: 'Unable to reset two-factor authentication.'}); });
});

router.route('/central-west/dashboard-config')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var waterConfig = integrationConfig('waterNsw', { enabled: true });
    var bomConfig = integrationConfig('bom', { enabled: true });
    var radioConfig = integrationConfig('radio', { enabled: true });
    var piawareConfig = integrationConfig('piaware', { enabled: true, pollSeconds: 10 });
    var radarConfig = integrationConfig('weatherRadar', { enabled: true, opacityPercent: 62, defaultVisible: false });
    var mapConfig = integrationConfig('liveMap', { wheelPxPerZoomLevel: 180 });
    res.set('Cache-Control', 'private, no-store');
    res.status(200).json({
      waterNswEnabled: waterConfig.enabled !== false,
      bomEnabled: bomConfig.enabled !== false,
      radioEnabled: radioConfig.enabled !== false,
      piawareEnabled: piawareConfig.enabled !== false,
      piawarePollSeconds: Math.min(Math.max(parseInt(piawareConfig.pollSeconds, 10) || 10, 5), 300),
      weatherRadarEnabled: radarConfig.enabled !== false,
      weatherRadarOpacity: Math.min(Math.max(parseInt(radarConfig.opacityPercent, 10) || 62, 10), 100) / 100,
      weatherRadarDefaultVisible: radarConfig.defaultVisible === true,
      wheelPxPerZoomLevel: Math.min(Math.max(parseInt(mapConfig.wheelPxPerZoomLevel, 10) || 180, 60), 600)
    });
  });

router.route('/central-west/bom-warnings')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var bomConfig = integrationConfig('bom', { enabled: true, warningsUrl: 'https://www.bom.gov.au/fwo/IDZ00061.warnings_land_nsw.xml', cacheMinutes: 10 });
    if (bomConfig.enabled === false) return res.status(200).json({ disabled: true, fetchedAt: Math.floor(Date.now() / 1000), localWarnings: [], statewideCount: 0 });
    var now = Date.now();
    var bomCacheMilliseconds = Math.min(Math.max(parseInt(bomConfig.cacheMinutes, 10) || 10, 1), 1440) * 60 * 1000;
    if (bomWarningCache.data && now - bomWarningCache.fetchedAt < bomCacheMilliseconds) {
      return res.status(200).json(bomWarningCache.data);
    }

    axios.get(bomConfig.warningsUrl, {
      timeout: 12000,
      headers: { 'User-Agent': 'CentralWestAlerts/1.0 PageMon weather warning panel' },
      responseType: 'text'
    }).then(function (response) {
      var xml = String(response.data || '');
      var items = [];
      var itemPattern = /<item>([\s\S]*?)<\/item>/gi;
      var match;
      function field(block, name) {
        var result = new RegExp('<' + name + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + name + '>', 'i').exec(block);
        return result ? result[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim() : '';
      }
      while ((match = itemPattern.exec(xml)) !== null) {
        var title = field(match[1], 'title');
        var description = field(match[1], 'description');
        var combined = title + ' ' + description;
        var local = keywordPattern(bomConfig.localKeywords).test(combined);
        items.push({
          title: title,
          description: description,
          link: field(match[1], 'link'),
          published: field(match[1], 'pubDate'),
          local: local
        });
      }
      var payload = {
        fetchedAt: Math.floor(now / 1000),
        source: 'Australian Bureau of Meteorology',
        sourceUrl: 'https://www.bom.gov.au/nsw/warnings/',
        localWarnings: items.filter(function (item) { return item.local; }),
        statewideCount: items.length
      };
      bomWarningCache = { fetchedAt: now, data: payload };
      res.status(200).json(payload);
    }).catch(function (err) {
      logger.main.warn('Unable to retrieve BOM warning feed: ' + err.message);
      if (bomWarningCache.data) return res.status(200).json(bomWarningCache.data);
      res.status(502).json({ error: 'BOM warning feed is temporarily unavailable' });
    });
  });

router.route('/central-west/rfs-incidents')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var now = Date.now();
    if (rfsIncidentCache.data && now - rfsIncidentCache.fetchedAt < 10 * 60 * 1000) {
      return res.status(200).json(rfsIncidentCache.data);
    }
    axios.get('https://www.rfs.nsw.gov.au/feeds/majorIncidents.json', {
      timeout: 15000,
      headers: { 'User-Agent': 'CentralWestAlerts/1.0 PageMon incident map' }
    }).then(function (response) {
      function pointFromGeometry(geometry) {
        if (!geometry) return null;
        if (geometry.type === 'Point') return geometry.coordinates;
        if (geometry.type === 'GeometryCollection') {
          for (var i = 0; i < geometry.geometries.length; i++) {
            var point = pointFromGeometry(geometry.geometries[i]);
            if (point) return point;
          }
        }
        return null;
      }
      var incidents = (response.data.features || []).map(function (feature) {
        var point = pointFromGeometry(feature.geometry);
        if (!point) return null;
        var longitude = Number(point[0]);
        var latitude = Number(point[1]);
        // Broad Central West window: includes neighbouring incidents that may
        // affect travel or response without filling the map with all of NSW.
        if (latitude < -34.5 || latitude > -30.8 || longitude < 147.3 || longitude > 151.0) return null;
        var properties = feature.properties || {};
        return {
          title: properties.title || 'RFS incident',
          category: properties.category || 'Incident',
          description: String(properties.description || '').replace(/<br\s*\/?\s*>/gi, ' · ').replace(/<[^>]+>/g, ''),
          link: properties.link || 'https://www.rfs.nsw.gov.au/fire-information/fires-near-me',
          published: properties.pubDate || '',
          latitude: latitude,
          longitude: longitude
        };
      }).filter(Boolean);
      var payload = { fetchedAt: Math.floor(now / 1000), incidents: incidents };
      rfsIncidentCache = { fetchedAt: now, data: payload };
      res.status(200).json(payload);
    }).catch(function (err) {
      logger.main.warn('Unable to retrieve RFS incident feed: ' + err.message);
      if (rfsIncidentCache.data) return res.status(200).json(rfsIncidentCache.data);
      res.status(502).json({ error: 'RFS incident feed is temporarily unavailable' });
    });
  });

router.route('/central-west/waternsw-dams')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var waterConfig = integrationConfig('waterNsw', { enabled: true, apiUrl: 'https://api.waternsw.com.au/water/surface-water-data-api', refreshHours: '0,12' });
    if (waterConfig.enabled === false) return res.status(200).json({ disabled: true, fetchedAt: Math.floor(Date.now() / 1000), dams: [], alerts: [] });
    var now = Date.now();
    var currentSlot = configuredWaterSlot(now, waterConfig.refreshHours);
    if (waterNswCache.data) {
      var cachedSlot = configuredWaterSlot(waterNswCache.fetchedAt || Number(waterNswCache.data.fetchedAt || 0) * 1000, waterConfig.refreshHours);
      if (cachedSlot === currentSlot || waterNswAttemptSlot === currentSlot) return res.status(200).json(waterNswCache.data);
    }
    waterNswAttemptSlot = currentSlot;
    var subscriptionKey = waterConfig.subscriptionKey || process.env.WATERNSW_DATA_KEY || process.env.WATERNSW_SUBSCRIPTION_KEY;
    if (!subscriptionKey) return res.status(503).json({ error: 'WaterNSW API subscription is not configured' });
    var sourceUrl = waterConfig.apiUrl;
    var localDams = {
      '421148': { name: 'Windamere Dam', latitude: -32.7259, longitude: 149.7675 },
      '421078': { name: 'Burrendong Dam', latitude: -32.6673, longitude: 149.1115 },
      '412010': { name: 'Wyangala Dam', latitude: -33.9688, longitude: 148.9517 },
      '421189': { name: 'Oberon Dam', latitude: -33.7250, longitude: 149.8646 },
      '412106': { name: 'Carcoar Dam', latitude: -33.6179, longitude: 149.1776 }
    };
    var latestRequest = axios.get(sourceUrl, {
      timeout: 20000,
      params: { siteId: Object.keys(localDams).join(','), frequency: 'Latest', variable: 'ActiveStoragePercentage,TotalStorageVolume,StorageWaterLevel,SpillwayOutflow', pageNumber: 1 },
      headers: { 'Ocp-Apim-Subscription-Key': subscriptionKey, 'Accept': 'application/json', 'User-Agent': 'CentralWestAlerts/1.0 WaterNSW storage panel' }
    });
    var dailyRequest = axios.get(sourceUrl, {
      timeout: 60000,
      params: { siteId: Object.keys(localDams).join(','), frequency: 'Daily', dataType: 'AutoQC', variable: 'ActiveStoragePercentage', startDate: waterNswDateTime(now - 4 * 24 * 60 * 60 * 1000), endDate: waterNswDateTime(now - 10 * 60 * 1000), pageNumber: 1 },
      headers: { 'Ocp-Apim-Subscription-Key': subscriptionKey, 'Accept': 'application/json', 'User-Agent': 'CentralWestAlerts/1.0 WaterNSW daily storage trend' }
    });
    Promise.all([latestRequest, dailyRequest]).then(function (responses) {
      var response = responses[0];
      var dailyResponse = responses[1];
      var grouped = {};
      Object.keys(localDams).forEach(function (siteId) { grouped[siteId] = { readings: {}, observedAt: null }; });
      (response.data.latestRecords || []).forEach(function (record) {
        var group = grouped[String(record.siteId)];
        if (!group) return;
        group.readings[record.variableName] = record;
        if (!group.observedAt || record.variableName === 'ActiveStoragePercentage') group.observedAt = record.timeStamp;
      });
      var dailyBySite = {};
      (dailyResponse.data.records || []).forEach(function (record) {
        var siteId = String(record.siteId);
        if (!dailyBySite[siteId]) dailyBySite[siteId] = [];
        dailyBySite[siteId].push(record);
      });
      Object.keys(dailyBySite).forEach(function (siteId) {
        dailyBySite[siteId].sort(function (a, b) { return String(a.timeStamp).localeCompare(String(b.timeStamp)); });
      });
      var todayLabel = waterNswDateTime(now).split(' ')[0];
      var dams = Object.keys(localDams).map(function (siteId) {
        var metadata = localDams[siteId];
        var group = grouped[siteId];
        var percentageRecord = group.readings.ActiveStoragePercentage;
        var volumeRecord = group.readings.TotalStorageVolume;
        if (!percentageRecord) return null;
        var percentage = Number(percentageRecord.value);
        var volumeMl = volumeRecord ? Number(volumeRecord.value) : null;
        var capacityMl = volumeMl !== null && percentage > 0 ? Math.round(volumeMl / (percentage / 100)) : null;
        var previousRecords = (dailyBySite[siteId] || []).filter(function (record) { return String(record.timeStamp).indexOf(todayLabel) !== 0; });
        var previousRecord = previousRecords.length ? previousRecords[previousRecords.length - 1] : null;
        var percentageChange = previousRecord ? Number((percentage - Number(previousRecord.value)).toFixed(3)) : null;
        var status = percentage > 100 ? 'possible-spill' : percentage >= 100 ? 'full' : percentage >= 95 ? 'near-capacity' : 'normal';
        return { name: metadata.name, siteId: siteId, percentage: percentage, dailyChange: percentageChange, previousPercentage: previousRecord ? Number(previousRecord.value) : null, trendObservedAt: previousRecord ? previousRecord.timeStamp : null, weeklyChange: null, capacityMl: capacityMl, volumeMl: volumeMl, storageLevelM: group.readings.StorageWaterLevel ? Number(group.readings.StorageWaterLevel.value) : null, observedAt: group.observedAt, status: status, possibleSpill: status === 'possible-spill', latitude: metadata.latitude, longitude: metadata.longitude, link: 'https://www.waternsw.com.au/nsw-dams' };
      }).filter(Boolean);
      if (!dams.length) throw new Error('WaterNSW API returned no Central West storage readings');
      dams.push({
        name: 'Rylstone Dam',
        percentage: null,
        weeklyChange: null,
        capacityMl: 3038,
        volumeMl: null,
        status: 'level-unavailable',
        possibleSpill: false,
        latitude: -32.7859022,
        longitude: 149.9901407,
        operator: 'Mid-Western Regional Council',
        note: 'Council-owned town water supply dam. A continuous public storage reading is not currently available.',
        lastOfficialReport: { percentage: 95, reportedAt: '2025-05-28T16:00:00+10:00', trend: 'rising', historical: true, link: 'https://www.midwestern.nsw.gov.au/Council/Media-and-news/Latest-news/Rylstone-Dam-nearing-capacity-and-likely-to-spill' },
        link: 'https://www.midwestern.nsw.gov.au/Services/Water-services/Water-supply/Rylstone-Dam'
      });
      dams.sort(function (a, b) { return (b.percentage === null ? -1 : b.percentage) - (a.percentage === null ? -1 : a.percentage); });
      var payload = { fetchedAt: Math.floor(now / 1000), source: 'WaterNSW Water Data API and Mid-Western Regional Council', sourceUrl: sourceUrl, dams: dams, alerts: dams.filter(function (dam) { return dam.possibleSpill; }).map(function (dam) { return { type: 'possible-spill', title: dam.name + ' may be spilling or releasing', description: 'Published storage is ' + dam.percentage + '%. Confirm current spill and release conditions with WaterNSW or the Early Warning Network.', dam: dam.name, link: dam.link }; }) };
      waterNswCache = { fetchedAt: now, data: payload };
      fs.writeFile(waterNswCacheFile, JSON.stringify(payload), function (writeError) { if (writeError) logger.main.warn('Unable to persist WaterNSW dam cache: ' + writeError.message); });
      res.status(200).json(payload);
    }).catch(function (err) {
      logger.main.warn('Unable to retrieve WaterNSW dam levels from API: ' + err.message);
      if (waterNswCache.data) {
        waterNswCache.data.stale = true;
        return res.status(200).json(waterNswCache.data);
      }
      res.status(502).json({ error: 'WaterNSW dam levels are temporarily unavailable' });
    });
  });

router.route('/central-west/waternsw-rylstone-gauges')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var waterConfig = integrationConfig('waterNsw', { enabled: true, apiUrl: 'https://api.waternsw.com.au/water/surface-water-data-api', refreshHours: '0,12' });
    if (waterConfig.enabled === false) return res.status(200).json({ disabled: true, fetchedAt: Math.floor(Date.now() / 1000), gauges: [] });
    var now = Date.now();
    if (waterNswGaugeCache.data) {
      var currentSlot = configuredWaterSlot(now, waterConfig.refreshHours);
      var cachedSlot = configuredWaterSlot(waterNswGaugeCache.fetchedAt || Number(waterNswGaugeCache.data.fetchedAt || 0) * 1000, waterConfig.refreshHours);
      if (cachedSlot === currentSlot || waterNswGaugeAttemptSlot === currentSlot) return res.status(200).json(waterNswGaugeCache.data);
      waterNswGaugeAttemptSlot = currentSlot;
    }
    if (!waterNswGaugeCache.data) {
      waterNswGaugeAttemptSlot = configuredWaterSlot(now, waterConfig.refreshHours);
    }
    var subscriptionKey = waterConfig.subscriptionKey || process.env.WATERNSW_DATA_KEY || process.env.WATERNSW_SUBSCRIPTION_KEY;
    if (!subscriptionKey) return res.status(503).json({ error: 'WaterNSW API subscription is not configured' });
    var sites = {};
    (centralWestGaugeMetadata.sites || []).forEach(function (site) {
      var siteId = String(site.siteId);
      sites[siteId] = {
        name: siteId === '421184' ? 'Cudgegong River upstream Rylstone' : siteId === '421903' ? 'Cudgegong River at Rylstone' : site.siteName,
        latitude: site.latitude,
        longitude: site.longitude,
        position: siteId === '421184' ? 'Upstream of Rylstone Dam' : siteId === '421903' ? 'Downstream at Rylstone' : 'WaterNSW site ' + siteId,
        featured: siteId === '421184' || siteId === '421903'
      };
    });
    var siteIds = Object.keys(sites);
    var batches = [];
    for (var i = 0; i < siteIds.length; i += 20) batches.push(siteIds.slice(i, i + 20));
    var requests = batches.map(function (batch) {
      return axios.get(waterConfig.apiUrl, {
        timeout: 20000,
        params: { siteId: batch.join(','), frequency: 'Latest', pageNumber: 1 },
        headers: { 'Ocp-Apim-Subscription-Key': subscriptionKey, 'Accept': 'application/json', 'User-Agent': 'CentralWestAlerts/1.0 WaterNSW gauge map' }
      });
    });
    Promise.all(requests).then(function (responses) {
      var grouped = {};
      var qualities = {};
      Object.keys(sites).forEach(function (siteId) {
        grouped[siteId] = Object.assign({ siteId: siteId, readings: {}, observedAt: null, quality: null }, sites[siteId]);
      });
      responses.forEach(function (response) {
        Object.assign(qualities, response.data.qualities || {});
        (response.data.latestRecords || []).forEach(function (record) {
          var gauge = grouped[String(record.siteId)];
          if (!gauge) return;
          gauge.readings[record.variableName] = { value: record.value, unit: record.unitOfMeasure, observedAt: record.timeStamp, qualityCode: record.qualityCode };
          if (!gauge.observedAt) gauge.observedAt = record.timeStamp;
        });
      });
      Object.keys(grouped).forEach(function (siteId) {
        var gauge = grouped[siteId];
        var primary = gauge.readings.StreamWaterLevel || gauge.readings.FlowRate;
        if (primary) {
          gauge.observedAt = primary.observedAt;
          gauge.quality = qualities[String(primary.qualityCode)] || null;
        }
      });
      var payload = { fetchedAt: Math.floor(now / 1000), source: 'WaterNSW Water Data API', bounds: centralWestGaugeMetadata.bounds, gauges: Object.keys(grouped).map(function (siteId) { return grouped[siteId]; }) };
      waterNswGaugeCache = { fetchedAt: now, data: payload };
      fs.writeFile(waterNswGaugeCacheFile, JSON.stringify(payload), function (writeError) { if (writeError) logger.main.warn('Unable to persist WaterNSW gauge cache: ' + writeError.message); });
      res.status(200).json(payload);
    }).catch(function (err) {
      logger.main.warn('Unable to retrieve Central West WaterNSW gauges: ' + err.message);
      if (waterNswGaugeCache.data) {
        waterNswGaugeCache.data.stale = true;
        return res.status(200).json(waterNswGaugeCache.data);
      }
      res.status(502).json({ error: 'Central West WaterNSW gauges are temporarily unavailable' });
    });
  });

router.route('/central-west/waternsw-algae-alerts')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var waterConfig = integrationConfig('waterNsw', { enabled: true });
    if (waterConfig.enabled === false) return res.status(200).json({ disabled: true, fetchedAt: Math.floor(Date.now() / 1000), sites: [], alerts: [] });
    var now = Date.now();
    if (waterNswAlgaeCache.data && now - waterNswAlgaeCache.fetchedAt < 60 * 60 * 1000) {
      return res.status(200).json(waterNswAlgaeCache.data);
    }
    var sourceUrl = 'https://nula.waternsw.com.au/arcgis/rest/services/External_Maps/AlgalAlerts/FeatureServer/0/query';
    axios.get(sourceUrl, {
      timeout: 15000,
      params: { where: '1=1', outFields: 'site_code,site_name,region,lat,long,current_status,current_tox_count,current_tox_bio,current_cyan_count,current_cyan_bio,comments,first_date,useage,dom_tox,Timestamp', returnGeometry: true, f: 'json' },
      headers: { 'Accept': 'application/json', 'User-Agent': 'CentralWestAlerts/1.0 WaterNSW algae map' }
    }).then(function (response) {
      var statusLabels = { '0': 'Green', '1': 'Amber', '2': 'Red' };
      var sites = ((response.data || {}).features || []).map(function (feature) {
        var item = feature.attributes || {};
        var latitude = Number(item.lat || (feature.geometry || {}).y);
        var longitude = Number(item.long || (feature.geometry || {}).x);
        return {
          siteCode: item.site_code,
          name: item.site_name,
          region: item.region,
          latitude: latitude,
          longitude: longitude,
          statusCode: String(item.current_status),
          status: statusLabels[String(item.current_status)] || 'Unknown',
          toxicCount: item.current_tox_count,
          toxicBiovolume: item.current_tox_bio,
          cyanobacteriaCount: item.current_cyan_count,
          cyanobacteriaBiovolume: item.current_cyan_bio,
          dominantToxicSpecies: item.dom_tox,
          usage: item.useage,
          comments: item.comments,
          sampledAt: item.first_date,
          updatedAt: item.Timestamp
        };
      }).filter(function (site) {
        return isFinite(site.latitude) && isFinite(site.longitude) && site.latitude >= -34.3 && site.latitude <= -31.5 && site.longitude >= 148.7 && site.longitude <= 150.25;
      });
      var payload = { fetchedAt: Math.floor(now / 1000), source: 'WaterNSW Algal Alert Map', sourceUrl: 'https://www.waternsw.com.au/water-services/water-quality/algae-alerts', sites: sites, alerts: sites.filter(function (site) { return site.status === 'Red' || site.status === 'Amber'; }) };
      waterNswAlgaeCache = { fetchedAt: now, data: payload };
      res.status(200).json(payload);
    }).catch(function (err) {
      logger.main.warn('Unable to retrieve WaterNSW algae alerts: ' + err.message);
      if (waterNswAlgaeCache.data) return res.status(200).json(waterNswAlgaeCache.data);
      res.status(502).json({ error: 'WaterNSW algae alerts are temporarily unavailable' });
    });
  });

router.route('/central-west/aircraft')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var piawareConfig = integrationConfig('piaware', {
      enabled: true,
      aircraftUrl: 'http://192.168.1.118/skyaware/data/aircraft.json',
      timeoutSeconds: 4,
      maximumAgeSeconds: 60
    });
    res.set('Cache-Control', 'private, no-store');
    if (piawareConfig.enabled === false) {
      return res.status(200).json({ disabled: true, now: Date.now() / 1000, aircraft: [] });
    }
    var timeoutMs = Math.min(Math.max(parseInt(piawareConfig.timeoutSeconds, 10) || 4, 1), 30) * 1000;
    var maximumAge = Math.min(Math.max(parseInt(piawareConfig.maximumAgeSeconds, 10) || 60, 5), 600);
    axios.get(piawareConfig.aircraftUrl, { timeout: timeoutMs })
      .then(function (response) {
        var data = response.data || {};
        var aircraft = (data.aircraft || []).filter(function (item) {
          return typeof item.lat === 'number' && typeof item.lon === 'number' && (Number(item.seen) || 0) <= maximumAge;
        }).map(function (item) {
          return {
            hex: item.hex,
            flight: String(item.flight || '').trim(),
            registration: item.r || '',
            aircraftType: item.t || '',
            latitude: item.lat,
            longitude: item.lon,
            altitude: item.alt_baro === 'ground' ? 'ground' : (item.alt_baro || item.alt_geom || null),
            speed: item.gs || null,
            track: item.track || null,
            verticalRate: item.baro_rate || item.geom_rate || null,
            emergency: item.emergency || 'none',
            category: item.category || '',
            seen: item.seen || 0,
            messages: item.messages || 0
          };
        });
        res.status(200).json({ now: data.now || Date.now() / 1000, aircraft: aircraft });
      }).catch(function (err) {
        logger.main.warn('Unable to retrieve local PiAware feed: ' + err.message);
        res.status(502).json({ error: 'PiAware receiver is temporarily unavailable' });
      });
  });

// Read-only bridge to the local Rdio Scanner database. These routes require
// an authenticated browser session; PageMon API keys cannot retrieve radio
// metadata or audio.
router.route('/central-west/radio-calls')
  .get(isSessionUser, function (req, res) {
    var radioConfig = integrationConfig('radio', { enabled: true, databasePath: '/home/rodgrech/Applications/rdio-scanner.db', maximumCalls: 50 });
    if (radioConfig.enabled === false) return res.status(200).json({ disabled: true, calls: [], fetchedAt: Math.floor(Date.now() / 1000) });
    var maximumCalls = Math.min(Math.max(parseInt(radioConfig.maximumCalls, 10) || 50, 1), 100);
    var limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), maximumCalls);
    var rdioDatabasePath = path.resolve(radioConfig.databasePath);
    if (!fs.existsSync(rdioDatabasePath)) {
      res.set('Cache-Control', 'private, no-store');
      return res.status(200).json({ calls: [], available: false, fetchedAt: Math.floor(Date.now() / 1000) });
    }
    var radioDb = new sqlite3.Database(rdioDatabasePath, sqlite3.OPEN_READONLY, function (openError) {
      if (openError) {
        logger.main.error('Unable to open Rdio Scanner database: ' + openError.message);
        return res.status(503).json({ error: 'Radio history is temporarily unavailable.' });
      }

      var sql = [
        'select c.id, c.dateTime, c.system, s.label as systemLabel,',
        'c.talkgroup, coalesce(t.label, t.name) as talkgroupLabel,',
        'c.frequency, c.source, u.label as sourceLabel, g.label as groupLabel, x.label as tagLabel,',
        'length(c.audio) as audioBytes, c.audioType, c.audioName',
        'from rdioScannerCalls c',
        'left join rdioScannerSystems s on s.id = c.system',
        'left join rdioScannerTalkgroups t on t.systemId = c.system and t.id = c.talkgroup',
        'left join rdioScannerUnits u on u.systemId = c.system and u.id = c.source',
        'left join rdioScannerGroups g on g._id = t.groupId',
        'left join rdioScannerTags x on x._id = t.tagId',
        'order by c.id desc limit ?'
      ].join(' ');

      radioDb.all(sql, [limit], function (queryError, rows) {
        radioDb.close();
        if (queryError) {
          logger.main.error('Unable to query Rdio Scanner calls: ' + queryError.message);
          return res.status(503).json({ error: 'Radio history is temporarily unavailable.' });
        }
        rows.forEach(function (row) {
          var parsed = Date.parse(String(row.dateTime || '').replace(' +0000 UTC', 'Z'));
          var agency = radioAgency(row.groupLabel, row.tagLabel);
          row.timestamp = isNaN(parsed) ? null : Math.floor(parsed / 1000);
          row.agencyName = agency.name;
          row.agencyCode = agency.code;
          delete row.dateTime;
          delete row.groupLabel;
          delete row.tagLabel;
          row.audioUrl = '/api/central-west/radio-calls/' + row.id + '/audio';
        });
        res.set('Cache-Control', 'private, no-store');
        res.status(200).json({ calls: rows, fetchedAt: Math.floor(Date.now() / 1000) });
      });
    });
  });

router.route('/central-west/radio-calls/:id/audio')
  .get(isSessionUser, function (req, res) {
    var radioConfig = integrationConfig('radio', { enabled: true, databasePath: '/home/rodgrech/Applications/rdio-scanner.db' });
    if (radioConfig.enabled === false) return res.status(404).json({ error: 'Radio integration is disabled.' });
    var rdioDatabasePath = path.resolve(radioConfig.databasePath);
    if (!fs.existsSync(rdioDatabasePath)) return res.status(404).json({ error: 'Radio integration is not configured on this server.' });
    var id = parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid radio call ID.' });

    var radioDb = new sqlite3.Database(rdioDatabasePath, sqlite3.OPEN_READONLY, function (openError) {
      if (openError) {
        logger.main.error('Unable to open Rdio Scanner database for audio: ' + openError.message);
        return res.status(503).json({ error: 'Radio audio is temporarily unavailable.' });
      }
      radioDb.get('select audio, audioName, audioType from rdioScannerCalls where id = ?', [id], function (queryError, row) {
        radioDb.close();
        if (queryError) {
          logger.main.error('Unable to retrieve Rdio Scanner audio: ' + queryError.message);
          return res.status(503).json({ error: 'Radio audio is temporarily unavailable.' });
        }
        if (!row || !row.audio) return res.status(404).json({ error: 'Radio call not found.' });

        var audio = Buffer.isBuffer(row.audio) ? row.audio : Buffer.from(row.audio);
        var contentType = row.audioType || (/\.m4a$/i.test(row.audioName || '') ? 'audio/mp4' : 'audio/mpeg');
        var range = req.headers.range;
        res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'private, max-age=3600');
        res.type(contentType);

        if (range) {
          var match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match) return res.status(416).set('Content-Range', 'bytes */' + audio.length).end();
          var start = match[1] ? parseInt(match[1], 10) : 0;
          var end = match[2] ? parseInt(match[2], 10) : audio.length - 1;
          if (start < 0 || end < start || start >= audio.length) return res.status(416).set('Content-Range', 'bytes */' + audio.length).end();
          end = Math.min(end, audio.length - 1);
          res.status(206);
          res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + audio.length);
          res.set('Content-Length', String(end - start + 1));
          return res.end(audio.slice(start, end + 1));
        }

        res.set('Content-Length', String(audio.length));
        return res.end(audio);
      });
    });
  });

router.route('/central-west/weather-radar')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    var radarConfig = integrationConfig('weatherRadar', {
      enabled: true,
      metadataUrl: 'https://api.rainviewer.com/public/weather-maps.json',
      cacheMinutes: 10,
      opacityPercent: 62
    });
    res.set('Cache-Control', 'private, no-store');
    if (radarConfig.enabled === false) return res.status(200).json({ disabled: true });
    var now = Date.now();
    var cacheMs = Math.min(Math.max(parseInt(radarConfig.cacheMinutes, 10) || 10, 1), 1440) * 60 * 1000;
    if (radarCache.data && now - radarCache.fetchedAt < cacheMs) {
      return res.status(200).json(radarCache.data);
    }
    axios.get(radarConfig.metadataUrl, { timeout: 10000 })
      .then(function (response) {
        var data = response.data || {};
        var frames = data.radar && data.radar.past ? data.radar.past : [];
        var latest = frames.length ? frames[frames.length - 1] : null;
        if (!latest || !data.host) throw new Error('No radar frame available');
        var payload = {
          generated: data.generated,
          frameTime: latest.time,
          tileUrl: data.host + latest.path + '/256/{z}/{x}/{y}/2/1_1.png',
          opacity: Math.min(Math.max(parseInt(radarConfig.opacityPercent, 10) || 62, 10), 100) / 100,
          attribution: 'Weather radar by RainViewer'
        };
        radarCache = { fetchedAt: now, data: payload };
        res.status(200).json(payload);
      }).catch(function (err) {
        logger.main.warn('Unable to retrieve RainViewer radar metadata: ' + err.message);
        if (radarCache.data) return res.status(200).json(radarCache.data);
        res.status(502).json({ error: 'Weather radar is temporarily unavailable' });
      });
  });

router.use([handleError]);

module.exports = router;

function handleError(err, req, res, next) {
  var output = {
    error: {
      name: err.name,
      message: err.message,
      text: err.toString()
    }
  };
  var statusCode = err.status || 500;
  res.status(statusCode).json(output);
}

function parseJSON(json) {
  var parsed;
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    // ignore errors
  }
  return parsed;
}
