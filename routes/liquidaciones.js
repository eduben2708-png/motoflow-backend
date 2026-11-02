const express = require('express');
const router = express.Router();
const pool = require('../config/database');

const PORCENTAJE_REPARTIDOR = 0.80;

// Formas de pago válidas para la tarifa de servicio (las mismas que usa el
// panel financiero del administrador). Cualquier otro valor (o vacío) cae en
// "sin_definir" en vez de romper la cuenta.
const METODOS_PAGO_VALIDOS = ['efectivo', 'transferencia', 'qr', 'app'];

// La tarifa de servicio la puede cobrar el repartidor al vendedor (al
// retirar, si tildó esa opción al crear el pedido) o al destinatario (al
// entregar) — hay que mirar el campo correcto en cada caso, igual que en
// GET /api/pedidos/financiero.
function resolverMetodoPagoTarifa(pedido) {
  const metodo = pedido.pago_servicio_retiro ? pedido.forma_pago_servicio : pedido.tipo_pago;
  return METODOS_PAGO_VALIDOS.includes(metodo) ? metodo : 'sin_definir';
}

// Cuentas de una liquidación a partir de sus pedidos. Está separado de la consulta a la
// base para poder usar EXACTAMENTE la misma fórmula al calcular una liquidación nueva
// y al recalcular las pendientes.
// Lo que cobra JM por el servicio de un pedido: la tarifa más el recargo de centro (si lo
// tiene). Se cobra junto con la tarifa y de la misma forma, así que entra en el reparto
// 80% repartidor / 20% JM igual que la tarifa.
function servicioDe(pedido) {
  return Number(pedido.tarifa_servicio || 0) + Number(pedido.recargo_centro || 0);
}

function calcularMontos(pedidos) {
  const totalTarifas = pedidos.reduce((total, pedido) => total + servicioDe(pedido), 0);

  // Cómo se cobró cada parte de la tarifa (se muestra en la liquidación).
  const tarifasPorMetodo = { efectivo: 0, transferencia: 0, qr: 0, app: 0, sin_definir: 0 };
  pedidos.forEach(pedido => {
    const metodo = resolverMetodoPagoTarifa(pedido);
    tarifasPorMetodo[metodo] += servicioDe(pedido);
  });
  const montoRepartidor = Math.round(totalTarifas * PORCENTAJE_REPARTIDOR);
  const comisionPlataforma = totalTarifas - montoRepartidor;

  // Lo que el repartidor cobró en efectivo y NO le pertenece a él: 20% de la tarifa de esos
  // pedidos + la comisión de encargo. El monto_compra NO se toca acá: eso es simplemente
  // la devolución de lo que el repartidor ya puso de su bolsillo, no hay nada que rendir por eso.
  //
  // "Efectivo" se decide con la MISMA regla que el desglose de arriba: si el vendedor pagó la
  // tarifa al retirar, vale su forma de pago (forma_pago_servicio); si no, la del destinatario
  // al entregar (tipo_pago). Antes se miraba solo tipo_pago, y un servicio que el vendedor
  // pagó en efectivo al retirar quedaba como "no cobrado por el repartidor": la cuenta salía
  // mal y hasta cambiaba quién le debe a quién.
  const pedidosEfectivo = pedidos.filter(pedido => resolverMetodoPagoTarifa(pedido) === 'efectivo');
  const tarifaEfectivo = pedidosEfectivo.reduce((total, pedido) => total + servicioDe(pedido), 0);
  const comisionEncargoEfectivo = pedidosEfectivo.reduce((total, pedido) => total + Number(pedido.comision_encargo || 0), 0);
  const porcentajeEmpresa = 1 - PORCENTAJE_REPARTIDOR;
  const efectivoCobrado = Math.round(tarifaEfectivo * porcentajeEmpresa) + comisionEncargoEfectivo;

  // Para saber quién le debe a quién NO hay que comparar contra el 80% de TODO lo
  // facturado: en los pedidos que el repartidor cobró en efectivo, él ya se quedó con
  // su parte en el momento de cobrar, así que ahí no hay nada pendiente de pagarle.
  // Lo único que la empresa realmente le debe en plata son los pedidos que NO fueron
  // en efectivo (esos los cobró la empresa, no el repartidor).
  const tarifaNoEfectivo = totalTarifas - tarifaEfectivo;
  const montoRepartidorARendir = Math.round(tarifaNoEfectivo * PORCENTAJE_REPARTIDOR);

  const montoNeto = montoRepartidorARendir - efectivoCobrado;
  const direccionPago = montoNeto >= 0 ? 'empresa_paga' : 'repartidor_paga';

  return {
    totalTarifas,
    tarifasPorMetodo,
    montoRepartidor,
    comisionPlataforma,
    efectivoCobrado,
    montoNeto: Math.abs(montoNeto),
    direccionPago
  };
}

async function calcularResumen(conn, repartidorId, fechaDesde, fechaHasta) {
  const desdeValida = fechaDesde || '2000-01-01 00:00:00';
  const hastaValida = fechaHasta || new Date().toISOString().slice(0, 19).replace('T', ' ');

  const [pedidos] = await conn.query(
    `SELECT id, tarifa_servicio, recargo_centro, monto_compra, comision_encargo, tipo_pago,
            pago_servicio_retiro, forma_pago_servicio, fecha_creacion
     FROM pedidos
     WHERE repartidor_id = ?
       AND estado = 'entregado'
       AND liquidacion_id IS NULL
       AND fecha_creacion >= ?
       AND fecha_creacion <= ?
     ORDER BY fecha_creacion ASC`,
    [repartidorId, desdeValida, hastaValida]
  );

  const montos = calcularMontos(pedidos);

  // El período real queda definido por los pedidos encontrados: desde el más viejo sin liquidar
  // hasta el corte elegido. Así nunca queda un pedido "en el medio" sin cubrir.
  const fechaInicioReal = pedidos.length ? pedidos[0].fecha_creacion : hastaValida;

  return {
    repartidor_id: Number(repartidorId),
    fecha_inicio: fechaInicioReal,
    fecha_fin: hastaValida,
    porcentaje_repartidor: 80,
    total_servicios: pedidos.length,
    total_tarifas: montos.totalTarifas,
    tarifas_por_metodo: montos.tarifasPorMetodo,
    monto_repartidor: montos.montoRepartidor,
    comision_plataforma: montos.comisionPlataforma,
    efectivo_cobrado: montos.efectivoCobrado,
    monto_neto: montos.montoNeto,
    direccion_pago: montos.direccionPago,
    pedidos_ids: pedidos.map(pedido => pedido.id),
    pedidos: pedidos.map(pedido => ({
      id: pedido.id,
      tarifa_servicio: servicioDe(pedido),
      tipo_pago: pedido.tipo_pago,
      metodo_pago_tarifa: resolverMetodoPagoTarifa(pedido),
      fecha_creacion: pedido.fecha_creacion
    }))
  };
}

// GET /api/liquidaciones/resumen?repartidor_id=2&fecha_hasta=2026-08-10
router.get('/resumen', async (req, res) => {
  let conn;
  try {
    const { repartidor_id, fecha_desde, fecha_hasta } = req.query;
    if (!repartidor_id) return res.status(400).json({ error: 'Seleccioná un repartidor' });

    conn = await pool.getConnection();
    const resumen = await calcularResumen(conn, repartidor_id, fecha_desde, fecha_hasta);
    res.json(resumen);
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/liquidaciones/cerrar-semana - Cierre semanal masivo: calcula y crea
// la liquidación pendiente de TODOS los repartidores aprobados que tengan
// pedidos entregados sin liquidar, en un solo paso (en vez de ir uno por uno).
router.post('/cerrar-semana', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();

    const [repartidores] = await conn.query(
      `SELECT r.id, u.nombre FROM repartidores r
       JOIN usuarios u ON r.usuario_id = u.id
       WHERE r.estado_aprobacion = 'aprobado'`
    );

    const creadas = [];

    for (const repartidor of repartidores) {
      const resumen = await calcularResumen(conn, repartidor.id, null, null);
      if (resumen.total_servicios === 0) continue;

      const [resultado] = await conn.query(
        `INSERT INTO liquidaciones (
          repartidor_id, fecha_inicio, fecha_fin, total_servicios,
          total_tarifas, tarifas_por_metodo, monto_repartidor, comision_plataforma,
          efectivo_cobrado, monto_neto, direccion_pago, estado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
        [
          resumen.repartidor_id,
          resumen.fecha_inicio,
          resumen.fecha_fin,
          resumen.total_servicios,
          resumen.total_tarifas,
          JSON.stringify(resumen.tarifas_por_metodo),
          resumen.monto_repartidor,
          resumen.comision_plataforma,
          resumen.efectivo_cobrado,
          resumen.monto_neto,
          resumen.direccion_pago
        ]
      );

      await conn.query(
        'UPDATE pedidos SET liquidacion_id = ? WHERE id IN (?)',
        [resultado.insertId, resumen.pedidos_ids]
      );

      creadas.push({
        liquidacion_id: resultado.insertId,
        repartidor_id: repartidor.id,
        nombre: repartidor.nombre,
        monto_neto: resumen.monto_neto,
        direccion_pago: resumen.direccion_pago
      });
    }

    res.json({ success: true, creadas });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/liquidaciones - Listar liquidaciones creadas (opcionalmente filtradas por repartidor)
router.get('/', async (req, res) => {
  let conn;
  try {
    const { repartidor_id } = req.query;
    const condicion = repartidor_id ? 'WHERE l.repartidor_id = ?' : '';
    const valores = repartidor_id ? [repartidor_id] : [];

    conn = await pool.getConnection();
    const [liquidaciones] = await conn.query(
      `SELECT l.*, u.nombre, u.telefono
       FROM liquidaciones l
       JOIN repartidores r ON l.repartidor_id = r.id
       JOIN usuarios u ON r.usuario_id = u.id
       ${condicion}
       ORDER BY l.fecha_fin DESC, l.id DESC`,
      valores
    );

    // tarifas_por_metodo se guarda como texto (JSON) en la base; se manda
    // como objeto para que el frontend no tenga que parsearlo. Las
    // liquidaciones creadas antes de este campo existir quedan en null.
    const conTarifasParseadas = liquidaciones.map(liquidacion => ({
      ...liquidacion,
      tarifas_por_metodo: liquidacion.tarifas_por_metodo
        ? JSON.parse(liquidacion.tarifas_por_metodo)
        : null
    }));

    res.json(conTarifasParseadas);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/liquidaciones - Crear una liquidación calculada en el servidor
router.post('/', async (req, res) => {
  let conn;
  try {
    const { repartidor_id, fecha_desde, fecha_hasta } = req.body;
    if (!repartidor_id) return res.status(400).json({ error: 'Seleccioná un repartidor' });

    conn = await pool.getConnection();

    const resumen = await calcularResumen(conn, repartidor_id, fecha_desde, fecha_hasta);
    if (resumen.total_servicios === 0) {
      return res.status(400).json({ error: 'No hay pedidos pendientes de liquidar para este repartidor' });
    }

    const [resultado] = await conn.query(
      `INSERT INTO liquidaciones (
        repartidor_id, fecha_inicio, fecha_fin, total_servicios,
        total_tarifas, tarifas_por_metodo, monto_repartidor, comision_plataforma,
        efectivo_cobrado, monto_neto, direccion_pago, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
      [
        resumen.repartidor_id,
        resumen.fecha_inicio,
        resumen.fecha_fin,
        resumen.total_servicios,
        resumen.total_tarifas,
        JSON.stringify(resumen.tarifas_por_metodo),
        resumen.monto_repartidor,
        resumen.comision_plataforma,
        resumen.efectivo_cobrado,
        resumen.monto_neto,
        resumen.direccion_pago
      ]
    );

    const liquidacionId = resultado.insertId;

    // Marca cada pedido incluido con el número de esta liquidación, para que nunca
    // vuelva a contarse en una liquidación futura (ni se duplique, ni se pierda).
    await conn.query(
      'UPDATE pedidos SET liquidacion_id = ? WHERE id IN (?)',
      [liquidacionId, resumen.pedidos_ids]
    );

    res.status(201).json({ success: true, liquidacion_id: liquidacionId, resumen });
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/liquidaciones/recalcular-pendientes - Vuelve a hacer las cuentas de las
// liquidaciones que todavía están "pendiente" (nunca las pagadas ni las que tienen un
// comprobante en revisión), usando la fórmula actual. Sin { "aplicar": true } solo muestra
// cómo quedarían (vista previa) y no cambia nada. Sirve para corregir liquidaciones que se
// armaron antes de arreglar el cálculo del efectivo.
router.post('/recalcular-pendientes', async (req, res) => {
  let conn;
  try {
    const aplicar = !!(req.body && req.body.aplicar === true);
    conn = await pool.getConnection();

    const [liquidaciones] = await conn.query(
      `SELECT l.id, l.estado, l.efectivo_cobrado, l.monto_neto, l.direccion_pago, u.nombre
       FROM liquidaciones l
       JOIN repartidores r ON l.repartidor_id = r.id
       JOIN usuarios u ON r.usuario_id = u.id
       WHERE l.estado = 'pendiente'
       ORDER BY l.id ASC`
    );

    const resultado = [];
    for (const liquidacion of liquidaciones) {
      const [pedidos] = await conn.query(
        `SELECT id, tarifa_servicio, recargo_centro, comision_encargo, tipo_pago, pago_servicio_retiro, forma_pago_servicio
         FROM pedidos WHERE liquidacion_id = ?`,
        [liquidacion.id]
      );
      if (pedidos.length === 0) continue;

      const montos = calcularMontos(pedidos);
      const antes = { direccion_pago: liquidacion.direccion_pago, monto_neto: Number(liquidacion.monto_neto), efectivo_cobrado: Number(liquidacion.efectivo_cobrado) };
      const despues = { direccion_pago: montos.direccionPago, monto_neto: montos.montoNeto, efectivo_cobrado: montos.efectivoCobrado };
      const cambia = antes.direccion_pago !== despues.direccion_pago
        || antes.monto_neto !== despues.monto_neto
        || antes.efectivo_cobrado !== despues.efectivo_cobrado;

      if (aplicar && cambia) {
        await conn.query(
          `UPDATE liquidaciones
           SET tarifas_por_metodo = ?, efectivo_cobrado = ?, monto_neto = ?, direccion_pago = ?
           WHERE id = ? AND estado = 'pendiente'`,
          [JSON.stringify(montos.tarifasPorMetodo), montos.efectivoCobrado, montos.montoNeto, montos.direccionPago, liquidacion.id]
        );
      }

      resultado.push({ liquidacion_id: liquidacion.id, nombre: liquidacion.nombre, cambia, antes, despues });
    }

    res.json({
      aplicado: aplicar,
      revisadas: resultado.length,
      corregidas: resultado.filter(fila => fila.cambia).length,
      detalle: resultado
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/liquidaciones/:id/pagar - Registrar pago al repartidor
router.put('/:id/pagar', async (req, res) => {
  let conn;
  try {
    const { comprobante_transferencia } = req.body;
    if (!comprobante_transferencia || !String(comprobante_transferencia).startsWith('data:image/')) {
      return res.status(400).json({ error: 'La foto del comprobante es obligatoria' });
    }
    if (String(comprobante_transferencia).length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'La foto del comprobante es demasiado grande' });
    }
    conn = await pool.getConnection();
    const [resultado] = await conn.query(
      `UPDATE liquidaciones
       SET estado = 'pagado', comprobante_transferencia = ?, fecha_pago = NOW()
       WHERE id = ? AND estado = 'pendiente'`,
      [comprobante_transferencia || null, req.params.id]
    );

    if (!resultado.affectedRows) {
      return res.status(404).json({ error: 'Liquidación no encontrada o ya fue pagada' });
    }
    res.json({ success: true, message: 'Liquidación marcada como pagada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/liquidaciones/:id/reportar-pago - El propio repartidor avisa que ya
// pagó lo que debía y sube su comprobante. Queda "pago_reportado": todavía
// sigue bloqueado hasta que el administrador lo confirme (ver /confirmar-pago).
router.put('/:id/reportar-pago', async (req, res) => {
  let conn;
  try {
    const { comprobante_transferencia } = req.body;
    if (!comprobante_transferencia || !String(comprobante_transferencia).startsWith('data:image/')) {
      return res.status(400).json({ error: 'La foto del comprobante es obligatoria' });
    }
    if (String(comprobante_transferencia).length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'La foto del comprobante es demasiado grande' });
    }

    conn = await pool.getConnection();
    const [resultado] = await conn.query(
      `UPDATE liquidaciones
       SET estado = 'pago_reportado', comprobante_transferencia = ?
       WHERE id = ? AND direccion_pago = 'repartidor_paga' AND estado = 'pendiente'`,
      [comprobante_transferencia, req.params.id]
    );

    if (!resultado.affectedRows) {
      return res.status(404).json({ error: 'Esta liquidación no existe, ya tiene un comprobante enviado, o no corresponde que la pague el repartidor' });
    }
    res.json({ success: true, message: 'Comprobante enviado. Queda pendiente de confirmación.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/liquidaciones/:id/confirmar-pago - El administrador confirma que
// recibió la plata que el repartidor reportó como pagada. Recién acá se
// desbloquea al repartidor (ver utils/bloqueo.js).
router.put('/:id/confirmar-pago', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [resultado] = await conn.query(
      `UPDATE liquidaciones
       SET estado = 'pagado', fecha_pago = NOW()
       WHERE id = ? AND estado = 'pago_reportado'`,
      [req.params.id]
    );
    if (!resultado.affectedRows) {
      return res.status(404).json({ error: 'Esta liquidación no tiene un comprobante pendiente de confirmar' });
    }
    res.json({ success: true, message: 'Pago confirmado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/liquidaciones/:id/rechazar-pago - El administrador rechaza el
// comprobante que subió el repartidor (por ejemplo, no corresponde a esta
// deuda). Vuelve a quedar "pendiente" para que suba uno nuevo; sigue bloqueado.
router.put('/:id/rechazar-pago', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [resultado] = await conn.query(
      `UPDATE liquidaciones
       SET estado = 'pendiente', comprobante_transferencia = NULL
       WHERE id = ? AND estado = 'pago_reportado'`,
      [req.params.id]
    );
    if (!resultado.affectedRows) {
      return res.status(404).json({ error: 'Esta liquidación no tiene un comprobante pendiente de confirmar' });
    }
    res.json({ success: true, message: 'Comprobante rechazado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/liquidaciones/:id/comprobante - Adjuntar o reemplazar evidencia de pago
router.put('/:id/comprobante', async (req, res) => {
  let conn;
  try {
    const { comprobante_transferencia } = req.body;
    if (!comprobante_transferencia || !String(comprobante_transferencia).startsWith('data:image/')) {
      return res.status(400).json({ error: 'La foto del comprobante es obligatoria' });
    }
    if (String(comprobante_transferencia).length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'La foto del comprobante es demasiado grande' });
    }

    conn = await pool.getConnection();
    const [resultado] = await conn.query(
      'UPDATE liquidaciones SET comprobante_transferencia = ? WHERE id = ?',
      [comprobante_transferencia, req.params.id]
    );
    if (!resultado.affectedRows) return res.status(404).json({ error: 'Liquidación no encontrada' });
    res.json({ success: true, message: 'Comprobante guardado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
