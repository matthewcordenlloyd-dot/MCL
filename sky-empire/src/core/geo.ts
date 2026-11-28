/**
 * Geographic helpers. The world uses a local East-North-Up frame around an origin
 * (for M1 the Heathrow ARP) mapped to three.js as x = east, y = up, z = south.
 * An equirectangular approximation is accurate to well under 0.1% within ~20 km,
 * which is all the walking/airport scale needs. M2's terrain streaming will move
 * to a floating origin with proper ellipsoid maths for long flights.
 */
const R_EARTH = 6378137;
const DEG = Math.PI / 180;

export interface GeoOrigin {
  lat: number;
  lon: number;
}

export function geoToLocal(origin: GeoOrigin, lat: number, lon: number): { x: number; z: number } {
  const x = (lon - origin.lon) * DEG * R_EARTH * Math.cos(origin.lat * DEG);
  const north = (lat - origin.lat) * DEG * R_EARTH;
  return { x, z: -north };
}

export function localToGeo(origin: GeoOrigin, x: number, z: number): { lat: number; lon: number } {
  const lat = origin.lat + (-z / R_EARTH) / DEG;
  const lon = origin.lon + (x / (R_EARTH * Math.cos(origin.lat * DEG))) / DEG;
  return { lat, lon };
}

/** Unit vector pointing at the sun (three.js axes) from azimuth (deg from north, clockwise) and elevation. */
export function sunDirection(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** Heading in degrees (0 = north, clockwise) -> yaw around +Y for an object facing -Z. */
export function headingToYaw(headingDeg: number): number {
  return -headingDeg * DEG;
}
