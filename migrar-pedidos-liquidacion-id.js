const pool = require('./config/database');

async function migrar() {
  let conn;

  try {
    conn = await pool.getConnection();

    await conn.query(`
      ALTER TABLE pedidos
      ADD COLUMN liquidacion_id INT NULL DEFAULT NULL,
      ADD INDEX idx_liquidacion_id (liquidacion_id)
    `);

    console.log('✓ Columna liquidacion_id agregada a pedidos.');
  } catch (error) {
    console.error('Error al migrar:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrar();
