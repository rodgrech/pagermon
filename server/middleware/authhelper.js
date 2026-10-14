// pass passport for configuration
const bcrypt = require('bcryptjs');
var nconf = require('nconf');
const permissions = require('../lib/permissions');

var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

function isLoggedIn (req, res, next) {    
    const passport = require('../auth/local');
            if (req.isAuthenticated()) {
                // if user is authenticated in the session, carry on
                return next();
            } else {
                //perform api authentication - all api keys are assumed to be admin 
                return passport.authenticate('login-api', { session: false, failWithError: true })(req, res, next),
                    function (next) {
                        next();
                    },
                    function (res) {
                        return res.status(401).json({ error: 'Authentication failed.' });
                    }
            }
}

function isLoggedInMessages (req, res, next) {    
    const passport = require('../auth/local');
    var apiSecurity = nconf.get('messages:apiSecurity');
        if (apiSecurity) { //check if Secure mode is on
            if (req.isAuthenticated()) {
                // if user is authenticated in the session, carry on
                return next();
            } else {
                //perform api authentication - all api keys are assumed to be admin 
                return passport.authenticate('login-api', { session: false, failWithError: true })(req, res, next),
                    function (next) {
                        next();
                    },
                    function (res) {
                        return res.status(401).json({ error: 'Authentication failed.' });
                    }
            }
        } else {
            return next();
        }
}

function isAdminGUI (req, res, next) {
    if (req.isAuthenticated() && permissions.adminAccess(req.user)) {
      if (nconf.get('auth:requireAdminTwoFactor') && !req.user.totp_enabled) return res.redirect('/auth/profile');
      //if the user is authenticated and the user's role is admin carry on
      return next();
    } else {
        res.redirect('/')
    }
}

function isAdmin (req, res, next) {
    if (req.isAuthenticated() && req.user.role !== 'admin') {
      var permission = 'manageSettings';
      var route = req.path || '';
      if (/^\/messages\/[^/]+\/visibility$/.test(route)) permission = 'moderateMessages';
      else if (/^\/user\/[^/]+\/(approve|deny)$/.test(route)) permission = 'approveUsers';
      else if (/^\/user(?:\/|$)|^\/userCheck\//.test(route)) {
        if (req.method === 'GET' && permissions.has(req.user, 'approveUsers')) return next();
        permission = 'manageUsers';
      } else if (/^\/capcode/.test(route)) permission = 'manageAliases';
      if (permissions.has(req.user, permission)) return next();
      return res.status(403).json({error: 'You do not have permission for this action'});
    }
    const passport = require('../auth/local');
    if (req.isAuthenticated() && req.user.role == 'admin') {
      if (nconf.get('auth:requireAdminTwoFactor') && !req.user.totp_enabled) return res.status(403).json({error: 'Administrator two-factor enrolment is required.'});
      //if the user is authenticated and the user's role is admin carry on
      return next();
    } else {
        //if apikey in header perform api authentication - all api keys are assumed to be admin 
      return passport.authenticate('login-api', { session: false, failWithError: true })(req, res, next),
        function (next) {
          next();
        },
        function (res) {
          return res.status(401).json({ error: 'Authentication failed.' });
        }
    } 
  }

  function comparePass(userPassword, databasePassword) {
    return bcrypt.compareSync(userPassword, databasePassword);
}

module.exports = {
    isLoggedIn,
    isLoggedInMessages,
    isAdmin,
    isAdminGUI,
    comparePass
}
  
