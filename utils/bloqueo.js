// Reglas de bloqueo semanal de repartidores.
//
// Cada sábado se cierra la semana y se crea la liquidación pendiente de cada
// repartidor. Si de esa liquidación surge que el repartidor le debe plata a
// la empresa (cobró de más en efectivo), tiene el fin de semana entero para
// pagarla. El lunes a la mañana, si todavía no pagó, queda bloqueado para
// recibir pedidos nuevos hasta que quede al día.

// Devuelve la medianoche del lunes de la semana actual (hora del servidor).
function lunesDeEstaSemana(ahora = new Date()) {
  const fecha = new Date(ahora);
  const dia = fecha.getDay(); // 0 = domingo, 1 = lunes, ..., 6 = sábado
  const diasDesdeLunes = dia === 0 ? 6 : dia - 1;
  fecha.setHours(0, 0, 0, 0);
  fecha.setDate(fecha.getDate() - diasDesdeLunes);
  return fecha;
}

// Devuelve el set de ids de repartidores actualmente bloqueados: tienen una
// liquidación sin pagar donde ELLOS le deben a la empresa, cerrada antes del
// lunes de esta semana.
async function idsRepartidoresBloqueados(conn) {
  const corte = lunesDeEstaSemana();
  const [filas] = await conn.query(
    `SELECT DISTINCT repartidor_id FROM liquidaciones
     WHERE direccion_pago = 'repartidor_paga'
       AND estado != 'pagado'
       AND fecha_fin < ?`,
    [corte]
  );
  return new Set(filas.map(fila => fila.repartidor_id));
}

async function estaBloqueado(conn, repartidorId) {
  const bloqueados = await idsRepartidoresBloqueados(conn);
  return bloqueados.has(Number(repartidorId));
}

module.exports = { lunesDeEstaSemana, idsRepartidoresBloqueados, estaBloqueado };
