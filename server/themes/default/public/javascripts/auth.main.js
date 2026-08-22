angular.module('app', ['ngRoute', 'ngResource', 'ngSanitize', 'angular-uuid', 'ui.bootstrap', 'ui.validate', 'textAngular'])
    // Service
    .factory('Api', ['$resource',
        function ($resource) {
            return {
                Login: $resource('/auth/login/', null, {
                    'post': { method: 'POST', isArray: false }
                }),
                Register: $resource('/auth/register/', null, {
                    'post': { method: 'POST', isArray: false }
                }),
                Reset: $resource('/auth/reset/', null, {
                    'post': { method: 'POST', isArray: false }
                }),
                UserDetail: $resource('/api/user/:id', { id: '@id' }, {
                    'post': { method: 'POST', isArray: false }
                }),
                UsernameCheck: $resource('/auth/userCheck/username/:id', { id: '@id' }, {
                    'post': { method: 'POST', isArray: false }
                }),
                UseremailCheck: $resource('/auth/userCheck/email/:id', { id: '@id' }, {
                    'post': { method: 'POST', isArray: false }
                }),
                Profile: $resource('/auth/profile/me', null, {
                    'post': { method: 'POST', isArray: false }
                }),
                PushConfig: $resource('/api/push/config'),
                PushCapcodes: $resource('/api/push/capcodes', null, {'query': {method: 'GET', isArray: true}}),
                PushSubscription: $resource('/api/push/subscription', null, {
                    'remove': {method: 'DELETE', isArray: false}
                }),
                PushTest: $resource('/api/push/test')
                ,TwoFactor: $resource('/auth/two-factor', null, {'verify': {method: 'POST'}})
                ,TwoFactorEnrol: $resource('/auth/two-factor/enrol', null, {'start': {method: 'POST'}})
                ,TwoFactorConfirm: $resource('/auth/two-factor/confirm', null, {'confirm': {method: 'POST'}})
                ,TwoFactorDisable: $resource('/auth/two-factor/disable', null, {'disable': {method: 'POST'}})
            };
        }])

    .controller('LoginController', ['$scope', '$routeParams', 'Api', '$uibModal', '$filter', '$location', '$timeout', '$window', function ($scope, $routeParams, Api, $uibModal, $filter, $location, $timeout, $window) {
        $scope.loading = false;
        $scope.loginMessage = {};

        $scope.loginSubmit = function () {
            $scope.loading = true;
            Api.Login.post(null, $scope.user).$promise.then(function (response) {
                console.log(response);
                $scope.loading = false;
                if (response.status == 'ok') {
                    $window.location.href = response.redirect
                } else if (response.status == 'two-factor') {
                    $window.location.href = response.redirect
                } else {
                    $scope.loginMessage.text = 'Login Error: ' + response.data.error;
                    $scope.loginMessage.type = 'alert-danger';
                    $scope.loginMessage.show = true;
                    $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                }
            }, function (response) {
                console.log(response);
                $scope.loginMessage.text = 'Login Error: ' + response.data.error;
                $scope.loginMessage.type = 'alert-danger';
                $scope.loginMessage.show = true;
                $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                $scope.loading = false;
            });
        };

    }])

    .controller('TwoFactorController', ['$scope', 'Api', '$window', function($scope, Api, $window) {
        $scope.verify = function() {
            $scope.loading = true; $scope.message = '';
            Api.TwoFactor.verify({}, $scope.twoFactor).$promise.then(function(response) {
                $window.location.href = response.redirect;
            }, function(response) {
                $scope.loading = false; $scope.message = response.data.error || 'Verification failed.';
            });
        };
    }])

    .controller('RegisterController', ['$scope', '$routeParams', 'Api', '$uibModal', '$filter', '$location', '$timeout', '$window', function ($scope, $routeParams, Api, $uibModal, $filter, $location, $timeout, $window) {
        $scope.userLoading = false;
        $scope.existingUsername = false;
        $scope.existingEmail = false;
        $scope.loading = false;
        $scope.alertMessage = {};

        $scope.checkUsername = function () {
            $scope.userLoading = true;
            if ($scope.user.username) {
                Api.UsernameCheck.get({ id: $scope.user.username }, function (results) {
                    console.log(results)
                    if (results.username) {
                        $scope.userLoading = false;
                        $scope.existingUsername = true;
                        return true;
                    } else {
                        $scope.userLoading = false;
                        $scope.existingUsername = false;
                        return false;
                    }
                });
            } else {
                $scope.userLoading = false;
                $scope.existingUsername = false;
                return false;
            }
        };

        $scope.checkEmail = function () {
            $scope.userLoading = true;
            if ($scope.user.email) {
                Api.UseremailCheck.get({ id: $scope.user.email }, function (results) {
                    console.log(results)
                    if (results.email) {
                        $scope.userLoading = false;
                        $scope.existingEmail = true;
                        return true;
                    } else {
                        $scope.userLoading = false;
                        $scope.existingEmail = false;
                        return false;
                    }
                });
            } else {
                $scope.userLoading = false;
                $scope.existingEmail = false;
                return false;
            }
        };

        $scope.registerSubmit = function () {
            console.log('fire')
            if ($scope.existingUsername) {
                $scope.alertMessage.text = 'Error creating user: User with this username already exists.';
                $scope.alertMessage.type = 'alert-danger';
                $scope.alertMessage.show = true;
                $timeout(function () { $scope.alertMessage.show = false; }, 3000);
            } else if ($scope.existingEmail) {
                $scope.alertMessage.text = 'Error creating user: User with this email already exists.';
                $scope.alertMessage.type = 'alert-danger';
                $scope.alertMessage.show = true;
                $timeout(function () { $scope.alertMessage.show = false; }, 3000);
            } else {
                $scope.userLoading = true;
                Api.Register.save(null, $scope.user).$promise.then(function (response) {
                    console.log(response);
                    if (response.status == 'pending') {
                        $scope.alertMessage.text = response.message;
                        $scope.alertMessage.type = 'alert-info';
                        $scope.alertMessage.show = true;
                        $scope.userLoading = false;
                        $timeout(function () { $window.location.href = response.redirect; }, 5000);
                    } else if (response.status == 'ok') {
                        $scope.alertMessage.text = 'User created!';
                        $scope.alertMessage.type = 'alert-success';
                        $scope.alertMessage.show = true;
                        $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                        $scope.userLoading = false;
                        $window.location.href = response.redirect
                    } else {
                        $scope.alertMessage.text = 'Error creating user: ' + response;
                        $scope.alertMessage.type = 'alert-danger';
                        $scope.alertMessage.show = true;
                        $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                        $scope.userLoading = false;
                    }
                }, function (response) {
                    console.log(response);
                    $scope.alertMessage.text = 'Error creating user: ' + response.data.error;
                    $scope.alertMessage.type = 'alert-danger';
                    $scope.alertMessage.show = true;
                    $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                    $scope.userLoading = false;
                });
            }
        };
    }])

    .controller('ResetController', ['$scope', '$routeParams', 'Api', '$uibModal', '$filter', '$location', '$timeout', '$window', function ($scope, $routeParams, Api, $uibModal, $filter, $location, $timeout, $window) {
        $scope.resetMessage = {};
        $scope.resetSubmit = function () {
            $scope.loading = false
            var vars = { 'user': $scope.user, 'password': $scope.password };

            Api.Reset.post(null, vars).$promise.then(function (response) {
                console.log(response);
                $scope.loading = false;
                if (response.status == 'ok') {
                    $window.location.href = response.redirect
                } else {
                    $scope.resetMessage.text = 'Failed to reset password: ' + response.data.error;
                    $scope.resetMessage.type = 'alert-danger';
                    $scope.resetMessage.show = true;
                    $timeout(function () { $scope.resetMessage.show = false; }, 3000);
                }
            }, function (response) {
                console.log(response);
                $scope.resetMessage.text = 'Failed to reset password: ' + response.data.error;
                $scope.resetMessage.type = 'alert-danger';
                $scope.resetMessage.show = true;
                $timeout(function () { $scope.resetMessage.show = false; }, 3000);
                $scope.loading = false;
            });
        };
    }])

    .controller('ProfileController', ['$scope', '$routeParams', 'Api', '$uibModal', '$filter', '$location', '$timeout', '$window', function ($scope, $routeParams, Api, $uibModal, $filter, $location, $timeout, $window) {
        $scope.alertMessage = {};
        $scope.loading = true;
        $scope.push = {supported: 'serviceWorker' in navigator && 'PushManager' in window, enabled: false, subscribed: false, capcode: '', capcodes: []};

        $scope.filteredPushCapcodes = function() {
            var query = String($scope.push.capcodeSearch || '').toLowerCase().trim();
            var selected = String($scope.push.capcode || '');
            var rows = $scope.push.capcodes || [];
            var result = [];
            for (var selectedIndex = 0; selected && selectedIndex < rows.length; selectedIndex += 1) {
                if (String(rows[selectedIndex].address) === selected) { result.push(rows[selectedIndex]); break; }
            }
            for (var i = 0; i < rows.length && result.length < 100; i += 1) {
                var item = rows[i];
                var matches = !query || [item.address, item.alias, item.agency].join(' ').toLowerCase().indexOf(query) !== -1;
                if (matches && String(item.address) !== selected) result.push(item);
            }
            return result;
        };

        function pushMessage(text, type) {
            $scope.alertMessage.text = text;
            $scope.alertMessage.type = type || 'alert-info';
            $scope.alertMessage.show = true;
        }

        function applicationServerKey(value) {
            var padding = '='.repeat((4 - value.length % 4) % 4);
            var raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
            return Uint8Array.from(raw, function(character) { return character.charCodeAt(0); });
        }

        function refreshPushState() {
            Api.PushConfig.get().$promise.then(function(config) {
                $scope.push.enabled = config.enabled;
                $scope.push.publicKey = config.publicKey;
                $scope.push.capcode = config.capcode || '';
                if (!$scope.push.supported || !config.enabled) return;
                Api.PushCapcodes.query().$promise.then(function(rows) { $scope.push.capcodes = rows; });
                navigator.serviceWorker.ready.then(function(registration) {
                    return registration.pushManager.getSubscription();
                }).then(function(subscription) {
                    $scope.$evalAsync(function() { $scope.push.subscribed = Boolean(subscription); });
                });
            });
        }

        $scope.enablePush = function() {
            if (!$scope.push.capcode) return pushMessage('Select one capcode first.', 'alert-warning');
            Notification.requestPermission().then(function(permission) {
                if (permission !== 'granted') throw new Error('Notification permission was not granted.');
                return navigator.serviceWorker.ready;
            }).then(function(registration) {
                return registration.pushManager.getSubscription().then(function(existing) {
                    return existing || registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: applicationServerKey($scope.push.publicKey)});
                });
            }).then(function(subscription) {
                return Api.PushSubscription.save({subscription: subscription.toJSON(), capcode: $scope.push.capcode}).$promise;
            }).then(function() {
                $scope.push.subscribed = true;
                pushMessage('Push notifications saved for capcode ' + $scope.push.capcode + '.', 'alert-success');
            }).catch(function(error) {
                $scope.$evalAsync(function() { pushMessage(error.data && error.data.error || error.message || 'Unable to enable push notifications.', 'alert-danger'); });
            });
        };

        $scope.disablePush = function() {
            navigator.serviceWorker.ready.then(function(registration) { return registration.pushManager.getSubscription(); }).then(function(subscription) {
                if (!subscription) return Api.PushSubscription.remove({}).$promise;
                var endpoint = subscription.endpoint;
                return Api.PushSubscription.remove({endpoint: endpoint}).$promise.then(function() { return subscription.unsubscribe(); });
            }).then(function() {
                $scope.$evalAsync(function() { $scope.push.subscribed = false; pushMessage('Push notifications disabled on this device.', 'alert-success'); });
            });
        };

        $scope.testPush = function() {
            Api.PushTest.save().$promise.then(function() { pushMessage('Test notification sent.', 'alert-success'); }, function(response) { pushMessage(response.data.error || 'Test failed.', 'alert-danger'); });
        };
        $scope.startTwoFactor = function() {
            Api.TwoFactorEnrol.start({}).$promise.then(function(result) {
                $scope.twoFactor = {setup: true, secret: result.secret, uri: result.uri, qrCode: result.qrCode};
            }, function(response) { pushMessage(response.data.error || 'Unable to start 2FA enrolment.', 'alert-danger'); });
        };
        $scope.confirmTwoFactor = function() {
            Api.TwoFactorConfirm.confirm({}, {code: $scope.twoFactor.code}).$promise.then(function(result) {
                $scope.user.totp_enabled = true; $scope.twoFactor.recoveryCodes = result.recoveryCodes;
                pushMessage('Two-factor authentication enabled. Save the recovery codes now.', 'alert-success');
            }, function(response) { pushMessage(response.data.error || 'Unable to confirm code.', 'alert-danger'); });
        };
        $scope.disableTwoFactor = function() {
            Api.TwoFactorDisable.disable({}, {password: $scope.twoFactorDisablePassword}).$promise.then(function() {
                $scope.user.totp_enabled = false; $scope.twoFactor = {}; $scope.twoFactorDisablePassword = '';
                pushMessage('Two-factor authentication disabled.', 'alert-success');
            }, function(response) { pushMessage(response.data.error || 'Unable to disable 2FA.', 'alert-danger'); });
        };
        refreshPushState();
        $scope.userSubmit = function () {
            $scope.loading = true;
            Api.Profile.save(null, $scope.user).$promise.then(function (response) {
                console.log(response);
                if (response.status == 'ok') {
                    $scope.alertMessage.text = 'User saved!';
                    $scope.alertMessage.type = 'alert-success';
                    $scope.alertMessage.show = true;
                    $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                    $scope.loading = false;
                } else {
                    $scope.alertMessage.text = 'Error saving user: ' + response;
                    $scope.alertMessage.type = 'alert-danger';
                    $scope.alertMessage.show = true;
                    $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                    $scope.loading = false;
                }
            }, function (response) {
                console.log(response);
                $scope.alertMessage.text = 'Error saving user: ' + response.data.error;
                $scope.alertMessage.type = 'alert-danger';
                $scope.alertMessage.show = true;
                $timeout(function () { $scope.alertMessage.show = false; }, 3000);
                $scope.loading = false;
            });
        };
        Api.Profile.get( function (results) {
            $scope.user = results;
            $scope.userLoading = false;
            $scope.existingUsername = false;
            $scope.existingEmail = false;
            $scope.loading = false;

            if (results.username) {
                $scope.user.originalUsername = results.username;
                $scope.user.originalEmail = results.email;
                $scope.user.lastlogondate = new Date(results.lastlogondate).toLocaleString('en-AU')
                console.log(results)
            }
        });
    }])

    .config(['$routeProvider', '$locationProvider', '$httpProvider', function ($routeProvider, $locationProvider, $httpProvider) {
        $routeProvider
            .when('/login', {
                templateUrl: '/templates/auth/login.html',
                controller: 'LoginController'
            })
            .when('/profile', {
                templateUrl: '/templates/auth/profile.html',
                controller: 'ProfileController'
            })
            .when('/two-factor', {
                templateUrl: '/templates/auth/two-factor.html',
                controller: 'TwoFactorController'
            })
            .when('/register', {
                templateUrl: '/templates/auth/register.html',
                controller: 'RegisterController'
            })
            .when('/reset', {
                templateUrl: '/templates/auth/reset.html',
                controller: 'ResetController'
            });
        $httpProvider.defaults.headers.delete = { "Content-Type": "application/json;charset=utf-8" };
        $httpProvider.interceptors.push(function ($q, $location) {
            return {
                response: function (response) {
                    return response;
                },
                responseError: function (response) {
                    if (response.status === 401)
                        $location.absUrl('/login');
                    return $q.reject(response);
                }
            };
        });
        $locationProvider.html5Mode({ enabled: true, requireBase: false, rewriteLinks: true });
    }]);
