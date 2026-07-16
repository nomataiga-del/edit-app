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
  const local = {
    get(keys, cb) {
      const names = keys == null ? allKeys() : (Array.isArray(keys) ? keys : [keys]);
      const res = {};
      names.forEach((n) => { const v = read(n); if (v !== undefined) res[n] = v; });
      return cb ? cb(res) : Promise.resolve(res);
    },
    set(obj, cb) {
      Object.keys(obj).forEach((n) => localStorage.setItem(NS + n, JSON.stringify(obj[n])));
      const changes = {};
      Object.keys(obj).forEach((n) => (changes[n] = { newValue: obj[n] }));
      listeners.forEach((l) => { try { l(changes, "local"); } catch { /* ignore */ } });
      return cb ? cb() : Promise.resolve();
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach((n) => localStorage.removeItem(NS + n));
      return cb ? cb() : Promise.resolve();
    },
  };
  window.chrome = {
    storage: { local, onChanged: { addListener: (fn) => listeners.push(fn) } },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => {} },
    runtime: { lastError: null, onMessage: { addListener: () => {} }, sendMessage: () => {} },
  };
})();
