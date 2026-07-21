const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const { initDatabase } = require('./database');
const InventoryController = require('../backend/controllers/inventoryController');

const expressApp = express();
const PORT = 3001;

expressApp.use(express.json());

// Serve Static Frontend
expressApp.use(express.static(path.join(__dirname, '../frontend/views')));

// Inisialisasi Database SQLite
initDatabase();

// API Endpoints
expressApp.get('/api/status', (req, res) => {
  res.json({ status: 'Online', message: 'Backend Server SQLite3 Berjalan!' });
});

expressApp.get('/api/report/warehouse', async (req, res) => {
  const { warehouse_id, start_date, end_date } = req.query;
  try {
    const reportData = await InventoryController.getReportWarehouse(warehouse_id, start_date, end_date);
    res.json({ success: true, data: reportData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Express Server
expressApp.listen(PORT, () => {
  console.log(`Express Server running on http://localhost:${PORT}`);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    title: "Egg Inventory System - Farm Management",
    autoHideMenuBar: true, // Sembunyikan menu bar bawaan Electron
    webPreferences: {
      nodeIntegration: true
    }
  });

  // Load Halaman UI Dashboard Utama
  win.loadURL(`http://localhost:${PORT}/index.html`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});