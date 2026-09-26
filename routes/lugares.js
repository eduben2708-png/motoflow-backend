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

// POST /resolver-link - Nuestro cliente (que muchas veces es a la vez
// vendedor) recibe la ubicación de SU propio cliente como un link de
// Google Maps (compartido por WhatsApp, por ejemplo) y quiere usarla directo
// como punto de retiro/entrega en vez de tener que buscar la dirección nueva.
// Los links cortos (maps.app.goo.gl) no traen las coordenadas en la URL: hay
// que seguir la redirección para llegar a la URL final, que sí las tiene.
const DOMINIOS_MAPS_PERMITIDOS = ['google.com', 'goo.gl', 'g.co'];

function esLinkDeGoogleMaps(url) {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return DOMINIOS_MAPS_PERMITIDOS.some((dominio) => hostname === dominio || hostname.endsWith(`.${dominio}`));
  } catch {
    return false;
  }
}

function extraerCoordenadasDeTexto(texto) {
  const patrones = [
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,        // .../@-25.5097,-54.6111,17z
    /[?&]q=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,    // ?q=-25.5097,-54.6111
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/      // datos internos de Google (3d=lat, 4d=lng)
  ];

  for (const patron of patrones) {
    const coincidencia = texto.match(patron);
    if (coincidencia) {
      return { lat: Number(coincidencia[1]), lng: Number(coincidencia[2]) };
    }
  }
  return null;
}

router.post('/resolver-link', async (req, res) => {
  const url = String(req.body.url || '').trim();

  if (!url) {
    return res.status(400).json({ error: 'Pegá un link de ubicación' });
  }

  if (!esLinkDeGoogleMaps(url)) {
    return res.status(400).json({ error: 'Ese link no es de Google Maps. Pegá el link tal cual te lo compartieron.' });
  }

  try {
    // fetch sigue redirecciones automáticamente, y "response.url" queda con
    // la URL final ya resuelta (ahí es donde vienen las coordenadas en los
    // links cortos tipo maps.app.goo.gl).
    const respuesta = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      }
    });
    const urlFinal = respuesta.url || url;

    let coordenadas = extraerCoordenadasDeTexto(urlFinal);
    if (!coordenadas) {
      // Algunos links resuelven a una página en vez de a una URL con las
      // coordenadas a la vista: se busca el mismo patrón dentro del HTML.
      const cuerpo = await respuesta.text();
      coordenadas = extraerCoordenadasDeTexto(cuerpo);
    }

    if (!coordenadas) {
      return res.status(422).json({ error: 'No se pudieron leer las coordenadas de ese link. Probá pegar el link completo de Google Maps, o buscar la dirección a mano.' });
    }

    res.json(coordenadas);
  } catch (error) {
    console.error('Error al resolver link de ubicación:', error.message);
    res.status(500).json({ error: 'No se pudo abrir ese link. Verificá que sea un link válido de Google Maps.' });
  }
});

module.exports = router;
