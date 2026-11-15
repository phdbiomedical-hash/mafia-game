'use strict';
/*
 * منطق لعبة المافيا — كل القرارات تُحسب على الخادم حتى لا يستطيع أحد الغش من هاتفه.
 *
 * الأدوار: شيخ المافيا (يقتل) — مافيا (يسكّت) — طبيب (يعالج) — مواطن.
 * تسلسل الجولة:
 *   roles → night → nightResult → discussion (90ث) → voting → [إعادة تصويت عند التعادل]
 *   → defense (30ث) → final (تعديل التصويت) → elimination → night ... → gameover
 */

const ROLE = { GODFATHER: 'godfather', MAFIA: 'mafia', DOCTOR: 'doctor', CITIZEN: 'citizen' };

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 20;

// TIME_SCALE يُستخدم فقط للاختبار السريع (مثلاً 0.05)
const SCALE = Number(process.env.TIME_SCALE || 1);
const T = {
  night: 75,        // مهلة الليل (تنتهي مبكراً إذا اختار الجميع)
  nightResult: 15,  // عرض إعلان الصباح
  discussion: 90,   // دقيقة ونصف للحوار
  voting: 60,       // مهلة التصويت (تنتهي مبكراً إذا صوّت الجميع)
  defense: 30,      // نصف دقيقة للتبرير
  final: 30,        // مهلة تعديل التصويت
  elimination: 12,  // عرض نتيجة الاستبعاد
};
const EXTEND_BY = 30;
const ms = (s) => Math.max(20, Math.round(s * 1000 * SCALE));

const isMafia = (p) => !!p && (p.role === ROLE.GODFATHER || p.role === ROLE.MAFIA);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Room {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.players = new Map(); // id -> player
    this.order = [];
    this.hostId = null;
    this.timer = null;
    this.next = null;
    this.lastActive = Date.now();
    this.resetGame();
  }

  /* ---------- أدوات ---------- */
  emit() { this.lastActive = Date.now(); this.onChange(this); }
  get list() { return this.order.map((id) => this.players.get(id)).filter(Boolean); }
  get alive() { return this.list.filter((p) => p.alive); }
  get aliveConnected() { return this.alive.filter((p) => p.connected); }
  find(role) { return this.list.find((p) => p.role === role); }
  byToken(token) { return this.list.find((p) => p.token === token); }

  // من يملك القتل: شيخ المافيا، وإذا خرج ينتقل القتل إلى المافيا
  killerId() {
    const gf = this.find(ROLE.GODFATHER);
    if (gf && gf.alive) return gf.id;
    const m = this.find(ROLE.MAFIA);
    return m && m.alive ? m.id : null;
  }
  // التسكيت للمافيا فقط ما دام شيخ المافيا حياً
  silencerId() {
    const gf = this.find(ROLE.GODFATHER), m = this.find(ROLE.MAFIA);
    return gf && gf.alive && m && m.alive ? m.id : null;
  }
  doctorId() {
    const d = this.find(ROLE.DOCTOR);
    return d && d.alive ? d.id : null;
  }

  resetGame() {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = 0;
    this.night = null;
    this.silencedId = null;
    this.doctorSelfUsed = false;
    this.votes = {};
    this.candidates = [];
    this.runoff = false;
    this.tieIds = null;
    this.accusedId = null;
    this.tally = null;
    this.finalVotes = {};
    this.finalConfirmed = {};
    this.lastNight = null;
    this.lastElim = null;
    this.winner = null;
    this.phaseEndsAt = null;
    for (const p of this.players.values()) {
      p.role = null; p.alive = true; p.ready = false; p.revealed = false;
    }
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setPhase(phase, seconds, next) {
    this.clearTimer();
    this.phase = phase;
    this.next = next || null;
    if (seconds && next) {
      const dur = ms(seconds);
      this.phaseEndsAt = Date.now() + dur;
      this.timer = setTimeout(() => { this.timer = null; next(); }, dur);
    } else {
      this.phaseEndsAt = null;
    }
    this.emit();
  }

  /* ---------- اللاعبون ---------- */
  addPlayer(player) {
    if (this.phase !== 'lobby') return 'اللعبة بدأت بالفعل، انتظر الجولة القادمة';
    if (this.players.size >= MAX_PLAYERS) return 'الغرفة ممتلئة';
    const taken = this.list.some((p) => p.name.trim() === player.name.trim());
    if (taken) return 'هذا الاسم مستخدم في الغرفة، اختر اسماً آخر';
    Object.assign(player, { role: null, alive: true, ready: false, revealed: false, connected: true });
    this.players.set(player.id, player);
    this.order.push(player.id);
    if (!this.hostId) this.hostId = player.id;
    this.emit();
    return null;
  }

  removePlayer(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.hostId === id) this.reassignHost();
    this.emit();
  }

  reassignHost() {
    const c = this.list.find((p) => p.connected) || this.list[0];
    this.hostId = c ? c.id : null;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    this.checkProgress();
    this.emit();
  }

  kick(byId, targetId) {
    if (byId !== this.hostId) return 'فقط منشئ الغرفة يستطيع ذلك';
    if (this.phase !== 'lobby') return 'لا يمكن الحذف أثناء اللعب';
    if (targetId === byId) return 'لا يمكنك حذف نفسك';
    this.removePlayer(targetId);
    return null;
  }

  leave(id) {
    if (this.phase === 'lobby' || this.phase === 'gameover') { this.removePlayer(id); return; }
    // أثناء اللعب: يبقى في القائمة كغير متصل حتى لا تنكشف الأدوار
    const p = this.players.get(id);
    if (p) { p.connected = false; p.token = null; }
    if (this.hostId === id) this.reassignHost();
    this.checkProgress();
    this.emit();
  }

  /* ---------- بدء اللعبة ---------- */
  start(byId) {
    if (byId !== this.hostId) return 'فقط منشئ الغرفة يستطيع بدء اللعبة';
    if (this.phase !== 'lobby') return 'اللعبة بدأت بالفعل';
    const offline = this.list.filter((p) => !p.connected);
    if (offline.length) return 'لاعبون غير متصلين: ' + offline.map((p) => p.name).join('، ') + ' — احذفهم أو انتظر عودتهم';
    if (this.players.size < MIN_PLAYERS) return `تحتاج ${MIN_PLAYERS} لاعبين على الأقل`;
    this.resetGame();
    const ids = shuffle(this.list.map((p) => p.id));
    ids.forEach((id, i) => {
      this.players.get(id).role =
        i === 0 ? ROLE.GODFATHER : i === 1 ? ROLE.MAFIA : i === 2 ? ROLE.DOCTOR : ROLE.CITIZEN;
    });
    this.setPhase('roles', 0, () => this.startNight());
    return null;
  }

  ready(id) {
    if (this.phase !== 'roles') return null;
    const p = this.players.get(id);
    if (p) p.ready = true;
    if (!this.checkProgress()) this.emit();
    return null;
  }

  /* ---------- الليل ---------- */
  startNight() {
    this.round += 1;
    this.silencedId = null; // التسكيت يستمر نهاراً واحداً فقط
    this.night = { kill: null, silence: null, heal: null, suspects: {}, done: new Set() };
    this.accusedId = null; this.tally = null; this.tieIds = null;
    this.setPhase('night', T.night, () => this.resolveNight());
  }

  nightAction(id, targetId) {
    if (this.phase !== 'night') return 'ليس وقت الليل';
    const p = this.players.get(id), t = this.players.get(targetId), n = this.night;
    if (!p || !p.alive) return 'أنت خارج اللعبة';
    if (!t || !t.alive) return 'اختيار غير صالح';
    if (n.done.has(id)) return 'لقد اخترت بالفعل';

    if (id === this.killerId()) {
      if (isMafia(t)) return 'لا يمكنك قتل أحد من المافيا';
      n.kill = targetId;
    } else if (id === this.silencerId()) {
      if (isMafia(t)) return 'لا يمكنك تسكيت أحد من المافيا';
      n.silence = targetId;
    } else if (id === this.doctorId()) {
      if (targetId === id && this.doctorSelfUsed) return 'عالجت نفسك من قبل — مسموح مرة واحدة فقط';
      n.heal = targetId;
    } else {
      if (targetId === id) return 'اختر شخصاً غيرك';
      n.suspects[id] = targetId; // اختيار "الشك" للمواطنين حتى يضغط الجميع ولا تنكشف الأدوار
    }
    n.done.add(id);
    if (!this.checkProgress()) this.emit();
    return null;
  }

  resolveNight() {
    const n = this.night;
    const docId = this.doctorId();
    let killedId = null, saved = false;
    if (n.kill) {
      if (n.heal === n.kill) saved = true;
      else { killedId = n.kill; this.players.get(killedId).alive = false; }
    }
    if (docId && n.heal === docId) this.doctorSelfUsed = true;
    const sp = n.silence && this.players.get(n.silence);
    this.silencedId = sp && sp.alive ? sp.id : null;

    // استطلاع الشكوك (من المواطنين فقط، بدون أسماء المصوّتين)
    const counts = {};
    Object.values(n.suspects).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    let topSuspect = null;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length && (entries.length === 1 || entries[0][1] > entries[1][1]) && this.players.get(entries[0][0]).alive) {
      topSuspect = { id: entries[0][0], count: entries[0][1] };
    }

    this.lastNight = {
      round: this.round,
      targetId: n.kill,
      killedId,
      saved,
      silencedId: this.silencedId,
      killerIsGodfather: !!(this.find(ROLE.GODFATHER) || {}).alive,
      topSuspect,
    };
    this.winner = this.checkWin();
    this.setPhase('nightResult', T.nightResult, () => this.afterNightResult());
  }

  afterNightResult() {
    if (this.winner) return this.gameOver();
    this.setPhase('discussion', T.discussion, () => this.startVoting());
  }

  /* ---------- التصويت ---------- */
  startVoting(candidates) {
    this.votes = {};
    this.runoff = !!candidates;
    this.candidates = candidates || this.alive.map((p) => p.id);
    this.setPhase('voting', T.voting, () => this.tallyVotes());
  }

  vote(id, targetId) {
    if (this.phase !== 'voting') return 'ليس وقت التصويت';
    const p = this.players.get(id);
    if (!p || !p.alive) return 'أنت خارج اللعبة';
    if (targetId === id) return 'لا يمكنك التصويت لنفسك';
    if (!this.candidates.includes(targetId)) return 'اختيار غير صالح';
    if (this.votes[id]) return 'لقد صوّتّ بالفعل';
    this.votes[id] = targetId;
    if (!this.checkProgress()) this.emit();
    return null;
  }

  count(votes) {
    const map = {};
    for (const [voter, target] of Object.entries(votes)) {
      const v = this.players.get(voter);
      if (!v || !v.alive) continue;
      (map[target] = map[target] || []).push(voter);
    }
    return Object.entries(map)
      .map(([id, voters]) => ({ id, count: voters.length, voters }))
      .sort((a, b) => b.count - a.count);
  }

  tallyVotes() {
    const tally = this.count(this.votes);
    this.tally = tally;
    if (!tally.length) {
      this.lastElim = { type: 'novotes' };
      return this.setPhase('elimination', T.elimination, () => this.afterElim());
    }
    const top = tally[0].count;
    const leaders = tally.filter((t) => t.count === top).map((t) => t.id);
    if (leaders.length > 1) {
      if (!this.runoff) {
        this.tieIds = leaders;
        return this.startVoting(leaders); // إعادة التصويت بين المتعادلين
      }
      this.lastElim = { type: 'tie', ids: leaders };
      return this.setPhase('elimination', T.elimination, () => this.afterElim());
    }
    this.accusedId = leaders[0];
    this.setPhase('defense', T.defense, () => this.startFinal());
  }

  startFinal() {
    this.finalVotes = { ...this.votes };
    this.finalConfirmed = {};
    this.setPhase('final', T.final, () => this.resolveFinal());
  }

  finalVote(id, targetId) {
    if (this.phase !== 'final') return 'ليس وقت تعديل التصويت';
    const p = this.players.get(id);
    if (!p || !p.alive) return 'أنت خارج اللعبة';
    if (targetId === id) return 'لا يمكنك التصويت لنفسك';
    if (!this.candidates.includes(targetId)) return 'اختيار غير صالح';
    this.finalVotes[id] = targetId;
    this.finalConfirmed[id] = true;
    if (!this.checkProgress()) this.emit();
    return null;
  }

  resolveFinal() {
    const tally = this.count(this.finalVotes);
    this.tally = tally;
    const acc = tally.find((t) => t.id === this.accusedId);
    const accCount = acc ? acc.count : 0;
    const others = tally.filter((t) => t.id !== this.accusedId).map((t) => t.count);
    const eliminated = accCount > 0 && others.every((c) => accCount > c);
    const p = this.players.get(this.accusedId);
    if (eliminated && p) { p.alive = false; p.revealed = true; }
    this.lastElim = { type: eliminated ? 'out' : 'spared', id: this.accusedId, role: eliminated && p ? p.role : null };
    this.winner = this.checkWin();
    this.setPhase('elimination', T.elimination, () => this.afterElim());
  }

  afterElim() {
    if (this.winner) return this.gameOver();
    this.startNight();
  }

  /* ---------- النهاية ---------- */
  checkWin() {
    const alive = this.alive;
    const m = alive.filter(isMafia).length;
    const others = alive.length - m;
    if (m === 0) return 'citizens';
    if (m >= others) return 'mafia';
    return null;
  }

  gameOver() {
    for (const p of this.players.values()) p.revealed = true;
    this.setPhase('gameover', 0, null);
  }

  newGame(byId) {
    if (byId !== this.hostId) return 'فقط منشئ الغرفة يستطيع ذلك';
    // إزالة من غادر نهائياً
    for (const p of this.list) if (!p.token) this.removePlayer(p.id);
    this.resetGame();
    this.emit();
    return null;
  }

  /* ---------- تحكم المضيف ---------- */
  skip(byId) {
    if (byId !== this.hostId) return 'فقط منشئ الغرفة يستطيع ذلك';
    if (!this.next) return null;
    const fn = this.next;
    this.clearTimer();
    fn();
    return null;
  }

  extend(byId) {
    if (byId !== this.hostId) return 'فقط منشئ الغرفة يستطيع ذلك';
    if (!this.phaseEndsAt || !this.next) return null;
    const remaining = this.phaseEndsAt - Date.now() + ms(EXTEND_BY);
    const fn = this.next;
    this.clearTimer();
    this.phaseEndsAt = Date.now() + remaining;
    this.timer = setTimeout(() => { this.timer = null; fn(); }, remaining);
    this.emit();
    return null;
  }

  // ينهي المرحلة مبكراً إذا أنهى جميع اللاعبين المتصلين اختياراتهم
  checkProgress() {
    const ac = this.aliveConnected;
    let done = false;
    if (this.phase === 'roles') done = this.list.filter((p) => p.connected).every((p) => p.ready);
    else if (this.phase === 'night') done = ac.every((p) => this.night.done.has(p.id));
    else if (this.phase === 'voting') done = ac.every((p) => this.votes[p.id]);
    else if (this.phase === 'final') done = ac.every((p) => this.finalConfirmed[p.id]);
    if (done && this.next && ac.length) {
      const fn = this.next;
      this.clearTimer();
      setTimeout(fn, Math.min(600, ms(0.6))); // مهلة قصيرة حتى لا يُعرف آخر من ضغط
      this.next = null;
      return true;
    }
    return false;
  }

  /* ---------- ما يراه كل لاعب ---------- */
  view(pid) {
    const me = this.players.get(pid);
    const ph = this.phase;
    const dayPhases = ['nightResult', 'discussion', 'voting', 'defense', 'final', 'elimination'];
    const canSee = (p) => ph === 'gameover' || p.revealed || p.id === pid || (isMafia(me) && isMafia(p));

    const v = {
      code: this.code,
      phase: ph,
      round: this.round,
      hostId: this.hostId,
      minPlayers: MIN_PLAYERS,
      phaseEndsAt: this.phaseEndsAt,
      serverNow: Date.now(),
      me: me && {
        id: me.id, name: me.name, alive: me.alive, role: me.role, ready: me.ready,
        silenced: me.id === this.silencedId && dayPhases.includes(ph),
      },
      players: this.list.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        ready: ph === 'roles' ? p.ready : undefined,
        silenced: p.id === this.silencedId && dayPhases.includes(ph),
        role: p.role && canSee(p) ? p.role : null,
        revealed: p.revealed,
      })),
      lastNight: dayPhases.includes(ph) || ph === 'gameover' ? this.lastNight : null,
      lastElim: ph === 'elimination' || ph === 'gameover' ? this.lastElim : null,
      winner: ph === 'gameover' ? this.winner : null,
      accusedId: ['defense', 'final', 'elimination'].includes(ph) ? this.accusedId : null,
      tally: ['defense', 'final', 'elimination'].includes(ph) ? this.tally : null,
    };

    if (ph === 'night' && me && me.alive) {
      const n = this.night;
      let action = 'suspect', target = n.suspects[me.id] || null;
      if (me.id === this.killerId()) { action = 'kill'; target = n.kill; }
      else if (me.id === this.silencerId()) { action = 'silence'; target = n.silence; }
      else if (me.id === this.doctorId()) { action = 'heal'; target = n.heal; }
      const targets = this.alive.filter((t) => {
        if (action === 'kill' || action === 'silence') return !isMafia(t);
        if (action === 'heal') return t.id !== me.id || !this.doctorSelfUsed;
        return t.id !== me.id;
      }).map((t) => t.id);
      v.night = {
        action, target, targets,
        done: n.done.has(me.id),
        selfHealUsed: this.doctorSelfUsed,
        inherited: action === 'kill' && me.role === ROLE.MAFIA,
        doneCount: n.done.size,
        total: this.aliveConnected.length,
      };
      if (isMafia(me)) v.night.team = { kill: n.kill, silence: n.silence };
    }

    if (ph === 'voting') {
      v.voting = {
        candidates: this.candidates,
        myVote: (me && this.votes[me.id]) || null,
        votedIds: Object.keys(this.votes),
        runoff: this.runoff,
        tieIds: this.tieIds,
        total: this.aliveConnected.length,
      };
    }

    if (ph === 'final') {
      v.final = {
        options: this.candidates,
        myVote: (me && this.finalVotes[me.id]) || null,
        confirmed: !!(me && this.finalConfirmed[me.id]),
        confirmedCount: Object.keys(this.finalConfirmed).length,
        total: this.aliveConnected.length,
      };
    }
    return v;
  }
}

module.exports = { Room, ROLE, MIN_PLAYERS, MAX_PLAYERS, isMafia };
