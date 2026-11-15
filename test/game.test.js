'use strict';
process.env.TIME_SCALE = process.env.TIME_SCALE || '0.002';
const assert = require('assert');
const { Room, ROLE, isMafia } = require('../game');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function playOne(n) {
  const room = new Room('1234', () => {});
  for (let i = 0; i < n; i++) assert.strictEqual(room.addPlayer({ id: 'p' + i, token: 't' + i, name: 'لاعب' + i }), null);
  assert.ok(room.addPlayer({ id: 'x', token: 'x', name: 'لاعب0' }), 'duplicate name rejected');
  assert.strictEqual(room.start('p0'), null);
  const roles = room.list.map((p) => p.role);
  assert.strictEqual(roles.filter((r) => r === ROLE.GODFATHER).length, 1);
  assert.strictEqual(roles.filter((r) => r === ROLE.MAFIA).length, 1);
  assert.strictEqual(roles.filter((r) => r === ROLE.DOCTOR).length, 1);
  // mafia see each other, citizens see nobody
  const gf = room.find(ROLE.GODFATHER), mf = room.find(ROLE.MAFIA);
  assert.strictEqual(room.view(gf.id).players.find((p) => p.id === mf.id).role, ROLE.MAFIA);
  const cit = room.list.find((p) => !isMafia(p));
  assert.ok(room.view(cit.id).players.filter((p) => p.id !== cit.id).every((p) => p.role === null));

  room.list.forEach((p) => room.ready(p.id));
  let guard = 0, selfHeals = 0;
  while (room.phase !== 'gameover' && guard++ < 5000) {
    await sleep(3);
    if (room.phase === 'night') {
      for (const p of room.alive) {
        const v = room.view(p.id).night;
        if (!v || v.done || Math.random() < 0.05) continue;
        const t = pick(v.targets);
        if (v.action === 'heal' && t === p.id) selfHeals++;
        const err = room.nightAction(p.id, t);
        assert.strictEqual(err, null, err);
        if (room.phase !== 'night') break;
      }
      // doctor self-heal twice must be rejected
      const d = room.find(ROLE.DOCTOR);
      if (room.phase === 'night' && room.doctorSelfUsed && d.alive && !room.night.done.has(d.id)) {
        assert.ok(room.nightAction(d.id, d.id));
      }
      // killer cannot target mafia
      const k = room.killerId();
      if (room.phase === 'night' && k && !room.night.done.has(k)) {
        const m = room.alive.find((p) => isMafia(p));
        assert.ok(room.nightAction(k, m.id));
      }
    } else if (room.phase === 'voting') {
      for (const p of room.alive) {
        const opts = room.candidates.filter((c) => c !== p.id);
        if (!room.votes[p.id] && opts.length) room.vote(p.id, pick(opts));
        if (room.phase !== 'voting') break;
      }
    } else if (room.phase === 'final') {
      for (const p of room.alive) {
        const opts = room.candidates.filter((c) => c !== p.id);
        if (!room.finalConfirmed[p.id] && opts.length) room.finalVote(p.id, Math.random() < 0.7 && room.finalVotes[p.id] ? room.finalVotes[p.id] : pick(opts));
        if (room.phase !== 'final') break;
      }
    } else if (['discussion', 'nightResult', 'defense', 'elimination'].includes(room.phase) && Math.random() < 0.3) {
      room.skip('p0');
    }
  }
  assert.strictEqual(room.phase, 'gameover', 'game finished');
  const m = room.alive.filter(isMafia).length, o = room.alive.length - m;
  if (room.winner === 'citizens') assert.strictEqual(m, 0);
  else assert.ok(m >= o && m > 0);
  assert.ok(selfHeals <= 1, 'doctor healed self at most once');
  room.clearTimer();
  return room.winner;
}

(async () => {
  const res = { citizens: 0, mafia: 0 };
  for (let i = 0; i < 200; i++) res[await playOne(5 + (i % 8))]++;
  console.log('200 full games OK —', res);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
