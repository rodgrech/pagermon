var confFile = './config/config.json';
var express = require('express');
var router = express.Router();
var nconf = require('nconf');
var db = require('../knex/knex.js');

nconf.file({ file: confFile });
nconf.load();

const passport = require('../auth/local');

router.use(function (req, res, next) {
    res.locals.login = req.isAuthenticated();
    res.locals.user = req.user || false;
    res.locals.register = nconf.get('auth:registration')
    res.locals.hidecapcode = nconf.get('messages:HideCapcode');
    res.locals.pdwmode = nconf.get('messages:pdwMode');
    res.locals.hidesource = nconf.get('messages:HideSource');
    res.locals.apisecurity = nconf.get('messages:apiSecurity');
    res.locals.iconsize = nconf.get('messages:iconsize');
    res.locals.gaEnable = nconf.get('monitoring:gaEnable');
    res.locals.gaTrackingCode = nconf.get('monitoring:gaTrackingCode');
    res.locals.frontPopupEnable = nconf.get('global:frontPopupEnable');
    res.locals.frontPopupTitle = nconf.get('global:frontPopupTitle');
    res.locals.frontPopupContent = nconf.get('global:frontPopupContent');
    res.locals.searchLocation = nconf.get('global:searchLocation');
    res.locals.monitorName = nconf.get("global:monitorName");
    res.locals.faKey = nconf.get("global:faKey");
    next();
});

/* GET home page. */
router.get('/', function (req, res, next) {
    if (nconf.get('messages:apiSecurity') && !req.isAuthenticated()) {
        req.flash('loginMessage', 'You need to be logged in to access this page');
        return res.redirect('/auth/login');
    }

    res.render('index', { pageTitle: 'Home' });
});

/* Detailed receiver status is private account information. */
router.get('/service-status', function (req, res) {
    res.set({
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    if (!req.isAuthenticated()) {
        req.flash('loginMessage', 'You need to be logged in to view service status');
        return res.redirect('/auth/login');
    }

    res.render('service-status', { pageTitle: 'Service Status' });
});

router.get('/pwa-help', function (req, res) {
    if (!req.isAuthenticated()) {
        req.flash('loginMessage', 'You need to be logged in to view the app setup guide');
        return res.redirect('/auth/login');
    }
    res.render('pwa-help', { pageTitle: 'App setup', suppressAutomaticModals: true });
});

router.post('/welcome/acknowledge', function (req, res) {
    if (!req.isAuthenticated()) return res.status(401).json({error: 'Authentication required.'});
    db('users').where('id', req.user.id).update({welcome_acknowledged: true}).then(function () {
        req.user.welcome_acknowledged = true;
        res.json({status: 'ok'});
    }).catch(function (error) {
        res.status(500).json({error: error.message});
    });
});

module.exports = router;
