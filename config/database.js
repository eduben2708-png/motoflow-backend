const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function inicializarBaseDeDatos() {
  let conn;
  try {
    conn = await pool.getConnection();
    
    // Crear tabla usuarios
    await conn.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255),
        telefono VARCHAR(50) NOT NULL,
        rol VARCHAR(50) DEFAULT 'cliente',
        password_hash VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Tabla "usuarios" creada o ya existe');

    // Agrega la columna a instalaciones que ya tenían la tabla creada sin ella.
    try {
      await conn.query('ALTER TABLE usuarios ADD COLUMN password_hash VARCHAR(255) NULL');
      console.log('✓ Columna "password_hash" agregada a "usuarios"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Crear tabla repartidores
    await conn.query(`
      CREATE TABLE IF NOT EXISTS repartidores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        ci VARCHAR(50) UNIQUE NOT NULL,
        placa VARCHAR(50) UNIQUE NOT NULL,
        marca_moto VARCHAR(100),
        modelo_moto VARCHAR(100),
        estado_aprobacion VARCHAR(50) DEFAULT 'pendiente',
        ubicacion_lat DECIMAL(10, 8),
        ubicacion_lng DECIMAL(11, 8),
        gps_activo BOOLEAN DEFAULT FALSE,
        alias_bancario VARCHAR(100),
        banco VARCHAR(100),
        titular_cuenta VARCHAR(100),
        ci_titular VARCHAR(50),
        total_entregas INT DEFAULT 0,
        calificacion DECIMAL(3, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
      )
    `);
    console.log('✓ Tabla "repartidores" creada o ya existe');
  } catch (error) {
    console.error('❌ Error creando tabla:', error.message);
  } finally {
    if (conn) conn.release();
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