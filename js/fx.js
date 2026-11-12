// Transient effects: smoke, explosions, tracers, muzzle flashes. Pooled, short-lived.

import * as THREE from 'three';

function discTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class FX {
  constructor(ctx) {
    this.ctx = ctx;
    this.tex = discTexture();
    this.items = [];            // {obj, t, dur, update(item, dt)}
    this.geo = new THREE.PlaneGeometry(1, 1);
  }

  _sprite(color, scale, additive = false) {
    const mat = new THREE.SpriteMaterial({
      map: this.tex, color, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(scale);
    return s;
  }

  smoke(pos, color = 0x666668, big = false) {
    if (this.items.length > 90) return;
    const s = this._sprite(color, big ? 2.6 : 1.4);
    s.position.copy(pos);
    this.ctx.scene.add(s);
    this.items.push({
      obj: s, t: 0, dur: big ? 2.4 : 1.4,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.7, 1.2 + Math.random() * 0.7, (Math.random() - 0.5) * 0.7),
      update(it, dt) {
        it.obj.position.addScaledVector(it.vel, dt);
        it.obj.material.opacity = 0.55 * (1 - it.t / it.dur);
        it.obj.scale.addScalar(dt * 1.6);
        it.obj.material.rotation += dt;
      },
    });
  }

  fire(pos) {
    if (this.items.length > 90) return;
    const s = this._sprite(0xff7818, 1.6, true);
    s.position.copy(pos);
    this.ctx.scene.add(s);
    this.items.push({
      obj: s, t: 0, dur: 0.6,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.6, (Math.random() - 0.5) * 0.6),
      update(it, dt) {
        it.obj.position.addScaledVector(it.vel, dt);
        it.obj.material.opacity = 0.85 * (1 - it.t / it.dur);
      },
    });
  }

  tracer(from, to) {
    const g = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(g, mat);
    this.ctx.scene.add(line);
    this.items.push({
      obj: line, t: 0, dur: 0.07,
      update(it) { it.obj.material.opacity = 0.9 * (1 - it.t / it.dur); },
      cleanup(it) { it.obj.geometry.dispose(); },
    });
  }

  muzzle(pos) {
    const s = this._sprite(0xffd75e, 0.5, true);
    s.position.copy(pos);
    this.ctx.scene.add(s);
    this.items.push({
      obj: s, t: 0, dur: 0.05,
      update(it) { it.obj.material.opacity = 1 - it.t / it.dur; },
    });
  }

  explosion(pos, radius, source) {
    const { scene, audio, player } = this.ctx;
    audio.explosion(pos.distanceTo(player.group.position));
    // flash sphere
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.95, toneMapped: false });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), mat);
    ball.position.copy(pos).y += 0.8;
    scene.add(ball);
    this.items.push({
      obj: ball, t: 0, dur: 0.45,
      update(it, dt) {
        it.obj.scale.addScalar(dt * 16);
        it.obj.material.opacity = 0.95 * (1 - it.t / it.dur);
      },
      cleanup(it) { it.obj.geometry.dispose(); },
    });
    for (let i = 0; i < 10; i++) this.fire(pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2)));
    for (let i = 0; i < 8; i++) this.smoke(pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2)), 0x333336, true);
    // burning wreck: flames + smoke for a while (handled by vehicles via hp; here just the burst)
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.t >= it.dur) {
        it.cleanup?.(it);
        it.obj.removeFromParent();
        if (it.obj.material) it.obj.material.dispose();
        this.items.splice(i, 1);
      } else {
        it.update(it, dt);
      }
    }
  }
}
