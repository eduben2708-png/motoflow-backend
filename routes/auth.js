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
    const telefono = normalizarTelefono(req.body.telefono);
    const { codigo } = req.body;

    if (!telefono) {
      return res.status(400).json({ error: 'Ingresá los 9 dígitos del teléfono, sin +595 ni 0 adelante' });
    }
    if (codigo !== '123456') {
      return res.status(400).json({ error: 'Código inválido' });
    }

    conn = await pool.getConnection();
    const [usuarios] = await conn.query(
      'SELECT * FROM usuarios WHERE telefono IN (?, ?, ?, ?) LIMIT 1',
      variantesTelefono(telefono)
    );

    let usuario;
    if (usuarios.length === 0) {
      // Usuario nuevo: crearlo
      const rol = telefono === '973802026' ? 'admin' : 'cliente';
      const [resultado] = await conn.query(
        'INSERT INTO usuarios (nombre, telefono, rol) VALUES (?, ?, ?)',
        [telefono, telefono, rol]
      );
      usuario = { id: resultado.insertId, telefono, rol };
    } else {
      // Usuario existente: usar sus datos
      usuario = usuarios[0];
    }

    res.json({
      success: true,
      message: 'Login exitoso',
      usuario: { id: usuario.id, telefono, rol: usuario.rol }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;