exports.up = function (knex) {
  return knex.schema.hasColumn('users', 'approvaldenialreason').then(function (exists) {
    if (exists) return null;
    return knex.schema.table('users', function (table) {
      table.text('approvaldenialreason').nullable();
    });
  });
};

exports.down = function (knex) {
  return knex.schema.hasColumn('users', 'approvaldenialreason').then(function (exists) {
    if (!exists) return null;
    return knex.schema.table('users', function (table) {
      table.dropColumn('approvaldenialreason');
    });
  });
};
