exports.up = function(db) {
  return db.schema.hasTable('password_reset_tokens').then(function(exists) {
    if (exists) return null;
    return db.schema.createTable('password_reset_tokens', function(table) {
      table.increments('id').primary();
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('token_hash', 64).notNullable().unique();
      table.datetime('expires_at').notNullable();
      table.datetime('used_at');
    });
  }).then(function() {
    return db.schema.hasColumn('users', 'password_reset_at').then(function(exists) {
      if (exists) return null;
      return db.schema.table('users', function(table) { table.datetime('password_reset_at'); });
    });
  });
};

exports.down = function(db) {
  return db.schema.dropTableIfExists('password_reset_tokens').then(function() {
    return db.schema.hasColumn('users', 'password_reset_at').then(function(exists) {
      if (exists) return db.schema.table('users', function(table) { table.dropColumn('password_reset_at'); });
    });
  });
};
