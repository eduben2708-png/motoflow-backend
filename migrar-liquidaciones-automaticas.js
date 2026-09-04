const express = require('express');
const router = express.Router();
const pool = require('../config/database');

const PORCENTAJE_REPARTIDOR = 0.80;

function validarFechas(fechaInicio, fechaFin) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin || '')) {
    throw new Error('Las fechas deben tener formato AAAA-MM-DD');
  }
  if (fechaInicio > fechaFin) throw new Error('La fecha inicial no puede ser mayor que la final');
}

async function calcularResumen(conn, repartidorId, fechaInicio, fechaFin) {
  validarFechas(fechaInicio, fechaFin);

  const [pedidos] = await conn.query(
    `SELECT id, tarifa_servicio, monto_compra, comision_encargo, tipo_pago, fecha_entregado
     FROM pedidos
     WHERE repartidor_id = ?
       AND estado = 'entregado'
       AND DATE(fecha_entregado) BETWEEN ? AND ?
     ORDER BY fecha_entregado ASC`,
    [repartidorId, fechaInicio, fechaFin]
  );

  const totalTarifas = pedidos.reduce((total, pedido) => total + Number(pedido.tarifa_servicio || 0), 0);
  const montoRepartidor = Math.round(totalTarifas * PORCENTAJE_REPARTIDOR);
  const comisionPlataforma = totalTarifas - montoRepartidor;

  return {
    repartidor_id: Number(repartidorId),
    fecha_inicio: fechaInicio,
    fecha_fin: fechaFin,
    porcentaje_repartidor: 80,
    total_servicios: pedidos.length,
    total_tarifas: totalTarifas,
    monto_repartidor: montoRepartidor,
    comision_plataforma: comisionPlataforma,
    pedidos: pedidos.map(pedido => ({
      id: pedido.id,
      tarifa_servicio: Number(pedido.tarifa_servicio || 0),
      tipo_pago: pedido.tipo_pago,
      fecha_entregado: pedido.fecha_entregado
    }))
  };
}

// GET /api/liquidaciones/resumen?repartidor_id=2&fecha_inicio=2026-08-01&fecha_fin=2026-08-07
router.get('/resumen', async (req, res) => {
  let conn;
  try {
    const { repartidor_id, fecha_inicio, fecha_fin } = req.query;
    if (!repartidor_id) return res.status(400).json({ error: 'Seleccioná un repartidor' });

    conn = await pool.getConnection();
    const resumen = await calcularResumen(conn, repartidor_id, fecha_inicio, fecha_fin);
    res.json(resumen);
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/liquidaciones - Listar liquidaciones creadas
router.get('/', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [liquidaciones] = await conn.query(
      `SELECT l.*, u.nombre, u.telefono
       FROM liquidaciones l
       JOIN repartidores r ON l.repartidor_id = r.id
       JOIN usuarios u ON r.usuario_id = u.id
       ORDER BY l.fecha_fin DESC, l.id DESC`
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
    const { repartidor_id, fecha_inicio, fecha_fin } = req.body;
    if (!repartidor_id) return res.status(400).json({ error: 'Seleccioná un repartidor' });

    conn = await pool.getConnection();
    const [existentes] = await conn.query(
      `SELECT id FROM liquidaciones
       WHERE repartidor_id = ? AND fecha_inicio = ? AND fecha_fin = ?`,
      [repartidor_id, fecha_inicio, fecha_fin]
    );
    if (existentes.length) {
      return res.status(409).json({ error: 'Ya existe una liquidación para ese repartidor y período' });
    }

    const resumen = await calcularResumen(conn, repartidor_id, fecha_inicio, fecha_fin);
    if (resumen.total_servicios === 0) {
      return res.status(400).json({ error: 'No hay pedidos entregados en ese período' });
    }

    const [resultado] = await conn.query(
      `INSERT INTO liquidaciones (
        repartidor_id, fecha_inicio, fecha_fin, total_servicios,
        total_tarifas, monto_repartidor, comision_plataforma, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
      [
        resumen.repartidor_id,
        resumen.fecha_inicio,
        resumen.fecha_fin,
        resumen.total_servicios,
        resumen.total_tarifas,
        resumen.monto_repartidor,
        resumen.comision_plataforma
      ]
    );

    res.status(201).json({ success: true, liquidacion_id: resultado.insertId, resumen });
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
