// seedAdmin.js - create/reset the first administrator
// Usage: node seedAdmin.js <username> <password>
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

(async () => {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: node seedAdmin.js <username> <password>');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO app_users (username, password_hash, role) VALUES ($1,$2,'admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = $2, role = 'admin'`,
    [username, hash]);
  console.log(`Admin user '${username}' ready.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
