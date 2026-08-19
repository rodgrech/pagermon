exports.up = function(db) {
  return db.schema.hasColumn('users', 'pushcapcode').then(function(exists) {
    if (!exists) return db.schema.table('users', function(table) { table.string('pushcapcode', 32); });
  }).then(function() {
    return db.schema.hasTable('push_subscriptions');
  }).then(function(exists) {
    if (exists) return;
    return db.schema.createTable('push_subscriptions', function(table) {
      table.increments('id').primary();
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.text('endpoint').notNullable().unique();
      table.text('p256dh').notNullable();
      table.text('auth').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
      table.index('user_id');
    });
  });
};

exports.down = function(db) {
  return db.schema.dropTableIfExists('push_subscriptions').then(function() {
    return db.schema.hasColumn('users', 'pushcapcode');
  }).then(function(exists) {
    if (exists) return db.schema.table('users', function(table) { table.dropColumn('pushcapcode'); });
  });
};
