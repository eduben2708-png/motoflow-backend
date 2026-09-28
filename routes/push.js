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

// --- TEMPORAL: solo para diagnosticar por qué no llegan las notificaciones
// push. No expone las claves p256dh/auth. Se puede borrar una vez que
// quede confirmado que todo funciona. ---

// GET /debug-suscripciones - Muestra qué dispositivos quedaron guardados,
// para confirmar si la suscripción del celular llegó a guardarse o no.
router.get('/debug-suscripciones', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [filas] = await conn.query(
      'SELECT id, usuario_id, endpoint, created_at FROM push_subscriptions ORDER BY id DESC'
    );
    res.json(filas.map(f => ({
      id: f.id,
      usuario_id: f.usuario_id,
      endpoint_preview: f.endpoint.slice(0, 70) + '...',
      created_at: f.created_at
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /probar/:usuarioId - Manda un push de prueba directo a un usuario,
// sin necesidad de crear un pedido real, para ver si la entrega funciona.
router.post('/probar/:usuarioId', async (req, res) => {
  try {
    await enviarPushAUsuario(Number(req.params.usuarioId), {
      titulo: 'Prueba de JMMotocourier',
      cuerpo: 'Si ves esto, las notificaciones push están funcionando.'
    });
    res.json({ success: true, mensaje: 'Push de prueba enviado (revisá el celular).' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
