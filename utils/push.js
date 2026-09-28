const webpush = require('web-push');
const pool = require('../config/database');

// Las claves VAPID (Voluntary Application Server Identification) le prueban
// a los servicios de push (Google, Mozilla, etc.) que quien manda la
// notificación es nuestro propio servidor. Viven en variables de entorno,
// igual que la clave de Google Maps.
let configurado = false;

function asegurarConfiguracion() {
  if (configurado) return true;

  const clavePublica = process.env.VAPID_PUBLIC_KEY;
  const clavePrivada = process.env.VAPID_PRIVATE_KEY;

  if (!clavePublica || !clavePrivada) {
    return false;
  }

  webpush.setVapidDetails(
    'mailto:contacto@jmmotocourier.com',
    clavePublica,
    clavePrivada
  );
  configurado = true;
  return true;
}

// Manda una notificación push a todos los dispositivos suscritos de un
// usuario (puede tener más de uno: por ejemplo, si reinstaló la app en el
// celular). Si un dispositivo ya no acepta pushes (410/404: el usuario
// desinstaló la app, o el navegador dio de baja la suscripción), se borra
// esa suscripción de la base para no seguir intentando en vano.
async function enviarPushAUsuario(usuarioId, payload) {
  if (!asegurarConfiguracion()) {
    console.log('⚠️ Push no configurado (faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY en el servidor): se omite el envío.');
    return;
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const [suscripciones] = await conn.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE usuario_id = ?',
      [usuarioId]
    );

    console.log(`🔔 Push: usuario ${usuarioId} tiene ${suscripciones.length} dispositivo(s) suscrito(s).`);

    for (const suscripcion of suscripciones) {
      const suscripcionPush = {
        endpoint: suscripcion.endpoint,
        keys: {
          p256dh: suscripcion.p256dh,
          auth: suscripcion.auth
        }
      };

      try {
        await webpush.sendNotification(suscripcionPush, JSON.stringify(payload));
        console.log(`✓ Push entregado al servicio de notificaciones (usuario ${usuarioId}, suscripción ${suscripcion.id}).`);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await conn.query('DELETE FROM push_subscriptions WHERE id = ?', [suscripcion.id]);
          console.log(`Suscripción ${suscripcion.id} vencida (status ${error.statusCode}): se borró de la base.`);
        } else {
          console.error(
            `Error al enviar notificación push (usuario ${usuarioId}, suscripción ${suscripcion.id}):`,
            error.statusCode, error.body || error.message
          );
        }
      }
    }
  } catch (error) {
    console.error('Error al buscar suscripciones push:', error.message);
  } finally {
    if (conn) conn.release();
  }
}

module.exports = { enviarPushAUsuario };
