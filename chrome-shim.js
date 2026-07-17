// chrome-shim.js — makes the extension's popup code run as a plain web app.
// Backs chrome.storage.local with localStorage (persistent, per-origin) and
// provides no-op tabs/runtime. Must load BEFORE popup.js (which reads chrome).
window.__EDIT_WEB__ = true;
(function () {
  const NS = "edit_ls_";
  const listeners = [];
  const allKeys = () =>
    Object.keys(localStorage).filter((k) => k.startsWith(NS)).map((k) => k.slice(NS.length));
  const read = (name) => {
    const raw = localStorage.getItem(NS + name);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  };
  const fire = (changes) => listeners.forEach((l) => { try { l(changes, "local"); } catch { /* ignore */ } });
  const local = {
    // Supports get(null|string|string[]|{key:default}) like chrome.storage.local.
    get(keys, cb) {
      const res = {};
      if (keys == null) { allKeys().forEach((n) => { const v = read(n); if (v !== undefined) res[n] = v; }); }
      else if (Array.isArray(keys)) { keys.forEach((n) => { const v = read(n); if (v !== undefined) res[n] = v; }); }
      else if (typeof keys === "object") { Object.keys(keys).forEach((n) => { const v = read(n); res[n] = v === undefined ? keys[n] : v; }); }
      else { const v = read(keys); if (v !== undefined) res[keys] = v; }
      return cb ? cb(res) : Promise.resolve(res);
    },
    set(obj, cb) {
      try {
        Object.keys(obj).forEach((n) => localStorage.setItem(NS + n, JSON.stringify(obj[n])));
      } catch (e) {
        // quota exceeded / Safari Private Mode: surface it instead of losing data silently
        try { alert("保存できませんでした（ブラウザの保存容量制限の可能性）。プライベートブラウズを解除するか、不要なアイテムを削除してください。"); } catch { /* ignore */ }
        return cb ? cb() : Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const changes = {};
      Object.keys(obj).forEach((n) => (changes[n] = { newValue: obj[n] }));
      fire(changes);
      return cb ? cb() : Promise.resolve();
    },
    remove(keys, cb) {
      const names = Array.isArray(keys) ? keys : [keys];
      names.forEach((n) => localStorage.removeItem(NS + n));
      const changes = {}; names.forEach((n) => (changes[n] = {}));
      fire(changes);
      return cb ? cb() : Promise.resolve();
    },
  };
  window.chrome = {
    storage: { local, onChanged: { addListener: (fn) => listeners.push(fn) } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => {} },
    runtime: { lastError: null, onMessage: { addListener: () => {} }, sendMessage: () => {} },
  };
})();
