// Android: play with the built-in VLC player screen instead of the PC converter
(function () {
  const VLC_UA = 'VLC/3.0.21 LibVLC/3.0.21';
  window.playFull = function (item, list = null, idx = null) {
    list = list && list.length ? list : [item];
    idx = idx ?? list.indexOf(item);
    if (idx < 0) { list = [item]; idx = 0; }
    S.current = item; S.playingList = list; S.playingIndex = idx;
    // only a window of the list goes to the player (a category can have thousands of channels)
    const from = Math.max(0, idx - 300), to = Math.min(list.length, idx + 301);
    const sub = list.slice(from, to);
    const items = sub.map(x => {
      const k = favKey(x), vod = x.kind !== 'live' && x.kind !== 'catchup';
      const at = vod ? (S.pos[k] || 0) : 0, d = S.durs[k] || 0;
      return { name: x.name || '', num: x.num ? String(x.num) : '', kind: x.kind, url: streamUrl(x), sub: x.seriesName || (x.kind === 'live' ? (x.catName || 'Live TV') : ''), key: k, start: (at > 30 && (!d || at < d - 60)) ? at : 0 };
    });
    S.androidPlay = { sub };
    addRecent(item);
    window.AndroidNative.play(JSON.stringify({ items, index: idx - from, ua: VLC_UA, autoNext: item.kind === 'episode' && (S.settings.autoNext ?? true) }));
  };

  window.__onPlayerResult = function (json) {
    let r; try { r = JSON.parse(json); } catch { return; }
    const P = S.androidPlay; if (!P) return;
    let changed = false;
    for (const p of r.progress || []) {
      const it = P.sub[p.i]; if (!it || it.kind === 'live' || it.kind === 'catchup') continue;
      const k = favKey(it);
      S.pos[k] = p.dur > 0 && p.pos >= p.dur - 30 ? p.dur : p.pos;
      if (p.dur > 0) S.durs[k] = p.dur;
      if (it !== S.current) addRecent(it);
      changed = true;
    }
    if (changed) { save(pKey('pos'), S.pos); save(pKey('durs'), S.durs); }
    const last = P.sub[r.index];
    if (last && last !== S.current) { S.current = last; addRecent(last); }
    if (r.gotoNum) {
      const ch = typeof findChannelByNum === 'function' && findChannelByNum(r.gotoNum);
      if (ch) { const L = S.data.live.items.filter(x => x.cat === ch.cat); return setTimeout(() => playFull(ch, L, L.indexOf(ch)), 300); }
      toast('Channel ' + r.gotoNum + ' not found');
    }
    if (S.view === 'dash' && typeof goHome === 'function') goHome();
  };

  // Login form on a tablet keyboard: no auto-capital / autocorrect (it changes usernames like "abc" -> "Abc")
  document.querySelectorAll('#form-xtream input, #form-m3u input').forEach(i => {
    i.setAttribute('autocapitalize', 'none'); i.setAttribute('autocorrect', 'off'); i.setAttribute('spellcheck', 'false');
  });
  const urlIn = document.querySelector('#form-xtream input[name=url]'); if (urlIn) { urlIn.type = 'url'; urlIn.setAttribute('inputmode', 'url'); }

  // Xtream login: forgive common mistakes in the server address (https instead of http, missing :8080)
  const fx = document.querySelector('#form-xtream');
  if (fx) fx.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const clean = (v) => (v || '').replace(/\s+/g, '');
    const user = { id: Date.now().toString(36), type: 'xtream', name: f.name.trim(), username: clean(f.username), password: (f.password || '').trim(), url: normBase(clean(f.url)), uaFixed: (f.ua || '').trim() || undefined };
    // a full get.php / player_api link pasted into the server box: take user + pass from it
    try { const u = new URL(clean(f.url)); if (u.searchParams.get('username')) { user.username = u.searchParams.get('username'); user.password = u.searchParams.get('password') || user.password; } } catch {}
    const tries = [user.url];
    if (/^https:/i.test(user.url)) tries.push(user.url.replace(/^https:/i, 'http:'));
    for (const t of [...tries]) if (!/:\d+$/.test(t)) tries.push(t.replace(/^https:/i, 'http:') + ':8080');
    const uniq = [...new Set(tries)];
    let ok = false;
    for (let i = 0; i < uniq.length && !ok; i++) {
      user.url = uniq[i];
      ok = await login(user, true);
      // only retry another address when the server could not be reached (not for a wrong password)
      if (!ok && !/SSL|TLS|connect|refused|timed? ?out|Unable to resolve|No response|ECONN|EOF|reset/i.test(document.querySelector('#login-msg').textContent)) break;
    }
    if (ok) { S.users.push(user); await save('users', S.users); e.target.reset(); }
  };

  // downloads: entries Android no longer lists (cancelled, or restarted after "server busy") leave the ⬇ menu
  window.__dlKeep = function (ids) {
    if (typeof DL === 'undefined') return;
    let ch = false;
    for (const k of [...DL.keys()]) if (k > 0 && !ids.has(k)) { DL.delete(k); ch = true; }
    if (ch && typeof renderDownloads === 'function') renderDownloads();
  };

  // ---------------------------------------------------------------- Free Channels (legal free-to-air playlists)
  // iptv-org (publicly available streams) + Free-TV (only officially free channels). One tap = add + open.
  // These do NOT use the Xtream account, so they don't take its 1 connection.
  const IO = 'https://raw.githubusercontent.com/iptv-org/iptv/gh-pages/';
  const FREE_LISTS = [
    { name: 'Free · Gujarati', flag: '🪔', url: IO + 'languages/guj.m3u' },
    { name: 'Free · Hindi', flag: '🇮🇳', url: IO + 'languages/hin.m3u' },
    { name: 'Free · India (all)', flag: '🇮🇳', url: IO + 'countries/in.m3u' },
    { name: 'Free · South Africa', flag: '🇿🇦', url: IO + 'countries/za.m3u' },
    { name: 'Free · Mozambique', flag: '🇲🇿', url: IO + 'countries/mz.m3u' },
    { name: 'Free · News (world)', flag: '📰', url: IO + 'categories/news.m3u' },
    { name: 'Free-TV (best quality)', flag: '⭐', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8' },
    { name: 'Free · All world', flag: '🌍', url: IO + 'index.m3u' }
  ];
  async function openFree(i) {
    const f = FREE_LISTS[i]; if (!f) return;
    let user = S.users.find(u => u.type === 'm3u' && u.url === f.url);
    const isNew = !user;
    if (isNew) user = { id: 'free' + Date.now().toString(36), type: 'm3u', name: f.name, url: f.url, free: true };
    const ok = await login(user, false);
    if (ok && isNew) { S.users.push(user); await save('users', S.users); renderUsers(); }
  }
  const wrap = document.querySelector('#screen-login .login-wrap');
  if (wrap) {
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'free-box';
    card.innerHTML = '<h2>📺 Free Channels <small style="font-weight:400;color:var(--muted)">· ફ્રી ચેનલો</small></h2>' +
      '<div class="free-grid">' + FREE_LISTS.map((f, i) => `<button class="free-btn" data-free="${i}"><span>${f.flag}</span>${esc(f.name.replace(/^Free · /, ''))}</button>`).join('') + '</div>' +
      '<p class="free-note">Legal free-to-air channels (iptv-org, Free-TV). Some streams can be offline. Does not use your IPTV account.</p>';
    card.addEventListener('click', (e) => { const b = e.target.closest('[data-free]'); if (b) openFree(+b.dataset.free); });
    wrap.appendChild(card);
  }

  // 🔊 Sound in Settings (volume boost + auto-level) – saved on the tablet, the player uses the same values
  (function soundSettings() {
    const anchor = document.querySelector('#settings label.row:has(#set-hideadult)') || document.querySelector('#settings .set-sec');
    if (!anchor || !window.AndroidNative || !window.AndroidNative.soundGet) return;
    const box = document.createElement('div');
    box.className = 'set-sec snd-sec';
    box.innerHTML = '<b>🔊 Sound</b>' +
      '<div class="snd-row"><span>Extra volume (above 100%)</span><b id="snd-val">100%</b></div>' +
      '<input type="range" id="snd-boost" min="100" max="200" step="5" value="100">' +
      '<small class="snd-warn hidden" id="snd-warn">⚠ 150% થી વધારે: અવાજ ફાટી શકે અને કાન માટે નુકસાનકારક છે</small>' +
      '<label class="row"><input type="checkbox" id="snd-auto"> Auto-level – every channel about equally loud, loud ads tamed (changes slowly)</label>' +
      '<small class="muted" id="snd-note">In the player: swipe up on the right side (or the + volume button) past 100% – it stops at 150% with a warning, swipe again for up to 200%. Auto-level starts with the next video.</small>' +
      '<div class="row-btns"><button class="btn small ghost" id="snd-reset">↺ Reset to default</button></div>';
    anchor.insertAdjacentElement('afterend', box);
    const $s = (id) => box.querySelector('#' + id);
    const show = () => { const v = +$s('snd-boost').value; $s('snd-val').textContent = v + '%'; $s('snd-warn').classList.toggle('hidden', v <= 150); };
    const load = () => {
      let c = { boost: 100, auto: false, supported: true };
      try { c = JSON.parse(window.AndroidNative.soundGet()); } catch {}
      $s('snd-boost').value = c.boost; $s('snd-auto').checked = !!c.auto; show();
      if (!c.supported) { $s('snd-boost').disabled = $s('snd-auto').disabled = true; $s('snd-note').textContent = 'This tablet cannot do this (needs Android 9 or newer).'; }
    };
    const store = () => { window.AndroidNative.soundSet(+$s('snd-boost').value, $s('snd-auto').checked); };
    $s('snd-boost').addEventListener('input', () => { show(); store(); });
    $s('snd-auto').addEventListener('change', store);
    $s('snd-reset').onclick = () => { $s('snd-boost').value = 100; $s('snd-auto').checked = false; show(); store(); toast('Sound: default'); };
    // refresh whenever Settings opens (the player panel may have changed it)
    new MutationObserver(() => { if (!document.getElementById('settings').classList.contains('hidden')) load(); })
      .observe(document.getElementById('settings'), { attributes: true, attributeFilter: ['class'] });
    load();
  })();

  // hardware back: close the top window first, then go to Home, then leave the app
  window.__androidBack = function () {
    const open = [...document.querySelectorAll('.modal:not(.hidden), #details:not(.hidden), #subsearch:not(.hidden)')];
    if (open.length) { open[open.length - 1].classList.add('hidden'); return true; }
    const s = document.querySelector('#search');
    if (s && s.value) { s.value = ''; s.dispatchEvent(new Event('input')); return true; }
    if (S.user && S.view && S.view !== 'dash' && typeof goHome === 'function') { goHome(); return true; }
    return false;
  };
})();
