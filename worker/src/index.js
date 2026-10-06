// Worker "deviazioni": per una linea GTT restituisce gli avvisi completi
// e, quando GTT li pubblica, i tratti deviati con le fermate saltate.
//
// GET /deviazioni?linea=15
// {
//   line: "15",
//   alerts: [{ title, text, date, stops: [{id, name, lat, lng}] }],
//   deviations: [{ route, direction, from: {id, name}, to: {id, name},
//                  skipped: [{id, name, lat, lng}] | null, paths: [[[lat, lng], ...]] }],
//   (`paths` è il tratto del percorso normale NON percorso, non il giro alternativo:
//    quello GTT lo descrive solo nel testo dell'avviso)
//   routes: [{ id, verso, name, path: [[lat, lng]], stops: [{id, name, lat, lng}] }]
// }
// `routes` (per la mappa) è vuoto se la linea non ha né avvisi né deviazioni.
// `alerts[].stops` sono le fermate citate nel testo che si trovano sul percorso.

const GTT = 'https://www.gtt.to.it';
const CACHE_TTL_S = 300;
const GTT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; staffarda-bus)',
  'Accept-Language': 'it-IT,it;q=0.9',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname !== '/deviazioni') return json({ error: 'Not found' }, 404);

    const line = (url.searchParams.get('linea') || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{1,6}$/.test(line)) return json({ error: 'Parametro linea non valido' }, 400);

    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheKey = new Request(`${url.origin}/deviazioni?linea=${line}`);
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    let data;
    try {
      data = await getLineInfo(line);
    } catch (e) {
      return json({ error: 'GTT non raggiungibile' }, 502);
    }

    const response = json(data, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL_S}` });
    if (cache) ctx?.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

async function getLineInfo(line) {
  const lineUrl = `${GTT}/cms/percorari/urbano?view=percorsi&bacino=U&linea=${encodeURIComponent(line)}&Regol=GE`;
  const [page, geo] = await Promise.all([fetchText(lineUrl), fetchDeviationGeo(line, lineUrl)]);
  if (!page) throw new Error('Pagina linea vuota');

  const routes = parseRoutes(page);
  const deviations = buildDeviations(geo, routes);
  const alerts = parseAlerts(page).map(alert => ({ ...alert, stops: findMentionedStops(alert, routes) }));
  const hasNews = alerts.length > 0 || deviations.length > 0;

  return {
    line,
    alerts,
    deviations,
    routes: hasNews ? routes.filter(r => r.path.length) : [],
  };
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { ...GTT_HEADERS, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Il servizio a volte risponde vuoto: un secondo tentativo, poi ci si arrende
// (le deviazioni sono un'informazione in più, gli avvisi arrivano comunque).
async function fetchDeviationGeo(line, referer) {
  const url = `${GTT}/cms/components/com_gtt/proxydas.php?serviceName=GetDisserviziLineaGeoJson&linea=${encodeURIComponent(line)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = (await fetchText(url, { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' })).trim();
      if (!body) continue;
      return JSON.parse(body);
    } catch (e) {}
  }
  return null;
}

// --- Parsing della pagina linea -------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', egrave: 'è', eacute: 'é', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì', deg: '°' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function cleanText(html) {
  if (!html) return '';
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n')
    .map(row => row.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleCase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/(^|[\s'(./-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase())
    .trim();
}

function parseAlerts(page) {
  const heading = page.indexOf('>Avvisi <');
  if (heading < 0) return [];
  const end = page.indexOf('<script', heading);
  const block = page.slice(heading, end < 0 ? undefined : end);

  return block.split(/<h5>/i).slice(1).map(chunk => ({
    title: cleanText(/<b>([\s\S]*?)<\/b>/i.exec(chunk)?.[1]),
    text: cleanText(/<\/h\d>\s*<span>([\s\S]*?)<\/span>/i.exec(chunk)?.[1]),
    date: cleanText(/class="pull-right">([\s\S]*?)<\/span>/i.exec(chunk)?.[1]),
  })).filter(alert => alert.title || alert.text);
}

function parseRoutes(page) {
  const routes = new Map();
  const route = index => {
    if (!routes.has(index)) routes.set(index, { id: null, verso: null, name: null, path: [], stops: [] });
    return routes.get(index);
  };

  // Tabella dei percorsi: checkbox "percorsoN" seguita dal link con codice, verso e nome
  const rowRe = /id="percorso(\d+)"[\s\S]*?view=percorso&amp;[^"]*?percorso=([^&"]+)&amp;verso=([^&"]+)[^"]*">\s*([^<]*?)\s*</g;
  for (const [, index, id, verso, name] of page.matchAll(rowRe)) {
    Object.assign(route(index), { id, verso, name: cleanText(name) });
  }

  // Fermate: icona con className "percorsoN", poi il marker con coordinate e popup "Fermata: <strong>ID - NOME"
  const stopRe = /className: 'percorso(\d+)',\s*iconAnchor:[^}]*\}\);\s*L\.marker\(\[([-\d.]+),\s*([-\d.]+)\][\s\S]*?Fermata: <strong>(\d+) - ([^<]*)<\/strong>/g;
  for (const [, index, lat, lng, id, name] of page.matchAll(stopRe)) {
    // Il nome sta dentro una stringa JS tra apici: gli apostrofi arrivano come \'
    const stopName = titleCase(decodeEntities(name.replace(/\\'/g, "'")));
    route(index).stops.push({ id, name: stopName, lat: Number(lat), lng: Number(lng) });
  }

  // Tracciati: new L.Polyline([new L.LatLng(lat,lng), ...], { ... className: 'percorsoN' ... })
  const lineRe = /new L\.Polyline\(\[([\s\S]*?)\]\s*,\s*\{([\s\S]*?)\}\)/g;
  for (const [, points, options] of page.matchAll(lineRe)) {
    const index = /className: 'percorso(\d+)'/.exec(options)?.[1];
    if (index == null) continue;
    route(index).path = [...points.matchAll(/LatLng\(([-\d.]+),\s*([-\d.]+)\)/g)].map(([, lat, lng]) => [Number(lat), Number(lng)]);
  }

  return [...routes.values()].filter(r => r.id);
}

// "Fermata 558", "fermata n. 559", "Fermata n.1120": numeri di palina citati nell'avviso
function findMentionedStops(alert, routes) {
  const ids = new Set();
  for (const [, id] of `${alert.title}\n${alert.text}`.matchAll(/fermat[ae]\s*(?:n\.?|nr\.?|numero)?\s*(\d{2,5})\b/gi)) {
    ids.add(id);
  }
  const found = new Map();
  for (const route of routes) {
    for (const stop of route.stops) {
      if (ids.has(stop.id) && !found.has(stop.id)) found.set(stop.id, stop);
    }
  }
  return [...found.values()];
}

// --- Deviazioni --------------------------------------------------------------

function toLatLngPaths(geometry) {
  if (!geometry?.coordinates) return [];
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  return lines.map(line => line.map(([lng, lat]) => [lat, lng]));
}

function buildDeviations(geo, routes) {
  if (!geo?.features?.length) return [];

  return geo.features.map(feature => {
    const p = feature.properties || {};
    const route = routes.find(r => r.id === p.Percorso) || routes.find(r => r.verso === p.Verso);
    const stops = route?.stops || [];
    const fromId = String(p.FermataInizio ?? '');
    const toId = String(p.FermataFine ?? '');
    const fromIndex = stops.findIndex(s => s.id === fromId);
    const toIndex = stops.findIndex(s => s.id === toId);

    return {
      route: route?.id ?? p.Percorso ?? null,
      direction: route?.name ?? null,
      from: { id: fromId, name: titleCase(p.NomeInizio) },
      to: { id: toId, name: titleCase(p.NomeFine) },
      // null = non sappiamo ricostruirle (fermate non trovate nel percorso)
      skipped: fromIndex >= 0 && toIndex > fromIndex ? stops.slice(fromIndex + 1, toIndex) : null,
      paths: toLatLngPaths(feature.geometry),
    };
  });
}
