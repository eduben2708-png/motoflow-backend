const pool = require('./config/database');

async function migrar() {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`
      ALTER TABLE pedidos
        ADD COLUMN origen_lat DECIMAL(10,8) NULL AFTER destino_direccion,
        ADD COLUMN origen_lng DECIMAL(11,8) NULL AFTER origen_lat,
        ADD COLUMN destino_lat DECIMAL(10,8) NULL AFTER origen_lng,
        ADD COLUMN destino_lng DECIMAL(11,8) NULL AFTER destino_lat
    `);
    console.log('✓ Coordenadas de retiro y entrega agregadas a pedidos.');
  } catch (error) {
    console.error('Error al migrar:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrar();
