exports.up = async function (knex) {
  if (knex.client.config.client === 'sqlite3') {
    await knex.schema.table('users', function (table) { table.string('role_next', 32).notNullable().defaultTo('user'); });
    await knex('users').update({role_next: knex.ref('role')});
    await knex.schema.table('users', function (table) { table.dropColumn('role'); });
    await knex.schema.table('users', function (table) { table.renameColumn('role_next', 'role'); });
    return;
  }
  return knex.schema.alterTable('users', function (table) {
    table.enu('role', ['admin', 'superuser', 'user']).notNullable().defaultTo('user').alter();
  });
};
exports.down = function () { return Promise.resolve(); };
