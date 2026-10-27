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
app.use('/api/push', require('./routes/push'));

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
        descriptor_facial TEXT NULL,
        consentimiento_biometrico BOOLEAN DEFAULT FALSE,
        consentimiento_biometrico_fecha TIMESTAMP NULL,
        ultima_verificacion_facial TIMESTAMP NULL,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
      )
    `);

    // Verificación facial al activar el GPS: evita que otra persona use la
    // cuenta de un repartidor aprobado. descriptor_facial guarda el "código"
    // numérico de su cara (no la foto), generado una sola vez al registrarla
    // con su consentimiento explícito; cada selfie posterior se compara
    // contra ese código en el momento, sin guardarse (ver
    // POST /:id/rostro y POST /:id/verificar-rostro en routes/repartidores.js).
    try {
      await conn.query('ALTER TABLE repartidores ADD COLUMN descriptor_facial TEXT NULL');
      console.log('✓ Columna "descriptor_facial" agregada a "repartidores"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE repartidores ADD COLUMN consentimiento_biometrico BOOLEAN DEFAULT FALSE');
      console.log('✓ Columna "consentimiento_biometrico" agregada a "repartidores"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE repartidores ADD COLUMN consentimiento_biometrico_fecha TIMESTAMP NULL');
      console.log('✓ Columna "consentimiento_biometrico_fecha" agregada a "repartidores"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE repartidores ADD COLUMN ultima_verificacion_facial TIMESTAMP NULL');
      console.log('✓ Columna "ultima_verificacion_facial" agregada a "repartidores"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Cuándo llegó la última posición GPS del repartidor. Sin esto no hay
    // forma de distinguir un repartidor que se está moviendo ahora de uno
    // que cerró la app hace horas y quedó con "gps_activo" prendido: el mapa
    // del cliente y el del administrador mostrarían una posición vieja como
    // si fuera actual.
    try {
      await conn.query('ALTER TABLE repartidores ADD COLUMN ubicacion_actualizada TIMESTAMP NULL');
      console.log('✓ Columna "ubicacion_actualizada" agregada a "repartidores"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Color de la moto y foto de perfil del repartidor: se muestran al cliente
    // cuando sigue su pedido, para que reconozca a quién va a recibir. La
    // foto se guarda ya reducida (unos 40-60 KB) como texto en la base, y no
    // viaja en la lista de repartidores: se pide aparte en GET /:id/foto.
    const columnasNuevas = [
      ['color_moto', 'VARCHAR(30) NULL'],
      ['foto_perfil', 'MEDIUMTEXT NULL'],
      ['foto_actualizada', 'TIMESTAMP NULL']
    ];
    for (const [nombre, tipo] of columnasNuevas) {
      try {
        await conn.query(`ALTER TABLE repartidores ADD COLUMN ${nombre} ${tipo}`);
        console.log(`✓ Columna "${nombre}" agregada a "repartidores"`);
      } catch (error) {
        // Ya existe la columna: es esperable en cada reinicio a partir del primero.
      }
    }

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
        telefono_destinatario VARCHAR(20) NULL,
        recargo_centro DECIMAL(10, 2) DEFAULT 0,
        pago_servicio_retiro BOOLEAN DEFAULT FALSE,
        forma_pago_servicio VARCHAR(50) NULL,
        calificacion_repartidor TINYINT NULL,
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

    // Teléfono de contacto de quien recibe el pedido (lo carga el cliente que
    // vende, para que el repartidor pueda llamarlo si no encuentra la
    // dirección). Es opcional, por eso NULL.
    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN telefono_destinatario VARCHAR(20) NULL');
      console.log('✓ Columna "telefono_destinatario" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Recargo fijo cuando el punto de retiro cae dentro del centro de
    // Ciudad del Este (ver RECARGO_CENTRO en routes/pedidos.js). Se guarda
    // aparte del resto de la tarifa para que quede claro en el historial
    // por qué un pedido costó más.
    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN recargo_centro DECIMAL(10, 2) DEFAULT 0');
      console.log('✓ Columna "recargo_centro" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Caso "el vendedor ya arregla el pago del servicio directo con el
    // repartidor al momento de retirar" (por ejemplo, en mano), y por eso no
    // corresponde cobrárselo al destinatario al entregar. pago_servicio_retiro
    // lo tilda el vendedor al confirmar el pedido; forma_pago_servicio la
    // completa el repartidor recién al marcar "Paquete retirado".
    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN pago_servicio_retiro BOOLEAN DEFAULT FALSE');
      console.log('✓ Columna "pago_servicio_retiro" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN forma_pago_servicio VARCHAR(50) NULL');
      console.log('✓ Columna "forma_pago_servicio" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Calificación (1 a 5) que el cliente le deja al repartidor una vez
    // entregado el pedido. Con esto se recalcula el promedio guardado en
    // repartidores.calificacion (ver PUT /api/pedidos/:id/calificacion).
    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN calificacion_repartidor TINYINT NULL');
      console.log('✓ Columna "calificacion_repartidor" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Quién canceló el pedido ('cliente' o 'admin') y cuándo.
    try {
      await conn.query("ALTER TABLE pedidos ADD COLUMN cancelado_por VARCHAR(20) NULL");
      console.log('✓ Columna "cancelado_por" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN fecha_cancelacion TIMESTAMP NULL');
      console.log('✓ Columna "fecha_cancelacion" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Aceptación de pedidos por parte del repartidor: cuándo se le asignó, cuándo
    // aceptó, quiénes ya lo rechazaron (ids separados por coma) y si ya se le avisó
    // al administrador de que sigue sin repartidor.
    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN asignado_en TIMESTAMP NULL');
      console.log('✓ Columna "asignado_en" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN aceptado_en TIMESTAMP NULL');
      console.log('✓ Columna "aceptado_en" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN repartidores_descartados VARCHAR(255) NULL');
      console.log('✓ Columna "repartidores_descartados" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    try {
      await conn.query('ALTER TABLE pedidos ADD COLUMN aviso_admin_pendiente TINYINT DEFAULT 0');
      console.log('✓ Columna "aviso_admin_pendiente" agregada a "pedidos"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

    // Pedidos que ya estaban en curso antes de existir la aceptación (no tienen
    // "asignado_en"): se consideran aceptados para que no venzan solos.
    try {
      await conn.query("UPDATE pedidos SET aceptado_en = NOW() WHERE estado IN ('asignado', 'en_retiro', 'en_camino') AND aceptado_en IS NULL AND asignado_en IS NULL");
    } catch (error) {
      console.error('Error al marcar pedidos en curso como aceptados:', error.message);
    }

    // Celulares con la app Android: el "token" de Firebase por usuario, para mandarle
    // los avisos de pedidos aunque la app esté cerrada.
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS fcm_tokens (
          id INT AUTO_INCREMENT PRIMARY KEY,
          usuario_id INT NOT NULL,
          token VARCHAR(400) NOT NULL,
          creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_fcm_token (token(191)),
          KEY idx_fcm_usuario (usuario_id)
        )
      `);
    } catch (error) {
      console.error('Error al crear la tabla fcm_tokens:', error.message);
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

    // Guarda cómo se cobró la tarifa de esos pedidos (efectivo, transferencia,
    // QR, app) como JSON de texto, para mostrarlo en el detalle de la
    // liquidación sin tener que recalcularlo cada vez. No cambia en nada el
    // cálculo de a quién le debe plata a quién (ver calcularResumen en
    // routes/liquidaciones.js), es solo informativo.
    try {
      await conn.query('ALTER TABLE liquidaciones ADD COLUMN tarifas_por_metodo TEXT NULL');
      console.log('✓ Columna "tarifas_por_metodo" agregada a "liquidaciones"');
    } catch (error) {
      // Ya existe la columna: es esperable en cada reinicio a partir del primero.
    }

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

async function crearTablaPushSubscriptions() {
  let conn;
  try {
    conn = await pool.getConnection();

    // Guarda, por dispositivo (endpoint), la suscripción push de cada
    // repartidor. Con esto el servidor sabe a qué "buzón" del navegador
    // mandarle el aviso de un pedido nuevo, sin que el celular necesite
    // tener la app abierta.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        endpoint VARCHAR(500) UNIQUE NOT NULL,
        p256dh VARCHAR(255) NOT NULL,
        auth VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_push_usuario (usuario_id)
      )
    `);
    console.log('✓ Tabla push_subscriptions verificada');
  } catch (error) {
    console.error('❌ Error en tabla push_subscriptions:', error.message);
  } finally {
    if (conn) conn.release();
  }
}

crearTablaPedidos();
crearTablaLiquidaciones();
crearTablaMensajes();
crearTablaPushSubscriptions();

// Cada 30 segundos se revisan los pedidos que quedaron pendientes por falta de
// repartidores y se asignan apenas aparece uno disponible cerca.
setInterval(() => {
  require('./routes/pedidos').reasignarPedidosPendientes()
    .catch(error => console.error('Error en la revisión de pendientes:', error.message));
}, 30000);

module.exports = app;



