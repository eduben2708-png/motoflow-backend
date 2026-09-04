const pool = require('./config/database');

async function verificar() {
  let conn;

  try {
    conn = await pool.getConnection();
    const [columnas] = await conn.query('DESCRIBE pedidos');

    console.log('--- COLUMNAS DE LA TABLA pedidos ---');
    columnas.forEach(col => {
      console.log(`${col.Field} | tipo: ${col.Type} | default: ${col.Default}`);
    });
  } catch (error) {
    console.error('Error al verificar estructura:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

verificar();