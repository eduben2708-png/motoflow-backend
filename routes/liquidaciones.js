const express = require('express');
const router = express.Router();
const pool = require('../config/database');

const PORCENTAJE_REPARTIDOR = 0.80;

async function calcularResumen(conn, repartidorId, fechaHasta) {
  const hastaValida = fechaHasta || new Date().toISOString().slice(0, 19).replace('T', ' ');

  const [pedidos] = await conn.query(
    `SELECT id, tarifa_servicio, monto_compra, comision_encargo, tipo_pago, fecha_entregado
     FROM pedidos
     WHERE repartidor_id = ?
       AND estado = 'entregado'
       AND liquidacion_id IS NULL
       AND fecha_entregado <= ?
     ORDER BY fecha_entregado ASC`,
    [repartidorId, hastaValida]
  );

  const totalTarifas = pedidos.reduce((total, pedido) => total + Number(pedido.tarifa_servicio || 0), 0);
  const montoRepartidor = Math.round(totalTarifas * PORCENTAJE_REPARTIDOR);
  const comisionPlataforma = totalTarifas - montoRepartidor;

  // Lo que el repartidor cobró en efectivo y NO le pertenece a él: 20% de la tarifa de esos
  // pedidos + la comisión de encargo. El monto_compra NO se toca acá: eso es simplemente
  // la devolución de lo que el repartidor ya puso de su bolsillo, no hay nada que rendir por eso.
  const pedidosEfectivo = pedidos.filter(pedido => pedido.tipo_pago === 'efectivo');
  const tarifaEfectivo = pedidosEfectivo.reduce((total, pedido) => total + Number(pedido.tarifa_servicio || 0), 0);
  const comisionEncargoEfectivo = pedidosEfectivo.reduce((total, pedido) => total + Number(pedido.comision_encargo || 0), 0);
  const porcentajeEmpresa = 1 - PORCENTAJE_REPARTIDOR;
  const efectivoCobrado = Math.round(tarifaEfectivo * porcentajeEmpresa) + comisionEncargoEfectivo;

  const montoNeto = montoRepartidor - efectivoCobrado;
  const direccionPago = montoNeto >= 0 ? 'empresa_paga' : 'repartidor_paga';

  // El período real queda definido por los pedidos encontrados: desde el más viejo sin liquidar
  // hasta el corte elegido. Así nunca queda un pedido "en el medio" sin cubrir.
  const fechaInicioReal = pedidos.length ? pedidos[0].fecha_entregado : hastaValida;

  return {
    repartidor_id: Number(repartidorId),
    fecha_inicio: fechaInicioReal,
    fecha_fin: hastaValida,
    porcentaje_repartidor: 80,
    total_servicios: pedidos.length,
    total_tarifas: totalTarifas,
    monto_repartidor: montoRepartidor,
    comision_plataforma: comisionPlataforma,
    efectivo_cobrado: efectivoCobrado,
    monto_neto: Math.abs(montoNeto),
    direccion_pago: direccionPago,
    pedidos_ids: pedidos.map(pedido => pedido.id),
    pedidos: pedidos.map(pedido => ({
      id: pedido.id,
      tarifa_servicio: Number(pedido.tarifa_servicio || 0),
      tipo_pago: pedido.tipo_pago,
      fecha_entregado: pedido.fecha_entregado
    }))
  };
}

// GET /api/liquidaciones/resumen?repartidor_id=2&fecha_hasta=2026-08-10
router.get('/resumen', async (req, res) => {
  let conn;
  try {
    const { repartidor_id, fecha_hasta } = req.query;
    if (!repartidor_id) return res.status(400).json({ error: 'Seleccioná un repartidor' });

    conn = await pool.getConnection();
    const resumen = await calcularResumen(conn, repartidor_id, fecha_hasta);
    res.json(resumen);
  } catch (error) {
    res.status(400).json({ error: error.message });
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
    res.json(liquidaciones);
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
    const { repartidor_id, fecha_hasta } = req.body;
    if (!repartidor_id) return res.status(400).json({ error: 'Seleccioná un repartidor' });

    conn = await pool.getConnection();

    const resumen = await calcularResumen(conn, repartidor_id, fecha_hasta);
    if (resumen.total_servicios === 0) {
      return res.status(400).json({ error: 'No hay pedidos pendientes de liquidar para este repartidor' });
    }

    const [resultado] = await conn.query(
      `INSERT INTO liquidaciones (
        repartidor_id, fecha_inicio, fecha_fin, total_servicios,
        total_tarifas, monto_repartidor, comision_plataforma,
        efectivo_cobrado, monto_neto, direccion_pago, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
      [
        resumen.repartidor_id,
        resumen.fecha_inicio,
        resumen.fecha_fin,
        resumen.total_servicios,
        resumen.total_tarifas,
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