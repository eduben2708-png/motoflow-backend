CREATE DATABASE IF NOT EXISTS motoflow
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

USE motoflow;

CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  telefono VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(100),
  foto_url VARCHAR(255),
  rol ENUM('cliente', 'repartidor', 'admin') NOT NULL DEFAULT 'cliente',
  estado ENUM('activo', 'bloqueado', 'suspendido') NOT NULL DEFAULT 'activo',
  fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS repartidores (
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
  calificacion DECIMAL(3,2) NOT NULL DEFAULT 5.00,
  total_entregas INT NOT NULL DEFAULT 0,
  total_rechazos INT NOT NULL DEFAULT 0,
  gps_activo BOOLEAN NOT NULL DEFAULT FALSE,
  ubicacion_lat DECIMAL(10,8),
  ubicacion_lng DECIMAL(11,8),
  estado_aprobacion ENUM('pendiente', 'aprobado', 'rechazado') NOT NULL DEFAULT 'pendiente',
  CONSTRAINT fk_repartidores_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pedidos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id INT NOT NULL,
  repartidor_id INT NULL,
  tipo ENUM('delivery', 'encargo', 'retiro') NOT NULL,
  origen_direccion VARCHAR(255) NOT NULL,
  destino_direccion VARCHAR(255) NOT NULL,
  monto INT NOT NULL,
  distancia_km DECIMAL(8,2) NULL,
  tarifa_base INT NOT NULL DEFAULT 0,
  km_adicionales DECIMAL(8,2) NOT NULL DEFAULT 0,
  costo_km_adicionales INT NOT NULL DEFAULT 0,
  monto_compra INT NOT NULL DEFAULT 0,
  comision_encargo INT NOT NULL DEFAULT 0,
  tarifa_servicio INT NOT NULL DEFAULT 0,
  tipo_pago ENUM('pendiente', 'efectivo', 'transferencia', 'qr', 'app') NOT NULL DEFAULT 'pendiente',
  estado ENUM('pendiente', 'asignado', 'en_retiro', 'en_camino', 'entregado', 'cancelado') NOT NULL DEFAULT 'pendiente',
  liquidacion_id INT NULL,
  fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_entregado DATETIME NULL,
  INDEX idx_pedidos_liquidacion_id (liquidacion_id),
  CONSTRAINT fk_pedidos_cliente FOREIGN KEY (cliente_id) REFERENCES usuarios(id),
  CONSTRAINT fk_pedidos_repartidor FOREIGN KEY (repartidor_id) REFERENCES repartidores(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS liquidaciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repartidor_id INT NOT NULL,
  fecha_inicio DATETIME NOT NULL,
  fecha_fin DATETIME NOT NULL,
  total_servicios INT NOT NULL,
  total_tarifas INT NOT NULL DEFAULT 0,
  monto_repartidor INT NOT NULL,
  comision_plataforma INT NOT NULL DEFAULT 0,
  efectivo_cobrado INT NOT NULL DEFAULT 0,
  monto_neto INT NOT NULL DEFAULT 0,
  direccion_pago ENUM('empresa_paga', 'repartidor_paga') NOT NULL DEFAULT 'empresa_paga',
  estado ENUM('pendiente', 'pagado') NOT NULL DEFAULT 'pendiente',
  comprobante_transferencia LONGTEXT NULL,
  fecha_pago DATETIME NULL,
  CONSTRAINT fk_liquidaciones_repartidor FOREIGN KEY (repartidor_id) REFERENCES repartidores(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER //
CREATE TRIGGER pedidos_establecer_fecha_entregado
BEFORE UPDATE ON pedidos
FOR EACH ROW
BEGIN
  IF NEW.estado = 'entregado' AND OLD.estado <> 'entregado' THEN
    SET NEW.fecha_entregado = NOW();
  END IF;
END//
DELIMITER ;
