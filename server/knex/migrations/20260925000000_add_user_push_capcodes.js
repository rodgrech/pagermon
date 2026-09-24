exports.up = function(db) {
  return db.schema.hasTable('user_push_capcodes').then(function(exists) {
    if (exists) return null;
    return db.schema.createTable('user_push_capcodes', function(table) {
      table.increments('id').primary();
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('capcode', 32).notNullable();
      table.unique(['user_id', 'capcode']);
      table.index('capcode');
    }).then(function() {
      return db('users').select('id', 'pushcapcode').whereNotNull('pushcapcode');
    }).then(function(users) {
      var rows = (users || []).filter(function(user) {
        return /^\d{1,32}$/.test(String(user.pushcapcode || ''));
      }).map(function(user) {
        return {user_id: user.id, capcode: String(user.pushcapcode)};
      });
      return rows.length ? db('user_push_capcodes').insert(rows) : null;
    });
  });
};

exports.down = function(db) {
  return db.schema.dropTableIfExists('user_push_capcodes');
};
