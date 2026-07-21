const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadDatabaseModule(tempDbPath) {
  process.env.EGG_DB_PATH = tempDbPath;
  delete require.cache[require.resolve('../src/main/database')];
  return require('../src/main/database');
}

test('initDatabase resolves after the database schema and seed data are ready', async () => {
  const tempDbPath = path.join(os.tmpdir(), `egg-inventory-${Date.now()}.db`);
  const { initDatabase, db } = loadDatabaseModule(tempDbPath);
  const initialization = initDatabase();

  assert.ok(initialization instanceof Promise, 'initDatabase should return a Promise');
  await initialization;

  const row = await new Promise((resolve, reject) => {
    db.get('SELECT username FROM master_user WHERE username = ?', ['admin'], (err, userRow) => {
      if (err) return reject(err);
      resolve(userRow);
    });
  });

  assert.ok(row, 'The seeded admin user should exist after initialization');
  assert.equal(row.username, 'admin');

  db.close();
  fs.unlinkSync(tempDbPath);
  delete process.env.EGG_DB_PATH;
});

test('initDatabase completes seed data when the company already exists', async () => {
  const tempDbPath = path.join(os.tmpdir(), `egg-inventory-${Date.now() + 1}.db`);
  const { initDatabase, db } = loadDatabaseModule(tempDbPath);

  await new Promise((resolve, reject) => {
    db.run('CREATE TABLE IF NOT EXISTS master_company (id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT UNIQUE NOT NULL, company_name TEXT NOT NULL, initial TEXT, status TEXT DEFAULT "A")', (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  await new Promise((resolve, reject) => {
    db.run("INSERT INTO master_company (company_code, company_name, initial) VALUES ('CMP-001', 'Existing Company', 'EX')", (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  await initDatabase();

  const adminUser = await new Promise((resolve, reject) => {
    db.get('SELECT username, role FROM master_user WHERE username = ?', ['admin'], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

  const warehouseRows = await new Promise((resolve, reject) => {
    db.all('SELECT warehouse_code FROM master_warehouse ORDER BY id', (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

  assert.ok(adminUser, 'The admin user should be created when the company exists but the seeds do not');
  assert.equal(adminUser.role, 'Superadmin');
  assert.ok(warehouseRows.some((row) => row.warehouse_code === 'WH-SERANG'));
  assert.ok(warehouseRows.some((row) => row.warehouse_code === 'WH-BOGOR'));

  db.close();
  fs.unlinkSync(tempDbPath);
  delete process.env.EGG_DB_PATH;
});
