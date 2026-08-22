var express = require('express');
var bodyParser = require('body-parser');
var router = express.Router();
var bcrypt = require('bcryptjs');
var fs = require('fs');
var logger = require('../log');
var util = require('util');
var passport = require('../auth/local'); // pass passport for configuration
const authHelper = require('../middleware/authhelper')

router.use(function (req, res, next) {
    res.locals.login = req.isAuthenticated();
    res.locals.user = req.user;
    res.locals.monitorName = nconf.get("global:monitorName");
    next();
});

var nconf = require('nconf');
var confFile = './config/config.json';
var conf_backup = './config/backup.json';
var defaultConfig = require('../config/default.json');
var integrationDefaults = defaultConfig.integrations;

nconf.file({ file: confFile });
nconf.load();

router.use(bodyParser.json());       // to support JSON-encoded bodies
router.use(bodyParser.urlencoded({     // to support URL-encoded bodies
    extended: true
}));

router.route('/settingsData')
    .get(authHelper.isAdmin, function (req, res, next) {
        nconf.load();
        let settings = nconf.get();
        settings.integrations = Object.assign({}, integrationDefaults, settings.integrations || {});
        Object.keys(integrationDefaults).forEach(function (name) {
            settings.integrations[name] = Object.assign({}, integrationDefaults[name], settings.integrations[name] || {});
        });
        settings.notifications = Object.assign({}, defaultConfig.notifications, settings.notifications || {});
        settings.notifications.webPush = Object.assign({}, defaultConfig.notifications.webPush, settings.notifications.webPush || {});
        // logger.main.debug(util.format('Config:\n\n%o',settings));
        let plugins = [];
        fs.readdirSync('./plugins').forEach(file => {
            if (file.endsWith('.json')) {
                let pConf = require(`../plugins/${file}`);
                if (!pConf.disable)
                    plugins.push(pConf);
            }
        });
        let themes = [];
        fs.readdirSync('./themes').forEach(file => {
            themes.push(file)
        });
        // logger.main.debug(util.format('Plugin Config:\n\n%o',plugins));
        let data = { "settings": settings, "plugins": plugins, "themes": themes, "pwaIconThemes": themes }
        res.json(data);
    })
    .post(authHelper.isAdmin, function (req, res, next) {
        nconf.load();
        if (req.body) {
            var currentConfig = nconf.get();
            var currentTheme = (currentConfig.global && currentConfig.global.theme) || 'default';
            var requestedTheme = (req.body.global && req.body.global.theme) || 'default';
            var requestedThemePath = './themes/' + requestedTheme;
            var currentPwaIconTheme = (currentConfig.global && currentConfig.global.pwaIconTheme) || 'theme';
            var requestedPwaIconTheme = (req.body.global && req.body.global.pwaIconTheme) || 'theme';

            if (!/^[a-zA-Z0-9_-]+$/.test(requestedTheme) || !fs.existsSync(requestedThemePath)) {
                return res.status(400).send({ error: 'Selected theme is not installed.' });
            }
            if (requestedPwaIconTheme !== 'theme' &&
                (!/^[a-zA-Z0-9_-]+$/.test(requestedPwaIconTheme) || !fs.existsSync('./themes/' + requestedPwaIconTheme))) {
                return res.status(400).send({ error: 'Selected PWA icon set is not installed.' });
            }

            var pwaIconChanged = currentPwaIconTheme !== requestedPwaIconTheme;
            if (pwaIconChanged) req.body.global.pwaIconVersion = Date.now();

            fs.writeFileSync(conf_backup, JSON.stringify(currentConfig, null, 2));
            fs.writeFileSync(confFile, JSON.stringify(req.body, null, 2));
            nconf.load();
            res.status(200).send({
                status: 'ok',
                restartRequired: currentTheme !== requestedTheme,
                theme: requestedTheme,
                pwaIconChanged: pwaIconChanged
            });
        } else {
            res.status(400).send({ error: 'request body empty' });
        }
    });

router.post('/restart', authHelper.isAdmin, function (req, res) {
    if (!/^(1|true|yes)$/i.test(String(process.env.PAGERMON_ALLOW_WEB_RESTART || ''))) {
        return res.status(403).send({ error: 'Web restart is disabled by the server administrator.' });
    }
    res.status(202).send({ status: 'restarting' });
    setTimeout(function () { process.exit(0); }, 750);
});

router.get('*', authHelper.isAdminGUI, function (req, res, next) {
    res.render('admin', { pageTitle: 'Admin' });
});

module.exports = router;
