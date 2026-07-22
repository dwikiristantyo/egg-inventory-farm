module.exports = function registerRoutes(expressApp, db) {
  const bcrypt = require('bcryptjs');
  const ExcelJS = require('exceljs');
  const puppeteer = require('puppeteer');

  function isSuperadmin(role) {
    return role === 'Superadmin' || role === 'Administrator';
  }

  function getWarehouseAccessQuery(userId, role, callback) {
    if (!userId || isSuperadmin(role)) {
      return callback(null, '');
    }

    db.all(
      `SELECT warehouse_id FROM user_warehouse_access WHERE user_id = ?`,
      [userId],
      (err, rows) => {
        if (err) return callback(err);
        const ids = rows.map((row) => row.warehouse_id);
        if (ids.length === 0) {
          return callback(null, 'AND 0');
        }
        const placeholders = ids.map(() => '?').join(',');
        callback(null, `AND h.warehouse_id IN (${placeholders})`, ids);
      }
    );
  }

  function canAccessWarehouse(userId, role, warehouseId, callback) {
    if (!warehouseId) return callback(null, false);
    if (!userId || isSuperadmin(role)) return callback(null, true);
    db.get('SELECT 1 FROM user_warehouse_access WHERE user_id = ? AND warehouse_id = ?', [userId, warehouseId], (err, row) => {
      if (err) return callback(err);
      callback(null, !!row);
    });
  }

  function isLockedPeriod(status) {
    return ['LOCKED', 'LOCK', 'Locked', 'Lock'].includes(status);
  }

  function getPeriodMonthYear(dateString) {
    const date = new Date(dateString);
    return { month: date.getMonth() + 1, year: date.getFullYear() };
  }

  function ensureItemUsedStatus(itemId, callback) {
    db.get('SELECT status FROM master_item WHERE id = ?', [itemId], (err, item) => {
      if (err || !item) return callback(err || new Error('Item tidak ditemukan'));
      if (item.status === 'A') {
        db.run('UPDATE master_item SET status = ? WHERE id = ?', ['U', itemId], (updateErr) => callback(updateErr));
      } else {
        callback(null);
      }
    });
  }

  expressApp.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username dan password wajib diisi!' });
    }

    db.get('SELECT * FROM master_user WHERE username = ?', [username], (err, user) => {
      if (err) {
        console.error('Login DB Error:', err.message);
        return res.status(500).json({ success: false, message: `Database Error: ${err.message}` });
      }
      if (!user) {
        return res.status(401).json({ success: false, message: 'Username tidak ditemukan!' });
      }
      const isValid = bcrypt.compareSync(password, user.password);
      if (!isValid) {
        return res.status(401).json({ success: false, message: 'Password salah!' });
      }
      res.json({ success: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    });
  });

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

      db.all(sql, params, (dbErr, rows) => {
        if (dbErr) return res.status(500).json({ success: false, error: dbErr.message });
        res.json({ success: true, data: rows || [] });
      });
    });
  });

  expressApp.get('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    const { user_id, role } = req.query;

    db.get(`SELECT h.*, w.warehouse_name FROM transaction_header h LEFT JOIN master_warehouse w ON h.warehouse_id = w.id WHERE h.id = ?`, [id], (err, header) => {
      if (err || !header) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
      canAccessWarehouse(user_id, role, header.warehouse_id, (accessErr, allowed) => {
        if (accessErr) return res.status(500).json({ success: false, message: accessErr.message });
        if (!allowed) return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke warehouse ini.' });

        db.all(`SELECT d.*, i.item_code, i.item_name, i.base_unit, i.secondary_unit, i.status AS item_status FROM transaction_detail d JOIN master_item i ON d.item_id = i.id WHERE d.header_id = ?`, [id], (detailErr, details) => {
          if (detailErr) return res.status(500).json({ success: false, message: detailErr.message });
          res.json({ success: true, data: { ...header, details: details || [] } });
        });
      });
    });
  });

  expressApp.post('/api/transactions', (req, res) => {
    const { trans_date, trans_type, warehouse_id, created_by, remark, user_id, role } = req.body;
    if (!trans_date || !trans_type) {
      return res.status(400).json({ success: false, message: 'Tanggal dan tipe transaksi wajib diisi!' });
    }
    canAccessWarehouse(user_id, role, warehouse_id || 1, (accessErr, allowed) => {
      if (accessErr) return res.status(500).json({ success: false, message: accessErr.message });
      if (!allowed) return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke warehouse ini.' });

      const { month, year } = getPeriodMonthYear(trans_date);
      db.get('SELECT status FROM period_lock WHERE period_month = ? AND period_year = ? AND warehouse_id = ?', [month, year, warehouse_id || 1], (lockErr, lock) => {
        if (lockErr) return res.status(500).json({ success: false, message: lockErr.message });
        if (lock && isLockedPeriod(lock.status)) {
          return res.status(400).json({ success: false, message: `Periode ${month}-${year} untuk warehouse tersebut telah di-lock.` });
        }

        const targetWarehouseId = warehouse_id || 1;
        const dateCode = trans_date.replace(/-/g, '');
        const transNumber = `TR-${dateCode}-${Math.floor(1000 + Math.random() * 9000)}`;
        db.run(
          `INSERT INTO transaction_header (trans_number, trans_type, trans_date, warehouse_id, remark, status, period_month, period_year, created_by)
           VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
          [transNumber, trans_type, trans_date, targetWarehouseId, remark || '', month, year, created_by || 'Admin'],
          function(insertErr) {
            if (insertErr) return res.status(500).json({ success: false, message: insertErr.message });
            res.json({ success: true, message: 'Transaksi berhasil ditambahkan!', header_id: this.lastID, trans_number: transNumber });
          }
        );
      });
    });
  });

  expressApp.post('/api/transactions-with-details', (req, res) => {
    const { trans_date, trans_type, warehouse_id, created_by, remark, details, user_id, role } = req.body;
    if (!trans_date || !details || details.length === 0) {
      return res.status(400).json({ success: false, message: 'Data header dan minimal 1 detail wajib diisi!' });
    }

    canAccessWarehouse(user_id, role, warehouse_id, (accessErr, allowed) => {
      if (accessErr) return res.status(500).json({ success: false, message: accessErr.message });
      if (!allowed) return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke warehouse ini.' });

      const { month, year } = getPeriodMonthYear(trans_date);
      db.get('SELECT status FROM period_lock WHERE period_month = ? AND period_year = ? AND warehouse_id = ?', [month, year, warehouse_id], (lockErr, lock) => {
        if (lockErr) return res.status(500).json({ success: false, message: lockErr.message });
        if (lock && isLockedPeriod(lock.status)) {
          return res.status(400).json({ success: false, message: `Periode ${month}-${year} untuk warehouse tersebut telah di-lock.` });
        }

        const transNumber = `TR-${trans_date.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
        db.run(
          `INSERT INTO transaction_header (trans_number, trans_type, trans_date, warehouse_id, remark, status, period_month, period_year, created_by)
           VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
          [transNumber, trans_type, trans_date, warehouse_id, remark || '', month, year, created_by || 'Admin'],
          function(errHeader) {
            if (errHeader) return res.status(500).json({ success: false, message: errHeader.message });
            const headerId = this.lastID;
            const stmt = db.prepare(`INSERT INTO transaction_detail (header_id, item_id, qty_pcs, qty_weight, notes) VALUES (?, ?, ?, ?, ?)`);
            let pending = details.length;
            details.forEach((item) => {
              stmt.run(headerId, item.item_id, item.qty_pcs || 0, item.qty_weight || 0, item.notes || '', (detailErr) => {
                if (detailErr) return res.status(500).json({ success: false, message: detailErr.message });
                ensureItemUsedStatus(item.item_id, (statusErr) => {
                  if (statusErr) return res.status(500).json({ success: false, message: statusErr.message });
                  pending -= 1;
                  if (pending === 0) {
                    stmt.finalize();
                    res.json({ success: true, message: 'Transaksi berhasil disimpan!', header_id: headerId, trans_number: transNumber });
                  }
                });
              });
            });
          }
        );
      });
    });
  });

  expressApp.put('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    const { trans_date, trans_type, warehouse_id, remark, details, created_by, user_id, role } = req.body;

    db.get('SELECT * FROM transaction_header WHERE id = ?', [id], (err, header) => {
      if (err || !header) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
      if (header.status !== 'Active') return res.status(400).json({ success: false, message: 'Hanya transaksi Active yang bisa diedit.' });
      canAccessWarehouse(user_id, role, header.warehouse_id, (accessErr, allowed) => {
        if (accessErr) return res.status(500).json({ success: false, message: accessErr.message });
        if (!allowed) return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke warehouse ini.' });
        const { month, year } = getPeriodMonthYear(trans_date);
        db.get('SELECT status FROM period_lock WHERE period_month = ? AND period_year = ? AND warehouse_id = ?', [month, year, warehouse_id || header.warehouse_id], (lockErr, lock) => {
          if (lockErr) return res.status(500).json({ success: false, message: lockErr.message });
          if (lock && isLockedPeriod(lock.status)) return res.status(400).json({ success: false, message: `Periode ${month}-${year} telah di-lock.` });
          db.run(
            `UPDATE transaction_header SET trans_date = ?, trans_type = ?, warehouse_id = ?, remark = ?, updated_by = ?, updated_date = CURRENT_TIMESTAMP WHERE id = ?`,
            [trans_date, trans_type, warehouse_id || header.warehouse_id, remark || '', created_by || 'Admin', id],
            (updateErr) => {
              if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
              db.run('DELETE FROM transaction_detail WHERE header_id = ?', [id], (deleteErr) => {
                if (deleteErr) return res.status(500).json({ success: false, message: deleteErr.message });
                const stmt = db.prepare('INSERT INTO transaction_detail (header_id, item_id, qty_pcs, qty_weight, notes) VALUES (?, ?, ?, ?, ?)');
                let pending = details.length;
                details.forEach((item) => {
                  stmt.run(id, item.item_id, item.qty_pcs || 0, item.qty_weight || 0, item.notes || '', (detailErr) => {
                    if (detailErr) return res.status(500).json({ success: false, message: detailErr.message });
                    ensureItemUsedStatus(item.item_id, (statusErr) => {
                      if (statusErr) return res.status(500).json({ success: false, message: statusErr.message });
                      pending -= 1;
                      if (pending === 0) {
                        stmt.finalize();
                        res.json({ success: true, message: 'Transaksi berhasil diperbarui!' });
                      }
                    });
                  });
                });
              });
            }
          );
        });
      });
    });
  });

  expressApp.delete('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    const { user_id, role } = req.query;
    db.get('SELECT * FROM transaction_header WHERE id = ?', [id], (err, row) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (!row) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
      canAccessWarehouse(user_id, role, row.warehouse_id, (accessErr, allowed) => {
        if (accessErr) return res.status(500).json({ success: false, message: accessErr.message });
        if (!allowed) return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke warehouse ini.' });
        if (row.status !== 'Active') return res.status(400).json({ success: false, message: 'Hanya transaksi Active yang bisa dihapus.' });
        db.run('UPDATE transaction_header SET status = ? WHERE id = ?', ['Deleted', id], (updateErr) => {
          if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
          res.json({ success: true, message: 'Transaksi berhasil dihapus' });
        });
      });
    });
  });

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

      const sql = `SELECT p.*, w.warehouse_name FROM period_lock p LEFT JOIN master_warehouse w ON p.warehouse_id = w.id ${filters} ORDER BY p.period_year DESC, p.period_month DESC, p.warehouse_id`;
      db.all(sql, params, (dbErr, rows) => {
        if (dbErr) return res.status(500).json({ success: false, error: dbErr.message });
        res.json({ success: true, data: rows || [] });
      });
    });
  });

  expressApp.post('/api/period/toggle-lock', (req, res) => {
    const { month, year, action, action_by, warehouse_id, user_id, role } = req.body;
    if (!warehouse_id) return res.status(400).json({ success: false, message: 'Warehouse harus dipilih.' });
    canAccessWarehouse(user_id, role, warehouse_id, (accessErr, allowed) => {
      if (accessErr) return res.status(500).json({ success: false, message: accessErr.message });
      if (!allowed) return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke warehouse ini.' });

      const newHeaderStatus = action === 'LOCK' ? 'Locked' : 'Active';
      const newPeriodStatus = action === 'LOCK' ? 'LOCKED' : 'OPEN';
      db.serialize(() => {
        db.run('UPDATE transaction_header SET status = ? WHERE period_month = ? AND period_year = ? AND warehouse_id = ?', [newHeaderStatus, month, year, warehouse_id]);
        db.run(`INSERT INTO period_lock (period_month, period_year, warehouse_id, status, action_date, action_by)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
          ON CONFLICT(period_month, period_year, warehouse_id) DO UPDATE SET status = excluded.status, action_date = CURRENT_TIMESTAMP, action_by = excluded.action_by`, [month, year, warehouse_id, newPeriodStatus, action_by || 'Admin']);
        res.json({ success: true, message: `Periode ${month}-${year} pada warehouse berhasil di-${action.toLowerCase()}!` });
      });
    });
  });

  expressApp.get('/api/warehouses', (req, res) => {
    const { user_id, role } = req.query;
    getWarehouseAccessQuery(user_id, role, (err, accessSql, accessParams) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      const sql = `SELECT id, warehouse_name, warehouse_code, company_id FROM master_warehouse WHERE status = 'A' ${accessSql}`;
      db.all(sql, accessParams || [], (dbErr, rows) => {
        if (dbErr) return res.status(500).json({ success: false, error: dbErr.message });
        res.json({ success: true, data: rows || [] });
      });
    });
  });

  expressApp.get('/api/items', (req, res) => {
    db.all('SELECT id, item_code, item_name, category, base_unit, secondary_unit, status FROM master_item WHERE status IN ("A", "U") ORDER BY item_name', [], (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    });
  });

  expressApp.get('/api/master/items', (req, res) => {
    db.all('SELECT * FROM master_item ORDER BY id DESC', [], (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    });
  });

  expressApp.get('/api/master/items/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM master_item WHERE id = ?', [id], (err, row) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (!row) return res.status(404).json({ success: false, message: 'Item tidak ditemukan' });
      res.json({ success: true, data: row });
    });
  });

  expressApp.post('/api/master/items', (req, res) => {
    const { item_code, item_name, category, base_unit, secondary_unit, status, created_by, user_role } = req.body;
    if (!item_code || !item_name || !category) return res.status(400).json({ success: false, message: 'Kode, nama, dan kategori item wajib diisi.' });
    if (user_role && !isSuperadmin(user_role)) return res.status(403).json({ success: false, message: 'Hanya superadmin yang dapat memodifikasi master item.' });

    db.run(
      'INSERT INTO master_item (item_code, item_name, category, base_unit, secondary_unit, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [item_code, item_name, category, base_unit || 'Butir', secondary_unit || 'KG', status || 'A', created_by || 'System'],
      function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: 'Item berhasil ditambahkan' });
      }
    );
  });

  expressApp.put('/api/master/items/:id', (req, res) => {
    const { id } = req.params;
    const { item_code, item_name, category, base_unit, secondary_unit, user_role } = req.body;
    if (user_role && !isSuperadmin(user_role)) return res.status(403).json({ success: false, message: 'Hanya superadmin yang dapat memodifikasi master item.' });

    db.get('SELECT * FROM master_item WHERE id = ?', [id], (err, item) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (!item) return res.status(404).json({ success: false, message: 'Item tidak ditemukan' });
      if (item.status !== 'A') return res.status(400).json({ success: false, message: 'Item dengan status U/X tidak bisa diedit.' });

      db.run('UPDATE master_item SET item_code = ?, item_name = ?, category = ?, base_unit = ?, secondary_unit = ?, updated_by = ?, updated_date = CURRENT_TIMESTAMP WHERE id = ?', [item_code, item_name, category, base_unit || item.base_unit, secondary_unit || item.secondary_unit, user_role || 'System', id], function(updateErr) {
        if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
        res.json({ success: true, message: 'Item berhasil diperbarui' });
      });
    });
  });

  expressApp.delete('/api/master/items/:id', (req, res) => {
    const { id } = req.params;
    const { user_role } = req.query;
    if (user_role && !isSuperadmin(user_role)) return res.status(403).json({ success: false, message: 'Hanya superadmin yang dapat memodifikasi master item.' });

    db.get('SELECT * FROM master_item WHERE id = ?', [id], (err, item) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (!item) return res.status(404).json({ success: false, message: 'Item tidak ditemukan' });
      if (item.status === 'A') {
        db.run('DELETE FROM master_item WHERE id = ?', [id], (deleteErr) => {
          if (deleteErr) return res.status(500).json({ success: false, message: deleteErr.message });
          res.json({ success: true, message: 'Item berhasil dihapus' });
        });
      } else if (item.status === 'U') {
        db.run('UPDATE master_item SET status = ? WHERE id = ?', ['X', id], (updateErr) => {
          if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
          res.json({ success: true, message: 'Item dipindahkan ke status X' });
        });
      } else {
        return res.status(400).json({ success: false, message: 'Item dengan status X tidak bisa dihapus lagi.' });
      }
    });
  });

  expressApp.get('/api/user-groups', (req, res) => {
    db.all('SELECT * FROM user_group ORDER BY id', [], (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    });
  });

  expressApp.post('/api/user-groups', (req, res) => {
    const { group_name, description, user_role } = req.body;
    if (!isSuperadmin(user_role)) return res.status(403).json({ success: false, message: 'Hanya superadmin yang dapat mengelola user group.' });
    db.run('INSERT INTO user_group (group_name, description) VALUES (?, ?)', [group_name, description], function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'User Group berhasil ditambahkan' });
    });
  });

  expressApp.post('/api/master/warehouses', (req, res) => {
    const { warehouse_code, warehouse_name, company_id, user_role } = req.body;
    if (!isSuperadmin(user_role)) return res.status(403).json({ success: false, message: 'Hanya superadmin yang dapat mengelola warehouse.' });
    db.run('INSERT INTO master_warehouse (company_id, warehouse_code, warehouse_name) VALUES (?, ?, ?)', [company_id || 1, warehouse_code, warehouse_name], function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'Warehouse / Farm berhasil ditambahkan' });
    });
  });

  expressApp.get('/api/reports/stock-summary', (req, res) => {
    const { from_date, to_date, warehouse_id, item_ids, user_id, role } = req.query;
    if (!from_date || !to_date || !warehouse_id) return res.status(400).json({ success: false, message: 'Parameter from_date, to_date, dan warehouse_id wajib diisi.' });
    const selectedItemIds = item_ids ? (Array.isArray(item_ids) ? item_ids : item_ids.split(',').filter(Boolean)) : [];

    getWarehouseAccessQuery(user_id, role, (err, accessSql, accessParams) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      // check access to requested warehouse
      if (!isSuperadmin(role) && accessParams && accessParams.length > 0 && !accessParams.includes(Number(warehouse_id))) {
        return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke warehouse ini.' });
      }

      // build SQL from provided ledger query, replace literal params with placeholders
      let sql = `
WITH params AS (
    SELECT ? AS from_date, ? AS to_date, ? AS warehouse_id
),

opening_balance AS (
    SELECT 
        d.item_id,
        COALESCE(SUM(CASE 
            WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_pcs 
            WHEN h.trans_type = 'OUT' THEN -d.qty_pcs 
            ELSE 0 
        END), 0) AS init_qty_pcs,
        COALESCE(SUM(CASE 
            WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_weight 
            WHEN h.trans_type = 'OUT' THEN -d.qty_weight 
            ELSE 0 
        END), 0) AS init_qty_weight
    FROM transaction_header h
    JOIN transaction_detail d ON h.id = d.header_id
    CROSS JOIN params p
    WHERE h.trans_date < (SELECT from_date FROM params)
      AND h.warehouse_id = (SELECT warehouse_id FROM params)
      AND h.status IN ('Posted', 'Active')
    GROUP BY d.item_id
),

raw_transactions AS (
    SELECT 
        h.id AS trans_id,
        h.trans_date,
        d.item_id,
        mi.item_name,
        mi.base_unit,
        mi.secondary_unit,
        d.notes,
        h.trans_type,
        CASE 
            WHEN h.trans_type = 'ADJUSTMENT' THEN 1
            WHEN h.trans_type = 'IN' THEN 2
            WHEN h.trans_type = 'OUT' THEN 3
            ELSE 4
        END AS type_priority,
        CASE WHEN h.trans_type = 'ADJUSTMENT' THEN d.qty_pcs ELSE 0 END AS adj_qty_pcs,
        CASE WHEN h.trans_type = 'IN'         THEN d.qty_pcs ELSE 0 END AS in_qty_pcs,
        CASE WHEN h.trans_type = 'OUT'        THEN d.qty_pcs ELSE 0 END AS out_qty_pcs,
        CASE WHEN h.trans_type = 'ADJUSTMENT' THEN d.qty_weight ELSE 0 END AS adj_qty_weight,
        CASE WHEN h.trans_type = 'IN'         THEN d.qty_weight ELSE 0 END AS in_qty_weight,
        CASE WHEN h.trans_type = 'OUT'        THEN d.qty_weight ELSE 0 END AS out_qty_weight,
        CASE 
            WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_pcs 
            WHEN h.trans_type = 'OUT' THEN -d.qty_pcs 
            ELSE 0 
        END AS net_pcs,
        CASE 
            WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_weight 
            WHEN h.trans_type = 'OUT' THEN -d.qty_weight 
            ELSE 0 
        END AS net_weight
    FROM transaction_header h
    JOIN transaction_detail d ON h.id = d.header_id
    JOIN master_item mi ON d.item_id = mi.id
    CROSS JOIN params p
    WHERE h.trans_date BETWEEN (SELECT from_date FROM params) AND (SELECT to_date FROM params)
      AND h.warehouse_id = (SELECT warehouse_id FROM params)
      AND h.status IN ('Posted', 'Active')
`;

      const params = [from_date, to_date, Number(warehouse_id)];
      if (selectedItemIds.length > 0) {
        sql += ` AND d.item_id IN (${selectedItemIds.map(() => '?').join(',')})`;
        selectedItemIds.forEach(id => params.push(Number(id)));
      }

      sql += `
),

calculated_ledger AS (
    SELECT 
        t.*,
        COALESCE(ob.init_qty_pcs, 0) AS init_qty_pcs,
        COALESCE(ob.init_qty_weight, 0) AS init_qty_weight,
        ROW_NUMBER() OVER (
            ORDER BY t.item_id ASC, t.trans_date ASC, t.type_priority ASC, t.trans_id ASC
        ) AS row_num,
        SUM(t.net_pcs) OVER (
            PARTITION BY t.item_id 
            ORDER BY t.trans_date ASC, t.type_priority ASC, t.trans_id ASC
        ) AS running_net_pcs,
        SUM(t.net_weight) OVER (
            PARTITION BY t.item_id 
            ORDER BY t.trans_date ASC, t.type_priority ASC, t.trans_id ASC
        ) AS running_net_weight
    FROM raw_transactions t
    LEFT JOIN opening_balance ob ON t.item_id = ob.item_id
)

SELECT 
    c.row_num AS no,
    c.trans_date,
    c.item_name,
    c.notes,
    (c.init_qty_pcs + c.running_net_pcs - c.net_pcs) AS saldo_awal_qty_pcs,
    c.base_unit AS saldo_awal_base_unit,
    (c.init_qty_weight + c.running_net_weight - c.net_weight) AS saldo_awal_qty_weight,
    c.secondary_unit AS saldo_awal_secondary_unit,
    c.adj_qty_pcs AS adjustment_qty_pcs,
    c.base_unit AS adjustment_base_unit,
    c.adj_qty_weight AS adjustment_qty_weight,
    c.secondary_unit AS adjustment_secondary_unit,
    c.in_qty_pcs AS in_qty_pcs,
    c.base_unit AS in_base_unit,
    c.in_qty_weight AS in_qty_weight,
    c.secondary_unit AS in_secondary_unit,
    c.out_qty_pcs AS out_qty_pcs,
    c.base_unit AS out_base_unit,
    c.out_qty_weight AS out_qty_weight,
    c.secondary_unit AS out_secondary_unit,
    (c.init_qty_pcs + c.running_net_pcs) AS balance_qty_pcs,
    c.base_unit AS balance_base_unit,
    (c.init_qty_weight + c.running_net_weight) AS balance_qty_weight,
    c.secondary_unit AS balance_secondary_unit
FROM calculated_ledger c
ORDER BY c.item_id ASC, c.trans_date ASC, c.type_priority ASC, c.trans_id ASC;
`;

      db.all(sql, params, (errQuery, rows) => {
        if (errQuery) return res.status(500).json({ success: false, error: errQuery.message });
        res.json({ success: true, data: rows || [] });
      });
    });
  });

  // export endpoint (excel or pdf)
  expressApp.get('/api/reports/stock-summary/export', async (req, res) => {
    const { type = 'excel', from_date, to_date, warehouse_id, item_ids, user_id, role } = req.query;
    if (!from_date || !to_date || !warehouse_id) return res.status(400).send('from_date,to_date,warehouse_id required');
    // reuse the same SQL logic
    const selectedItemIds = item_ids ? (Array.isArray(item_ids) ? item_ids : item_ids.split(',').filter(Boolean)) : [];
    getWarehouseAccessQuery(user_id, role, (err, accessSql, accessParams) => {
      if (err) return res.status(500).send(err.message);
      if (!isSuperadmin(role) && accessParams && accessParams.length > 0 && !accessParams.includes(Number(warehouse_id))) {
        return res.status(403).send('Forbidden');
      }
        // build full ledger SQL (same as list endpoint) so export matches displayed report
        let sql = `
    WITH params AS (
      SELECT ? AS from_date, ? AS to_date, ? AS warehouse_id
    ),

    opening_balance AS (
      SELECT 
        d.item_id,
        COALESCE(SUM(CASE 
          WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_pcs 
          WHEN h.trans_type = 'OUT' THEN -d.qty_pcs 
          ELSE 0 
        END), 0) AS init_qty_pcs,
        COALESCE(SUM(CASE 
          WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_weight 
          WHEN h.trans_type = 'OUT' THEN -d.qty_weight 
          ELSE 0 
        END), 0) AS init_qty_weight
      FROM transaction_header h
      JOIN transaction_detail d ON h.id = d.header_id
      CROSS JOIN params p
      WHERE h.trans_date < (SELECT from_date FROM params)
        AND h.warehouse_id = (SELECT warehouse_id FROM params)
        AND h.status IN ('Posted', 'Active')
      GROUP BY d.item_id
    ),

    raw_transactions AS (
      SELECT 
        h.id AS trans_id,
        h.trans_date,
        d.item_id,
        mi.item_name,
        mi.base_unit,
        mi.secondary_unit,
        d.notes,
        h.trans_type,
        CASE 
          WHEN h.trans_type = 'ADJUSTMENT' THEN 1
          WHEN h.trans_type = 'IN' THEN 2
          WHEN h.trans_type = 'OUT' THEN 3
          ELSE 4
        END AS type_priority,
        CASE WHEN h.trans_type = 'ADJUSTMENT' THEN d.qty_pcs ELSE 0 END AS adj_qty_pcs,
        CASE WHEN h.trans_type = 'IN'         THEN d.qty_pcs ELSE 0 END AS in_qty_pcs,
        CASE WHEN h.trans_type = 'OUT'        THEN d.qty_pcs ELSE 0 END AS out_qty_pcs,
        CASE WHEN h.trans_type = 'ADJUSTMENT' THEN d.qty_weight ELSE 0 END AS adj_qty_weight,
        CASE WHEN h.trans_type = 'IN'         THEN d.qty_weight ELSE 0 END AS in_qty_weight,
        CASE WHEN h.trans_type = 'OUT'        THEN d.qty_weight ELSE 0 END AS out_qty_weight,
        CASE 
          WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_pcs 
          WHEN h.trans_type = 'OUT' THEN -d.qty_pcs 
          ELSE 0 
        END AS net_pcs,
        CASE 
          WHEN h.trans_type IN ('ADJUSTMENT', 'IN') THEN d.qty_weight 
          WHEN h.trans_type = 'OUT' THEN -d.qty_weight 
          ELSE 0 
        END AS net_weight
      FROM transaction_header h
      JOIN transaction_detail d ON h.id = d.header_id
      JOIN master_item mi ON d.item_id = mi.id
      CROSS JOIN params p
      WHERE h.trans_date BETWEEN (SELECT from_date FROM params) AND (SELECT to_date FROM params)
        AND h.warehouse_id = (SELECT warehouse_id FROM params)
        AND h.status IN ('Posted', 'Active')
    `;

        const params = [from_date, to_date, Number(warehouse_id)];
        if (selectedItemIds.length > 0) {
        sql += ` AND d.item_id IN (${selectedItemIds.map(() => '?').join(',')})`;
        selectedItemIds.forEach(id => params.push(Number(id)));
        }

        sql += `
    ),

    calculated_ledger AS (
      SELECT 
        t.*,
        COALESCE(ob.init_qty_pcs, 0) AS init_qty_pcs,
        COALESCE(ob.init_qty_weight, 0) AS init_qty_weight,
        ROW_NUMBER() OVER (
          ORDER BY t.item_id ASC, t.trans_date ASC, t.type_priority ASC, t.trans_id ASC
        ) AS row_num,
        SUM(t.net_pcs) OVER (
          PARTITION BY t.item_id 
          ORDER BY t.trans_date ASC, t.type_priority ASC, t.trans_id ASC
        ) AS running_net_pcs,
        SUM(t.net_weight) OVER (
          PARTITION BY t.item_id 
          ORDER BY t.trans_date ASC, t.type_priority ASC, t.trans_id ASC
        ) AS running_net_weight
      FROM raw_transactions t
      LEFT JOIN opening_balance ob ON t.item_id = ob.item_id
    )

    SELECT 
      c.row_num AS no,
      c.trans_date,
      c.item_name,
      c.notes,
      (c.init_qty_pcs + c.running_net_pcs - c.net_pcs) AS saldo_awal_qty_pcs,
      c.base_unit AS saldo_awal_base_unit,
      (c.init_qty_weight + c.running_net_weight - c.net_weight) AS saldo_awal_qty_weight,
      c.secondary_unit AS saldo_awal_secondary_unit,
      c.adj_qty_pcs AS adjustment_qty_pcs,
      c.base_unit AS adjustment_base_unit,
      c.adj_qty_weight AS adjustment_qty_weight,
      c.secondary_unit AS adjustment_secondary_unit,
      c.in_qty_pcs AS in_qty_pcs,
      c.base_unit AS in_base_unit,
      c.in_qty_weight AS in_qty_weight,
      c.secondary_unit AS in_secondary_unit,
      c.out_qty_pcs AS out_qty_pcs,
      c.base_unit AS out_base_unit,
      c.out_qty_weight AS out_qty_weight,
      c.secondary_unit AS out_secondary_unit,
      (c.init_qty_pcs + c.running_net_pcs) AS balance_qty_pcs,
      c.base_unit AS balance_base_unit,
      (c.init_qty_weight + c.running_net_weight) AS balance_qty_weight,
      c.secondary_unit AS balance_secondary_unit
    FROM calculated_ledger c
    ORDER BY c.item_id ASC, c.trans_date ASC, c.type_priority ASC, c.trans_id ASC;
    `;

      db.get('SELECT warehouse_name FROM master_warehouse WHERE id = ?', [warehouse_id], async (whErr, warehouse) => {
        if (whErr) return res.status(500).send(whErr.message);
        const warehouseName = warehouse?.warehouse_name || '';

        db.all(sql, params, async (qErr, rows) => {
          if (qErr) return res.status(500).send(qErr.message);
          try {
            const title = 'Report Stock Per Warehouse Group By Item';
            const rangeText = `From Date: ${from_date}   To Date: ${to_date}`;
            const warehouseText = `Farm / Warehouse: ${warehouseName}`;
            const headers = [
              'No', 'trans_date', 'item_name', 'notes',
              'saldo_awal_qty_pcs', 'saldo_awal_base_unit', 'saldo_awal_qty_weight', 'saldo_awal_secondary_unit',
              'adjustment_qty_pcs', 'adjustment_base_unit', 'adjustment_qty_weight', 'adjustment_secondary_unit',
              'in_qty_pcs', 'in_base_unit', 'in_qty_weight', 'in_secondary_unit',
              'out_qty_pcs', 'out_base_unit', 'out_qty_weight', 'out_secondary_unit',
              'balance_qty_pcs', 'balance_base_unit', 'balance_qty_weight', 'balance_secondary_unit'
            ];

            if (type === 'excel') {
              const workbook = new ExcelJS.Workbook();
              const sheet = workbook.addWorksheet('Report');
              const totalCols = headers.length;
              const endCol = String.fromCharCode('A'.charCodeAt(0) + totalCols - 1);

              sheet.mergeCells(`A1:${endCol}1`);
              sheet.mergeCells(`A2:${endCol}2`);
              sheet.mergeCells(`A3:${endCol}3`);
              sheet.getCell('A1').value = title;
              sheet.getCell('A2').value = rangeText;
              sheet.getCell('A3').value = warehouseText;
              ['A1', 'A2', 'A3'].forEach((cell) => {
                sheet.getCell(cell).alignment = { horizontal: 'center', vertical: 'middle' };
                sheet.getCell(cell).font = { bold: true, size: 12 };
              });

              const headerRow1 = sheet.getRow(4);
              const headerRow2 = sheet.getRow(5);
              headerRow1.height = 20;
              headerRow2.height = 20;

              const titles = [
                { label: 'No', span: 1 },
                { label: 'trans_date', span: 1 },
                { label: 'item_name', span: 1 },
                { label: 'notes', span: 1 },
                { label: 'saldo_awal', span: 4 },
                { label: 'adjustment', span: 4 },
                { label: 'in', span: 4 },
                { label: 'out', span: 4 },
                { label: 'balance', span: 4 }
              ];
              let colIndex = 1;
              titles.forEach((item) => {
                const start = sheet.getRow(4).getCell(colIndex);
                start.value = item.label;
                start.alignment = { horizontal: 'center', vertical: 'middle' };
                start.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB8D5FF' } };
                start.font = { bold: true };
                if (item.span > 1) {
                  const endIndex = colIndex + item.span - 1;
                  sheet.mergeCells(4, colIndex, 4, endIndex);
                  for (let c = colIndex; c <= endIndex; c += 1) {
                    sheet.getCell(4, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB8D5FF' } };
                    sheet.getCell(4, c).font = { bold: true };
                  }
                } else {
                  sheet.mergeCells(4, colIndex, 5, colIndex);
                  sheet.getCell(4, colIndex).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB8D5FF' } };
                  sheet.getCell(4, colIndex).font = { bold: true };
                }
                colIndex += item.span;
              });

              const subHeaders = ['qty_pcs', 'base_unit', 'qty_weight', 'secondary_unit'];
              const subCols = ['E', 'F', 'G', 'H'];
              let subIndex = 5;
              for (let group = 0; group < 5; group += 1) {
                subHeaders.forEach((sub) => {
                  const cell = headerRow2.getCell(subIndex);
                  cell.value = sub;
                  cell.alignment = { horizontal: 'center', vertical: 'middle' };
                  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4F1FF' } };
                  cell.font = { bold: true };
                  subIndex += 1;
                });
              }

              sheet.columns = headers.map((h) => ({ header: h, key: h, width: 14 }));
              sheet.columns[1].width = 14;
              sheet.columns[2].width = 18;
              sheet.columns[3].width = 22;
              sheet.columns[4].width = 12;
              sheet.columns[6].width = 12;
              rows.forEach((row) => {
                sheet.addRow([
                  row.no,
                  row.trans_date,
                  row.item_name,
                  row.notes,
                  row.saldo_awal_qty_pcs,
                  row.saldo_awal_base_unit,
                  row.saldo_awal_qty_weight,
                  row.saldo_awal_secondary_unit,
                  row.adjustment_qty_pcs,
                  row.adjustment_base_unit,
                  row.adjustment_qty_weight,
                  row.adjustment_secondary_unit,
                  row.in_qty_pcs,
                  row.in_base_unit,
                  row.in_qty_weight,
                  row.in_secondary_unit,
                  row.out_qty_pcs,
                  row.out_base_unit,
                  row.out_qty_weight,
                  row.out_secondary_unit,
                  row.balance_qty_pcs,
                  row.balance_base_unit,
                  row.balance_qty_weight,
                  row.balance_secondary_unit
                ]);
              });

              const buffer = await workbook.xlsx.writeBuffer();
              res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
              res.setHeader('Content-Disposition', 'attachment; filename=stock-report.xlsx');
              return res.send(Buffer.from(buffer));
            }

            const html = `
              <html>
                <head>
                  <meta charset="utf-8">
                  <style>
                    body { font-family: Arial, sans-serif; font-size: 11px; }
                    table { border-collapse: collapse; width: 100%; }
                    th, td { border: 1px solid #999; padding: 6px; }
                    .title-row td { background: #d8e8ff; font-weight: bold; text-align: center; font-size: 14px; }
                    .info-row td { background: #f3f6ff; font-weight: bold; }
                    .group-header { background: #b8d5ff; text-align: center; font-weight: bold; }
                    .sub-header { background: #e4f1ff; text-align: center; font-weight: bold; }
                  </style>
                </head>
                <body>
                  <table>
                    <tr class="title-row"><td colspan="24">${title}</td></tr>
                    <tr class="info-row"><td colspan="24">${rangeText}</td></tr>
                    <tr class="info-row"><td colspan="24">${warehouseText}</td></tr>
                    <tr class="group-header">
                      <td rowspan="2">No</td>
                      <td rowspan="2">trans_date</td>
                      <td rowspan="2">item_name</td>
                      <td rowspan="2">notes</td>
                      <td colspan="4">saldo_awal</td>
                      <td colspan="4">adjustment</td>
                      <td colspan="4">in</td>
                      <td colspan="4">out</td>
                      <td colspan="4">balance</td>
                    </tr>
                    <tr class="sub-header">
                      <td>qty_pcs</td><td>base_unit</td><td>qty_weight</td><td>secondary_unit</td>
                      <td>qty_pcs</td><td>base_unit</td><td>qty_weight</td><td>secondary_unit</td>
                      <td>qty_pcs</td><td>base_unit</td><td>qty_weight</td><td>secondary_unit</td>
                      <td>qty_pcs</td><td>base_unit</td><td>qty_weight</td><td>secondary_unit</td>
                      <td>qty_pcs</td><td>base_unit</td><td>qty_weight</td><td>secondary_unit</td>
                    </tr>
                    ${rows.map((row) => `
                      <tr>
                        <td>${row.no}</td>
                        <td>${row.trans_date}</td>
                        <td>${row.item_name}</td>
                        <td>${row.notes || ''}</td>
                        <td>${row.saldo_awal_qty_pcs}</td>
                        <td>${row.saldo_awal_base_unit}</td>
                        <td>${row.saldo_awal_qty_weight}</td>
                        <td>${row.saldo_awal_secondary_unit}</td>
                        <td>${row.adjustment_qty_pcs}</td>
                        <td>${row.adjustment_base_unit}</td>
                        <td>${row.adjustment_qty_weight}</td>
                        <td>${row.adjustment_secondary_unit}</td>
                        <td>${row.in_qty_pcs}</td>
                        <td>${row.in_base_unit}</td>
                        <td>${row.in_qty_weight}</td>
                        <td>${row.in_secondary_unit}</td>
                        <td>${row.out_qty_pcs}</td>
                        <td>${row.out_base_unit}</td>
                        <td>${row.out_qty_weight}</td>
                        <td>${row.out_secondary_unit}</td>
                        <td>${row.balance_qty_pcs}</td>
                        <td>${row.balance_base_unit}</td>
                        <td>${row.balance_qty_weight}</td>
                        <td>${row.balance_secondary_unit}</td>
                      </tr>
                    `).join('')}
                  </table>
                </body>
              </html>
            `;

            const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
            await browser.close();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename=stock-report.pdf');
            return res.send(pdfBuffer);
          } catch (e) {
            return res.status(500).send(e.message);
          }
        });
      });
    });
  });

  expressApp.get('/api/users', (req, res) => {
    db.all('SELECT id, username, name, role, status FROM master_user ORDER BY id DESC', [], (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, data: rows || [] });
    });
  });

  expressApp.post('/api/users', (req, res) => {
    const { username, name, password, role, user_role } = req.body;
    if (!isSuperadmin(user_role)) return res.status(403).json({ success: false, message: 'Hanya superadmin yang dapat mengelola user.' });
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.run('INSERT INTO master_user (username, name, password, role, status) VALUES (?, ?, ?, ?, ?)', [username, name, hashedPassword, role || 'User', 'A'], function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'User berhasil ditambahkan' });
    });
  });

  expressApp.delete('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const { user_role } = req.query;
    if (!isSuperadmin(user_role)) return res.status(403).json({ success: false, message: 'Hanya superadmin yang dapat mengelola user.' });
    db.run('DELETE FROM master_user WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'User berhasil dihapus' });
    });
  });

  return expressApp;
};