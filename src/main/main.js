// ==========================================
// API TRANSAKSI WITH DETAILS
// ==========================================
expressApp.get('/api/transactions/:id', (req, res) => {
  const { id } = req.params;
  const sqlHeader = `
    SELECT h.*, w.warehouse_name 
    FROM transaction_header h 
    LEFT JOIN master_warehouse w ON h.warehouse_id = w.id 
    WHERE h.id = ?`;
  
  db.get(sqlHeader, [id], (err, header) => {
    if (err || !header) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });

    const sqlDetails = `
      SELECT d.*, i.item_name, i.item_code 
      FROM transaction_detail d
      JOIN master_item i ON d.item_id = i.id
      WHERE d.header_id = ?`;

    db.all(sqlDetails, [id], (errDetails, details) => {
      res.json({ success: true, data: { ...header, details: details || [] } });
    });
  });
});

expressApp.post('/api/transactions-with-details', (req, res) => {
  const { trans_date, trans_type, warehouse_id, created_by, details } = req.body;

  if (!trans_date || !details || details.length === 0) {
    return res.status(400).json({ success: false, message: 'Data header dan minimal 1 item detail wajib diisi!' });
  }

  const transDateObj = new Date(trans_date);
  const periodMonth = transDateObj.getMonth() + 1;
  const periodYear = transDateObj.getFullYear();

  db.get('SELECT status FROM period_lock WHERE period_month = ? AND period_year = ?', [periodMonth, periodYear], (err, lock) => {
    if (lock && lock.status === 'LOCKED') {
      return res.status(400).json({ success: false, message: `Periode ${periodMonth}-${periodYear} terkuncur/LOCKED!` });
    }

    const transNumber = `TR-${trans_date.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    db.run(
      `INSERT INTO transaction_header (trans_number, trans_type, trans_date, warehouse_id, status, period_month, period_year, created_by)
       VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
      [transNumber, trans_type, trans_date, warehouse_id, periodMonth, periodYear, created_by || 'Admin'],
      function (errHeader) {
        if (errHeader) return res.status(500).json({ success: false, message: errHeader.message });

        const headerId = this.lastID;
        const stmt = db.prepare(`INSERT INTO transaction_detail (header_id, item_id, qty_pcs, qty_weight, notes) VALUES (?, ?, ?, ?, ?)`);

        details.forEach(item => {
          stmt.run(headerId, item.item_id, item.qty_pcs, item.qty_weight, item.notes || '');
        });
        stmt.finalize();

        res.json({ success: true, message: 'Transaksi berhasil disimpan!' });
      }
    );
  });
});

// ==========================================
// API MASTER ITEMS & WAREHOUSES
// ==========================================
expressApp.post('/api/master/items', (req, res) => {
  const { item_code, item_name, category, secondary_unit } = req.body;
  db.run(
    'INSERT INTO master_item (item_code, item_name, category, secondary_unit) VALUES (?, ?, ?, ?)',
    [item_code, item_name, category, secondary_unit || 'Kg'],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'Item berhasil ditambahkan' });
    }
  );
});

expressApp.post('/api/master/warehouses', (req, res) => {
  const { warehouse_code, warehouse_name, company_id } = req.body;
  db.run(
    'INSERT INTO master_warehouse (company_id, warehouse_code, warehouse_name) VALUES (?, ?, ?)',
    [company_id || 1, warehouse_code, warehouse_name],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'Warehouse / Farm berhasil ditambahkan' });
    }
  );
});

// ==========================================
// API USER GROUPS & ACCESS AUTHORIZATION
// ==========================================
expressApp.get('/api/user-groups', (req, res) => {
  db.all('SELECT * FROM user_group', [], (err, rows) => {
    res.json({ success: true, data: rows || [] });
  });
});

expressApp.post('/api/user-groups', (req, res) => {
  const { group_name, description } = req.body;
  db.run('INSERT INTO user_group (group_name, description) VALUES (?, ?)', [group_name, description], function(err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'User Group berhasil ditambahkan' });
  });
});

// ==========================================
// API REPORTS & STOCK SUMMARY
// ==========================================
expressApp.get('/api/reports/stock-summary', (req, res) => {
  const { warehouse_id } = req.query;
  let params = [];
  let whFilter = '';

  if (warehouse_id) {
    whFilter = 'WHERE h.warehouse_id = ?';
    params.push(warehouse_id);
  }

  const sql = `
    SELECT 
      i.item_code,
      i.item_name,
      SUM(CASE WHEN h.trans_type = 'IN' THEN d.qty_pcs WHEN h.trans_type = 'OUT' THEN -d.qty_pcs ELSE 0 END) as total_pcs,
      SUM(CASE WHEN h.trans_type = 'IN' THEN d.qty_weight WHEN h.trans_type = 'OUT' THEN -d.qty_weight ELSE 0 END) as total_weight
    FROM transaction_detail d
    JOIN transaction_header h ON d.header_id = h.id
    JOIN master_item i ON d.item_id = i.id
    ${whFilter}
    GROUP BY i.id
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows || [] });
  });
});