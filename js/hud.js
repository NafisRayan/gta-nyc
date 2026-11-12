// HUD: money, stars, health/armor, weapon, rotating minimap, toasts, big overlays.

const MAP_SCALE = 3;          // px per metre on the prerendered map

export class HUD {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = {
      money: document.getElementById('money'),
      stars: document.getElementById('stars'),
      hp: document.getElementById('hpfill'),
      ar: document.getElementById('arfill'),
      weapon: document.getElementById('weapon'),
      mission: document.getElementById('mission'),
      toasts: document.getElementById('toasts'),
      big: document.getElementById('big'),
      bigText: document.getElementById('bigtext'),
      bigSub: document.getElementById('bigsub'),
      map: document.getElementById('minimap'),
      hud: document.getElementById('hud'),
      crosshair: document.getElementById('crosshair'),
      hurt: document.getElementById('hurt'),
      loading: document.getElementById('loading'),
      title: document.getElementById('title'),
      loadfill: document.getElementById('loadfill'),
      loadmsg: document.getElementById('loadmsg'),
    };
    this.mapCtx = this.el.map.getContext('2d');
    this.moneyShown = -1;
  }

  show() { this.el.hud.style.display = 'block'; this.el.crosshair.style.display = 'block'; }

  loading(p, msg) {
    this.el.loadfill.style.width = Math.round(p * 100) + '%';
    if (msg) this.el.loadmsg.textContent = msg;
  }
  showTitle() {
    this.el.loading.style.opacity = '0';
    setTimeout(() => (this.el.loading.style.display = 'none'), 500);
    this.el.title.style.display = 'flex';
  }

  prerenderMap(world) {
    const w = (world.CITY.x1 - world.CITY.x0) + 80, h = (world.CITY.z1 - world.CITY.z0) + 80;
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * MAP_SCALE); cv.height = Math.round(h * MAP_SCALE);
    const g = cv.getContext('2d');
    const X = (x) => (x - world.CITY.x0 + 40) * MAP_SCALE;
    const Z = (z) => (z - world.CITY.z0 + 40) * MAP_SCALE;
    g.fillStyle = '#2e343c'; g.fillRect(0, 0, cv.width, cv.height);
    // blocks
    g.fillStyle = '#3a4048';
    for (let i = 0; i < world.NBX; i++) for (let j = 0; j < world.NBZ; j++) {
      g.fillRect(X(world.CITY.x0 + i * world.P + world.SW / 2), Z(world.CITY.z0 + j * world.P + world.SW / 2),
        (world.P - world.SW) * MAP_SCALE, (world.P - world.SW) * MAP_SCALE);
    }
    // parks
    g.fillStyle = '#3e5a3c';
    for (const key of world.PARKS) {
      const [i, j] = key.split(',').map(Number);
      g.fillRect(X(world.CITY.x0 + i * world.P + world.SW / 2), Z(world.CITY.z0 + j * world.P + world.SW / 2),
        (world.P - world.SW) * MAP_SCALE, (world.P - world.SW) * MAP_SCALE);
    }
    // roads
    g.fillStyle = '#8f979f';
    for (const x of world.STREET_XS) g.fillRect(X(x - world.SW / 2), Z(world.CITY.z0), world.SW * MAP_SCALE, (world.CITY.z1 - world.CITY.z0) * MAP_SCALE);
    for (const z of world.STREET_ZS) g.fillRect(X(world.CITY.x0), Z(z - world.SW / 2), (world.CITY.x1 - world.CITY.x0) * MAP_SCALE, world.SW * MAP_SCALE);
    this.mapImg = cv;
  }

  toast(msg, cls = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + cls;
    t.textContent = msg;
    this.el.toasts.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 2800);
    setTimeout(() => t.remove(), 3300);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  missionText(s) {
    this.el.mission.textContent = s || '';
  }

  big(text, sub, cls = '') {
    this.el.bigText.textContent = text;
    this.el.bigText.className = cls;
    this.el.bigSub.textContent = sub || '';
    this.el.big.style.display = 'flex';
  }
  bigHide() { this.el.big.style.display = 'none'; }

  hurtFlash() {
    this.el.hurt.style.opacity = '1';
    clearTimeout(this._hurtT);
    this._hurtT = setTimeout(() => (this.el.hurt.style.opacity = '0'), 250);
  }

  update(dt) {
    const { player, police, missions } = this.ctx;
    // money
    if (player.money !== this.moneyShown) {
      this.el.money.textContent = '$' + player.money.toLocaleString('en-US');
      if (this.moneyShown >= 0 && player.money > this.moneyShown) {
        this.el.money.classList.remove('bump');
        void this.el.money.offsetWidth;
        this.el.money.classList.add('bump');
      }
      this.moneyShown = player.money;
    }
    // stars
    const s = police.stars;
    let starStr = '';
    for (let i = 0; i < 5; i++) starStr += i < s ? '★' : '<span class="off">★</span>';
    this.el.stars.innerHTML = starStr;
    // bars
    this.el.hp.style.width = Math.max(0, player.hp) + '%';
    this.el.ar.style.width = Math.max(0, player.armor) + '%';
    // weapon
    const w = player.weapons[player.weaponIdx];
    this.el.weapon.innerHTML = `${w.name}<small>${player.state === 'driving' ? 'drive-by' : '∞'}</small>`;
    this.drawMap();
  }

  drawMap() {
    const { player, police, missions, world } = this.ctx;
    const g = this.mapCtx, S = this.el.map.width;   // 420
    const R = S / 2;
    const view = 64 * MAP_SCALE;                     // metres of map shown around the player
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#20242b'; g.fillRect(0, 0, S, S);
    g.translate(R, R);
    g.rotate(player.camYaw);
    const px = (player.group.position.x - world.CITY.x0 + 40) * MAP_SCALE;
    const pz = (player.group.position.z - world.CITY.z0 + 40) * MAP_SCALE;
    g.drawImage(this.mapImg, -px + 0, -pz + 0);
    // blips (drawn in map space, edge-clamped like GTA)
    const blip = (x, z, color, square = false, size = 9) => {
      let bx = (x - world.CITY.x0 + 40) * MAP_SCALE - px;
      let bz = (z - world.CITY.z0 + 40) * MAP_SCALE - pz;
      const d = Math.hypot(bx, bz), max = R - 14;
      if (d > max) { bx = (bx / d) * max; bz = (bz / d) * max; }
      g.fillStyle = color;
      if (square) g.fillRect(bx - size / 2, bz - size / 2, size, size);
      else { g.beginPath(); g.arc(bx, bz, size / 2, 0, Math.PI * 2); g.fill(); }
    };
    for (const b of missions.blips()) blip(b.x, b.z, b.color, b.square, b.square ? 8 : 10);
    for (const c of police.cops) if (!c.dead && c.char) blip(c.pos().x, c.pos().z, '#e04a3a', true, 8);
    for (const v of police.cruisers) if (!v.dead) blip(v.pos.x, v.pos.y, '#e04a3a', true, 10);
    g.restore();
    // player arrow at center
    g.save();
    g.translate(R, R);
    g.fillStyle = '#f2f2f2';
    g.beginPath();
    g.moveTo(0, -9); g.lineTo(6.5, 7); g.lineTo(0, 3.4); g.lineTo(-6.5, 7);
    g.closePath(); g.fill();
    g.restore();
  }
}
