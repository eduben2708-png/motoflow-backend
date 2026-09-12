const express = require('express');
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
      // Usuario nuevo: crearlo
      const rol = telefono === '973802026' ? 'admin' : 'cliente';
      const [resultado] = await conn.query(
        'INSERT INTO usuarios (nombre, telefono, rol) VALUES (?, ?, ?)',
        [telefono, telefono, rol]
      );
      usuario = { id: resultado.insertId, telefono, rol };
      console.log('🆕 Usuario creado:', usuario);
    } else {
      console.log('✓ Usuario existente encontrado:', usuarios[0]);
      // Usuario existente: usar sus datos
      usuario = usuarios[0];
    }

    console.log('✓ Enviando respuesta al cliente...');
    res.json({
      success: true,
      message: 'Login exitoso',
      usuario: { id: usuario.id, telefono, rol: usuario.rol }
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

module.exports = router;