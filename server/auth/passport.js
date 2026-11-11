const passport = require("passport");
var db = require("../knex/knex.js");

module.exports = () => {
  passport.serializeUser((user, done) => {
    done(null, {id: user.id, password: user.password});
  });

  passport.deserializeUser((sessionUser, done) => {
    db("users")
      .where({ id: typeof sessionUser === 'object' ? sessionUser.id : sessionUser })
      .first()
      .then((user) => {
        // Password resets revoke old sessions, including sessions created before
        // this release when Passport stored only the numeric user ID.
        const validSession = typeof sessionUser === 'object'
          ? sessionUser.password === user?.password
          : !user?.password_reset_at;
        if (user && user.status === 'active' && validSession) {
          done(null, user);
        } else {
          //this invalidates existing sessions if no user returned.
          done(null, false);
        }
      })
      .catch((err) => {
        done(err, null);
      });
  });
};
