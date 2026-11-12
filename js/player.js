// Player: third-person controller, camera, shooting, vehicle enter/exit, wasted/busted.

import * as THREE from 'three';
import { CHARACTERS, spawnCharacter } from './assets.js';
import { clamp, damp, dampAngle, angNorm, resolveCircle, Grid } from './utils.js';

const WALK = 2.4, RUN = 5.4;

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.hp = 100;
    this.armor = 0;
    this.money = 500;
    this.alive = true;
    this.state = 'onFoot';        // onFoot | driving | dead | busted
    this.vehicle = null;
    this.weaponIdx = 0;
    this.weapons = [
      { name: 'Pistol', dmg: 26, rate: 0.36, spread: 0.012, auto: false },
      { name: 'SMG', dmg: 13, rate: 0.09, spread: 0.05, auto: true },
    ];
    this.lastShot = 0;
    this.camYaw = 0;
    this.camPitch = 0.28;
    this.camDist = 4.6;
    this.vy = 0;
    this.camPos = new THREE.Vector3();
    this.vehicleInput = { throttle: 0, brake: 0, steer: 0, hand: false };
    this.shake = 0;
    this._prevKeys = new Set();
  }

  async init() {
    this.char = await spawnCharacter(CHARACTERS.player);
    this.group = this.char.object;
    const s = this.ctx.world.spawn;
    this.group.position.set(s.x, 0, s.z);
    this.ctx.scene.add(this.group);
    this.ctx.camera.position.set(s.x, 3, s.z + 6);
    this.camPos.copy(this.ctx.camera.position);
    return this;
  }

  addMoney(n) { this.money = Math.max(0, this.money + n); }

  // -------------------------------------------------- damage & states
  damage(n, src) {
    if (!this.alive) return;
    const absorbed = Math.min(this.armor, n * 0.6);
    this.armor -= absorbed;
    this.hp -= n - absorbed;
    this.ctx.hud.hurtFlash();
    if (src !== 'crash' && src !== 'explosion') this.ctx.audio.hurt();
    if (this.hp <= 0) this.wasted();
  }

  wasted() {
    if (this.state === 'dead') return;
    this.alive = false;
    this.state = 'dead';
    this.hp = 0;
    this.char.play('Idle', 0);
    this.group.rotation.z = Math.PI / 2 * 0.9;
    this.ctx.hud.big('WASTED', 'You wake up at the hospital, lighter by $300.');
    this.ctx.audio.sirenUpdate(false, 1);
    setTimeout(() => this._respawn('$300 hospital bill'), 3000);
  }

  busted() {
    if (this.state !== 'onFoot' && this.state !== 'driving') return;
    this.alive = false;
    this.state = 'busted';
    this._penalty = 250;
    this.ctx.hud.big('BUSTED', 'The cops took $250 and your ammo.', 'blue');
    this.ctx.audio.sirenUpdate(false, 1);
    setTimeout(() => this._respawn(), 3000);
  }

  _respawn() {
    const s = this.ctx.world.spawn;
    this.exitVehicle(true);
    this.group.rotation.z = 0;
    this.group.position.set(s.x, 0, s.z);
    this.hp = 100;
    this.armor = 0;
    this.addMoney(-Math.min(this.money, this._penalty || 300));
    this._penalty = 300;
    this.alive = true;
    this.state = 'onFoot';
    this.ctx.police.clear();
    this.ctx.hud.bigHide();
  }

  // -------------------------------------------------- vehicles
  toggleVehicle() {
    if (this.state === 'driving') { this.exitVehicle(); return; }
    if (this.state !== 'onFoot') return;
    const ctx = this.ctx;
    const pp = this.group.position;
    // live vehicles first
    let best = null, bd = 3.4;
    for (const v of ctx.traffic.vehicles) {
      if (v.dead) continue;
      const door = v.doorPos();
      const d = Math.hypot(door.x - pp.x, door.y - pp.z);
      if (d < bd) { bd = d; best = { v }; }
    }
    // parked instanced spots
    if (!best) {
      for (const spot of ctx.world.parkedSpots) {
        if (spot.jacked) continue;
        const d = Math.hypot(spot.x - pp.x, spot.z - pp.z);
        if (d < bd) { bd = d; best = { spot }; }
      }
    }
    if (!best) return;
    let v = best.v;
    if (best.spot) {
      v = ctx.traffic.jackParked(best.spot);
      ctx.police.addCrime(0.8, 'Grand theft auto');
    } else if (v.driver === 'ai') {
      ctx.police.addCrime(1.0, 'Carjacking');
    } else if (v.driver === 'cop') {
      ctx.police.addCrime(2.0, 'Stealing a cruiser');
    }
    v.driver = 'player';
    this.vehicle = v;
    this.state = 'driving';
    this.group.visible = false;
    ctx.hud.toast(v.def.name);
    // headlight spotlights
    if (!v.spots) {
      v.spots = [];
      for (const sx of [-0.55, 0.55]) {
        const sl = new THREE.SpotLight(0xfff1cf, 0, 55, 0.5, 0.5, 1.4);
        sl.position.set(sx, 0.7, v.l / 2);
        const t = new THREE.Object3D(); t.position.set(sx * 2, 0.1, v.l / 2 + 14);
        v.model.add(sl, t);
        sl.target = t;
        v.spots.push(sl);
      }
    }
  }

  exitVehicle(silent = false) {
    const v = this.vehicle;
    if (!v) return;
    const door = v.doorPos();
    let x = door.x, z = door.y;
    if (this.ctx.world.blocked(x, z, 0.45)) { x = v.pos.x * 2 - x; z = v.pos.y * 2 - z; }   // other side
    this.group.position.set(x, 0, z);
    this.group.visible = true;
    this.state = 'onFoot';
    if (v.driver === 'player') v.driver = null;
    this.vehicle = null;
    if (v.spots) for (const s of v.spots) s.intensity = 0;
  }

  // -------------------------------------------------- shooting
  shoot(input) {
    const ctx = this.ctx;
    const w = this.weapons[this.weaponIdx];
    const now = ctx.time;
    if (now - this.lastShot < w.rate) return;
    if (!w.auto && !input.shootEdge) return;
    if (!input.mouseDown) return;
    this.lastShot = now;

    ctx.audio.shot(0);
    const origin = ctx.camera.position.clone();
    const dir = new THREE.Vector3();
    ctx.camera.getWorldDirection(dir);
    dir.x += (Math.random() - 0.5) * w.spread;
    dir.y += (Math.random() - 0.5) * w.spread;
    dir.z += (Math.random() - 0.5) * w.spread;
    dir.normalize();
    const muzzle = this.group.position.clone().add(new THREE.Vector3(0, this.state === 'driving' ? 1.2 : 1.4, 0));
    ctx.fx.muzzle(muzzle.add(dir.clone().multiplyScalar(0.6)));

    const MAXD = 80;
    // nearest hit: peds, cops, vehicles, static
    let hit = null, hitT = MAXD;
    const ox = origin.x, oz = origin.z, dx = dir.x, dz = dir.z;
    const horizontal = Math.hypot(dx, dz) > 1e-4;
    if (horizontal) {
      const ndx = dx / Math.hypot(dx, dz), ndz = dz / Math.hypot(dx, dz);
      const maxT2 = MAXD / Math.hypot(dx, dz);
      const p = ctx.peds.rayHit(ox, oz, ndx, ndz, maxT2);
      if (p) { const t = p.t * Math.hypot(dx, dz); if (t < hitT) { hitT = t; hit = { kind: 'ped', ped: p.ped }; } }
      const c = ctx.police.rayHit(ox, oz, ndx, ndz, maxT2);
      if (c) { const t = c.t * Math.hypot(dx, dz); if (t < hitT) { hitT = t; hit = { kind: 'cop', cop: c.cop }; } }
      for (const v of ctx.traffic.vehicles) {
        if (v === this.vehicle || v.dead) continue;
        const t = v.rayHit(ox, oz, ndx, ndz, maxT2);
        if (t !== null) { const T = t * Math.hypot(dx, dz); if (T < hitT) { hitT = T; hit = { kind: 'vehicle', vehicle: v }; } }
      }
    }
    // static march
    for (let t = 2; t < MAXD; t += 1.5) {
      if (ctx.world.blocked(origin.x + dx * t, origin.z + dz * t, 0.1)) {
        if (t < hitT) { hitT = t; hit = { kind: 'static' }; }
        break;
      }
    }
    const end = origin.clone().addScaledVector(dir, Math.min(hitT, MAXD));
    ctx.fx.tracer(muzzle, end);

    if (hit) {
      if (hit.kind === 'ped') {
        hit.ped.damage(w.dmg, true);
        ctx.peds.fleeAt(this.group.position.x, this.group.position.z);
      } else if (hit.kind === 'cop') {
        hit.cop.damage(w.dmg);
        ctx.peds.fleeAt(this.group.position.x, this.group.position.z);
      } else if (hit.kind === 'vehicle') {
        hit.vehicle.applyDamage(w.dmg * 0.55);
        if (hit.vehicle.driver === 'ai' || hit.vehicle.role === 'parked') ctx.police.addCrime(0.3, 'Shooting');
        ctx.fx.smoke(end, 0xcccccc);
      }
      if (hit.kind !== 'static') ctx.police.addCrime(0.12, null);
    }
    ctx.peds.fleeAt(origin.x + dx * 6, origin.z + dz * 6, 12);
  }

  // -------------------------------------------------- per-frame
  update(dt, input) {
    const ctx = this.ctx;
    // camera look
    if (input.lookX || input.lookY) this.lastLookT = ctx.time;
    this.camYaw -= input.lookX * 0.0026;
    this.camPitch = clamp(this.camPitch + input.lookY * 0.0026, -0.25, 1.15);
    if (this.state === 'dead' || this.state === 'busted') {
      this.char.update(dt);
      this._camera(dt);
      return;
    }

    if (this.state === 'driving') this._driving(dt, input);
    else this._onFoot(dt, input);

    if (input.mouseDown) this.shoot(input);
    this.char.update(dt);
    this._camera(dt);
    this._prevKeys = new Set(input.keys);
  }

  _onFoot(dt, input) {
    const ctx = this.ctx, keys = input.keys;
    const fx = -Math.sin(this.camYaw), fz = -Math.cos(this.camYaw);      // camera facing
    const rx = -fz, rz = fx;
    let mx = 0, mz = 0;
    if (keys.has('KeyW')) { mx += fx; mz += fz; }
    if (keys.has('KeyS')) { mx -= fx; mz -= fz; }
    if (keys.has('KeyD')) { mx += rx; mz += rz; }
    if (keys.has('KeyA')) { mx -= rx; mz -= rz; }
    const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = mx || mz ? (running ? RUN : WALK) : 0;
    const len = Math.hypot(mx, mz) || 1;
    const p = this.group.position;
    p.x += (mx / len) * speed * dt;
    p.z += (mz / len) * speed * dt;

    // collisions: static
    const p2 = { x: p.x, y: p.z };
    const items = ctx.world.colliderGrid.query(p2.x, p2.y, 1.2);
    for (const it of items) if (it.on !== false) resolveCircle(p2, 0.38, it);
    p.x = p2.x; p.z = p2.y;
    // vehicles (push out of OBBs)
    for (const v of ctx.traffic.vehicles) {
      const dx = p.x - v.pos.x, dz = p.z - v.pos.y;
      if (Math.hypot(dx, dz) > v.l) continue;
      const cos = Math.cos(-v.heading), sin = Math.sin(-v.heading);
      let lx = cos * dx - sin * dz, lz = sin * dx + cos * dz;
      const hx = v.l / 2 + 0.35, hz = v.w / 2 + 0.35;
      if (Math.abs(lx) < hx && Math.abs(lz) < hz) {
        const px2 = hx - Math.abs(lx), pz2 = hz - Math.abs(lz);
        if (px2 < pz2) lx += Math.sign(lx) * px2; else lz += Math.sign(lz) * pz2;
        const cos2 = Math.cos(v.heading), sin2 = Math.sin(v.heading);
        p.x = v.pos.x + (cos2 * lx - sin2 * lz);
        p.z = v.pos.y + (sin2 * lx + cos2 * lz);
        // moving vehicle hurts
        if (Math.abs(v.speed) > 7) this.damage(Math.abs(v.speed) * 1.4, 'crash');
      }
    }

    // jump
    if (keys.has('Space') && p.y <= 0.001) this.vy = 4.6;
    this.vy -= 12 * dt;
    p.y = Math.max(0, p.y + this.vy * dt);
    if (p.y === 0) this.vy = 0;

    // face movement, or camera when firing
    if (speed > 0) {
      const want = Math.atan2(mx, mz);
      this.group.rotation.y += angNorm(want - this.group.rotation.y) * Math.min(1, dt * 10);
    } else if (input.mouseDown) {
      this.group.rotation.y += angNorm(this.camYaw + Math.PI - this.group.rotation.y) * Math.min(1, dt * 12);
    }
    this.char.locomotion(speed);
  }

  _driving(dt, input) {
    const v = this.vehicle;
    if (!v) { this.state = 'onFoot'; return; }
    const keys = input.keys;
    this.vehicleInput.throttle = keys.has('KeyW') ? 1 : 0;
    this.vehicleInput.brake = keys.has('KeyS') ? 1 : 0;
    this.vehicleInput.steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
    this.vehicleInput.hand = keys.has('Space');
    // headlights follow night
    const night = this.ctx.nightK > 0.25;
    v.setLights(night);
    for (const s of v.spots || []) s.intensity = night ? 60 : 0;
  }

  _camera(dt) {
    const ctx = this.ctx, cam = ctx.camera;
    let target, wantYaw = this.camYaw, wantDist = this.camDist, pitch = this.camPitch;
    if (this.state === 'driving' && this.vehicle) {
      const v = this.vehicle;
      target = new THREE.Vector3(v.pos.x, 1.3, v.pos.y);
      const behind = v.heading + Math.PI;
      if (ctx.time - (this.lastLookT ?? -9) > 0.7) this.camYaw = dampAngle(this.camYaw, behind, 2.2, dt);
      wantDist = 8.2 + Math.abs(v.speed) * 0.06;
      pitch = 0.34;
    } else {
      target = this.group.position.clone().add(new THREE.Vector3(0, 1.55, 0));
    }
    const dH = Math.cos(pitch) * wantDist, dV = Math.sin(pitch) * wantDist;
    let ex = target.x + Math.sin(this.camYaw) * dH;
    let ez = target.z + Math.cos(this.camYaw) * dH;
    let ey = target.y + dV;
    // camera collision: march from target outward
    const step = 0.5, n = Math.floor(wantDist / step);
    for (let i = 1; i <= n; i++) {
      const sx = target.x + Math.sin(this.camYaw) * step * i;
      const sz = target.z + Math.cos(this.camYaw) * step * i;
      if (ctx.world.blocked(sx, sz, 0.35)) {
        const f = Math.max(0.3, (step * i - 0.5) / wantDist);
        ex = target.x + Math.sin(this.camYaw) * dH * f;
        ez = target.z + Math.cos(this.camYaw) * dH * f;
        break;
      }
    }
    this.shake = Math.max(0, this.shake - dt * 3);
    this.camPos.set(ex, ey, ez);
    cam.position.lerp(this.camPos, Math.min(1, dt * 10));
    if (this.shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      cam.position.y += (Math.random() - 0.5) * this.shake * 0.5;
    }
    cam.lookAt(target);
  }
}
