const { db } = require('../../main/database');

const InventoryController = {
  // Transaksi Baru (Header & Detail)
  createTransaction: (headerData, details) => {
    return new Promise((resolve, reject) => {
      const { trans_number, trans_type, trans_date, warehouse_id, created_by } = headerData;
      const dateObj = new Date(trans_date);
      const period_month = dateObj.getMonth() + 1;
      const period_year = dateObj.getFullYear();

      const sqlHeader = `
        INSERT INTO transaction_header (trans_number, trans_type, trans_date, warehouse_id, period_month, period_year, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      db.run(sqlHeader, [trans_number, trans_type, trans_date, warehouse_id, period_month, period_year, created_by], function(err) {
        if (err) return reject(err);
        
        const headerId = this.lastID;
        const sqlDetail = `INSERT INTO transaction_detail (header_id, item_id, qty_pcs, qty_weight, notes) VALUES (?, ?, ?, ?, ?)`;

        let completed = 0;
        if (details.length === 0) return resolve(headerId);

        details.forEach((item) => {
          db.run(sqlDetail, [headerId, item.item_id, item.qty_pcs, item.qty_weight, item.notes || ''], (err) => {
            if (err) return reject(err);
            completed++;
            if (completed === details.length) resolve(headerId);
          });
        });
      });
    });
  },

  // Report per Warehouse
  getReportWarehouse: (warehouse_id, startDate, endDate) => {
    return new Promise((resolve, reject) => {
      const querySaldoAwal = `
        SELECT 
          d.item_id,
          i.item_name,
          SUM(CASE WHEN h.trans_type IN ('ADJ', 'IN') THEN d.qty_pcs ELSE -d.qty_pcs END) as sa_qty_pcs,
          SUM(CASE WHEN h.trans_type IN ('ADJ', 'IN') THEN d.qty_weight ELSE -d.qty_weight END) as sa_qty_weight
        FROM transaction_detail d
        JOIN transaction_header h ON d.header_id = h.id
        JOIN master_item i ON d.item_id = i.id
        WHERE h.warehouse_id = ? AND h.trans_date < ? AND h.status != 'X'
        GROUP BY d.item_id
      `;

      const queryMutasi = `
        SELECT 
          d.item_id,
          i.item_name,
          SUM(CASE WHEN h.trans_type = 'ADJ' THEN d.qty_pcs ELSE 0 END) as adj_pcs,
          SUM(CASE WHEN h.trans_type = 'IN' THEN d.qty_pcs ELSE 0 END) as in_pcs,
          SUM(CASE WHEN h.trans_type = 'OUT' THEN d.qty_pcs ELSE 0 END) as out_pcs,
          SUM(CASE WHEN h.trans_type = 'ADJ' THEN d.qty_weight ELSE 0 END) as adj_weight,
          SUM(CASE WHEN h.trans_type = 'IN' THEN d.qty_weight ELSE 0 END) as in_weight,
          SUM(CASE WHEN h.trans_type = 'OUT' THEN d.qty_weight ELSE 0 END) as out_weight
        FROM transaction_detail d
        JOIN transaction_header h ON d.header_id = h.id
        JOIN master_item i ON d.item_id = i.id
        WHERE h.warehouse_id = ? AND h.trans_date BETWEEN ? AND ? AND h.status != 'X'
        GROUP BY d.item_id
      `;

      db.all(querySaldoAwal, [warehouse_id, startDate], (err, saldoAwal) => {
        if (err) return reject(err);
        db.all(queryMutasi, [warehouse_id, startDate, endDate], (err, mutasi) => {
          if (err) return reject(err);
          resolve({ saldoAwal, mutasi });
        });
      });
    });
  }
};

module.exports = InventoryController;