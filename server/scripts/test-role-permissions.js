const assert = require('assert');
const nconf = require('nconf');
const permissions = require('../lib/permissions');
const authHelper = require('../middleware/authhelper');
const admin = {role: 'admin', status: 'active'};
const superuser = {role: 'superuser', status: 'active'};
const user = {role: 'user', status: 'active'};
nconf.overrides({auth: {rolePermissions: {superuser: {}, user: {}}}});
permissions.definitions.forEach(function (item) { assert.strictEqual(permissions.has(admin, item.key), true); });
assert.strictEqual(permissions.has(superuser, 'moderateMessages'), true);
assert.strictEqual(permissions.has(superuser, 'manageSettings'), false);
assert.strictEqual(permissions.has(user, 'moderateMessages'), false);
assert.strictEqual(permissions.has({role: 'superuser', status: 'disabled'}, 'moderateMessages'), false);
assert.strictEqual(permissions.has(null, 'viewHiddenMessages'), false);
function check(subject, path, method, allowed) {
  let advanced = false;
  let status;
  authHelper.isAdmin({user: subject, path, method, isAuthenticated: function () { return true; }}, {status: function (code) { status = code; return this; }, json: function () {}}, function () { advanced = true; });
  assert.strictEqual(advanced, allowed, path + ' authorization');
  if (!allowed) assert.strictEqual(status, 403);
}
check(superuser, '/messages/1/visibility', 'POST', true);
check(user, '/messages/1/visibility', 'POST', false);
check(superuser, '/user/2/approve', 'POST', true);
check(superuser, '/user/2', 'POST', false);
check(superuser, '/user/2', 'GET', true);
check(superuser, '/settingsData', 'GET', false);
async function migrationTest() {
  const knex = require('knex')({client: 'sqlite3', connection: {filename: ':memory:'}, useNullAsDefault: true});
  try {
    await knex.schema.createTable('users', function (table) { table.increments('id'); table.enu('role', ['admin', 'user']).notNullable().defaultTo('user'); });
    await knex('users').insert({role: 'admin'});
    await require('../knex/migrations/20261014020000_add_superuser_role').up(knex);
    await knex('users').insert({role: 'superuser'});
    assert.strictEqual((await knex('users').where('id', 1).first()).role, 'admin');
    assert.strictEqual((await knex('users').where('id', 2).first()).role, 'superuser');
    console.log('Role permission checks and SQLite migration passed');
  } finally { await knex.destroy(); }
}
migrationTest().catch(function (error) { console.error(error); process.exitCode = 1; });
