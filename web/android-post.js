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
