const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.EGG_DB_PATH || path.join(__dirname, '../../egg_inventory.db');
const db = new sqlite3.Database(dbPath);

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getRow(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function ensureColumnExists(table, column, definition) {
  const rows = await getAll(`PRAGMA table_info(${table})`);
  const hasColumn = rows.some((row) => row.name === column);
  if (!hasColumn) {
    await runSql(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function initDatabase() {
  try {
    await runSql('PRAGMA foreign_keys = ON;');

    await runSql(`
      CREATE TABLE IF NOT EXISTS master_company (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_code TEXT UNIQUE NOT NULL,
        company_name TEXT NOT NULL,
        initial TEXT,
        status TEXT DEFAULT 'A'
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS master_warehouse (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        warehouse_code TEXT,
        warehouse_name TEXT NOT NULL,
        status TEXT DEFAULT 'A',
        FOREIGN KEY(company_id) REFERENCES master_company(id)
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS user_group (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_name TEXT UNIQUE NOT NULL,
        description TEXT,
        permissions TEXT
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS master_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_code TEXT UNIQUE NOT NULL,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL,
        base_unit TEXT DEFAULT 'Butir',
        secondary_unit TEXT DEFAULT 'Kg',
        status TEXT DEFAULT 'A',
        created_by TEXT,
        created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT,
        updated_date DATETIME
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS master_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT DEFAULT 'A'
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS user_warehouse_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES master_user(id) ON DELETE CASCADE,
        FOREIGN KEY(warehouse_id) REFERENCES master_warehouse(id) ON DELETE CASCADE
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS transaction_header (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trans_number TEXT UNIQUE NOT NULL,
        trans_type TEXT NOT NULL,
        trans_date DATE NOT NULL,
        warehouse_id INTEGER NOT NULL,
        remark TEXT,
        status TEXT DEFAULT 'Active',
        period_month INTEGER NOT NULL,
        period_year INTEGER NOT NULL,
        created_by TEXT,
        created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT,
        updated_date DATETIME,
        FOREIGN KEY(warehouse_id) REFERENCES master_warehouse(id)
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS transaction_detail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        header_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        qty_pcs INTEGER DEFAULT 0,
        qty_weight REAL DEFAULT 0,
        notes TEXT,
        FOREIGN KEY(header_id) REFERENCES transaction_header(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES master_item(id)
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS period_lock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_month INTEGER NOT NULL,
        period_year INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        action_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        action_by TEXT,
        UNIQUE(period_month, period_year, warehouse_id)
      );
    `);

    await ensureColumnExists('master_company', 'initial', 'initial TEXT');
    await ensureColumnExists('master_warehouse', 'warehouse_code', 'warehouse_code TEXT');
    await ensureColumnExists('transaction_header', 'remark', 'remark TEXT');
    await ensureColumnExists('transaction_header', 'updated_by', 'updated_by TEXT');
    await ensureColumnExists('transaction_header', 'updated_date', 'updated_date DATETIME');
    await ensureColumnExists('period_lock', 'warehouse_id', 'warehouse_id INTEGER');
    await ensureColumnExists('period_lock', 'action_by', 'action_by TEXT');

    await seedDefaultData();
    return db;
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

async function seedDefaultData() {
  const companyRow = await getRow('SELECT id FROM master_company ORDER BY id LIMIT 1');
  let companyId = companyRow ? companyRow.id : null;

  if (!companyId) {
    const companyResult = await runSql("INSERT INTO master_company (company_code, company_name, initial) VALUES ('CMP-001', 'PT Farm Eggs Nusantara', 'FEN')");
    companyId = companyResult.lastID;
  }

  const warehouseRows = await getAll('SELECT warehouse_code FROM master_warehouse WHERE warehouse_code IN (?, ?)', ['WH-SERANG', 'WH-BOGOR']);
  const warehouseCodes = new Set(warehouseRows.map((row) => row.warehouse_code));
  if (!warehouseCodes.has('WH-SERANG')) {
    await runSql("INSERT INTO master_warehouse (company_id, warehouse_code, warehouse_name) VALUES (?, 'WH-SERANG', 'Serang Farm Layer')", [companyId]);
  }
  if (!warehouseCodes.has('WH-BOGOR')) {
    await runSql("INSERT INTO master_warehouse (company_id, warehouse_code, warehouse_name) VALUES (?, 'WH-BOGOR', 'Bogor Farm Layer')", [companyId]);
  }

  const superadminGroup = await getRow('SELECT id FROM user_group WHERE group_name = ?', ['Superadmin']);
  if (!superadminGroup) {
    await runSql("INSERT INTO user_group (group_name, description, permissions) VALUES ('Superadmin', 'Akses penuh seluruh sistem', 'ALL')");
  }

  const operatorGroup = await getRow('SELECT id FROM user_group WHERE group_name = ?', ['Operator Farm']);
  if (!operatorGroup) {
    await runSql("INSERT INTO user_group (group_name, description, permissions) VALUES ('Operator Farm', 'Akses input transaksi & view stok', 'TRANSITION,VIEW')");
  }

  const adminUser = await getRow('SELECT id FROM master_user WHERE username = ?', ['admin']);
  if (!adminUser) {
    const hashedAdmin = bcrypt.hashSync('admin123', 10);
    await runSql("INSERT INTO master_user (username, name, password, role, status) VALUES ('admin', 'Administrator System', ?, 'Superadmin', 'A')", [hashedAdmin]);
  }

  const adminUserRow = await getRow('SELECT id FROM master_user WHERE username = ?', ['admin']);
  if (adminUserRow) {
    const accessRows = await getAll('SELECT warehouse_id FROM user_warehouse_access WHERE user_id = ?', [adminUserRow.id]);
    const accessSet = new Set(accessRows.map((row) => row.warehouse_id));
    const warehouseIds = await getAll('SELECT id, warehouse_code FROM master_warehouse WHERE warehouse_code IN (?, ?)', ['WH-SERANG', 'WH-BOGOR']);
    for (const warehouse of warehouseIds) {
      if (!accessSet.has(warehouse.id)) {
        await runSql('INSERT INTO user_warehouse_access (user_id, warehouse_id) VALUES (?, ?)', [adminUserRow.id, warehouse.id]);
      }
    }
  }

  const existingItems = await getAll('SELECT item_code FROM master_item WHERE item_code IN (?, ?, ?)', ['EG001', 'EG002', 'EG003']);
  const itemCodes = new Set(existingItems.map((row) => row.item_code));
  if (!itemCodes.has('EG001')) {
    await runSql("INSERT INTO master_item (item_code, item_name, category, base_unit, secondary_unit, status, created_by) VALUES ('EG001', 'Jumbo Eggs', 'Egg', 'Butir', 'KG', 'A', 'System')");
  }
  if (!itemCodes.has('EG002')) {
    await runSql("INSERT INTO master_item (item_code, item_name, category, base_unit, secondary_unit, status, created_by) VALUES ('EG002', 'Cull Eggs', 'Egg', 'Butir', 'KG', 'A', 'System')");
  }
  if (!itemCodes.has('EG003')) {
    await runSql("INSERT INTO master_item (item_code, item_name, category, base_unit, secondary_unit, status, created_by) VALUES ('EG003', 'Crack Eggs', 'Egg', 'Butir', 'KG', 'A', 'System')");
  }
}

module.exports = { db, initDatabase };