// store.js — shared by background.js and popup.js (ES module)

export const KEY = "edit_items_v1";

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Tracking/referrer params that don't identify the product — dropped so the
// same item shared with e.g. ?igshid=… (common from mobile) dedupes correctly.
const TRACKING_PARAM = /^(utm_|mc_)/i;
const TRACKING_KEYS = new Set(["fbclid", "gclid", "yclid", "dclid", "_gl", "igshid", "spm", "ref_src", "ref_", "cmpid"]);
export function normUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    x.hash = "";
    const drop = [];
    x.searchParams.forEach((_, k) => { if (TRACKING_PARAM.test(k) || TRACKING_KEYS.has(k.toLowerCase())) drop.push(k); });
    drop.forEach((k) => x.searchParams.delete(k));
    if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, ""); // trailing slash (keep root "/")
    return x.toString();
  } catch {
    return u;
  }
}

export function domainFromUrl(url) {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : "https://" + url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function siteNameFromDomain(domain) {
  if (!domain) return "";
  const parts = domain.split(".");
  const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

export function faviconUrl(domain) {
  return domain ? `https://www.google.com/s/2/favicons?domain=${domain}&sz=64` : "";
}

export function curSymbol(code) {
  const m = { JPY: "¥", USD: "$", EUR: "€", GBP: "£", CNY: "¥", KRW: "₩" };
  if (!code) return "¥";
  return m[code.toUpperCase()] || code;
}

export function fmtPrice(p, cur) {
  if (p === "" || p == null || isNaN(Number(p))) return "—";
  return curSymbol(cur) + Number(p).toLocaleString();
}

/* ---------------- currency / FX (手動レート・外部API不使用) ---------------- */
export const KEY_FX = "edit_fx_v1";
// Yen per 1 unit of foreign currency. Approximate defaults — user-editable.
export function defaultFx() {
  return { USD: 155, EUR: 165, GBP: 195, CNY: 22, KRW: 0.11 };
}
export async function getFx() {
  const r = await chrome.storage.local.get(KEY_FX);
  return r[KEY_FX] && typeof r[KEY_FX] === "object" ? { ...defaultFx(), ...r[KEY_FX] } : defaultFx();
}
export async function setFx(fx) { await chrome.storage.local.set({ [KEY_FX]: fx }); }

// Optional extract-proxy (Cloudflare Worker) URL for non-Shopify sites on mobile.
export const KEY_WORKER = "edit_worker_v1";
export async function getWorker() { const r = await chrome.storage.local.get(KEY_WORKER); return (r[KEY_WORKER] || "").trim(); }
export async function setWorker(u) { await chrome.storage.local.set({ [KEY_WORKER]: (u || "").trim() }); }

/* ---------------- backup reminder（データ消失の再発防止） ---------------- */
// The web/PWA build keeps everything in localStorage, which the browser may
// evict (storage pressure / clearing site data) — a periodic JSON export is
// the only real safety net. Track when the user last exported and until when
// the reminder is snoozed. Plain string-keyed entries so they work through
// both chrome.storage.local (拡張) and the localStorage shim (web).
export const KEY_LAST_BACKUP = "edit_last_backup_v1";     // epoch ms of the last export
export const KEY_BACKUP_SNOOZE = "edit_backup_snooze_v1"; // epoch ms until which the reminder is muted
export async function getLastBackupAt() { const r = await chrome.storage.local.get(KEY_LAST_BACKUP); return Number(r[KEY_LAST_BACKUP]) || 0; }
export async function setLastBackupAt(ts = Date.now()) { await chrome.storage.local.set({ [KEY_LAST_BACKUP]: ts }); }
export async function getBackupSnoozeUntil() { const r = await chrome.storage.local.get(KEY_BACKUP_SNOOZE); return Number(r[KEY_BACKUP_SNOOZE]) || 0; }
export async function setBackupSnoozeUntil(ts) { await chrome.storage.local.set({ [KEY_BACKUP_SNOOZE]: ts }); }

export const BACKUP_REMIND_MIN_ITEMS = 10;   // don't nag while there is little to lose
export const BACKUP_REMIND_AFTER_DAYS = 14;  // remind when the last export is older than this
export const BACKUP_SNOOZE_DAYS = 7;         // 「後で」 mutes the banner this long
// Pure decision (unit-testable): remind when there is enough data to lose AND
// the last export is missing/stale AND the user hasn't snoozed. Cloud sync ON
// (自動バックアップ) makes the manual-export nag pointless — never show then.
// Returns { show, days } — days = full days since the last backup (null = never).
export function backupReminderState(itemCount, lastBackupAt, snoozeUntil, now = Date.now(), syncEnabled = false) {
  const last = Number(lastBackupAt) || 0;
  const days = last > 0 ? Math.max(0, Math.floor((now - last) / 86400000)) : null;
  const stale = last <= 0 || now - last >= BACKUP_REMIND_AFTER_DAYS * 86400000;
  const show = !syncEnabled && (Number(itemCount) || 0) >= BACKUP_REMIND_MIN_ITEMS && stale && now >= (Number(snoozeUntil) || 0);
  return { show, days };
}

/* ---------------- cloud sync（自動バックアップ・Cloudflare Worker KV） ---------------- */
// Root fix for the PWA data-loss incident: every data change is pushed
// (debounced) to the user's own Cloudflare Worker /sync endpoint (KV, 無料枠)
// under a secret token; boot pulls & merges. Same token on PC and phone =
// same cloud data ⇒ effective PC⇔スマホ sync. Plain string-keyed entries so
// they work through chrome.storage.local (拡張) AND the localStorage shim (web).
export const KEY_SYNC_ENABLED = "edit_sync_enabled_v1";
export const KEY_SYNC_TOKEN = "edit_sync_token_v1";
export const KEY_SYNC_LAST_PUSH = "edit_sync_last_push_v1"; // epoch ms of the last successful PUT
export const KEY_SYNC_LAST_PULL = "edit_sync_last_pull_v1"; // epoch ms of the last successful GET+merge
// KV free tier allows 1,000 writes/day; a 30s debounce over human editing
// keeps personal use at a few dozen writes a day.
export const SYNC_PUSH_DEBOUNCE_MS = 30000;

export async function getSyncEnabled() { const r = await chrome.storage.local.get(KEY_SYNC_ENABLED); return !!r[KEY_SYNC_ENABLED]; }
export async function setSyncEnabled(v) { await chrome.storage.local.set({ [KEY_SYNC_ENABLED]: !!v }); }
export async function getSyncToken() { const r = await chrome.storage.local.get(KEY_SYNC_TOKEN); return String(r[KEY_SYNC_TOKEN] || "").trim(); }
export async function setSyncToken(t) { await chrome.storage.local.set({ [KEY_SYNC_TOKEN]: String(t || "").trim() }); }
export async function getSyncLastPush() { const r = await chrome.storage.local.get(KEY_SYNC_LAST_PUSH); return Number(r[KEY_SYNC_LAST_PUSH]) || 0; }
export async function setSyncLastPush(ts = Date.now()) { await chrome.storage.local.set({ [KEY_SYNC_LAST_PUSH]: ts }); }
export async function getSyncLastPull() { const r = await chrome.storage.local.get(KEY_SYNC_LAST_PULL); return Number(r[KEY_SYNC_LAST_PULL]) || 0; }
export async function setSyncLastPull(ts = Date.now()) { await chrome.storage.local.set({ [KEY_SYNC_LAST_PULL]: ts }); }

// Token contract — MUST mirror the worker's validSyncToken (worker/worker.js).
export function validSyncToken(t) {
  return /^[A-Za-z0-9_-]{16,}$/.test(String(t || ""));
}

// Unguessable device-pairing token: 22 chars over a 64-symbol URL-safe
// alphabet (= 132 bits) via crypto.getRandomValues. `b & 63` is uniform
// because the alphabet size divides 256.
export function genSyncToken(len = 22) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const buf = new Uint8Array(len);
  globalThis.crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[buf[i] & 63];
  return s;
}

// Build the worker /sync URL (reuses the 取得代行 worker origin).
export function syncEndpoint(workerUrl, token) {
  const base = String(workerUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return base + "/sync?token=" + encodeURIComponent(String(token || "").trim());
}

// Which storage changes warrant a cloud push: the four data stores only.
// Sync bookkeeping keys (last push/pull) must NOT re-trigger a push — that
// would loop: push -> setSyncLastPush -> onChanged -> push …
export function changesNeedPush(changedKeys) {
  const watch = new Set([KEY, KEY_OUTFITS, KEY_BASES, KEY_CATEGORIES]);
  return (changedKeys || []).some((k) => watch.has(k));
}

// After restoring a cloud backup on a device that already had items (e.g. the
// first-run seed), mergeImport keeps the LOCAL id on a URL collision — so any
// cloud base entry pointing at the cloud twin's id would dangle. Re-point each
// base id to the merged item with the same normalized URL; entries that cannot
// be resolved are dropped (a dangling base is invisible in the UI anyway).
export function remapImportedBases(cloudBases, incoming, merged) {
  const urlOfCloudId = new Map();
  (Array.isArray(incoming) ? incoming : []).forEach((r) => {
    if (r && r.id && r.url) urlOfCloudId.set(String(r.id), normUrl(String(r.url)));
  });
  const idByUrl = new Map();
  (Array.isArray(merged) ? merged : []).forEach((i) => { const k = normUrl(i.url); if (k) idByUrl.set(k, i.id); });
  const ids = new Set((Array.isArray(merged) ? merged : []).map((i) => i.id));
  const out = {};
  for (const k of Object.keys(cloudBases || {})) {
    const cid = cloudBases[k];
    if (ids.has(cid)) { out[k] = cid; continue; }
    const u = urlOfCloudId.get(String(cid));
    const nid = u ? idByUrl.get(u) : undefined;
    if (nid) out[k] = nid;
  }
  return out;
}

// Normalize a currency symbol or code to a map key (e.g. "€"->"EUR").
export function currencyCode(cur) {
  const m = { "¥": "JPY", "￥": "JPY", "$": "USD", "€": "EUR", "£": "GBP", "₩": "KRW" };
  const c = String(cur || "").trim();
  if (!c) return "JPY";
  return m[c] || c.toUpperCase();
}

// Convert a price to JPY using the manual FX table. Returns rounded yen, or
// null if not convertible (unknown currency without a rate).
export function toJPY(price, cur, fx) {
  if (price === "" || price == null || isNaN(Number(price))) return null;
  const n = Number(price);
  const code = currencyCode(cur);
  if (code === "JPY") return Math.round(n);
  const rate = fx && fx[code];
  if (!rate) return null;
  return Math.round(n * rate);
}

/* ---------------- category taxonomy (大カテゴリ→中カテゴリ) ---------------- */
// Two-level classification so items can be browsed/compared by genre.
// Edit this list to add or reorder categories; the popup tabs and the edit
// modal both read from it. Majors with an empty `subs` array are leaf tabs.
export const TAXONOMY = [
  { major: "トップス", subs: ["コート", "ジャケット", "シャツ", "Tシャツ", "ノースリーブ", "ニット"] },
  { major: "ボトムス", subs: ["ハーフパンツ", "パンツ", "スカート"] },
  { major: "ワンピース", subs: [] },
  { major: "アクセサリー", subs: [] },
  { major: "靴", subs: [] },
  { major: "その他", subs: [] },
];

export function majorsList() {
  return TAXONOMY.map((t) => t.major);
}

export function subsFor(major) {
  const e = TAXONOMY.find((t) => t.major === major);
  return e ? e.subs : [];
}

// Map legacy single-field `category` values to the new major/sub pair.
export const LEGACY_CATEGORY = {
  "トップス": ["トップス", ""],
  "アウター": ["トップス", "コート"],
  "ニット": ["トップス", "ニット"],
  "シャツ": ["トップス", "シャツ"],
  "Tシャツ": ["トップス", "Tシャツ"],
  "ボトムス": ["ボトムス", ""],
  "パンツ": ["ボトムス", "パンツ"],
  "スカート": ["ボトムス", "スカート"],
  "ワンピース": ["ワンピース", ""],
  "シューズ": ["靴", ""],
  "靴": ["靴", ""],
  "バッグ": ["アクセサリー", ""],
  "アクセサリー": ["アクセサリー", ""],
  "その他": ["その他", ""],
};

// Ensure an item has `major`/`sub`. If `major` is already set it is kept;
// otherwise it is derived from the legacy `category` field.
export function migrateItemCategory(it) {
  const o = { ...it };
  if (!o.major) {
    const map = LEGACY_CATEGORY[o.category || ""];
    o.major = map ? map[0] : "";
    if (!o.sub) o.sub = map ? map[1] : "";
  }
  if (o.sub == null) o.sub = "";
  return o;
}

// ---- user-customizable category config (stored) ----
// The taxonomy above is the DEFAULT. Users can add/remove/rename via the
// popup's category settings; the chosen config is persisted here.
export const KEY_CATEGORIES = "edit_categories_v1";

export function defaultCategories() {
  return TAXONOMY.map((t) => ({ major: t.major, subs: [...t.subs] }));
}
export async function getCategories() {
  const r = await chrome.storage.local.get(KEY_CATEGORIES);
  const v = r[KEY_CATEGORIES];
  return Array.isArray(v) && v.length ? v : defaultCategories();
}
export async function setCategories(list) {
  await chrome.storage.local.set({ [KEY_CATEGORIES]: list });
}
export function majorsOf(cats) { return (cats || []).map((c) => c.major); }
export function subsOf(cats, major) {
  const e = (cats || []).find((c) => c.major === major);
  return e ? e.subs : [];
}

// ---- size measurements & base-garment comparison ----
// Per-major measurement fields (cm). Editable later; kept here as the default.
export const MEASURE_FIELDS = {
  "トップス": ["肩幅", "身幅", "着丈", "袖丈"],
  "ボトムス": ["ウエスト", "股上", "股下", "わたり幅", "裾幅"],
  "ワンピース": ["肩幅", "身幅", "着丈"],
  "靴": ["実寸(cm)"],
};
export function measureFieldsFor(major) { return MEASURE_FIELDS[major] || []; }

// Aliases so a pasted size table matches our field names.
const MEASURE_ALIASES = {
  "肩幅": ["肩幅", "肩巾", "shoulder"],
  "身幅": ["身幅", "身巾", "胸囲", "chest", "bust"],
  "着丈": ["着丈", "総丈", "着 丈", "length"],
  "袖丈": ["袖丈", "裄丈", "裄", "sleeve"],
  "ウエスト": ["ウエスト", "ウェスト", "waist"],
  "股上": ["股上", "rise"],
  "股下": ["股下", "inseam"],
  "わたり幅": ["わたり幅", "わたり", "thigh"],
  "裾幅": ["裾幅", "裾巾", "hem", "leg opening"],
};

// Parse a pasted size table / spec text into { field: cm } for the given
// fields. Grabs the first number after each field label (or alias). Best for a
// single size's spec; for a full table it takes the first row's values.
export function parseMeasures(text, fields) {
  const out = {};
  const t = String(text || "");
  for (const f of (fields || [])) {
    const aliases = MEASURE_ALIASES[f] || [f];
    for (const a of aliases) {
      const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = t.match(new RegExp(esc + "[^0-9]{0,8}([0-9]+(?:\\.[0-9]+)?)\\s*(cm|mm|inch|inches|in|\")?", "i"));
      if (m) { const cm = toCm(m[1] + (m[2] || "")); if (cm != null) { out[f] = String(cm); break; } }
    }
  }
  return out;
}

// Parse a measurement string and return centimetres (number) or null.
// Understands cm (default), mm, and inch (inch/in/"). e.g. "18in" -> 45.7
export function toCm(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase().replace(/[”″]/g, '"');
  if (!s) return null;
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*(mm|cm|inches|inch|in|")?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = m[2] || "cm";
  let cm;
  if (unit === "mm") cm = n / 10;
  else if (unit === "inch" || unit === "inches" || unit === "in" || unit === '"') cm = n * 2.54;
  else cm = n;
  return Math.round(cm * 10) / 10;
}

// Base garment is a reference to an existing item, per category (大/中).
// Key is `major/sub` so e.g. Tシャツ・ジャケット・コート each have their own
// baseline (all use the same トップス measure fields, but different reference garments).
export const KEY_BASES = "edit_bases_v1"; // { "major/sub": itemId }
export function baseKey(major, sub) { return major ? major + "/" + (sub || "") : ""; }
export async function getBases() {
  const r = await chrome.storage.local.get(KEY_BASES);
  return r[KEY_BASES] && typeof r[KEY_BASES] === "object" ? r[KEY_BASES] : {};
}
export async function setBases(b) { await chrome.storage.local.set({ [KEY_BASES]: b }); }

// Drop any base entry pointing at a deleted item. Returns a new object.
export function pruneBaseItem(bases, itemId) {
  const out = {};
  for (const k of Object.keys(bases || {})) if (bases[k] !== itemId) out[k] = bases[k];
  return out;
}

// Compare an item's measures to the base's measures (both cm). Returns
// { field: { base, value, diff } } for every field the base defines.
export function diffVsBase(itemMeasures, baseMeasures) {
  const out = {};
  if (!baseMeasures) return out;
  for (const f of Object.keys(baseMeasures)) {
    const base = Number(baseMeasures[f]);
    if (isNaN(base)) continue;
    const raw = itemMeasures ? itemMeasures[f] : undefined;
    const val = raw === "" || raw == null ? NaN : Number(raw);
    out[f] = { base, value: isNaN(val) ? null : val, diff: isNaN(val) ? null : Math.round((val - base) * 10) / 10 };
  }
  return out;
}

// ---- source classification (軸a: ブランド公式のみで信頼担保) ----
// Known marketplaces / malls / resale — everything else is assumed to be a
// brand's own (official/direct) site. Users can override per item.
export const MARKETPLACE_DOMAINS = [
  "rakuten.co.jp", "amazon.co.jp", "amazon.com", "zozo.jp", "zozotown.com",
  "mercari.com", "shopping.yahoo.co.jp", "paypaymall.yahoo.co.jp", "auctions.yahoo.co.jp",
  "qoo10.jp", "wowma.jp", "buyma.com", "magaseek.com", "locondo.jp", "shoplist.com",
  "fril.jp", "rakuma.rakuten.co.jp", "2ndstreet.jp", "grailed.com", "ebay.com",
  "dena.com", "tabio.com" /* example mall-ish */,
];

// Classify a domain as "mall" or "official" (best-effort heuristic).
export function sourceKind(domain) {
  const d = String(domain || "").replace(/^www\./, "").toLowerCase();
  if (!d) return "official";
  for (const base of MARKETPLACE_DOMAINS) {
    if (d === base || d.endsWith("." + base)) return "mall";
  }
  return "official";
}

// Effective source: user override wins, otherwise auto-classify by domain.
// Returns "official" | "mall" | "other".
export function effectiveSource(item) {
  const s = item && item.source;
  if (s === "official" || s === "mall" || s === "other") return s;
  return sourceKind(item && item.domain);
}

// ---- first-run seed: register a default size base once ----
// Uniqlo AIRism Cotton Crew Neck T (2XL) as the トップス size baseline.
// Measurements are typical published figures — fully editable in the app.
export const KEY_SEEDED = "edit_seeded_v1";
export const SEED_BASE = {
  url: "https://www.uniqlo.com/jp/ja/products/E482522-000/00",
  domain: "uniqlo.com", site: "UNIQLO", brand: "UNIQLO",
  name: "エアリズムコットンクルーネックT（半袖） 2XL",
  price: "", currency: "¥", image: "",
  status: "購入済み", note: "サイズ基準（要確認・編集可）",
  category: "", major: "トップス", sub: "Tシャツ", tags: "基準",
  availability: "", sizes: "2XL",
  measures: { "肩幅": "52", "身幅": "62", "着丈": "77", "袖丈": "24" },
};

// Seed exactly once (flagged). Never seeds over existing data, and never
// re-adds after the user deletes it. Returns true if it seeded.
export async function ensureSeeded() {
  const flag = await chrome.storage.local.get(KEY_SEEDED);
  if (flag[KEY_SEEDED]) return false;
  await chrome.storage.local.set({ [KEY_SEEDED]: true });
  const existing = await getItems();
  if (existing.length) return false;
  const item = { id: uid(), _ts: Date.now(), ...SEED_BASE };
  await chrome.storage.local.set({ [KEY]: [item], [KEY_BASES]: { [baseKey(item.major, item.sub)]: item.id } });
  return true;
}

export async function getItems() {
  const r = await chrome.storage.local.get(KEY);
  return Array.isArray(r[KEY]) ? r[KEY] : [];
}

export async function setItems(items) {
  await chrome.storage.local.set({ [KEY]: items });
}

// Add or refresh by URL. Returns { status: "added" | "updated" }.
export async function addItem(data) {
  const items = await getItems();
  const key = normUrl(data.url);
  const idx = key ? items.findIndex((i) => normUrl(i.url) === key) : -1;
  if (idx >= 0) {
    const merged = { ...items[idx] };
    // price change tracking (軸b): remember the previous price so the UI can
    // show ▼値下げ/▲値上げ since the last capture
    if (data.price && merged.price && data.price !== merged.price) {
      merged.prevPrice = merged.price;
      merged.prevPriceAt = Date.now();
    }
    // refresh extracted fields, keep user-set status/note/category/tags
    for (const f of ["name", "price", "currency", "image", "brand", "site", "domain", "availability", "sizes", "color", "colors"]) {
      if (data[f]) merged[f] = data[f];
    }
    if (data.measuresBySize && Object.keys(data.measuresBySize).length) merged.measuresBySize = data.measuresBySize;
    if (data.availBySize && Object.keys(data.availBySize).length) merged.availBySize = data.availBySize;
    merged._updated = Date.now(); // keep _ts (added time) so re-fetches don't reorder the list
    items[idx] = merged;
    await setItems(items);
    return { status: "updated", id: merged.id };
  }
  const item = {
    id: uid(),
    _ts: Date.now(),
    status: "欲しい",
    note: "",
    category: "",
    major: "",
    sub: "",
    measures: {},
    measuresBySize: {},
    availBySize: {},
    sizePicked: "",
    color: "",
    colors: "",
    source: "",
    tags: "",
    ...data,
  };
  items.unshift(item);
  await setItems(items);
  return { status: "added", id: item.id };
}

/* ---------------- export / import (JSON) ---------------- */

export const EXPORT_VERSION = 1;

// Wrap the current state in a versioned envelope for a portable backup.
// `extras` may carry outfits / bases / categories for a full backup.
export function toExport(items, extras = {}) {
  const env = {
    app: "EDIT",
    kind: "edit-export",
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    count: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items : [],
  };
  if (Array.isArray(extras.outfits)) env.outfits = extras.outfits;
  if (extras.bases && typeof extras.bases === "object") env.bases = extras.bases;
  if (Array.isArray(extras.categories)) env.categories = extras.categories;
  return env;
}

// Coerce an arbitrary parsed object into a clean, well-formed item.
export function normalizeImported(raw) {
  const s = (v) => (v == null ? "" : String(v));
  const domain = raw && raw.domain ? s(raw.domain) : domainFromUrl(s(raw && raw.url));
  const o = {
    id: raw && raw.id ? s(raw.id) : uid(),
    _ts: Number(raw && raw._ts) || Date.now(),
    url: s(raw && raw.url),
    domain,
    site: raw && raw.site ? s(raw.site) : siteNameFromDomain(domain),
    brand: s(raw && raw.brand),
    name: s(raw && raw.name).slice(0, 200),
    price: s(raw && raw.price).replace(/[^\d.]/g, ""),
    currency: s(raw && raw.currency),
    image: s(raw && raw.image),
    note: s(raw && raw.note),
    category: s(raw && raw.category),
    major: s(raw && raw.major),
    sub: s(raw && raw.sub),
    tags: s(raw && raw.tags),
    status: raw && raw.status ? s(raw.status) : "欲しい",
    availability: s(raw && raw.availability),
    sizes: s(raw && raw.sizes),
    measures: sanitizeMeasures(raw && raw.measures),
    measuresBySize: (raw && raw.measuresBySize && typeof raw.measuresBySize === "object") ? raw.measuresBySize : {},
    availBySize: (raw && raw.availBySize && typeof raw.availBySize === "object") ? raw.availBySize : {},
    prevPrice: s(raw && raw.prevPrice).replace(/[^\d.]/g, ""),
    prevPriceAt: Number(raw && raw.prevPriceAt) || 0,
    sizePicked: s(raw && raw.sizePicked),
    color: s(raw && raw.color),
    colors: s(raw && raw.colors),
    source: s(raw && raw.source),
  };
  return migrateItemCategory(o);
}

// Normalize a measures map: coerce every value to cm (numeric string), drop blanks.
export function sanitizeMeasures(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(raw)) {
    const cm = toCm(raw[k]);
    if (cm != null) out[k] = String(cm);
  }
  return out;
}

// Accept either a raw items array or an export envelope; return the array.
export function itemsFromParsed(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.items)) return parsed.items;
  throw new Error("インポート形式が不正です（items 配列が見つかりません）");
}

// Merge imported items into existing, deduping by normalized URL.
// On URL collision the imported record wins but keeps the existing id, so
// re-importing a backup is idempotent. Returns { items, added, updated }.
export function mergeImport(existing, incoming) {
  if (!Array.isArray(incoming)) throw new Error("インポートデータが配列ではありません");
  const byKey = new Map();
  const order = [];
  const put = (item) => {
    const key = normUrl(item.url) || item.id;
    if (byKey.has(key)) { item.id = byKey.get(key).id; byKey.set(key, item); }
    else { byKey.set(key, item); order.push(key); }
  };
  (Array.isArray(existing) ? existing : []).forEach((it) => put({ ...it }));

  let added = 0, updated = 0;
  incoming.forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const item = normalizeImported(raw);
    const key = normUrl(item.url) || item.id;
    if (byKey.has(key)) updated++; else added++;
    put(item);
  });

  const items = order.map((k) => byKey.get(k)).sort((a, b) => (b._ts || 0) - (a._ts || 0));
  return { items, added, updated };
}

// Patch a single item by id (used by the manual stock/price re-check).
// Returns the updated item, or null if not found.
export async function patchItem(id, patch) {
  const items = await getItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  // keep _ts (added time) so edits/re-checks/size-picks don't reorder the list
  items[idx] = { ...items[idx], ...patch, _updated: Date.now() };
  await setItems(items);
  return items[idx];
}

/* ---------------- outfits / コーデ (軸c) ---------------- */

export const KEY_OUTFITS = "edit_outfits_v1";

export async function getOutfits() {
  const r = await chrome.storage.local.get(KEY_OUTFITS);
  return Array.isArray(r[KEY_OUTFITS]) ? r[KEY_OUTFITS] : [];
}

export async function setOutfits(outfits) {
  await chrome.storage.local.set({ [KEY_OUTFITS]: outfits });
}

export function newOutfit(name) {
  return { id: uid(), name: (name || "新しいコーデ").slice(0, 80), itemIds: [], note: "", _ts: Date.now() };
}

// Toggle an item's membership in an outfit. Returns a new outfit object.
export function toggleOutfitItem(outfit, itemId) {
  const has = outfit.itemIds.includes(itemId);
  return {
    ...outfit,
    itemIds: has ? outfit.itemIds.filter((x) => x !== itemId) : [...outfit.itemIds, itemId],
    _ts: Date.now(),
  };
}

// Sum the prices of the items referenced by an outfit (missing ids ignored).
export function outfitTotal(itemIds, items) {
  const set = new Set(itemIds || []);
  return (items || []).filter((i) => set.has(i.id)).reduce((s, i) => s + (Number(i.price) || 0), 0);
}

// Drop a deleted item's id from every outfit. Returns a new outfits array.
export function pruneItemFromOutfits(outfits, itemId) {
  return (outfits || []).map((o) =>
    o.itemIds.includes(itemId) ? { ...o, itemIds: o.itemIds.filter((x) => x !== itemId) } : o
  );
}
