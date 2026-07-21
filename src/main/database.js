const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

// Path penyimpanan database SQLite
const dbPath = path.join(__dirname, '../../egg_inventory.db');

// Inisialisasi koneksi database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Gagal membuka database SQLite:', err.message);
  } else {
    console.log('Koneksi database SQLite berhasil.');
  }
});

function initDatabase() {
  db.serialize(() => {
    // Enable Foreign Key Support
    db.run('PRAGMA foreign_keys = ON;');

    // 1. Master Company
    db.run(`
      CREATE TABLE IF NOT EXISTS master_company (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_code TEXT UNIQUE NOT NULL,
        company_name TEXT NOT NULL,
        initial TEXT,
        status TEXT DEFAULT 'A'
      );
    `);

    // 2. Master Warehouse
    db.run(`
      CREATE TABLE IF NOT EXISTS master_warehouse (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        warehouse_name TEXT NOT NULL,
        status TEXT DEFAULT 'A',
        FOREIGN KEY(company_id) REFERENCES master_company(id)
      );
    `);

    // 3. Master Item
    db.run(`
      CREATE TABLE IF NOT EXISTS master_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL,
        base_unit TEXT DEFAULT 'Butir',
        secondary_unit TEXT,
        status TEXT DEFAULT 'A',
        created_by TEXT,
        created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT,
        updated_date DATETIME
      );
    `);

    // 4. Master User
    db.run(`
      CREATE TABLE IF NOT EXISTS master_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nik TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        company_id INTEGER,
        warehouse_access TEXT,
        role TEXT NOT NULL,
        status TEXT DEFAULT 'A'
      );
    `);

    // 5. Transaction Header
    db.run(`
      CREATE TABLE IF NOT EXISTS transaction_header (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trans_number TEXT UNIQUE NOT NULL,
        trans_type TEXT NOT NULL,
        trans_date DATE NOT NULL,
        warehouse_id INTEGER NOT NULL,
        status TEXT DEFAULT 'A',
        period_month INTEGER NOT NULL,
        period_year INTEGER NOT NULL,
        created_by TEXT,
        created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT,
        updated_date DATETIME,
        FOREIGN KEY(warehouse_id) REFERENCES master_warehouse(id)
      );
    `);

    // 6. Transaction Detail
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

    seedDefaultData();
  });
}

function seedDefaultData() {
  db.get('SELECT count(*) as count FROM master_company', (err, row) => {
    if (err) return console.error(err.message);

    if (row.count === 0) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);

      db.run('INSERT INTO master_company (company_code, company_name, initial) VALUES (?, ?, ?)', 
        ['CMP-001', 'PT Farm Eggs Nusantara', 'FEN'], function(err) {
          if (err) return;
          const companyId = this.lastID;

          db.run('INSERT INTO master_warehouse (company_id, warehouse_name) VALUES (?, ?)', [companyId, 'Farm Utama - Kandang A']);
          db.run('INSERT INTO master_warehouse (company_id, warehouse_name) VALUES (?, ?)', [companyId, 'Farm Utama - Kandang B']);

          db.run('INSERT INTO master_user (nik, name, password, company_id, warehouse_access, role) VALUES (?, ?, ?, ?, ?, ?)',
            ['ADMIN01', 'Administrator', hashedPassword, companyId, '[1, 2]', 'Administrator']);
      });

      db.run('INSERT INTO master_item (item_name, category, secondary_unit, created_by) VALUES (?, ?, ?, ?)', ['Telur Utuh Grade A', 'Utuh', 'Box (10 Kg)', 'System']);
      db.run('INSERT INTO master_item (item_name, category, secondary_unit, created_by) VALUES (?, ?, ?, ?)', ['Telur Retak', 'Afkir', 'Ikat', 'System']);
    }
  });
}

module.exports = { db, initDatabase };