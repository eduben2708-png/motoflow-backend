const pool = require('./config/database');

async function migrar() {
  let conn;

  try {
    conn = await pool.getConnection();
    await conn.query(`
      ALTER TABLE pedidos
      MODIFY COLUMN estado ENUM(
        'pendiente', 'asignado', 'en_retiro', 'en_camino', 'entregado', 'cancelado'
      ) NOT NULL DEFAULT 'pendiente'
    `);

    console.log('Estado de retiro agregado correctamente.');
  } catch (error) {
    console.error('Error al actualizar estados:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrar();
