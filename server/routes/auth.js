const express = require('express');

const router = express.Router();
const bcrypt = require('bcryptjs');
const moment = require('moment');
const nconf = require('nconf');

const confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

// Rate limiting for login and public duplicate-checking routes.
const { rateLimit } = require('express-rate-limit');

const db = require('../knex/knex.js');
const logger = require('../log');
const passport = require('../auth/local');
const authHelper = require('../middleware/authhelper')
const twoFactor = require('../lib/twoFactor');

const lockoutCallback = function(req, res) {
        res.status(429).send({ status: 'lockedout', error: 'Too many attempts, please try again later' });
        logger.auth.info(`Rate limit lockout: ${req.ip}`);
};

const duplicateCheckLimiter = rateLimit({
        windowMs: 20000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        handler: lockoutCallback,
});

const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 4,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        handler: lockoutCallback,
});

const twoFactorLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 8,
        standardHeaders: true,
        legacyHeaders: false,
        handler: lockoutCallback,
});

function loginComplete(req, res, user, remember) {
        return new Promise(function(resolve, reject) {
                req.logIn(user, function(err) { if (err) return reject(err); resolve(); });
        }).then(function() {
                const currentDatetime = moment().format('YYYY-MM-DD HH:mm:ss');
                return db('users').where('id', user.id).update({lastlogondate: currentDatetime});
        }).then(function() {
                delete req.session.pendingTwoFactorUserId;
                if (!remember) return null;
                const raw = require('crypto').randomBytes(32).toString('hex');
                const days = Math.max(1, Math.min(365, Number(nconf.get('auth:twoFactorRememberDays')) || 30));
                const expires = moment().add(days, 'days');
                return db('two_factor_devices').insert({user_id: user.id, token_hash: twoFactor.hash(raw), created_at: moment().format('YYYY-MM-DD HH:mm:ss'), expires_at: expires.format('YYYY-MM-DD HH:mm:ss')}).then(function() {
                        res.cookie('pagermon_2fa', raw, {httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: days * 86400000});
                });
        }).then(function() {
                res.status(200).send({status: 'ok', redirect: user.role === 'admin' ? '/admin' : '/'});
                logger.auth.info(`Successful login: ${user.username}`);
        });
}

// End Bruteforce

router.route('/login')
        .get(function(req, res) {
                if (!req.isAuthenticated()) {
                        let user = '';
                        if (typeof req.username !== 'undefined') {
                                user = req.username;
                        }
                        res.render('auth', {
                                pageTitle: 'User',
                                loginPage: true,
                                loginBackgroundEnabled: Boolean(String(nconf.get('global:loginBackgroundUrl') || '').trim()),
                                loginBackgroundOpacity: Math.max(0, Math.min(100, Number(nconf.get('global:loginBackgroundOpacity')) || 32)),
                        });
                } else {
                        res.redirect('/');
                }
        })
        .post(loginLimiter, function(req, res, next) {
                passport.authenticate('login-user', (err, user) => {
                        if (err) {
                                //this is commented out as it seems to fire when a user is disabled?! even tho the below functions still run
                                //res.status(500).send({ status: 'failed', error: 'An Error Occured' });
                                logger.auth.error(err);
                        } else if (!user) {
                                res.status(401).send({ status: 'failed', error: 'Check Details and try again' });
                                logger.auth.debug(`Login Failed: ${req.body.username}`);
                        } else if (user) {
                                if (user.approvalpending) {
                                        res.status(401).send({
                                                status: 'pending',
                                                error: 'Account awaiting administrator approval',
                                        });
                                        logger.auth.info(`Pending account login blocked: ${user.username}`);
                                } else if (user.status !== 'disabled') {
                                        if (user.role === 'admin' && user.totp_enabled) {
                                                const trusted = req.cookies.pagermon_2fa;
                                                const trustedQuery = trusted ? db('two_factor_devices').where({user_id: user.id, token_hash: twoFactor.hash(trusted)}).where('expires_at', '>', moment().format('YYYY-MM-DD HH:mm:ss')).first() : Promise.resolve(null);
                                                return trustedQuery.then(function(device) {
                                                        if (device) return loginComplete(req, res, user, false);
                                                        req.session.pendingTwoFactorUserId = user.id;
                                                        res.status(200).send({status: 'two-factor', redirect: '/auth/two-factor'});
                                                }).catch(next);
                                        }
                                        req.logIn(user, function(err) {
                                                if (err) {
                                                        res.status(401).send({
                                                                status: 'failed',
                                                                error: 'An error occured',
                                                        });
                                                        logger.auth.debug(
                                                                `Failed login ${JSON.stringify(user)} ${err}`
                                                        );
                                                } else {
                                                        // Update last logon timestamp for user
                                                        const { id } = user;
                                                        // create the datetime, thanks mysql ┌∩┐(◣_◢)┌∩┐
                                                        const currentTimestamp = moment().unix(); // in seconds
                                                        const currentDatetime = moment(currentTimestamp * 1000).format(
                                                                'YYYY-MM-DD HH:mm:ss'
                                                        );
                                                        return db
                                                                .from('users')
                                                                .where('id', '=', id)
                                                                .update({
                                                                        lastlogondate: currentDatetime,
                                                                })
                                                                .then(() => {
                                                                        if (user.role !== 'admin') {
                                                                                res.status(200).send({
                                                                                        status: 'ok',
                                                                                        redirect: '/',
                                                                                });
                                                                        } else {
                                                                                res.status(200).send({
                                                                                        status: 'ok',
                                                                                        redirect: '/admin',
                                                                                });
                                                                        }
                                                                        logger.auth.debug(
                                                                                `Successful login ${JSON.stringify(
                                                                                        user
                                                                                )}`
                                                                        );
                                                                })
                                                                .catch(err => {
                                                                        logger.db.error(err);
                                                                });
                                                }
                                        });
                                } else {
                                        res.status(401).send({ status: 'failed', error: 'User Disabled' });
                                        logger.auth.debug(`User Disabled${req.user.username}`);
                                }
                        }
                })(req, res, next);
        });

router.get('/two-factor', function(req, res) {
        if (!req.session.pendingTwoFactorUserId) return res.redirect('/auth/login');
        res.render('auth', {pageTitle: 'Two-factor authentication', twoFactorPage: true});
});

router.post('/two-factor', twoFactorLimiter, function(req, res, next) {
        const userId = req.session.pendingTwoFactorUserId;
        if (!userId) return res.status(401).send({error: 'Your login session expired. Please sign in again.'});
        db('users').where('id', userId).first().then(function(user) {
                if (!user || !user.totp_enabled) throw new Error('Two-factor authentication is unavailable.');
                const code = String(req.body.code || '').trim().toUpperCase();
                let valid = twoFactor.verify(twoFactor.decrypt(user.totp_secret), code);
                let recovery = [];
                try { recovery = JSON.parse(user.totp_recovery_codes || '[]'); } catch (ignore) {}
                const recoveryHash = twoFactor.hash(code);
                const recoveryIndex = recovery.indexOf(recoveryHash);
                if (recoveryIndex >= 0) { valid = true; recovery.splice(recoveryIndex, 1); }
                if (!valid) return res.status(401).send({error: 'Invalid authentication or recovery code.'});
                const update = recoveryIndex >= 0 ? db('users').where('id', user.id).update({totp_recovery_codes: JSON.stringify(recovery)}) : Promise.resolve();
                return update.then(function() { return loginComplete(req, res, user, Boolean(req.body.remember)); });
        }).catch(next);
});

router.route('/logout').get(authHelper.isLoggedIn, function(req, res, next) {
        const username = req.user.username;
        req.logout(function(err) {
                if (err) return next(err);
                logger.auth.debug(`Successful Logout ${username}`);
                return res.redirect('/');
        });
});

router.route('/profile/').get(authHelper.isLoggedIn, function(req, res) {
        res.render('auth', {
                pageTitle: 'User',
        });
});

router.route('/profile/:id')
        .get(authHelper.isLoggedIn, function(req, res, next) {
                const { username } = req.user;
                db.from('users')
                        .select('id', 'givenname', 'surname', 'username', 'email', 'lastlogondate', 'role', 'totp_enabled', 'totp_enrolled_at')
                        .where('username', username)
                        .then(function(row) {
                                if (row.length > 0) {
                                        const rowsend = row[0];
                                        res.status(200);
                                        res.json(rowsend);
                                } else {
                                        res.status(500).json({ status: 'failed', error: '' });
                                        logger.auth.error('failed to select user');
                                }
                        })
                        .catch(err => {
                                logger.main.error(err);
                                return next(err);
                        });
        })
        .post(authHelper.isLoggedIn, function(req, res) {
                if (req.body.username === req.user.username) {
                        const { username } = req.body;
                        const { givenname } = req.body;
                        const surname = req.body.surname || '';
                        const { email } = req.body;
                        const lastlogondate = Date.now();
                        console.time('insert');
                        db.from('users')
                                .where('username', '=', req.user.username)
                                .update({
                                        username,
                                        givenname,
                                        surname,
                                        email,
                                        lastlogondate,
                                })
                                .then(result => {
                                        console.timeEnd('insert');
                                        res.status(200).send({ status: 'ok', id: result });
                                })
                                .catch(err => {
                                        console.timeEnd('insert');
                                        logger.main.error(err);
                                        res.status(400).send(err);
                                });
                } else {
                        res.status(401).json({ message: 'Please update your own details only' });
                        logger.auth.error('Possible attempt to compromise security POST:/auth/profile');
                }
        });

router.post('/two-factor/enrol', authHelper.isLoggedIn, function(req, res) {
        if (req.user.role !== 'admin') return res.status(403).send({error: 'Two-factor authentication is currently available for administrators.'});
        const secret = twoFactor.newSecret();
        req.session.pendingTotpSecret = secret;
        const issuer = String(nconf.get('global:monitorName') || 'PagerMon');
        const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(req.user.username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
        res.send({status: 'ok', secret: secret, uri: uri});
});

router.post('/two-factor/confirm', authHelper.isLoggedIn, twoFactorLimiter, function(req, res) {
        const secret = req.session.pendingTotpSecret;
        if (req.user.role !== 'admin' || !secret) return res.status(400).send({error: 'Start enrolment again.'});
        if (!twoFactor.verify(secret, req.body.code)) return res.status(400).send({error: 'That code is not valid. Check the device clock and try again.'});
        const codes = twoFactor.recoveryCodes();
        db('users').where('id', req.user.id).update({totp_enabled: true, totp_secret: twoFactor.encrypt(secret), totp_recovery_codes: JSON.stringify(codes.map(twoFactor.hash)), totp_enrolled_at: moment().format('YYYY-MM-DD HH:mm:ss')}).then(function() {
                delete req.session.pendingTotpSecret;
                res.send({status: 'ok', recoveryCodes: codes});
        }).catch(function(err) { logger.auth.error(err); res.status(500).send({error: 'Unable to enable two-factor authentication.'}); });
});

router.post('/two-factor/disable', authHelper.isLoggedIn, twoFactorLimiter, function(req, res) {
        if (req.user.role !== 'admin' || !authHelper.comparePass(req.body.password || '', req.user.password)) return res.status(401).send({error: 'Password incorrect.'});
        db.transaction(function(trx) {
                return trx('two_factor_devices').where('user_id', req.user.id).del().then(function() {
                        return trx('users').where('id', req.user.id).update({totp_enabled: false, totp_secret: null, totp_recovery_codes: null, totp_enrolled_at: null});
                });
        }).then(function() { res.clearCookie('pagermon_2fa'); res.send({status: 'ok'}); }).catch(function(err) { logger.auth.error(err); res.status(500).send({error: 'Unable to disable two-factor authentication.'}); });
});

router.route('/register')
        .get(function(req, res) {
                const reg = nconf.get('auth:registration');
                if (reg) {
                        res.render('auth', {
                                title: 'Registration',
                                message: req.flash('registerMessage'),
                        });
                } else {
                        res.redirect('/');
                }
        })
        .post(function(req, res, next) {
                const reg = nconf.get('auth:registration');
                if (reg) {
                        const salt = bcrypt.genSaltSync();
                        const hash = bcrypt.hashSync(req.body.password, salt);
                        // dupecheck to prevent a non-literal insert being abused to reset passwords
                        return db('users')
                                .where('username', '=', req.body.username)
                                .orWhere('email', '=', req.body.email)
                                .select('id')
                                .then(row => {
                                        if (row.length > 0) {
                                                logger.auth.error(
                                                        `Duplicate registration via API${JSON.stringify(row)}`
                                                );
                                                res.status(401).json({ error: 'access denied' });
                                        } else {
                                                return db('users')
                                                        .insert({
                                                                username: req.body.username,
                                                                password: hash,
                                                                givenname: req.body.givenname,
                                                                surname: req.body.surname,
                                                                email: req.body.email,
                                                                role: 'user',
                                                                status: nconf.get('auth:requireApproval') ? 'disabled' : 'active',
                                                                approvalpending: Boolean(nconf.get('auth:requireApproval')),
                                                                lastlogondate: Date.now(),
                                                        })
                                                        .then(() => {
                                                                if (nconf.get('auth:requireApproval')) {
                                                                        logger.auth.info(`Created account pending approval: ${req.body.username}`);
                                                                        return res.status(200).json({
                                                                                status: 'pending',
                                                                                message: 'Registration received. An administrator must approve your account before you can sign in.',
                                                                                redirect: '/auth/login',
                                                                        });
                                                                }
                                                                passport.authenticate('login-user', (err, user) => {
                                                                        if (user) {
                                                                                req.logIn(user, function(err) {
                                                                                        if (err) {
                                                                                                res.status(500).json({
                                                                                                        status:
                                                                                                                'failed',
                                                                                                        error: err,
                                                                                                        redirect:
                                                                                                                '/auth/register',
                                                                                                });
                                                                                                logger.auth.error(err);
                                                                                        } else {
                                                                                                res.status(200).json({
                                                                                                        status: 'ok',
                                                                                                        redirect: '/',
                                                                                                });
                                                                                                logger.auth.info(
                                                                                                        `Created Account: ${user}`
                                                                                                );
                                                                                        }
                                                                                });
                                                                        } else {
                                                                                logger.auth.error(err);
                                                                                res.status(500).json({
                                                                                        status: 'failed',
                                                                                        error: err,
                                                                                        redirect: '/auth/register',
                                                                                });
                                                                        }
                                                                })(req, res, next);
                                                        })
                                                        .catch(err => {
                                                                logger.auth.error(err);
                                                                res.status(400).json({
                                                                        status: 'failed',
                                                                        error: 'invalid data',
                                                                });
                                                        });
                                        }
                                });
                }
                logger.auth.error('Registration attempted with registration disabled');
                res.status(400).json({ error: 'registration disabled' });
        });

router.route('/reset')
        .get(function(req, res) {
                let user = '';
                if (typeof req.username !== 'undefined') {
                        user = req.username;
                }
                if (req.user) {
                        return res.render('auth', {
                                title: 'User - Reset Password',
                                message: req.flash('loginMessage'),
                                username: user,
                        });
                } else {
                res.redirect('/auth/login');
                }
        })
        .post(authHelper.isLoggedIn, function(req, res) {
                const { password } = req.body;
                // bcrypt function
                if (password.length && !authHelper.comparePass(password, req.user.password)) {
                        const salt = bcrypt.genSaltSync();
                        const hash = bcrypt.hashSync(req.body.password, salt);
                        const { id } = req.user;
                        //need to update this query to select the user first then update. 
                        db.from('users')
                                .returning('id')
                                .where('id', '=', id)
                                .update({
                                        password: hash,
                                })
                                .then(() => {
                                        res.status(200).send({ status: 'ok', redirect: '/' });
                                        logger.auth.debug(`${req.user.username} Password Reset Successfully`);
                                })
                                .catch(err => {
                                        res.status(500).send({ status: 'failed', error: 'Failed to update password' });
                                        logger.auth.error(`${req.user.username} error resetting password${err}`);
                                        console.log(err)
                                });
                } else {
                        res.status(400).send({ status: 'failed', error: 'Password Blank or the Same' });
                }
        });

router.route('/userCheck/username/:id').get(duplicateCheckLimiter, function(req, res, next) {
        const { id } = req.params;
        db.from('users')
                .select('username')
                .where('username', id)
                .then(row => {
                        if (row.length > 0) {
                                const rowsend = row[0];
                                res.status(200);
                                res.json(rowsend);
                        } else {
                                const rowsend = {
                                        username: '',
                                        password: '',
                                        givenname: '',
                                        surname: '',
                                        email: '',
                                        role: 'user',
                                        status: 'active',
                                };
                                res.status(200);
                                res.json(rowsend);
                        }
                })
                .catch(err => {
                        logger.main.error(err);
                        return next(err);
                });
});

router.route('/userCheck/email/:id').get(duplicateCheckLimiter, function(req, res, next) {
        const { id } = req.params;
        db.from('users')
                .select('email')
                .where('email', id)
                .then(row => {
                        if (row.length > 0) {
                                const rowsend = row[0];
                                res.status(200);
                                res.json(rowsend);
                        } else {
                                const rowsend = {
                                        username: '',
                                        password: '',
                                        givenname: '',
                                        surname: '',
                                        email: '',
                                        role: 'user',
                                        status: 'active',
                                };
                                res.status(200);
                                res.json(rowsend);
                        }
                })
                .catch(err => {
                        logger.main.error(err);
                        return next(err);
                });
});

module.exports = router;
