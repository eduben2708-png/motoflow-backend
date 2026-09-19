const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../config/database');

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

// Contraseñas: scrypt + salt propio por usuario (sin dependencias externas).
// Se guarda como "salt:hash", ambos en hexadecimal.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarPassword(password, almacenado) {
  if (!almacenado || !String(almacenado).includes(':')) return false;

  const [salt, hashGuardado] = String(almacenado).split(':');
  const hashIntento = crypto.scryptSync(password, salt, 64).toString('hex');

  const bufferGuardado = Buffer.from(hashGuardado, 'hex');
  const bufferIntento = Buffer.from(hashIntento, 'hex');
  if (bufferGuardado.length !== bufferIntento.length) return false;

  return crypto.timingSafeEqual(bufferGuardado, bufferIntento);
}

// POST /api/auth/check-phone - Dice si ese teléfono ya tiene cuenta y contraseña,
// para que el frontend decida si pedir contraseña directamente o mandar un código.
router.post('/check-phone', async (req, res) => {
  let conn;
  try {
    const telefono = normalizarTelefono(req.body.telefono);
    if (!telefono) {
      return res.status(400).json({ error: 'Ingresá los 9 dígitos del teléfono, sin +595 ni 0 adelante' });
    }

    conn = await pool.getConnection();
    const [usuarios] = await conn.query(
      'SELECT id, rol, password_hash FROM usuarios WHERE telefono IN (?, ?, ?, ?) LIMIT 1',
      variantesTelefono(telefono)
    );

    if (usuarios.length === 0) {
      return res.json({ existe: false, tiene_password: false });
    }

    res.json({
      existe: true,
      rol: usuarios[0].rol,
      tiene_password: Boolean(usuarios[0].password_hash)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/auth/registrar - Crea una cuenta de cliente nueva directamente,
// sin pasar por el código de verificación (hoy es fijo, no es un SMS real).
// Se usa cuando el usuario ya sabe que no tiene cuenta y toca "Registrarme".
router.post('/registrar', async (req, res) => {
  let conn;
  try {
    const telefono = normalizarTelefono(req.body.telefono);
    const nombre = String(req.body.nombre || '').trim();
    const password = req.body.password;

    if (!telefono) {
      return res.status(400).json({ error: 'Ingresá los 9 dígitos del teléfono, sin +595 ni 0 adelante' });
    }
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    conn = await pool.getConnection();

    const [existentes] = await conn.query(
      'SELECT id FROM usuarios WHERE telefono IN (?, ?, ?, ?) LIMIT 1',
      variantesTelefono(telefono)
    );
    if (existentes.length > 0) {
      return res.status(409).json({ error: 'Ese número ya tiene una cuenta creada. Iniciá sesión.' });
    }

    const [resultado] = await conn.query(
      'INSERT INTO usuarios (nombre, telefono, rol, password_hash) VALUES (?, ?, ?, ?)',
      [nombre, telefono, 'cliente', hashPassword(String(password))]
    );

    res.json({
      success: true,
      usuario: { id: resultado.insertId, telefono, rol: 'cliente', nombre }
    });
  } catch (error) {
    console.error('❌ Error al registrar cliente:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/auth/send-code
router.post('/send-code', async (req, res) => {
  const telefono = normalizarTelefono(req.body.telefono);

  if (!telefono) {
    return res.status(400).json({ error: 'Ingresá los 9 dígitos del teléfono, sin +595 ni 0 adelante' });
  }

  console.log(`Código para +595${telefono}: 123456`);
  res.json({ success: true, message: 'Código enviado' });
});

// POST /api/auth/verify-code
// Confirma el teléfono con el código. Para clientes sin contraseña todavía
// (cuenta nueva, o recuperando el acceso) devuelve requiere_registro para que
// el frontend le pida nombre + contraseña antes de dejarlo entrar.
router.post('/verify-code', async (req, res) => {
  let conn;

  try {
    console.log('📞 VERIFY-CODE: Solicitud recibida', req.body);
    const telefono = normalizarTelefono(req.body.telefono);
    const { codigo } = req.body;
    console.log('📞 Teléfono normalizado:', telefono, '| Código:', codigo);

    if (!telefono) {
      console.log('❌ Teléfono inválido');
      return res.status(400).json({ error: 'Ingresá los 9 dígitos del teléfono, sin +595 ni 0 adelante' });
    }
    if (codigo !== '123456') {
      console.log('❌ Código inválido');
      return res.status(400).json({ error: 'Código inválido' });
    }

    console.log('✓ Conectando a base de datos...');
    conn = await pool.getConnection();
    console.log('✓ Conexión exitosa. Buscando usuario...');

    const [usuarios] = await conn.query(
      'SELECT * FROM usuarios WHERE telefono IN (?, ?, ?, ?) LIMIT 1',
      variantesTelefono(telefono)
    );

    console.log('✓ Búsqueda completada. Usuarios encontrados:', usuarios.length);

    let usuario;
    if (usuarios.length === 0) {
      console.log('🆕 Usuario nuevo. Creando...');
      const rol = telefono === '987654321' ? 'admin' : 'cliente';
      const [resultado] = await conn.query(
        'INSERT INTO usuarios (nombre, telefono, rol) VALUES (?, ?, ?)',
        [telefono, telefono, rol]
      );
      usuario = { id: resultado.insertId, telefono, rol, nombre: telefono, password_hash: null };
      console.log('🆕 Usuario creado:', usuario);
    } else {
      console.log('✓ Usuario existente encontrado:', usuarios[0]);
      usuario = usuarios[0];
    }

    // Solo los clientes necesitan contraseña. Si todavía no tiene una (cuenta
    // recién creada, o está recuperando el acceso), el frontend le pide que
    // cree/renueve nombre y contraseña antes de entrar al dashboard.
    const requiereRegistro = usuario.rol === 'cliente' && !usuario.password_hash;

    console.log('✓ Enviando respuesta al cliente...');
    res.json({
      success: true,
      message: 'Login exitoso',
      usuario: {
        id: usuario.id,
        telefono,
        rol: usuario.rol,
        nombre: usuario.nombre,
        requiere_registro: requiereRegistro
      }
    });
    console.log('✓ Respuesta enviada correctamente');

  } catch (error) {
    console.error('❌ ERROR EN VERIFY-CODE:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) {
      console.log('🔌 Liberando conexión...');
      conn.release();
    }
  }
});

// POST /api/auth/login-password - Login habitual del cliente una vez que ya
// tiene contraseña creada: teléfono + contraseña, sin pasar por el código.
router.post('/login-password', async (req, res) => {
  let conn;
  try {
    const telefono = normalizarTelefono(req.body.telefono);
    const { password } = req.body;

    if (!telefono) {
      return res.status(400).json({ error: 'Ingresá los 9 dígitos del teléfono, sin +595 ni 0 adelante' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Ingresá tu contraseña' });
    }

    conn = await pool.getConnection();
    const [usuarios] = await conn.query(
      'SELECT * FROM usuarios WHERE telefono IN (?, ?, ?, ?) LIMIT 1',
      variantesTelefono(telefono)
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ error: 'No encontramos una cuenta con ese número' });
    }

    const usuario = usuarios[0];

    if (!usuario.password_hash) {
      return res.status(400).json({ error: 'Esta cuenta todavía no tiene contraseña. Ingresá con el código de verificación.' });
    }

    if (!verificarPassword(password, usuario.password_hash)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    res.json({
      success: true,
      usuario: { id: usuario.id, telefono, rol: usuario.rol, nombre: usuario.nombre }
    });
  } catch (error) {
    console.error('❌ Error en login-password:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/auth/completar-registro - Guarda el nombre real y crea/renueva la
// contraseña del cliente (primer registro, o recuperación de contraseña).
router.put('/completar-registro', async (req, res) => {
  let conn;
  try {
    const { usuario_id, nombre, password } = req.body;
    const nombreLimpio = String(nombre || '').trim();

    if (!usuario_id) {
      return res.status(400).json({ error: 'Falta el usuario' });
    }
    if (!nombreLimpio) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    conn = await pool.getConnection();
    const [resultado] = await conn.query(
      'UPDATE usuarios SET nombre = ?, password_hash = ? WHERE id = ?',
      [nombreLimpio, hashPassword(String(password)), usuario_id]
    );

    if (!resultado.affectedRows) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ success: true, nombre: nombreLimpio });
  } catch (error) {
    console.error('❌ Error al completar registro:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/auth/cambiar-rol
router.put('/cambiar-rol', async (req, res) => {
  try {
    const { telefono, rol } = req.body;
    console.log(`Cambiando rol para ${telefono} a ${rol}`);
    const conn = await pool.getConnection();
    await conn.query('UPDATE usuarios SET rol = ? WHERE telefono = ?', [rol, telefono]);
    conn.release();
    console.log(`✓ Rol cambiado para ${telefono} a ${rol}`);
    res.json({ success: true, message: `Rol cambiado a ${rol}` });
  } catch (error) {
    console.error('❌ Error al cambiar rol:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
