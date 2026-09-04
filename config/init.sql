CREATE TABLE usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  telefono VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(100),
  foto_url VARCHAR(255),
  rol ENUM('cliente', 'repartidor', 'admin') DEFAULT 'cliente',
  estado ENUM('activo', 'bloqueado', 'suspendido') DEFAULT 'activo',
  fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repartidores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NOT NULL UNIQUE,
  ci VARCHAR(20) UNIQUE NOT NULL,
  placa VARCHAR(20) UNIQUE NOT NULL,
  marca_moto VARCHAR(100),
  modelo_moto VARCHAR(100),
  alias_bancario VARCHAR(100),
  banco VARCHAR(100),
  titular_cuenta VARCHAR(100),
  ci_titular VARCHAR(20),
  calificacion DECIMAL(3,2) DEFAULT 5.00,
  total_entregas INT DEFAULT 0,
  total_rechazos INT DEFAULT 0,
  gps_activo BOOLEAN DEFAULT FALSE,
  ubicacion_lat DECIMAL(10,8),
  ubicacion_lng DECIMAL(11,8),
  estado_aprobacion ENUM('pendiente', 'aprobado', 'rechazado') DEFAULT 'pendiente',
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

CREATE TABLE pedidos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id INT NOT NULL,
  repartidor_id INT,
  tipo ENUM('delivery', 'encargo', 'retiro') NOT NULL,
  origen_direccion VARCHAR(255) NOT NULL,
  destino_direccion VARCHAR(255) NOT NULL,
  monto INT NOT NULL,
  tipo_pago ENUM('efectivo', 'app') DEFAULT 'efectivo',
  estado ENUM('pendiente', 'asignado', 'en_camino', 'entregado', 'cancelado') DEFAULT 'pendiente',
  fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cliente_id) REFERENCES usuarios(id),
  FOREIGN KEY (repartidor_id) REFERENCES repartidores(id)
);

CREATE TABLE liquidaciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repartidor_id INT NOT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  total_servicios INT NOT NULL,
  monto_repartidor INT NOT NULL,
  estado ENUM('pendiente', 'pagado') DEFAULT 'pendiente',
  FOREIGN KEY (repartidor_id) REFERENCES repartidores(id)
);