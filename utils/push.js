const webpush = require('web-push');
const pool = require('../config/database');

// ---- Firebase (app Android) -------------------------------------------------
// La app Android recibe los avisos por Firebase Cloud Messaging (FCM), que despierta
// el celular con prioridad alta aunque la app esté cerrada. La clave del servicio
// vive en la variable de entorno FIREBASE_SERVICE_ACCOUNT de Render (el contenido
// del archivo JSON de la cuenta de servicio, tal cual o codificado en base64).
// Si no está configurada, o si falta el paquete "firebase-admin", se omite el envío
// por Firebase y todo lo demás sigue funcionando.
let firebaseAdmin;

function obtenerFirebase() {
  if (firebaseAdmin !== undefined) return firebaseAdmin;
  firebaseAdmin = null;

  const crudo = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!crudo) return null;

  try {
    const texto = crudo.startsWith('{') ? crudo : Buffer.from(crudo, 'base64').toString('utf8');
    const credenciales = JSON.parse(texto);
    // firebase-admin 12 o más nuevo: se usan los módulos "app" y "messaging"
    // (ya no existe admin.credential en el paquete principal).
    const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    const app = getApps().length ? getApp() : initializeApp({ credential: cert(credenciales) });
    firebaseAdmin = { messaging: () => getMessaging(app) };
    console.log('✓ Firebase listo para enviar avisos a la app Android.');
  } catch (error) {
    console.error('⚠️ No se pudo iniciar Firebase (revisá FIREBASE_SERVICE_ACCOUNT y que esté instalado firebase-admin):', error.message);
  }
  return firebaseAdmin;
}

// Manda el aviso a los celulares con la app Android instalada. Devuelve cuántos
// dispositivos tiene registrados ese usuario (aunque no se pueda enviar a todos).
async function enviarPushFirebase(conn, usuarioId, payload, resultados) {
  const [tokens] = await conn.query('SELECT id, token FROM fcm_tokens WHERE usuario_id = ?', [usuarioId]);
  if (tokens.length === 0) return 0;

  const admin = obtenerFirebase();
  if (!admin) {
    resultados.push({ ok: false, error: 'Firebase no está configurado en el servidor (FIREBASE_SERVICE_ACCOUNT)' });
    return tokens.length;
  }

  const esMensaje = payload.tipo === 'mensaje';
  console.log(`🔔 Firebase: usuario ${usuarioId} tiene ${tokens.length} celular(es) con la app Android.`);

  for (const dispositivo of tokens) {
    try {
      await admin.messaging().send({
        token: dispositivo.token,
        notification: { title: payload.titulo || 'JMMotocourier', body: payload.cuerpo || '' },
        data: {
          tipo: String(payload.tipo || 'pedido'),
          pedidoId: payload.pedidoId ? String(payload.pedidoId) : ''
        },
        android: {
          // Prioridad alta: Android despierta el celular y muestra el aviso ya mismo.
          priority: 'high',
          ttl: 300000,
          notification: {
            channelId: esMensaje ? 'mensajes' : 'pedidos',
            tag: payload.pedidoId ? (esMensaje ? 'chat-' : 'pedido-') + payload.pedidoId : 'jmmotocourier'
          }
        }
      });
      resultados.push({ dispositivo: dispositivo.id, ok: true, via: 'firebase' });
      console.log(`✓ Aviso entregado a Firebase (usuario ${usuarioId}, celular ${dispositivo.id}).`);
    } catch (error) {
      const codigo = error.code || '';
      if (codigo === 'messaging/registration-token-not-registered' || codigo === 'messaging/invalid-registration-token') {
        await conn.query('DELETE FROM fcm_tokens WHERE id = ?', [dispositivo.id]);
        resultados.push({ dispositivo: dispositivo.id, ok: false, via: 'firebase', error: 'Celular dado de baja: se borró (debe volver a abrir la app)' });
        console.log(`Celular ${dispositivo.id} dado de baja en Firebase (${codigo}): se borró de la base.`);
      } else {
        resultados.push({ dispositivo: dispositivo.id, ok: false, via: 'firebase', error: String(error.message).slice(0, 300) });
        console.error(`Error al enviar por Firebase (usuario ${usuarioId}, celular ${dispositivo.id}):`, codigo, error.message);
      }
    }
  }
  return tokens.length;
}

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
  const resultados = [];
  let conn;
  try {
    conn = await pool.getConnection();

    // Primero los celulares con la app Android (Firebase).
    let celularesAndroid = 0;
    try {
      celularesAndroid = await enviarPushFirebase(conn, usuarioId, payload, resultados);
    } catch (error) {
      // Si la tabla de Firebase todavía no existe o falla, se sigue con el push web.
      console.error('Error al enviar por Firebase:', error.message);
    }

    if (!asegurarConfiguracion()) {
      console.log('⚠️ Push web no configurado (faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY en el servidor): se omite el envío web.');
      if (celularesAndroid === 0) {
        resultados.push({ ok: false, error: 'Faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY en el servidor' });
      }
      return resultados;
    }

    const [suscripciones] = await conn.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE usuario_id = ?',
      [usuarioId]
    );

    console.log(`🔔 Push: usuario ${usuarioId} tiene ${suscripciones.length} dispositivo(s) suscrito(s).`);
    if (suscripciones.length === 0 && celularesAndroid === 0) {
      resultados.push({ ok: false, error: 'Este usuario no tiene ningún dispositivo suscrito (debe volver a entrar a la app y aceptar las notificaciones)' });
    }

    for (const suscripcion of suscripciones) {
      const suscripcionPush = {
        endpoint: suscripcion.endpoint,
        keys: {
          p256dh: suscripcion.p256dh,
          auth: suscripcion.auth
        }
      };

      try {
        // urgency: 'high' le dice a Android que despierte el celular y
        // entregue el aviso ya mismo, en vez de esperar a que salga del
        // modo de ahorro de batería (que es lo que probablemente estaba
        // pasando: el servidor mandaba bien el push, pero Android lo
        // dejaba en cola por prioridad normal). TTL de 5 minutos: con 60
        // segundos, si el celular estaba en reposo profundo o sin datos
        // justo en ese momento, el aviso se descartaba para siempre y el
        // repartidor nunca se enteraba hasta abrir la app. 5 minutos
        // alcanza para que llegue al despertar, sin ser tan largo como
        // para avisar de un pedido que ya se reasignó.
        await webpush.sendNotification(suscripcionPush, JSON.stringify(payload), {
          urgency: 'high',
          TTL: 300
        });
        resultados.push({ suscripcion: suscripcion.id, ok: true });
        console.log(`✓ Push entregado al servicio de notificaciones (usuario ${usuarioId}, suscripción ${suscripcion.id}).`);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await conn.query('DELETE FROM push_subscriptions WHERE id = ?', [suscripcion.id]);
          resultados.push({ suscripcion: suscripcion.id, ok: false, status: error.statusCode, error: 'Suscripción vencida: se borró (el repartidor debe volver a entrar a la app)' });
          console.log(`Suscripción ${suscripcion.id} vencida (status ${error.statusCode}): se borró de la base.`);
        } else {
          resultados.push({ suscripcion: suscripcion.id, ok: false, status: error.statusCode, error: String(error.body || error.message).slice(0, 300) });
          console.error(
            `Error al enviar notificación push (usuario ${usuarioId}, suscripción ${suscripcion.id}):`,
            error.statusCode, error.body || error.message
          );
        }
      }
    }
  } catch (error) {
    console.error('Error al buscar suscripciones push:', error.message);
    resultados.push({ ok: false, error: error.message });
  } finally {
    if (conn) conn.release();
  }
  return resultados;
}

module.exports = { enviarPushAUsuario };
