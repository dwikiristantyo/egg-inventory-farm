const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true
    }
  });

  // Menampilkan pesan sederhana
  win.loadURL('data:text/html;charset=utf-8,<h2>Sistem Inventory Farm Siap Dikembangkan!</h2>');
}

app.whenReady().then(createWindow);