// Police: wanted stars, escalating response — foot officers, cruisers, arrests.

import * as THREE from 'three';
import { CHARACTERS, spawnCharacter, VEHICLE_IDS } from './assets.js';
import { angNorm, clamp, rayCircleXZ } from './utils.js';

const STAR_THRESHOLDS = [0.8, 2.2, 4.5, 8, 13];
const FOOT_CAP = [0, 2, 3, 4, 6, 8];
const CAR_CAP = [0, 0, 1, 2, 3, 4];

class Cop {
  constructor(ctx, x, z) {
    this.ctx = ctx;
    this.hp = 45;
    this.shootCd = 0;
    this.state = 'chase';
    this.spawned = (async () => {
      this.char = await spawnCharacter(CHARACTERS.cop);
      this.char.object.position.set(x, 0, z);
      this.ctx.scene.add(this.char.object);
      this.char.play('Run', 0);
    })();
  }

  pos() { return this.char ? this.char.object.position : { x: 0, z: 0 }; }

  damage(n) {
    this.hp -= n;
    if (this.hp <= 0 && this.char) {
      this.ctx.fx.smoke(this.pos().clone().add(new THREE.Vector3(0, 1, 0)), 0x8a1a1a);
      this.ctx.police.addCrime(2, 'cop killer');
      this.dead = true;
    }
  }

  update(dt) {
    if (!this.char) return;
    const ctx = this.ctx, player = ctx.player;
    const o = this.char.object;
    const dx = player.group.position.x - o.position.x, dz = player.group.position.z - o.position.z;
    const dist = Math.hypot(dx, dz);

    if (player.alive) {
      const want = Math.atan2(dx, dz);
      o.rotation.y += angNorm(want - o.rotation.y) * Math.min(1, dt * 9);
      const speed = dist > 1.1 ? 4.4 : 0;
      if (speed > 0) {
        o.position.x += (dx / dist) * speed * dt;
        o.position.z += (dz / dist) * speed * dt;
      }
      this.char.locomotion(speed);
      // shooting at 2+ stars
      this.shootCd -= dt;
      if (ctx.police.stars >= 2 && dist < 26 && this.shootCd <= 0) {
        this.shootCd = 1.6 + Math.random() * 0.9;
        const from = o.position.clone().add(new THREE.Vector3(0, 1.35, 0));
        const hitChance = clamp(0.62 - dist * 0.016, 0.12, 0.62);
        if (Math.random() < hitChance) {
          const to = player.group.position.clone().add(new THREE.Vector3(0, 1.1, 0));
          ctx.fx.tracer(from, to);
          ctx.audio.shot(dist);
          player.damage(7, 'cop');
        } else {
          const to = player.group.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 1.1, (Math.random() - 0.5) * 3));
          ctx.fx.tracer(from, to);
          ctx.audio.shot(dist);
        }
      }
      // arrest attempt below 3 stars
      if (ctx.police.stars > 0 && ctx.police.stars < 3 && dist < 1.5 && player.state === 'onFoot') {
        ctx.police.bustedT += dt;
        if (ctx.police.bustedT > 1.1) player.busted();
      }
    }
    this.char.update(dt);
  }

  dispose() { this.char?.dispose(); }
}

export class Police {
  constructor(ctx) {
    this.ctx = ctx;
    this.heat = 0;
    this.stars = 0;
    this.cops = [];
    this.cruisers = [];
    this.bustedT = 0;
    this.lastCrimeT = -999;
    this.spawnT = 0;
    this.flashT = 0;
  }

  addCrime(n, label) {
    const wasStars = this.stars;
    this.heat += n;
    this.lastCrimeT = this.ctx.time;
    this.updateStars();
    if (this.stars > wasStars) {
      this.ctx.hud.toast(label ? `${label} — wanted level up` : 'Wanted level up', 'police');
    }
  }

  updateStars() {
    let s = 0;
    for (let i = 0; i < STAR_THRESHOLDS.length; i++) if (this.heat >= STAR_THRESHOLDS[i]) s = i + 1;
    this.stars = Math.max(s, 0);
  }

  currentTarget() {
    const p = this.ctx.player;
    return p.vehicle && p.state === 'driving'
      ? { x: p.vehicle.pos.x, z: p.vehicle.pos.y }
      : { x: p.group.position.x, z: p.group.position.z };
  }

  update(dt) {
    const ctx = this.ctx, player = ctx.player;
    const target = this.currentTarget();

    // heat decay: faster with distance from any unit
    const anyNear = [...this.cops, ...this.cruisers].some((u) => {
      const p = u.pos ? u.pos() : { x: u.pos.x, z: u.pos.y };
      return Math.hypot(p.x - target.x, p.z - target.z) < 60;
    });
    if (ctx.time - this.lastCrimeT > 12 && !anyNear && this.heat > 0) this.heat -= dt * 0.55;
    const before = this.stars;
    this.updateStars();
    if (this.stars < before) ctx.hud.toast('Losing the heat…', 'police');

    // spawn control
    this.spawnT += dt;
    if (this.spawnT > 1.2) {
      this.spawnT = 0;
      const liveFoot = this.cops.filter((c) => !c.dead).length;
      const liveCars = this.cruisers.filter((c) => !c.dead).length;
      if (this.stars > 0 && liveFoot < FOOT_CAP[this.stars]) this.spawnFootCop();
      if (this.stars >= 2 && liveCars < CAR_CAP[this.stars]) this.spawnCruiser();
    }
    this.bustedT = Math.max(0, this.bustedT - dt * 0.5);

    // units
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const c = this.cops[i];
      if (c.dead || this.stars === 0) { c.dispose(); this.cops.splice(i, 1); continue; }
      const d = Math.hypot(c.pos().x - target.x, c.pos().z - target.z);
      if (d > 120) { c.dispose(); this.cops.splice(i, 1); continue; }
      c.update(dt);
    }
    for (let i = this.cruisers.length - 1; i >= 0; i--) {
      const v = this.cruisers[i];
      if (v.dead || this.stars === 0) { v.dispose(); this.cruisers.splice(i, 1); continue; }
      const d = Math.hypot(v.pos.x - target.x, v.pos.y - target.z);
      if (d > 150) { v.dispose(); this.cruisers.splice(i, 1); continue; }
      // disgorge officers when close to an on-foot player
      if (this.stars >= 1 && d < 14 && Math.abs(v.speed) < 3 && !v.disgorged) {
        v.disgorged = true;
        for (let k = 0; k < 2; k++) {
          const a = Math.random() * Math.PI * 2;
          this.cops.push(new Cop(ctx, v.pos.x + Math.cos(a) * 2.5, v.pos.y + Math.sin(a) * 2.5));
        }
      }
      // lightbar flash
      this.flashT += dt;
      const on = Math.floor(this.flashT * 5) % 2 === 0;
      if (v.lightbar) {
        v.lightbar[0].visible = on;
        v.lightbar[1].visible = !on;
      }
      // cruiser ram damage to player vehicle
      if (player.vehicle && player.state === 'driving') {
        const pd = Math.hypot(v.pos.x - player.vehicle.pos.x, v.pos.y - player.vehicle.pos.y);
        if (pd < 3.4 && Math.abs(v.speed) > 8 && ctx.time - (v.lastRam || 0) > 1) {
          v.lastRam = ctx.time;
          player.vehicle.applyDamage(9);
          player.damage(4, 'ram');
        }
      }
      // shots from window at 4+
      if (this.stars >= 4 && d < 22) {
        v.shootCd = (v.shootCd ?? 1) - dt;
        if (v.shootCd <= 0) {
          v.shootCd = 1.8 + Math.random();
          ctx.audio.shot(d);
          if (Math.random() < 0.3) player.damage(6, 'cop');
          const from = new THREE.Vector3(v.pos.x, 1.3, v.pos.y);
          const to = player.group.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 1.1, (Math.random() - 0.5) * 2));
          ctx.fx.tracer(from, to);
        }
      }
    }

    // siren audio: any cruiser near
    const siren = this.cruisers.some((v) => !v.dead && Math.hypot(v.pos.x - target.x, v.pos.y - target.z) < 55);
    ctx.audio.sirenUpdate(siren && this.stars >= 2, dt);
  }

  async spawnFootCop() {
    const t = this.currentTarget();
    const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 25;
    const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
    if (this.ctx.world.blocked(x, z, 0.5)) return;
    this.cops.push(new Cop(this.ctx, x, z));
  }

  async spawnCruiser() {
    const ctx = this.ctx, t = this.currentTarget();
    // pick a lane point 70-110 m away
    const lanes = ctx.world.lanes.filter((l) => {
      const px = l.axis === 'v' ? l.offset : t.x, pz = l.axis === 'h' ? l.offset : t.z;
      const along = l.axis === 'v' ? t.z : t.x;
      const d = Math.hypot(px - t.x, pz - t.z);
      return d > 65 && d < 120;
    });
    if (!lanes.length) return;
    const lane = lanes[Math.floor(Math.random() * lanes.length)];
    const span = lane.axis === 'v' ? [ctx.world.CITY.z0 + 10, ctx.world.CITY.z1 - 10] : [ctx.world.CITY.x0 + 10, ctx.world.CITY.x1 - 10];
    const a = span[0] + Math.random() * (span[1] - span[0]);
    const x = lane.axis === 'v' ? lane.offset : a;
    const z = lane.axis === 'v' ? a : lane.offset;
    const heading = lane.axis === 'v' ? (lane.dir > 0 ? 0 : Math.PI) : (lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    const v = new ctx.Vehicle(VEHICLE_IDS.police, x, z, heading, 'police');
    v.driver = 'cop';
    // lightbar: red + blue boxes on the roof
    const g1 = new THREE.BoxGeometry(0.3, 0.12, 0.24), g2 = new THREE.BoxGeometry(0.3, 0.12, 0.24);
    const m1 = new THREE.MeshBasicMaterial({ color: 0xdd2222, toneMapped: false });
    const m2 = new THREE.MeshBasicMaterial({ color: 0x2255dd, toneMapped: false });
    const b1 = new THREE.Mesh(g1, m1), b2 = new THREE.Mesh(g2, m2);
    b1.position.set(-0.28, 1.62, 0.1); b2.position.set(0.28, 1.62, 0.1);
    v.model.add(b1, b2);
    v.lightbar = [b1, b2];
    this.cruisers.push(v);
    ctx.traffic.add(v);
  }

  /** player bullet vs cops: nearest hit */
  rayHit(ox, oz, dx, dz, maxT) {
    let best = null;
    for (const c of this.cops) {
      if (c.dead || !c.char) continue;
      const o = c.pos();
      const t = rayCircleXZ(ox, oz, dx, dz, o.x, o.z, 0.42);
      if (t !== null && t < maxT && (best === null || t < best.t)) best = { cop: c, t };
    }
    return best;
  }

  clear() {
    this.heat = 0;
    this.updateStars();
    for (const c of this.cops) c.dispose();
    for (const v of this.cruisers) v.dispose();
    this.cops = [];
    this.cruisers = [];
  }
}
