module.exports = function registerRoutes(expressApp, db) {
  const bcrypt = require('bcryptjs');

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
    const { group_by = 'warehouse', from_date, to_date, warehouse_id, item_ids, user_id, role } = req.query;
    const selectedItemIds = item_ids ? (Array.isArray(item_ids) ? item_ids : item_ids.split(',')) : [];
    const selectedWarehouseIds = warehouse_id ? [Number(warehouse_id)] : [];

    getWarehouseAccessQuery(user_id, role, (err, accessSql, accessParams) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      let warehouseFilter = '';
      let warehouseParams = [];
      if (selectedWarehouseIds.length > 0) {
        warehouseFilter = 'AND h.warehouse_id IN (' + selectedWarehouseIds.map(() => '?').join(',') + ')';
        warehouseParams = selectedWarehouseIds;
      } else if (!isSuperadmin(role) && accessParams && accessParams.length > 0) {
        warehouseFilter = 'AND h.warehouse_id IN (' + accessParams.map(() => '?').join(',') + ')';
        warehouseParams = accessParams;
      }

      db.all(`SELECT h.trans_date, h.trans_type, h.warehouse_id, d.item_id, d.qty_pcs, d.qty_weight, i.item_code, i.item_name, i.base_unit, i.secondary_unit, w.warehouse_name FROM transaction_header h JOIN transaction_detail d ON d.header_id = h.id JOIN master_item i ON d.item_id = i.id LEFT JOIN master_warehouse w ON h.warehouse_id = w.id WHERE h.status != 'Deleted' ${warehouseFilter} ORDER BY h.trans_date`, [...warehouseParams], (txErr, txRows) => {
        if (txErr) return res.status(500).json({ success: false, error: txErr.message });

        db.all('SELECT id, item_code, item_name, base_unit, secondary_unit FROM master_item WHERE status IN ("A", "U") ORDER BY item_name', [], (itemErr, itemRows) => {
          if (itemErr) return res.status(500).json({ success: false, error: itemErr.message });

          const warehouseRows = selectedWarehouseIds.length > 0 ? selectedWarehouseIds.map((id) => ({ id })) : (accessParams && accessParams.length > 0 ? accessParams.map((id) => ({ id })) : []);
          const accessibleWarehouses = warehouseRows.length > 0 ? warehouseRows : [];

          const rows = [];
          const itemsToShow = itemRows.filter((item) => selectedItemIds.length === 0 || selectedItemIds.includes(String(item.id)));

          const buildEntry = (warehouseId, warehouseName, item) => ({
            warehouse_id: warehouseId,
            warehouse_name: warehouseName,
            item_id: item.id,
            item_code: item.item_code,
            item_name: item.item_name,
            base_unit: item.base_unit,
            secondary_unit: item.secondary_unit,
            opening_pcs: 0,
            opening_weight: 0,
            adjustment_pcs: 0,
            adjustment_weight: 0,
            in_pcs: 0,
            in_weight: 0,
            out_pcs: 0,
            out_weight: 0,
            closing_pcs: 0,
            closing_weight: 0
          });

          const warehouseList = accessibleWarehouses.length > 0 ? accessibleWarehouses : [];
          if (warehouseList.length === 0) {
            db.all('SELECT id, warehouse_name FROM master_warehouse WHERE status = "A" ORDER BY id', [], (whErr, whRows) => {
              if (whErr) return res.status(500).json({ success: false, error: whErr.message });
              finalizeReport(whRows);
            });
          } else {
            finalizeReport(warehouseList.map((warehouse) => ({ id: warehouse.id, warehouse_name: warehouse.warehouse_name || '' })));
          }

          function finalizeReport(warehouseListData) {
            warehouseListData.forEach((warehouse) => {
              itemsToShow.forEach((item) => {
                const entry = buildEntry(warehouse.id, warehouse.warehouse_name || warehouse.name || '-', item);
                txRows.filter((tx) => tx.warehouse_id === warehouse.id && tx.item_id === item.id).forEach((tx) => {
                  const txDate = tx.trans_date;
                  const isOpening = from_date && txDate < from_date;
                  const isInRange = (!from_date || txDate >= from_date) && (!to_date || txDate <= to_date);
                  const sign = tx.trans_type === 'OUT' ? -1 : 1;
                  if (isOpening) {
                    entry.opening_pcs += sign * Number(tx.qty_pcs || 0);
                    entry.opening_weight += sign * Number(tx.qty_weight || 0);
                  }
                  if (isInRange) {
                    if (tx.trans_type === 'ADJ') {
                      entry.adjustment_pcs += Number(tx.qty_pcs || 0);
                      entry.adjustment_weight += Number(tx.qty_weight || 0);
                    } else if (tx.trans_type === 'IN') {
                      entry.in_pcs += Number(tx.qty_pcs || 0);
                      entry.in_weight += Number(tx.qty_weight || 0);
                    } else if (tx.trans_type === 'OUT') {
                      entry.out_pcs += Number(tx.qty_pcs || 0);
                      entry.out_weight += Number(tx.qty_weight || 0);
                    }
                  }
                });
                entry.closing_pcs = entry.opening_pcs + entry.adjustment_pcs + entry.in_pcs - entry.out_pcs;
                entry.closing_weight = entry.opening_weight + entry.adjustment_weight + entry.in_weight - entry.out_weight;
                rows.push(entry);
              });
            });
            res.json({ success: true, data: rows });
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