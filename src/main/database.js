const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, '../../egg_inventory.db');
const db = new sqlite3.Database(dbPath);

function ensureColumnExists(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err || !rows) return;
    const hasColumn = rows.some(row => row.name === column);
    if (!hasColumn) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  });
}

function initDatabase() {
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON;');

    db.run(`
      CREATE TABLE IF NOT EXISTS master_company (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_code TEXT UNIQUE NOT NULL,
        company_name TEXT NOT NULL,
        status TEXT DEFAULT 'A'
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS master_warehouse (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        warehouse_code TEXT UNIQUE NOT NULL,
        warehouse_name TEXT NOT NULL,
        status TEXT DEFAULT 'A',
        FOREIGN KEY(company_id) REFERENCES master_company(id)
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS user_group (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_name TEXT UNIQUE NOT NULL,
        description TEXT,
        permissions TEXT
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS master_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_code TEXT UNIQUE NOT NULL,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL,
        base_unit TEXT DEFAULT 'Butir',
        secondary_unit TEXT DEFAULT 'Kg',
        status TEXT DEFAULT 'A'
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS master_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        group_id INTEGER,
        role TEXT NOT NULL,
        status TEXT DEFAULT 'A',
        FOREIGN KEY(group_id) REFERENCES user_group(id)
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS user_warehouse_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES master_user(id) ON DELETE CASCADE,
        FOREIGN KEY(warehouse_id) REFERENCES master_warehouse(id) ON DELETE CASCADE
      );
    `);

    db.run(`
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

    db.run(`
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

    db.run(`
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

    ensureColumnExists('transaction_header', 'remark', 'remark TEXT');
    ensureColumnExists('transaction_header', 'updated_by', 'updated_by TEXT');
    ensureColumnExists('transaction_header', 'updated_date', 'updated_date DATETIME');
    ensureColumnExists('period_lock', 'warehouse_id', 'warehouse_id INTEGER');
    ensureColumnExists('period_lock', 'action_by', 'action_by TEXT');

    seedDefaultData();
  });
}

function seedDefaultData() {
  db.get('SELECT count(*) as count FROM master_company', (err, row) => {
    if (err || !row) return;
    if (row.count === 0) {
      const hashedAdmin = bcrypt.hashSync('admin123', 10);

      db.run("INSERT INTO master_company (company_code, company_name) VALUES ('CMP-001', 'PT Farm Eggs Nusantara')", function() {
        const companyId = this.lastID;
        db.run("INSERT INTO master_warehouse (company_id, warehouse_code, warehouse_name) VALUES (?, 'WH-SERANG', 'Serang Farm Layer')", [companyId]);
        db.run("INSERT INTO master_warehouse (company_id, warehouse_code, warehouse_name) VALUES (?, 'WH-BOGOR', 'Bogor Farm Layer')", [companyId]);

        db.run("INSERT INTO user_group (group_name, description, permissions) VALUES ('Superadmin', 'Akses penuh seluruh sistem', 'ALL')", function() {
          const groupId = this.lastID;
          db.run("INSERT INTO master_user (username, name, password, group_id, role) VALUES ('admin', 'Administrator System', ?, ?, 'Superadmin')", [hashedAdmin, groupId], function(err) {
            if (!err) {
              const adminUserId = this.lastID;
              db.run('INSERT INTO user_warehouse_access (user_id, warehouse_id) VALUES (?, ?)', [adminUserId, 1]);
              db.run('INSERT INTO user_warehouse_access (user_id, warehouse_id) VALUES (?, ?)', [adminUserId, 2]);
            }
          });
        });

        db.run("INSERT INTO user_group (group_name, description, permissions) VALUES ('Operator Farm', 'Akses Input Transaksi & View Stok', 'TRANSITION,VIEW')");

        db.run("INSERT INTO master_item (item_code, item_name, category) VALUES ('ITM-001', 'Jumbo Eggs', 'Utuh')");
        db.run("INSERT INTO master_item (item_code, item_name, category) VALUES ('ITM-002', 'Cull Eggs', 'Utuh')");
        db.run("INSERT INTO master_item (item_code, item_name, category) VALUES ('ITM-003', 'Crack Eggs', 'Retak')");
      });
    }
  });
}

module.exports = { db, initDatabase };