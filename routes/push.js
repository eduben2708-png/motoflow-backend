const express = require('express');
const router = express.Router();
const pool = require('../config/database');

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

module.exports = router;
