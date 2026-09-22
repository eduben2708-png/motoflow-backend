const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '5mb' }));

// Sirve el frontend desde http://localhost:5000 para que el mapa envíe un Referer válido.
app.use(express.static(path.join(__dirname, '..', 'motoflow-web')));

// Rutas básicas
app.get('/api/health', (req, res) => {
  res.json({ status: 'JMMotocourier Backend running ✓' });
});

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/pedidos', require('./routes/pedidos'));
app.use('/api/repartidores', require('./routes/repartidores'));
app.use('/api/liquidaciones', require('./routes/liquidaciones'));
app.use('/api/lugares', require('./routes/lugares'));

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Algo salió mal' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🛵 MotoCourier CDE Backend corriendo en puerto ${PORT}`);
});

// Inicializar tabla repartidores
const pool = require('./config/database');

async function inicializarTablasDB() {
  try {
    let conn = await pool.getConnection();
    
    await conn.query(`
      CREATE TABLE IF NOT EXISTS repartidores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        ci VARCHAR(50) UNIQUE NOT NULL,
        placa VARCHAR(50) UNIQUE NOT NULL,
        marca_moto VARCHAR(100),
        modelo_moto VARCHAR(100),
        estado_aprobacion VARCHAR(50) DEFAULT 'pendiente',
        ubicacion_lat DECIMAL(10, 8),
        ubicacion_lng DECIMAL(11, 8),
        gps_activo BOOLEAN DEFAULT FALSE,
        alias_bancario VARCHAR(100),
        banco VARCHAR(100),
        titular_cuenta VARCHAR(100),
        ci_titular VARCHAR(50),
        total_entregas INT DEFAULT 0,
        calificacion DECIMAL(3, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
      )
    `);
    console.log('✓ Tabla repartidores verificada');
    conn.release();
  } catch (error) {
    console.error('❌ Error en tabla repartidores:', error.message);
  }
}

inicializarTablasDB();

async function crearTablaPedidos() {
  let conn;
  try {
    conn = await pool.getConnection();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cliente_id INT,
        repartidor_id INT,
        tipo VARCHAR(50),
        origen_direccion VARCHAR(255),
        destino_direccion VARCHAR(255),
        origen_lat DECIMAL(10, 8),
        origen_lng DECIMAL(11, 8),
        destino_lat DECIMAL(10, 8),
        destino_lng DECIMAL(11, 8),
        monto DECIMAL(10, 2),
        tipo_pago VARCHAR(50),
        distancia_km DECIMAL(10, 2),
        tarifa_base DECIMAL(10, 2),
        km_adicionales DECIMAL(10, 2),
        costo_km_adicionales DECIMAL(10, 2),
        monto_compra DECIMAL(10, 2),
        comision_encargo DECIMAL(10, 2),
        tarifa_servicio DECIMAL(10, 2),
        estado VARCHAR(50) DEFAULT 'pendiente',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        liquidacion_id INT NULL,
        FOREIGN KEY (liquidacion_id) REFERENCES liquidaciones(id)
      )
    `);

    // Agrega la columna a instalaciones que ya tenían la tabla creada sin ella.
    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN liquidacion_id INT NULL');
      console.log('✓ Columna "liquidacion_id" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    console.log('✓ Tabla pedidos verificada');
  } catch (error) {
    console.error('❌ Error en tabla pedidos:', error.message);
  } finally {
    if (conn) conn.release();
  }
}

async function crearTablaLiquidaciones() {
  try {
    let conn = await pool.getConnection();
    
    await conn.query(`
      CREATE TABLE IF NOT EXISTS liquidaciones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        repartidor_id INT NOT NULL,
        fecha_inicio DATETIME,
        fecha_fin DATETIME,
        total_servicios INT DEFAULT 0,
        total_tarifas DECIMAL(10, 2),
        monto_repartidor DECIMAL(10, 2),
        comision_plataforma DECIMAL(10, 2),
        efectivo_cobrado DECIMAL(10, 2),
        monto_neto DECIMAL(10, 2),
        direccion_pago VARCHAR(50),
        estado VARCHAR(50) DEFAULT 'pendiente',
        comprobante_transferencia LONGTEXT,
        fecha_pago DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (repartidor_id) REFERENCES repartidores(id)
      )
    `);
    console.log('✓ Tabla liquidaciones verificada');
    conn.release();
  } catch (error) {
    console.error('❌ Error en tabla liquidaciones:', error.message);
  }
}

async function crearTablaMensajes() {
  let conn;
  try {
    conn = await pool.getConnection();

    // Sin FOREIGN KEY hacia pedidos a propósito: esta tabla se crea en paralelo
    // con crearTablaPedidos() y no hay garantía de qué termine primero.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mensajes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pedido_id INT NOT NULL,
        usuario_id INT NOT NULL,
        mensaje TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mensajes_pedido (pedido_id)
      )
    `);
    console.log('✓ Tabla mensajes verificada');
  } catch (error) {
    console.error('❌ Error en tabla mensajes:', error.message);
  } finally {
    if (conn) conn.release();
  }
}

crearTablaPedidos();
crearTablaLiquidaciones();
crearTablaMensajes();

module.exports = app;



