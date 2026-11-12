// Polyfork CDN asset access: ES modules for buildings/props/vehicles,
// GLB (with clips) for characters. Everything hotlinks anonymously —
// Polyfork's free tier explicitly allows this, no key needed.

import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

export const CDN = 'https://polyfork.dev/cdn/';

let onProgress = null;               // (done, total, label)
let loaded = 0, total = 0;
export const setProgress = (fn) => { onProgress = fn; };
const tick = (label) => { loaded++; onProgress?.(loaded, total, label); };

// ---- kit ground palette (measured from the kit's tiles) ----
export const PALETTE = {
  asphalt: 0x3f4247,
  asphaltDark: 0x322d2c,
  sidewalk: 0xcfc6b9,
  curb: 0xb2ab9d,
  plaza: 0xb5aea0,
  plazaDark: 0x8d887d,
  grass: 0x7fa356,
  markYellow: 0xe8a825,
  markWhite: 0xd8d5cd,
};

// ---- building / prop / vehicle ids (all from the NYC City Kit) ----
export const BUILDINGS = [
  'auto-repair-garage-b91464', 'classical-bank-04954e', 'brick-church-322885',
  'brownstone-row-house-1b84fd', 'corner-shop-5aec8c', 'corner-tenement-92fb62',
  'department-store-ffbd58', 'street-diner-40fc87', 'fire-station-e2b756',
  'cast-iron-loft-b04b5a', 'movie-theater-40eeef', 'office-tower-1538cc',
  'parking-garage-6e4f2c', 'postwar-apartment-slab-cee5f9', 'prewar-apartment-house-1081a6',
  'public-school-19ade5', 'art-deco-setback-tower-b3a788', 'one-storey-shop-row-83c958',
  'brick-tenement-7d2014', 'narrow-walk-up-41f10c',
];
export const PROPS = [
  'street-lamp-136745', 'traffic-light-b217a2', 'fire-hydrant-b68b17', 'mailbox-8e36e8',
  'newsstand-6dfd65', 'park-bench-dc8b62', 'street-tree-0d33f3', 'bus-shelter-f786b4',
  'hot-dog-cart-115192', 'subway-entrance-9ccc8b', 'manhole-cover-137569', 'parking-meter-e9cf71',
  'newspaper-box-3f2c0e', 'payphone-stand-f97728', 'wire-trash-basket-269c1c', 'metal-trash-can-f57043',
  'bike-rack-a1e7c3', 'globe-lamp-346cb6', 'construction-dumpster-2de7ae', 'traffic-cone-33e81e',
  'sidewalk-bollard-c2567e', 'curbside-dining-shed-606329', 'fire-alarm-call-box-56d332',
  'projecting-shop-sign-aa1867', 'police-barricade-0bbf37', 'scaffolding-section-6554c0',
];
export const ROOFPROPS = [
  'rooftop-water-tower-b38362', 'roof-bulkhead-0f0acc', 'rooftop-ac-unit-6ccb3c',
  'rooftop-billboard-48a23e', 'steam-stack-59baaf',
];
export const CHARACTERS = {
  civ: [
    'commuter-381e7f', 'shopper-d3208f', 'delivery-courier-327e30',
    'doorman-3f2e09', 'construction-worker-c1ad8c', 'street-vendor-139de3', 'firefighter-b13b36',
  ],
  cop: 'police-officer-1cc379',
  player: 'commuter-381e7f',
};
export const VEHICLE_IDS = {
  cab: 'yellow-cab-8df4a0', town: 'town-car-56eeb6', hatch: 'compact-hatchback-386417',
  truck: 'delivery-truck-a9537e', garbage: 'garbage-truck-a7ffbf', food: 'food-truck-3c4e0e',
  bus: 'city-bus-49fd97', fire: 'fire-engine-7d476b', police: 'police-cruiser-a2d25e',
};

// Register how many network resources we expect (rough, for the loading bar)
total = BUILDINGS.length + PROPS.length + ROOFPROPS.length + 9 + 8 + 2; // + vehicle modules + characters + helpers

// ---- ES module cache (createAsset factories) ----
const mods = new Map();
export async function getModule(id) {
  let m = mods.get(id);
  if (!m) {
    m = import(/* @vite-ignore */ CDN + id + '.mjs').then((m) => { tick(id); return m; });
    mods.set(id, m);
  }
  return m;
}

/** Fresh copy of a prop/building/vehicle model (module cached, geometry rebuilt cheaply). */
export async function makeStatic(id) {
  const m = await getModule(id);
  return m.createAsset();
}

/** Cached module + its night zones (albedo defaults read from the public params.json). */
const nightCache = new Map();
export async function getNightZones(id) {
  let z = nightCache.get(id);
  if (z !== undefined) return z;
  z = [];
  try {
    const [m, params] = await Promise.all([
      getModule(id),
      fetch(CDN + id + '-params.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    const night = m.night || params.night || {};
    const defaults = params.params || {};
    for (const [zone, n] of Object.entries(night)) {
      const from = defaults[zone]?.default ?? null;
      if (from == null) continue;                       // zone albedo unknown — skip, never guess
      z.push({
        from: new THREE.Color(from),                    // sRGB parsed to linear by three
        to: new THREE.Color(n.color),
        intensity: n.intensity ?? 1,
        lamp: n.intensity == null ? true : n.intensity >= 0.9,
      });
    }
  } catch { /* offline param fetch — city just glows less */ }
  nightCache.set(id, z);
  return z;
}

// ---- characters: GLB with Idle/Walk/Run clips inside ----
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const loader = new GLTFLoader();

const charCache = new Map();
async function loadCharacter(id) {
  let c = charCache.get(id);
  if (!c) {
    c = new Promise((resolve, reject) => {
      loader.load(CDN + id + '.glb',
        (g) => { tick(id); resolve({ scene: g.scene, clips: g.animations }); },
        undefined, reject);
    });
    charCache.set(id, c);
  }
  return c;
}

/**
 * A live character: cloned skinned mesh + AnimationMixer with locomotion.
 */
export async function spawnCharacter(id) {
  const { scene, clips } = await loadCharacter(id);
  const object = skeletonClone(scene);
  const mixer = new THREE.AnimationMixer(object);
  const actions = {};
  for (const clip of clips) actions[clip.name] = mixer.clipAction(clip);
  let current = null;
  const api = {
    object, actions,
    play(name, fade = 0.18) {
      const next = actions[name];
      if (!next || next === current) return;
      next.reset().play();
      if (current) { next.crossFadeFrom(current, fade, false); }
      current = next;
    },
    /** speed in m/s → Idle / Walk / Run with fade */
    locomotion(speed) {
      const want = speed < 0.3 ? 'Idle' : speed < 3.2 ? 'Walk' : 'Run';
      if (actions[want] && actions[want] !== current) api.play(want);
    },
    update(dt) { mixer.update(dt); },
    dispose() { mixer.stopAllAction(); object.removeFromParent(); },
  };
  if (actions.Idle) api.play('Idle', 0);
  return api;
}
