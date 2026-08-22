exports.up = function(db) {
  return db.schema.hasColumn('users', 'totp_enabled').then(function(exists) {
    if (exists) return null;
    return db.schema.table('users', function(table) {
      table.boolean('totp_enabled').notNullable().defaultTo(false);
      table.text('totp_secret');
      table.text('totp_recovery_codes');
      table.datetime('totp_enrolled_at');
    });
  }).then(function() {
    return db.schema.hasTable('two_factor_devices').then(function(exists) {
      if (exists) return null;
      return db.schema.createTable('two_factor_devices', function(table) {
        table.increments('id').primary();
        table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('token_hash', 64).notNullable().unique();
        table.datetime('created_at').notNullable();
        table.datetime('expires_at').notNullable();
      });
    });
  });
};

exports.down = function(db) {
  return db.schema.dropTableIfExists('two_factor_devices').then(function() {
    return db.schema.table('users', function(table) {
      table.dropColumn('totp_enabled'); table.dropColumn('totp_secret');
      table.dropColumn('totp_recovery_codes'); table.dropColumn('totp_enrolled_at');
    });
  });
};
