// Pedestrians: ambient walkers on the pavement, panic fleeing, vehicle impacts.

import * as THREE from 'three';
import { CHARACTERS, spawnCharacter } from './assets.js';
import { angNorm, clamp, rayCircleXZ } from './utils.js';

const WALK = 1.15, RUN = 4.4;

class Ped {
  constructor(ctx, charId, x, z) {
    this.ctx = ctx;
    this.charId = charId;
    this.hp = 30;
    this.state = 'walk';           // walk | flee | dead | passenger
    this.fleeT = 0;
    this.deadT = 0;
    this.passenger = false;
    this.target = new THREE.Vector2(x, z);
    this.vel = new THREE.Vector2();
  }

  async init(x, z) {
    this.char = await spawnCharacter(this.charId);
    this.char.object.position.set(x, 0, z);
    this.ctx.scene.add(this.char.object);
    this.pickTarget();
    return this;
  }

  pos() { return this.char ? this.char.object.position : { x: 0, z: 0 }; }

  pickTarget() {
    if (!this.char) return;
    const pts = this.ctx.world.pavementPoints;
    // nearest few pavement points, pick one 8-40 m away
    let best = null;
    for (let tries = 0; tries < 12; tries++) {
      const i = Math.floor(Math.random() * pts.length / 2) * 2;
      const x = pts[i], z = pts[i + 1];
      const d = Math.hypot(x - this.pos().x, z - this.pos().z);
      if (d > 8 && d < 46 && !this.ctx.world.blocked(x, z, 0.4)) { best = { x, z }; break; }
    }
    if (!best) best = { x: this.pos().x + (Math.random() - 0.5) * 6, z: this.pos().z + (Math.random() - 0.5) * 6 };
    this.target.set(best.x, best.z);
  }

  fleeFrom(x, z) {
    if (this.state === 'dead' || this.passenger) return;
    this.state = 'flee';
    this.fleeT = 5 + Math.random() * 3;
    this.fleeFromPos = new THREE.Vector2(x, z);
  }

  die(fling = null) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deadT = 0;
    this.char.play('Idle', 0.01);
    if (fling) this.vel.copy(fling);
    this.char.object.rotation.z = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2) * 0.9;
    this.char.object.position.y = 0.15;
  }

  damage(n, fromPlayer) {
    if (this.state === 'dead') return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.die();
      if (fromPlayer) this.ctx.police.addCrime(1.2, 'murder');
    } else if (fromPlayer) {
      this.ctx.police.addCrime(0.4, 'shooting');
      this.fleeFrom(this.ctx.player.group.position.x, this.ctx.player.group.position.z);
    }
  }

  update(dt) {
    if (!this.char) return;
    const o = this.char.object;
    if (this.state === 'dead') {
      this.deadT += dt;
      // slide a little if flung
      o.position.x += this.vel.x * dt * Math.max(0, 1 - this.deadT * 2);
      o.position.z += this.vel.y * dt * Math.max(0, 1 - this.deadT * 2);
      this.char.update(dt);
      return;
    }
    if (this.passenger) { this.char.update(dt); return; }

    let speed = WALK;
    if (this.state === 'flee') {
      this.fleeT -= dt;
      if (this.fleeT <= 0) this.state = 'walk';
      const dx = o.position.x - this.fleeFromPos.x, dz = o.position.z - this.fleeFromPos.y;
      const d = Math.hypot(dx, dz) || 1;
      this.target.set(o.position.x + (dx / d) * 12, o.position.z + (dz / d) * 12);
      speed = RUN;
    }

    const dx = this.target.x - o.position.x, dz = this.target.y - o.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1 || this.ctx.world.blocked(o.position.x + (dx / dist) * 0.8, o.position.z + (dz / dist) * 0.8, 0.4)) {
      if (this.state !== 'flee') this.pickTarget();
      else this.target.set(o.position.x + (Math.random() - 0.5) * 8, o.position.z + (Math.random() - 0.5) * 8);
    } else {
      const step = Math.min(speed * dt, dist);
      o.position.x += (dx / dist) * step;
      o.position.z += (dz / dist) * step;
      const want = Math.atan2(dx, dz);
      o.rotation.y += angNorm(want - o.rotation.y) * Math.min(1, dt * 8);
    }
    this.char.locomotion(speed);
    this.char.update(dt);
  }

  dispose() { this.char.dispose(); }
}

export class PedManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.peds = [];
    this.spawnT = 0;
    this.cap = 14;
  }

  spawnOne(nearX, nearZ) {
    const pts = this.ctx.world.pavementPoints;
    for (let tries = 0; tries < 24; tries++) {
      const i = Math.floor(Math.random() * pts.length / 2) * 2;
      const x = pts[i], z = pts[i + 1];
      const d = Math.hypot(x - nearX, z - nearZ);
      if (d < 22 || d > 62 || this.ctx.world.blocked(x, z, 0.45)) continue;
      const id = CHARACTERS.civ[Math.floor(Math.random() * CHARACTERS.civ.length)];
      const ped = new Ped(this.ctx, id, x, z);
      this.peds.push(ped);
      return ped.init(x, z);
    }
    return null;
  }

  /** nearest live ped within r of (x,z) — for cab pickups etc. */
  nearest(x, z, r, excludeState = 'dead') {
    let best = null, bd = r;
    for (const p of this.peds) {
      if (p.state === excludeState || p.passenger) continue;
      const d = Math.hypot(p.pos().x - x, p.pos().z - z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  fleeAt(x, z, r = 16) {
    for (const p of this.peds) {
      if (Math.hypot(p.pos().x - x, p.pos().z - z) < r) p.fleeFrom(x, z);
    }
  }

  /** shooting ray: returns {ped, t, head} or null */
  rayHit(ox, oz, dx, dz, maxT) {
    let best = null;
    for (const p of this.peds) {
      if (p.state === 'dead' || p.passenger) continue;
      const o = p.pos();
      const body = rayCircleXZ(ox, oz, dx, dz, o.x, o.z, 0.42);
      if (body !== null && body < maxT && (best === null || body < best.t)) best = { ped: p, t: body, head: false };
    }
    return best;
  }

  update(dt) {
    const ppos = this.ctx.player.group.position;
    this.spawnT += dt;
    const live = this.peds.filter((p) => p.state !== 'dead').length;
    if (this.spawnT > 0.5 && live < this.cap) { this.spawnT = 0; this.spawnOne(ppos.x, ppos.z); }

    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      // vehicle impacts
      if (p.state !== 'dead' && !p.passenger && p.char) {
        for (const v of this.ctx.traffic.vehicles) {
          const sp = Math.abs(v.speed);
          if (sp < 4) continue;
          const dx = p.pos().x - v.pos.x, dz = p.pos().z - v.pos.y;
          const cos = Math.cos(-v.heading), sin = Math.sin(-v.heading);
          const lx = cos * dx - sin * dz, lz = sin * dx + cos * dz;
          if (Math.abs(lx) < v.l / 2 + 0.3 && Math.abs(lz) < v.w / 2 + 0.25) {
            const fromPlayer = v === this.ctx.player.vehicle;
            p.die(new THREE.Vector2(dx * 2.2, dz * 2.2).normalize().multiplyScalar(6));
            if (fromPlayer) this.ctx.police.addCrime(1.0, 'vehicular manslaughter');
            this.ctx.audio.hurt();
          }
        }
      }
      // despawn
      const d = Math.hypot(p.pos().x - ppos.x, p.pos().z - ppos.z);
      if ((!p.passenger && d > 95) || (p.state === 'dead' && p.deadT > 9)) {
        p.dispose();
        this.peds.splice(i, 1);
        continue;
      }
      p.update(dt);
    }
  }
}
