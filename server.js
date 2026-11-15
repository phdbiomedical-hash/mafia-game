'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 25000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/qr', async (req, res) => {
  try {
    const text = String(req.query.t || '').slice(0, 300);
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#1a0f12', light: '#f3e9d6' } });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
  } catch { res.status(400).end(); }
});

const rooms = new Map();
const newId = (n) => crypto.randomBytes(n).toString('hex');

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', room.view(p.id));
  }
}

function genCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function cleanName(name) {
  return String(name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

const hostTimers = new Map();

io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const player = room && room.byToken(socket.data.token);
    return { room, player };
  };

  const attach = (room, player) => {
    // إذا كان اللاعب متصلاً من جهاز/تبويب آخر، نفصل القديم
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) { old.emit('replaced'); old.data.code = null; }
    }
    player.socketId = socket.id;
    socket.data.code = room.code;
    socket.data.token = player.token;
    room.setConnected(player.id, true);
  };

  socket.on('create', ({ name } = {}, ack = () => {}) => {
    name = cleanName(name);
    if (!name) return ack({ error: 'اكتب اسمك أولاً' });
    const code = genCode();
    const room = new Room(code, broadcast);
    rooms.set(code, room);
    const player = { id: newId(4), token: newId(16), name };
    room.addPlayer(player);
    attach(room, player);
    ack({ ok: true, code, token: player.token });
  });

  socket.on('join', ({ code, name, token } = {}, ack = () => {}) => {
    code = String(code || '').trim();
    const room = rooms.get(code);
    if (!room) return ack({ error: 'لا توجد غرفة بهذا الرقم', gone: true });
    // إعادة اتصال بنفس الهوية
    const existing = token && room.byToken(token);
    if (existing) { attach(room, existing); return ack({ ok: true, code, token }); }
    name = cleanName(name);
    if (!name) return ack({ error: 'اكتب اسمك أولاً' });
    const player = { id: newId(4), token: newId(16), name };
    const err = room.addPlayer(player);
    if (err) return ack({ error: err });
    attach(room, player);
    ack({ ok: true, code, token: player.token });
  });

  const action = (event, fn) => {
    socket.on(event, (data = {}, ack = () => {}) => {
      const { room, player } = ctx();
      if (!room || !player) return ack({ error: 'انقطع الاتصال بالغرفة، أعد الدخول', gone: true });
      const err = fn(room, player, data || {});
      ack(err ? { error: err } : { ok: true });
    });
  };

  action('start', (r, p) => r.start(p.id));
  action('ready', (r, p) => r.ready(p.id));
  action('night', (r, p, d) => r.nightAction(p.id, d.target));
  action('vote', (r, p, d) => r.vote(p.id, d.target));
  action('final', (r, p, d) => r.finalVote(p.id, d.target));
  action('skip', (r, p) => r.skip(p.id));
  action('extend', (r, p) => r.extend(p.id));
  action('newGame', (r, p) => r.newGame(p.id));
  action('kick', (r, p, d) => r.kick(p.id, d.target));
  action('leave', (r, p) => {
    r.leave(p.id);
    socket.data.code = null;
    if (r.players.size === 0) { r.clearTimer(); rooms.delete(r.code); }
    return null;
  });

  socket.on('disconnect', () => {
    const { room, player } = ctx();
    if (!room || !player || player.socketId !== socket.id) return;
    player.socketId = null;
    room.setConnected(player.id, false);
    // إذا غاب المضيف أكثر من 30 ثانية تنتقل صلاحياته لأول لاعب متصل
    if (room.hostId === player.id) {
      clearTimeout(hostTimers.get(room.code));
      hostTimers.set(room.code, setTimeout(() => {
        if (room.hostId === player.id && !player.connected) { room.reassignHost(); room.emit(); }
      }, 30000));
    }
  });
});

// تنظيف الغرف المهجورة كل 10 دقائق
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.list.some((p) => p.connected);
    if ((!anyone && now - room.lastActive > 30 * 60 * 1000) || now - room.lastActive > 6 * 3600 * 1000) {
      room.clearTimer();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n🎩  لعبة المافيا تعمل الآن');
  console.log(`   على هذا الجهاز:   http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`   للهواتف على نفس الشبكة:  http://${ip}:${PORT}`));
  console.log('');
});
