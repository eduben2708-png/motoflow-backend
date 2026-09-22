const express = require('express');
const router = express.Router();

// Proxy hacia la Places API (New) de Google. La clave nunca sale del backend:
// vive solo en la variable de entorno GOOGLE_MAPS_API_KEY de Render, y el
// frontend le pega a este endpoint nuestro en vez de llamar a Google directo.
//
// Se eligió "Text Search (New)" porque en un solo pedido devuelve nombre,
// dirección formateada y coordenadas — lo mismo que el frontend ya esperaba
// de Nominatim (display_name, lat, lon), así que no hace falta un segundo
// pedido de "detalles" como pide Autocomplete.

// Centro aproximado de Ciudad del Este, usado para priorizar resultados de
// la zona (locationBias) sin excluir el resto del país.
const CENTRO_CDE = { latitude: -25.5097, longitude: -54.6111 };
const RADIO_SESGO_METROS = 15000;

router.get('/buscar', async (req, res) => {
  const clave = process.env.GOOGLE_MAPS_API_KEY;

  if (!clave) {
    return res.status(500).json({ error: 'Búsqueda de direcciones no configurada en el servidor.' });
  }

  const consulta = String(req.query.q || '').trim();
  if (consulta.length < 3) {
    return res.json([]);
  }

  try {
    const respuestaGoogle = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': clave,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
      },
      body: JSON.stringify({
        textQuery: consulta,
        languageCode: 'es',
        regionCode: 'PY',
        locationBias: {
          circle: {
            center: CENTRO_CDE,
            radius: RADIO_SESGO_METROS
          }
        }
      })
    });

    const datos = await respuestaGoogle.json();

    if (!respuestaGoogle.ok) {
      console.error('Error de Google Places:', datos);
      return res.status(502).json({ error: 'No se pudo consultar el buscador de direcciones.' });
    }

    const lugares = Array.isArray(datos.places) ? datos.places : [];

    // Se traduce al mismo formato que ya usaba el frontend con Nominatim
    // (display_name, lat, lon), para no tener que tocar la lógica de
    // sugerencias/selección del lado del cliente.
    const resultados = lugares.map((lugar) => ({
      display_name: lugar.formattedAddress || lugar.displayName?.text || consulta,
      lat: lugar.location?.latitude,
      lon: lugar.location?.longitude
    })).filter((r) => typeof r.lat === 'number' && typeof r.lon === 'number');

    res.json(resultados);
  } catch (error) {
    console.error('Error al buscar dirección con Google Places:', error.message);
    res.status(500).json({ error: 'No se pudo buscar la dirección. Probá de nuevo en unos segundos.' });
  }
});

module.exports = router;
