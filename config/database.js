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
    rejectUnauthorized: false
  }
});

// Crear tabla si no existe
async function inicializarBaseDeDatos() {
  try {
    const conn = await pool.getConnection();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255),
        telefono VARCHAR(50) NOT NULL,
        rol VARCHAR(50) DEFAULT 'cliente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Tabla "usuarios" creada o ya existe');
    conn.release();
  } catch (error) {
    console.error('❌ Error creando tabla:', error.message);
  }
}

// Ejecutar al iniciar
inicializarBaseDeDatos();

// Test conexión
pool.getConnection()
  .then(conn => {
    console.log('✓ Conectado a MySQL (Aiven) exitosamente con SSL');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Error conectando a MySQL');
    console.error('Código:', err.code);
    console.error('Mensaje:', err.message);
  });

module.exports = pool;