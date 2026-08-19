exports.up = function(db) {
  return db.schema.hasColumn('users', 'approvalpending').then(function(exists) {
    if (!exists) {
      return db.schema.table('users', function(table) {
        table.boolean('approvalpending').notNullable().defaultTo(false);
      });
    }
  });
};

exports.down = function(db) {
  return db.schema.hasColumn('users', 'approvalpending').then(function(exists) {
    if (exists) {
      return db.schema.table('users', function(table) {
        table.dropColumn('approvalpending');
      });
    }
  });
};
