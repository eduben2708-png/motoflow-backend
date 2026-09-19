// Migración: deja una sola cuenta admin con el número 973802026 y la
// contraseña 30012018. Se puede correr una sola vez (idempotente: si se
// vuelve a correr, simplemente reafirma el mismo número y contraseña).
//
// Uso: node migrar-admin-principal.js

const crypto = require('crypto');
const pool = require('./config/database');

const TELEFONO_ADMIN_NUEVO = '973802026';
const PASSWORD_ADMIN_NUEVO = '30012018';
const TELEFONO_ADMIN_ANTERIOR = '987654321';

function normalizarTelefono(telefono) {
  let numero = String(telefono || '').replace(/\D/g, '');
  if (numero.startsWith('595')) numero = numero.slice(3);
  if (numero.startsWith('0')) numero = numero.slice(1);
  return /^\d{9}$/.test(numero) ? numero : null;
}

function variantesTelefono(telefonoNormalizado) {
  return [
    telefonoNormalizado,
    `0${telefonoNormalizado}`,
    `+595${telefonoNormalizado}`,
    `595${telefonoNormalizado}`
  ];
}

// Mismo esquema que routes/auth.js: scrypt + salt propio, "salt:hash" en hex.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function migrar() {
  let conn;

  try {
    conn = await pool.getConnection();

    const telefonoNuevo = normalizarTelefono(TELEFONO_ADMIN_NUEVO);
    if (!telefonoNuevo) {
      throw new Error('El número nuevo no tiene un formato válido (9 dígitos)');
    }
    const passwordHash = hashPassword(PASSWORD_ADMIN_NUEVO);

    // 1) ¿Ya existe una cuenta con el número nuevo? La convertimos en admin
    //    con la contraseña indicada, sea cual sea su estado actual.
    const [existeNuevo] = await conn.query(
      'SELECT id FROM usuarios WHERE telefono IN (?, ?, ?, ?) LIMIT 1',
      variantesTelefono(telefonoNuevo)
    );

    if (existeNuevo.length > 0) {
      await conn.query(
        'UPDATE usuarios SET telefono = ?, rol = ?, password_hash = ? WHERE id = ?',
        [telefonoNuevo, 'admin', passwordHash, existeNuevo[0].id]
      );
      console.log(`✓ Cuenta existente (id ${existeNuevo[0].id}) actualizada: admin, número ${telefonoNuevo}, contraseña nueva.`);
      return;
    }

    // 2) Si no existe, buscamos el admin anterior (987654321) para migrarlo
    //    al número nuevo en lugar de dejar dos cuentas admin dando vueltas.
    const [existeViejo] = await conn.query(
      'SELECT id FROM usuarios WHERE telefono IN (?, ?, ?, ?) AND rol = ? LIMIT 1',
      [...variantesTelefono(normalizarTelefono(TELEFONO_ADMIN_ANTERIOR)), 'admin']
    );

    if (existeViejo.length > 0) {
      await conn.query(
        'UPDATE usuarios SET telefono = ?, password_hash = ? WHERE id = ?',
        [telefonoNuevo, passwordHash, existeViejo[0].id]
      );
      console.log(`✓ Admin (id ${existeViejo[0].id}) migrado del número anterior a ${telefonoNuevo}, con la contraseña nueva.`);
      return;
    }

    // 3) No había ningún admin todavía: creamos la cuenta de cero.
    const [resultado] = await conn.query(
      'INSERT INTO usuarios (nombre, telefono, rol, password_hash) VALUES (?, ?, ?, ?)',
      ['Admin', telefonoNuevo, 'admin', passwordHash]
    );
    console.log(`✓ Cuenta admin creada (id ${resultado.insertId}), número ${telefonoNuevo}, contraseña nueva.`);
  } catch (error) {
    console.error('❌ Error al migrar el admin:', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrar();
