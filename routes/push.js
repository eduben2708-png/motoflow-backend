const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { enviarPushAUsuario } = require('../utils/push');

// GET /vapid-public-key - Le da al frontend la clave pública VAPID para que
// arme la suscripción push. Así, si algún día hay que rotar las claves, no
// hace falta tocar el HTML: solo cambiar la variable de entorno en Render.
router.get('/vapid-public-key', (req, res) => {
  const clave = process.env.VAPID_PUBLIC_KEY;
  if (!clave) {
    return res.status(500).json({ error: 'Las notificaciones push no están configuradas en el servidor.' });
  }
  res.json({ publicKey: clave });
});

// POST /suscribir - Guarda (o actualiza) la suscripción push de un
// dispositivo para un repartidor. Se guarda por "endpoint" (que identifica
// al dispositivo/navegador), no solo por usuario, porque un mismo
// repartidor puede tener la app abierta en más de un celular.
router.post('/suscribir', async (req, res) => {
  let conn;
  try {
    const { usuario_id, subscription } = req.body;

    if (!usuario_id || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Faltan datos de la suscripción' });
    }

    conn = await pool.getConnection();
    await conn.query(
      `INSERT INTO push_subscriptions (usuario_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE usuario_id = VALUES(usuario_id), p256dh = VALUES(p256dh), auth = VALUES(auth)`,
      [usuario_id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /desuscribir - Se llama al cerrar sesión, para dejar de mandarle
// notificaciones a un dispositivo donde ya nadie va a estar mirando.
router.post('/desuscribir', async (req, res) => {
  let conn;
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Falta el endpoint de la suscripción' });
    }

    conn = await pool.getConnection();
    await conn.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /fcm/suscribir - La app Android registra el "token" de Firebase de ese
// celular para el usuario. Como esa app recibe los avisos por Firebase, se borran
// las suscripciones de push web de ese usuario para no mandarle cada aviso dos veces.
router.post('/fcm/suscribir', async (req, res) => {
  let conn;
  try {
    const usuarioId = Number(req.body.usuario_id);
    const token = String(req.body.token || '').trim();
    if (!usuarioId || token.length < 20) {
      return res.status(400).json({ error: 'Faltan datos del celular' });
    }

    conn = await pool.getConnection();
    await conn.query(
      `INSERT INTO fcm_tokens (usuario_id, token) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE usuario_id = VALUES(usuario_id)`,
      [usuarioId, token]
    );
    await conn.query('DELETE FROM push_subscriptions WHERE usuario_id = ?', [usuarioId]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /fcm/desuscribir - Se llama al cerrar sesión en la app Android.
router.post('/fcm/desuscribir', async (req, res) => {
  let conn;
  try {
    const token = String(req.body.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'Falta el token' });
    }
    conn = await pool.getConnection();
    await conn.query('DELETE FROM fcm_tokens WHERE token = ?', [token]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /probar - Prueba de notificación: el repartidor toca "Probar que me lleguen
// los avisos" y, 8 segundos después (para que alcance a minimizar la app), le
// llega una notificación. Responde cuántos celulares tiene registrados; si es 0
// no se manda nada. Hay un tiempo de espera entre pruebas para que no se pueda
// usar para llenar de avisos a nadie.
const SEGUNDOS_ANTES_DE_PRUEBA = 8;
const ultimaPrueba = new Map();

router.post('/probar', async (req, res) => {
  let conn;
  try {
    const usuarioId = Number(req.body.usuario_id);
    if (!usuarioId) {
      return res.status(400).json({ error: 'Falta el usuario' });
    }

    const ahora = Date.now();
    if (ahora - (ultimaPrueba.get(usuarioId) || 0) < 20000) {
      return res.status(429).json({ error: 'Esperá unos segundos antes de probar de nuevo.' });
    }
    ultimaPrueba.set(usuarioId, ahora);

    conn = await pool.getConnection();
    const [filas] = await conn.query('SELECT COUNT(*) AS total FROM push_subscriptions WHERE usuario_id = ?', [usuarioId]);
    let dispositivos = Number(filas[0].total);
    try {
      const [filasAndroid] = await conn.query('SELECT COUNT(*) AS total FROM fcm_tokens WHERE usuario_id = ?', [usuarioId]);
      dispositivos += Number(filasAndroid[0].total);
    } catch (error) {
      // La tabla de la app Android todavía no existe: solo cuenta el push web.
    }

    if (dispositivos > 0) {
      setTimeout(() => {
        enviarPushAUsuario(usuarioId, {
          titulo: 'JMMotocourier',
          cuerpo: 'Prueba: si ves esto, tu celular recibe los avisos de pedidos nuevos.'
        }).catch(error => console.error('Error en la notificación de prueba:', error.message));
      }, SEGUNDOS_ANTES_DE_PRUEBA * 1000);
    }

    res.json({ dispositivos, segundos: SEGUNDOS_ANTES_DE_PRUEBA });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
