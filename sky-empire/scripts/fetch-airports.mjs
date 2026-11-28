// Downloads OurAirports (public domain) and builds compact game data:
//   data/world/airports.json  airline-capable airports
//   data/world/runways.json   runway ends for those airports (procedural airports, M4)
//   data/world/countries.json country names + continents
// Usage: npm run airports            (uses cached CSVs in data/raw if present)
//        npm run airports -- --refresh
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = 'https://davidmegginson.github.io/ourairports-data/';
const RAW = 'data/raw';
const OUT = 'data/world';
const refresh = process.argv.includes('--refresh');
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

async function get(name) {
  const path = `${RAW}/${name}`;
  if (!refresh && existsSync(path)) return readFileSync(path, 'utf8');
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(path, text);
  console.log(`downloaded ${name} (${(text.length / 1e6).toFixed(1)} MB)`);
  return text;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const airports = parseCsv(await get('airports.csv'));
const runways = parseCsv(await get('runways.csv'));
const countries = parseCsv(await get('countries.csv'));

const PAVED = /asp|con|bit|pav|tarmac|cop|pem/i;
const best = new Map(); // airport ident -> longest paved runway (m)
const rwByAirport = new Map();
for (const r of runways) {
  if (r.closed === '1') continue;
  const lenM = Number(r.length_ft) * 0.3048;
  if (!lenM) continue;
  if (PAVED.test(r.surface)) best.set(r.airport_ident, Math.max(best.get(r.airport_ident) ?? 0, lenM));
  if (!rwByAirport.has(r.airport_ident)) rwByAirport.set(r.airport_ident, []);
  rwByAirport.get(r.airport_ident).push(r);
}

const TYPE = { large_airport: 0, medium_airport: 1, small_airport: 2 };
const out = [];
const rwOut = {};
for (const a of airports) {
  const t = TYPE[a.type];
  if (t === undefined || t === 2) continue;
  const rw = Math.round(best.get(a.ident) ?? 0);
  const sched = a.scheduled_service === 'yes' ? 1 : 0;
  // airline-capable: large airports, or medium ones with scheduled service and a 1,200 m+ paved runway
  if (!(t === 0 || (sched && rw >= 1200))) continue;
  const icao = a.icao_code || a.gps_code || a.ident;
  out.push([icao, a.iata_code || '', a.name, a.municipality || '', a.iso_country, +(+a.latitude_deg).toFixed(4), +(+a.longitude_deg).toFixed(4), Math.round(+a.elevation_ft || 0), t, rw, sched]);
  rwOut[icao] = (rwByAirport.get(a.ident) ?? [])
    .filter((r) => r.le_latitude_deg && r.he_latitude_deg && r.closed !== '1')
    .map((r) => [r.le_ident, r.he_ident, +(+r.le_latitude_deg).toFixed(5), +(+r.le_longitude_deg).toFixed(5), +(+r.he_latitude_deg).toFixed(5), +(+r.he_longitude_deg).toFixed(5), Math.round(+r.length_ft * 0.3048), Math.round((+r.width_ft || 148) * 0.3048), r.surface]);
}
out.sort((x, y) => x[8] - y[8] || y[9] - x[9]);
writeFileSync(`${OUT}/airports.json`, JSON.stringify({
  _doc: 'OurAirports (public domain), airline-capable subset. Columns: icao, iata, name, city, country, lat, lon, elevationFt, type (0 large, 1 medium), longestPavedRunwayM, scheduledService. Rebuild with npm run airports.',
  columns: ['icao', 'iata', 'name', 'city', 'country', 'lat', 'lon', 'elevFt', 'type', 'runwayM', 'scheduled'],
  rows: out,
}));
writeFileSync(`${OUT}/runways.json`, JSON.stringify({ _doc: 'Runway ends: le, he, leLat, leLon, heLat, heLon, lengthM, widthM, surface', byIcao: rwOut }));
writeFileSync(`${OUT}/countries.json`, JSON.stringify(Object.fromEntries(countries.map((c) => [c.code, [c.name, c.continent]]))));
console.log(`airports: ${out.length} (large ${out.filter((a) => a[8] === 0).length}), runways for ${Object.keys(rwOut).length}, countries ${countries.length}`);
