/* Alnur IPTV Player - renderer */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UA_LIST = [
  'okhttp/4.12.0',
  'IPTVSmartersPro',
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
  'Dalvik/2.1.0 (Linux; U; Android 13; SM-A736B Build/TP1A.220624.014)',
  'VLC/3.0.20 LibVLC/3.0.20',
  'TiviMate/4.7.0 (Android 12)',
  'IBOPlayer',
  'XCIPTV',
  'Kodi/20.2 (Windows NT 10.0.19045; Win64; x64) App_Bitness/64 Version/20.2',
  'ExoPlayerLib/2.18.7',
  'Lavf/58.76.100',
  'IPTV Smarters/1.0.3 (iPad; iOS 16.6; Scale/2.00)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
];
// Identities tried for the video stream itself (many servers only stream to VLC / known players)
const STREAM_UAS = ['VLC/3.0.21 LibVLC/3.0.21', 'VLC/3.0.20 LibVLC/3.0.20', 'IPTVSmartersPro', 'okhttp/4.12.0', 'Lavf/58.76.100', 'Lavf/60.16.100'];
const ADULT_RE = /adult|xxx|18\+|porn|for adults/i;

const S = {
  users: [], user: null, account: null,
  data: { live: null, movie: null, series: null },
  settings: { ua: 'auto', format: 'ts', vlcPath: '', autoVLC: false, hideAdult: true },
  fav: {}, recent: [], pos: {},
  view: 'live', cat: '__all', list: [], rendered: 0,
  playingList: [], playingIndex: -1, current: null
};

// ---------------------------------------------------------------- helpers
function loader(on, text = 'Loading...') { $('#loader').classList.toggle('hidden', !on); $('#loader-text').textContent = text; }
let toastT;
function toast(msg, ms = 2800) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }
function show(id) { $$('.screen').forEach(s => s.classList.add('hidden')); $(id).classList.remove('hidden'); }
function b64(s) { if (!s) return ''; try { return decodeURIComponent(escape(atob(s))); } catch { return s; } }
function fmtTime(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function normBase(u) { u = u.trim().replace(/\/+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'http://' + u; return u.replace(/\/(player_api\.php|get\.php).*$/i, ''); }
const uKey = (k) => `${k}_${S.user.id}`;                                      // per playlist (server settings)
const pKey = (k) => S.profile && S.profile !== 'main' ? `${k}_${S.user.id}_p_${S.profile}` : uKey(k); // per profile
async function save(key, val) { await window.native.storeSet(key, val); }

// ---------------------------------------------------------------- Xtream API
function api(action = '', extra = '') {
  const u = S.user;
  return `${u.url}/player_api.php?username=${encodeURIComponent(u.username)}&password=${encodeURIComponent(u.password)}${action ? '&action=' + action : ''}${extra}`;
}
async function getJSON(url) {
  let r = await window.native.get(url);
  // server rate limit (HTTP 503 / 429): wait and ask again instead of failing
  for (let i = 1; !r.ok && (r.status === 503 || r.status === 429) && i <= 3; i++) {
    await new Promise(res => setTimeout(res, 3000 * i));
    r = await window.native.get(url);
  }
  if (!r.ok) throw new Error(r.error || 'Request failed');
  return r.data;
}
function liveFormat() {
  const allowed = (S.account && Array.isArray(S.account.allowed_output_formats)) ? S.account.allowed_output_formats.map(String) : [];
  let f = S.settings.format;
  if (allowed.length && !allowed.includes(f)) f = allowed.includes('ts') ? 'ts' : allowed.includes('m3u8') ? 'm3u8' : f;
  return f;
}
// Alternative addresses for the same stream (panels differ); tried one by one when the server refuses
function streamUrls(item) {
  const first = streamUrl(item);
  if (item.url || item.kind !== 'live') return [first];
  const u = S.user, cred = `${encodeURIComponent(u.username)}/${encodeURIComponent(u.password)}`;
  const other = liveFormat() === 'ts' ? 'm3u8' : 'ts';
  return [first, `${u.url}/live/${cred}/${item.id}.${other}`, `${u.url}/${cred}/${item.id}`];
}
// Catch-up (timeshift): /timeshift/user/pass/<minutes>/<YYYY-MM-DD:HH-MM in server time>/<id>.ts
function srvStamp(epochSec) { const d = new Date(epochSec * 1000 + (S.srvOffset || 0)); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`; }
function catchupUrl(item, fromSec = 0) {
  const u = S.user, cred = `${encodeURIComponent(u.username)}/${encodeURIComponent(u.password)}`;
  const start = item.start + fromSec;
  const mins = Math.max(1, Math.ceil((item.dur - fromSec) / 60) + 1);
  return `${u.url}/timeshift/${cred}/${mins}/${srvStamp(start)}/${item.chId}.ts`;
}
function streamUrl(item) {
  if (item.kind === 'catchup') return catchupUrl(item, 0);
  if (item.url) return item.url;
  const u = S.user, cred = `${encodeURIComponent(u.username)}/${encodeURIComponent(u.password)}`;
  if (item.kind === 'live') return `${u.url}/live/${cred}/${item.id}.${liveFormat()}`;
  if (item.kind === 'movie') return `${u.url}/movie/${cred}/${item.id}.${item.ext || 'mp4'}`;
  if (item.kind === 'episode') return `${u.url}/series/${cred}/${item.id}.${item.ext || 'mp4'}`;
  return '';
}

// ---------------------------------------------------------------- M3U parser
function parseM3U(text) {
  const out = { live: [], movie: [], series: [] };
  const lines = text.split(/\r?\n/);
  let meta = null, n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; });
      const name = line.substring(line.lastIndexOf(',') + 1).trim();
      meta = { name: attrs['tvg-name'] && !name ? attrs['tvg-name'] : name, logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || 'Uncategorized', epgId: attrs['tvg-id'] || '' };
    } else if (!line.startsWith('#') && meta) {
      const url = line;
      let kind = 'live';
      if (/\/series\//i.test(url)) kind = 'series';
      else if (/\/movie\//i.test(url) || /\.(mp4|mkv|avi|mov|wmv|flv)(\?|$)/i.test(url)) kind = 'movie';
      out[kind].push({ kind: kind === 'series' ? 'episode' : kind, id: 'm' + (++n), name: meta.name, logo: meta.logo, cat: meta.group, url, epgId: meta.epgId });
      meta = null;
    }
  }
  const build = (items) => {
    const map = new Map();
    items.forEach(i => map.set(i.cat, (map.get(i.cat) || 0) + 1));
    return { cats: [...map.keys()].map(k => ({ id: k, name: k })), items };
  };
  return { live: build(out.live), movie: build(out.movie), series: build(out.series) };
}

// ---------------------------------------------------------------- users / login
async function loadUsers() {
  S.users = (await window.native.storeGet('users')) || [];
  const s = await window.native.storeGet('settings');
  if (s) Object.assign(S.settings, s);
  applyTheme();
  $('#btn-view').textContent = S.settings.viewMode === 'list' ? '☰' : '▦';
  // open the last used playlist straight away
  const last = await window.native.storeGet('lastUser');
  const u = S.users.find(x => x.id === last);
  if (u) setTimeout(() => login(u), 50);
  renderUsers();
}
function renderUsers() {
  const has = S.users.length > 0;
  $('#user-list-box').classList.toggle('hidden', !has);
  $('#login-box').classList.toggle('hidden', has);
  $('#btn-back-users').classList.toggle('hidden', !has);
  $('#user-list').innerHTML = S.users.map((u, i) => `
    <div class="user-row">
      <div class="u-main" data-i="${i}"><b>${esc(u.name)}<span class="badge">${u.type === 'm3u' ? 'M3U' : 'XTREAM'}</span></b>
      <small>${esc(u.type === 'm3u' ? u.url.slice(0, 60) : u.username + ' @ ' + u.url)}</small></div>
      <button class="del" data-del="${i}" title="Delete">🗑</button>
    </div>`).join('');
}
$('#user-list').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-del]');
  if (d) {
    if (!confirm('Delete this user?')) return;
    S.users.splice(+d.dataset.del, 1); await save('users', S.users); renderUsers(); return;
  }
  const m = e.target.closest('.u-main');
  if (m) login(S.users[+m.dataset.i]);
});
$('#btn-add-user').onclick = () => { $('#user-list-box').classList.add('hidden'); $('#login-box').classList.remove('hidden'); };
$('#btn-back-users').onclick = () => renderUsers();
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $('#form-xtream').classList.toggle('hidden', t.dataset.tab !== 'xtream');
  $('#form-m3u').classList.toggle('hidden', t.dataset.tab !== 'm3u');
  $('#login-msg').textContent = '';
});
$('#form-xtream').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const user = { id: Date.now().toString(36), type: 'xtream', name: f.name.trim(), username: f.username.trim(), password: f.password.trim(), url: normBase(f.url), uaFixed: (f.ua || '').trim() || undefined };
  if (await login(user, true)) { S.users.push(user); await save('users', S.users); e.target.reset(); }
};
$('#form-m3u').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  let url = f.url.trim(); if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  const user = { id: Date.now().toString(36), type: 'm3u', name: f.name.trim(), url, uaFixed: (f.ua || '').trim() || undefined };
  // If the M3U link is actually an Xtream get.php link, upgrade to Xtream (gives EPG, posters, seasons)
  try {
    const u = new URL(url);
    if (/get\.php$/i.test(u.pathname) && u.searchParams.get('username') && u.searchParams.get('password')) {
      Object.assign(user, { type: 'xtream', url: u.origin, username: u.searchParams.get('username'), password: u.searchParams.get('password') });
    }
  } catch {}
  if (await login(user, true)) { S.users.push(user); await save('users', S.users); e.target.reset(); }
};

// Try user-agents until the server answers. Gentle: this server rate-limits (HTTP 503) if asked too fast.
const API_UAS_FIRST = ['Dalvik/2.1.0 (Linux; U; Android 13; SM-A736B Build/TP1A.220624.014)', 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3', 'IPTVSmartersPro'];
async function probe(url, asText, isGood) {
  const order = S.user.uaFixed ? [S.user.uaFixed]
    : S.settings.ua && S.settings.ua !== 'auto' ? [S.settings.ua]
    : [...new Set([S.user.ua, ...API_UAS_FIRST, ...UA_LIST].filter(Boolean))];
  let lastErr = 'No response', n = 0, n503 = 0;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < order.length; i++) {
    const ua = order[i];
    if (n++) { loader(true, `Connecting… (try ${n})`); await wait(1500); }
    let r = await window.native.get(url, asText, ua);
    if (!r.ok && r.status === 503 && n503 < 2) {
      // probably "too many requests": wait and ask again with the SAME identity
      n503++; loader(true, 'Server busy – waiting a few seconds…'); await wait(5000 * n503);
      r = await window.native.get(url, asText, ua);
    }
    if (r.ok && isGood(r.data)) {
      if (S.user.ua !== ua) { S.user.ua = ua; const k = S.users.findIndex(u => u.id === S.user.id); if (k >= 0) { S.users[k].ua = ua; save('users', S.users); } }
      await window.native.setUA(ua);
      return r.data;
    }
    if (r.ok) return r.data;
    lastErr = r.error;
    if (r.status === 503 && ua === S.user.ua) break; // this identity worked before: server is just busy, other identities won't help
    if (n >= 6) break; // don't hammer the server
  }
  if (/HTTP 503/.test(lastErr)) throw new Error('server is temporarily refusing connections (HTTP 503 – too many requests). Please wait 2–3 minutes, close other IPTV apps, and try again.');
  throw new Error(lastErr);
}

async function login(user, isNew = false) {
  S.offline = false; clearTimeout(S.reconnT);
  S.user = user; S.data = { live: null, movie: null, series: null }; S.account = null;
  loader(true, 'Connecting to server...');
  $('#login-msg').textContent = '';
  try {
    if (user.type === 'xtream') {
      let info;
      try { info = await probe(api(), false, d => d && d.user_info); }
      catch (e) {
        const cached = await window.native.storeGet(uKey('cache_info'));
        if (!cached || !/503|429|timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|No response/i.test(e.message)) throw e;
        info = cached; S.offline = true;
      }
      if (!S.offline) window.native.storeSet(uKey('cache_info'), info);
      if (!info || !info.user_info || String(info.user_info.auth) !== '1') throw new Error('Invalid username / password');
      if (info.user_info.status && info.user_info.status !== 'Active') throw new Error('Account status: ' + info.user_info.status);
      S.account = info.user_info;
      S.server = info.server_info || {};
      S.srvOffset = 0;
      if (S.server.time_now && S.server.timestamp_now) { const loc = Date.parse(S.server.time_now.replace(' ', 'T') + 'Z'); if (!isNaN(loc)) S.srvOffset = loc - (+S.server.timestamp_now) * 1000; }
      if (info.server_info && info.server_info.server_protocol && info.server_info.url && !isNew) { /* keep user URL */ }
    } else {
      loader(true, 'Downloading playlist...');
      const text = await probe(user.url, true, t => typeof t === 'string' && t.includes('#EXTINF'));
      if (!text.includes('#EXTINF')) throw new Error('This is not a valid M3U playlist');
      S.data = parseM3U(text);
    }
    S.profiles = (await window.native.storeGet(uKey('profiles'))) || [{ id: 'main', name: 'Main' }];
    S.profile = (await window.native.storeGet(uKey('profile'))) || 'main';
    if (!S.profiles.find(p => p.id === S.profile)) S.profile = 'main';
    await loadProfileData();
    S.directBlocked = !!(await window.native.storeGet(uKey('directBlocked')));
    S.chanStage = (await window.native.storeGet(uKey('chanStage'))) || {};
    S.recentStages = [];
    loader(false);
    save('lastUser', user.id);
    await openBrowse('live');
    setTimeout(() => autoLoadEpg(false), 1500);
    if (S.offline) { toast('⚠️ Server is busy right now (HTTP 503). Showing your saved channel list – playing may still work. Reconnecting automatically…', 9000); scheduleReconnect(1); }
    return true;
  } catch (err) {
    loader(false);
    const m = 'Login failed: ' + err.message;
    if (isNew) $('#login-msg').textContent = m; else { toast(m); }
    return false;
  }
}

// server busy at login: try again quietly in the background (1, 2, 4, 8… minutes, max 15)
function scheduleReconnect(n) {
  clearTimeout(S.reconnT);
  const user = S.user;
  S.reconnT = setTimeout(async () => {
    if (S.user !== user || !S.offline) return;
    const r = await window.native.get(api(), false, S.user.ua);
    if (S.user !== user) return;
    if (r.ok && r.data && r.data.user_info && String(r.data.user_info.auth) === '1') {
      S.offline = false; S.account = r.data.user_info; window.native.storeSet(uKey('cache_info'), r.data);
      if (S.user.ua) window.native.setUA(S.user.ua);
      toast('✅ Server connected again – lists are up to date');
      ['live', 'movie', 'series'].forEach(k => { if (S.data[k]) refreshList(k, uKey('list_' + k), S.user); });
    } else scheduleReconnect(n + 1);
  }, Math.min(15, 2 ** (n - 1)) * (window.__reconnMs || 60000));
}

// ---------------------------------------------------------------- profiles, hidden / locked categories, PIN
async function loadProfileData() {
  S.fav = (await window.native.storeGet(pKey('fav'))) || {};
  S.recent = (await window.native.storeGet(pKey('recent'))) || [];
  S.pos = (await window.native.storeGet(pKey('pos'))) || {};
  S.durs = (await window.native.storeGet(pKey('durs'))) || {};
  S.cont = (await window.native.storeGet(pKey('cont'))) || S.recent.filter(i => i.kind === 'movie' || i.kind === 'episode');
  S.hiddenCats = (await window.native.storeGet(pKey('hiddenCats'))) || {};
  S.lockedCats = (await window.native.storeGet(pKey('lockedCats'))) || {};
  S.unlocked = {}; S.showHidden = false;
}
async function switchProfile(id) {
  S.profile = id; await save(uKey('profile'), id);
  await loadProfileData();
  toast('Profile: ' + (S.profiles.find(p => p.id === id) || {}).name);
  if (['live', 'movie', 'series', 'fav', 'recent'].includes(S.view)) openBrowse(S.view); else goHome();
}
const catKey = (id) => `${S.view}:${id}`;
const isAdultCat = (c) => ADULT_RE.test(c.name);
function isLocked(view, id) {
  if (S.lockedCats[`${view}:${id}`]) return true;
  if (S.settings.pin && S.settings.lockAdult !== false && S.data[view]) { const c = S.data[view].cats.find(x => x.id === id); if (c && isAdultCat(c)) return true; }
  return false;
}
function pinPrompt(title) {
  return new Promise((resolve) => {
    const m = $('#pinmodal'); $('#pin-title').textContent = title; $('#pin-in').value = ''; $('#pin-msg').textContent = '';
    m.classList.remove('hidden'); setTimeout(() => $('#pin-in').focus(), 50);
    const done = (v) => { m.classList.add('hidden'); $('#pin-ok').onclick = $('#pin-cancel').onclick = $('#pin-in').onkeydown = null; resolve(v); };
    $('#pin-ok').onclick = () => done($('#pin-in').value.trim());
    $('#pin-cancel').onclick = () => done(null);
    $('#pin-in').onkeydown = (e) => { if (e.key === 'Enter') done($('#pin-in').value.trim()); if (e.key === 'Escape') done(null); };
  });
}
function pinPromptText(title) {
  const inp = $('#pin-in'); inp.type = 'text'; inp.style.letterSpacing = '0'; inp.maxLength = 24; inp.style.fontSize = '16px';
  return pinPrompt(title).then(v => { inp.type = 'password'; inp.style.letterSpacing = '8px'; inp.maxLength = 8; inp.style.fontSize = '22px'; return v; });
}
async function askPin() {
  if (!S.settings.pin) return true;
  const v = await pinPrompt('Enter parental PIN');
  if (v === null) return false;
  if (v !== S.settings.pin) { toast('Wrong PIN'); return false; }
  return true;
}
async function ensurePinExists() {
  if (S.settings.pin) return true;
  const a = await pinPrompt('Create a 4-digit parental PIN'); if (!a) return false;
  if (!/^\d{4,8}$/.test(a)) { toast('PIN must be 4–8 digits'); return false; }
  const b = await pinPrompt('Repeat the PIN'); if (a !== b) { toast('PINs did not match'); return false; }
  S.settings.pin = a; save('settings', S.settings); toast('🔒 Parental PIN set'); return true;
}

// ---------------------------------------------------------------- dashboard / navigation
function setNav(v) { $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === v)); }
function goHome() {
  stopAll();
  show('#screen-main');
  S.view = 'dash'; setNav('dash');
  $('#side').classList.add('hidden'); $('#browse').classList.add('hidden'); $('#recview').classList.add('hidden'); $('#guideview').classList.add('hidden'); $('#dash').classList.remove('hidden');
  $('#crumb').textContent = 'Dashboard';
  const a = S.account;
  if (a) {
    const exp = a.exp_date && a.exp_date !== 'null' ? new Date(+a.exp_date * 1000).toLocaleDateString() : 'Unlimited';
    $('#acc-info').textContent = `${S.user.name} (${a.username})  ·  Expiry: ${exp}  ·  Connections: ${a.active_cons ?? 0}/${a.max_connections ?? '-'}`;
  } else $('#acc-info').textContent = `Playlist: ${S.user.name}`;
  renderPlaylistBox();
  updateCounts();
  // Continue watching: movies / episodes started but not finished
  const cont = S.cont.filter(i => progressOf(i) > 0.01 && progressOf(i) < 0.92).slice(0, 12);
  S.contList = cont;
  $('#dash-cont-wrap').classList.toggle('hidden', !cont.length);
  const rmBtn = (k, w) => `<button class="rm-x" data-rm${w}="${k}" title="Remove">✖</button>`;
  $('#dash-cont').innerHTML = cont.map((i, k) => cardHTML(i, k, true).replace(/^(<div[^>]*>)/, `$1${rmBtn(k, 'c')}`).replace('</div>', '</div>').replace(/<div class="t"/, `<div class="pbarmini"><div style="width:${Math.round(progressOf(i) * 100)}%"></div></div><div class="t"`)).join('');
  const rec = S.recent.slice(0, 12);
  S.dashList = rec;
  $('#dash-recent').innerHTML = rec.length ? rec.map((i, k) => cardHTML(i, k, true).replace(/^(<div[^>]*>)/, `$1${rmBtn(k, 'r')}`)).join('') : '<div class="empty" style="padding:20px">Nothing watched yet.</div>';
}
function updateCounts() {
  ['live', 'movie', 'series'].forEach(k => {
    const d = S.data[k];
    $('#cnt-' + k).textContent = d ? `${d.items.length.toLocaleString()} ${k === 'live' ? 'channels' : 'titles'}` : '';
  });
}
async function preloadCounts() {
  if (S.user.type !== 'xtream') return;
  try { await ensureData('live'); updateCounts(); } catch {}
  for (const k of ['movie', 'series']) { // only if saved before - never a big download nobody asked for
    if (S.data[k]) continue;
    const c = await window.native.listGet(uKey('list_' + k)).catch(() => null);
    if (c && c.items && c.items.length && !S.data[k]) { S.data[k] = c; if (!S.offline && listOld(c)) refreshList(k, uKey('list_' + k), S.user); }
  }
  updateCounts();
}
function switchUsers() { stopAll(); S.user = null; show('#screen-login'); renderUsers(); }
$('#btn-switch').onclick = switchUsers;
$('#btn-reload').onclick = async () => {
  if (S.user.type === 'm3u') { await login(S.user); toast('Playlist reloaded'); return; }
  toast('Downloading fresh lists from the server…');
  const v = S.view, kinds = ['live', 'movie', 'series'].filter(k => S.data[k] || k === v);
  loader(true, 'Updating lists…');
  try { for (const k of kinds) await ensureData(k, true); toast('✅ Lists updated'); } catch (e) { toast('Update failed: ' + e.message); }
  loader(false);
  if (['live', 'movie', 'series'].includes(v)) openBrowse(v); else updateCounts();
};
$$('[data-go]').forEach(b => b.onclick = () => openBrowse(b.dataset.go));
$$('.rail-btn').forEach(b => b.onclick = () => {
  const v = b.dataset.nav;
  if (v === 'dash') return goHome();
  if (v === 'settings') return openSettings();
  if (v === 'rec') return openRecordings();
  if (v === 'guide') return openGuide();
  if (v === 'search') { if (S.view === 'dash') openBrowse('live'); return setTimeout(() => $('#search').focus(), 50); }
  openBrowse(v);
});
function progressOf(i) { const k = favKey(i), p = S.pos[k] || 0, d = S.durs[k] || 0; if (!d) return p > 30 ? 0.05 : 0; return Math.min(1, p / d); }
async function removeCont(items) {
  const keys = new Set(items.map(favKey));
  S.cont = S.cont.filter(i => !keys.has(favKey(i)));
  for (const k of keys) { delete S.pos[k]; } // forget the resume point too
  await save(pKey('cont'), S.cont); await save(pKey('pos'), S.pos);
}
async function removeRecent(items) {
  const keys = new Set(items.map(favKey));
  S.recent = S.recent.filter(i => !keys.has(favKey(i)));
  await save(pKey('recent'), S.recent);
}
$('#clear-cont').onclick = async () => { if (!confirm('Clear "Continue watching"? (resume points are forgotten)')) return; await removeCont(S.cont.slice()); goHome(); toast('Continue watching cleared'); };
$('#clear-recent').onclick = async () => { if (!confirm('Clear "Recently watched"?')) return; S.recent = []; await save(pKey('recent'), []); goHome(); toast('Recently watched cleared'); };
$('#dash-cont').addEventListener('click', async e => {
  const rm = e.target.closest('[data-rmc]');
  if (rm) { e.stopPropagation(); await removeCont([S.contList[+rm.dataset.rmc]]); return goHome(); }
  const el = e.target.closest('[data-idx]'); if (!el) return;
  const item = S.contList[+el.dataset.idx]; playFull(item);
});
$('#dash-recent').addEventListener('click', async e => {
  const rm = e.target.closest('[data-rmr]');
  if (rm) { e.stopPropagation(); await removeRecent([S.dashList[+rm.dataset.rmr]]); return goHome(); }
  const el = e.target.closest('[data-idx]'); if (!el) return;
  const item = S.dashList[+el.dataset.idx];
  if (item.kind === 'live' || item.kind === 'episode') playFull(item); else openDetails(item);
});

// playlist (user) dropdown, like the "big b / Xtream Code" selector
function renderPlaylistBox() {
  $('#pl-name').textContent = S.user ? S.user.name : '-';
  const prof = S.profiles && S.profile !== 'main' ? ' · 👤 ' + ((S.profiles.find(p => p.id === S.profile) || {}).name || '') : '';
  $('#pl-type').textContent = S.user ? (S.user.type === 'm3u' ? 'M3U Playlist' : 'Xtream Code') + prof : '';
}
$('#pl-select').addEventListener('click', async (e) => {
  const menu = $('#pl-menu');
  const pd = e.target.closest('[data-profdel]');
  if (pd) { e.stopPropagation(); menu.classList.add('hidden'); if (!confirm('Delete this profile? (its favourites and history)')) return; S.profiles = S.profiles.filter(p => p.id !== pd.dataset.profdel); await save(uKey('profiles'), S.profiles); if (S.profile === pd.dataset.profdel) switchProfile('main'); return; }
  const pr = e.target.closest('[data-prof]');
  if (pr) {
    e.stopPropagation(); menu.classList.add('hidden');
    if (pr.dataset.prof === 'add') {
      const name = (await pinPromptText('New profile name (e.g. Kids)')) || ''; if (!name.trim()) return;
      const id = 'p' + Date.now().toString(36); S.profiles.push({ id, name: name.trim().slice(0, 24) }); await save(uKey('profiles'), S.profiles); return switchProfile(id);
    }
    if (pr.dataset.prof !== S.profile) switchProfile(pr.dataset.prof);
    return;
  }
  const it = e.target.closest('[data-pl]');
  if (it) {
    e.stopPropagation(); menu.classList.add('hidden');
    if (it.dataset.pl === 'add') { switchUsers(); $('#user-list-box').classList.add('hidden'); $('#login-box').classList.remove('hidden'); return; }
    const u = S.users[+it.dataset.pl];
    if (u && u.id !== S.user.id) login(u);
    return;
  }
  menu.innerHTML = '<div class="pl-sec">Playlists</div>' + S.users.map((u, i) => `<div class="pl-item ${S.user && u.id === S.user.id ? 'cur' : ''}" data-pl="${i}"><span>${esc(u.name)}</span><small>${u.type === 'm3u' ? 'M3U' : 'Xtream'}</small></div>`).join('') +
    `<div class="pl-item pl-add" data-pl="add">＋ Add playlist</div>` +
    '<div class="pl-sec">Profiles (own favourites & history)</div>' + (S.profiles || []).map(p => `<div class="pl-item ${p.id === S.profile ? 'cur' : ''}" data-prof="${p.id}"><span>👤 ${esc(p.name)}</span>${p.id !== 'main' ? `<small data-profdel="${p.id}" title="Delete profile">✖</small>` : ''}</div>`).join('') +
    `<div class="pl-item pl-add" data-prof="add">＋ Add profile</div>`;
  menu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => { if (!e.target.closest('#pl-select')) $('#pl-menu').classList.add('hidden'); });

// theme + view mode
function applyTheme() { document.body.classList.toggle('dark', S.settings.theme === 'dark'); $('#btn-theme').textContent = S.settings.theme === 'dark' ? '☀' : '☾'; }
$('#btn-theme').onclick = () => { S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); save('settings', S.settings); };
$('#btn-view').onclick = () => { S.settings.viewMode = S.settings.viewMode === 'list' ? 'grid' : 'list'; save('settings', S.settings); $('#btn-view').textContent = S.settings.viewMode === 'list' ? '☰' : '▦'; renderList(true); };

// ---------------------------------------------------------------- data
const LIST_API = { live: ['get_live_categories', 'get_live_streams'], movie: ['get_vod_categories', 'get_vod_streams'], series: ['get_series_categories', 'get_series'] };
async function fetchList(kind) {
  const A = LIST_API[kind];
  const cats = await getJSON(api(A[0]));
  const items = await getJSON(api(A[1]));
  const catArr = (Array.isArray(cats) ? cats : []).map(c => ({ id: String(c.category_id), name: c.category_name }));
  const catName = Object.fromEntries(catArr.map(c => [c.id, c.name]));
  const list = (Array.isArray(items) ? items : []).map(x => {
    if (kind === 'live') return { kind, id: x.stream_id, name: x.name, logo: x.stream_icon, cat: String(x.category_id), num: x.num, epgId: x.epg_channel_id, archive: +x.tv_archive || 0, archiveDays: +x.tv_archive_duration || 0 };
    if (kind === 'movie') return { kind, id: x.stream_id, name: x.name, logo: x.stream_icon, cat: String(x.category_id), rating: x.rating, ext: x.container_extension, added: +x.added || 0 };
    return { kind: 'series', id: x.series_id, name: x.name, logo: x.cover, cat: String(x.category_id), rating: x.rating, plot: x.plot, added: +x.last_modified || 0 };
  });
  list.forEach(i => { i.catName = catName[i.cat] || ''; });
  return { cats: catArr, items: list, at: Date.now() };
}
// Saved list opens instantly; a fresh copy is downloaded quietly in the background
async function ensureData(kind, force = false) {
  if (S.data[kind] && !force) return S.data[kind];
  if (S.user.type !== 'xtream') return (S.data[kind] = S.data[kind] || { cats: [], items: [] });
  const key = uKey('list_' + kind), user = S.user;
  if (!force) {
    const c = await window.native.listGet(key);
    if (S.user !== user) throw new Error('user changed');
    if (c && c.items && c.items.length) {
      S.data[kind] = c;
      if (!S.offline && listOld(c)) refreshList(kind, key, user);
      return c;
    }
  }
  if (S.offline) throw new Error('server is busy (HTTP 503) and this list was never loaded before. Please wait a few minutes.');
  const d = await fetchList(kind);
  if (S.user !== user) throw new Error('user changed');
  window.native.listSet(key, d);
  return (S.data[kind] = d);
}
const refreshing = {};
const LIST_MAX_AGE = 12 * 3600 * 1000; // saved lists are refreshed in the background when older than 12 h (or with ⟳)
const listOld = (c) => Date.now() - (c.at || 0) > LIST_MAX_AGE;
async function refreshList(kind, key, user) {
  if (refreshing[key]) return; refreshing[key] = true;
  await new Promise(r => setTimeout(r, { live: 1500, movie: 6000, series: 9000 }[kind])); // let the screen / first play go first
  try {
    const d = await fetchList(kind);
    if (S.user !== user || !d.items.length) return;
    const old = S.data[kind], added = old ? d.items.length - old.items.length : 0;
    S.data[kind] = d; window.native.listSet(key, d);
    if (kind === S.view && $('#player').classList.contains('hidden') && !$('#screen-main').classList.contains('hidden')) {
      const keep = { cat: S.cat, page: S.page, q: $('#search').value };
      renderCats && renderCats(); S.cat = keep.cat; S.page = keep.page; renderList(true);
    }
    updateCounts();
    if (added > 0) toast(`🆕 ${added} new ${kind === 'live' ? 'channels' : kind === 'movie' ? 'movies' : 'series'} added`);
  } catch {} finally { refreshing[key] = false; }
}

// ---------------------------------------------------------------- browse
const TITLES = { live: 'Live TV', movie: 'Movies', series: 'Series', fav: 'Favorites', recent: 'Recently watched' };
async function openBrowse(view) {
  stopAll();
  show('#screen-main');
  S.view = view; S.cat = '__all'; S.page = 0; setNav(view);
  $('#search').value = ''; $('#cat-filter').value = '';
  $('#dash').classList.add('hidden'); $('#recview').classList.add('hidden'); $('#guideview').classList.add('hidden'); $('#browse').classList.remove('hidden'); $('#side').classList.remove('hidden');
  $('#side-title').textContent = { live: 'Live Categories', movie: 'Movie Categories', series: 'Series Categories', fav: 'Favorites', recent: 'Recently watched' }[view];
  renderPlaylistBox();
  if (['live', 'movie', 'series'].includes(view) && !S.data[view]) {
    $('#cats').innerHTML = ''; $('#items').innerHTML = '<div class="empty">Loading…</div>';
    loader(true, `Loading ${TITLES[view].toLowerCase()}…`);
    try { await ensureData(view); } catch (e) { loader(false); toast('Error: ' + e.message); return goHome(); }
    loader(false);
  }
  renderCats(); renderList();
}
function visibleCats(includeHidden) {
  let cats = S.data[S.view].cats;
  if (S.settings.hideAdult && !S.settings.pin) cats = cats.filter(c => !ADULT_RE.test(c.name));
  if (S.settings.hideAdult && S.settings.pin && S.settings.lockAdult === false) cats = cats.filter(c => !ADULT_RE.test(c.name));
  if (!includeHidden && !S.showHidden) cats = cats.filter(c => !S.hiddenCats[catKey(c.id)]);
  return cats;
}
// categories whose items may appear in "All Items" / search (not hidden, not locked unless unlocked)
function openCats() { return new Set(visibleCats().filter(c => !isLocked(S.view, c.id) || S.unlocked[catKey(c.id)]).map(c => c.id)); }
function catName(id) {
  if (id === '__all') return 'All Items';
  if (id === '__fav') return 'Favorites';
  if (id === '__new') return 'Recently Added';
  if (id === '__cu') return 'Catch-up channels';
  if (S.view === 'fav' || S.view === 'recent') return { live: 'Live TV', movie: 'Movies', series: 'Series' }[id] || 'All Items';
  const c = S.data[S.view] && S.data[S.view].cats.find(x => x.id === id);
  return c ? c.name : '';
}
function renderCats() {
  const box = $('#cats');
  const f = $('#cat-filter').value.trim().toLowerCase();
  const row = (id, name, cnt, real) => {
    const locked = real && isLocked(S.view, id), hidden = real && S.hiddenCats[catKey(id)];
    const acts = real ? `<span class="cat-acts"><button data-chide="${esc(id)}" title="${hidden ? 'Show this category' : 'Hide this category'}">${hidden ? '🙈' : '👁'}</button><button data-clock="${esc(id)}" title="${locked ? 'Unlock (remove PIN lock)' : 'Lock with PIN'}">${locked ? '🔓' : '🔒'}</button></span>` : '';
    return `<div class="cat ${S.cat === id ? 'active' : ''} ${hidden ? 'is-hidden' : ''}" data-cat="${esc(id)}"><span>${locked ? '🔒 ' : ''}${esc(name)}</span>${acts}<span class="cnt">${cnt}</span></div>`;
  };
  if (S.view === 'fav' || S.view === 'recent') {
    const counts = { live: 0, movie: 0, series: 0, episode: 0 };
    const src = S.view === 'fav' ? Object.values(S.fav) : S.recent;
    src.forEach(i => counts[i.kind]++);
    box.innerHTML = row('__all', 'All Items', src.length) + row('live', 'Live TV', counts.live) + row('movie', 'Movies', counts.movie) + row('series', 'Series', counts.series + counts.episode);
    return;
  }
  const d = S.data[S.view];
  const counts = {}; d.items.forEach(i => counts[i.cat] = (counts[i.cat] || 0) + 1);
  const favCount = Object.values(S.fav).filter(x => x.kind === S.view).length;
  let html = '';
  if (!f) {
    const okC = openCats(); const allCnt = d.cats.length ? d.items.filter(i => okC.has(i.cat)).length : d.items.length;
    html += row('__all', 'All Items', allCnt) + row('__fav', '★ Favorites', favCount);
    if (S.view === 'live') { const cu = d.items.filter(i => i.archive).length; if (cu) html += row('__cu', '⏪ Catch-up channels', cu); }
    if (S.view !== 'live') html += row('__new', 'Recently Added', '');
  }
  html += visibleCats().filter(c => !f || c.name.toLowerCase().includes(f)).map(c => row(c.id, c.name, counts[c.id] || 0, true)).join('');
  const nHidden = visibleCats(true).filter(c => S.hiddenCats[catKey(c.id)]).length;
  if (nHidden) html += `<div class="cat cat-more" data-togglehidden="1"><span>${S.showHidden ? '▲ Hide hidden categories' : `▼ Show hidden categories (${nHidden})`}</span></div>`;
  box.innerHTML = html || '<div class="empty" style="padding:20px">No category.</div>';
}
$('#cats').addEventListener('click', async e => {
  const h = e.target.closest('[data-chide]');
  if (h) { e.stopPropagation(); const k = catKey(h.dataset.chide); if (S.hiddenCats[k]) delete S.hiddenCats[k]; else { S.hiddenCats[k] = 1; toast('Category hidden – "Show hidden categories" at the bottom brings it back'); } await save(pKey('hiddenCats'), S.hiddenCats); renderCats(); renderList(true); return; }
  const l = e.target.closest('[data-clock]');
  if (l) {
    e.stopPropagation(); const id = l.dataset.clock, k = catKey(id);
    if (isLocked(S.view, id)) { if (!(await askPin())) return; delete S.lockedCats[k]; S.unlocked[k] = 1; toast('🔓 Unlocked'); }
    else { if (!(await ensurePinExists())) return; S.lockedCats[k] = 1; delete S.unlocked[k]; toast('🔒 Locked with PIN'); if (S.cat === id) S.cat = '__all'; }
    await save(pKey('lockedCats'), S.lockedCats); renderCats(); renderList(true); return;
  }
  if (e.target.closest('[data-togglehidden]')) { S.showHidden = !S.showHidden; renderCats(); return; }
  const c = e.target.closest('.cat'); if (!c) return;
  const id = c.dataset.cat;
  if (!id.startsWith('__') && isLocked(S.view, id) && !S.unlocked[catKey(id)]) { if (!(await askPin())) return; S.unlocked[catKey(id)] = 1; }
  S.cat = id; S.page = 0; renderCats(); renderList();
});
$('#cat-search-btn').onclick = () => { const f = $('#cat-filter'); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.focus(); else { f.value = ''; renderCats(); } };
$('#cat-filter').addEventListener('input', renderCats);
let searchT;
$('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(() => { S.page = 0; renderList(); }, 220); });

function currentItems() {
  const q = $('#search').value.trim().toLowerCase();
  let list;
  if (S.view === 'fav' || S.view === 'recent') {
    list = S.view === 'fav' ? Object.values(S.fav) : S.recent.slice();
    if (S.cat !== '__all') list = list.filter(i => i.kind === S.cat || (S.cat === 'series' && i.kind === 'episode'));
  } else {
    const d = S.data[S.view];
    list = d.items;
    if (S.cat === '__all' || S.cat === '__new' || S.cat === '__cu' || S.cat === '__fav') {
      const ok = openCats();
      list = list.filter(i => ok.has(i.cat) || (S.user.type === 'm3u' && !S.data[S.view].cats.length));
    }
    if (S.cat === '__fav') list = list.filter(i => S.fav[favKey(i)]);
    else if (S.cat === '__cu') list = list.filter(i => i.archive);
    else if (S.cat === '__new') list = list.slice().sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 300);
    else if (S.cat !== '__all') list = list.filter(i => i.cat === S.cat);
  }
  if (q) list = list.filter(i => (i.name || '').toLowerCase().includes(q));
  return list;
}
function perPage() { return +S.settings.perPage || 25; }
function renderList(keepPage) {
  S.list = currentItems();
  const pp = perPage(), total = S.list.length, pages = Math.max(1, Math.ceil(total / pp));
  if (!keepPage && S.page >= pages) S.page = 0;
  S.page = Math.min(S.page, pages - 1);
  const start = S.page * pp, end = Math.min(start + pp, total);
  $('#crumb').textContent = `${TITLES[S.view]} / ${catName(S.cat)}`;
  $('#sec-title').textContent = catName(S.cat);
  $('#sec-count').textContent = `${total.toLocaleString()} ${S.view === 'live' ? 'channels' : 'items'}`;
  $('#page-info').textContent = total ? `${start + 1} – ${end} of ${total.toLocaleString()}` : '0 of 0';
  $('#pg-prev').disabled = S.page === 0; $('#pg-next').disabled = S.page >= pages - 1;
  $('#per-page').value = String(pp);
  const box = $('#items'); box.scrollTop = 0;
  if (!total) { box.innerHTML = '<div class="empty">Nothing here yet.</div>'; return; }
  const listMode = S.settings.viewMode === 'list';
  let html = '';
  for (let k = start; k < end; k++) html += listMode ? rowHTML(S.list[k], k) : cardHTML(S.list[k], k);
  box.innerHTML = `<div class="${listMode ? 'list' : 'grid'}">${html}</div>`;
}
$('#pg-prev').onclick = () => { if (S.page > 0) { S.page--; renderList(true); } };
$('#pg-next').onclick = () => { S.page++; renderList(true); };
$('#per-page').onchange = () => { S.settings.perPage = +$('#per-page').value; save('settings', S.settings); S.page = 0; renderList(); };

function imgTag(i, cls = '') {
  const ph = i.kind === 'live' ? '<div class="ph">▶</div>' : '<div class="noimg">🎬</div>';
  if (!i.logo) return ph;
  return `<img loading="lazy" class="${cls}" src="${esc(i.logo)}" onerror="this.outerHTML='${ph.replace(/"/g, '&quot;')}'">`;
}
function cardHTML(i, idx, noStar) {
  const fav = S.fav[favKey(i)] ? 'on' : '';
  const star = noStar ? '' : `<button class="star ${fav}" data-star="${idx}" title="Favorite">★</button>`;
  if (i.kind === 'live') {
    const playing = S.current && S.current.kind === 'live' && S.current.id === i.id ? 'playing' : '';
    return `<div class="ccard ${playing}" data-idx="${idx}" title="${esc(i.name)}"><span class="live-badge">LIVE</span>${i.archive ? '<span class="cu-chip" title="Catch-up available">⏪</span>' : ''}${star}<div class="logo-box">${imgTag(i)}</div><div class="nm">${i.num ? `<b class="cnum">${esc(i.num)}</b>` : ''}${esc(i.name)}</div></div>`;
  }
  const rate = i.rating && +i.rating > 0 ? `<span class="rate">★ ${(+i.rating).toFixed(1)}</span>` : '';
  const sub = i.kind === 'episode' && i.seriesName ? `<div class="sub">${esc(i.seriesName)}</div>` : '';
  return `<div class="poster" data-idx="${idx}" title="${esc(i.name)}">${imgTag(i)}${rate}${star}<div class="t">${esc(i.name)}</div>${sub}</div>`;
}
function rowHTML(i, idx) {
  const fav = S.fav[favKey(i)] ? 'on' : '';
  const playing = S.current && S.current.id === i.id ? 'playing' : '';
  return `<div class="prow ${playing}" data-idx="${idx}"><span class="num">${esc(i.num ?? idx + 1)}</span>${imgTag(i)}${i.kind === 'live' ? '<span class="live-badge">LIVE</span>' : ''}<span class="nm">${esc(i.name)}</span><button class="star ${fav}" data-star="${idx}">★</button></div>`;
}
$('#items').addEventListener('click', e => {
  const st = e.target.closest('[data-star]');
  if (st) { e.stopPropagation(); toggleFav(S.list[+st.dataset.star], st); return; }
  const el = e.target.closest('[data-idx]'); if (!el) return;
  const item = S.list[+el.dataset.idx];
  if (item.kind === 'live') playFull(item, S.list, +el.dataset.idx);
  else if (item.kind === 'episode') playFull(item);
  else openDetails(item);
});

// ---------------------------------------------------------------- favorites / recent
const favKey = (i) => `${i.kind}:${i.id}`;
function slim(i) { const { kind, id, name, logo, cat, ext, url, rating, num, seriesId, seriesName, epgId } = i; return { kind, id, name, logo, cat, ext, url, rating, num, seriesId, seriesName, epgId }; }
async function toggleFav(item, btn) {
  const k = favKey(item);
  if (S.fav[k]) { delete S.fav[k]; toast('Removed from favorites'); } else { S.fav[k] = slim(item); toast('Added to favorites ★'); }
  if (btn) btn.classList.toggle('on', !!S.fav[k]);
  await save(pKey('fav'), S.fav);
  if (S.view === 'fav' || S.cat === '__fav') renderList(true);
  if (S.view !== 'fav' && S.view !== 'recent' && S.view !== 'dash') renderCats();
}
async function addRecent(item) {
  if (item.kind === 'catchup') return;
  if (item.kind === 'movie' || item.kind === 'episode') {
    S.cont = [slim(item), ...S.cont.filter(r => favKey(r) !== favKey(item))].slice(0, 50);
    save(pKey('cont'), S.cont);
  }
  S.recent = [slim(item), ...S.recent.filter(r => favKey(r) !== favKey(item))].slice(0, 50);
  await save(pKey('recent'), S.recent);
}

// ---------------------------------------------------------------- EPG
async function loadEPG(item) {
  const box = $('#epg');
  if (S.user.type !== 'xtream') { box.innerHTML = '<div class="empty">EPG available with Xtream login.</div>'; return; }
  box.innerHTML = '<div class="empty">Loading guide...</div>';
  let list = [];
  try {
    const d = await getJSON(api(item.archive ? 'get_simple_data_table' : 'get_short_epg', `&stream_id=${item.id}${item.archive ? '' : '&limit=8'}`));
    list = (d && d.epg_listings) || [];
  } catch {}
  const curCh = () => S.current && (S.current.kind === 'catchup' ? S.current.channel : S.current);
  if (curCh()?.id !== item.id) return;
  // fall back to an external EPG (Settings > EPG URL) when the server has no guide
  if (!list.length) list = (await extEpgFor(item)) || [];
  if (curCh()?.id !== item.id) return;
  const now = Date.now() / 1000;
  const archFrom = item.archive ? now - (item.archiveDays || 1) * 86400 : Infinity;
  let html = '';
  if (item.archive) {
    const opts = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [180, '3 h'], [360, '6 h'], [720, '12 h'], [1440, '24 h']].filter(([m]) => m * 60 <= (item.archiveDays || 1) * 86400);
    html += `<div class="cu-box"><b>⏪ Catch-up</b><small>Watch from earlier (server keeps ${item.archiveDays || 1} day${(item.archiveDays || 1) > 1 ? 's' : ''})</small><div class="cu-btns">${opts.map(([m, l]) => `<button class="btn small" data-goback="${m}">-${l}</button>`).join('')}</div></div>`;
  }
  const items = list.filter(p => +p.stop_timestamp > now - 86400 * 7).slice(-40);
  const past = items.filter(p => +p.stop_timestamp <= now), rest = items.filter(p => +p.stop_timestamp > now);
  const row = (p, canPlay) => {
    const st = +p.start_timestamp, en = +p.stop_timestamp, isNow = st <= now && now < en;
    const day = new Date(st * 1000).toDateString() !== new Date().toDateString() ? new Date(st * 1000).toLocaleDateString([], { weekday: 'short' }) + ' ' : '';
    const act = canPlay ? `<button class="btn small" data-cu="${st}|${en}|${esc(b64(p.title)).replace(/\|/g, ' ')}">▶ Watch</button>`
      : (st > now ? `<button class="btn small ghost" data-remind="${st}|${esc(b64(p.title)).replace(/\|/g, ' ')}" title="Remind me">🔔</button><button class="btn small ghost" data-recsch="${st}|${en}|${esc(b64(p.title)).replace(/\|/g, ' ')}" title="Record">⏺</button>` : '');
    return `<div class="epg-item ${isNow ? 'now' : ''}"><small>${day}${fmtTime(new Date(st * 1000))} – ${fmtTime(new Date(en * 1000))}${isNow ? ' · NOW' : ''}</small><b>${esc(b64(p.title))}</b>${p.description ? `<p>${esc(b64(p.description).slice(0, 160))}</p>` : ''}<div class="epg-act">${act}</div></div>`;
  };
  if (past.length && item.archive) html += '<h4 class="epg-h">Earlier (catch-up)</h4>' + past.slice(-12).map(p => row(p, item.archive && (+p.has_archive === 1 || +p.start_timestamp >= archFrom))).join('');
  if (rest.length) html += '<h4 class="epg-h">Now & next</h4>' + rest.slice(0, 10).map(p => row(p, false)).join('');
  if (!items.length) html += '<div class="empty">No programme information from your server.<br><small>Tip: add an EPG link in Settings → TV Guide.</small></div>';
  box.innerHTML = html;
}
$('#epg').addEventListener('click', (e) => {
  const ch = S.current && (S.current.kind === 'catchup' ? S.current.channel : S.current);
  if (!ch) return;
  const gb = e.target.closest('[data-goback]');
  if (gb) { const now = Math.floor(Date.now() / 1000), m = +gb.dataset.goback; return playCatchup(ch, now - m * 60, now - 30, `${ch.name} (−${m >= 60 ? m / 60 + ' h' : m + ' min'})`); }
  const cu = e.target.closest('[data-cu]');
  if (cu) { const [st, en, t] = cu.dataset.cu.split('|'); return playCatchup(ch, +st, +en, `${ch.name} – ${t}`); }
  const rm = e.target.closest('[data-remind]');
  if (rm) { const [st, t] = rm.dataset.remind.split('|'); return addReminder(ch, +st, t); }
  const rs = e.target.closest('[data-recsch]');
  if (rs) { const [st, en, t] = rs.dataset.recsch.split('|'); return scheduleRecording(ch, +st, +en, t); }
});
async function extEpgFor(item) {
  const now = Date.now() / 1000;
  const r = await window.native.epgFor([{ key: 'x', epgId: item.epgId, name: item.name }], now - 86400 * 3, now + 86400 * 2);
  return r.x || null;
}

function playCatchup(ch, start, end, title) {
  const item = { kind: 'catchup', id: 'cu' + ch.id + '_' + start, chId: ch.id, channel: ch, name: title, start, dur: Math.max(60, end - start), logo: ch.logo, catName: '⏪ Catch-up', archive: 0 };
  playFull(item);
}

// ---------------------------------------------------------------- player engine
const engines = { mini: null, full: null };
const PLOG = [];
const qHeight = () => ({ '1080p': 1080, '720p': 720, '480p': 480 }[S.settings.quality] || (S.autoLow ? 480 : 720));
function plog(m) { PLOG.push(new Date().toISOString().slice(11, 23) + ' ' + m); if (PLOG.length > 300) PLOG.shift(); }
function destroyEngine(slot) {
  const e = engines[slot]; if (!e) return;
  engines[slot] = null;
  clearTimeout(e.wd); clearTimeout(e.wd2); clearInterval(e.gateT); clearInterval(e.speedT);
  detachPlayer(e);
  try { e.video.pause(); e.video.removeAttribute('src'); e.video.load(); } catch {}
  e.video.remove();
  engines[slot] = null;
}
function stopAll() { destroyEngine('mini'); destroyEngine('full'); $('#player').classList.add('hidden'); window.native.exitFullscreen(); }
function detachPlayer(eng) {
  try { eng.hls && eng.hls.destroy(); } catch {}
  try { if (eng.ts) { eng.ts.pause(); eng.ts.unload(); eng.ts.detachMediaElement(); eng.ts.destroy(); } } catch {}
  eng.hls = eng.ts = null;
}
// Plays an item. Stage 0 = direct; on decode error -> stage 1 (FFmpeg: fix audio) -> stage 2 (FFmpeg: full convert)
function startEngine(slot, host, item, onFail, onStatus, onBuffer) {
  destroyEngine(slot);
  const video = document.createElement('video');
  video.autoplay = true; video.controls = slot !== 'full'; video.playsInline = true;
  host.appendChild(video);
  const eng = { video, url: streamUrl(item), urls: streamUrls(item), urlIdx: 0, uaList: [...new Set([S.user.streamUA, ...STREAM_UAS, S.user.ua].filter(Boolean))], uaIdx: 0, stage: 0, offset: 0, failing: false };
  const curUA = () => eng.uaList[eng.uaIdx];
  // audio / subtitle track choice (kept per playback). Subtitles need exact timing -> full convert
  eng.opts = { a: item._aTrack || 0, s: item._sTrack ?? -1, live: item.kind === 'live', nopipe: !!(S.noPipe && S.noPipe[item.id]) };
  const modeFor = () => eng.stage >= 2 ? 'full' : 'audio';
  const conv = (t) => {
    eng.subCues = new Set();
    if (item.kind === 'catchup') { const m = Math.floor(t / 60) * 60; return window.native.convert(catchupUrl(item, m), modeFor(), t - m, curUA(), qHeight(), eng.opts); }
    return window.native.convert(eng.urls[eng.urlIdx], modeFor(), t, curUA(), qHeight(), eng.opts);
  };
  // restart the converter at the current position (after changing audio/subtitle track)
  eng.restart = async () => {
    const t = isLive ? 0 : eng.pos();
    if (eng.stage === 0) { eng.failing = false; return fail('track change', true, 1); }
    detachPlayer(eng);
    eng.offset = t; eng.base = null; eng.gating = true; eng.need = 1.5; eng.sameRetry = 0;
    if (slot === 'full' && ctl && ctl.eng === eng) clearCues();
    await new Promise(r => setTimeout(r, 1500)); // 1-connection accounts: let the old one close
    if (engines[slot] !== eng) return;
    eng.local = await conv(t);
    if (engines[slot] !== eng) return;
    attach(eng.local, true);
  };
  // position in the movie: converter streams start at "base" (where the audio really begins = the seek point)
  eng.pos = () => eng.base === null && eng.local ? eng.offset : eng.offset + Math.max(0, (video.currentTime || 0) - (eng.base || 0));
  engines[slot] = eng;
  const isLive = item.kind === 'live';

  const attach = (url, forceTs) => {
    detachPlayer(eng);
    eng.failing = false;
    if (!forceTs) eng.directOpened = true;
    eng.base = (forceTs && !isLive) ? null : 0;
    plog(`attach stage=${eng.stage} ua#${eng.uaIdx}=${curUA()} url#${eng.urlIdx} ${forceTs ? 'converter' : 'direct'}`);
    const p = url.split('?')[0].toLowerCase();
    if (!forceTs && p.endsWith('.m3u8') && window.Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
      eng.hls = hls; hls.loadSource(url); hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fail('HLS: ' + d.details, /media|codec|buffer/i.test(d.details)); });
    } else if ((forceTs || p.endsWith('.ts') || (isLive && !/\.(mp4|mkv|avi|m3u8)$/.test(p))) && window.mpegts && mpegts.isSupported()) {
      const pl = mpegts.createPlayer({ type: 'mpegts', isLive: isLive || forceTs, url },
        { enableWorker: true, liveBufferLatencyChasing: false, lazyLoad: false, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 360, autoCleanupMinBackwardDuration: 300,
          enableStashBuffer: true, stashInitialSize: 128 * 1024, fixAudioTimestampGap: true });
      eng.ts = pl; pl.attachMediaElement(video); pl.load();
      Promise.resolve(pl.play()).catch(() => {});
      pl.on(mpegts.Events.ERROR, (t, d) => fail('Stream error: ' + (d || t), t === mpegts.ErrorTypes.MEDIA_ERROR));
      // Check codecs up-front: unsupported audio (AC3/EAC3/MP2) -> fix audio; unsupported video (HEVC) -> full convert
      pl.on(mpegts.Events.MEDIA_INFO, (mi) => plog(`mediainfo v=${mi && mi.videoCodec} a=${mi && mi.audioCodec} ${mi && mi.width}x${mi && mi.height}`));
      if (forceTs && eng.stage === 1 && isLive) {
        // ask the converter whether the source is interlaced (1080i TV) - the built-in player can't show that
        const chk = async (n) => {
          if (engines[slot] !== eng || eng.stage !== 1 || !eng.local) return;
          const l = await window.native.convertLog(eng.local);
          if (l && l.vinfo) { if (l.interlaced) { plog('interlaced source -> full convert'); fail('Interlaced video', true, 2); } return; }
          if (n < 16) setTimeout(() => chk(n + 1), 250);
        };
        setTimeout(() => chk(0), 300);
      }
      pl.on(mpegts.Events.MEDIA_INFO, (mi) => {
        if (eng.stage > 1 || !mi) return;
        const ok = (c) => { try { return MediaSource.isTypeSupported(c); } catch { return false; } };
        const vOk = !mi.hasVideo || !mi.videoCodec || ok(`video/mp4; codecs="${mi.videoCodec}"`);
        const aOk = !mi.hasAudio || !mi.audioCodec || ok(`audio/mp4; codecs="${mi.audioCodec}"`);
        if (!vOk) fail('Video format ' + mi.videoCodec, true, 2);
        else if (!aOk && eng.stage === 0) fail('Audio format ' + mi.audioCodec, true, 1);
      });
    } else {
      video.removeAttribute('src'); video.src = url; video.play().catch(() => {});
    }
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fail = async (why, isDecode = true, toStage = 0) => {
    if (engines[slot] !== eng || eng.failing) return;
    eng.failing = true;
    console.warn('[player] stage', eng.stage, 'failed:', why);
    plog(`FAIL stage=${eng.stage} decode=${isDecode} to=${toStage} why=${why} t=${video.currentTime.toFixed(1)} ready=${video.readyState} err=${video.error ? video.error.code + ' ' + video.error.message : '-'}`);
    // Server cut the direct connection -> remember, next channels go straight to the converter (saves a connection)
    if (eng.stage === 0 && !isDecode && S.user) { S.directBlocked = true; save(uKey('directBlocked'), true); }
    if (toStage) eng.stage = toStage - 1;

    // Converter already running and the server refused
    if (eng.stage >= 1 && eng.local) {
      await sleep(300);
      const err = await window.native.convertError(eng.local);
      if (engines[slot] !== eng) return;
      const refused = /\b(401|403|406|429|509)\b|Unauthorized|Forbidden|Not Acceptable|Too Many/i.test(err);
      const notFound = /\b404\b|Not Found/i.test(err);
      const dm = String(err).match(/(\d+) DC, \d+ AC, \d+ MV errors/);
      if (eng.stage >= 2 && ((dm && +dm[1] > 2000) || /Not yet implemented in FFmpeg/i.test(err))) return finalFail(why, err); // broken source: retrying won't help
      if (refused || notFound) {
        detachPlayer(eng);
        if (refused && curUA() === S.user.streamUA && (eng.sameRetry || 0) < 4) {
          // this identity worked before -> 401 is probably the previous channel's connection still closing
          eng.sameRetry = (eng.sameRetry || 0) + 1;
          onStatus && onStatus('Switching channel…');
          await sleep([700, 1000, 1500, 2500][eng.sameRetry - 1]);
        } else if (refused && eng.uaIdx < eng.uaList.length - 1) {
          // server refused this player identity -> try the next one (VLC first)
          eng.uaIdx++;
          onStatus && onStatus(`Trying player identity ${eng.uaIdx + 1}/${eng.uaList.length}…`);
          await sleep(1800);
        } else if (refused && (eng.busyTries || 0) < 2) {
          // all identities refused: maybe connection limit -> wait and go round again with the best ones
          eng.busyTries = (eng.busyTries || 0) + 1; eng.uaIdx = 0;
          onStatus && onStatus(`Server busy (connection limit) – retrying ${eng.busyTries}/2…`);
          await sleep(5000);
        } else if (eng.urlIdx < eng.urls.length - 1) {
          eng.urlIdx++; eng.busyTries = 0; eng.uaIdx = 0;
          onStatus && onStatus(`Trying another stream address (${eng.urlIdx + 1}/${eng.urls.length})…`);
          await sleep(1500);
        } else return finalFail(why, err);
        if (engines[slot] !== eng) return;
        eng.local = await conv(isLive ? 0 : eng.pos());
        if (engines[slot] !== eng) return;
        attach(eng.local, true);
        return;
      }
    }
    // live channel through our fast connection failed: try once more the classic way (FFmpeg opens the stream itself)
    if (isLive && eng.stage >= 2 && eng.local && !eng.opts.nopipe) {
      eng.opts.nopipe = true; S.noPipe = S.noPipe || {}; S.noPipe[item.id] = true;
      plog('retry without pipe');
      onStatus && onStatus('Retrying channel…');
      detachPlayer(eng); await sleep(600);
      if (engines[slot] !== eng) return;
      eng.failing = false;
      eng.local = await conv(0); eng.offset = 0;
      if (engines[slot] !== eng) return;
      attach(eng.local, true);
      return;
    }
    // ANY other problem (network block, codec, unsupported format) -> next converter stage
    if (eng.stage < 2) {
      const resumeAt = isLive ? 0 : Math.max(eng.pos(), eng.offset ? 0 : (item._startAt || 0));
      const fromDirect = eng.stage === 0;
      eng.stage++;
      onStatus && onStatus(eng.stage === 1 ? 'Loading channel…' : 'Optimizing video…');
      detachPlayer(eng);
      if (fromDirect && eng.directOpened) await sleep(2500); // let the server release the first (direct) connection
      if (engines[slot] !== eng) return;
      const local = await conv(resumeAt);
      if (engines[slot] !== eng) return;
      eng.offset = resumeAt; eng.local = local;
      attach(local, true);
      return;
    }
    finalFail(why, eng.local ? await window.native.convertError(eng.local) : '');
  };
  const finalFail = async (why, detail) => {
    onStatus && onStatus('Checking stream…');
    if (!detail) detail = await window.native.probe(eng.urls[eng.urlIdx], curUA());
    detail = String(detail || '').split('\n').filter(l => !/errors in [BPI] frame|Error while decoding stream|concealing \d+|Invalid data found when processing input|corrupt (decoded )?frame|PES packet size mismatch|Packet corrupt|non-existing PPS|decode_slice_header|no frame!|missing picture/i.test(l)).join('\n').replace(/https?:\/\/\S+/g, '[stream]').replace(/\[[\w#]+ @ 0x[0-9a-f]+\]\s*/gi, '');
    if (engines[slot] !== eng) return;
    onStatus && onStatus(null);
    let hint = '';
    const raw = eng.local ? String(await window.native.convertError(eng.local) || '') : '';
    const dmg = raw.match(/(\d+) DC, \d+ AC, \d+ MV errors/);
    if ((dmg && +dmg[1] > 2000) || /Not yet implemented in FFmpeg/i.test(raw)) {
      onFail && onFail('📡 This channel\'s signal is damaged at the server right now (the picture data arrives broken – VLC shows the same).\n\nTry again later, or pick another channel / the HD or SD version of it.');
      return;
    }
    if (/401|Unauthorized/i.test(detail)) hint = '\n\nServer refused this login for streaming. Usually: account already in use on another device/app (connection limit), or account expired. Close IPTV Smarters / other devices using this account and try again.';
    else if (/406|403/i.test(detail)) hint = '\n\nServer blocked this player. Try Settings > User-Agent > IPTVSmartersPro.';
    onFail && onFail(why + (detail ? '\n\nDetails: ' + detail.trim().slice(0, 300) : '') + hint);
  };

  // ---- Smooth playback: wait for a small buffer before playing, re-buffer on stalls, jump over gaps ----
  const ahead = () => {
    const b = video.buffered, t = video.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.25 && b.end(i) > t) return b.end(i) - t;
    return 0;
  };
  const nextStart = () => {
    const b = video.buffered, t = video.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) > t) return b.start(i);
    return -1;
  };
  eng.gating = true; eng.need = isLive ? 0.6 : 1.0; eng.stalls = 0;
  video.addEventListener('waiting', () => {
    if (eng.stage === 0 && !isLive) return; // normal files: browser handles it
    if (video.currentTime > 0.5) { eng.stalls++; eng.need = Math.min(6, 2.5 + eng.stalls * 0.5); }
    eng.gating = true;
  });
  const fixBase = () => {
    if (eng.base !== null || !video.buffered.length) return;
    eng.base = video.buffered.start(0);
    if (video.currentTime < eng.base) video.currentTime = eng.base + 0.02;
    plog('base ' + eng.base.toFixed(2));
  };
  ['progress', 'loadedmetadata', 'canplay'].forEach(ev => video.addEventListener(ev, fixBase));
  eng.gateT = setInterval(() => {
    if (engines[slot] !== eng) return clearInterval(eng.gateT);
    fixBase();
    if (video.readyState < 1) return;
    // jump small gaps in the stream (a common cause of endless "buffering")
    if (ahead() < 0.1) { const ns = nextStart(); if (ns > 0 && ns - video.currentTime < 3) { video.currentTime = ns + 0.05; plog('gap jump ' + (ns - video.currentTime).toFixed(2)); } }
    if (!eng.gating) return;
    if (eng.userPaused) { eng.gating = false; return; }
    if (!video.paused) { video.pause(); eng.autoPaused = true; onBuffer && onBuffer(true); }
    if (ahead() >= eng.need) {
      eng.gating = false; eng.autoPaused = false; onBuffer && onBuffer(false);
      video.play().catch(() => {});
      plog(`buffer ok ahead=${ahead().toFixed(1)} need=${eng.need}`);
    }
  }, 250);
  // seek (movies/episodes) - through the converter we restart FFmpeg at the new time
  eng.seekTo = async (t) => {
    if (isLive) return;
    t = Math.max(0, t);
    if (eng.stage === 0 && isFinite(video.duration) && video.duration > 0) { video.currentTime = Math.min(t, video.duration - 1); return; }
    if (eng.stage === 0) return;
    // already downloaded (grey part of the seek bar)? just jump there - no new connection, instant
    if (eng.base !== null && video.buffered.length) {
      const vt = t - eng.offset + eng.base, b = video.buffered;
      for (let i = 0; i < b.length; i++) if (vt >= b.start(i) && vt < b.end(i) - 1) { video.currentTime = vt; plog('seek inside buffer ' + t.toFixed(1)); return; }
    }
    detachPlayer(eng);
    eng.offset = t; eng.base = null; eng.gating = true; eng.need = 2; eng.sameRetry = 0; eng.busyTries = 0;
    if (slot === 'full' && ctl && ctl.eng === eng) clearCues();
    $('#pbuffer') && slot === 'full' && $('#pbuffer').classList.remove('hidden');
    // the server allows 1 connection: give it a moment to close the old one
    const my = (eng.seekSeq = (eng.seekSeq || 0) + 1);
    await new Promise(r => setTimeout(r, 2200));
    if (engines[slot] !== eng || my !== eng.seekSeq) return;
    eng.local = await conv(t);
    if (engines[slot] !== eng) return;
    attach(eng.local, true);
  };

  // If a stream never starts (e.g. unsupported video but no error), move to the next stage
  const watchdog = () => {
    clearTimeout(eng.wd);
    eng.wd = setTimeout(() => { if (engines[slot] === eng && video.readyState < 2) fail('No picture after 15s (ready=' + video.readyState + ')', true); }, 15000);
  };
  video.addEventListener('loadstart', watchdog);
  video.addEventListener('loadedmetadata', () => {
    clearTimeout(eng.wd2);
    if (eng.stage >= 2) return;
    eng.wd2 = setTimeout(() => { if (engines[slot] === eng && video.readyState < 3) fail('Video format not playable directly (interlaced?)', true, 2); }, 5000);
  });
  ['loadedmetadata', 'canplay', 'waiting', 'stalled', 'ended', 'pause'].forEach(ev => video.addEventListener(ev, () => plog(`video ${ev} t=${video.currentTime.toFixed(1)} ready=${video.readyState}`)));
  video.addEventListener('playing', () => {
    plog(`video playing t=${video.currentTime.toFixed(1)}`);
    clearTimeout(eng.wd); clearTimeout(eng.wd2); onStatus && onStatus(null);
    if (isLive && S.user && eng.stage >= 1) {
      S.chanStage = S.chanStage || {};
      if (S.chanStage[item.id] !== eng.stage) { S.chanStage[item.id] = eng.stage; save(uKey('chanStage'), S.chanStage); }
      S.recentStages = [...(S.recentStages || []), eng.stage].slice(-3);
    }
    if (eng.stage >= 1 && S.user && S.user.streamUA !== curUA()) {
      S.user.streamUA = curUA();
      const i = S.users.findIndex(u => u.id === S.user.id); if (i >= 0) { S.users[i].streamUA = curUA(); save('users', S.users); }
    }
  });
  video.addEventListener('error', () => fail('This format is not supported by the built-in player.', true));
  if (S.settings.convert === 'always' || S.directBlocked || item.kind === 'catchup') {
    // Start at the stage this channel needed last time; if recent channels all needed full convert, start there
    const known = isLive && S.chanStage && S.chanStage[item.id];
    const recent = S.recentStages || [];
    const start = known || (isLive && recent.length >= 2 && recent.every(x => x === 2) ? 2 : 1);
    eng.failing = false; eng.stage = 0; fail('converter', true, start);
  }
  else attach(eng.url, false);
  return eng;
}

// full player
function playFull(item, list = null, idx = null) {
  S.current = item;
  if (list) { S.playingList = list; S.playingIndex = idx ?? list.indexOf(item); }
  else { S.playingList = [item]; S.playingIndex = 0; }
  if (S.settings.autoVLC) { openVLC(item); addRecent(item); return; }
  destroyEngine('mini');
  $('#player').classList.remove('hidden');
  $('#player-title').textContent = (item.kind === 'live' && item.num ? item.num + '  ·  ' : '') + item.name;
  $('#player-sub').textContent = item.seriesName || (item.kind === 'live' ? (item.catName || 'Live TV') : '');
  $('#pbuffer').classList.remove('hidden');
  $('#player-msg').classList.add('hidden');
  const eng = startEngine('full', $('#player-host'), item, (why) => {
    const m = $('#player-msg');
    m.innerHTML = `<div style="white-space:pre-wrap;user-select:text;text-align:left">⚠️ ${esc(why)}</div><br><button class="btn primary" id="msg-vlc">Play in VLC</button>`;
    m.classList.remove('hidden');
    $('#msg-vlc').onclick = () => openVLC(item);
  }, (status) => {
    const m = $('#player-msg');
    if (status) { m.textContent = '⏳ ' + status; m.classList.remove('hidden'); } else m.classList.add('hidden');
  }, (buffering) => $('#pbuffer').classList.toggle('hidden', !buffering));
  bindControls(eng, item);
  // watch converter speed: if this PC can't keep up (speed < 1x), drop to 480p automatically (quality = auto)
  let slow = 0;
  eng.speedT = setInterval(async () => {
    if (engines.full !== eng) return clearInterval(eng.speedT);
    if (!eng.local || eng.stage < 2) return;
    const l = await window.native.convertLog(eng.local);
    const sp = l && l.prog && parseFloat(l.prog.speed);
    if (!sp) return;
    plog('converter speed ' + sp + 'x');
    if (sp < 0.95 && eng.video.currentTime > 4) slow++; else slow = 0;
    if (slow >= 3 && (S.settings.quality || 'auto') === 'auto' && !S.autoLow) {
      S.autoLow = true; clearInterval(eng.speedT);
      toast('PC is slow for HD conversion – switching to 480p for smooth playback');
      playFull(item, S.playingList, S.playingIndex);
    }
  }, 3000);
  // resume for movies / episodes
  const pk = favKey(item);
  if (item.kind !== 'live' && item.kind !== 'catchup') {
    const at = S.pos[pk];
    item._startAt = at > 30 ? at : 0;
    if (at > 30) eng.video.addEventListener('loadedmetadata', () => { if (eng.stage === 0 && isFinite(eng.video.duration) && at < eng.video.duration - 30) { eng.video.currentTime = at; toast('Resumed from ' + Math.floor(at / 60) + ' min'); } }, { once: true });
    let lastSave = 0;
    eng.video.addEventListener('timeupdate', () => {
      const t = eng.pos();
      if (Math.abs(t - lastSave) > 15) {
        lastSave = t; S.pos[pk] = t; save(pKey('pos'), S.pos);
        const d = ctlDuration(); if (d && S.durs[pk] !== Math.round(d)) { S.durs[pk] = Math.round(d); save(pKey('durs'), S.durs); }
      }
    });
  }
  addRecent(item);
  // TV guide drawer for live channels
  $('#player-guide').classList.toggle('hidden', item.kind !== 'live' && item.kind !== 'catchup');
  $('#player-rec').classList.toggle('hidden', item.kind !== 'live');
  $('#player-rec').classList.remove('on'); $('#player-rec').textContent = '⏺ Rec';
  if (!$('#linkpanel').classList.contains('hidden')) showLinkPanel(item);
  if (item.kind === 'live') loadEPG(item); else if (item.kind === 'catchup') loadEPG(item.channel); else $('#guide').classList.add('hidden');
  $$('.ccard.playing,.prow.playing').forEach(x => x.classList.remove('playing'));
  nudgeIdle();
}
$('#player-guide').onclick = () => { $('#linkpanel').classList.add('hidden'); $('#guide').classList.toggle('hidden'); };
$('#player-link').onclick = () => { $('#guide').classList.add('hidden'); if (S.current) showLinkPanel(S.current); $('#linkpanel').classList.toggle('hidden'); };

// ---------------------------------------------------------------- external TV guide + guide grid + reminders
const epgUrlFor = () => (S.settings.epgUrls || {})[S.user.id] || '';
async function autoLoadEpg(force) {
  if (!S.user || S.user.type !== 'xtream' && !epgUrlFor()) return;
  const st = await window.native.epgStatus();
  const url = epgUrlFor() || `${S.user.url}/xmltv.php?username=${encodeURIComponent(S.user.username)}&password=${encodeURIComponent(S.user.password)}`;
  if (!force && st.url === url && Date.now() - st.loaded < 12 * 3600e3) return st;
  const r = await window.native.epgLoad(url);
  S.epgInfo = r; updateEpgStatus();
  return r;
}
function updateEpgStatus() {
  const r = S.epgInfo; const el = $('#set-epg-status'); if (!el) return;
  el.textContent = !r ? 'Not loaded yet' : r.ok ? `Loaded: ${r.channels} channels, ${r.progs.toLocaleString()} programmes` + (r.progs ? '' : ' – this source has no programmes') : '⚠️ ' + r.error;
}
const GUIDE = { start: 0, hours: 3, cat: '__all', page: 0 };
async function openGuide() {
  stopAll(); show('#screen-main');
  S.view = 'guide'; setNav('guide');
  $('#side').classList.add('hidden'); $('#browse').classList.add('hidden'); $('#dash').classList.add('hidden'); $('#recview').classList.add('hidden'); $('#guideview').classList.remove('hidden');
  $('#crumb').textContent = 'TV Guide';
  if (!S.data.live) { loader(true, 'Loading channels…'); try { await ensureData('live'); } catch {} loader(false); }
  if (!GUIDE.start) { const n = Date.now() / 1000; GUIDE.start = Math.floor(n / 1800) * 1800 - 1800; }
  renderGuide();
}
async function renderGuide() {
  const d = S.data.live; if (!d) return;
  const prevView = S.view; S.view = 'live'; const ok = openCats(); const cats = visibleCats().filter(c => !isLocked('live', c.id) || S.unlocked[catKey(c.id)]); S.view = prevView;
  $('#g-cat').innerHTML = `<option value="__fav">★ Favorites</option><option value="__all">All channels</option>` + cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('#g-cat').value = GUIDE.cat;
  let list = GUIDE.cat === '__fav' ? d.items.filter(i => S.fav[favKey(i)]) : GUIDE.cat === '__all' ? d.items.filter(i => ok.has(i.cat)) : d.items.filter(i => i.cat === GUIDE.cat);
  const per = 25, pages = Math.max(1, Math.ceil(list.length / per)); GUIDE.page = Math.min(GUIDE.page, pages - 1);
  list = list.slice(GUIDE.page * per, GUIDE.page * per + per);
  GUIDE.list = list;
  $('#g-page').textContent = `${GUIDE.page + 1} / ${pages}`;
  const t0 = GUIDE.start, t1 = t0 + GUIDE.hours * 3600, span = t1 - t0, now = Date.now() / 1000;
  $('#g-day').textContent = new Date(t0 * 1000).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  let head = '';
  for (let t = t0; t < t1; t += 1800) head += `<div class="g-slot" style="left:${(t - t0) / span * 100}%">${fmtTime(new Date(t * 1000))}</div>`;
  $('#g-head').innerHTML = head + (now > t0 && now < t1 ? `<div class="g-now" style="left:${(now - t0) / span * 100}%"></div>` : '');
  const data = await window.native.epgFor(list.map((c, i) => ({ key: String(i), epgId: c.epgId, name: c.name })), t0, t1);
  const anyData = Object.keys(data).length > 0;
  $('#g-rows').innerHTML = list.map((c, i) => {
    const progs = data[String(i)] || [];
    const blocks = progs.map((p, k) => {
      const a = Math.max(t0, p.start_timestamp), b = Math.min(t1, p.stop_timestamp);
      const cls = p.stop_timestamp <= now ? 'past' : p.start_timestamp <= now ? 'live' : '';
      return `<div class="g-prog ${cls}" style="left:${(a - t0) / span * 100}%;width:${(b - a) / span * 100}%" data-g="${i}|${k}" title="${esc(b64(p.title))}"><b>${esc(b64(p.title))}</b><small>${fmtTime(new Date(p.start_timestamp * 1000))}</small></div>`;
    }).join('') || '<div class="g-none">No guide data</div>';
    return `<div class="g-row"><div class="g-ch" data-gch="${i}">${c.logo ? `<img src="${esc(c.logo)}" onerror="this.remove()">` : ''}<span>${esc(c.name)}</span>${c.archive ? '<em>⏪</em>' : ''}</div><div class="g-line">${blocks}${now > t0 && now < t1 ? `<div class="g-now" style="left:${(now - t0) / span * 100}%"></div>` : ''}</div></div>`;
  }).join('') || '<div class="empty">No channels here.</div>';
  GUIDE.data = data;
  $('#g-hint').classList.toggle('hidden', anyData);
}
$('#g-cat').onchange = () => { GUIDE.cat = $('#g-cat').value; GUIDE.page = 0; renderGuide(); };
$('#g-prev').onclick = () => { GUIDE.start -= 3600; renderGuide(); };
$('#g-next').onclick = () => { GUIDE.start += 3600; renderGuide(); };
$('#g-now').onclick = () => { const n = Date.now() / 1000; GUIDE.start = Math.floor(n / 1800) * 1800 - 1800; renderGuide(); };
$('#g-pprev').onclick = () => { if (GUIDE.page > 0) { GUIDE.page--; renderGuide(); } };
$('#g-pnext').onclick = () => { GUIDE.page++; renderGuide(); };
$('#g-rows').addEventListener('click', (e) => {
  const chEl = e.target.closest('[data-gch]');
  if (chEl) { const c = GUIDE.list[+chEl.dataset.gch]; return playFull(c, GUIDE.list, +chEl.dataset.gch); }
  const g = e.target.closest('[data-g]'); if (!g) return;
  const [i, k] = g.dataset.g.split('|').map(Number); const c = GUIDE.list[i], p = GUIDE.data[String(i)][k], now = Date.now() / 1000, title = b64(p.title);
  if (p.start_timestamp <= now && now < p.stop_timestamp) return playFull(c, GUIDE.list, i);
  if (p.stop_timestamp <= now) { if (c.archive) return playCatchup(c, p.start_timestamp, p.stop_timestamp, `${c.name} – ${title}`); return toast('This channel has no catch-up on your server'); }
  // future programme: remind or record
  const pop = $('#g-pop'); pop.innerHTML = `<b>${esc(title)}</b><small>${esc(c.name)} · ${fmtTime(new Date(p.start_timestamp * 1000))} – ${fmtTime(new Date(p.stop_timestamp * 1000))}</small><div class="row-btns"><button class="btn small" id="gp-rem">🔔 Remind me</button><button class="btn small" id="gp-rec">⏺ Record</button></div>`;
  const r = g.getBoundingClientRect(); pop.style.left = Math.min(window.innerWidth - 320, r.left) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; pop.classList.remove('hidden');
  $('#gp-rem').onclick = () => { pop.classList.add('hidden'); addReminder(c, p.start_timestamp, title); };
  $('#gp-rec').onclick = () => { pop.classList.add('hidden'); scheduleRecording(c, p.start_timestamp, p.stop_timestamp, title); };
});
document.addEventListener('click', (e) => { if (!e.target.closest('#g-pop') && !e.target.closest('[data-g]')) $('#g-pop').classList.add('hidden'); });

// reminders
async function addReminder(ch, st, title) {
  const list = (await window.native.storeGet('reminders')) || [];
  if (list.find(r => r.chId === ch.id && r.st === st)) return toast('Reminder already set');
  list.push({ chId: ch.id, chName: ch.name, st, title, user: S.user.id });
  await save('reminders', list);
  toast(`🔔 I will remind you at ${fmtTime(new Date((st - 60) * 1000))}: ${title}`);
}
setInterval(async () => {
  if (!S.user) return;
  const list = (await window.native.storeGet('reminders')) || [];
  const now = Date.now() / 1000; let changed = false;
  for (const r of list) {
    if (r.done || r.user !== S.user.id) continue;
    if (r.st - now <= 60) {
      r.done = true; changed = true;
      if (r.st + 1800 < now) continue; // missed long ago
      const bar = $('#remindbar'); $('#rb-text').textContent = `🔔 ${r.title} – ${r.chName} ${r.st > now ? 'starts at ' + fmtTime(new Date(r.st * 1000)) : 'has started'}`;
      bar.classList.remove('hidden'); bar.dataset.ch = r.chId;
      try { new Notification('Alnur IPTV – reminder', { body: `${r.title} on ${r.chName}` }); } catch {}
    }
  }
  if (changed) save('reminders', list.filter(r => !r.done || r.st > now - 86400));
}, 15000);
$('#rb-watch').onclick = async () => {
  const bar = $('#remindbar'); bar.classList.add('hidden');
  const d = await ensureData('live'); const c = d.items.find(x => String(x.id) === String(bar.dataset.ch)); if (c) playFull(c);
};
$('#rb-close').onclick = () => $('#remindbar').classList.add('hidden');

// ---------------------------------------------------------------- find subtitles online
function guessTitle(item) {
  let raw = item.kind === 'episode' && item.seriesName ? item.seriesName : item.name;
  let year = ''; const ym = raw.match(/\b(19[3-9]\d|20[0-4]\d)\b/); if (ym) year = ym[1];
  let t = raw.replace(/^[A-Z]{2,4}\s*[:|]\s*/, '').replace(/\[[^\]]*\]/g, '').replace(/\((?:19|20)\d\d\)/g, '')
    .replace(/\((hindi|english|tamil|telugu|gujarati|punjabi|marathi|bengali|malayalam|kannada|dubbed|multi[^)]*|org[^)]*)\)/gi, '')
    .replace(/\b(4k|uhd|fhd|hd|1080p|720p|hevc|x264|x265|web[- ]?dl|webrip|bluray)\b/gi, '').replace(/[|:,.-]+\s*$/, '').replace(/\s+/g, ' ').trim();
  let season = '', episode = '';
  const se = (item.name || '').match(/S(\d{1,2})\s*[ ·.]?\s*E(\d{1,3})/i); if (item.kind === 'episode' && se) { season = String(+se[1]); episode = String(+se[2]); }
  return { title: t, year, season, episode };
}
const SUB_LANGS = [['en', 'English'], ['hi', 'Hindi'], ['gu', 'Gujarati'], ['ar', 'Arabic'], ['pt', 'Portuguese'], ['es', 'Spanish'], ['fr', 'French'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ur', 'Urdu'], ['bn', 'Bengali'], ['ml', 'Malayalam']];
function openSubSearch() {
  if (!ctl) return;
  const g = guessTitle(ctl.item);
  $('#ss-title').value = g.title; $('#ss-year').value = g.year; $('#ss-season').value = g.season; $('#ss-episode').value = g.episode;
  const sel = (S.settings.subLangs || 'en,hi').split(',');
  $('#ss-langs').innerHTML = SUB_LANGS.map(([c, n]) => `<label class="chip"><input type="checkbox" value="${c}" ${sel.includes(c) ? 'checked' : ''}> ${n}</label>`).join('');
  $('#ss-results').innerHTML = '';
  const noKeys = !S.settings.osKey && !S.settings.subdlKey;
  $('#ss-keys').classList.toggle('hidden', !noKeys);
  $('#subsearch').classList.remove('hidden');
  if (!noKeys) doSubSearch();
}
async function doSubSearch() {
  const langs = [...document.querySelectorAll('#ss-langs input:checked')].map(i => i.value).join(',') || 'en';
  S.settings.subLangs = langs; save('settings', S.settings);
  if (!S.settings.osKey && !S.settings.subdlKey) { $('#ss-keys').classList.remove('hidden'); return; }
  $('#ss-results').innerHTML = '<div class="empty">Searching…</div>';
  const r = await window.native.subsSearch({ query: $('#ss-title').value.trim(), year: $('#ss-year').value.trim(), season: $('#ss-season').value.trim(), episode: $('#ss-episode').value.trim(), langs, osKey: S.settings.osKey || '', subdlKey: S.settings.subdlKey || '' });
  S.subResults = r.results;
  const errs = r.errors.length ? `<div class="ss-err">${r.errors.map(esc).join('<br>')}</div>` : '';
  $('#ss-results').innerHTML = errs + (r.results.length ? r.results.slice(0, 60).map((x, i) => `<div class="ss-row" data-ssi="${i}"><span class="ss-lang">${esc((x.lang || '?').toUpperCase())}</span><div class="ss-main"><b>${esc(x.name)}</b><small>${esc(x.provider)}${x.downloads ? ' · ' + x.downloads.toLocaleString() + ' downloads' : ''}${x.hi ? ' · hearing impaired' : ''}</small></div><button class="btn small">⬇ Use</button></div>`).join('') : '<div class="empty">No subtitles found. Try a shorter title, another language, or remove the year.</div>');
}
$('#ss-go').onclick = doSubSearch;
$('#ss-title').onkeydown = (e) => { if (e.key === 'Enter') doSubSearch(); };
$('#ss-close').onclick = () => $('#subsearch').classList.add('hidden');
$('#ss-settings').onclick = () => { $('#subsearch').classList.add('hidden'); openSettings(); setTimeout(() => $('#set-oskey').focus(), 100); };
$('#ss-results').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-ssi]'); if (!row) return;
  const it = S.subResults[+row.dataset.ssi];
  row.querySelector('button').textContent = '…';
  const r = await window.native.subsDownload(it, { osKey: S.settings.osKey || '' });
  if (!r.ok) { row.querySelector('button').textContent = '⬇ Use'; return toast('⚠️ ' + r.error); }
  if (applyExtSubs(r.text, it.provider)) $('#subsearch').classList.add('hidden');
});
$$('[data-ext]').forEach(a => a.onclick = (e) => { e.preventDefault(); window.native.openExternal(a.dataset.ext); });

// ---------------------------------------------------------------- auto-sync subtitles with the audio
// Listens to the sound for ~60 s, finds when people talk, and shifts the subtitles (±30 s) to match.
const audioTaps = new WeakMap();
function startAutoSync() {
  if (!ctl || !ctl.extCues || ctl.syncing) return;
  const v = ctl.eng.video, eng = ctl.eng;
  let tap = audioTaps.get(v);
  try {
    if (!tap) {
      const ac = new AudioContext(), src = ac.createMediaElementSource(v), an = ac.createAnalyser();
      an.fftSize = 2048; an.smoothingTimeConstant = 0; src.connect(an); an.connect(ac.destination);
      tap = { ac, an, buf: new Uint8Array(an.frequencyBinCount) }; audioTaps.set(v, tap);
    }
  } catch (e) { return toast('Auto-sync not available: ' + e.message); }
  tap.ac.resume();
  ctl.syncing = true; toast('🎯 Auto-sync: listening to the audio – keep watching (about 1 minute)');
  const samples = [], t0 = Date.now();
  const binHz = tap.ac.sampleRate / tap.an.fftSize, lo = Math.floor(300 / binHz), hi = Math.ceil(3400 / binHz);
  let last = -1, loud = 0;
  const stop = (msg) => { clearInterval(T); if (ctl) ctl.syncing = false; if (msg) toast(msg); };
  const T = setInterval(() => {
    if (!ctl || ctl.eng !== eng || !ctl.extCues) return stop();
    if (Date.now() - t0 > 240000) return samples.length >= 250 ? (clearInterval(T), finishAutoSync(samples)) : stop('🎯 Auto-sync stopped: the video did not play long enough. Try again while it plays.');
    if (v.paused || v.readyState < 3) return;
    const p = eng.pos(); if (Math.abs(p - last) < 0.03) return; // not moving (buffering)
    if (last >= 0 && Math.abs(p - last) > 2) samples.length = 0; // user jumped: start counting again
    last = p;
    tap.an.getByteFrequencyData(tap.buf);
    let sp = 0; for (let i = lo; i <= hi; i++) sp += tap.buf[i];
    sp /= (hi - lo + 1); if (sp > 1) loud++;
    samples.push([p, sp]);
    if (samples.length === 120 && loud < 5) return stop('🎯 Auto-sync: could not hear the audio of this stream. Use ⚙ → Subtitles delay to adjust by hand.');
    if (samples.length % 100 === 0 && samples.length < 600) toast(`🎯 Auto-sync: listening… ${samples.length / 10} / 60 s`);
    if (samples.length >= 600) { clearInterval(T); finishAutoSync(samples); }
  }, 100);
}
function finishAutoSync(samples) {
  if (!ctl) return;
  ctl.syncing = false;
  // correlate "how loud is the speech band" with "is a subtitle on screen", for every shift −30…+30 s
  const v = samples.map(x => x[1]), n = v.length, m = v.reduce((p, c) => p + c, 0) / n;
  const sd = Math.sqrt(v.reduce((p, c) => p + (c - m) * (c - m), 0) / n) || 1;
  const cues = ctl.extCues;
  const active = (t) => { let lo = 0, hi = cues.length - 1; while (lo <= hi) { const k = (lo + hi) >> 1; if (cues[k].e < t) lo = k + 1; else if (cues[k].s > t) hi = k - 1; else return 1; } return 0; };
  const corr = (d) => { let on = 0, sum = 0; for (let i = 0; i < n; i++) if (active(samples[i][0] - d)) { on++; sum += v[i] - m; } if (!on || on === n) return -1; const pa = on / n; return sum / (n * sd * Math.sqrt(pa * (1 - pa))); };
  let best = 0, bestScore = -1e9; const scoreAt0 = corr(0);
  for (let k = -300; k <= 300; k++) { const d = k / 10, c = corr(d); if (c > bestScore || (c === bestScore && Math.abs(d) < Math.abs(best))) { bestScore = c; best = d; } }
  if (bestScore < 0.12 || bestScore <= scoreAt0 + 0.03 || Math.abs(best) < 0.15) return toast('🎯 Auto-sync: subtitles already look in sync (or audio too unclear). Use ⚙ → Subtitles delay to adjust by hand.');
  S.settings.subDelay = Math.round(best * 10) / 10; save('settings', S.settings);
  clearCues(); addCues(ctl.extCues);
  toast(`🎯 Subtitles shifted by ${S.settings.subDelay > 0 ? '+' : ''}${S.settings.subDelay.toFixed(1)} s`);
}

// ---------------------------------------------------------------- recordings
const VLC_UA = 'VLC/3.0.21 LibVLC/3.0.21';
async function scheduleRecording(ch, st, en, title) {
  const name = title ? `${ch.name} - ${title}` : ch.name;
  await window.native.recAdd({ name, chId: ch.id, url: streamUrl(ch), ua: (S.user && S.user.streamUA) || VLC_UA, start: st - 60, end: en + 120 });
  toast(`⏺ Recording scheduled: ${name} (${fmtTime(new Date(st * 1000))})`);
}
// instant recording of what is playing: same connection as the player (works on 1-connection accounts)
$('#player-rec').onclick = async () => {
  const eng = engines.full; if (!eng || !S.current) return;
  if (eng.opts.rec) {
    await window.native.recCancel(eng.opts.rec.id);
    eng.opts.rec = null; $('#player-rec').classList.remove('on'); $('#player-rec').textContent = '⏺ Rec';
    toast('⏹ Recording saved'); eng.restart(); return;
  }
  const r = await window.native.recInstant(S.current.name);
  eng.opts.rec = r; eng.recStart = Date.now();
  $('#player-rec').classList.add('on');
  toast('⏺ Recording started'); eng.restart();
};
setInterval(() => {
  const eng = engines.full;
  if (eng && eng.opts && eng.opts.rec) $('#player-rec').textContent = '⏺ ' + fmtDur((Date.now() - eng.recStart) / 1000);
}, 1000);
let REC = [];
async function openRecordings() {
  stopAll(); show('#screen-main');
  S.view = 'rec'; setNav('rec');
  $('#side').classList.add('hidden'); $('#browse').classList.add('hidden'); $('#dash').classList.add('hidden'); $('#guideview').classList.add('hidden'); $('#recview').classList.remove('hidden');
  $('#crumb').textContent = 'Recordings';
  // channel choices: current/recent/favourite live channels (+ the whole live list if loaded)
  const seen = new Set(), opts = [];
  const add = (c) => { if (c && c.kind === 'live' && !seen.has(c.id)) { seen.add(c.id); opts.push(c); } };
  S.recent.forEach(add); Object.values(S.fav).forEach(add); (S.data.live ? S.data.live.items.slice(0, 2000) : []).forEach(add);
  S.recChoices = opts;
  $('#rs-ch').innerHTML = opts.map((c, i) => `<option value="${i}">${esc(c.name)}</option>`).join('') || '<option>Open Live TV first</option>';
  const d = new Date(Date.now() + 5 * 60000); d.setSeconds(0, 0);
  $('#rs-start').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  REC = await window.native.recList(); renderRecordings();
}
function renderRecordings() {
  const anyRec = REC.some(r => r.status === 'recording');
  $('#rec-dot').classList.toggle('hidden', !anyRec);
  if (S.view !== 'rec') return;
  const list = REC.slice().sort((a, b) => b.start - a.start);
  $('#rec-list').innerHTML = list.length ? list.map(r => {
    const when = new Date(r.start * 1000).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const len = r.end ? ` – ${fmtTime(new Date(r.end * 1000))}` : '';
    const acts = [
      r.status === 'done' || r.status === 'recording' ? `<button class="btn small" data-rplay="${r.id}">▶ Play</button>` : '',
      r.file ? `<button class="btn small ghost" data-rfolder="${r.id}">📁</button>` : '',
      r.status === 'recording' || r.status === 'scheduled' ? `<button class="btn small ghost" data-rstop="${r.id}">${r.status === 'recording' ? '⏹ Stop' : '✖ Cancel'}</button>` : `<button class="btn small ghost" data-rdel="${r.id}" title="Remove (keeps the file)">🗑</button>`
    ].join('');
    return `<div class="rec-item"><span class="rstat ${r.status}">${r.status}</span><div class="ri-main"><b>${esc(r.name)}</b><small>${when}${len}${r.size ? ' · ' + mb(r.size) : ''}${r.error ? ' · ' + esc(r.error) : ''}</small></div>${acts}</div>`;
  }).join('') : '<div class="empty">No recordings yet.</div>';
}
window.native.onRec((l) => { REC = l; renderRecordings(); });
window.native.onRecStarting((r) => {
  toast('⏺ Scheduled recording starting: ' + r.name);
  if (!$('#player').classList.contains('hidden') && S.account && +S.account.max_connections <= 1) { closePlayer(); toast('Playback stopped – your account allows 1 connection and a recording is starting'); }
});
window.native.recList().then(l => { REC = l; renderRecordings(); });
$('#rs-add').onclick = async () => {
  const c = (S.recChoices || [])[+$('#rs-ch').value]; if (!c) return toast('Open Live TV first so channels are loaded');
  const st = Math.floor(new Date($('#rs-start').value).getTime() / 1000), mins = Math.max(1, +$('#rs-min').value || 60);
  if (!st) return toast('Pick a start time');
  await window.native.recAdd({ name: c.name, chId: c.id, url: streamUrl(c), ua: (S.user && S.user.streamUA) || VLC_UA, start: st, end: st + mins * 60 });
  toast('⏺ Recording scheduled');
  REC = await window.native.recList(); renderRecordings();
};
$('#rec-list').addEventListener('click', async (e) => {
  const id = (k) => { const el = e.target.closest(`[data-${k}]`); return el && el.dataset[k]; };
  const r = (x) => REC.find(y => y.id === x);
  let x;
  if ((x = id('rplay'))) { const rr = r(x); return playFull({ kind: 'movie', id: 'rec_' + rr.id, name: rr.name, url: rr.file, catName: 'Recording' }); }
  if ((x = id('rfolder'))) return window.native.recFolder(r(x).file);
  if ((x = id('rstop'))) { await window.native.recCancel(x); return; }
  if ((x = id('rdel'))) { await window.native.recDelete(x, false); return; }
});

// ---------------------------------------------------------------- links + downloads
function dlName(item) {
  const ext = item.ext || ((item.url || '').match(/\.(mp4|mkv|avi|mov|ts|m4v)(\?|$)/i) || [])[1] || 'mp4';
  const base = item.kind === 'episode' && item.seriesName ? `${item.seriesName} - ${item.name}` : item.name;
  return `${base}.${ext}`;
}
const canDownload = (item) => item && item.kind !== 'live';
function showLinkPanel(item) {
  const url = streamUrl(item);
  $('#lp-name').textContent = item.name;
  $('#lp-url').value = url;
  $('#lp-dl').classList.toggle('hidden', !canDownload(item));
  const ua = (S.user && S.user.streamUA) || 'VLC/3.0.21 LibVLC/3.0.21';
  $('#lp-note').innerHTML = (item.kind === 'live'
    ? 'Live TV is a never-ending stream, so it can\'t be downloaded – copy the URL and paste it in VLC (Media → Open Network Stream) or any IPTV player.'
    : 'Download saves the file to your Downloads folder.') +
    `<br><br>Note: your server only allows certain players. VLC works. Other apps may need this User-Agent: <code>${esc(ua)}</code>` +
    (S.account && +S.account.max_connections === 1 ? '<br><br>Your account allows 1 connection at a time – stop playback before using the link elsewhere.' : '');
}
async function copyLink(item) {
  await window.native.copy(streamUrl(item));
  toast('🔗 Link copied – paste it anywhere (Ctrl+V)');
}
async function startDownload(item) {
  if (!canDownload(item)) return toast('Live TV cannot be downloaded – use Copy URL');
  // account allows 1 connection: stop playback so the download can connect
  if (!$('#player').classList.contains('hidden') && S.account && +S.account.max_connections <= 1) { closePlayer(); toast('Playback stopped (1 connection allowed) – download starting…'); }
  else toast('⬇ Download started – see ⬇ at the top');
  await window.native.dlStart(streamUrl(item), dlName(item), (S.user && S.user.streamUA) || 'VLC/3.0.21 LibVLC/3.0.21');
}
$('#lp-copy').onclick = () => { if (S.current) { copyLink(S.current); $('#lp-url').select(); } };
$('#lp-dl').onclick = () => S.current && startDownload(S.current);

const DL = new Map();
const mb = (b) => (b / 1048576).toFixed(b > 1073741824 ? 0 : 1) + ' MB';
function renderDownloads() {
  const list = [...DL.values()].reverse();
  const active = list.filter(d => ['starting', 'downloading', 'waiting'].includes(d.state));
  const badge = $('#dl-badge');
  if (active.length) {
    const d = active[0];
    badge.textContent = d.total ? Math.floor(d.got / d.total * 100) + '%' : active.length;
    badge.classList.remove('hidden');
  } else badge.classList.add('hidden');
  $('#dl-list').innerHTML = list.length ? list.map(d => {
    const pct = d.total ? Math.min(100, d.got / d.total * 100) : (d.state === 'done' ? 100 : 0);
    const status = { starting: 'Starting…', waiting: 'Waiting for free connection…', downloading: `${mb(d.got)}${d.total ? ' / ' + mb(d.total) : ''} · ${mb(d.speed || 0)}/s`, done: '✅ Done · ' + mb(d.got), error: '⚠️ ' + d.error, cancelled: 'Cancelled' }[d.state] || d.state;
    const act = ['starting', 'downloading', 'waiting'].includes(d.state) ? `<button data-dlc="${d.id}">Cancel</button>` : d.state === 'done' ? `<button data-dls="${d.id}">Show in folder</button>` : '';
    return `<div class="dl-item"><b title="${esc(d.name)}">${esc(d.name)}</b><div class="dl-bar"><div style="width:${pct}%"></div></div><div class="dl-meta"><span>${esc(status)}</span>${act}</div></div>`;
  }).join('') : '<div class="dl-empty">No downloads yet. Open a movie or episode and press ⬇ Download.</div>';
}
window.native.onDl((d) => {
  const prev = DL.get(d.id);
  DL.set(d.id, d);
  if (d.state === 'done' && (!prev || prev.state !== 'done')) toast('✅ Downloaded: ' + d.name);
  if (d.state === 'error' && (!prev || prev.state !== 'error')) toast('⚠️ Download failed: ' + d.error);
  renderDownloads();
});
$('#btn-dl').onclick = (e) => { e.stopPropagation(); renderDownloads(); $('#dlmenu').classList.toggle('hidden'); };
$('#dlmenu').addEventListener('click', (e) => {
  e.stopPropagation();
  const c = e.target.closest('[data-dlc]'); if (c) return window.native.dlCancel(+c.dataset.dlc);
  const sh = e.target.closest('[data-dls]'); if (sh) return window.native.dlShow(DL.get(+sh.dataset.dls).file);
});
$('#dl-folder').onclick = () => window.native.dlShow('');
document.addEventListener('click', (e) => { if (!e.target.closest('.dlwrap')) $('#dlmenu').classList.add('hidden'); });
// ---------------------------------------------------------------- player controls
const ICON = {
  play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
  fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z'
};
const ASPECTS = [['Fit', 'contain'], ['Fill (crop)', 'cover'], ['Stretch', 'fill'], ['Original', 'none']];
const LANG = { hin: 'Hindi', eng: 'English', guj: 'Gujarati', tam: 'Tamil', tel: 'Telugu', mar: 'Marathi', ben: 'Bengali', pan: 'Punjabi', urd: 'Urdu', mal: 'Malayalam', kan: 'Kannada', ara: 'Arabic', spa: 'Spanish', fra: 'French', fre: 'French', ger: 'German', deu: 'German', por: 'Portuguese', ita: 'Italian', rus: 'Russian', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', tur: 'Turkish', und: 'Unknown' };
const langName = (l) => LANG[(l || '').toLowerCase()] || (l ? l.toUpperCase() : '');
function fmtDur(t, long) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h || long ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
}
let ctl = null; // current controls state
function bindControls(eng, item) {
  const v = eng.video, isLive = item.kind === 'live';
  ctl = { eng, item, isLive, dur: 0, dragging: false, tracks: null, extCues: item._extCues || null };
  v.volume = S.settings.volume ?? 1; v.muted = !!S.settings.muted;
  v.style.objectFit = (ASPECTS[S.settings.aspect || 0] || ASPECTS[0])[1];
  v.playbackRate = isLive ? 1 : (S.settings.speed || 1);
  $('#pseek').classList.toggle('hidden', isLive);
  $('#ptime-cur').classList.toggle('hidden', isLive);
  $('#plive').classList.toggle('hidden', !isLive);
  if (item.kind === 'catchup') ctl.dur = item.dur;
  const L = S.playingList || [];
  $('#pb-prev').disabled = !(L.length > 1 && S.playingIndex > 0) && !isLive;
  $('#pb-next').disabled = !(L.length > 1 && S.playingIndex < L.length - 1) && !isLive;
  if (isLive) { $('#pb-prev').disabled = L.length < 2; $('#pb-next').disabled = L.length < 2; }
  $('#pb-prev').title = isLive ? 'Previous channel (↓)' : 'Previous episode';
  $('#pb-next').title = isLive ? 'Next channel (↑)' : 'Next episode';
  const upd = () => updateControls();
  ['timeupdate', 'progress', 'play', 'pause', 'volumechange', 'durationchange', 'loadedmetadata'].forEach(ev => v.addEventListener(ev, upd));
  v.addEventListener('click', () => { if (swipe.used) { swipe.used = false; return; } closeMenus(); togglePlay(); });
  v.style.filter = (S.settings.bright ?? 1) === 1 ? '' : `brightness(${S.settings.bright})`;
  // subtitle track on the <video>
  ctl.tt = v.addTextTrack('subtitles', 'Subtitles', 'en'); ctl.tt.mode = 'showing';
  ctl.cueKeys = new Set();
  applySubStyle();
  if (ctl.extCues) { eng.extSubs = true; }
  updateControls();
}
// position of the movie (seconds) -> time on the <video> element
function toVideoTime(abs) { const e = ctl.eng; return (e.stage > 0 ? abs - e.offset + (e.base || 0) : abs) + (S.settings.subDelay || 0); }
function addCues(list) {
  if (!ctl || !ctl.tt) return;
  if (list === ctl.extCues) return; // external subtitles are drawn by the overlay below
  if (ctl.eng.stage > 0 && ctl.eng.base === null) return; // wait until the start point is known
  for (const c of list) {
    const key = c.s + '|' + c.t;
    if (ctl.cueKeys.has(key)) continue;
    ctl.cueKeys.add(key);
    const st = toVideoTime(c.s), en = toVideoTime(c.e);
    if (en <= 0) continue;
    try { const vc = new VTTCue(Math.max(0, st), en, c.t); vc.snapToLines = true; vc.line = -4; ctl.tt.addCue(vc); } catch {} // -4 = above the control bar
  }
}
function clearCues() { if (!ctl || !ctl.tt) return; for (const c of [...(ctl.tt.cues || [])]) ctl.tt.removeCue(c); ctl.cueKeys = new Set(); }
function parseSubs(text) {
  const out = [];
  if (/\[Events\]/i.test(text) && /^Dialogue:/m.test(text)) { // .ass / .ssa
    const t = (x) => { const m = x.trim().match(/(\d+):(\d+):(\d+)[.:](\d+)/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4])) : 0; };
    for (const l of text.split(/\r?\n/)) { if (!l.startsWith('Dialogue:')) continue; const p = l.slice(9).split(','); if (p.length < 10) continue; const tx = p.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim(); if (tx) out.push({ s: t(p[1]), e: t(p[2]), t: tx }); }
    return out.sort((a, b) => a.s - b.s);
  }
  const ts = (x) => { const m = x.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+)\.(\d+)/); return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4])) : 0; };
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n'); const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
    if (t) out.push({ s: ts(a), e: ts(b.split(' ').filter(Boolean)[0] || b), t });
  }
  return out;
}
function applySubStyle() {
  let st = document.getElementById('cue-style');
  if (!st) { st = document.createElement('style'); st.id = 'cue-style'; document.head.appendChild(st); }
  st.textContent = `video::cue{font-size:${S.settings.subSize || 100}%;}`;
}
function ctlDuration() {
  if (!ctl) return 0;
  if (ctl.item.kind === 'catchup') return ctl.item.dur;
  const v = ctl.eng.video;
  if (ctl.eng.stage === 0 && isFinite(v.duration) && v.duration > 0) return v.duration;
  return ctl.dur || 0;
}
function updateControls() {
  if (!ctl) return;
  const v = ctl.eng.video;
  $('#pb-play-ico').setAttribute('d', v.paused && !ctl.eng.autoPaused ? ICON.play : ICON.pause);
  $('#pb-mute-ico').setAttribute('d', v.muted || v.volume === 0 ? ICON.mute : ICON.vol);
  $('#pb-vol').value = v.muted ? 0 : v.volume;
  $('#pb-subs').classList.toggle('on', (ctl.eng.opts && ctl.eng.opts.s >= 0) || !!ctl.extCues);
  if (ctl.isLive) {
    // live pause / rewind: how far behind the live edge are we?
    const b = v.buffered, edge = b.length ? b.end(b.length - 1) : v.currentTime, behind = Math.max(0, edge - v.currentTime);
    const lag = behind > 8;
    $('#plive').classList.toggle('behind', lag);
    $('#plive').textContent = lag ? `● GO LIVE  (−${fmtDur(behind)})` : '● LIVE';
    $('#ptime').textContent = fmtDur(v.currentTime);
    return;
  }
  const d = ctlDuration(), pos = ctl.eng.pos();
  if (!ctl.dragging) {
    const pct = d ? Math.min(100, pos / d * 100) : 0;
    $('#pseek-fill').style.width = pct + '%'; $('#pseek-knob').style.left = pct + '%';
    let bufEnd = 0; const b = v.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5) bufEnd = Math.max(bufEnd, b.end(i));
    $('#pseek-buf').style.width = (d ? Math.min(100, (ctl.eng.offset + bufEnd) / d * 100) : 0) + '%';
  }
  $('#ptime-cur').textContent = fmtDur(pos, d >= 3600);
  $('#ptime').textContent = d ? fmtDur(d, true) : '--:--';
}
function togglePlay() {
  if (!ctl) return; const v = ctl.eng.video;
  if (v.paused && !ctl.eng.autoPaused) { ctl.eng.userPaused = false; v.play().catch(() => {}); }
  else { ctl.eng.userPaused = true; ctl.eng.gating = false; ctl.eng.autoPaused = false; v.pause(); $('#pbuffer').classList.add('hidden'); }
  updateControls();
}
function seekBy(sec) {
  if (!ctl) return;
  if (ctl.isLive) {
    // rewind / forward inside what the player has kept (about 5 minutes)
    const v = ctl.eng.video, b = v.buffered; if (!b.length) return;
    const lo = b.start(0) + 0.5, hi = b.end(b.length - 1) - 1;
    v.currentTime = Math.min(hi, Math.max(lo, v.currentTime + sec));
    if (sec < 0 && v.currentTime <= lo + 0.1) toast('That is as far back as the player has kept (about 5 min)');
    return;
  }
  clearCues(); ctl.eng.seekTo(ctl.eng.pos() + sec);
}
$('#plive').onclick = () => { if (!ctl || !ctl.isLive) return; const v = ctl.eng.video, b = v.buffered; if (b.length) v.currentTime = b.end(b.length - 1) - 1.5; if (v.paused) togglePlay(); };
function playNeighbor(step) {
  const L = S.playingList; if (!L || L.length < 2) return;
  if (S.current?.kind === 'live') return zap(step);
  const i = S.playingIndex + step; if (i < 0 || i >= L.length) return;
  playFull(L[i], L, i); toast(L[i].name);
}
// poll converter log for duration + track list, and the subtitle file
setInterval(async () => {
  if (!ctl || $('#player').classList.contains('hidden') || !ctl.eng.local) return;
  const eng = ctl.eng;
  const l = await window.native.convertLog(eng.local);
  if (!l || !ctl || ctl.eng !== eng) return;
  if (l.duration && !ctl.isLive) ctl.dur = l.duration;
  if (l.tracks) ctl.tracks = l.tracks;
  if (l.hasSub && eng.base !== null) {
    const src = eng.local;
    try { const r = await fetch(src.replace(/\/s\/(\d+)\.ts.*/, '/sub/$1.vtt'), { cache: 'no-store' }); const txt = await r.text(); if (ctl && ctl.eng === eng && eng.local === src && eng.base !== null) addCues(parseSubs(txt)); } catch {}
  }
}, 1500);

// ---- menus ----
function closeMenus() { $$('.pmenu').forEach(m => m.classList.add('hidden')); }
function openMenu(id, html) { const m = $(id); const was = !m.classList.contains('hidden'); closeMenus(); if (was) return; m.innerHTML = html; m.classList.remove('hidden'); }
const mi = (attr, label, on, sub, dis) => `<div class="mi ${on ? 'on' : ''} ${dis ? 'dis' : ''}" ${dis ? '' : attr}><span>${esc(label)}${sub ? ` <small>${esc(sub)}</small>` : ''}</span></div>`;
$('#pb-subs').onclick = (e) => {
  e.stopPropagation(); if (!ctl) return;
  const t = ctl.tracks, cur = ctl.eng.opts ? ctl.eng.opts.s : -1;
  let html = '<h5>Subtitles</h5>' + mi('data-sub="-1"', 'Off', cur < 0 && !ctl.extCues);
  if (ctl.isLive) html += mi('', 'Subtitles are available for movies & series', false, '', true);
  else if (t && t.subs.length) html += t.subs.map(x => mi(`data-sub="${x.n}"`, langName(x.lang) || 'Track ' + (x.n + 1), cur === x.n, x.text ? x.codec : 'image subtitles – not supported', !x.text)).join('');
  else html += mi('', t ? 'No subtitles in this file' : 'Looking for subtitles…', false, '', true);
  if (!ctl.isLive) {
    html += '<div class="sep"></div>' + mi('data-sub="online"', '🌐 Find subtitles online…') + mi('data-sub="file"', '📂 Load subtitle file (.srt / .vtt / .ass)…', !!ctl.extCues);
    if (ctl.extCues) html += mi('data-sub="sync"', ctl.syncing ? '🎯 Auto-sync: listening…' : '🎯 Auto-sync with the audio', false, ctl.syncing ? 'keep watching ~1 min' : '');
  }
  openMenu('#menu-subs', html);
};
$('#menu-subs').onclick = (e) => {
  e.stopPropagation();
  const d = e.target.closest('[data-sub]'); if (!d || !ctl) return;
  closeMenus();
  if (d.dataset.sub === 'file') return $('#sub-file').click();
  if (d.dataset.sub === 'online') return openSubSearch();
  if (d.dataset.sub === 'sync') return startAutoSync();
  const n = +d.dataset.sub;
  ctl.extCues = null; ctl.item._extCues = null; ctl.eng.extSubs = false;
  ctl.item._sTrack = n; ctl.eng.opts.s = n;
  clearCues();
  toast(n < 0 ? 'Subtitles off' : 'Loading subtitles…');
  ctl.eng.restart();
};
// overlay for downloaded / loaded subtitle files: follows the movie position directly, so it works with every playback mode
function cueAt(cues, t) { let lo = 0, hi = cues.length - 1, f = -1; while (lo <= hi) { const k = (lo + hi) >> 1; if (cues[k].s <= t) { f = k; lo = k + 1; } else hi = k - 1; } const out = []; for (let i = f; i >= 0 && i > f - 6; i--) if (cues[i].s <= t && t < cues[i].e) out.unshift(cues[i].t); return out; }
setInterval(() => {
  const ov = $('#subov'); if (!ov) return;
  if (!ctl || !ctl.extCues || $('#player').classList.contains('hidden')) { if (ov.textContent) ov.innerHTML = ''; return; }
  const lines = cueAt(ctl.extCues, ctl.eng.pos() - (S.settings.subDelay || 0));
  const html = lines.map(x => esc(x).replace(/\n/g, '<br>')).join('<br>');
  if (ov.innerHTML !== html) ov.innerHTML = html;
  ov.style.fontSize = (2.4 * (S.settings.subSize || 100) / 100).toFixed(2) + 'vw';
}, 120);
function applyExtSubs(text, label) {
  if (!ctl) return false;
  const cues = parseSubs(text);
  if (!cues.length) { toast('Could not read subtitles from this file'); return false; }
  cues.sort((a, b) => a.s - b.s);
  const hadTrack = ctl.eng.opts.s >= 0;
  ctl.extCues = cues; ctl.item._extCues = cues; ctl.item._sTrack = -1; ctl.eng.opts.s = -1;
  clearCues();
  if (hadTrack) ctl.eng.restart();
  toast(`Subtitles loaded (${cues.length} lines, ${fmtDur(cues[0].s, true)} – ${fmtDur(cues[cues.length - 1].e, true)})${label ? ' – ' + label : ''}. Out of sync? Use 🎯 Auto-sync or ⚙ → Subtitles delay.`);
  return true;
}
$('#sub-file').onchange = async () => {
  const f = $('#sub-file').files[0]; $('#sub-file').value = '';
  if (!f || !ctl) return;
  const cues = parseSubs(await f.text());
  if (!cues.length) return toast('Could not read subtitles from this file');
  ctl.extCues = cues; ctl.item._extCues = cues; ctl.item._sTrack = -1; ctl.eng.opts.s = -1;
  clearCues();
  toast(`Subtitles loaded (${cues.length} lines)`);
  // exact timing needs the converter in full mode; direct playback already has exact time
  addCues(cues);
};
// external subtitles: re-add after every (re)start, timing depends on the restart point
setInterval(() => { if (ctl && ctl.extCues && ctl.tt && ctl.cueKeys.size === 0) addCues(ctl.extCues); }, 1000);

$('#pb-audio').onclick = (e) => {
  e.stopPropagation(); if (!ctl) return;
  const t = ctl.tracks, cur = ctl.eng.opts ? ctl.eng.opts.a : 0;
  let html = '<h5>Audio</h5>';
  if (t && t.audio.length) html += t.audio.map(x => mi(`data-aud="${x.n}"`, langName(x.lang) || 'Track ' + (x.n + 1), cur === x.n, x.codec + (x.info ? ' · ' + x.info.split(',').slice(0, 2).join(',') : ''))).join('');
  else html += mi('', ctl.eng.stage === 0 ? 'Default audio' : 'Looking for audio tracks…', true, '', true);
  openMenu('#menu-audio', html);
};
$('#menu-audio').onclick = (e) => {
  e.stopPropagation();
  const d = e.target.closest('[data-aud]'); if (!d || !ctl) return;
  closeMenus();
  const n = +d.dataset.aud; if (n === ctl.eng.opts.a) return;
  ctl.item._aTrack = n; ctl.eng.opts.a = n;
  clearCues(); toast('Switching audio…');
  ctl.eng.restart();
};
$('#pb-set').onclick = (e) => {
  e.stopPropagation(); if (!ctl) return;
  const q = S.settings.quality || 'auto', sp = S.settings.speed || 1;
  let html = '<h5>Quality</h5>' + ['auto', '1080p', '720p', '480p'].map(x => mi(`data-q="${x}"`, x === 'auto' ? 'Auto' + (S.autoLow ? ' (480p)' : '') : x, q === x)).join('');
  if (!ctl.isLive) html += '<div class="sep"></div><h5>Playback speed</h5>' + [0.75, 1, 1.25, 1.5, 2].map(x => mi(`data-sp="${x}"`, x === 1 ? 'Normal' : x + '×', sp === x)).join('');
  const sl = S.sleepAt ? Math.ceil((S.sleepAt - Date.now()) / 60000) : 0;
  html += '<div class="sep"></div><h5>Sleep timer' + (sl ? ` (${sl} min left)` : '') + '</h5>' + [0, 15, 30, 60, 90].map(m => mi(`data-sleep="${m}"`, m ? m + ' min' : 'Off', m === 0 ? !S.sleepAt : false)).join('');
  if (ctl.item.kind === 'episode') html += '<div class="sep"></div>' + mi('data-autonext="1"', 'Auto-play next episode', S.settings.autoNext !== false);
  html += `<div class="sep"></div><h5>Subtitles</h5>
    <div class="rowctl"><span>Size ${S.settings.subSize || 100}%</span><span><button data-ss="-10">−</button> <button data-ss="10">+</button></span></div>
    <div class="rowctl"><span>Delay ${(S.settings.subDelay || 0).toFixed(1)}s</span><span><button data-sd="-0.5">−</button> <button data-sd="0.5">+</button></span></div>`;
  openMenu('#menu-set', html);
};
$('#menu-set').onclick = (e) => {
  e.stopPropagation(); if (!ctl) return;
  const slp = e.target.closest('[data-sleep]'), an = e.target.closest('[data-autonext]');
  if (slp) { const m = +slp.dataset.sleep; S.sleepAt = m ? Date.now() + m * 60000 : 0; closeMenus(); return toast(m ? `😴 Playback will stop in ${m} min` : 'Sleep timer off'); }
  if (an) { S.settings.autoNext = S.settings.autoNext === false; save('settings', S.settings); closeMenus(); return toast('Auto-play next episode: ' + (S.settings.autoNext ? 'on' : 'off')); }
  const qd = e.target.closest('[data-q]'), spd = e.target.closest('[data-sp]'), ss = e.target.closest('[data-ss]'), sd = e.target.closest('[data-sd]');
  if (qd) {
    closeMenus();
    S.settings.quality = qd.dataset.q; save('settings', S.settings);
    if (S.current.kind === 'live' && S.chanStage && qd.dataset.q !== 'auto') S.chanStage[S.current.id] = 2;
    const pos = !ctl.isLive ? ctl.eng.pos() : 0; if (pos) S.current._startAt = pos;
    playFull(S.current, S.playingList, S.playingIndex);
    return toast('Quality: ' + qd.dataset.q);
  }
  if (spd) { S.settings.speed = +spd.dataset.sp; save('settings', S.settings); ctl.eng.video.playbackRate = S.settings.speed; toast('Speed ' + S.settings.speed + '×'); closeMenus(); return; }
  if (ss) { S.settings.subSize = Math.min(200, Math.max(50, (S.settings.subSize || 100) + +ss.dataset.ss)); applySubStyle(); }
  if (sd) { S.settings.subDelay = Math.round(((S.settings.subDelay || 0) + +sd.dataset.sd) * 10) / 10; clearCues(); if (ctl.extCues) addCues(ctl.extCues); }
  save('settings', S.settings);
  closeMenus(); $('#pb-set').click(); // re-open with new values
};
document.addEventListener('click', (e) => { if (!e.target.closest('.pmenu-wrap')) closeMenus(); });

$('#pb-play').onclick = togglePlay;
$('#pb-back').onclick = () => seekBy(-30);
$('#pb-fwd').onclick = () => seekBy(30);
$('#pb-prev').onclick = () => playNeighbor(-1);
$('#pb-next').onclick = () => playNeighbor(1);
$('#pb-aspect').onclick = () => {
  if (!ctl) return;
  S.settings.aspect = ((S.settings.aspect || 0) + 1) % ASPECTS.length; save('settings', S.settings);
  ctl.eng.video.style.objectFit = ASPECTS[S.settings.aspect][1];
  toast('Aspect: ' + ASPECTS[S.settings.aspect][0]);
};
$('#pb-mute').onclick = () => { if (!ctl) return; const v = ctl.eng.video; v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; S.settings.muted = v.muted; save('settings', S.settings); };
// swipe with the mouse on the video: right half = volume, left half = brightness (like mobile players)
const swipe = { on: false, used: false };
function swipeOsd(icon, val, label) {
  const o = $('#swipe-osd'); o.classList.remove('hidden');
  o.innerHTML = `<span>${icon}</span><div class="sw-bar"><i style="height:${Math.round(Math.max(0, Math.min(1, val)) * 100)}%"></i></div><b>${label}</b>`;
  clearTimeout(swipe.t); swipe.t = setTimeout(() => o.classList.add('hidden'), 900);
}
function setVolume(x) {
  const v = ctl.eng.video; x = Math.max(0, Math.min(1, x)); v.volume = x; v.muted = x === 0;
  S.settings.volume = x; S.settings.muted = v.muted; save('settings', S.settings);
  swipeOsd(x === 0 ? '🔇' : x < 0.5 ? '🔉' : '🔊', x, Math.round(x * 100) + '%');
}
function setBright(x) {
  x = Math.max(0.2, Math.min(1.6, Math.round(x * 100) / 100)); S.settings.bright = x; save('settings', S.settings);
  ctl.eng.video.style.filter = x === 1 ? '' : `brightness(${x})`;
  swipeOsd('☀️', (x - 0.2) / 1.4, Math.round(x * 100) + '%');
}
$('#player').addEventListener('mousedown', (e) => {
  if (!ctl || e.button !== 0 || e.target.tagName !== 'VIDEO') return;
  const r = e.target.getBoundingClientRect();
  Object.assign(swipe, { on: true, used: false, y: e.clientY, h: r.height, right: e.clientX > r.left + r.width / 2, vol: ctl.eng.video.muted ? 0 : ctl.eng.video.volume, br: S.settings.bright ?? 1 });
});
window.addEventListener('mousemove', (e) => {
  if (!swipe.on || !ctl) return;
  const dy = swipe.y - e.clientY;
  if (!swipe.used && Math.abs(dy) < 12) return;
  swipe.used = true; e.preventDefault();
  const frac = dy / (swipe.h * 0.6); // drag 60% of the height = full range
  if (swipe.right) setVolume(swipe.vol + frac); else setBright(swipe.br + frac * 1.4);
});
window.addEventListener('mouseup', () => { swipe.on = false; });
// mouse wheel does the same: right side volume, left side brightness
$('#player').addEventListener('wheel', (e) => {
  if (!ctl || e.target.tagName !== 'VIDEO') return;
  e.preventDefault(); nudgeIdle && nudgeIdle();
  const r = e.target.getBoundingClientRect(), step = e.deltaY < 0 ? 0.05 : -0.05;
  if (e.clientX > r.left + r.width / 2) setVolume((ctl.eng.video.muted ? 0 : ctl.eng.video.volume) + step); else setBright((S.settings.bright ?? 1) + step);
}, { passive: false });
$('#pb-vol').oninput = () => { if (!ctl) return; const v = ctl.eng.video; v.volume = +$('#pb-vol').value; v.muted = v.volume === 0; S.settings.volume = v.volume; S.settings.muted = v.muted; save('settings', S.settings); };
$('#pb-pip').onclick = async () => { if (!ctl) return; try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await ctl.eng.video.requestPictureInPicture(); } catch (e) { toast('Picture-in-picture not available'); } };
$('#pb-fs').onclick = async () => { const fs = await window.native.toggleFullscreen(); $('#pb-fs-ico').setAttribute('d', fs ? ICON.fsExit : ICON.fs); };
// seek bar: click / drag, with time tooltip
(() => {
  const bar = $('#pseek');
  const frac = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  bar.addEventListener('mousemove', (e) => {
    const d = ctlDuration(); if (!d || !ctl || ctl.isLive) return;
    const f = frac(e), tip = $('#pseek-tip');
    tip.textContent = fmtDur(f * d, d >= 3600); tip.style.left = (f * 100) + '%'; tip.classList.remove('hidden');
    if (ctl.dragging) { $('#pseek-fill').style.width = f * 100 + '%'; $('#pseek-knob').style.left = f * 100 + '%'; }
  });
  bar.addEventListener('mouseleave', () => $('#pseek-tip').classList.add('hidden'));
  bar.addEventListener('mousedown', () => { if (ctl && !ctl.isLive && ctlDuration()) ctl.dragging = true; });
  window.addEventListener('mouseup', (e) => {
    if (!ctl || !ctl.dragging) return;
    ctl.dragging = false;
    const d = ctlDuration(); if (!d) return;
    clearCues();
    ctl.eng.seekTo(frac(e) * d);
  });
})();
setInterval(() => { if (ctl && !$('#player').classList.contains('hidden')) updateControls(); }, 500);
// auto-play next episode (like Smarters): 8 s countdown at the end, Esc / Cancel stops it
setInterval(() => {
  if (!ctl || $('#player').classList.contains('hidden') || ctl.item.kind !== 'episode') return;
  const d = ctlDuration(), p = ctl.eng.pos(), L = S.playingList || [];
  const hasNext = L.length > 1 && S.playingIndex < L.length - 1;
  if (!d || !hasNext || ctl.nextCancelled) return;
  const left = d - p;
  if (left < 12 && left > -5 && S.settings.autoNext !== false) {
    // countdown runs on the clock (the stream may stop a second before the real end)
    if (!ctl.nextAt) ctl.nextAt = Date.now() + Math.min(10, Math.max(3, left)) * 1000;
    const box = $('#nextbox'); box.classList.remove('hidden');
    $('#next-name').textContent = L[S.playingIndex + 1].name;
    const n = Math.max(0, Math.ceil((ctl.nextAt - Date.now()) / 1000)); $('#next-count').textContent = n;
    if (n <= 0 && !ctl.nextFired) { ctl.nextFired = true; S.pos[favKey(ctl.item)] = d; save(pKey('pos'), S.pos); box.classList.add('hidden'); playNeighbor(1); }
  } else { ctl.nextAt = 0; $('#nextbox').classList.add('hidden'); }
}, 500);
$('#next-cancel').onclick = () => { if (ctl) ctl.nextCancelled = true; $('#nextbox').classList.add('hidden'); };
$('#next-now').onclick = () => { if (!ctl) return; ctl.nextFired = true; $('#nextbox').classList.add('hidden'); S.pos[favKey(ctl.item)] = ctlDuration(); save(pKey('pos'), S.pos); playNeighbor(1); };
// sleep timer
setInterval(() => {
  if (!S.sleepAt) return;
  const left = S.sleepAt - Date.now();
  if (left <= 0) { S.sleepAt = 0; if (!$('#player').classList.contains('hidden')) { closePlayer(); toast('😴 Sleep timer – playback stopped'); } }
}, 5000);

function closePlayer() {
  ctl = null;
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  destroyEngine('full');
  $('#player').classList.add('hidden');
  window.native.exitFullscreen();
  if (['live', 'fav', 'recent'].includes(S.view) && S.current) {
    // jump the grid to the page of the channel we were watching (after zapping)
    const i = S.list ? S.list.indexOf(S.current) : -1;
    if (i >= 0) S.page = Math.floor(i / perPage());
    renderList(true);
  }
}
function zap(step) {
  const L = S.playingList; if (!L || L.length < 2 || S.current?.kind !== 'live') return;
  let i = S.playingIndex;
  do { i = (i + step + L.length) % L.length; } while (L[i].kind !== 'live' && i !== S.playingIndex);
  playFull(L[i], L, i);
  toast(`${L[i].num ? L[i].num + '. ' : ''}${L[i].name}`);
}
// type a channel number (like a TV remote): digits collect for 1.5 s, Enter plays at once
const numZap = { s: '', t: null };
function numZapKey(d) {
  numZap.s = (numZap.s + d).slice(-5);
  const o = $('#numzap'); o.classList.remove('hidden');
  const target = findChannelByNum(numZap.s);
  o.innerHTML = `<b>${esc(numZap.s)}</b><small>${target ? esc(target.name) : 'No channel'}</small>`;
  clearTimeout(numZap.t); numZap.t = setTimeout(numZapGo, 1500);
}
function findChannelByNum(n) {
  const L = S.data.live && S.data.live.items; if (!L) return null;
  return L.find(x => String(x.num) === String(+n)) || null;
}
function numZapGo() {
  clearTimeout(numZap.t); const n = numZap.s; numZap.s = '';
  const o = $('#numzap'); setTimeout(() => o.classList.add('hidden'), 400);
  if (!n) return;
  const ch = findChannelByNum(n);
  if (!ch) return toast(`Channel ${+n} not found`);
  let L = S.playingList && S.playingList.includes(ch) ? S.playingList : S.data.live.items.filter(x => x.cat === ch.cat);
  playFull(ch, L, L.indexOf(ch));
  toast(`${ch.num}. ${ch.name}`);
}
$('#player-close').onclick = closePlayer;
$('#player-vlc').onclick = () => S.current && openVLC(S.current);
$('#player-host').addEventListener('dblclick', (e) => { e.preventDefault(); $('#pb-fs').click(); });
let idleT;
function nudgeIdle() { const p = $('#player'); p.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => p.classList.add('idle'), 3000); }
$('#player').addEventListener('mousemove', nudgeIdle);

async function openVLC(item) {
  const ok = await window.native.openVLC(streamUrl(item), item.name, S.settings.vlcPath);
  if (ok) { toast('Opening in VLC...'); destroyEngine('mini'); destroyEngine('full'); $('#player').classList.add('hidden'); }
}

document.addEventListener('keydown', e => {
  const playerOpen = !$('#player').classList.contains('hidden');
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && !playerOpen && S.user) {
    e.preventDefault(); if (S.view === 'dash') openBrowse('live'); setTimeout(() => { $('#search').focus(); $('#search').select(); }, 50); return;
  }
  if (e.target.tagName === 'INPUT' && e.key !== 'Escape') return;
  if (playerOpen && /^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && (S.current?.kind === 'live' || numZap.s)) { e.preventDefault(); return numZapKey(e.key); }
  if (playerOpen && e.key === 'Enter' && numZap.s) { e.preventDefault(); return numZapGo(); }
  if (playerOpen) {
    nudgeIdle();
    const v = engines.full?.video;
    if (e.key === 'Escape') { e.preventDefault(); closeMenus(); window.native.exitFullscreen(); }
    else if (e.key === 'f' || e.key === 'F') window.native.toggleFullscreen();
    else if (e.key === ' ' && v) { e.preventDefault(); togglePlay(); }
    else if ((e.key === 'm' || e.key === 'M') && v) $('#pb-mute').click();
    // like a TV remote: Up = next channel number (10 -> 11), Down = previous (10 -> 9)
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); playNeighbor(1); }
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); playNeighbor(-1); }
    else if (e.key === 'ArrowRight' && v && S.current?.kind !== 'live') seekBy(30);
    else if (e.key === 'ArrowLeft' && v && S.current?.kind !== 'live') seekBy(-30);
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#details').classList.contains('hidden')) return $('#details').classList.add('hidden');
    if (!$('#settings').classList.contains('hidden')) return $('#settings').classList.add('hidden');
    if (document.activeElement === $('#search') && $('#search').value) { $('#search').value = ''; S.page = 0; return renderList(); }
    if (S.view !== 'dash' && !$('#screen-main').classList.contains('hidden')) return goHome();
  }
});

// ---------------------------------------------------------------- details (movie / series)
$('#details-close').onclick = () => $('#details').classList.add('hidden');
$('#details').addEventListener('click', e => { if (e.target.id === 'details') $('#details').classList.add('hidden'); });

async function openDetails(item) {
  const box = $('#details-content');
  if (item.url || S.user.type !== 'xtream') {
    // M3U item: no metadata API
    box.innerHTML = `<img class="cover" src="${esc(item.logo || '')}" onerror="this.style.visibility='hidden'"><div style="flex:1"><h1>${esc(item.name)}</h1><div class="meta"><span>${esc(item.cat || '')}</span></div><div class="row-btns"><button class="btn primary" id="d-play">▶ Play</button><button class="btn" id="d-vlc">Open in VLC</button>${item.kind !== 'live' ? '<button class="btn" id="d-dl">⬇ Download</button>' : ''}<button class="btn" id="d-link">🔗 Copy link</button><button class="btn ghost" id="d-fav">${S.fav[favKey(item)] ? '★ Remove favorite' : '☆ Add to favorites'}</button></div></div>`;
    $('#details').classList.remove('hidden');
    wireDetailButtons(item);
    return;
  }
  loader(true, 'Loading details...');
  try {
    if (item.kind === 'movie') {
      const d = await getJSON(api('get_vod_info', `&vod_id=${item.id}`));
      const i = d.info || {}; const md = d.movie_data || {};
      if (md.container_extension) item.ext = md.container_extension;
      const pos = S.pos[favKey(item)];
      setBackdrop(i);
      box.innerHTML = `
        <img class="cover" src="${esc(i.movie_image || i.cover_big || item.logo || '')}" onerror="this.style.visibility='hidden'">
        <div style="flex:1">
          <h1>${esc(i.name || item.name)}</h1>
          <div class="meta">${[i.releasedate || i.release_date, i.duration, i.genre, i.rating ? '★ ' + i.rating : '', item.ext?.toUpperCase()].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>
          <div class="row-btns">
            <button class="btn primary" id="d-play">▶ ${pos > 30 ? 'Resume' : 'Play'}</button>
            ${pos > 30 ? '<button class="btn" id="d-restart">↺ Start over</button>' : ''}
            <button class="btn" id="d-vlc">Open in VLC</button>
            <button class="btn" id="d-dl">⬇ Download</button>
            <button class="btn" id="d-link">🔗 Copy link</button>
            ${i.youtube_trailer ? '<button class="btn ghost" id="d-trailer">▶ Trailer</button>' : ''}
            <button class="btn ghost" id="d-fav">${S.fav[favKey(item)] ? '★ Remove favorite' : '☆ Add to favorites'}</button>
          </div>
          <p class="plot">${esc(i.plot || i.description || 'No description available.')}</p>
          ${i.director ? `<p class="meta"><b>Director:</b>&nbsp;${esc(i.director)}</p>` : ''}
          <div id="d-cast">${castChips(i.cast || i.actors)}</div>
          <div id="d-more"></div>
        </div>`;
      $('#details').classList.remove('hidden');
      wireDetailButtons(item);
      if ($('#d-restart')) $('#d-restart').onclick = () => { delete S.pos[favKey(item)]; $('#details').classList.add('hidden'); playFull(item); };
      if ($('#d-trailer')) $('#d-trailer').onclick = () => window.open('https://www.youtube.com/watch?v=' + i.youtube_trailer);
      fillMore(item, i);
    } else if (item.kind === 'series') {
      const d = await getJSON(api('get_series_info', `&series_id=${item.id}`));
      const i = d.info || {};
      const eps = d.episodes || {};
      const seasons = Object.keys(eps).sort((a, b) => +a - +b);
      setBackdrop(i);
      box.innerHTML = `
        <img class="cover" src="${esc(i.cover || item.logo || '')}" onerror="this.style.visibility='hidden'">
        <div style="flex:1;min-width:0">
          <h1>${esc(i.name || item.name)}</h1>
          <div class="meta">${[i.releaseDate || i.release_date, i.genre, i.rating ? '★ ' + i.rating : '', seasons.length + ' season(s)'].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>
          <div class="row-btns"><button class="btn ghost" id="d-fav">${S.fav[favKey(item)] ? '★ Remove favorite' : '☆ Add to favorites'}</button></div>
          <p class="plot">${esc(i.plot || 'No description available.')}</p>
          ${i.director ? `<p class="meta"><b>Director:</b>&nbsp;${esc(i.director)}</p>` : ''}
          <div id="d-cast">${castChips(i.cast)}</div>
          <div class="seasons">${seasons.map((s, k) => `<button class="season-btn ${k === 0 ? 'active' : ''}" data-season="${esc(s)}">Season ${esc(s)}</button>`).join('')}</div>
          <div id="ep-list"></div>
        </div>`;
      $('#details').classList.remove('hidden');
      wireDetailButtons(item);
      const showSeason = (s) => {
        $$('.season-btn').forEach(b => b.classList.toggle('active', b.dataset.season === s));
        const list = (eps[s] || []).map(e => ({ kind: 'episode', id: e.id, ext: e.container_extension, name: `S${s} E${e.episode_num} · ${e.title || ''}`, logo: e.info?.movie_image || i.cover, seriesId: item.id, seriesName: item.name, plot: e.info?.plot, dur: e.info?.duration }));
        $('#ep-list').innerHTML = list.map((e, k) => `
          <div class="ep" data-ep="${k}"><img src="${esc(e.logo || '')}" onerror="this.style.visibility='hidden'">
          <div style="flex:1"><div class="ep-t">${esc(e.name)}</div><small>${esc(e.dur || '')}${progressOf(e) >= 0.92 ? ' · <b style="color:#2e7d32">✓ Watched</b>' : S.pos[favKey(e)] > 30 ? ' · ▶ in progress' : ''}</small>${progressOf(e) > 0.01 && progressOf(e) < 0.92 ? `<div class="pbarmini"><div style="width:${Math.round(progressOf(e) * 100)}%"></div></div>` : ''}
          ${e.plot ? `<small style="display:block;margin-top:4px">${esc(e.plot.slice(0, 160))}</small>` : ''}</div>
          <div class="ep-act"><button class="btn small" data-epdl="${k}" title="Download">⬇</button><button class="btn small" data-eplink="${k}" title="Copy link">🔗</button><button class="btn small" data-vlc="${k}">VLC</button></div></div>`).join('') || '<div class="empty">No episodes.</div>';
        $('#ep-list').onclick = (ev) => {
          const dlb = ev.target.closest('[data-epdl]'); if (dlb) return startDownload(list[+dlb.dataset.epdl]);
          const lkb = ev.target.closest('[data-eplink]'); if (lkb) return copyLink(list[+lkb.dataset.eplink]);
          const v = ev.target.closest('[data-vlc]');
          if (v) { openVLC(list[+v.dataset.vlc]); addRecent(list[+v.dataset.vlc]); return; }
          const el = ev.target.closest('[data-ep]'); if (!el) return;
          $('#details').classList.add('hidden');
          playFull(list[+el.dataset.ep], list, +el.dataset.ep);
        };
      };
      $$('.season-btn').forEach(b => b.onclick = () => showSeason(b.dataset.season));
      if (seasons.length) showSeason(seasons[0]);
      $('#ep-list').insertAdjacentHTML('afterend', '<div id="d-more"></div>');
      fillMore(item, i);
    }
  } catch (e) { toast('Could not load details: ' + e.message); }
  loader(false);
}
// ---- richer details: backdrop, cast, "More like this" (same category; TMDB key adds better matches + cast photos)
function setBackdrop(i) {
  const b = Array.isArray(i.backdrop_path) ? i.backdrop_path[0] : i.backdrop_path;
  const body = $('#details .modal-body');
  body.style.setProperty('--bd', b ? `url("${String(b).replace(/["\\]/g, '')}")` : 'none');
  body.classList.toggle('has-bd', !!b);
}
function castChips(str, tm) {
  if (tm && tm.length) return `<div class="cast">${tm.map(c => `<div class="castc"><div class="castp">${c.profile_path ? `<img src="https://image.tmdb.org/t/p/w185${esc(c.profile_path)}" onerror="this.remove()">` : ''}</div><b>${esc(c.name)}</b><small>${esc(c.character || '')}</small></div>`).join('')}</div>`;
  const names = String(str || '').split(/\s*,\s*/).filter(Boolean).slice(0, 12);
  return names.length ? `<div class="cast">${names.map(n => `<span class="castn">${esc(n)}</span>`).join('')}</div>` : '';
}
const normTitle = (s) => String(s || '').toLowerCase().replace(/^[a-z0-9]{2,4}\s*[:|]\s*/, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/\b(19|20)\d\d\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function moreRow(list, title) {
  return list.length ? `<h3 class="more-h">${esc(title)}</h3><div class="more-row">${list.map((x, k) => `<div class="more-c" data-more="${k}"><div class="more-p"><img src="${esc(x.logo || '')}" loading="lazy" onerror="this.remove()"></div><span>${esc(x.name)}</span></div>`).join('')}</div>` : '';
}
async function fillMore(item, i) {
  const box = $('#d-more'); if (!box) return;
  const d = S.data[item.kind];
  const local = d ? d.items.filter(x => x.cat === item.cat && x.id !== item.id).sort((a, b) => (+b.rating || 0) - (+a.rating || 0) || (b.added || 0) - (a.added || 0)).slice(0, 16) : [];
  let shown = local, title = 'More from ' + (item.catName || 'this category');
  const render = () => { box.innerHTML = moreRow(shown, title); box.onclick = (e) => { const c = e.target.closest('[data-more]'); if (c) openDetails(shown[+c.dataset.more]); }; };
  render();
  const key = S.settings.tmdbKey; if (!key || !d) return;
  const type = item.kind === 'movie' ? 'movie' : 'tv';
  let id = +(i.tmdb_id || i.tmdb || 0);
  if (!id) {
    const g = guessTitle(item);
    const r = await window.native.tmdb(`search/${type}?query=${encodeURIComponent(g.title)}${g.year ? (type === 'movie' ? '&year=' : '&first_air_date_year=') + g.year : ''}`, key);
    if (r.error) { if (/key/.test(r.error)) toast('TMDB: ' + r.error); return; }
    id = r.data.results && r.data.results[0] && r.data.results[0].id;
  }
  if (!id || $('#d-more') !== box) return;
  const [rec, sim, cred] = await Promise.all([window.native.tmdb(`${type}/${id}/recommendations`, key), window.native.tmdb(`${type}/${id}/similar`, key), window.native.tmdb(`${type}/${id}/credits`, key)]);
  if ($('#d-more') !== box) return;
  if (cred.error && /key/.test(cred.error)) { toast('TMDB: ' + cred.error); return; }
  if (cred.data && cred.data.cast && cred.data.cast.length) $('#d-cast').innerHTML = castChips('', cred.data.cast.slice(0, 12));
  if (!d.byTitle) { d.byTitle = new Map(); for (const x of d.items) { const k = normTitle(x.name); if (k && !d.byTitle.has(k)) d.byTitle.set(k, x); } }
  const found = [], seen = new Set([item.id]);
  for (const r of [...((rec.data && rec.data.results) || []), ...((sim.data && sim.data.results) || [])]) {
    const x = d.byTitle.get(normTitle(r.title || r.name)) || d.byTitle.get(normTitle(r.original_title || r.original_name));
    if (x && !seen.has(x.id)) { seen.add(x.id); found.push(x); }
  }
  if (found.length) { shown = [...found, ...local.filter(x => !seen.has(x.id))].slice(0, 20); title = 'More like this'; render(); }
}
function wireDetailButtons(item) {
  const p = $('#d-play'); if (p) p.onclick = () => { $('#details').classList.add('hidden'); playFull(item); };
  const v = $('#d-vlc'); if (v) v.onclick = () => { openVLC(item); addRecent(item); };
  const dl = $('#d-dl'); if (dl) dl.onclick = () => startDownload(item);
  const lk = $('#d-link'); if (lk) lk.onclick = () => copyLink(item);
  const f = $('#d-fav'); if (f) f.onclick = async () => { await toggleFav(item); f.textContent = S.fav[favKey(item)] ? '★ Remove favorite' : '☆ Add to favorites'; };
}

// ---------------------------------------------------------------- settings
function openSettings() {
  $('#set-ua').innerHTML = '<option value="auto">Auto (try all – recommended)</option>' + UA_LIST.map(u => `<option value="${esc(u)}">${esc(u.length > 60 ? u.slice(0, 60) + '…' : u)}</option>`).join('');
  $('#set-ua').value = S.settings.ua || 'auto';
  $('#set-format').value = S.settings.format;
  $('#set-convert').value = S.settings.convert || 'auto';
  $('#set-vlc').value = S.settings.vlcPath || '';
  $('#set-autovlc').checked = !!S.settings.autoVLC;
  $('#set-hideadult').checked = !!S.settings.hideAdult;
  $('#set-lockadult').checked = S.settings.lockAdult !== false;
  $('#set-epg').value = S.user ? epgUrlFor() : '';
  $('#set-tmdb').value = S.settings.tmdbKey || '';
  $('#set-oskey').value = S.settings.osKey || ''; $('#set-subdlkey').value = S.settings.subdlKey || '';
  updateEpgStatus();
  $('#settings').classList.remove('hidden');
}
$('[data-close="settings"]').onclick = () => $('#settings').classList.add('hidden');
$('#set-save').onclick = async () => {
  S.settings.ua = $('#set-ua').value;
  if (S.settings.ua !== 'auto') window.native.setUA(S.settings.ua);
  S.settings.format = $('#set-format').value;
  S.settings.convert = $('#set-convert').value;
  S.settings.vlcPath = $('#set-vlc').value.trim();
  S.settings.autoVLC = $('#set-autovlc').checked;
  S.settings.hideAdult = $('#set-hideadult').checked;
  S.settings.lockAdult = $('#set-lockadult').checked;
  S.settings.tmdbKey = $('#set-tmdb').value.trim();
  S.settings.osKey = $('#set-oskey').value.trim(); S.settings.subdlKey = $('#set-subdlkey').value.trim();
  await save('settings', S.settings);
  $('#settings').classList.add('hidden'); toast('Settings saved');
};
$('#set-diag').onclick = runDiagnostics;
$('#set-epg-load').onclick = async () => {
  if (!S.user) return;
  S.settings.epgUrls = S.settings.epgUrls || {}; S.settings.epgUrls[S.user.id] = $('#set-epg').value.trim(); save('settings', S.settings);
  $('#set-epg-status').textContent = 'Downloading guide… (can take a minute)';
  await autoLoadEpg(true);
};
$('#set-pin').onclick = async () => {
  if (S.settings.pin && !(await askPin())) return;
  const old = S.settings.pin; S.settings.pin = null;
  if (!(await ensurePinExists())) S.settings.pin = old;
  save('settings', S.settings);
};
$('#set-pin-off').onclick = async () => { if (!S.settings.pin) return toast('No PIN set'); if (!(await askPin())) return; S.settings.pin = null; save('settings', S.settings); toast('PIN removed'); };
$('#set-backup').onclick = async () => { const f = await window.native.backupExport(); toast('💾 Backup saved: ' + f); };
$('#set-restore').onclick = () => $('#restore-file').click();
$('#restore-file').onchange = async () => {
  const f = $('#restore-file').files[0]; $('#restore-file').value = ''; if (!f) return;
  const r = await window.native.backupImport(await f.text());
  if (r !== true) return toast('⚠️ ' + r);
  toast('✅ Backup restored – restarting…'); setTimeout(() => location.reload(), 1200);
};
$('#set-clear-recent').onclick = async () => { S.recent = []; await save(pKey('recent'), []); toast('Cleared'); };

// ---------------------------------------------------------------- diagnostics
async function runDiagnostics() {
  if (!S.user || S.user.type !== 'xtream') return toast('Diagnostics need an Xtream login');
  $('#settings').classList.add('hidden');
  loader(true, 'Diagnostic: loading channel list…');
  try {
    const live = await ensureData('live');
    const movies = await ensureData('movie').catch(() => null);
    const ch = (S.current && S.current.kind === 'live') ? S.current : live.items[0];
    const mv = movies && movies.items[0];
    stopAll();
    const u = S.user, cred = `${encodeURIComponent(u.username)}/${encodeURIComponent(u.password)}`;
    const targets = [
      { label: 'LIVE .ts  ' + ch.name, url: `${u.url}/live/${cred}/${ch.id}.ts` },
      { label: 'LIVE .m3u8 ' + ch.name, url: `${u.url}/live/${cred}/${ch.id}.m3u8` },
      { label: 'LIVE no-ext ' + ch.name, url: `${u.url}/${cred}/${ch.id}` }
    ];
    if (mv) targets.push({ label: 'MOVIE ' + mv.name, url: `${u.url}/movie/${cred}/${mv.id}.${mv.ext || 'mp4'}` });
    const uas = [...new Set(['VLC/3.0.21 LibVLC/3.0.21', 'IPTVSmartersPro', S.user.ua, 'okhttp/4.12.0'].filter(Boolean))];
    window.native.onDiagProgress(m => loader(true, 'Diagnostic running… ' + m + '  (about 1 minute)'));
    const acc = S.account ? { status: S.account.status, exp_date: S.account.exp_date, active_cons: S.account.active_cons, max_connections: S.account.max_connections, allowed_output_formats: S.account.allowed_output_formats } : {};
    const file = await window.native.runDiag({ username: u.username, password: u.password, apiUA: S.user.ua, streamUA: S.user.streamUA, account: acc, targets, uas });
    // Real in-app playback test of the live channel (exactly what the Live TV screen does)
    loader(true, 'Diagnostic: testing real playback (30s)…');
    await new Promise(r => setTimeout(r, 3000));
    PLOG.length = 0;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:320px;height:180px;z-index:200';
    document.body.appendChild(host);
    const statuses = [];
    let failText = '';
    plog('settings convert=' + S.settings.convert + ' directBlocked=' + S.directBlocked + ' format=' + S.settings.format);
    const eng = startEngine('mini', host, ch, (w) => { failText = w; plog('ONFAIL ' + w); }, (st) => { if (st) { statuses.push(st); plog('status ' + st); } });
    let best = 0;
    for (let k = 0; k < 30 && !failText; k++) { await new Promise(r => setTimeout(r, 1000)); best = Math.max(best, eng.video.currentTime || 0); if (best > 8) break; }
    const flog = eng.local ? await window.native.convertLog(eng.local) : null;
    const hide = (x) => String(x).split(u.username).join('<USER>').split(u.password).join('<PASS>');
    const res = ['', '=== REAL PLAYBACK TEST: ' + ch.name + ' (id ' + ch.id + ')',
      'converter speed=' + (flog && flog.prog ? flog.prog.speed : '-') + ' stalls=' + eng.stalls + ' quality=' + (S.settings.quality || 'auto') + (S.autoLow ? ' (auto-low)' : ''),
      'RESULT: ' + (best > 2 ? 'PLAYING OK (' + best.toFixed(1) + 's played)' : 'NOT PLAYING') + ' | stage=' + eng.stage + ' ua=' + (eng.uaList[eng.uaIdx]) + ' url#' + eng.urlIdx,
      'audio bytes=' + eng.video.webkitAudioDecodedByteCount + ' video frames=' + (eng.video.webkitDecodedFrameCount) + ' size=' + eng.video.videoWidth + 'x' + eng.video.videoHeight,
      'fail=' + hide(failText), '--- player log', ...PLOG.map(hide), '--- converter (ffmpeg) log', hide(flog ? (flog.mode + ' ' + flog.ua + '\n' + flog.log) : 'none')];
    destroyEngine('mini'); host.remove();
    await window.native.diagAppend(res.join('\n'));
    loader(false);
    toast('Report saved: ' + file);
  } catch (e) { loader(false); toast('Diagnostic failed: ' + e.message); }
}

// ---------------------------------------------------------------- clock + boot
function tick() { const t = new Date().toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); $('#clock').textContent = t; }
setInterval(tick, 15000); tick();
loadUsers();
