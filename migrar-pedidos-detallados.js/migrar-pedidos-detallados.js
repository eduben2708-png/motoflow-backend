const pool = require('../config/database');

const columnas = [
  ['distancia_km', 'DECIMAL(8,2) NULL AFTER monto'],
  ['tarifa_base', 'INT NOT NULL DEFAULT 0 AFTER distancia_km'],
  ['km_adicionales', 'DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER tarifa_base'],
  ['costo_km_adicionales', 'INT NOT NULL DEFAULT 0 AFTER km_adicionales'],
  ['monto_compra', 'INT NOT NULL DEFAULT 0 AFTER costo_km_adicionales'],
  ['comision_encargo', 'INT NOT NULL DEFAULT 0 AFTER monto_compra'],
  ['tarifa_servicio', 'INT NOT NULL DEFAULT 0 AFTER comision_encargo']
];

async function migrar() {
  let conn;

  try {
    conn = await pool.getConnection();

    for (const [nombre, definicion] of columnas) {
      const [existente] = await conn.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedidos' AND COLUMN_NAME = ?`,
        [nombre]
      );

      if (existente.length === 0) {
        await conn.query(`ALTER TABLE pedidos ADD COLUMN ${nombre} ${definicion}`);
        console.log(`Columna agregada: ${nombre}`);
      } else {
        console.log(`Columna ya existente: ${nombre}`);
      }
    }

    console.log('Migración completada correctamente.');
  } catch (error) {
    console.error('Error en la migración:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrar();
