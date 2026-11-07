exports.up = async function (knex) {
  if (knex.client.config.client !== 'sqlite3') {
    await knex.schema.alterTable('users', function (table) {
      table.enu('role', ['system_admin', 'admin', 'superuser', 'user']).notNullable().defaultTo('user').alter();
    });
  }

  const existing = await knex('users').where({role: 'system_admin'}).first('id');
  if (existing) return;
  const firstAdmin = await knex('users').where({role: 'admin', status: 'active'}).orderBy('id').first('id');
  if (firstAdmin) await knex('users').where({id: firstAdmin.id}).update({role: 'system_admin'});
};

exports.down = async function (knex) {
  await knex('users').where({role: 'system_admin'}).update({role: 'admin'});
  if (knex.client.config.client !== 'sqlite3') {
    await knex.schema.alterTable('users', function (table) {
      table.enu('role', ['admin', 'superuser', 'user']).notNullable().defaultTo('user').alter();
    });
  }
};
