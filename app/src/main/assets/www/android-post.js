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
