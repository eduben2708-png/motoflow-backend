const pool = require('../config/database');

async function migrar() {
  let conn;

  try {
    conn = await pool.getConnection();
    await conn.query(`
      ALTER TABLE pedidos
      MODIFY COLUMN tipo_pago ENUM(
        'pendiente', 'efectivo', 'transferencia', 'qr', 'app'
      ) NOT NULL DEFAULT 'pendiente'
    `);

    console.log('Formas de pago actualizadas correctamente.');
  } catch (error) {
    console.error('Error al actualizar formas de pago:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrar();
