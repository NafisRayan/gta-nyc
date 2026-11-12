// Small shared helpers: RNG, math, 2D ray/box queries, spatial hash.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const smoothstep = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

export function angNorm(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
export function dampAngle(a, b, lambda, dt) {
  return a + angNorm(b - a) * (1 - Math.exp(-lambda * dt));
}

/** mulberry32 seeded RNG */
export function RNG(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

/**
 * Ray vs axis-aligned box in XZ (buildings are tall; height ignored).
 * o: {x,z} origin, d: {x,z} normalized direction. Returns t or null.
 */
export function rayBoxXZ(ox, oz, dx, dz, x0, x1, z0, z1) {
  let tmin = 0, tmax = Infinity;
  for (const [o, d, a, b] of [[ox, dx, x0, x1], [oz, dz, z0, z1]]) {
    if (Math.abs(d) < 1e-9) { if (o < a || o > b) return null; continue; }
    let t1 = (a - o) / d, t2 = (b - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Ray vs circle in XZ. Returns t or null. */
export function rayCircleXZ(ox, oz, dx, dz, cx, cz, r) {
  const fx = ox - cx, fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

/**
 * Spatial hash for static colliders.
 * items are objects with x0,x1,z0,z1 (boxes) or x,z,r (circles).
 */
export class Grid {
  constructor(cell = 10) { this.cell = cell; this.map = new Map(); }
  _key(cx, cz) { return cx + ',' + cz; }
  insert(item, x0, x1, z0, z1) {
    const c = this.cell;
    for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++)
      for (let cz = Math.floor(z0 / c); cz <= Math.floor(z1 / c); cz++) {
        const k = this._key(cx, cz);
        let list = this.map.get(k);
        if (!list) this.map.set(k, (list = []));
        list.push(item);
      }
  }
  query(x, z, r, out = []) {
    const c = this.cell;
    const seen = new Set();
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++)
      for (let cz = Math.floor((z - r) / c); cz <= Math.floor((z + r) / c); cz++) {
        const list = this.map.get(this._key(cx, cz));
        if (!list) continue;
        for (const it of list) if (!seen.has(it)) { seen.add(it); out.push(it); }
      }
    return out;
  }
}

/** Push a circle ({x,y}, r) out of a collider. Mutates p = {x,y}; returns hit collider or null. */
export function resolveCircle(p, r, item) {
  if (item.r !== undefined) { // circle collider
    const dx = p.x - item.x, dz = p.y - item.z, d = Math.hypot(dx, dz), min = r + item.r;
    if (d >= min || d < 1e-6) return null;
    const push = (min - d) / d;
    p.x += dx * push; p.y += dz * push;
    return item;
  }
  // box collider: nearest-point method
  const nx = clamp(p.x, item.x0, item.x1), nz = clamp(p.y, item.z0, item.z1);
  const dx = p.x - nx, dz = p.y - nz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return null;
  if (d2 < 1e-9) { // center inside box: push out the shortest side
    const left = p.x - item.x0, right = item.x1 - p.x, top = p.y - item.z0, bot = item.z1 - p.y;
    const m = Math.min(left, right, top, bot);
    if (m === left) p.x = item.x0 - r; else if (m === right) p.x = item.x1 + r;
    else if (m === top) p.y = item.z0 - r; else p.y = item.z1 + r;
    return item;
  }
  const d = Math.sqrt(d2), push = (r - d) / d;
  p.x += dx * push; p.y += dz * push;
  return item;
}

/** Ray vs oriented rectangle in XZ (a vehicle). v = {x,z,heading,w,l}. Returns t or null. */
export function rayOBBXZ(ox, oz, dx, dz, v) {
  // transform ray into car frame
  const cos = Math.cos(-v.heading), sin = Math.sin(-v.heading);
  const px = cos * (ox - v.x) - sin * (oz - v.z);
  const pz = sin * (ox - v.x) + cos * (oz - v.z);
  const ddx = cos * dx - sin * dz, ddz = sin * dx + cos * dz;
  return rayBoxXZ(px, pz, ddx, ddz, -v.l / 2, v.l / 2, -v.w / 2, v.w / 2);
}
