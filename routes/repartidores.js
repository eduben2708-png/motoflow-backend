const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { idsRepartidoresBloqueados } = require('../utils/bloqueo');

// La foto llega desde la app ya reducida (cuadrada, ~400 px, JPEG). Acá se
// valida que realmente sea una imagen en formato data URL y que no sea
// enorme, para no llenar la base con archivos que no corresponden.
const TAMANO_MAXIMO_FOTO = 600 * 1024;
function validarFoto(foto) {
  if (foto === undefined || foto === null || foto === '') return { ok: true, valor: null };
  if (typeof foto !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(foto)) {
    return { ok: false, error: 'La foto no es una imagen válida' };
  }
  if (foto.length > TAMANO_MAXIMO_FOTO) {
    return { ok: false, error: 'La foto es demasiado grande. Probá con otra o sacala de nuevo.' };
  }
  return { ok: true, valor: foto };
}

function normalizarColor(color) {
  const limpio = String(color || '').trim().slice(0, 30);
  return limpio ? limpio.charAt(0).toUpperCase() + limpio.slice(1).toLowerCase() : null;
}

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
      `SELECT r.id, r.usuario_id, r.ci, r.placa, r.marca_moto, r.modelo_moto, r.estado_aprobacion,
              r.ubicacion_lat, r.ubicacion_lng,
              (r.gps_activo AND r.ubicacion_actualizada IS NOT NULL
               AND TIMESTAMPDIFF(SECOND, r.ubicacion_actualizada, NOW()) <= 7200) AS gps_activo,
              r.alias_bancario, r.banco,
              r.titular_cuenta, r.ci_titular, r.total_entregas, r.calificacion, r.created_at,
              TIMESTAMPDIFF(SECOND, r.ubicacion_actualizada, NOW()) AS segundos_desde_ubicacion,
              r.color_moto, (r.foto_perfil IS NOT NULL) AS tiene_foto,
              UNIX_TIMESTAMP(r.foto_actualizada) AS foto_version,
              u.nombre, u.telefono
       FROM repartidores r
       JOIN usuarios u ON r.usuario_id = u.id
       ORDER BY r.id DESC`
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

// GET /:id/foto - Entrega la foto del repartidor como imagen, para usarla en
// un <img>. Se pide aparte (y no dentro de la lista de repartidores) porque
// la lista se consulta cada pocos segundos y la foto pesa decenas de KB.
router.get('/:id/foto', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [[fila]] = await conn.query('SELECT foto_perfil FROM repartidores WHERE id = ?', [req.params.id]);
    const coincidencia = fila && fila.foto_perfil ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(fila.foto_perfil) : null;
    if (!coincidencia) return res.status(404).end();

    res.set('Content-Type', coincidencia[1]);
    // La dirección lleva "?v=" con la fecha de la foto, así que se puede
    // guardar en caché sin riesgo de mostrar una foto vieja tras cambiarla.
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(coincidencia[2], 'base64'));
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
    const colorMoto = normalizarColor(req.body.color_moto);
    const foto = validarFoto(req.body.foto);

    if (!nombre || !telefono || !ci || !placa) {
      return res.status(400).json({ error: 'Nombre, teléfono de 9 dígitos, CI y placa son obligatorios' });
    }
    if (!colorMoto) {
      return res.status(400).json({ error: 'El color de la moto es obligatorio' });
    }
    if (!foto.ok) {
      return res.status(400).json({ error: foto.error });
    }
    if (!foto.valor) {
      return res.status(400).json({ error: 'La foto del repartidor es obligatoria' });
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
        usuario_id, ci, placa, marca_moto, modelo_moto, color_moto, foto_perfil, foto_actualizada, estado_aprobacion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'pendiente')`,
      [usuarioId, ci, placa.toUpperCase(), marca_moto || null, modelo_moto || null, colorMoto, foto.valor]
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

// PUT /:id - El admin corrige el "catastro" (datos) de un repartidor ya
// registrado: nombre y teléfono viven en usuarios, CI/placa/moto en
// repartidores, así que se actualizan las dos tablas juntas.
router.put('/:id', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { nombre, ci, placa, marca_moto, modelo_moto } = req.body;
    const telefono = normalizarTelefono(req.body.telefono);
    const colorMoto = normalizarColor(req.body.color_moto);
    const foto = validarFoto(req.body.foto);

    if (!nombre || !telefono || !ci || !placa) {
      return res.status(400).json({ error: 'Nombre, teléfono de 9 dígitos, CI y placa son obligatorios' });
    }
    if (!foto.ok) {
      return res.status(400).json({ error: foto.error });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[repartidor]] = await conn.query('SELECT usuario_id FROM repartidores WHERE id = ?', [id]);
    if (!repartidor) {
      await conn.rollback();
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }

    const [telefonosEnUso] = await conn.query(
      'SELECT id FROM usuarios WHERE telefono IN (?, ?, ?, ?) AND id != ?',
      [...variantesTelefono(telefono), repartidor.usuario_id]
    );
    const [cisEnUso] = await conn.query('SELECT id FROM repartidores WHERE ci = ? AND id != ?', [ci, id]);
    const [placasEnUso] = await conn.query('SELECT id FROM repartidores WHERE placa = ? AND id != ?', [placa, id]);

    if (telefonosEnUso.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'Ese teléfono ya pertenece a otra cuenta' });
    }
    if (cisEnUso.length || placasEnUso.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'La CI o la placa ya está registrada para otro repartidor' });
    }

    await conn.query('UPDATE usuarios SET nombre = ?, telefono = ? WHERE id = ?', [nombre, telefono, repartidor.usuario_id]);
    await conn.query(
      'UPDATE repartidores SET ci = ?, placa = ?, marca_moto = ?, modelo_moto = ?, color_moto = ? WHERE id = ?',
      [ci, placa.toUpperCase(), marca_moto || null, modelo_moto || null, colorMoto, id]
    );
    // La foto solo se cambia si se mandó una nueva; si no, se conserva la actual.
    if (foto.valor) {
      await conn.query('UPDATE repartidores SET foto_perfil = ?, foto_actualizada = NOW() WHERE id = ?', [foto.valor, id]);
    }

    await conn.commit();
    res.json({ success: true });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.put('/:id/gps', async (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng, activo } = req.body;
    const conn = await pool.getConnection();
    if (activo === false) {
      // "Desconectarme": el repartidor deja de recibir pedidos al instante.
      await conn.query('UPDATE repartidores SET gps_activo = FALSE WHERE id = ?', [id]);
      conn.release();
      return res.json({ success: true, message: 'Repartidor desconectado' });
    }
    await conn.query(
      'UPDATE repartidores SET ubicacion_lat = ?, ubicacion_lng = ?, gps_activo = ?, ubicacion_actualizada = NOW() WHERE id = ?',
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