exports.up = function (knex) {
  return knex.schema.table('messages', function (table) {
    table.boolean('hidden').notNullable().defaultTo(false);
  });
};
exports.down = function (knex) {
  return knex.schema.table('messages', function (table) { table.dropColumn('hidden'); });
};
