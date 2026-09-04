const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// 1. CORS - Permitir Vercel y localhost
// ==========================================
app.use(cors({
  origin: [
    'http://localhost:5000',
    'https://motoflow-web.vercel.app',
    /\.vercel\.app$/
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 2. Rutas de API (sin servir archivos estáticos)
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'MotoCourier CDE Backend running ✓' });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/pedidos', require('./routes/pedidos'));
app.use('/api/repartidores', require('./routes/repartidores'));
app.use('/api/liquidaciones', require('./routes/liquidaciones'));

// Error handling
app.use((err, req, res, next) => {
  console.error('❌ Error en el servidor:', err.stack);
  res.status(500).json({ error: 'Algo salió mal en el servidor' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🛵 MotoCourier CDE Backend corriendo en puerto ${PORT}`);
});

module.exports = app;