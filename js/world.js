// City generator: a Manhattan-style grid built from Polyfork NYC City Kit modules.
// Owns: painted ground, building/prop placement, night-window carving, lamp pools,
// collision grid, traffic lanes, parking spots, mission points.

import * as THREE from 'three';
import { mergeAssets } from 'https://polyfork.dev/cdn/merge.mjs';
import {
  CDN, PALETTE, BUILDINGS, PROPS, ROOFPROPS, VEHICLE_IDS, getModule, getNightZones, makeStatic,
} from './assets.js';
import { RNG, clamp, Grid, pick } from './utils.js';

// ---- grid constants ----
export const P = 56;              // street pitch (m)
export const SW = 12;             // street width (two 4 m lanes + parking strips)
export const PW = 4;              // pavement width
export const NBX = 5, NBZ = 4;    // block counts
const HALF_X = (NBX * P + SW) / 2, HALF_Z = (NBZ * P + SW) / 2;
export const CITY = { x0: -HALF_X, x1: HALF_X, z0: -HALF_Z, z1: HALF_Z };
export const STREET_XS = Array.from({ length: NBX + 1 }, (_, k) => -HALF_X + SW / 2 + k * P);
export const STREET_ZS = Array.from({ length: NBZ + 1 }, (_, k) => -HALF_Z + SW / 2 + k * P);
const BLOCK_XS = STREET_XS.slice(0, -1).map((x) => x + P / 2);
const BLOCK_ZS = STREET_ZS.slice(0, -1).map((z) => z + P / 2);
const FRONT = P / 2 - SW / 2 - PW;            // 18: block center → building front line
const PARKS = new Set(['1,1', '3,2']);        // block indices that become parks

const LANE = 1.8;                             // drive lane offset from street center
const rnd = RNG(20261112);

// nearest distance from x to the values in arr
const nearDist = (v, arr) => Math.min(...arr.map((c) => Math.abs(v - c)));

export function surfaceAt(x, z) {
  const dx = nearDist(x, STREET_XS), dz = nearDist(z, STREET_ZS);
  if (dx < SW / 2 || dz < SW / 2) return 'road';
  if (x < CITY.x0 || x > CITY.x1 || z < CITY.z0 || z > CITY.z1) return 'outer';
  if (dx < SW / 2 + PW || dz < SW / 2 + PW) return 'sidewalk';
  const bi = Math.floor((x - CITY.x0) / P), bj = Math.floor((z - CITY.z0) / P);
  return PARKS.has(bi + ',' + bj) ? 'park' : 'plaza';
}

// =====================================================================================
export async function buildWorld(scene, onProgress) {
  const group = new THREE.Group();
  group.name = 'city';
  const colliders = [];                       // {x,z,r} circles | {x0,x1,z0,z1} boxes
  const colliderGrid = new Grid(12);
  const addCollider = (c) => {
    c.id = colliders.length; c.on = true;
    colliders.push(c);
    const b = c.r !== undefined
      ? [c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r]
      : [c.x0, c.x1, c.z0, c.z1];
    colliderGrid.insert(c, ...b);
  };

  // ---------------------------------------------------------------- ground (one mesh)
  const pos = [], col = [];
  const quad = (x0, z0, x1, z1, y, hex) => {
    const c = new THREE.Color(hex);
    for (const [px, pz] of [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]]) {
      pos.push(px, y, pz); col.push(c.r, c.g, c.b);
    }
  };
  // outer ground, then streets, pavements, block interiors, markings
  quad(CITY.x0 - 400, CITY.z0 - 400, CITY.x1 + 400, CITY.z1 + 400, -0.02, 0x565a52);
  for (const x of STREET_XS) quad(x - SW / 2, CITY.z0, x + SW / 2, CITY.z1, 0, PALETTE.asphalt);
  for (const z of STREET_ZS) quad(CITY.x0, z - SW / 2, CITY.x1, z + SW / 2, 0.001, PALETTE.asphalt);
  for (let i = 0; i < NBX; i++) for (let j = 0; j < NBZ; j++) {
    const bx = BLOCK_XS[i], bz = BLOCK_ZS[j];
    const in0 = FRONT + 0.0, in1 = P / 2 - SW / 2;   // pavement ring: FRONT..(FRONT+PW)
    // pavement ring (4 strips)
    quad(bx - in1, bz + in0, bx + in1, bz + in1, 0.002, PALETTE.sidewalk);           // +Z
    quad(bx - in1, bz - in1, bx + in1, bz - in0, 0.002, PALETTE.sidewalk);           // -Z
    quad(bx + in0, bz - in0 + 0.0, bx + in1, bz + in0, 0.002, PALETTE.sidewalk);     // +X
    quad(bx - in1, bz - in0, bx - in0, bz + in0, 0.002, PALETTE.sidewalk);           // -X
    // curb tone
    quad(bx - in1, bz + in0, bx + in1, bz + in0 + 0.35, 0.003, PALETTE.curb);
    quad(bx - in1, bz - in0 - 0.35, bx + in1, bz - in0, 0.003, PALETTE.curb);
    if (PARKS.has(i + ',' + j)) {
      quad(bx - in0, bz - in0, bx + in0, bz + in0, 0.01, PALETTE.grass);
      quad(bx - 1.2, bz - in0, bx + 1.2, bz + in0, 0.012, PALETTE.plaza);            // N-S path
      quad(bx - in0, bz - 1.2, bx + in0, bz + 1.2, 0.012, PALETTE.plaza);            // E-W path
    } else {
      quad(bx - in0, bz - in0, bx + in0, bz + in0, 0.004, PALETTE.plazaDark);
    }
  }
  // center dashes (skip junctions)
  const dash = (x0, z0, x1, z1) => quad(x0, z0, x1, z1, 0.02, PALETTE.markYellow);
  for (const x of STREET_XS) for (let z = CITY.z0; z < CITY.z1; z += 8) {
    if (nearDist(z + 2, STREET_ZS) > SW / 2 + 3) dash(x - 0.15, z, x + 0.15, z + 3.4);
  }
  for (const z of STREET_ZS) for (let x = CITY.x0; x < CITY.x1; x += 8) {
    if (nearDist(x + 2, STREET_XS) > SW / 2 + 3) dash(x, z - 0.15, x + 3.4, z + 0.15);
  }
  // crosswalks: zebra bands on each junction approach
  const zebra = (x0, z0, x1, z1) => quad(x0, z0, x1, z1, 0.021, PALETTE.markWhite);
  for (const jx of STREET_XS) for (const jz of STREET_ZS) {
    for (let s = -5; s <= 5; s += 1.6) {
      zebra(jx + s, jz + 6.4, jx + s + 0.8, jz + 8.6);    // north approach
      zebra(jx + s, jz - 8.6, jx + s + 0.8, jz - 6.4);    // south
      zebra(jx + 6.4, jz + s, jx + 8.6, jz + s + 0.8);    // east
      zebra(jx - 8.6, jz + s, jx - 6.4, jz + s + 0.8);    // west
    }
  }
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);

  // ---------------------------------------------------------------- placement pools
  const staticList = [];                       // objects to merge into few draw calls
  const parkedSpots = [];                      // {x,z,heading,type,slot,instance}
  const glowBuckets = new Map();               // glow hex -> positions[] (night carve)
  const lampPoints = [];                       // {x,z,y,hex}
  const pavementPoints = [];                   // ped walk targets
  const doorPoints = [];                       // mission destinations (pavement mid-fronts)
  const payphones = [];
  const subways = [];
  let lastBuilding = '';

  const place = (obj, x, y, z, ry = 0, collide = null) => {
    obj.position.set(x, y, z);
    obj.rotation.y = (ry * Math.PI) / 180;
    obj.updateMatrixWorld(true);
    staticList.push(obj);
    if (collide === 'box') {
      const b = new THREE.Box3().setFromObject(obj);
      addCollider({ x0: b.min.x, x1: b.max.x, z0: b.min.z, z1: b.max.z });
    } else if (typeof collide === 'number') {
      addCollider({ x, z, r: collide });
    }
    return obj;
  };

  // ---- buildings with night windows carved out for glow ----
  const carveCache = new Map();                // building id -> [{hex, localPositions}]
  async function carve(id) {
    let c = carveCache.get(id);
    if (c !== undefined) return c;
    c = [];
    try {
      const [m, zones] = await Promise.all([getModule(id), getNightZones(id)]);
      if (zones.length) {
        const probe = m.createAsset();
        probe.updateMatrixWorld(true);
        probe.traverse((n) => {
          if (!n.isMesh || n.isSkinnedMesh || !n.geometry?.attributes?.color) return;
          const g = n.geometry.index ? n.geometry.toNonIndexed() : n.geometry;
          const p = g.attributes.position, colA = g.attributes.color, v = new THREE.Vector3();
          for (const z of zones) {
            const pts = [];
            for (let t = 0; t < p.count / 3; t++) {
              let ok = true;
              for (let i = 0; i < 3 && ok; i++) {
                const k = t * 3 + i;
                ok = Math.abs(colA.getX(k) - z.from.r) < 0.004
                  && Math.abs(colA.getY(k) - z.from.g) < 0.004
                  && Math.abs(colA.getZ(k) - z.from.b) < 0.004;
              }
              if (!ok) continue;
              for (let i = 0; i < 3; i++) {
                v.fromBufferAttribute(p, t * 3 + i).applyMatrix4(n.matrixWorld);
                pts.push(v.x, v.y, v.z);
              }
            }
            if (pts.length) {
              const hex = '#' + z.to.getHexString();
              c.push({ hex, lamp: z.lamp, pts });
            }
          }
        });
        probe.removeFromParent();
      }
    } catch { /* no night data for this one */ }
    carveCache.set(id, c);
    return c;
  }

  function recordGlow(id, obj) {
    const carved = carveCache.get(id) || [];
    const v = new THREE.Vector3();
    for (const z of carved) {
      let bucket = glowBuckets.get(z.hex);
      if (!bucket) glowBuckets.set(z.hex, (bucket = []));
      let cx = 0, cy = 0, cz = 0, n = z.pts.length / 3;
      for (let i = 0; i < z.pts.length; i += 3) {
        v.set(z.pts[i], z.pts[i + 1], z.pts[i + 2]).applyMatrix4(obj.matrixWorld);
        bucket.push(v.x, v.y, v.z);
        cx += v.x; cy += v.y; cz += v.z;
      }
      if (z.lamp && n < 40) lampPoints.push({ x: cx / n, y: cy / n, z: cz / n, hex: z.hex });
    }
  }

  const BUILD_WEIGHTS = [
    ['brownstone-row-house-1b84fd', 3], ['narrow-walk-up-41f10c', 3], ['brick-tenement-7d2014', 3],
    ['corner-tenement-92fb62', 2], ['one-storey-shop-row-83c958', 2], ['corner-shop-5aec8c', 2],
    ['cast-iron-loft-b04b5a', 2], ['street-diner-40fc87', 1], ['department-store-ffbd58', 1],
    ['movie-theater-40eeef', 1], ['classical-bank-04954e', 1], ['brick-church-322885', 1],
    ['public-school-19ade5', 1], ['fire-station-e2b756', 1], ['auto-repair-garage-b91464', 1],
    ['parking-garage-6e4f2c', 1], ['prewar-apartment-house-1081a6', 2], ['postwar-apartment-slab-cee5f9', 2],
    ['office-tower-1538cc', 2], ['art-deco-setback-tower-b3a788', 2],
  ];
  const pickBuilding = () => {
    for (;;) {
      let t = 0; for (const [, w] of BUILD_WEIGHTS) t += w;
      let r = rnd() * t;
      let id = BUILD_WEIGHTS[0][0];
      for (const [bid, w] of BUILD_WEIGHTS) { r -= w; if (r <= 0) { id = bid; break; } }
      if (id !== lastBuilding) { lastBuilding = id; return id; }
    }
  };

  const SIDE = [
    { ry: 0, along: 'x', front: +FRONT },   // +Z: faces +Z, walk x
    { ry: 90, along: 'z', front: +FRONT },  // +X
    { ry: 180, along: 'x', front: -FRONT }, // -Z
    { ry: -90, along: 'z', front: -FRONT }, // -X
  ];

  for (let i = 0; i < NBX; i++) for (let j = 0; j < NBZ; j++) {
    const bx = BLOCK_XS[i], bz = BLOCK_ZS[j];
    const isPark = PARKS.has(i + ',' + j);

    if (isPark) {
      // trees, benches around a small plaza, lamps, a hot dog cart
      for (let t = 0; t < 9; t++) {
        const a = (t / 9) * Math.PI * 2 + rnd() * 0.5, r = 8 + rnd() * 7;
        const tree = await makeStatic('street-tree-0d33f3');
        place(tree, bx + Math.cos(a) * r, 0, bz + Math.sin(a) * r, rnd() * 360, 0.4);
      }
      for (let b = 0; b < 4; b++) {
        const a = b * Math.PI / 2 + Math.PI / 4;
        const bench = await makeStatic('park-bench-dc8b62');
        place(bench, bx + Math.cos(a) * 4.5, 0, bz + Math.sin(a) * 4.5, (a * 180) / Math.PI + 180);
      }
      place(await makeStatic('globe-lamp-346cb6'), bx, 0, bz, 0, 0.35);
      await carve('globe-lamp-346cb6');
      recordGlow('globe-lamp-346cb6', staticList[staticList.length - 1]);
      place(await makeStatic('hot-dog-cart-115192'), bx + 7, 0, bz + 3, -60, 0.9);
      pavementPoints.push(bx + FRONT - 2, bz, bx - FRONT + 2, bz, bx, bz + FRONT - 2, bx, bz - FRONT + 2);
      continue;
    }

    // ---- four street sides of the block: buildings shoulder to shoulder
    const sideIds = [];
    for (let s = 0; s < 4; s++) {
      const S = SIDE[s];
      let cursor = -13;
      let built = 0;
      while (cursor < 13 - 4) {
        const id = pickBuilding();
        const obj = await makeStatic(id);
        obj.rotation.y = (S.ry * Math.PI) / 180;
        obj.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(obj);
        const size = b.getSize(new THREE.Vector3());
        const wAlong = size.x, depth = size.z;
        if (cursor + wAlong > 13 && built > 0) { obj.removeFromParent(); break; }
        const along = bx + cursor + wAlong / 2;
        // position: front face sits on the front line
        let px, pz;
        if (S.along === 'x') { px = along; pz = bz + S.front - Math.sign(S.front) * depth / 2; }
        else { px = bx + S.front - Math.sign(S.front) * depth / 2; pz = along; }
        obj.position.set(px, 0, pz);
        obj.updateMatrixWorld(true);
        staticList.push(obj);
        const fb = new THREE.Box3().setFromObject(obj);
        addCollider({ x0: fb.min.x, x1: fb.max.x, z0: fb.min.z, z1: fb.max.z });
        lastBuilding = id;
        sideIds.push(id);
        await carve(id);
        recordGlow(id, obj);
        built++;
        cursor += wAlong + 0.25;

        // roofline props
        const h = fb.max.y;
        if (h > 10 && rnd() < 0.6) {
          const rid = pick(rnd, ROOFPROPS);
          const rp = await makeStatic(rid);
          const m = Math.min(3, wAlong / 2 - 1);
          place(rp, px + (rnd() * 2 - 1) * m, h, pz + (rnd() * 2 - 1) * (depth / 2 - 1.2), rnd() * 360);
        }
        // pavement point + mission door in front of this building
        if (S.along === 'x') pavementPoints.push(px, bz + Math.sign(S.front) * (FRONT + 2));
        else pavementPoints.push(bx + Math.sign(S.front) * (FRONT + 2), pz);
        if (built === 1 && rnd() < 0.5) {
          if (S.along === 'x') doorPoints.push(new THREE.Vector3(px, 0, bz + Math.sign(S.front) * (FRONT + 2)));
          else doorPoints.push(new THREE.Vector3(bx + Math.sign(S.front) * (FRONT + 2), 0, pz));
        }
      }
    }

    // alley clutter
    if (rnd() < 0.5) {
      const d = await makeStatic('construction-dumpster-2de7ae');
      place(d, bx + (rnd() * 2 - 1) * 8, 0, bz + (rnd() * 2 - 1) * 6, rnd() * 360, 'box');
    }
    if (rnd() < 0.4) {
      const c = await makeStatic('traffic-cone-33e81e');
      place(c, bx + (rnd() * 2 - 1) * 10, 0, bz + (rnd() * 2 - 1) * 8, rnd() * 360);
    }
    if (rnd() < 0.3) {
      const sc = await makeStatic('scaffolding-section-6554c0');
      place(sc, bx + (rnd() * 2 - 1) * 9, 0, bz + (rnd() * 2 - 1) * 7, rnd() < 0.5 ? 0 : 90);
    }
  }

  // ---------------------------------------------------------------- street furniture
  const SMALL = ['fire-hydrant-b68b17', 'mailbox-8e36e8', 'metal-trash-can-f57043',
    'wire-trash-basket-269c1c', 'newspaper-box-3f2c0e', 'bike-rack-a1e7c3',
    'fire-alarm-call-box-56d332', 'sidewalk-bollard-c2567e', 'parking-meter-e9cf71'];

  const lampModule = getModule('street-lamp-136745');
  const trafficModule = getModule('traffic-light-b217a2');
  await carve('street-lamp-136745');
  const recordLamp = (obj) => recordGlow('street-lamp-136745', obj);

  for (const x of STREET_XS) {
    for (let z = CITY.z0 + 9; z < CITY.z1; z += 18) {
      if (nearDist(z, STREET_ZS) < 10) continue;
      for (const side of [-1, 1]) {
        const lx = x + side * (SW / 2 + 0.6);
        const lamp = (await lampModule).createAsset();
        place(lamp, lx, 0, z, side > 0 ? -90 : 90);
        recordLamp(lamp);
        pavementPoints.push(lx + side * 1.5, z);
      }
    }
  }
  for (const z of STREET_ZS) {
    for (let x = CITY.x0 + 9; x < CITY.x1; x += 18) {
      if (nearDist(x, STREET_XS) < 10) continue;
      for (const side of [-1, 1]) {
        const lz = z + side * (SW / 2 + 0.6);
        const lamp = (await lampModule).createAsset();
        place(lamp, x, 0, lz, side > 0 ? 180 : 0);
        recordLamp(lamp);
        pavementPoints.push(x, lz + side * 1.5);
      }
    }
  }

  // street trees + small props along pavements
  const decorate = async (isV, c) => {
    const lineStart = isV ? CITY.z0 + 14 : CITY.x0 + 14;
    const lineEnd = isV ? CITY.z1 : CITY.x1;
    for (let u = lineStart; u < lineEnd; u += 13) {
      const other = isV ? nearDist(u, STREET_ZS) : nearDist(u, STREET_XS);
      if (other < 10) continue;
      for (const side of [-1, 1]) {
        const r = rnd();
        const off = side * (SW / 2 + 2.1);
        const px = isV ? c + off : u;
        const pz = isV ? u : c + off;
        const ry = isV ? (side > 0 ? -90 : 90) : (side > 0 ? 180 : 0);
        if (r < 0.30) place(await makeStatic('street-tree-0d33f3'), px, 0, pz, rnd() * 360, 0.4);
        else if (r < 0.44) {
          const id = pick(rnd, SMALL);
          const heavy = ['fire-hydrant-b68b17', 'mailbox-8e36e8', 'parking-meter-e9cf71'].includes(id);
          place(await makeStatic(id), px, 0, pz, ry, heavy ? 0.35 : 0.5);
        } else if (r < 0.49) {
          place(await makeStatic('newsstand-6dfd65'), px, 0, pz, ry, 1.0);
        } else if (r < 0.54) {
          place(await makeStatic('bus-shelter-f786b4'), px, 0, pz, ry, 'box');
        }
      }
    }
  };
  for (const x of STREET_XS) await decorate(true, x);
  for (const z of STREET_ZS) await decorate(false, z);

  // traffic lights: two diagonal poles per junction
  for (const jx of STREET_XS) for (const jz of STREET_ZS) {
    for (const [sx, sz, ry] of [[1, 1, -135], [-1, -1, 45]]) {
      const tl = (await trafficModule).createAsset();
      place(tl, jx + sx * (SW / 2 + 0.7), 0, jz + sz * (SW / 2 + 0.7), ry, 0.3);
    }
  }

  // landmarks + mission furniture
  const subway1 = await makeStatic('subway-entrance-9ccc8b');
  place(subway1, BLOCK_XS[2] + 12, 0, BLOCK_ZS[1] + FRONT + 2, 0, 'box');
  subways.push(new THREE.Vector3(BLOCK_XS[2] + 12, 0, BLOCK_ZS[1] + FRONT + 2));
  const subway2 = await makeStatic('subway-entrance-9ccc8b');
  place(subway2, BLOCK_XS[0] + FRONT + 2, 0, BLOCK_ZS[3] - 10, 90, 'box');
  subways.push(new THREE.Vector3(BLOCK_XS[0] + FRONT + 2, 0, BLOCK_ZS[3] - 10));

  for (const [px, pz] of [[BLOCK_XS[1] - FRONT - 2, BLOCK_ZS[2] + 8], [BLOCK_XS[3] + FRONT + 2, BLOCK_ZS[0] - 8],
    [BLOCK_XS[4] - 8, BLOCK_ZS[3] + FRONT + 2]]) {
    const ph = await makeStatic('payphone-stand-f97728');
    place(ph, px, 0, pz, rnd() * 360, 0.4);
    payphones.push(new THREE.Vector3(px, 0, pz));
  }
  // dining sheds + vendors on random pavements
  for (let k = 0; k < 6; k++) {
    const bi = Math.floor(rnd() * NBX), bj = Math.floor(rnd() * NBZ);
    if (PARKS.has(bi + ',' + bj)) continue;
    const id = rnd() < 0.5 ? 'curbside-dining-shed-606329' : 'hot-dog-cart-115192';
    const o = await makeStatic(id);
    place(o, BLOCK_XS[bi] + (rnd() * 2 - 1) * 12, 0, BLOCK_ZS[bj] + FRONT + 2, rnd() < 0.5 ? 0 : 180, 0.9);
  }

  // ---------------------------------------------------------------- parked cars (instanced)
  const PARK_WEIGHTS = [
    [VEHICLE_IDS.cab, 24], [VEHICLE_IDS.town, 20], [VEHICLE_IDS.hatch, 26], [VEHICLE_IDS.truck, 10],
    [VEHICLE_IDS.food, 6], [VEHICLE_IDS.garbage, 5], [VEHICLE_IDS.bus, 4], [VEHICLE_IDS.fire, 5],
  ];
  const pickParked = () => {
    let t = 0; for (const [, w] of PARK_WEIGHTS) t += w;
    let r = rnd() * t;
    for (const [id, w] of PARK_WEIGHTS) { r -= w; if (r <= 0) return id; }
    return VEHICLE_IDS.cab;
  };
  // gather candidate spots along streets, then merge per type into InstancedMeshes
  for (const x of STREET_XS) for (let z = CITY.z0 + 12; z < CITY.z1 - 4; z += 7) {
    if (nearDist(z, STREET_ZS) < 11 || rnd() < 0.45) continue;
    for (const side of [-1, 1]) {
      parkedSpots.push({ x: x + side * (SW / 2 - 1.35), z, heading: 0, type: pickParked() });
    }
  }
  for (const z of STREET_ZS) for (let x = CITY.x0 + 12; x < CITY.x1 - 4; x += 7) {
    if (nearDist(x, STREET_XS) < 11 || rnd() < 0.45) continue;
    for (const side of [-1, 1]) {
      parkedSpots.push({ x, z: z + side * (SW / 2 - 1.35), heading: Math.PI / 2, type: pickParked() });
    }
  }

  const byType = new Map();
  for (const s of parkedSpots) (byType.get(s.type) || byType.set(s.type, []).get(s.type)).push(s);
  for (const [type, spots] of byType) {
    const mod = await getModule(type);
    const sample = mod.createAsset();
    const { merged } = mergeAssets([{ object: sample }], { keepDynamic: false });
    sample.removeFromParent();
    if (!merged) continue;
    const geo = merged.isMesh ? merged.geometry : merged.children[0].geometry;
    const mat = merged.isMesh ? merged.material : merged.children[0].material;
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    inst.castShadow = true; inst.receiveShadow = true;
    inst.name = 'parked:' + type;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1);
    spots.forEach((s, i) => {
      E.set(0, s.heading, 0); Q.setFromEuler(E); V.set(s.x, 0, s.z);
      M.compose(V, Q, SC);
      inst.setMatrixAt(i, M);
      s.instance = inst; s.slot = i;
      s.collider = { x: s.x, z: s.z, r: 1.5 };
      addCollider(s.collider);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  // ---------------------------------------------------------------- merge static scenery
  const mergedStatic = [];
  while (staticList.length) {
    const batch = staticList.splice(0, 220);
    const live = batch.filter((o) => !o.userData.tick);
    const { merged, dynamic } = mergeAssets(live.map((o) => ({ object: o, rig: o.userData.rig || {} })), { keepDynamic: false });
    if (merged) mergedStatic.push(merged);
    for (const d of dynamic) mergedStatic.push(d);
    for (const o of live) o.removeFromParent();
  }
  for (const m of mergedStatic) { m.traverse?.((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } }); group.add(m); }

  // ---------------------------------------------------------------- night glow meshes
  const glowMats = [];
  for (const [hex, pts] of glowBuckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const base = new THREE.Color(hex);
    const mat = new THREE.MeshBasicMaterial({ color: base.clone(), toneMapped: false });
    mat.userData.base = base;
    const mesh = new THREE.Mesh(g, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    glowMats.push(mat);
  }
  // lamp pools: one additive mesh of radial discs
  let pools = null, poolsMat = null;
  if (lampPoints.length) {
    const P2 = [], UV = [], C = [], Q = [[-1, -1], [1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]];
    const cc = new THREE.Color();
    lampPoints.slice(0, 400).forEach((l) => {
      const r = clamp(1.6 + l.y * 1.15, 3, 7.5);
      cc.set(l.hex);
      Q.forEach(([a, b], j) => {
        P2.push(l.x + a * r, 0.06, l.z + b * r);
        UV.push((a + 1) / 2, (b + 1) / 2);
        C.push(cc.r, cc.g, cc.b);
      });
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P2, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const ctx = cv.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)'); grad.addColorStop(0.2, 'rgba(255,255,255,0.5)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.18)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    poolsMat = new THREE.MeshBasicMaterial({
      map: tex, vertexColors: true, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    pools = new THREE.Mesh(g, poolsMat);
    pools.renderOrder = 3; pools.frustumCulled = false; pools.visible = false;
    group.add(pools);
  }
  const setNight = (k) => {
    for (const m of glowMats) {
      m.visible = k > 0.02;
      if (m.visible) m.color.copy(m.userData.base).multiplyScalar(k * 1.4);
    }
    if (poolsMat) {
      poolsMat.opacity = k * 0.5;
      pools.visible = k > 0.02;
    }
    return k;
  };
  group.userData.night = setNight;

  // ---------------------------------------------------------------- traffic lanes
  const lanes = [];
  for (const x of STREET_XS) {
    lanes.push({ axis: 'v', offset: x - LANE, dir: 1, c: x });    // +Z traffic on -X lane
    lanes.push({ axis: 'v', offset: x + LANE, dir: -1, c: x });
  }
  for (const z of STREET_ZS) {
    lanes.push({ axis: 'h', offset: z + LANE, dir: 1, c: z });    // +X traffic on +Z lane
    lanes.push({ axis: 'h', offset: z - LANE, dir: -1, c: z });
  }
  const junctions = [];
  for (const x of STREET_XS) for (const z of STREET_ZS) junctions.push({ x, z });

  // ---------------------------------------------------------------- queries
  const blocked = (x, z, r = 0.35) => {
    const items = colliderGrid.query(x, z, r + 2);
    for (const it of items) {
      if (it.on === false) continue;
      if (it.r !== undefined) {
        if (Math.hypot(x - it.x, z - it.z) < r + it.r) return it;
      } else {
        const nx = clamp(x, it.x0, it.x1), nz = clamp(z, it.z0, it.z1);
        if (Math.hypot(x - nx, z - nz) < r) return it;
      }
    }
    return null;
  };

  // player spawn: mid-block pavement near the center
  const spawn = new THREE.Vector3(BLOCK_XS[2] - FRONT - 2, 0, BLOCK_ZS[1] + 6);

  // packages: 10 hidden spots in alleys and quiet corners
  const packageSpots = [];
  for (let tries = 0; tries < 400 && packageSpots.length < 10; tries++) {
    const bi = Math.floor(rnd() * NBX), bj = Math.floor(rnd() * NBZ);
    const x = BLOCK_XS[bi] + (rnd() * 2 - 1) * 14, z = BLOCK_ZS[bj] + (rnd() * 2 - 1) * 14;
    if (blocked(x, z, 0.7)) continue;
    if (packageSpots.some((p) => Math.hypot(p.x - x, p.z - z) < 50)) continue;
    packageSpots.push(new THREE.Vector3(x, 0, z));
  }

  scene.add(group);
  onProgress?.('city built');

  return {
    group, ground, colliders, colliderGrid, blocked, surfaceAt,
    lanes, junctions, parkedSpots,
    pavementPoints, doorPoints, payphones, subways, packageSpots,
    spawn, setNight,
    CITY, STREET_XS, STREET_ZS, PARKS, P, SW, PW,
  };
}
