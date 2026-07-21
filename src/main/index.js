const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, initDatabase } = require('./database');

const expressApp = express();
const PORT = 3001;

expressApp.use(express.json());
expressApp.use(express.static(path.join(__dirname, '../frontend/views')));

// Inisialisasi Database SQLite
initDatabase();

require('./main')(expressApp, db);

function getWarehouseAccessQuery(userId, role, callback) {
  if (role === 'Superadmin') {
    return callback(null, '');
  }

  db.all(
    `SELECT warehouse_id FROM user_warehouse_access WHERE user_id = ?`,
    [userId],
    (err, rows) => {
      if (err) return callback(err);
      const ids = rows.map(r => r.warehouse_id);
      if (ids.length === 0) {
        return callback(null, 'AND 0');
      }
      const placeholders = ids.map(() => '?').join(',');
      callback(null, `AND h.warehouse_id IN (${placeholders})`, ids);
    }
  );
}

// ==========================================
// API 1: AUTHENTICATION (LOGIN)
// ==========================================
expressApp.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password wajib diisi!' });
  }

  // Fallback / Hardcoded Superadmin
  if (username === 'admin' && password === 'admin123') {
    return res.json({
      success: true,
      user: { id: 0, username: 'admin', name: 'Administrator System', role: 'Superadmin' }
    });
  }

  // Login dari database master_user
  db.get('SELECT * FROM master_user WHERE username = ?', [username], (err, user) => {
    if (err) {
      console.error("Login DB Error:", err.message);
      return res.status(500).json({ success: false, message: `Database Error: ${err.message}` });
    }
    if (!user) {
      return res.status(401).json({ success: false, message: 'Username tidak ditemukan!' });
    }

    const isValid = bcrypt.compareSync(password, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Password salah!' });
    }

    res.json({
      success: true,
      user: { id: user.id, username: user.username, name: user.name, role: user.role }
    });
  });
});

// ==========================================
// API 2: TRANSAKSI (READ, CREATE, DELETE)
// ==========================================
// GET LIST TRANSAKSI
expressApp.get('/api/transactions', (req, res) => {
  const { from_date, to_date, warehouse_id, search, user_id, role } = req.query;
  getWarehouseAccessQuery(user_id, role, (err, accessSql, accessParams) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    let filters = 'WHERE 1=1 ' + accessSql;
    const params = accessParams || [];

    if (from_date) {
      filters += ' AND h.trans_date >= ?';
      params.push(from_date);
    }
    if (to_date) {
      filters += ' AND h.trans_date <= ?';
      params.push(to_date);
    }
    if (warehouse_id) {
      filters += ' AND h.warehouse_id = ?';
      params.push(warehouse_id);
    }
    if (search) {
      filters += ` AND EXISTS (
        SELECT 1 FROM transaction_detail d
        JOIN master_item i ON d.item_id = i.id
        WHERE d.header_id = h.id AND (i.item_name LIKE ? OR i.item_code LIKE ?)
      )`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const sql = `
      SELECT h.*, w.warehouse_name
      FROM transaction_header h
      LEFT JOIN master_warehouse w ON h.warehouse_id = w.id
      ${filters}
      ORDER BY h.trans_date DESC, h.id DESC
      LIMIT 200
    `;

    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    });
  });
});

// POST TAMBAH TRANSAKSI BARU
expressApp.post('/api/transactions', (req, res) => {
  const { trans_date, trans_type, warehouse_id, created_by, remark } = req.body;

  if (!trans_date || !trans_type) {
    return res.status(400).json({ success: false, message: 'Tanggal dan Tipe Transaksi wajib diisi!' });
  }

  const transDateObj = new Date(trans_date);
  const periodMonth = transDateObj.getMonth() + 1;
  const periodYear = transDateObj.getFullYear();

  db.get(
    'SELECT status FROM period_lock WHERE period_month = ? AND period_year = ? AND warehouse_id = ?',
    [periodMonth, periodYear, warehouse_id || 1],
    (err, lock) => {
      if (err) {
        return res.status(500).json({ success: false, message: `Database Error: ${err.message}` });
      }
      if (lock && lock.status === 'LOCKED') {
        return res.status(400).json({
          success: false,
          message: `Gagal! Periode ${periodMonth}-${periodYear} untuk warehouse tersebut telah DI-LOCK. Transaksi tidak dapat ditambahkan.`
        });
      }

      const targetWarehouseId = warehouse_id || 1;
      const dateCode = trans_date.replace(/-/g, '');
      const transNumber = `TR-${dateCode}-${Math.floor(1000 + Math.random() * 9000)}`;

      db.run(
        `INSERT INTO transaction_header 
          (trans_number, trans_type, trans_date, warehouse_id, remark, status, period_month, period_year, created_by)
         VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
        [transNumber, trans_type, trans_date, targetWarehouseId, remark || '', periodMonth, periodYear, created_by || 'Admin'],
        function (insertErr) {
          if (insertErr) {
            return res.status(500).json({ success: false, message: insertErr.message });
          }
          res.json({
            success: true,
            message: 'Transaksi berhasil ditambahkan!',
            header_id: this.lastID,
            trans_number: transNumber
          });
        }
      );
    }
  );
});

// DELETE TRANSAKSI
expressApp.delete('/api/transactions/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT status FROM transaction_header WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!row) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
    if (row.status !== 'Active') {
      return res.status(400).json({ success: false, message: 'Hanya transaksi dengan status Active yang dapat dihapus.' });
    }
    db.run('UPDATE transaction_header SET status = ? WHERE id = ?', ['Deleted', id], function (err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'Transaksi berhasil dihapus' });
    });
  });
});

// ==========================================
// API 3: USER MANAGEMENT
// ==========================================
expressApp.get('/api/users', (req, res) => {
  db.all('SELECT id, username, name, role, status FROM master_user ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows || [] });
  });
});

expressApp.post('/api/users', (req, res) => {
  const { username, name, password, role } = req.body;

  if (!username || !name || !password) {
    return res.status(400).json({ success: false, message: 'Semua field wajib diisi!' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  db.run(
    'INSERT INTO master_user (username, name, password, role) VALUES (?, ?, ?, ?)',
    [username, name, hashedPassword, role || 'User'],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ success: false, message: 'Username sudah digunakan!' });
        }
        return res.status(500).json({ success: false, message: `Database Error: ${err.message}` });
      }
      res.json({ success: true, message: 'User berhasil ditambahkan!' });
    }
  );
});

expressApp.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM master_user WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'User berhasil dihapus' });
  });
});

// ==========================================
// API 4: LOCK / UNLOCK PERIODE MODUL
// ==========================================
expressApp.get('/api/periods', (req, res) => {
  const { user_id, role, warehouse_id } = req.query;
  getWarehouseAccessQuery(user_id, role, (err, accessSql, accessParams) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    let filters = 'WHERE 1=1 ' + accessSql;
    const params = accessParams || [];
    if (warehouse_id) {
      filters += ' AND warehouse_id = ?';
      params.push(warehouse_id);
    }

    const sql = `SELECT * FROM period_lock ${filters} ORDER BY period_year DESC, period_month DESC, warehouse_id`; 
    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    });
  });
});

expressApp.post('/api/period/toggle-lock', (req, res) => {
  const { month, year, action, action_by, warehouse_id } = req.body;
  if (!warehouse_id) return res.status(400).json({ success: false, message: 'Warehouse harus dipilih.' });

  const newHeaderStatus = action === 'LOCK' ? 'LOCKED' : 'Active';
  const newPeriodStatus = action === 'LOCK' ? 'LOCKED' : 'OPEN';

  db.serialize(() => {
    db.run(
      `UPDATE transaction_header SET status = ? WHERE period_month = ? AND period_year = ? AND warehouse_id = ?`,
      [newHeaderStatus, month, year, warehouse_id]
    );

    db.run(
      `INSERT INTO period_lock (period_month, period_year, warehouse_id, status, action_date, action_by)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(period_month, period_year, warehouse_id) DO UPDATE SET
         status = excluded.status,
         action_date = CURRENT_TIMESTAMP,
         action_by = excluded.action_by`,
      [month, year, warehouse_id, newPeriodStatus, action_by || 'Admin']
    );

    res.json({ success: true, message: `Periode ${month}-${year} pada warehouse berhasil di-${action.toLowerCase()}!` });
  });
});

// ==========================================
// API 5: MASTER DATA LOOKUPS (WAREHOUSE & ITEMS)
// ==========================================
expressApp.get('/api/warehouses', (req, res) => {
  const { user_id, role } = req.query;
  getWarehouseAccessQuery(user_id, role, (err, accessSql, accessParams) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    const sql = `SELECT id, warehouse_name, warehouse_code, company_id FROM master_warehouse WHERE status = 'A' ${accessSql}`;
    db.all(sql, accessParams || [], (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    });
  });
});

expressApp.get('/api/items', (req, res) => {
  db.all('SELECT id, item_code, item_name, category, base_unit, secondary_unit, status FROM master_item WHERE status IN ("A", "U")', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows || [] });
  });
});

// ==========================================
// JALANKAN SERVER & ELECTRON
// ==========================================
expressApp.listen(PORT, () => console.log(`Server Express running on http://localhost:${PORT}`));

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    title: 'Egg Inventory System',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true }
  });
  win.loadURL(`http://localhost:${PORT}/index.html`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});