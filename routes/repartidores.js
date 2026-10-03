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
    // Nunca se selecciona "descriptor_facial" acá: este endpoint lo consulta
    // cualquier cuenta logueada (no solo el admin), y ese campo es el código
    // biométrico de la cara del repartidor. Solo se expone si está
    // configurado o no (tiene_verificacion_facial), nunca el valor en sí.
    const [repartidores] = await conn.query(
      `SELECT r.id, r.usuario_id, r.ci, r.placa, r.marca_moto, r.modelo_moto, r.estado_aprobacion,
              r.ubicacion_lat, r.ubicacion_lng, r.gps_activo, r.alias_bancario, r.banco,
              r.titular_cuenta, r.ci_titular, r.total_entregas, r.calificacion, r.created_at,
              (r.descriptor_facial IS NOT NULL) AS tiene_verificacion_facial,
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

// PUT /:id - El admin corrige el "catastro" (datos) de un repartidor ya
// registrado: nombre y teléfono viven en usuarios, CI/placa/moto en
// repartidores, así que se actualizan las dos tablas juntas.
router.put('/:id', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { nombre, ci, placa, marca_moto, modelo_moto } = req.body;
    const telefono = normalizarTelefono(req.body.telefono);

    if (!nombre || !telefono || !ci || !placa) {
      return res.status(400).json({ error: 'Nombre, teléfono de 9 dígitos, CI y placa son obligatorios' });
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
      'UPDATE repartidores SET ci = ?, placa = ?, marca_moto = ?, modelo_moto = ? WHERE id = ?',
      [ci, placa.toUpperCase(), marca_moto || null, modelo_moto || null, id]
    );

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

// Umbral de distancia entre dos "códigos" de cara (descriptors de 128
// números que genera face-api.js en el navegador) para considerarlos la
// misma persona. Es el valor que recomienda la propia librería.
const UMBRAL_DISTANCIA_ROSTRO = 0.6;

function descriptorValido(descriptor) {
  return Array.isArray(descriptor) && descriptor.length === 128 && descriptor.every(valor => Number.isFinite(valor));
}

function distanciaEntreDescriptores(a, b) {
  let sumaCuadrados = 0;
  for (let i = 0; i < a.length; i++) {
    const diferencia = a[i] - b[i];
    sumaCuadrados += diferencia * diferencia;
  }
  return Math.sqrt(sumaCuadrados);
}

// POST /:id/rostro - El repartidor registra su cara una sola vez (con su
// consentimiento, tildado en el frontend antes de abrir la cámara). Se
// guarda el descriptor (el "código" de 128 números), nunca la foto.
router.post('/:id/rostro', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { descriptor } = req.body;

    if (!descriptorValido(descriptor)) {
      return res.status(400).json({ error: 'La verificación facial no se generó correctamente. Probá de nuevo con buena luz, mirando de frente.' });
    }

    conn = await pool.getConnection();
    const [[repartidor]] = await conn.query('SELECT id FROM repartidores WHERE id = ?', [id]);
    if (!repartidor) {
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }

    await conn.query(
      'UPDATE repartidores SET descriptor_facial = ?, consentimiento_biometrico = TRUE, consentimiento_biometrico_fecha = NOW() WHERE id = ?',
      [JSON.stringify(descriptor), id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /:id/verificar-rostro - Se llama cada vez que el repartidor activa el
// GPS/arranca su turno: compara la selfie de ese momento (ya convertida a
// descriptor en el navegador) contra el descriptor guardado al registrarse.
// Nunca se guarda ni se devuelve la selfie ni el descriptor guardado: solo
// si coincidió o no.
router.post('/:id/verificar-rostro', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { descriptor } = req.body;

    if (!descriptorValido(descriptor)) {
      return res.status(400).json({ error: 'La verificación facial no se generó correctamente. Probá de nuevo con buena luz, mirando de frente.' });
    }

    conn = await pool.getConnection();
    const [[repartidor]] = await conn.query('SELECT descriptor_facial FROM repartidores WHERE id = ?', [id]);
    if (!repartidor) {
      return res.status(404).json({ error: 'Repartidor no encontrado' });
    }
    if (!repartidor.descriptor_facial) {
      return res.status(400).json({ error: 'Todavía no configuraste tu verificación facial.' });
    }

    const descriptorGuardado = JSON.parse(repartidor.descriptor_facial);
    const verificado = distanciaEntreDescriptores(descriptor, descriptorGuardado) < UMBRAL_DISTANCIA_ROSTRO;

    if (verificado) {
      await conn.query('UPDATE repartidores SET ultima_verificacion_facial = NOW() WHERE id = ?', [id]);
    }

    res.json({ verificado });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
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