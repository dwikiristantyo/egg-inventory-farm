const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const { initDatabase } = require('./database');
const InventoryController = require('../backend/controllers/inventoryController');

const expressApp = express();
const PORT = 3001;

expressApp.use(express.json());

// Inisialisasi Database SQLite
initDatabase();

// API Route Status
expressApp.get('/api/status', (req, res) => {
  res.json({ status: 'Online', message: 'Backend Server SQLite3 Berjalan!' });
});

// API Route Report Warehouse
expressApp.get('/api/report/warehouse', async (req, res) => {
  const { warehouse_id, start_date, end_date } = req.query;
  try {
    const reportData = await InventoryController.getReportWarehouse(warehouse_id, start_date, end_date);
    res.json({ success: true, data: reportData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Jalankan Express
expressApp.listen(PORT, () => {
  console.log(`Express Backend running on http://localhost:${PORT}`);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Egg Inventory System - Farm Management",
    webPreferences: {
      nodeIntegration: true
    }
  });

  win.loadURL(`http://localhost:${PORT}/api/status`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});