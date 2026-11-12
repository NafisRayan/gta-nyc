// Liberty Shores — an open-world sandbox on the Polyfork NYC City Kit.
// Boot, input, game loop, day/night.

import * as THREE from 'three';
import { stage } from 'https://polyfork.dev/cdn/stage.mjs';
import { setProgress } from './assets.js';
import { buildWorld } from './world.js';
import { initVehicles, TrafficManager, Vehicle, nsGreen } from './vehicles.js';
import { PedManager } from './peds.js';
import { Police } from './police.js';
import { Missions } from './missions.js';
import { HUD } from './hud.js';
import { Player } from './player.js';
import { FX } from './fx.js';
import { AudioSys } from './audio.js';
import { VEHICLE_IDS } from './assets.js';
import { smoothstep } from './utils.js';

// ---- renderer / scene ----
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
} catch {
  document.getElementById('loadmsg').textContent = 'WebGL is not available in this browser.';
  throw new Error('no webgl');
}
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.className = 'game';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2600);

const ctx = {
  scene, camera, renderer,
  time: 0, nightK: 0,
  vehicleMods: new Map(),
  audio: new AudioSys(),
  Vehicle,
  police: null, peds: null, traffic: null, missions: null, hud: null, world: null, player: null,
};
ctx.Vehicle = Vehicle;

const hud = (ctx.hud = new HUD(ctx));
setProgress((done, total, label) => hud.loading(done / total, `Building the city — ${label} (${done}/${total})`));

// ---- world & systems ----
const look = stage(renderer, scene, { time: 'day' });
ctx.world = await buildWorld(scene);
ctx.world.group.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
look.shadows(ctx.world.group);
await initVehicles(ctx);
ctx.traffic = new TrafficManager(ctx);
ctx.fx = new FX(ctx);
ctx.player = await new Player(ctx).init();
ctx.police = new Police(ctx);
ctx.peds = new PedManager(ctx);
ctx.missions = new Missions(ctx);
hud.prerenderMap(ctx.world);

// starter cab parked next to the spawn
const spawn = ctx.world.spawn;
const cab = new Vehicle(ctx, VEHICLE_IDS.cab, spawn.x - 3.5, spawn.z - 3, 0, 'parked');
ctx.traffic.add(cab);
hud.showTitle();

// ---- input ----
const input = {
  keys: new Set(),
  mouseDown: false,
  shootEdge: false,
  lookX: 0, lookY: 0,
};
let playing = false;

addEventListener('keydown', (e) => {
  if (!playing) return;
  if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
  if (!input.keys.has(e.code)) {
    if (e.code === 'KeyF') ctx.player.toggleVehicle();
    if (e.code === 'KeyQ') ctx.player.weaponIdx = (ctx.player.weaponIdx + 1) % ctx.player.weapons.length;
    if (e.code === 'KeyE') {
      const pp = ctx.player.group.position;
      for (const ph of ctx.world.payphones) {
        if (Math.hypot(ph.x - pp.x, ph.z - pp.z) < 2.6) { ctx.missions.answerPhone(); break; }
      }
    }
  }
  input.keys.add(e.code);
});
addEventListener('keyup', (e) => input.keys.delete(e.code));
addEventListener('mousemove', (e) => {
  if (!playing || document.pointerLockElement !== renderer.domElement) return;
  input.lookX += e.movementX;
  input.lookY += e.movementY;
});
addEventListener('mousedown', (e) => {
  if (!playing) return;
  if (document.pointerLockElement !== renderer.domElement) { renderer.domElement.requestPointerLock(); return; }
  if (e.button === 0) { input.mouseDown = true; input.shootEdge = true; }
});
addEventListener('mouseup', (e) => { if (e.button === 0) input.mouseDown = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

document.getElementById('playBtn').addEventListener('click', () => {
  playing = true;
  hud.show();
  document.getElementById('title').style.display = 'none';
  renderer.domElement.requestPointerLock();
  ctx.audio.init();
  ctx.audio.resume();
  hud.toast('Welcome to Liberty Shores');
  hud.missionText('Find the yellow cab. Press F to get in. Payphones start courier jobs.');
});

// ---- loop ----
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!playing) return;
  ctx.time += dt;

  // day/night: a full cycle every four minutes
  const dayT = (0.12 + ctx.time / 240) % 1;
  look.setTime(dayT);
  ctx.nightK = dayT >= 0.8 ? smoothstep(0.80, 0.94, dayT) : dayT < 0.08 ? 1 - dayT / 0.08 : 0;

  input.lookX = 0; input.lookY = 0;

  ctx.player.update(dt, input);
  input.shootEdge = false;
  ctx.traffic.update(dt, nsGreen(ctx.time));
  ctx.police.update(dt);
  ctx.peds.update(dt);
  ctx.missions.update(dt);
  ctx.fx.update(dt);
  look.follow(ctx.player.state === 'driving' && ctx.player.vehicle ? ctx.player.vehicle.model : ctx.player.group);
  look.update();
  ctx.audio.engineUpdate(ctx.player.vehicle ? ctx.player.vehicle.speed : 0, ctx.player.state === 'driving', dt);
  hud.update(dt);

  renderer.render(scene, camera);
});

window.G = ctx;
