/* واجهة لعبة المافيا على الهاتف */
(() => {
  'use strict';

  const ROLES = {
    godfather: { name: 'شيخ المافيا', icon: '🎩', team: 'mafia',
      desc: 'أنت زعيم المافيا. في كل ليلة تختار شخصاً لقتله. شريكك هو المافيا، ولا أحد غيركما يعرف هويتكما.' },
    mafia: { name: 'مافيا', icon: '🕶️', team: 'mafia',
      desc: 'أنت من المافيا. في كل ليلة تختار شخصاً لتسكيته فلا يحق له الكلام في النهار التالي. إذا خرج شيخ المافيا تنتقل إليك مهمة القتل.' },
    doctor: { name: 'طبيب', icon: '🩺', team: 'town',
      desc: 'في كل ليلة تختار شخصاً لتعالجه فلا يستطيع أحد قتله. يمكنك أن تعالج نفسك مرة واحدة فقط طوال اللعبة.' },
    citizen: { name: 'مواطن', icon: '🧑', team: 'town',
      desc: 'مهمتك أن تكتشف شيخ المافيا والمافيا وتُخرجهما بالتصويت. في الليل تختار من تشك فيه سراً.' },
  };

  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('mafia.' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('mafia.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem('mafia.' + k); } catch { /* ignore */ } },
  };

  const params = new URLSearchParams(location.search);
  let S = null;            // آخر حالة من الخادم
  let clockOffset = 0;     // فرق الساعة مع الخادم
  let sel = null;          // الاختيار المحلي قبل التأكيد
  let phaseKey = '';
  let revealed = false;    // هل كشف اللاعب بطاقة دوره
  let busy = false;
  let joining = false;

  const socket = io({ transports: ['websocket', 'polling'] });

  /* ---------- اتصال ---------- */
  function send(event, data) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, data || {}, (err, res) => {
        if (err) { toast('تعذّر الاتصال، حاول مرة أخرى'); return resolve({ error: 'timeout' }); }
        if (res && res.error) {
          toast(res.error);
          if (res.gone) { store.del('session'); S = null; render(); }
        }
        resolve(res || {});
      });
    });
  }

  function rejoin() {
    const sess = store.get('session');
    if (!sess || joining) return;
    joining = true;
    socket.timeout(8000).emit('join', { code: sess.code, token: sess.token }, (err, res) => {
      joining = false;
      if (err) return;
      if (res && res.error) { store.del('session'); S = null; render(); }
    });
  }

  socket.on('connect', () => { $('#conn').hidden = true; rejoin(); });
  socket.on('disconnect', () => { $('#conn').hidden = false; });
  socket.on('replaced', () => { S = null; store.del('session'); render(); toast('فُتحت اللعبة من نافذة أخرى'); });
  socket.on('state', (st) => {
    clockOffset = st.serverNow - Date.now();
    const key = st.phase + ':' + st.round + ':' + (st.voting && st.voting.runoff ? 'r' : '');
    if (key !== phaseKey) {
      if (phaseKey && navigator.vibrate) { try { navigator.vibrate(st.phase === 'night' ? [80, 60, 80] : 120); } catch { /* ignore */ } }
      phaseKey = key; sel = null;
      if (st.phase === 'roles' || st.phase === 'lobby') revealed = false;
      window.scrollTo({ top: 0 });
    }
    S = st;
    render();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!socket.connected) socket.connect(); else rejoin();
      keepAwake();
    }
  });

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* ignore */ }
  }
  document.addEventListener('click', keepAwake, { once: true });

  /* ---------- مساعدات ---------- */
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800);
  }
  const P = (id) => (S && S.players.find((p) => p.id === id)) || null;
  const nm = (id) => { const p = P(id); return p ? esc(p.name) : '؟'; };
  const isHost = () => S && S.me && S.hostId === S.me.id;
  const initial = (name) => esc(String(name).trim().charAt(0) || '؟');
  const roleName = (r) => (ROLES[r] ? ROLES[r].name : '');
  const isMafiaRole = (r) => r === 'godfather' || r === 'mafia';

  function remaining() {
    if (!S || !S.phaseEndsAt) return null;
    return Math.max(0, S.phaseEndsAt - (Date.now() + clockOffset));
  }

  function timerHTML(total) {
    return `<div class="timer" data-timer data-total="${total}"><div class="num">--</div><div class="bar"><i style="width:100%"></i></div></div>`;
  }

  function tickTimers() {
    const ms = remaining();
    document.querySelectorAll('[data-timer]').forEach((el) => {
      if (ms == null) { el.hidden = true; return; }
      el.hidden = false;
      const s = Math.ceil(ms / 1000);
      const total = Number(el.dataset.total) || 60;
      const mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
      el.querySelector('.num').textContent = mm ? `${mm}:${ss}` : String(s);
      el.querySelector('.bar > i').style.width = Math.min(100, (s / total) * 100) + '%';
      el.classList.toggle('low', s <= 10);
    });
    document.querySelectorAll('[data-clock]').forEach((el) => {
      if (ms == null) { el.hidden = true; return; }
      el.hidden = false;
      el.querySelector('b').textContent = Math.ceil(ms / 1000);
    });
  }
  setInterval(tickTimers, 250);

  function roleCard(role, extra = '') {
    const r = ROLES[role];
    if (!r) return '';
    return `<div class="rolecard ${role} ${isMafiaRole(role) ? 'mafia' : ''}">
      <div class="ico">${r.icon}</div>
      <div class="label">دورك في اللعبة</div>
      <div class="rname">${r.name}</div>
      <p>${r.desc}</p>${extra}</div>`;
  }

  function teamHTML() {
    if (!S.me || !isMafiaRole(S.me.role)) return '';
    const mates = S.players.filter((p) => p.id !== S.me.id && isMafiaRole(p.role));
    if (!mates.length) return '';
    return `<div class="team small">شريكك: ${mates.map((m) => `<strong>${esc(m.name)}</strong> (${roleName(m.role)}${m.alive ? '' : ' — خرج'})`).join('، ')}</div>`;
  }

  function topbar() {
    const timed = ['night', 'discussion', 'voting', 'defense', 'final', 'nightResult', 'elimination'].includes(S.phase);
    return `<div class="topbar">
      <div class="right">
        <span class="chip">الغرفة <b>${esc(S.code)}</b></span>
        ${S.round ? `<span class="chip">الجولة <b>${S.round}</b></span>` : ''}
        ${timed ? `<span class="chip" data-clock>⏱ <b>--</b></span>` : ''}
      </div>
      <div class="left">
        ${S.me && S.me.role ? `<button class="btn sm ghost" data-act="peek">👁 دوري</button>` : ''}
        <button class="btn sm ghost" data-act="leave" aria-label="خروج">خروج</button>
      </div>
    </div>`;
  }

  function playerList(opts = {}) {
    return `<ul class="plist">${S.players.map((p) => {
      const tags = [];
      if (p.id === S.hostId) tags.push('<span class="tag host">المضيف</span>');
      if (S.me && p.id === S.me.id) tags.push('<span class="tag">أنت</span>');
      if (p.silenced) tags.push('<span class="tag mute">🤐 مُسكَت</span>');
      if (!p.alive) tags.push(`<span class="tag red">${p.revealed && p.role ? roleName(p.role) : 'خرج'}</span>`);
      else if (p.role && S.me && p.id !== S.me.id) tags.push(`<span class="tag red">${roleName(p.role)}</span>`);
      if (opts.ready && p.ready) tags.push('<span class="tag ok">جاهز ✓</span>');
      if (!p.connected) tags.push('<span class="tag">غير متصل</span>');
      const kick = opts.kick && isHost() && p.id !== S.me.id ? `<button class="btn sm ghost" data-act="kick" data-id="${p.id}" aria-label="حذف">✕</button>` : '';
      return `<li class="${p.alive ? '' : 'dead'} ${p.connected ? '' : 'off'}"><span class="avatar">${initial(p.name)}</span><span class="nm">${esc(p.name)}</span>${tags.join('')}${kick}</li>`;
    }).join('')}</ul>`;
  }

  function picks(ids, cls, current) {
    return `<div class="grid">${ids.map((id) => {
      const p = P(id);
      return `<button class="pick ${cls} ${current === id ? 'on' : ''}" data-act="sel" data-id="${id}">
        <span>${esc(p ? p.name : '؟')}</span>${S.me && id === S.me.id ? '<span class="sub">(نفسك)</span>' : ''}</button>`;
    }).join('')}</div>`;
  }

  function tallyHTML(tally) {
    if (!tally || !tally.length) return '';
    const max = Math.max(...tally.map((t) => t.count));
    return `<div class="tally">${tally.map((t) => `<div class="row">
      <span class="n">${nm(t.id)}</span><span class="c">${t.count} ${t.count === 1 ? 'صوت' : 'أصوات'}</span>
      <div class="bar"><i style="width:${(t.count / max) * 100}%"></i></div>
      <span class="v">${t.voters.map(nm).join('، ')}</span></div>`).join('')}</div>`;
  }

  function hostbar(buttons) {
    if (!isHost() || !buttons) return '';
    return `<div class="hostbar"><div class="in"><span class="lbl">تحكم المضيف</span>${buttons}</div></div>`;
  }
  const skipBtn = (label = 'تخطي ⏭') => `<button class="btn sm" data-act="skip">${label}</button>`;
  const extendBtn = '<button class="btn sm" data-act="extend">+30 ثانية</button>';

  /* ---------- الشاشات ---------- */
  function renderHome() {
    const name = store.get('name') || '';
    const code = params.get('room') || '';
    app.innerHTML = `
      <section class="hero fade-in">
        <svg class="hat" viewBox="0 0 512 512" aria-hidden="true"><ellipse cx="256" cy="330" rx="190" ry="44" fill="#d4a857"/><path d="M150 330c0-80 20-170 106-170s106 90 106 170z" fill="#d4a857"/><rect x="150" y="288" width="212" height="22" fill="#b0353a"/></svg>
        <div class="logo">مافيا</div>
        <p class="tagline">لعبة جماعية — كل لاعب من هاتفه</p>
      </section>
      <section class="card fade-in">
        <div class="field"><label class="label" for="name">اسمك في اللعبة</label>
          <input id="name" class="input" maxlength="16" autocomplete="nickname" placeholder="مثلاً: أبو علي" value="${esc(name)}"></div>
        ${code ? '' : `<button class="btn primary block" data-act="create">إنشاء غرفة جديدة</button><div class="or">أو ادخل غرفة موجودة</div>`}
        <div class="field"><label class="label" for="code">رقم الغرفة</label>
          <input id="code" class="input code" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0000" value="${esc(code)}"></div>
        <button class="btn ${code ? 'primary' : ''} block" data-act="join">دخول الغرفة</button>
        ${code ? `<button class="btn ghost sm" data-act="clearcode">أريد إنشاء غرفة جديدة بدلاً من ذلك</button>` : ''}
      </section>
      ${rulesHTML()}`;
  }

  function rulesHTML() {
    return `<details class="rules"><summary>طريقة اللعب</summary><ol>
      <li>توزّع اللعبة الأدوار سراً: شيخ المافيا، المافيا، الطبيب، والبقية مواطنون. شيخ المافيا والمافيا يعرفان بعضهما.</li>
      <li>في الليل: شيخ المافيا يقتل شخصاً، والمافيا يسكّت شخصاً، والطبيب يعالج شخصاً (ويعالج نفسه مرة واحدة فقط). المواطنون يختارون من يشكّون فيه.</li>
      <li>في الصباح يُعلن من قُتل ومن سُكّت، وهل أنقذه الطبيب، دون كشف من عالجه الطبيب.</li>
      <li>دقيقة ونصف للحوار، ثم يصوّت الجميع على شخص واحد. المُسكَت لا يتكلم لكنه يصوّت.</li>
      <li>صاحب أعلى الأصوات يبرّر خلال نصف دقيقة، ثم يمكن تعديل الأصوات. إن بقي الأعلى يُستبعد وتُكشف هويته.</li>
      <li>إذا خرج شيخ المافيا تنتقل مهمة القتل إلى المافيا.</li>
      <li>يفوز المواطنون بإخراج شيخ المافيا والمافيا، وتفوز المافيا إذا تساوى عددها مع عدد البقية.</li>
    </ol></details>`;
  }

  function renderLobby() {
    const link = `${location.origin}/?room=${S.code}`;
    const n = S.players.length;
    const enough = n >= S.minPlayers;
    app.innerHTML = `${topbar()}
      <section class="card center fade-in">
        <div class="label">رقم الغرفة</div>
        <div class="roomcode">${esc(S.code)}</div>
        <img class="qr" src="/qr?t=${encodeURIComponent(link)}" alt="رمز QR للدخول إلى الغرفة" width="180" height="180">
        <p class="small muted">امسح الرمز بكاميرا الهاتف، أو أرسل الرابط للاعبين</p>
        <div class="share"><input class="input" id="link" readonly value="${esc(link)}"><button class="btn sm" data-act="copy">نسخ</button></div>
      </section>
      <section class="card fade-in">
        <div class="topbar"><h3>اللاعبون</h3><span class="chip"><b>${n}</b> لاعب</span></div>
        ${playerList({ kick: true })}
        ${isHost()
          ? `<button class="btn primary block" data-act="start" ${enough ? '' : 'disabled'}>ابدأ اللعبة وزّع الأدوار</button>
             <p class="small muted center">${enough ? 'عندما يدخل الجميع اضغط ابدأ' : `تحتاج ${S.minPlayers} لاعبين على الأقل (يُفضّل 7 أو أكثر)`}</p>`
          : `<p class="muted center">بانتظار المضيف ليبدأ اللعبة…</p>`}
      </section>
      ${rulesHTML()}`;
  }

  function renderRoles() {
    const me = S.me;
    const ready = S.players.filter((p) => p.ready).length;
    const card = revealed
      ? roleCard(me.role, teamHTML())
      : `<div class="cover" data-act="reveal" role="button" tabindex="0"><div class="big">اضغط لكشف دورك</div><p class="muted small">تأكد أن لا أحد ينظر إلى شاشتك</p></div>`;
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">توزيع الأدوار</span><h2>كل لاعب يعرف دوره الآن</h2></section>
      ${card}
      ${revealed ? (me.ready
        ? `<div class="banner info">أنت جاهز ✓ — بانتظار البقية (${ready}/${S.players.length})</div>`
        : `<button class="btn primary block" data-act="ready">حفظت دوري — جاهز</button>`) : ''}
      <p class="small muted center">يمكنك رؤية دورك في أي وقت من زر «👁 دوري» في الأعلى</p>
      ${playerList({ ready: true })}
      ${hostbar(skipBtn('ابدأ الليل الآن'))}`;
  }

  function renderNight() {
    const n = S.night;
    let body;
    if (!S.me.alive) {
      body = `<div class="banner dead">👻 أنت خارج اللعبة — راقب بصمت ولا تكشف شيئاً</div>`;
    } else if (n.done) {
      body = `<div class="banner info">تم تسجيل اختيارك ✓<br><span class="small muted">بانتظار البقية (${n.doneCount}/${n.total}) — ضع هاتفك جانباً</span></div>`;
    } else {
      const cur = sel || null;
      const conf = {
        kill: { t: n.inherited ? 'خرج شيخ المافيا — القتل أصبح مهمتك' : 'اختر ضحيتك الليلة', s: 'سيُقتل هذا الشخص إلا إذا عالجه الطبيب.', cls: 'kill', btn: 'تأكيد القتل', b: 'danger' },
        silence: { t: 'اختر من تريد تسكيته', s: 'لن يحق له الكلام في النهار القادم.', cls: '', btn: 'تأكيد التسكيت', b: 'primary' },
        heal: { t: 'اختر من تعالجه الليلة', s: n.selfHealUsed ? 'استخدمت علاج نفسك من قبل.' : 'يمكنك اختيار نفسك مرة واحدة فقط في اللعبة.', cls: 'heal', btn: 'تأكيد العلاج', b: 'primary' },
        suspect: { t: 'من تشكّ أنه من المافيا؟', s: 'اختيارك سري. في الصباح يُعلن أكثر شخص شكّ فيه المواطنون.', cls: '', btn: 'تأكيد', b: 'primary' },
      }[n.action];
      let teamNote = '';
      if (n.team) {
        const parts = [];
        if (n.action !== 'kill' && n.team.kill) parts.push(`شيخ المافيا اختار قتل <strong>${nm(n.team.kill)}</strong>`);
        if (n.action !== 'silence' && n.team.silence) parts.push(`المافيا اختار تسكيت <strong>${nm(n.team.silence)}</strong>`);
        teamNote = teamHTML() + (parts.length ? `<div class="team small">${parts.join(' — ')}</div>` : '');
      }
      body = `<div class="night-sky">
        <div class="center"><h3>${conf.t}</h3><p class="small muted">${conf.s}</p></div>
        ${teamNote}
        ${picks(n.targets, conf.cls, cur)}
        <button class="btn ${conf.b} block" data-act="nightGo" ${cur ? '' : 'disabled'}>${conf.btn}${cur ? ': ' + nm(cur) : ''}</button>
      </div>`;
    }
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">الليلة ${S.round}</span><h2>حلّ الظلام على المدينة 🌙</h2>
        <p class="muted small">الجميع يختار من هاتفه بصمت</p></section>
      ${body}
      ${timerHTML(75)}
      ${hostbar(skipBtn('إنهاء الليل'))}`;
  }

  function morningNews() {
    const L = S.lastNight;
    if (!L) return '';
    const killer = L.killerIsGodfather ? 'شيخ المافيا' : 'المافيا';
    const items = [];
    if (!L.targetId) {
      items.push(`<div class="item save"><span class="ic">🌤️</span><div>مرّت الليلة بهدوء، لم يُقتل أحد.</div></div>`);
    } else if (L.saved) {
      items.push(`<div class="item save"><span class="ic">💉</span><div>حاول ${killer} قتل <strong>${nm(L.targetId)}</strong>، لكن الطبيب عالجه فنجا!</div></div>`);
    } else {
      items.push(`<div class="item kill"><span class="ic">🩸</span><div>قُتل <strong>${nm(L.killedId)}</strong> الليلة.<br><span class="small muted">لم يكن هو من عالجه الطبيب، فالطبيب اختار غيره.</span></div></div>`);
    }
    if (L.silencedId) {
      items.push(`<div class="item mute"><span class="ic">🤐</span><div>تم تسكيت <strong>${nm(L.silencedId)}</strong> — لا يحق له الكلام في هذا النهار.</div></div>`);
    }
    if (L.topSuspect) {
      items.push(`<div class="item"><span class="ic">🔎</span><div>أكثر شخص شكّ فيه المواطنون الليلة: <strong>${nm(L.topSuspect.id)}</strong></div></div>`);
    }
    return `<div class="news">${items.join('')}</div>`;
  }

  function myBanner() {
    if (!S.me) return '';
    if (!S.me.alive) return `<div class="banner dead">👻 أنت خارج اللعبة — يمكنك المتابعة بصمت</div>`;
    if (S.me.silenced) return `<div class="banner mute">🤐 أنت مُسكَت في هذا النهار — لا تتكلم، لكن يحق لك التصويت</div>`;
    return '';
  }

  function renderNightResult() {
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">صباح الجولة ${S.round}</span><h2>أشرقت الشمس ☀️</h2></section>
      ${morningNews()}
      ${myBanner()}
      ${hostbar(skipBtn('متابعة ⏭'))}`;
  }

  function renderDiscussion() {
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">وقت الحوار</span><h2>من تظنون أنه القاتل؟</h2>
        <p class="muted small">ناقشوا شكوككم بصوت عالٍ، وبعدها يبدأ التصويت</p></section>
      ${timerHTML(90)}
      ${myBanner()}
      ${morningNews()}
      ${playerList()}
      ${hostbar(extendBtn + skipBtn('ابدأ التصويت'))}`;
  }

  function renderVoting() {
    const v = S.voting;
    let body;
    const tieNote = v.runoff ? `<div class="banner mute">تعادل في الأصوات بين ${v.candidates.map(nm).join(' و ')} — أعيدوا التصويت بينهم</div>` : '';
    if (!S.me.alive) {
      body = myBanner();
    } else if (v.myVote) {
      body = `<div class="banner info">صوّتّ ضد <strong>${nm(v.myVote)}</strong> ✓<br><span class="small muted">بانتظار البقية (${v.votedIds.length}/${v.total})</span></div>`;
    } else {
      const opts = v.candidates.filter((id) => id !== S.me.id);
      body = `${myBanner()}${picks(opts, 'kill', sel)}
        <button class="btn danger block" data-act="voteGo" ${sel ? '' : 'disabled'}>أصوّت ضد${sel ? ' ' + nm(sel) : ''}</button>`;
    }
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">التصويت</span><h2>${v.runoff ? 'إعادة التصويت' : 'من هو المافيا؟'}</h2>
        <p class="muted small">اختر اسماً واحداً — صوت واحد لكل لاعب</p></section>
      ${tieNote}
      ${body}
      ${timerHTML(60)}
      <p class="small muted center">صوّت ${v.votedIds.length} من ${v.total}</p>
      ${hostbar(skipBtn('إنهاء التصويت'))}`;
  }

  function renderDefense() {
    const acc = P(S.accusedId);
    const meAcc = S.me && S.accusedId === S.me.id;
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">التبرير</span><h2>${meAcc ? 'دورك! دافع عن نفسك' : 'حصل على أعلى الأصوات'}</h2></section>
      <div class="accused fade-in">
        <div class="who">${nm(S.accusedId)}</div>
        <p>${acc && acc.silenced ? '🤐 لكنه مُسكَت ولا يستطيع الكلام — صمته هو تبريره' : 'لديه نصف دقيقة ليبرّر موقفه'}</p>
      </div>
      ${timerHTML(30)}
      ${tallyHTML(S.tally)}
      <p class="small muted center">بعد التبرير يمكنكم تعديل أصواتكم إن اقتنعتم</p>
      ${hostbar(extendBtn + skipBtn('انتهى التبرير'))}`;
  }

  function renderFinal() {
    const f = S.final;
    let body;
    if (!S.me.alive) {
      body = myBanner();
    } else if (f.confirmed) {
      body = `<div class="banner info">ثبّتّ صوتك ضد <strong>${nm(f.myVote)}</strong> ✓<br><span class="small muted">بانتظار البقية (${f.confirmedCount}/${f.total})</span></div>`;
    } else {
      const cur = sel || f.myVote;
      const opts = f.options.filter((id) => id !== S.me.id);
      body = `${picks(opts, 'kill', cur)}
        <button class="btn danger block" data-act="finalGo" ${cur ? '' : 'disabled'}>${cur && cur === f.myVote ? 'أُثبّت صوتي ضد ' + nm(cur) : cur ? 'أغيّر صوتي إلى ' + nm(cur) : 'اختر اسماً'}</button>`;
    }
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">القرار الأخير</span><h2>هل اقتنعتم بكلام ${nm(S.accusedId)}؟</h2>
        <p class="muted small">صوتك السابق محدد مسبقاً. ثبّته أو غيّره. إذا بقي ${nm(S.accusedId)} صاحب أعلى الأصوات سيُستبعد.</p></section>
      ${body}
      ${timerHTML(30)}
      ${hostbar(skipBtn('إعلان النتيجة'))}`;
  }

  function renderElimination() {
    const E = S.lastElim || {};
    let card = '';
    if (E.type === 'out') {
      const r = ROLES[E.role] || {};
      card = `<div class="accused"><div class="label">تم استبعاد</div><div class="who">${nm(E.id)}</div></div>
        <div class="rolecard ${E.role} ${isMafiaRole(E.role) ? 'mafia' : ''} fade-in">
          <div class="ico">${r.icon || ''}</div><div class="label">وكان في الحقيقة</div><div class="rname">${r.name || ''}</div>
          <p>${isMafiaRole(E.role) ? 'أحسنتم! أمسكتم بأحد أفراد المافيا.' : 'للأسف، كان بريئاً.'}</p></div>`;
    } else if (E.type === 'spared') {
      card = `<div class="banner info">نجا <strong>${nm(E.id)}</strong> — غيّر المصوّتون رأيهم ولم يُستبعد أحد</div>`;
    } else if (E.type === 'tie') {
      card = `<div class="banner info">تعادل مرة أخرى بين ${E.ids.map(nm).join(' و ')} — لم يُستبعد أحد هذه الجولة</div>`;
    } else {
      card = `<div class="banner info">لم يصوّت أحد — لم يُستبعد أحد هذه الجولة</div>`;
    }
    app.innerHTML = `${topbar()}
      <section class="phase fade-in"><span class="eyebrow">نتيجة التصويت</span><h2>قرار المدينة</h2></section>
      ${card}
      ${S.tally && S.tally.length ? `<details class="rules"><summary>تفاصيل الأصوات</summary><div style="margin-top:10px">${tallyHTML(S.tally)}</div></details>` : ''}
      <p class="small muted center">تبدأ الليلة التالية بعد قليل…</p>
      ${hostbar(skipBtn('متابعة ⏭'))}`;
  }

  function renderGameOver() {
    const w = S.winner;
    app.innerHTML = `${topbar()}
      <section class="winner ${w} fade-in">
        <div style="font-size:3.4rem">${w === 'citizens' ? '🏆' : '🎩'}</div>
        <div class="big">${w === 'citizens' ? 'فاز المواطنون!' : 'فازت المافيا!'}</div>
        <p>${w === 'citizens' ? 'تم كشف شيخ المافيا والمافيا وإخراجهما من المدينة.' : 'فشل المواطنون في كشف المافيا، وسيطرت المافيا على المدينة.'}</p>
      </section>
      <section class="card"><h3>هوية كل لاعب</h3>${playerList()}</section>
      ${isHost() ? `<button class="btn primary block" data-act="newGame">لعبة جديدة بنفس اللاعبين</button>` : `<p class="muted center">بانتظار المضيف لبدء لعبة جديدة…</p>`}`;
  }

  function render() {
    if (!S || !S.me) {
      if (store.get('session') && socket.connected) { app.innerHTML = '<p class="muted center" style="padding-top:40vh">جارٍ الدخول…</p>'; return; }
      return renderHome();
    }
    const fn = {
      lobby: renderLobby, roles: renderRoles, night: renderNight, nightResult: renderNightResult,
      discussion: renderDiscussion, voting: renderVoting, defense: renderDefense, final: renderFinal,
      elimination: renderElimination, gameover: renderGameOver,
    }[S.phase];
    if (fn) fn();
    tickTimers();
  }

  /* ---------- الأحداث ---------- */
  function showPeek() {
    if (!S || !S.me || !S.me.role) return;
    const el = $('#peek');
    el.innerHTML = roleCard(S.me.role, teamHTML() + '<p class="small muted">اضغط في أي مكان للإخفاء</p>');
    el.hidden = false;
  }
  $('#peek').addEventListener('click', () => { $('#peek').hidden = true; });

  async function enter(kind) {
    if (busy) return;
    const name = ($('#name') || {}).value || '';
    const code = (($('#code') || {}).value || '').trim();
    if (!name.trim()) { toast('اكتب اسمك أولاً'); $('#name').focus(); return; }
    if (kind === 'join' && !/^\d{4}$/.test(code)) { toast('اكتب رقم الغرفة المكوّن من 4 أرقام'); $('#code').focus(); return; }
    store.set('name', name.trim());
    busy = true;
    const res = await send(kind, kind === 'create' ? { name } : { name, code });
    busy = false;
    if (res.ok) {
      store.set('session', { code: res.code, token: res.token });
      if (params.get('room')) history.replaceState(null, '', '/');
    }
  }

  app.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    switch (act) {
      case 'create': return enter('create');
      case 'join': return enter('join');
      case 'clearcode': params.delete('room'); history.replaceState(null, '', '/'); return renderHome();
      case 'copy': {
        const inp = $('#link');
        try { await navigator.clipboard.writeText(inp.value); toast('تم نسخ الرابط'); }
        catch { inp.select(); try { document.execCommand('copy'); toast('تم نسخ الرابط'); } catch { toast('انسخ الرابط يدوياً'); } }
        return;
      }
      case 'kick': return send('kick', { target: b.dataset.id });
      case 'start': return send('start');
      case 'reveal': revealed = true; return render();
      case 'ready': return send('ready');
      case 'peek': return showPeek();
      case 'sel': sel = b.dataset.id; return render();
      case 'nightGo': if (sel) await send('night', { target: sel }); return;
      case 'voteGo': if (sel) await send('vote', { target: sel }); return;
      case 'finalGo': { const t = sel || (S.final && S.final.myVote); if (t) await send('final', { target: t }); return; }
      case 'skip': return send('skip');
      case 'extend': return send('extend');
      case 'newGame': return send('newGame');
      case 'leave': {
        const inGame = !['lobby', 'gameover'].includes(S.phase);
        if (!confirm(inGame ? 'هل تريد الخروج من اللعبة؟ لن تستطيع العودة لهذه اللعبة.' : 'هل تريد الخروج من الغرفة؟')) return;
        await send('leave');
        store.del('session'); S = null; phaseKey = ''; render();
        return;
      }
    }
  });

  app.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'code') enter('join');
    if (e.key === 'Enter' && e.target.id === 'name' && !params.get('room')) enter('create');
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.act === 'reveal') { e.preventDefault(); revealed = true; render(); }
  });

  // إعادة المحاولة إذا لم تصل الحالة
  setInterval(() => { if (socket.connected && store.get('session') && !S) rejoin(); }, 4000);

  render();
})();
