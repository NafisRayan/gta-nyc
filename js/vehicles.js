// Vehicles: arcade physics, wheels from kit rig pivots, traffic AI on lanes,
// police pursuit driving, explosions, parked cars as instanced jack targets.

import * as THREE from 'three';
import { VEHICLE_IDS, getModule } from './assets.js';
import { clamp, damp, dampAngle, angNorm, resolveCircle, rayCircleXZ, rayOBBXZ } from './utils.js';

export const DEFS = {
  [VEHICLE_IDS.cab]:     { name: 'Yellow Cab',   maxF: 26, acc: 11, brake: 26, traffic: true,  tw: 26 },
  [VEHICLE_IDS.town]:    { name: 'Town Car',     maxF: 28, acc: 10, brake: 24, traffic: true,  tw: 20 },
  [VEHICLE_IDS.hatch]:   { name: 'Hatchback',    maxF: 24, acc: 9,  brake: 22, traffic: true,  tw: 26 },
  [VEHICLE_IDS.truck]:   { name: 'Delivery Truck', maxF: 20, acc: 7, brake: 18, traffic: true, tw: 10 },
  [VEHICLE_IDS.garbage]: { name: 'Garbage Truck', maxF: 18, acc: 6, brake: 16, traffic: true,  tw: 5 },
  [VEHICLE_IDS.food]:    { name: 'Food Truck',   maxF: 20, acc: 7, brake: 18, traffic: true,  tw: 6 },
  [VEHICLE_IDS.bus]:     { name: 'City Bus',     maxF: 19, acc: 6,  brake: 15, traffic: true,  tw: 4 },
  [VEHICLE_IDS.fire]:    { name: 'Fire Engine',  maxF: 22, acc: 8,  brake: 18, traffic: true,  tw: 3 },
  [VEHICLE_IDS.police]:  { name: 'Police Cruiser', maxF: 30, acc: 13, brake: 28, traffic: false },
};
const WHEEL_R = 0.34;
const LANE = 1.8;

/** Traffic light phase helper: 9 s cycle, 0 = north-south green, 1 = east-west. */
export const nsGreen = (t) => Math.floor(t / 9) % 2 === 0;

export class Vehicle {
  constructor(ctx, typeId, x, z, heading, role = 'parked') {
    // role: 'player' | 'traffic' | 'police' | 'parked' (parked = temporary live copy of an instanced car)
    this.ctx = ctx;
    this.typeId = typeId;
    this.def = DEFS[typeId] || DEFS[VEHICLE_IDS.cab];
    this.role = role;
    this.pos = new THREE.Vector2(x, z);
    this.heading = heading;
    this.speed = 0;
    this.steer = 0;                 // current steering input (-1..1)
    this.hp = 100;
    this.dead = false;
    this.driver = null;             // 'player' | 'ai' | 'cop' | null
    this.lane = null;               // traffic assignment
    this.turn = null;               // junction turn in progress
    this.waitT = 0;
    this.smoke = 0;
    this.deadT = 0;
    this.lastCrash = 0;

    const mod = ctx.vehicleMods.get(typeId);
    this.model = mod.createAsset();
    this.model.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.material = n.material.clone();        // per-vehicle tint for wrecks
        if (n.geometry?.attributes?.uv === undefined && n.material.map) n.material.map = null;
      }
    });
    // rig pivots
    this.wheels = ['wheel-fr', 'wheel-fl', 'wheel-rr', 'wheel-rl'].map((n) => this.model.getObjectByName(n)).filter(Boolean);
    this.steers = ['steer-fr', 'steer-fl'].map((n) => this.model.getObjectByName(n)).filter(Boolean);
    // dims from bounding box
    const b = new THREE.Box3().setFromObject(this.model);
    this.w = b.max.x - b.min.x;
    this.l = b.max.z - b.min.z;

    // marker lights (visible at night)
    const lightGeo = new THREE.BoxGeometry(0.28, 0.12, 0.05);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff2cf, toneMapped: false });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xe8352c, toneMapped: false });
    this.lightMats = [headMat, tailMat];
    this.lights = [];
    for (const [sx, mat, z] of [[-1, headMat, this.l / 2 - 0.05], [1, headMat, this.l / 2 - 0.05],
      [-1, tailMat, -this.l / 2 + 0.05], [1, tailMat, -this.l / 2 + 0.05]]) {
      const m = new THREE.Mesh(lightGeo, mat);
      m.position.set(sx * (this.w / 2 - 0.35), 0.62, z);
      this.model.add(m);
      this.lights.push(m);
    }
    this.setLights(false);

    this.model.position.set(x, 0, z);
    this.model.rotation.y = heading;
    ctx.scene.add(this.model);
  }

  setLights(on) { for (const l of this.lights) l.visible = on; }

  doorPos() {
    // driver door: left side, slightly behind front axle
    const right = new THREE.Vector2(Math.cos(this.heading), -Math.sin(this.heading));
    return new THREE.Vector2(this.pos.x - right.x * (this.w / 2 + 0.7), this.pos.y - right.y * (this.w / 2 + 0.7));
  }

  forward() { return new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading)); }

  applyDamage(n) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) this.explode();
  }

  explode() {
    if (this.dead) return;
    this.dead = true;
    this.driver = null;
    this.speed = 0;
    this.deadT = 0;
    this.model.traverse((n) => {
      if (n.isMesh && n.material?.color) { n.material.color.setHex(0x181818); }
    });
    for (const m of this.lightMats) m.color.setHex(0x111111);
    this.ctx.fx.explosion(this.model.position, 6.5, this);
    // nearby damage
    const p = this.model.position;
    if (this.ctx.player.alive && this.ctx.player.group.position.distanceTo(p) < 6) {
      this.ctx.player.damage(65, 'explosion');
    }
    this.ctx.traffic.onExplosion(this);
  }

  update(dt, input) {
    const def = this.def;
    // sanitize: a non-finite state (collision ping-pong edge) recovers to the last good spot
    if (!Number.isFinite(this.pos.x) || !Number.isFinite(this.pos.y) || !Number.isFinite(this.speed) || !Number.isFinite(this.heading)) {
      if (this._good) {
        this.pos.copy(this._good.p); this.heading = this._good.h; this.speed = 0;
      } else {
        this.pos.set(0, 0); this.heading = 0; this.speed = 0;
      }
    }
    this._good = { p: this.pos.clone(), h: this.heading };
    if (this.dead) {
      this.deadT += dt;
      return;
    }
    // ---- longitudinal ----
    const braking = input.brake > 0 && this.speed > 0.5;
    if (input.throttle > 0) this.speed += def.acc * input.throttle * dt;
    if (braking) this.speed -= def.brake * dt;
    else if (input.brake > 0 && this.driver !== null) this.speed = Math.max(-9, this.speed - def.brake * 0.6 * dt);
    else if (input.brake > 0) this.speed = 0;               // no driver: brake just holds the car
    if (input.hand) this.speed -= Math.sign(this.speed) * def.brake * 1.2 * dt;
    // drag + rolling resistance
    this.speed -= this.speed * 0.35 * dt + Math.sign(this.speed) * Math.min(Math.abs(this.speed), 1.2 * dt);
    this.speed = clamp(this.speed, -9, def.maxF);

    // ---- steering ----
    this.steer = damp(this.steer, clamp(input.steer, -1, 1), 8, dt);
    const speedFac = clamp(this.speed / 7, -1, 1) / (1 + Math.abs(this.speed) * 0.028);
    const turnRate = (input.hand ? 1.5 : 1.0) * 1.9;
    this.heading += this.steer * turnRate * speedFac * dt * (input.hand ? 1.35 : 1);

    // ---- integrate ----
    const f = this.forward();
    this.pos.x += f.x * this.speed * dt;
    this.pos.y += f.y * this.speed * dt;

    // ---- world collision: two probes ----
    const probes = [
      new THREE.Vector2(this.pos.x + f.x * this.l * 0.32, this.pos.y + f.y * this.l * 0.32),
      new THREE.Vector2(this.pos.x - f.x * this.l * 0.32, this.pos.y - f.y * this.l * 0.32),
    ];
    for (const pr of probes) {
      const items = this.ctx.world.colliderGrid.query(pr.x, pr.y, 3);
      let hit = null;
      for (const it of items) {
        if (it.on === false) continue;
        const before = pr.x + ',' + pr.y;
        if (resolveCircle(pr, this.w * 0.52, it)) hit = it;
      }
      if (hit) {
        const dpx = pr.x - (this.pos.x + f.x * this.l * 0.32), dpy = pr.y - (this.pos.y + f.y * this.l * 0.32);
        this.pos.x += dpx; this.pos.y += dpy;
        const impact = Math.abs(this.speed);
        if (impact > 6 && this.ctx.time - this.lastCrash > 0.4) {
          this.lastCrash = this.ctx.time;
          this.applyDamage(impact * 1.1);
          this.ctx.audio.crash(impact, this.model.position.distanceTo(this.ctx.player.group.position));
          if (this.driver === 'player') this.ctx.player.damage(Math.max(0, (impact - 12) * 1.4), 'crash');
        }
        this.speed *= -0.25;
      }
    }
    // city bounds
    const C = this.ctx.world.CITY;
    this.pos.x = clamp(this.pos.x, C.x0 - 30, C.x1 + 30);
    this.pos.y = clamp(this.pos.y, C.z0 - 30, C.z1 + 30);

    // ---- visuals ----
    this.model.position.set(this.pos.x, 0, this.pos.y);
    this.model.rotation.y = this.heading;
    this.model.rotation.z = damp(this.model.rotation.z, -this.steer * clamp(this.speed / def.maxF, -1, 1) * 0.06, 6, dt);
    for (const w of this.wheels) w.rotation.x += (this.speed * dt) / WHEEL_R;
    for (const s of this.steers) s.rotation.y = damp(s.rotation.y, this.steer * 0.45, 10, dt);

    // smoke when damaged
    if (this.hp < 45 && !this.dead) {
      this.smoke += dt;
      if (this.smoke > 0.18) { this.smoke = 0; this.ctx.fx.smoke(this.model.position.clone().add(new THREE.Vector3(0, 0.9, 0)), this.hp < 20 ? 0x222222 : 0x777777); }
    }
  }

  /** bullet hit test: returns t or null */
  rayHit(ox, oz, dx, dz, maxT) {
    const t = rayOBBXZ(ox, oz, dx, dz, { x: this.pos.x, z: this.pos.y, heading: this.heading, w: this.w, l: this.l });
    return t !== null && t < maxT ? t : null;
  }

  dispose() {
    this.model.removeFromParent();
  }
}

// =====================================================================================
export class TrafficManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.vehicles = [];           // live Vehicle instances (traffic + police + player rides)
    this.targetTraffic = 11;
    this.spawnT = 0;
  }

  spawnTraffic() {
    const { world, player, scene } = this.ctx;
    const lanes = world.lanes.filter((l) => {
      // lane point ~100-140 m from player, inside city
      const px = l.axis === 'v' ? l.offset : clamp(player.group.position.x, world.CITY.x0, world.CITY.x1);
      const pz = l.axis === 'h' ? l.offset : clamp(player.group.position.z, world.CITY.z0, world.CITY.z1);
      const along = l.axis === 'v' ? player.group.position.z : player.group.position.x;
      const d = Math.hypot(px - player.group.position.x, pz - player.group.position.z);
      return d > 55 && d < 150;
    });
    if (!lanes.length) return;
    const lane = lanes[Math.floor(Math.random() * lanes.length)];
    const span = lane.axis === 'v' ? [world.CITY.z0 + 8, world.CITY.z1 - 8] : [world.CITY.x0 + 8, world.CITY.x1 - 8];
    const a = span[0] + Math.random() * (span[1] - span[0]);
    const x = lane.axis === 'v' ? lane.offset : a;
    const z = lane.axis === 'v' ? a : lane.offset;
    const heading = lane.axis === 'v' ? (lane.dir > 0 ? 0 : Math.PI) : (lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    // weighted type
    const pool = Object.entries(DEFS).filter(([, d]) => d.traffic);
    let t = pool.reduce((s, [, d]) => s + d.tw, 0), r = Math.random() * t, id = pool[0][0];
    for (const [vid, d] of pool) { r -= d.tw; if (r <= 0) { id = vid; break; } }
    const v = new Vehicle(this.ctx, id, x, z, heading, 'traffic');
    v.driver = 'ai';
    v.lane = lane;
    // avoid spawning inside another car
    for (const o of this.vehicles) if (o.pos.distanceTo(v.pos) < 8) { v.dispose(); return; }
    this.vehicles.push(v);
  }

  /** steal a parked (instanced) car: hide instance, spawn live vehicle */
  jackParked(spot) {
    const M = new THREE.Matrix4();
    M.makeScale(0.0001, 0.0001, 0.0001);
    M.setPosition(spot.x, -5, spot.z);
    spot.instance.setMatrixAt(spot.slot, M);
    spot.instance.instanceMatrix.needsUpdate = true;
    spot.collider.on = false;
    spot.jacked = true;
    const v = new Vehicle(this.ctx, spot.type, spot.x, spot.z, spot.heading, 'parked');
    this.vehicles.push(v);
    return v;
  }

  add(v) { this.vehicles.push(v); }

  onExplosion(src) {
    for (const v of this.vehicles) {
      if (v === src || v.dead) continue;
      const d = Math.hypot(v.pos.x - src.pos.x, v.pos.y - src.pos.y);
      if (d < 5.5) v.applyDamage(60);
    }
  }

  update(dt, phase) {
    const ctx = this.ctx, player = ctx.player;
    const ppos = player.group.position;

    // traffic population control
    this.spawnT += dt;
    const aiCount = this.vehicles.filter((v) => v.role === 'traffic' && !v.dead).length;
    if (this.spawnT > 0.7 && aiCount < this.targetTraffic) { this.spawnT = 0; this.spawnTraffic(); }

    // despawn far
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      const d = Math.hypot(v.pos.x - ppos.x, v.pos.y - ppos.y);
      const gone = (v.role === 'traffic' && (d > 190 || (v.dead && v.deadT > 9)))
        || (v.role === 'parked' && v.dead && v.deadT > 14 && v !== player.vehicle);
      if (gone && v !== player.vehicle) { v.dispose(); this.vehicles.splice(i, 1); }
    }

    // AI inputs
    for (const v of this.vehicles) {
      let input = { throttle: 0, brake: 0, steer: 0, hand: false };
      if (v === player.vehicle && player.state === 'driving') {
        input = player.vehicleInput;
      } else if (v.driver === 'ai' && !v.dead) {
        input = this.trafficAI(v, dt);
      } else if (v.driver === 'cop' && !v.dead) {
        input = this.policeAI(v, dt);
      } else {
        input = { throttle: 0, brake: 0, steer: 0, hand: true }; // parked/empty: held still
      }
      v.update(dt, input);
    }

    // pairwise vehicle collision
    const act = this.vehicles.filter((v) => !v.dead || v.deadT < 1);
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.y - a.pos.y;
      const d = Math.hypot(dx, dz), min = (a.l + b.l) * 0.30;
      if (!(d <= min) || d < 1e-4) continue;              // also skips NaN distances
      const push = Math.min((min - d) / d * 0.5, 2);
      a.pos.x -= dx * push; a.pos.y -= dz * push;
      b.pos.x += dx * push; b.pos.y += dz * push;
      const closing = Math.abs(a.speed - b.speed);
      if (closing > 9 && ctx.time - a.lastCrash > 0.5) {
        a.lastCrash = b.lastCrash = ctx.time;
        a.applyDamage(closing); b.applyDamage(closing);
        ctx.audio.crash(closing, Math.hypot(a.pos.x - ppos.x, a.pos.y - ppos.y));
        if (a === player.vehicle || b === player.vehicle) {
          player.damage(Math.max(0, (closing - 14) * 0.8), 'crash');
          if (a.driver === 'ai') ctx.police.addCrime(0.4, 'hit traffic');
          if (b.driver === 'ai') ctx.police.addCrime(0.4, 'hit traffic');
        }
      }
      a.speed *= 0.86; b.speed *= 0.86;
    }
  }

  trafficAI(v, dt) {
    const ctx = this.ctx, world = ctx.world;
    const input = { throttle: 0.55, brake: 0, steer: 0, hand: false };
    const cruise = 10 + (v.typeId === VEHICLE_IDS.bus ? -3 : 0);

    // junction turn in progress
    if (v.turn) {
      const T = v.turn;
      T.t += dt / T.dur;
      if (T.t >= 1) {
        v.pos.set(T.p2.x, T.p2.y);
        v.heading = T.h2;
        v.lane = T.lane;
        v.turn = null;
      } else {
        const u = 1 - T.t;
        v.pos.x = u * u * T.p0.x + 2 * u * T.t * T.p1.x + T.t * T.t * T.p2.x;
        v.pos.y = u * u * T.p0.y + 2 * u * T.t * T.p1.y + T.t * T.t * T.p2.y;
        const tx = 2 * u * (T.p1.x - T.p0.x) + 2 * T.t * (T.p2.x - T.p1.x);
        const ty = 2 * u * (T.p1.y - T.p0.y) + 2 * T.t * (T.p2.y - T.p1.y);
        v.heading = Math.atan2(tx, ty);
        input.throttle = 0.4;
        return input;
      }
    }

    // distance along lane to the next junction center
    const isV = v.lane.axis === 'v';
    const along = isV ? v.pos.y : v.pos.x;
    const lat = isV ? v.pos.x : v.pos.y;
    const dirs = world[isV ? 'STREET_ZS' : 'STREET_XS'];
    let nextJ = null, nextD = Infinity;
    for (const c of dirs) {
      const d = (c - along) * v.lane.dir;
      if (d > -3 && d < nextD) { nextD = d; nextJ = c; }
    }

    // red light: stop before the junction
    const green = isV ? nsGreen(ctx.time) : !nsGreen(ctx.time);
    if (!green && nextJ !== null && nextD > 6 && nextD < 16) {
      input.throttle = 0;
      input.brake = nextD < 11 ? 1 : 0.4;
    }

    // obstacle ahead (other vehicles + player car)
    for (const o of this.vehicles) {
      if (o === v) continue;
      const dx = o.pos.x - v.pos.x, dz = o.pos.y - v.pos.y;
      const fwd = dx * Math.sin(v.heading) + dz * Math.cos(v.heading);
      const side = Math.abs(dx * Math.cos(v.heading) - dz * Math.sin(v.heading));
      if (fwd > 0 && fwd < 9 && side < 2.2) {
        input.throttle = Math.min(input.throttle, 0.1);
        if (fwd < 5.5) { input.throttle = 0; input.brake = 1; }
      }
    }
    // player on foot ahead → brake (don't be a monster)
    if (ctx.player.state === 'onFoot' && ctx.player.alive) {
      const dx = ctx.player.group.position.x - v.pos.x, dz = ctx.player.group.position.z - v.pos.y;
      const fwd = dx * Math.sin(v.heading) + dz * Math.cos(v.heading);
      const side = Math.abs(dx * Math.cos(v.heading) - dz * Math.sin(v.heading));
      if (fwd > 0 && fwd < 8 && side < 2) { input.throttle = 0; input.brake = 1; }
    }

    // keep lane laterally
    const wantLat = v.lane.offset;
    const latErr = (isV ? v.pos.x - wantLat : v.pos.y - wantLat) * (isV ? 1 : -1);
    const headingWant = (isV ? (v.lane.dir > 0 ? 0 : Math.PI) : (v.lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2))
      + clamp(latErr * 0.22, -0.35, 0.35);
    input.steer = clamp(angNorm(headingWant - v.heading) * 1.6, -1, 1);
    if (Math.abs(v.speed) > cruise) input.throttle = 0;

    // junction: choose straight / right / left and build a bezier exit
    if (nextJ !== null && nextD < 5 && !v.turn) {
      const jc = nextJ;                                   // crossing street center
      const th = isV ? (v.lane.dir > 0 ? 0 : Math.PI) : (v.lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      const goRight = Math.random() < 0.55;
      const th2 = goRight ? th - Math.PI / 2 : th + Math.PI / 2;
      const newIsV = !isV;
      const dir2 = Math.round(newIsV ? Math.cos(th2) : Math.sin(th2));
      const off2 = jc + (newIsV ? (dir2 > 0 ? -LANE : LANE) : (dir2 > 0 ? LANE : -LANE));
      const newLane = world.lanes.find((l) => l.axis === (newIsV ? 'v' : 'h') && l.dir === dir2
        && Math.abs(l.offset - off2) < 0.01);
      if (newLane) {
        const p0 = { x: v.pos.x, y: v.pos.y };
        const exitAlong = jc + dir2 * 8;
        const p2 = newIsV ? { x: off2, y: exitAlong } : { x: exitAlong, y: off2 };
        const p1 = newIsV ? { x: v.lane.offset, y: off2 } : { x: off2, y: v.lane.offset };
        v.turn = {
          p0, p1, p2, t: 0, dur: 0.85,
          h2: Math.atan2(p2.x - p1.x, p2.y - p1.y),
          lane: newLane,
        };
      }
    }
    return input;
  }

  policeAI(v, dt) {
    const ctx = this.ctx;
    const target = ctx.police.currentTarget(v);
    const input = { throttle: 0.9, brake: 0, steer: 0, hand: false };
    if (!target) { input.throttle = 0; return input; }
    const tx = target.x, tz = target.z;
    const dx = tx - v.pos.x, dz = tz - v.pos.y;
    const dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    // obstacle probe ahead → veer
    const f = v.forward();
    const probeX = v.pos.x + f.x * 7, probeZ = v.pos.y + f.y * 7;
    if (ctx.world.blocked(probeX, probeZ, v.w * 0.6)) {
      const lX = v.pos.x + f.x * 5 - f.y * 4, lZ = v.pos.y + f.y * 5 + f.x * 4;
      const rX = v.pos.x + f.x * 5 + f.y * 4, rZ = v.pos.y + f.y * 5 - f.x * 4;
      const lFree = !ctx.world.blocked(lX, lZ, v.w * 0.6);
      want += lFree ? 0.9 : -0.9;
    }
    input.steer = clamp(angNorm(want - v.heading) * 1.7, -1, 1);
    input.throttle = dist > 7 ? 0.95 : 0.15;
    input.brake = dist < 5 && Math.abs(angNorm(want - v.heading)) > 2.2 ? 1 : 0;
    return input;
  }
}

/** Preload every vehicle module once. */
export async function initVehicles(ctx) {
  for (const id of Object.values(VEHICLE_IDS)) ctx.vehicleMods.set(id, await getModule(id));
}
