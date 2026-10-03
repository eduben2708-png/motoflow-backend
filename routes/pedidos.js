const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { lunesDeEstaSemana } = require('../utils/bloqueo');
const { enviarPushAUsuario } = require('../utils/push');

// Horario de atención: fuera de estos horarios no se aceptan pedidos
// nuevos. Los pedidos que ya estaban en curso (asignados, en camino, etc.)
// siguen su trámite normal — esto solo bloquea la creación de pedidos.
const HORA_APERTURA_MINUTOS = 7 * 60 + 30; // 07:30
const HORA_CIERRE_MINUTOS = 17 * 60 + 30; // 17:30

function horaActualEnParaguay() {
  const formateador = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Asuncion',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const partes = formateador.formatToParts(new Date());
  const hora = Number(partes.find(p => p.type === 'hour').value);
  const minuto = Number(partes.find(p => p.type === 'minute').value);
  return hora * 60 + minuto;
}

function dentroDelHorarioDeServicio() {
  const minutosActuales = horaActualEnParaguay();
  return minutosActuales >= HORA_APERTURA_MINUTOS && minutosActuales < HORA_CIERRE_MINUTOS;
}

// Interruptor para activar/desactivar el bloqueo de horario sin tener que
// tocar código: mientras se están haciendo pruebas conviene poder crear
// pedidos a cualquier hora. Cuando esté todo listo para el lanzamiento,
// alcanza con agregar HORARIO_ATENCION_ACTIVO=true en las variables de
// entorno de Render (sin volver a tocar este archivo).
function horarioDeAtencionActivo() {
  return process.env.HORARIO_ATENCION_ACTIVO === 'true';
}

function calcularDetalleTarifa(distanciaKm) {
  const distancia = Number(distanciaKm);

  if (!Number.isFinite(distancia) || distancia <= 0) {
    throw new Error('La distancia debe ser un número mayor que cero');
  }

  let tarifaBase;
  let kmAdicionales = 0;
  let costoKmAdicionales = 0;

  if (distancia <= 5) tarifaBase = 20000;
  else if (distancia <= 7) tarifaBase = 25000;
  else if (distancia <= 10) tarifaBase = 30000;
  else if (distancia <= 13) tarifaBase = 40000;
  else {
    tarifaBase = 50000;
    kmAdicionales = Math.max(0, distancia - 16);
    costoKmAdicionales = Math.round(kmAdicionales * 4000);
  }

  return {
    distanciaKm: distancia,
    tarifaBase,
    kmAdicionales,
    costoKmAdicionales,
    tarifaServicio: tarifaBase + costoKmAdicionales
  };
}

// Radio máximo (en km) desde la ubicación del repartidor hasta el punto de
// retiro para que un pedido nuevo se le asigne automáticamente. Si no hay
// ningún repartidor aprobado, con GPS activo y sin bloqueo dentro de este
// radio, el pedido queda sin asignar y el administrador lo asigna a mano.
const RADIO_MAXIMO_ASIGNACION_KM = 8;

function distanciaEntrePuntosKm(lat1, lng1, lat2, lng2) {
  const radioTierraKm = 6371;
  const aRad = grados => grados * Math.PI / 180;
  const diferenciaLat = aRad(lat2 - lat1);
  const diferenciaLng = aRad(lng2 - lng1);
  const a = Math.sin(diferenciaLat / 2) ** 2 +
    Math.cos(aRad(lat1)) * Math.cos(aRad(lat2)) *
    Math.sin(diferenciaLng / 2) ** 2;

  return radioTierraKm * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Recargo por retiro en el centro de Ciudad del Este: la zona más
// comercial (cerca de Av. San Blas / Monseñor Rodríguez) tiene más
// tránsito y demora más el retiro, así que se cobra un extra fijo cuando
// el punto de retiro cae dentro de este radio. Mismo punto que ya se usa
// para priorizar resultados de búsqueda de direcciones (ver lugares.js).
const CENTRO_CDE = { lat: -25.5097, lng: -54.6111 };
const RADIO_CENTRO_KM = 1;
const RECARGO_CENTRO = 5000;

function esRetiroEnElCentro(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return distanciaEntrePuntosKm(lat, lng, CENTRO_CDE.lat, CENTRO_CDE.lng) <= RADIO_CENTRO_KM;
}

// Comisión por armar una Compra por Encargo. Se deja en 0 mientras se está
// captando clientela; toda la estructura (columna comision_encargo, fila en
// el desglose, etc.) queda intacta para poder volver a cobrar un % más
// adelante sin tener que tocar nada más que este número.
const PORCENTAJE_COMISION_ENCARGO = 0;

// GET /api/pedidos
router.get('/', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [pedidos] = await conn.query(
      `SELECT p.*, uc.nombre AS cliente_nombre, uc.telefono AS cliente_telefono
       FROM pedidos p
       LEFT JOIN usuarios uc ON p.cliente_id = uc.id`
    );
    conn.release();
    res.json(pedidos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/pedidos/historial
router.get('/historial', async (req, res) => {
  let conn;

  try {
    const { estado, fecha_desde, fecha_hasta, cliente_id, repartidor_id } = req.query;

    const condiciones = [];
    const valores = [];

    if (estado) {
      condiciones.push('estado = ?');
      valores.push(estado);
    } else {
      condiciones.push("estado IN ('entregado', 'cancelado')");
    }

    if (fecha_desde) {
      condiciones.push('fecha_creacion >= ?');
      valores.push(`${fecha_desde} 00:00:00`);
    }

    if (fecha_hasta) {
      condiciones.push('fecha_creacion <= ?');
      valores.push(`${fecha_hasta} 23:59:59`);
    }

    if (cliente_id) {
      condiciones.push('cliente_id = ?');
      valores.push(cliente_id);
    }

    if (repartidor_id) {
      condiciones.push('repartidor_id = ?');
      valores.push(repartidor_id);
    }

    const whereClause = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';

    conn = await pool.getConnection();
    const [pedidos] = await conn.query(
      `SELECT p.*, uc.nombre AS cliente_nombre, uc.telefono AS cliente_telefono
       FROM pedidos p
       LEFT JOIN usuarios uc ON p.cliente_id = uc.id
       ${whereClause} ORDER BY p.fecha_creacion DESC`,
      valores
    );

    res.json(pedidos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/pedidos/financiero - Cuánto cobró realmente JMMotocourier (su
// propia tarifa de servicio, NO el monto_compra que es plata de paso del
// vendedor), agrupado por forma de pago, más el historial de pedidos que
// componen cada total. Solo cuenta pedidos "entregado": es plata que ya se
// cobró de verdad, no la que todavía está en camino.
router.get('/financiero', async (req, res) => {
  let conn;
  try {
    const { fecha_desde, fecha_hasta } = req.query;

    const condiciones = ["p.estado = 'entregado'"];
    const valores = [];

    if (fecha_desde) {
      condiciones.push('p.fecha_creacion >= ?');
      valores.push(`${fecha_desde} 00:00:00`);
    }
    if (fecha_hasta) {
      condiciones.push('p.fecha_creacion <= ?');
      valores.push(`${fecha_hasta} 23:59:59`);
    }

    conn = await pool.getConnection();
    const [pedidos] = await conn.query(
      `SELECT p.id, p.fecha_creacion, p.tipo, p.tarifa_servicio, p.recargo_centro, p.comision_encargo,
              p.pago_servicio_retiro, p.tipo_pago, p.forma_pago_servicio, p.repartidor_id,
              uc.nombre AS cliente_nombre
       FROM pedidos p
       LEFT JOIN usuarios uc ON p.cliente_id = uc.id
       WHERE ${condiciones.join(' AND ')}
       ORDER BY p.fecha_creacion DESC`,
      valores
    );

    const METODOS_VALIDOS = ['efectivo', 'transferencia', 'qr', 'app'];
    const totalesPorMetodo = { efectivo: 0, transferencia: 0, qr: 0, app: 0, sin_definir: 0 };

    const historial = pedidos.map(pedido => {
      const montoServicio = Number(pedido.tarifa_servicio || 0)
        + Number(pedido.recargo_centro || 0)
        + Number(pedido.comision_encargo || 0);

      // La tarifa de JMMotocourier la cobra el repartidor al vendedor (al
      // retirar, si tildó esa opción) o al destinatario (al entregar). Hay
      // que fijarse en el campo correcto según cuál de los dos pasó.
      let metodoPago = pedido.pago_servicio_retiro ? pedido.forma_pago_servicio : pedido.tipo_pago;
      if (!METODOS_VALIDOS.includes(metodoPago)) metodoPago = 'sin_definir';

      totalesPorMetodo[metodoPago] += montoServicio;

      return {
        id: pedido.id,
        fecha_creacion: pedido.fecha_creacion,
        tipo: pedido.tipo,
        monto_servicio: montoServicio,
        metodo_pago: metodoPago,
        cliente_nombre: pedido.cliente_nombre,
        repartidor_id: pedido.repartidor_id
      };
    });

    const totalGeneral = Object.values(totalesPorMetodo).reduce((suma, valor) => suma + valor, 0);

    res.json({ totalGeneral, totalesPorMetodo, historial });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/pedidos
router.post('/', async (req, res) => {
  let conn;

  try {
    // Se valida el horario ANTES que cualquier otra cosa: no tiene sentido
    // seguir calculando tarifas si de entrada no se va a aceptar el pedido.
    // Mientras HORARIO_ATENCION_ACTIVO no esté en "true" en Render, este
    // bloqueo queda desactivado (para poder probar a cualquier hora).
    if (horarioDeAtencionActivo() && !dentroDelHorarioDeServicio()) {
      return res.status(403).json({
        error: 'Fuera de horario de atención: el servicio funciona de 07:30 a 17:30 hs.'
      });
    }

    const {
      cliente_id, tipo, origen_direccion, destino_direccion,
      origen_nombre, destino_nombre, // Se agregan nombres/referencias comerciales opcionales
      distancia_km, monto_compra,
      origen_lat, origen_lng, destino_lat, destino_lng,
      telefono_destinatario, pago_servicio_retiro
    } = req.body;

    // El vendedor tilda esto cuando ya arregla el pago del servicio
    // directo con el repartidor al momento del retiro (por ejemplo, en
    // mano), y por lo tanto el repartidor NO debe cobrarle esa parte al
    // destinatario cuando entrega. La forma de pago de ese cobro la carga
    // el repartidor recién al marcar "Paquete retirado" (ver PUT /:id).
    const pagoServicioRetiro = pago_servicio_retiro === true || pago_servicio_retiro === 'true';

    // Teléfono opcional de quien recibe el pedido (lo carga el vendedor a
    // partir del contacto que le pasó su propio cliente), para que el
    // repartidor pueda llamarlo con un toque si no encuentra la dirección.
    const telefonoDestinatario = String(telefono_destinatario || '').replace(/\D/g, '').slice(0, 20) || null;

    if (!['delivery', 'retiro', 'encargo'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de servicio inválido' });
    }

    const detalleTarifa = calcularDetalleTarifa(distancia_km);
    const montoCompra = tipo === 'encargo' ? Math.round(Number(monto_compra) || 0) : 0;
    const origenLat = Number(origen_lat);
    const origenLng = Number(origen_lng);
    const destinoLat = Number(destino_lat);
    const destinoLng = Number(destino_lng);

    if (![origenLat, origenLng, destinoLat, destinoLng].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Marcá el punto de retiro y el punto de entrega en el mapa' });
    }

    if (tipo === 'encargo' && montoCompra <= 0) {
      return res.status(400).json({ error: 'El monto de compra es obligatorio para un encargo' });
    }

    const comisionEncargo = tipo === 'encargo' ? Math.round(montoCompra * PORCENTAJE_COMISION_ENCARGO) : 0;
    const recargoCentro = esRetiroEnElCentro(origenLat, origenLng) ? RECARGO_CENTRO : 0;
    const montoTotal = detalleTarifa.tarifaServicio + montoCompra + comisionEncargo + recargoCentro;

    conn = await pool.getConnection();

    // Guardamos las direcciones completas con el nombre del negocio si fue ingresado
    const dirOrigenFinal = origen_nombre ? `${origen_nombre} (${origen_direccion || ''})` : origen_direccion;
    const dirDestinoFinal = destino_nombre ? `${destino_nombre} (${destino_direccion || ''})` : destino_direccion;

    const [result] = await conn.query(
      `INSERT INTO pedidos (
        cliente_id, tipo, origen_direccion, destino_direccion,
        origen_lat, origen_lng, destino_lat, destino_lng, monto, tipo_pago,
        distancia_km, tarifa_base, km_adicionales, costo_km_adicionales,
        monto_compra, comision_encargo, tarifa_servicio, estado, telefono_destinatario,
        recargo_centro, pago_servicio_retiro
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cliente_id, tipo, dirOrigenFinal, dirDestinoFinal,
        origenLat, origenLng, destinoLat, destinoLng, montoTotal, 'pendiente',
        detalleTarifa.distanciaKm, detalleTarifa.tarifaBase, detalleTarifa.kmAdicionales,
        detalleTarifa.costoKmAdicionales, montoCompra, comisionEncargo,
        detalleTarifa.tarifaServicio, 'pendiente', telefonoDestinatario,
        recargoCentro, pagoServicioRetiro
      ]
    );

    // Asigna automáticamente el repartidor aprobado y con GPS activo más cercano al retiro
    const MAX_PEDIDOS_ACTIVOS_POR_REPARTIDOR = 3;

    const [repartidoresDisponibles] = await conn.query(
      `SELECT r.id, r.usuario_id, r.ubicacion_lat, r.ubicacion_lng
       FROM repartidores r
       WHERE r.estado_aprobacion = 'aprobado'
         AND r.gps_activo = TRUE
         AND r.ubicacion_lat IS NOT NULL
         AND r.ubicacion_lng IS NOT NULL
         AND (
           SELECT COUNT(*) FROM pedidos p
           WHERE p.repartidor_id = r.id
             AND p.estado IN ('asignado', 'en_retiro', 'en_camino')
         ) < ?
         AND NOT EXISTS (
           SELECT 1 FROM liquidaciones l
           WHERE l.repartidor_id = r.id
             AND l.direccion_pago = 'repartidor_paga'
             AND l.estado != 'pagado'
             AND l.fecha_fin < ?
         )`,
      [MAX_PEDIDOS_ACTIVOS_POR_REPARTIDOR, lunesDeEstaSemana()]
    );

    let repartidorAsignado = null;

    if (Number.isFinite(origenLat) && Number.isFinite(origenLng) && repartidoresDisponibles.length > 0) {
      repartidorAsignado = repartidoresDisponibles
        .map(repartidor => ({
          ...repartidor,
          distanciaKm: distanciaEntrePuntosKm(
            origenLat,
            origenLng,
            Number(repartidor.ubicacion_lat),
            Number(repartidor.ubicacion_lng)
          )
        }))
        // Solo se asignan automáticamente los repartidores que están dentro
        // del radio de retiro permitido. Los que están más lejos no reciben
        // este pedido (aunque estén disponibles).
        .filter(repartidor => repartidor.distanciaKm <= RADIO_MAXIMO_ASIGNACION_KM)
        .sort((a, b) => a.distanciaKm - b.distanciaKm)[0] || null;

      // Puede que haya repartidores disponibles pero que ninguno esté dentro
      // del radio permitido: en ese caso el pedido queda sin asignar, igual
      // que cuando no hay repartidores disponibles.
      if (repartidorAsignado) {
        await conn.query(
          'UPDATE pedidos SET repartidor_id = ?, estado = ? WHERE id = ?',
          [repartidorAsignado.id, 'asignado', result.insertId]
        );

        // No se espera la respuesta del push para no demorarle la
        // confirmación del pedido al cliente que lo está creando.
        enviarPushAUsuario(repartidorAsignado.usuario_id, {
          titulo: 'JMMotocourier',
          cuerpo: `¡Nuevo pedido asignado! Pedido #${result.insertId}.`,
          pedidoId: result.insertId
        }).catch(error => console.error('Error al enviar push de asignación automática:', error.message));
      }
    }

    res.json({
      id: result.insertId,
      monto_total: montoTotal,
      ...detalleTarifa,
      montoCompra,
      comisionEncargo,
      recargoCentro,
      pagoServicioRetiro,
      repartidor_id: repartidorAsignado?.id || null,
      distancia_repartidor_km: repartidorAsignado ? Number(repartidorAsignado.distanciaKm.toFixed(2)) : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/pedidos/:id
router.put('/:id', async (req, res) => {
  let conn;

  try {
    const { id } = req.params;
    const { estado, repartidor_id, tipo_pago, forma_pago_servicio } = req.body;

    if (!['pendiente', 'asignado', 'en_retiro', 'en_camino', 'entregado', 'cancelado'].includes(estado)) {
      return res.status(400).json({ error: 'Estado de pedido inválido' });
    }

    conn = await pool.getConnection();

    if (tipo_pago !== undefined && !['efectivo', 'transferencia', 'qr', 'app', 'pendiente'].includes(tipo_pago)) {
      return res.status(400).json({ error: 'Forma de pago inválida' });
    }

    if (forma_pago_servicio !== undefined && forma_pago_servicio !== null && forma_pago_servicio !== '' &&
        !['efectivo', 'transferencia', 'qr'].includes(forma_pago_servicio)) {
      return res.status(400).json({ error: 'Forma de pago del servicio inválida' });
    }

    const tieneRepartidor = repartidor_id !== undefined && repartidor_id !== null && repartidor_id !== '';
    const tienePago = tipo_pago !== undefined && tipo_pago !== null && tipo_pago !== '';
    const tieneFormaPagoServicio = forma_pago_servicio !== undefined && forma_pago_servicio !== null && forma_pago_servicio !== '';

    // Se arma el UPDATE con solo los campos que vinieron, en vez de un
    // if/else por cada combinación posible (con 3 campos opcionales ya
    // serían 8 casos): más fácil de leer y de sumarle un campo más adelante.
    const camposActualizar = ['estado = ?'];
    const valoresActualizar = [estado];

    if (tieneRepartidor) {
      camposActualizar.push('repartidor_id = ?');
      valoresActualizar.push(repartidor_id);
    }
    if (tienePago) {
      camposActualizar.push('tipo_pago = ?');
      valoresActualizar.push(tipo_pago);
    }
    if (tieneFormaPagoServicio) {
      camposActualizar.push('forma_pago_servicio = ?');
      valoresActualizar.push(forma_pago_servicio);
    }

    valoresActualizar.push(id);
    await conn.query(`UPDATE pedidos SET ${camposActualizar.join(', ')} WHERE id = ?`, valoresActualizar);

    if (repartidor_id && estado === 'asignado') {
      console.log(`🔔 NOTIFICACIÓN: Pedido #${id} asignado a repartidor ${repartidor_id}`);

      // Asignación manual desde el panel del administrador: también dispara
      // el push, igual que la asignación automática al crear el pedido.
      const [[repartidorInfo]] = await conn.query('SELECT usuario_id FROM repartidores WHERE id = ?', [repartidor_id]);
      if (repartidorInfo) {
        enviarPushAUsuario(repartidorInfo.usuario_id, {
          titulo: 'JMMotocourier',
          cuerpo: `¡Nuevo pedido asignado! Pedido #${id}.`,
          pedidoId: id
        }).catch(error => console.error('Error al enviar push de asignación manual:', error.message));
      }
    }

    res.json({ success: true, message: 'Pedido actualizado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/pedidos/:id/mensajes
router.get('/:id/mensajes', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    conn = await pool.getConnection();
    const [mensajes] = await conn.query(
      `SELECT m.id, m.usuario_id, m.mensaje, m.created_at, u.nombre AS usuario_nombre
       FROM mensajes m
       LEFT JOIN usuarios u ON m.usuario_id = u.id
       WHERE m.pedido_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
      [id]
    );

    res.json(mensajes.map(m => ({
      id: m.id,
      usuario_id: m.usuario_id,
      usuario_nombre: m.usuario_nombre,
      mensaje: m.mensaje,
      timestamp: new Date(m.created_at).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' })
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/pedidos/:id/mensajes
router.post('/:id/mensajes', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { usuario_id, mensaje } = req.body;
    const texto = String(mensaje || '').trim();

    if (!usuario_id) return res.status(400).json({ error: 'Falta identificar al usuario' });
    if (!texto) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });

    conn = await pool.getConnection();

    // Una vez que el pedido se entrega (o se cancela) ya no tiene sentido que
    // cliente y repartidor sigan escribiéndose. Este chequeo es la barrera
    // real: el botón de chat se oculta en el frontend, pero esto evita que
    // alguien mande el mensaje pegándole directo a la API.
    const [[pedido]] = await conn.query('SELECT estado FROM pedidos WHERE id = ?', [id]);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    if (['entregado', 'cancelado'].includes(pedido.estado)) {
      return res.status(403).json({ error: 'Este pedido ya fue entregado: el chat quedó cerrado.' });
    }

    const [resultado] = await conn.query(
      'INSERT INTO mensajes (pedido_id, usuario_id, mensaje) VALUES (?, ?, ?)',
      [id, usuario_id, texto]
    );
    const [[usuario]] = await conn.query('SELECT nombre FROM usuarios WHERE id = ?', [usuario_id]);

    console.log(`💬 Mensaje en pedido #${id}: ${texto}`);

    res.json({
      id: resultado.insertId,
      usuario_id,
      usuario_nombre: usuario?.nombre || null,
      mensaje: texto,
      timestamp: new Date().toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// PUT /api/pedidos/:id/calificacion
// El cliente que hizo el pedido califica al repartidor de 1 a 5 estrellas
// una vez entregado. Se guarda por pedido y además se recalcula el promedio
// del repartidor (repartidores.calificacion), que ya se muestra en el panel
// de admin y en el propio panel del repartidor.
router.put('/:id/calificacion', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const calificacion = Number(req.body.calificacion);

    if (!Number.isInteger(calificacion) || calificacion < 1 || calificacion > 5) {
      return res.status(400).json({ error: 'La calificación debe ser un número entero de 1 a 5.' });
    }

    conn = await pool.getConnection();

    const [[pedido]] = await conn.query('SELECT estado, repartidor_id, calificacion_repartidor FROM pedidos WHERE id = ?', [id]);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    if (pedido.estado !== 'entregado') {
      return res.status(400).json({ error: 'Solo se puede calificar un pedido que ya fue entregado.' });
    }
    if (!pedido.repartidor_id) {
      return res.status(400).json({ error: 'Este pedido no tiene un repartidor asignado.' });
    }
    if (pedido.calificacion_repartidor) {
      return res.status(400).json({ error: 'Este pedido ya fue calificado.' });
    }

    await conn.query('UPDATE pedidos SET calificacion_repartidor = ? WHERE id = ?', [calificacion, id]);

    // Promedio de todas las calificaciones que tiene ese repartidor hasta ahora.
    const [[{ promedio }]] = await conn.query(
      'SELECT AVG(calificacion_repartidor) AS promedio FROM pedidos WHERE repartidor_id = ? AND calificacion_repartidor IS NOT NULL',
      [pedido.repartidor_id]
    );
    await conn.query('UPDATE repartidores SET calificacion = ? WHERE id = ?', [promedio, pedido.repartidor_id]);

    res.json({ success: true, calificacion, promedioRepartidor: Number(promedio) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;