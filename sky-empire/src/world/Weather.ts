import W from '@data/weather.json';

/** Sun position (degrees) for a UTC time at a place: NOAA-style low-precision formulas (±0.5°). */
export function solarPosition(utcMs: number, latDeg: number, lonDeg: number): { azimuth: number; elevation: number } {
  const R = Math.PI / 180;
  const d = utcMs / 86_400_000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R;
  const e = (23.439 - 0.00000036 * d) * R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lonDeg) * R - ra);
  const lat = latDeg * R;
  const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { azimuth: ((az / R) + 360) % 360, elevation: el / R };
}

export interface Conditions {
  windDirDeg: number; // where the wind comes FROM, true
  windKt: number;
  gustKt: number;
  cloud: number; // 0..1 cover
  ceilingFt: number;
  precip: number; // 0..1 rain intensity
  visibilityM: number;
  turbulence: number; // 0..1
  storm: boolean;
  tempC: number;
  qnh: number;
}

/** Deterministic hash noise: smooth values from game time so weather is the same for the same date. */
function noise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number) => {
    const x = Math.sin((n + seed * 101.3) * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/**
 * Weather that drifts over game time (smooth noise, a few hours per "front"), shaped by the
 * season and latitude, and pushed around by economy events at your base (fog, storms).
 * Settings can force clear weather.
 */
export class Weather {
  current: Conditions = { windDirDeg: 240, windKt: 8, gustKt: 0, cloud: 0.3, ceilingFt: 4000, precip: 0, visibilityM: 30000, turbulence: 0.1, storm: false, tempC: 12, qnh: 1015 };
  forced: 'live' | 'clear' = 'live';

  /** events: ids of active economy events at the airport (e.g. 'fog_base', 'storm_base') */
  update(utcMs: number, latDeg: number, events: string[]): Conditions {
    if (this.forced === 'clear') {
      this.current = { windDirDeg: 240, windKt: 6, gustKt: 0, cloud: 0.15, ceilingFt: 5000, precip: 0, visibilityM: 40000, turbulence: 0.05, storm: false, tempC: 15, qnh: 1018 };
      return this.current;
    }
    const h = utcMs / 3_600_000 / W.frontHours;
    const seed = Math.round(latDeg * 10);
    const month = new Date(utcMs).getUTCMonth();
    const winter = Math.cos(((month - 0.5) / 12) * Math.PI * 2) * Math.sign(latDeg || 1); // +1 Jan (north), -1 Jul
    const wet = W.baseWetness + W.winterWetness * Math.max(0, winter) * Math.min(1, Math.abs(latDeg) / 45);
    const n1 = noise(h, seed);
    const n2 = noise(h * 1.7 + 13, seed);
    const n3 = noise(h * 0.6 + 41, seed);
    let cloud = Math.min(1, Math.max(0, n1 * 1.1 + wet - 0.45));
    let precip = Math.max(0, (cloud - W.rainCloudThreshold) / (1 - W.rainCloudThreshold)) * (0.4 + n2 * 0.6);
    let windKt = W.windMinKt + n2 * (W.windMaxKt - W.windMinKt) * (0.6 + cloud * 0.6);
    const windDirDeg = (W.prevailingWindDeg + (n3 - 0.5) * 160 + 360) % 360;
    let storm = precip > W.stormPrecip && n3 > 0.75;
    let visibilityM = Math.max(800, 40000 * (1 - precip * 0.85) * (1 - cloud * 0.2));
    // morning mist on calm, humid days
    const localHour = (new Date(utcMs).getUTCHours() + 24) % 24;
    if (windKt < 7 && cloud < 0.5 && localHour >= 4 && localHour <= 8 && n1 > 0.55) visibilityM = Math.min(visibilityM, 2500 + (1 - n1) * 6000);
    // economy events at the airport win
    if (events.some((e) => e.startsWith('fog'))) {
      visibilityM = 250 + n2 * 300;
      cloud = Math.max(cloud, 0.9);
      windKt = Math.min(windKt, 4);
    }
    if (events.some((e) => e.startsWith('storm') || e.startsWith('weather'))) {
      storm = true;
      precip = Math.max(precip, 0.8);
      cloud = 1;
      windKt = Math.max(windKt, 28);
      visibilityM = Math.min(visibilityM, 3000);
    }
    const gustKt = windKt > 12 ? Math.round(windKt * (0.3 + n1 * 0.4)) : 0;
    this.current = {
      windDirDeg: Math.round(windDirDeg / 10) * 10, windKt: Math.round(windKt), gustKt, cloud, ceilingFt: Math.round((4500 - cloud * 3800) / 100) * 100,
      precip, visibilityM, turbulence: Math.min(1, 0.05 + windKt / 60 + (storm ? 0.5 : 0) + cloud * 0.1), storm,
      tempC: Math.round(W.meanTempC - Math.abs(latDeg) * 0.33 - winter * W.seasonalSwingC * Math.min(1, Math.abs(latDeg) / 40) + (n3 - 0.5) * 5), qnh: Math.round(1013 + (0.5 - cloud) * 24 + (n2 - 0.5) * 8),
    };
    return this.current;
  }

  /** A METAR-style line for the HUD. */
  metar(icao: string, utcMs: number): string {
    const c = this.current;
    const d = new Date(utcMs);
    const t = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
    const wind = `${String(c.windDirDeg).padStart(3, '0')}${String(c.windKt).padStart(2, '0')}${c.gustKt ? `G${c.gustKt + c.windKt}` : ''}KT`;
    const vis = c.visibilityM >= 9999 ? '9999' : String(Math.round(c.visibilityM / 100) * 100).padStart(4, '0');
    const wx = c.storm ? '+TSRA' : c.precip > 0.6 ? '+RA' : c.precip > 0.25 ? 'RA' : c.precip > 0.02 ? '-RA' : c.visibilityM < 1000 ? 'FG' : c.visibilityM < 5000 ? 'BR' : '';
    const cov = c.cloud > 0.9 ? 'OVC' : c.cloud > 0.6 ? 'BKN' : c.cloud > 0.3 ? 'SCT' : c.cloud > 0.1 ? 'FEW' : '';
    const clouds = cov ? `${cov}${String(Math.round(c.ceilingFt / 100)).padStart(3, '0')}${c.storm ? 'CB' : ''}` : 'NSC';
    const temp = (v: number) => (v < 0 ? `M${String(-v).padStart(2, '0')}` : String(v).padStart(2, '0'));
    return [icao, t, wind, vis, wx, clouds, `${temp(c.tempC)}/${temp(c.tempC - 4 - Math.round(c.cloud * 3))}`, `Q${c.qnh}`].filter(Boolean).join(' ');
  }
}
