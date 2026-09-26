const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { idsRepartidoresBloqueados } = require('../utils/bloqueo');

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

router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [repartidores] = await conn.query(
      'SELECT r.*, u.nombre, u.telefono FROM repartidores r JOIN usuarios u ON r.usuario_id = u.id ORDER BY r.id DESC'
    );

    // Marca a cada repartidor si está bloqueado por no haber pagado lo que
    // debe (ver utils/bloqueo.js), para que el frontend pueda avisarle y
    // el panel del administrador lo muestre claramente.
    const bloqueados = await idsRepartidoresBloqueados(conn);
    const conEstadoBloqueo = repartidores.map(repartidor => ({
      ...repartidor,
      bloqueado: bloqueados.has(repartidor.id)
    }));

    res.json(conEstadoBloqueo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/registro', async (req, res) => {
  let conn;
  try {
    const { nombre, ci, placa, marca_moto, modelo_moto } = req.body;
    const telefono = normalizarTelefono(req.body.telefono);

    if (!nombre || !telefono || !ci || !placa) {
      return res.status(400).json({ error: 'Nombre, teléfono de 9 dígitos, CI y placa son obligatorios' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [usuariosExistentes] = await conn.query(
      'SELECT id FROM usuarios WHERE telefono IN (?, ?, ?, ?)',
      variantesTelefono(telefono)
    );
    const [cis] = await conn.query('SELECT id FROM repartidores WHERE ci = ?', [ci]);
    const [placas] = await conn.query('SELECT id FROM repartidores WHERE placa = ?', [placa]);

    if (cis.length || placas.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'La CI o la placa ya está registrada para otro repartidor' });
    }

    let usuarioId;

    if (usuariosExistentes.length) {
      // El teléfono ya tiene una cuenta (por ejemplo, alguien que ya usaba
      // la app como cliente y ahora también va a repartir). En vez de
      // rechazarlo, reutilizamos esa misma cuenta -conserva su historial y
      // sigue entrando con la contraseña que ya tenía- en lugar de exigir
      // un número distinto.
      usuarioId = usuariosExistentes[0].id;

      const [repartidorExistente] = await conn.query(
        'SELECT id FROM repartidores WHERE usuario_id = ?',
        [usuarioId]
      );
      if (repartidorExistente.length) {
        await conn.rollback();
        return res.status(409).json({ error: 'Ese número ya está registrado como repartidor' });
      }

      await conn.query('UPDATE usuarios SET nombre = ? WHERE id = ?', [nombre, usuarioId]);
    } else {
      const [usuario] = await conn.query(
        'INSERT INTO usuarios (nombre, telefono, rol) VALUES (?, ?, ?)',
        [nombre, telefono, 'repartidor']
      );
      usuarioId = usuario.insertId;
    }

    const [repartidor] = await conn.query(
      `INSERT INTO repartidores (
        usuario_id, ci, placa, marca_moto, modelo_moto, estado_aprobacion
      ) VALUES (?, ?, ?, ?, ?, 'pendiente')`,
      [usuarioId, ci, placa.toUpperCase(), marca_moto || null, modelo_moto || null]
    );

    await conn.commit();
    res.status(201).json({ success: true, repartidor_id: repartidor.insertId, estado: 'pendiente' });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/', async (req, res) => {
  try {
    const { usuario_id, ci, placa, marca_moto, modelo_moto, alias_bancario, banco, titular_cuenta, ci_titular } = req.body;
    const conn = await pool.getConnection();
    const [result] = await conn.query(
      'INSERT INTO repartidores (usuario_id, ci, placa, marca_moto, modelo_moto, alias_bancario, banco, titular_cuenta, ci_titular) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [usuario_id, ci, placa, marca_moto, modelo_moto, alias_bancario, banco, titular_cuenta, ci_titular]
    );
    conn.release();
    res.json({ success: true, repartidor_id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/gps', async (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng, activo } = req.body;
    const conn = await pool.getConnection();
    await conn.query(
      'UPDATE repartidores SET ubicacion_lat = ?, ubicacion_lng = ?, gps_activo = ? WHERE id = ?',
      [lat, lng, activo, id]
    );
    conn.release();
    res.json({ success: true, message: 'GPS actualizado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/aprobar', async (req, res) => {
  try {
    const { id } = req.params;
    const conn = await pool.getConnection();
    await conn.query('UPDATE repartidores SET estado_aprobacion = ? WHERE id = ?', ['aprobado', id]);
    conn.release();
    res.json({ success: true, message: 'Repartidor aprobado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;