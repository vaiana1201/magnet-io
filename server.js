const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));

const W = 3800, H = 3800;
const MAX_HUMANS_PER_ROOM = 25;
const BOT_NAMES = ['Vortex_AI', 'Kaiser_Bot', 'Pulsar_99', 'Quantum_X', 'Glitch_AI', 'Titan_Bot', 'Specter', 'Zephyr_AI', 'Nova_Bot', 'Apex_Unit', 'Helix_Bot', 'Onyx_AI', 'Phantom_AI', 'Chronos_Bot', 'Aura_Unit', 'Cyber_Wraith', 'Echo_Unit', 'Void_Stalker'];

// ================= PERSISTANCE DATABASE =================
const DB_FILE = path.join(__dirname, 'database.json');
let db = { users: {} };

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
    } else {
      saveDatabase();
    }
  } catch (err) {
    console.error("Erreur lecture DB:", err);
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error("Erreur écriture DB:", err);
  }
}
loadDatabase();

let rooms = {};

const SKINS_DEFAULTS = [
  { id:'classic', name:'Néodyme', col1:'#ff4d6d', col2:'#4cc9f0' },
  { id:'ferrite', name:'Ferrite', col1:'#e63946', col2:'#457b9d' },
  { id:'cyber', name:'Cyberpunk', col1:'#f72585', col2:'#7209b7' },
  { id:'toxic', name:'Toxique', col1:'#38b000', col2:'#9ef01a' },
  { id:'gold', name:'Or Prestige', col1:'#ffd166', col2:'#ffffff' }
];

function radiusOf(p) { return 14 + Math.sqrt(p.mass) * 2.35; }
function speedOf(p) {
  let s = Math.max(165, 340 / Math.pow(1 + p.mass / 220, 0.36));
  if (p.speedBoostTimer > 0) s *= 1.85;
  if (p.dashActiveTimer > 0) s *= 2.2;
  return s;
}

function initRoomData(roomId, isBR = false) {
  const parts = [];
  for (let i = 0; i < 450; i++) {
    parts.push({
      id: 'p_' + i,
      x: Math.random() * (W - 200) + 100,
      y: Math.random() * (H - 200) + 100,
      vx: 0, vy: 0,
      pol: Math.random() < 0.5 ? 1 : -1
    });
  }

  const anomalies = [
    { id: 'anom_1', x: W / 2, y: H / 2, radius: 240, type: 'blackhole', force: 400, rot: 0, alive: true },
    { id: 'anom_2', x: W * 0.25, y: H * 0.28, radius: 210, type: 'repulsor', force: 1500, rot: 0, alive: true },
    { id: 'anom_3', x: W * 0.75, y: H * 0.72, radius: 210, type: 'repulsor', force: 1500, rot: 0, alive: true }
  ];

  const powerups = [];
  for (let i = 0; i < 20; i++) {
    powerups.push({
      id: 'pw_' + i,
      x: Math.random() * (W - 400) + 200,
      y: Math.random() * (H - 400) + 200,
      type: Math.random() < 0.5 ? 'speed' : 'magnet',
      alive: true
    });
  }

  return {
    id: roomId,
    isBR: isBR,
    brState: isBR ? 'waiting' : 'active',
    brTimer: 20.0,
    brZoneRadius: W * 0.68,
    brZoneX: W / 2,
    brZoneY: H / 2,
    players: {},
    bots: {},
    parts,
    anomalies,
    powerups,
    wipeCooldown: 0
  };
}

function findOrCreateDynamicRoom(requested) {
  const req = requested.toUpperCase();

  if (req === 'BATTLE_ROYALE') {
    let brIdx = 1;
    while (true) {
      const brId = `BR-${brIdx}`;
      if (!rooms[brId]) {
        rooms[brId] = initRoomData(brId, true);
        return rooms[brId];
      }
      if (rooms[brId].brState === 'waiting' && Object.keys(rooms[brId].players).length < 25) {
        return rooms[brId];
      }
      brIdx++;
    }
  }

  if (req !== 'GLOBAL') {
    if (!rooms[req]) rooms[req] = initRoomData(req, false);
    return rooms[req];
  }

  let index = 1;
  while (true) {
    const candidateId = `GLOBAL-${index}`;
    if (!rooms[candidateId]) {
      rooms[candidateId] = initRoomData(candidateId, false);
      return rooms[candidateId];
    }
    const realPlayerCount = Object.values(rooms[candidateId].players).filter(p => p.alive).length;
    if (realPlayerCount < MAX_HUMANS_PER_ROOM) {
      return rooms[candidateId];
    }
    index++;
  }
}

function getSafeSpawn(room) {
  const allEnts = [...Object.values(room.players), ...Object.values(room.bots)].filter(e => e.alive);
  for (let attempts = 0; attempts < 40; attempts++) {
    const sx = Math.random() * (W - 800) + 400;
    const sy = Math.random() * (H - 800) + 400;
    let safe = true;

    for (const a of room.anomalies) {
      if (a.alive && Math.hypot(sx - a.x, sy - a.y) < a.radius + 350) { safe = false; break; }
    }
    if (!safe) continue;

    for (const e of allEnts) {
      if (Math.hypot(sx - e.x, sy - e.y) < radiusOf(e) + 400) { safe = false; break; }
    }

    if (safe) return { x: sx, y: sy };
  }
  return { x: Math.random() * (W - 800) + 400, y: Math.random() * (H - 800) + 400 };
}

function createBot(room, name) {
  const spawn = getSafeSpawn(room);
  const skin = SKINS_DEFAULTS[Math.floor(Math.random() * SKINS_DEFAULTS.length)];
  return {
    id: 'bot_' + Math.random().toString(36).substr(2, 9),
    name: name,
    isBot: true,
    skin: skin,
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0,
    tx: spawn.x, ty: spawn.y,
    mass: 22 + Math.random() * 35,
    pol: Math.random() < 0.5 ? 1 : -1,
    cool: 0,
    dashCooldown: 0,
    dashActiveTimer: 0,
    speedBoostTimer: 0,
    magnetBoostTimer: 0,
    spawnInvincible: 5.0,
    blackHoleTime: 0,
    aiTimer: 0.2,
    skill: 0.65 + Math.random() * 0.25,
    alive: true
  };
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let userAccount = null;

  socket.on('accountRegister', (data) => {
    const u = data.username ? data.username.trim() : '';
    const p = data.password ? data.password.trim() : '';
    if (!u || !p) return socket.emit('accountError', "Identifiants invalides.");
    if (db.users[u.toLowerCase()]) return socket.emit('accountError', "Ce pseudo est déjà pris.");

    db.users[u.toLowerCase()] = {
      username: u,
      password: p,
      isAdmin: (u.toLowerCase() === 'admin' && p === 'admin'),
      coins: 250,
      level: 1,
      xp: 0,
      bestScore: 0,
      unlockedSkins: ['classic'],
      activeSkin: 'classic'
    };
    saveDatabase();
    userAccount = db.users[u.toLowerCase()];
    socket.emit('accountSuccess', { user: userAccount, msg: "Compte créé ! (+250 🪙)" });
  });

  socket.on('accountLogin', (data) => {
    const u = data.username ? data.username.trim().toLowerCase() : '';
    const p = data.password ? data.password.trim() : '';
    const acc = db.users[u];
    if (acc && acc.password === p) {
      userAccount = acc;
      socket.emit('accountSuccess', { user: userAccount, msg: `Ravi de te revoir, ${acc.username} !` });
    } else {
      socket.emit('accountError', "Pseudo ou mot de passe incorrect.");
    }
  });

  socket.on('syncProfile', (data) => {
    if (userAccount && db.users[userAccount.username.toLowerCase()]) {
      const acc = db.users[userAccount.username.toLowerCase()];
      if (typeof data.coins === 'number') acc.coins = data.coins;
      if (typeof data.level === 'number') acc.level = data.level;
      if (typeof data.xp === 'number') acc.xp = data.xp;
      if (typeof data.bestScore === 'number') acc.bestScore = Math.max(acc.bestScore, data.bestScore);
      if (Array.isArray(data.unlockedSkins)) acc.unlockedSkins = data.unlockedSkins;
      if (data.activeSkin) acc.activeSkin = data.activeSkin;
      saveDatabase();
    }
  });

  socket.on('joinGame', (data) => {
    if (currentRoomId && rooms[currentRoomId] && rooms[currentRoomId].players[socket.id]) {
      delete rooms[currentRoomId].players[socket.id];
      socket.leave(currentRoomId);
    }

    const requestedRoom = (data.roomId && data.roomId.trim()) ? data.roomId.trim().toUpperCase() : 'GLOBAL';
    const room = findOrCreateDynamicRoom(requestedRoom);
    currentRoomId = room.id;
    socket.join(currentRoomId);

    const spawn = getSafeSpawn(room);

    room.players[socket.id] = {
      id: socket.id,
      name: data.name || 'Pilote',
      isAdmin: !!data.isAdmin,
      isBot: false,
      skin: data.skin || SKINS_DEFAULTS[0],
      x: spawn.x, y: spawn.y,
      vx: 0, vy: 0,
      tx: spawn.x, ty: spawn.y,
      mass: data.isAdmin ? 2500 : 24,
      pol: 1,
      cool: 0,
      dashCooldown: 0,
      dashActiveTimer: 0,
      speedBoostTimer: 0,
      magnetBoostTimer: 0,
      spawnInvincible: 5.0,
      blackHoleTime: 0,
      alive: true
    };

    socket.emit('joinedRoom', {
      roomId: currentRoomId,
      isBR: room.isBR,
      isAdmin: !!data.isAdmin
    });
  });

  socket.on('leaveGame', () => {
    if (currentRoomId && rooms[currentRoomId] && rooms[currentRoomId].players[socket.id]) {
      delete rooms[currentRoomId].players[socket.id];
    }
  });

  socket.on('input', (data) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const p = rooms[currentRoomId].players[socket.id];
    if (p && p.alive) { p.tx = data.tx; p.ty = data.ty; }
  });

  socket.on('togglePol', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const p = rooms[currentRoomId].players[socket.id];
    if (p && p.alive && p.cool <= 0) {
      p.pol = -p.pol;
      p.cool = 5.0;
    }
  });

  socket.on('performDash', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId];
    const p = room.players[socket.id];
    if (p && p.alive && p.dashCooldown <= 0 && p.mass > 16) {
      p.mass -= Math.max(1, p.mass * 0.03);
      p.dashCooldown = 3.0;
      p.dashActiveTimer = 0.35;
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy) || 1;
      p.vx = (dx / d) * (speedOf(p) + 750);
      p.vy = (dy / d) * (speedOf(p) + 750);
      io.to(currentRoomId).emit('playerDashed', { id: socket.id, x: p.x, y: p.y });
    }
  });

  socket.on('ejectMass', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId];
    const p = room.players[socket.id];
    if (p && p.alive && p.mass > 24) {
      p.mass -= 2;
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const r = radiusOf(p);
      room.parts.push({
        id: 'feed_' + Math.random().toString(36).substr(2, 8),
        x: p.x + (dx / d) * (r + 20),
        y: p.y + (dy / d) * (r + 20),
        vx: (dx / d) * 350,
        vy: (dy / d) * 350,
        pol: p.pol
      });
      io.to(currentRoomId).emit('massEjected', { x: p.x, y: p.y });
    }
  });

  socket.on('sendEmote', (data) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const p = rooms[currentRoomId].players[socket.id];
    if (p && p.alive) {
      io.to(currentRoomId).emit('playerEmoted', { id: p.id, emote: data.emote });
    }
  });

  socket.on('adminGiveMass', (data) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const p = rooms[currentRoomId].players[socket.id];
    if (p && p.alive && p.isAdmin) {
      p.mass = Math.max(20, p.mass + (data.amount || 500));
      io.to(currentRoomId).emit('adminMassGift', { id: p.id, mass: p.mass, added: data.amount });
    }
  });

  socket.on('adminTriggerFourCorners', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const p = rooms[currentRoomId].players[socket.id];
    if (p && p.alive && p.isAdmin) {
      p.x = W / 2; p.y = H / 2;
      p.mass = 660000;
      p.vx = 0; p.vy = 0;
    }
  });

  socket.on('disconnect', () => {
    if (currentRoomId && rooms[currentRoomId] && rooms[currentRoomId].players[socket.id]) {
      delete rooms[currentRoomId].players[socket.id];
    }
  });
});

function updateBotAI(b, room, dt) {
  b.aiTimer -= dt;
  if (b.aiTimer > 0) return;
  b.aiTimer = 0.2 + (1 - b.skill) * 0.25;

  const allEnts = [...Object.values(room.players), ...Object.values(room.bots)].filter(e => e.alive);
  let threat = null, minTD = 550;
  let prey = null, minPD = 580;

  for (const o of allEnts) {
    if (o === b || !o.alive) continue;
    const d = Math.hypot(o.x - b.x, o.y - b.y);
    if (o.mass > b.mass * 1.25 && d < minTD && o.spawnInvincible <= 0) { threat = o; minTD = d; }
    if (o.mass * 1.25 < b.mass && d < minPD && o.spawnInvincible <= 0) { prey = o; minPD = d; }
  }

  if (room.isBR && room.brState === 'active') {
    const distToCenter = Math.hypot(b.x - room.brZoneX, b.y - room.brZoneY);
    if (distToCenter > room.brZoneRadius * 0.85) {
      b.tx = room.brZoneX;
      b.ty = room.brZoneY;
      return;
    }
  }

  if (threat) {
    const dx = b.x - threat.x, dy = b.y - threat.y, d = Math.hypot(dx, dy) || 1;
    b.tx = b.x + (dx / d) * 400;
    b.ty = b.y + (dy / d) * 400;
    if (b.pol !== threat.pol && b.cool <= 0 && Math.random() < b.skill) {
      b.pol = -b.pol; b.cool = 5.0;
    }
    if (minTD < 240 && b.dashCooldown <= 0 && b.mass > 18 && Math.random() < 0.4) {
      b.mass -= Math.max(1, b.mass * 0.03);
      b.dashCooldown = 3.0;
      b.dashActiveTimer = 0.35;
      b.vx = (dx / d) * (speedOf(b) + 750);
      b.vy = (dy / d) * (speedOf(b) + 750);
      io.to(room.id).emit('playerDashed', { id: b.id, x: b.x, y: b.y });
    }
  } else if (prey) {
    b.tx = prey.x; b.ty = prey.y;
    if (b.pol === prey.pol && b.cool <= 0 && Math.random() < b.skill) {
      b.pol = -b.pol; b.cool = 5.0;
    }
  } else {
    let closestP = null, minD = 400;
    for (const p of room.parts) {
      if (p.pol === b.pol) {
        const d = Math.hypot(p.x - b.x, p.y - b.y);
        if (d < minD) { minD = d; closestP = p; }
      }
    }
    if (closestP) { b.tx = closestP.x; b.ty = closestP.y; }
  }

  const pad = 240;
  if (b.x < pad) b.tx = b.x + 350;
  if (b.x > W - pad) b.tx = b.x - 350;
  if (b.y < pad) b.ty = b.y + 350;
  if (b.y > H - pad) b.ty = b.y - 350;
}

const SERVER_TICKRATE = 60;
const dt = 1 / SERVER_TICKRATE;

setInterval(() => {
  for (const rId in rooms) {
    const room = rooms[rId];
    if (room.wipeCooldown > 0) room.wipeCooldown -= dt;

    const livePlayers = Object.values(room.players).filter(p => p.alive);
    const liveBots = Object.values(room.bots).filter(b => b.alive);

    if (room.isBR) {
      if (room.brState === 'waiting') {
        room.brTimer -= dt;
        if (room.brTimer <= 0 || livePlayers.length >= 25) {
          room.brState = 'active';
          room.brTimer = 0;
          const targetBots = Math.max(10, 25 - livePlayers.length);
          for (let k = 0; k < targetBots; k++) {
            const bName = BOT_NAMES[k % BOT_NAMES.length];
            const bot = createBot(room, bName);
            room.bots[bot.id] = bot;
          }
          io.to(room.id).emit('brMatchStarted', { totalAlive: livePlayers.length + targetBots });
        }
      } else if (room.brState === 'active') {
        if (room.brZoneRadius > 180) room.brZoneRadius -= dt * 28;

        const totalAlive = livePlayers.length + liveBots.length;
        if (totalAlive === 1 && livePlayers.length === 1 && room.brState !== 'ended') {
          room.brState = 'ended';
          const winner = livePlayers[0];
          io.to(winner.id).emit('brVictory', { rewardCoins: 5000 });
        }
      }
    } else {
      const neededBots = Math.max(0, MAX_HUMANS_PER_ROOM - (livePlayers.length + liveBots.length));
      for (let k = 0; k < neededBots; k++) {
        const bName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        const bot = createBot(room, bName);
        room.bots[bot.id] = bot;
      }
    }

    const allEntities = [...livePlayers, ...Object.values(room.bots).filter(b => b.alive)];

    let topLeaderId = null;
    let maxMass = 0;
    for (const e of allEntities) {
      if (e.mass > maxMass) {
        maxMass = e.mass;
        topLeaderId = e.id;
      }
    }

    for (const e of allEntities) {
      e.isSlowed = false;
      if (e.cool > 0) e.cool -= dt;
      if (e.dashCooldown > 0) e.dashCooldown -= dt;
      if (e.dashActiveTimer > 0) e.dashActiveTimer -= dt;
      if (e.speedBoostTimer > 0) e.speedBoostTimer -= dt;
      if (e.magnetBoostTimer > 0) e.magnetBoostTimer -= dt;
      if (e.spawnInvincible > 0) e.spawnInvincible -= dt;

      if (e.isBot) updateBotAI(e, room, dt);

      const r = radiusOf(e);

      if (room.isBR && room.brState === 'active') {
        const distToCenter = Math.hypot(e.x - room.brZoneX, e.y - room.brZoneY);
        if (distToCenter > room.brZoneRadius) {
          e.mass -= Math.max(1.5, e.mass * 0.08 * dt);
          if (e.mass < 12) {
            e.alive = false;
            if (!e.isBot) io.to(e.id).emit('youDied', { killer: 'la Tempête Toxique', mass: Math.floor(e.mass) });
            else delete room.bots[e.id];
            continue;
          }
        }
      }

      for (const pw of room.powerups) {
        if (!pw.alive) continue;
        const d = Math.hypot(e.x - pw.x, e.y - pw.y);
        if (d < r + 24) {
          pw.alive = false;
          if (pw.type === 'speed') {
            e.speedBoostTimer = 4.5;
            if (!e.isBot) io.to(e.id).emit('boostPicked', { type: 'speed', text: '⚡ SPEED BOOST (4.5s) !' });
          } else {
            e.magnetBoostTimer = 6.0;
            if (!e.isBot) io.to(e.id).emit('boostPicked', { type: 'magnet', text: '🧲 HYPER AIMANT (6s) !' });
          }
          setTimeout(() => {
            pw.x = Math.random() * (W - 400) + 200;
            pw.y = Math.random() * (H - 400) + 200;
            pw.alive = true;
          }, 10000);
        }
      }

      for (const a of room.anomalies) {
        if (!a.alive) continue;
        const dx = e.x - a.x, dy = e.y - a.y;
        const d = Math.hypot(dx, dy) || 1;

        if (r >= a.radius * 1.5 && d < r) {
          a.alive = false;
          e.mass += 1000;
          io.to(room.id).emit('anomalyEaten', { anomId: a.id, eaterId: e.id, eaterName: e.name, type: a.type, x: a.x, y: a.y });
          setTimeout(() => {
            const newPos = getSafeAnomalySpawn(room);
            a.x = newPos.x; a.y = newPos.y; a.alive = true;
          }, 12000);
          continue;
        }

        if (a.type === 'repulsor' && d < a.radius) {
          const factor = 1 - d / a.radius;
          e.vx = (dx / d) * (1500 * factor);
          e.vy = (dy / d) * (1500 * factor);
        }

        if (a.type === 'blackhole') {
          if (d < a.radius * 2.0 && d > 12) {
            const pull = (a.force / (d + 120)) * 260;
            e.vx -= (dx / d) * pull * dt;
            e.vy -= (dy / d) * pull * dt;
          }
          if (d < a.radius * 0.30) {
            e.blackHoleTime += dt;
            if (e.blackHoleTime >= 5.0) {
              e.blackHoleTime = 0;
              e.mass -= Math.max(2, e.mass * 0.10);
              io.to(room.id).emit('blackHoleZap', { id: e.id, x: e.x, y: e.y });
              if (e.mass < 10) {
                e.alive = false;
                if (!e.isBot) io.to(e.id).emit('youDied', { killer: 'le Trou Noir', mass: Math.floor(e.mass) });
                else delete room.bots[e.id];
              }
            }
          } else {
            e.blackHoleTime = 0;
          }
        }
      }

      const dx = e.tx - e.x, dy = e.ty - e.y;
      const d = Math.hypot(dx, dy);
      let spd = speedOf(e);
      if (e.isSlowed) spd *= 0.60;

      let ax = 0, ay = 0;
      if (d > 8) {
        const f = Math.min(1, d / 120);
        ax = (dx / d) * spd * f;
        ay = (dy / d) * spd * f;
      }

      const isAcc = e.dashActiveTimer > 0 || Math.hypot(e.vx, e.vy) > spd * 1.2;
      const turnFactor = isAcc ? 2.2 : Math.max(3.0, 6.2 - Math.sqrt(e.mass) * 0.04);

      e.vx += (ax - e.vx) * Math.min(1, dt * turnFactor);
      e.vy += (ay - e.vy) * Math.min(1, dt * turnFactor);
      e.x += e.vx * dt;
      e.y += e.vy * dt;

      if (r < W / 2) {
        if (e.x - r < 0) { e.x = r; if (e.vx < 0) e.vx = 0; }
        if (e.x + r > W) { e.x = W - r; if (e.vx > 0) e.vx = 0; }
        if (e.y - r < 0) { e.y = r; if (e.vy < 0) e.vy = 0; }
        if (e.y + r > H) { e.y = H - r; if (e.vy > 0) e.vy = 0; }
      } else {
        e.x = W / 2; e.y = H / 2;
      }

      if (e.mass > 80 && e.mass < 500000) e.mass -= (e.mass - 80) * 0.00004 * dt;

      const magnetRange = r * (e.magnetBoostTimer > 0 ? 5.2 : 2.8);

      for (let k = room.parts.length - 1; k >= 0; k--) {
        const part = room.parts[k];
        const pdx = e.x - part.x, pdy = e.y - part.y;
        const pdist = Math.hypot(pdx, pdy);

        if (pdist < magnetRange && part.pol === e.pol) {
          const pullSpeed = 480 + (1 - pdist / magnetRange) * 550;
          part.vx = (pdx / pdist) * pullSpeed;
          part.vy = (pdy / pdist) * pullSpeed;
          part.x += part.vx * dt;
          part.y += part.vy * dt;
        }

        if (pdist < r && part.pol === e.pol) {
          e.mass += 1.4;
          if (part.id && part.id.toString().startsWith('feed_')) {
            room.parts.splice(k, 1);
          } else {
            part.x = Math.random() * (W - 200) + 100;
            part.y = Math.random() * (H - 200) + 100;
            part.vx = 0; part.vy = 0;
            part.pol = Math.random() < 0.5 ? 1 : -1;
          }
          if (!e.isBot) io.to(e.id).emit('eatOrb', { x: e.x, y: e.y });
        }
      }
    }

    for (let i = 0; i < allEntities.length; i++) {
      const a = allEntities[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < allEntities.length; j++) {
        const b = allEntities[j];
        if (!b.alive) continue;

        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const ra = radiusOf(a), rb = radiusOf(b);

        if (a.pol !== b.pol) {
          if (d < ra * 2.2 && b.mass < a.mass * 0.40) b.isSlowed = true;
          if (d < rb * 2.2 && a.mass < b.mass * 0.40) a.isSlowed = true;
        }

        if (a.pol === b.pol && d < (ra + rb) * 0.95 && d > 2) {
          const ux = dx / d, uy = dy / d;
          const bounceForce = 900;
          a.vx -= ux * bounceForce;
          a.vy -= uy * bounceForce;
          b.vx += ux * bounceForce;
          b.vy += uy * bounceForce;
          io.to(room.id).emit('magnetBounce', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          continue;
        }

        if (d > (ra + rb) * 5.5 || d < 2) continue;

        const attract = a.pol !== b.pol ? 1 : -1;
        const force = 280000 / (d * d + (ra + rb) * (ra + rb) * 0.4);
        const ux = dx / d, uy = dy / d;
        const accA = Math.min(1300, force * b.mass / Math.max(a.mass, 12));
        const accB = Math.min(1300, force * a.mass / Math.max(b.mass, 12));

        a.vx += attract * ux * accA * dt;
        a.vy += attract * uy * accA * dt;
        b.vx -= attract * ux * accB * dt;
        b.vy -= attract * uy * accB * dt;

        if (d < Math.max(ra, rb) * 0.95 && a.pol !== b.pol) {
          let big = a.mass > b.mass ? a : b;
          let small = big === a ? b : a;

          if (big.mass > small.mass * 1.25 && small.spawnInvincible <= 0) {
            const wasLeaderBounty = (small.id === topLeaderId);
            big.mass += small.mass * 0.75;
            small.alive = false;

            io.to(room.id).emit('playerKilled', {
              deadId: small.id,
              killerId: big.id,
              x: small.x,
              y: small.y,
              radius: radiusOf(small),
              wasLeader: wasLeaderBounty
            });

            if (!small.isBot) {
              io.to(small.id).emit('youDied', { killer: big.name, mass: Math.floor(small.mass) });
            } else {
              delete room.bots[small.id];
            }
          }
        }
      }
    }

    const combinedEntities = { ...room.players, ...room.bots };
    io.to(room.id).emit('stateUpdate', {
      roomId: room.id,
      isBR: room.isBR,
      brState: room.brState,
      brTimer: room.brTimer,
      brZoneRadius: room.brZoneRadius,
      brZoneX: room.brZoneX,
      brZoneY: room.brZoneY,
      players: combinedEntities,
      parts: room.parts,
      anomalies: room.anomalies,
      powerups: room.powerups,
      topLeaderId: topLeaderId
    });
  }
}, 1000 / SERVER_TICKRATE);

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur Magnet.io prêt sur http://localhost:${PORT}`);
});