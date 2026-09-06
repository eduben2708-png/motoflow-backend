const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: true // OBLIGATORIO para Aiven
  }
});

// Test conexión
pool.getConnection()
  .then(conn => {
    console.log('✓ Conectado a MySQL (Aiven) exitosamente con SSL');
    conn.release();
  })
  .catch(err => {
    console.error('✗ Error conectando a MySQL');
    console.error('Código:', err.code);
    console.error('Mensaje:', err.message);
  });

module.exports = pool;