const nconf = require('nconf');
const definitions = [
  {key: 'viewPagerFeed', label: 'View pager feed tab'},
  {key: 'viewLiveMap', label: 'View live map tab'},
  {key: 'viewDiscovery', label: 'View discovery tab'},
  {key: 'viewRadio', label: 'View radio tab'},
  {key: 'viewWaterNsw', label: 'View WaterNSW tab'},
  {key: 'viewHiddenMessages', label: 'View hidden pager messages'},
  {key: 'moderateMessages', label: 'Hide and unhide pager messages'},
  {key: 'approveUsers', label: 'Approve and deny registrations'},
  {key: 'manageUsers', label: 'Manage user accounts and roles'},
  {key: 'manageAliases', label: 'Manage capcodes and aliases'},
  {key: 'manageSettings', label: 'Change settings, permissions and restart the server'}
];
const defaults = {
  superuser: {viewPagerFeed: true, viewLiveMap: true, viewDiscovery: true, viewRadio: true, viewWaterNsw: true, viewHiddenMessages: true, moderateMessages: true, approveUsers: true},
  user: {viewPagerFeed: true, viewLiveMap: true, viewRadio: true, viewWaterNsw: true}
};
function has(user, permission) {
  if (!user || (user.status && user.status !== 'active')) return false;
  if (user.role === 'admin') return true;
  if (!Object.prototype.hasOwnProperty.call(defaults, user.role)) return false;
  const configured = nconf.get('auth:rolePermissions:' + user.role) || {};
  return Object.prototype.hasOwnProperty.call(configured, permission) ? configured[permission] === true : defaults[user.role][permission] === true;
}
function forUser(user) {
  return definitions.reduce(function (result, item) {
    result[item.key] = !user && ['viewPagerFeed', 'viewLiveMap', 'viewWaterNsw'].includes(item.key) ? true : has(user, item.key);
    return result;
  }, {});
}
function adminAccess(user) {
  return ['manageUsers', 'approveUsers', 'manageAliases', 'manageSettings'].some(function (key) { return has(user, key); });
}
module.exports = {definitions, defaults, has, forUser, adminAccess};
