const express = require('express');
const path = require('path');
const { db, initDatabase } = require('./src/main/database');
const registerRoutes = require('./src/main/main');

(async function(){
  try{
    await initDatabase();
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname,'src/frontend/views')));
    registerRoutes(app, db);
    const PORT = 3001;
    app.listen(PORT, () => console.log(`Dev server listening http://localhost:${PORT}`));
  } catch (e) {
    console.error('Failed to start dev server:', e);
    process.exit(1);
  }
})();
