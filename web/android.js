// Android: window.native for the shared web UI (the Windows app gets it from Electron)
(function () {
  const PROXY = '/proxy';
  let UA = 'VLC/3.0.21 LibVLC/3.0.21';
  document.documentElement.classList.add('is-android');

  async function req(url, ua, headers) {
    const q = new URLSearchParams({ u: url, ua: ua || UA });
    if (headers) q.set('h', JSON.stringify(headers));
    try {
      const r = await fetch(PROXY + '?' + q.toString(), { cache: 'no-store' });
      const text = await r.text();
      if (r.status === 599) return { error: r.headers.get('X-Error') || text || 'Network error' };
      return { status: r.status, text };
    } catch (e) { return { error: String(e && e.message || e) }; }
  }

  // big lists (66k movies...) go to IndexedDB, small settings to localStorage
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => { const o = indexedDB.open('alnur', 1); o.onupgradeneeded = () => o.result.createObjectStore('kv'); o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error); });
    return dbp;
  }
  async function idb(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('kv', mode); const r = fn(t.objectStore('kv')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); }

  const noop = () => {};

  // ---- downloads: Android DownloadManager (Java side), polled for the ⬇ menu
  let dlCb = null, dlT = null;
  const seen = new Map(); // id -> {got, t} for speed
  function dlPoll() {
    clearTimeout(dlT);
    let list = [];
    try { list = JSON.parse(window.AndroidNative.dlList() || '[]'); } catch { list = []; }
    const now = Date.now(), ids = new Set();
    for (const d of list) {
      ids.add(d.id);
      const p = seen.get(d.id);
      d.speed = p && now > p.t ? Math.max(0, (d.got - p.got) / ((now - p.t) / 1000)) : 0;
      seen.set(d.id, { got: d.got, t: now });
      if (dlCb) dlCb(d);
    }
    if (dlCb) window.__dlKeep && window.__dlKeep(ids);
    if (list.some(d => ['starting', 'downloading', 'waiting'].includes(d.state))) dlT = setTimeout(dlPoll, 1000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) dlPoll(); });
  const nope = async () => ({ ok: false, error: 'Not available on the tablet' });
  window.native = {
    isAndroid: true,
    get: async (url, asText = false, ua = null) => {
      const r = await req(url, ua);
      if (r.error) return { ok: false, error: r.error };
      if (r.status < 200 || r.status >= 300) return { ok: false, status: r.status, error: 'HTTP ' + r.status };
      if (asText) return { ok: true, data: r.text };
      try { return { ok: true, data: JSON.parse(r.text) }; } catch { return { ok: false, error: 'Server did not return valid data (check URL / login).' }; }
    },
    setUA: async (ua) => { if (ua) UA = ua; return true; },
    storeGet: async (k) => { try { const v = localStorage.getItem('s:' + k); return v == null ? undefined : JSON.parse(v); } catch { return undefined; } },
    storeSet: async (k, v) => { try { localStorage.setItem('s:' + k, JSON.stringify(v)); } catch (e) { try { await idb('readwrite', s => s.put(v, 's:' + k)); } catch {} } return true; },
    listGet: async (k) => { try { return (await idb('readonly', s => s.get('l:' + k))) || null; } catch { return null; } },
    listSet: async (k, v) => { try { await idb('readwrite', s => s.put(v, 'l:' + k)); return true; } catch { return false; } },
    tmdb: async (p, key) => {
      if (!key) return { error: 'no key' };
      const bearer = key.length > 50;
      const url = 'https://api.themoviedb.org/3/' + p + (p.includes('?') ? '&' : '?') + (bearer ? '' : 'api_key=' + encodeURIComponent(key));
      const r = await req(url, 'AlnurIPTV', bearer ? { Authorization: 'Bearer ' + key, Accept: 'application/json' } : { Accept: 'application/json' });
      if (r.error) return { error: r.error };
      if (r.status !== 200) return { error: 'HTTP ' + r.status + (r.status === 401 ? ' – check your TMDB key' : '') };
      try { return { data: JSON.parse(r.text) }; } catch { return { error: 'bad answer' }; }
    },
    copy: async (t) => { window.AndroidNative.copy(String(t)); return true; },
    openExternal: async (u) => { window.AndroidNative.openUrl(u); return true; },
    toggleFullscreen: async () => true, exitFullscreen: async () => true,
    // PC-only features
    convert: nope, duration: nope, convertError: async () => '', probe: nope, convertLog: async () => null,
    diagAppend: async () => true, runDiag: nope, onDiagProgress: noop,
    recList: async () => [], recAdd: nope, recInstant: nope, recCancel: nope, recDelete: nope, recFolder: nope, onRec: noop, onRecStarting: noop,
    backupExport: nope, backupImport: nope,
    epgLoad: async () => ({ ok: false, error: 'not on tablet' }), epgStatus: async () => ({}), epgFor: async () => ({}),
    subsSearch: async () => ({ results: [], errors: ['Online subtitles are not on the tablet yet'] }), subsDownload: nope,
    openVLC: async (url, name) => { try { return !!window.AndroidNative.openVlc(url, name || ''); } catch { return false; } },
    dlStart: async (url, name, ua) => {
      let r = {};
      try { r = JSON.parse(window.AndroidNative.dlStart(url, name, ua || UA)); } catch { r = { id: -1, error: 'Download could not start' }; }
      if (!(r.id > 0)) { if (dlCb) dlCb({ id: -Date.now(), name, state: 'error', error: r.error || 'Download could not start', got: 0, total: 0 }); return { ok: false, error: r.error }; }
      setTimeout(dlPoll, 300);
      return { ok: true, id: r.id };
    },
    dlCancel: async (id) => { window.AndroidNative.dlCancel(String(id)); setTimeout(dlPoll, 200); return true; },
    dlShow: async (file) => { window.AndroidNative.dlShow(String(file || '')); return true; },
    onDl: (cb) => { dlCb = cb; setTimeout(dlPoll, 500); }
  };
})();
