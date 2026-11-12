// Missions: taxi fares, payphone courier jobs, 10 hidden packages, health/armor pickups.

import * as THREE from 'three';

function beam(ctx, color) {
  const g = new THREE.CylinderGeometry(1.4, 1.4, 7, 14, 1, true);
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.30, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const b = new THREE.Mesh(g, m);
  b.position.y = 3.5;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.2, 1.9, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  const grp = new THREE.Group();
  grp.add(b, ring);
  grp.visible = false;
  ctx.scene.add(grp);
  return grp;
}

export class Missions {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'none';           // none | farePickup | fareDrop | delivery
    this.marker = beam(ctx, 0xffd75e);
    this.markerTarget = null;     // Vector3
    this.timer = 0;
    this.fareCd = 4;
    this.packageLeft = 10;
    this.passenger = null;
    this.moneyEarned = 0;

    // ---- hidden packages ----
    this.packages = [];
    const boxGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    const boxMat = new THREE.MeshBasicMaterial({ color: 0x35c46a, toneMapped: false });
    for (const p of ctx.world.packageSpots) {
      const m = new THREE.Mesh(boxGeo, boxMat);
      m.position.set(p.x, 0.5, p.z);
      ctx.scene.add(m);
      this.packages.push(m);
    }

    // ---- health / armor pickups ----
    const w = ctx.world;
    const hp = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0xd84848, toneMapped: false }));
    hp.position.set(w.spawn.x + 4, 0.5, w.spawn.z - 6);
    const ar = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0x4c8fd8, toneMapped: false }));
    ar.position.set(w.payphones[0].x + 2, 0.5, w.payphones[0].z + 2);
    this.regen = [
      { mesh: hp, kind: 'health', cd: 0 },
      { mesh: ar, kind: 'armor', cd: 0 },
    ];
    for (const r of this.regen) ctx.scene.add(r.mesh);
  }

  setMarker(pos) {
    this.markerTarget = pos;
    this.marker.position.set(pos.x, 0, pos.z);
    this.marker.visible = true;
  }
  clearMarker() { this.marker.visible = false; this.markerTarget = null; }

  answerPhone() {
    if (this.mode !== 'none') { this.ctx.hud.toast('Finish your current job first'); return; }
    const doors = this.ctx.world.doorPoints;
    const start = doors[Math.floor(Math.random() * doors.length)];
    const end = doors[Math.floor(Math.random() * doors.length)];
    this.mode = 'delivery';
    this.deliveryStage = 0;
    this.delivery = [start, end];
    this.timer = start.distanceTo(end) / 6 + 40;
    this.setMarker(start);
    this.ctx.hud.missionText('Courier: pick up the package.');
    this.ctx.audio.pickup();
  }

  startFare() {
    const doors = this.ctx.world.doorPoints;
    const p = doors[Math.floor(Math.random() * doors.length)];
    this.mode = 'farePickup';
    this.timer = 60;
    this.setMarker(p);
    this.ctx.hud.missionText('Taxi: pick up the fare at the marker.');
  }

  update(dt) {
    const ctx = this.ctx, player = ctx.player;
    const ppos = player.group.position;
    this.marker.children.forEach((c) => { c.rotation.y += dt * 0.8; });

    // hidden packages
    for (let i = this.packages.length - 1; i >= 0; i--) {
      const m = this.packages[i];
      m.rotation.y += dt * 2;
      m.position.y = 0.5 + Math.sin(ctx.time * 2 + i) * 0.08;
      if (ppos.distanceTo(m.position) < 1.4) {
        m.removeFromParent();
        this.packages.splice(i, 1);
        this.packageLeft--;
        player.addMoney(150);
        ctx.audio.pickup();
        ctx.hud.toast(`Hidden package — $150 (${10 - this.packageLeft}/10)`, 'money');
        if (this.packageLeft === 0) {
          player.addMoney(1500);
          ctx.hud.toast('All packages found — $1500 bonus!', 'money');
        }
      }
    }

    // health / armor
    for (const r of this.regen) {
      r.cd -= dt;
      r.mesh.visible = r.cd <= 0;
      r.mesh.rotation.y += dt * 2;
      if (r.mesh.visible && ppos.distanceTo(r.mesh.position) < 1.3 && player.alive) {
        if (r.kind === 'health' && player.hp < 100) { player.hp = 100; r.cd = 60; ctx.audio.pickup(); ctx.hud.toast('Patched up'); }
        if (r.kind === 'armor' && player.armor < 100) { player.armor = 100; r.cd = 60; ctx.audio.pickup(); ctx.hud.toast('Body armor'); }
      }
    }

    // taxi fares: auto-start when driving a cab
    if (this.mode === 'none' && player.state === 'driving' && player.vehicle?.typeId.endsWith('yellow-cab-8df4a0')) {
      this.fareCd -= dt;
      if (this.fareCd <= 0 && Math.abs(player.vehicle.speed) < 2) this.startFare();
    }
    if (this.mode === 'none' && player.state !== 'driving') this.fareCd = Math.max(this.fareCd, 3);

    // mission timers
    if (this.mode !== 'none') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.fail('Out of time');
      }
    }

    // marker proximity
    if (this.markerTarget && player.alive) {
      const near = this.markerTarget.distanceTo(ppos) < 3.4
        || (player.state === 'driving' && Math.hypot(player.vehicle.pos.x - this.markerTarget.x, player.vehicle.pos.y - this.markerTarget.z) < 4.2);
      if (near) this.arrive();
    }
  }

  arrive() {
    const ctx = this.ctx, player = ctx.player;
    if (this.mode === 'delivery' && this.deliveryStage === 0) {
      this.deliveryStage = 1;
      const end = this.delivery[1];
      this.timer = end.distanceTo(player.group.position) / 7 + 35;
      this.setMarker(end);
      ctx.hud.missionText('Courier: deliver the package before the client walks.');
      ctx.audio.pickup();
      return;
    }
    if (this.mode === 'delivery') {
      const pay = 220 + Math.round(this.timer * 2);
      player.addMoney(pay);
      ctx.hud.toast(`Delivery complete — $${pay}`, 'money');
      ctx.hud.missionText(null);
      this.mode = 'none';
      this.clearMarker();
      ctx.audio.pickup();
      return;
    }
    if (this.mode === 'farePickup') {
      // grab a ped as passenger if one is nearby (cosmetic only)
      const ped = ctx.peds.nearest(this.markerTarget.x, this.markerTarget.z, 12);
      if (ped) { ped.passenger = true; ped.char.object.visible = false; this.passenger = ped; }
      const v = player.vehicle;
      const doors = ctx.world.doorPoints;
      // prefer a destination reasonably far away
      let end = doors[Math.floor(Math.random() * doors.length)];
      for (let k = 0; k < 10; k++) {
        const cand = doors[Math.floor(Math.random() * doors.length)];
        if (cand.distanceTo(new THREE.Vector3(v.pos.x, 0, v.pos.y)) > 90) { end = cand; break; }
      }
      this.mode = 'fareDrop';
      this.timer = end.distanceTo(player.group.position) / 6 + 30;
      this.setMarker(end);
      ctx.hud.missionText('Taxi: take the fare to the marker.');
      return;
    }
    if (this.mode === 'fareDrop') {
      const pay = Math.max(60, Math.round(90 + this.timer * 3));
      player.addMoney(pay);
      ctx.hud.toast(`Fare complete — $${pay}`, 'money');
      if (this.passenger) {
        this.passenger.passenger = false;
        this.passenger.char.object.visible = true;
        this.passenger.pickTarget();
        this.passenger = null;
      }
      this.mode = 'none';
      this.fareCd = 10;
      this.clearMarker();
      ctx.hud.missionText(null);
      ctx.audio.pickup();
    }
  }

  fail(why) {
    this.ctx.hud.toast(`Mission failed — ${why}`);
    this.ctx.hud.missionText(null);
    if (this.passenger) {
      this.passenger.passenger = false;
      this.passenger.char.object.visible = true;
      this.passenger = null;
    }
    this.mode = 'none';
    this.clearMarker();
  }

  /** minimap blips */
  blips() {
    const out = [];
    const pp = this.ctx.player.group.position;
    if (this.markerTarget && this.marker.visible) out.push({ x: this.markerTarget.x, z: this.markerTarget.z, color: '#ffd75e' });
    for (const p of this.packages) {
      if (p.position.distanceTo(pp) < 130) out.push({ x: p.position.x, z: p.position.z, color: '#35c46a' });
    }
    for (const ph of this.ctx.world.payphones) out.push({ x: ph.x, z: ph.z, color: '#9ad0ff', square: true });
    return out;
  }
}
