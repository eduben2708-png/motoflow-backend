const pool = require('./config/database');

async function migrar() {
  let conn;

  try {
    conn = await pool.getConnection();

    // Corrige el tipo de columna: una imagen en base64 no entra en VARCHAR(255).
    await conn.query(`
      ALTER TABLE liquidaciones
      MODIFY COLUMN comprobante_transferencia LONGTEXT NULL
    `);
    console.log('✓ comprobante_transferencia ahora es LONGTEXT (ya no se trunca).');

    // Agrega el seguimiento de efectivo cobrado por el repartidor y el neto real a liquidar.
    await conn.query(`
      ALTER TABLE liquidaciones
      ADD COLUMN efectivo_cobrado INT NOT NULL DEFAULT 0 AFTER comision_plataforma,
      ADD COLUMN monto_neto INT NOT NULL DEFAULT 0 AFTER efectivo_cobrado,
      ADD COLUMN direccion_pago ENUM('empresa_paga', 'repartidor_paga') NOT NULL DEFAULT 'empresa_paga' AFTER monto_neto
    `);
    console.log('✓ Columnas efectivo_cobrado, monto_neto y direccion_pago agregadas.');

  } catch (error) {
    console.error('Error al migrar:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrar();