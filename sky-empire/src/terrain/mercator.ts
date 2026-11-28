/** Web Mercator (EPSG:3857) slippy-map tile maths. */

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

export const keyOf = (t: TileKey) => `${t.z}/${t.x}/${t.y}`;

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Tile bounds in degrees: west, east, north, south. */
export function tileBounds(t: TileKey): { w: number; e: number; n: number; s: number } {
  return {
    w: tileXToLon(t.x, t.z),
    e: tileXToLon(t.x + 1, t.z),
    n: tileYToLat(t.y, t.z),
    s: tileYToLat(t.y + 1, t.z),
  };
}

export function children(t: TileKey): TileKey[] {
  const z = t.z + 1;
  const x = t.x * 2;
  const y = t.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

/** Ancestor at zoom `z` plus the sub-rectangle (0..1 fractions) this tile covers inside it. */
export function ancestor(t: TileKey, z: number): { key: TileKey; u0: number; v0: number; size: number } {
  const d = t.z - z;
  if (d <= 0) return { key: t, u0: 0, v0: 0, size: 1 };
  const f = 2 ** d;
  const key = { z, x: Math.floor(t.x / f), y: Math.floor(t.y / f) };
  return { key, u0: (t.x - key.x * f) / f, v0: (t.y - key.y * f) / f, size: 1 / f };
}

export function fillUrl(tpl: string, t: TileKey, key = ''): string {
  return tpl.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y)).replace('{key}', key);
}
