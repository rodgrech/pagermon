exports.up = function(db) {
  return db.schema.hasColumn('users', 'welcome_acknowledged').then(function(exists) {
    if (exists) return null;
    return db.schema.table('users', function(table) {
      table.boolean('welcome_acknowledged').notNullable().defaultTo(false);
    });
  });
};

exports.down = function(db) {
  return db.schema.hasColumn('users', 'welcome_acknowledged').then(function(exists) {
    if (!exists) return null;
    return db.schema.table('users', function(table) {
      table.dropColumn('welcome_acknowledged');
    });
  });
};
