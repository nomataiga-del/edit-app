// popup.js (ES module)
import {
  getItems, setItems, addItem, fmtPrice, faviconUrl, curSymbol,
  siteNameFromDomain, domainFromUrl, uid, normUrl, patchItem,
  toExport, itemsFromParsed, mergeImport,
  getOutfits, setOutfits, newOutfit, toggleOutfitItem, pruneItemFromOutfits,
  migrateItemCategory,
  getCategories, setCategories, defaultCategories, majorsOf, subsOf,
  getBases, setBases, baseKey, pruneBaseItem, measureFieldsFor, toCm, diffVsBase, parseMeasures,
  ensureSeeded, sourceKind, effectiveSource, SEED_BASE,
  getFx, setFx, defaultFx, toJPY, currencyCode,
  getWorker, setWorker,
} from "./store.js";
import { extractProduct, DOMAIN_RULES, shopifyProductJsonUrl, shopifyFromJson, guessCategory } from "./extract.js";

const STATUSES = ["欲しい", "検討中", "購入済み"];
const CURRENCIES = ["JPY", "USD", "EUR", "GBP", "CNY", "KRW"]; // stored as codes (¥ can't distinguish JPY/CNY)
const AVAILABILITIES = [
  { v: "", label: "—（不明）" },
  { v: "instock", label: "在庫あり" },
  { v: "outofstock", label: "在庫なし" },
  { v: "preorder", label: "予約" },
];
const AVAIL = {
  instock: { label: "在庫あり", color: "#3E7D5A" },
  outofstock: { label: "在庫なし", color: "var(--accent)" },
  preorder: { label: "予約", color: "#B7791F" },
};
function availLabel(a) { return AVAIL[a] ? AVAIL[a].label : "—"; }

let items = [];
let outfits = [];
let cats = defaultCategories(); // user-customizable category config
let bases = {};                 // { [major]: itemId } base garment per major
let fx = defaultFx();           // manual FX rates (yen per unit)
let workerUrl = "";             // optional extract-proxy for non-Shopify (mobile)
let viewMode = "items"; // "items" | "outfits"
let query = "", fSite = "すべて", fStatus = "すべて", fMajor = "すべて", fSub = "すべて", sort = "new";
let fOfficialOnly = false; // 軸a: show only brand-official (non-marketplace) items
const SOURCE_LABEL = { official: "公式", mall: "モール", other: "その他" };
const SOURCE_COLOR = { official: "#3E7D5A", mall: "#8E8B84", other: "#8E8B84" };
let compareIds = [];

/* tiny DOM helper */
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const k in props) {
    if (k === "class") e.className = props[k];
    else if (k === "text") e.textContent = props[k];
    else if (k === "html") e.innerHTML = props[k];
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), props[k]);
    else if (k === "style") e.setAttribute("style", props[k]);
    else if (props[k] != null) e.setAttribute(k, props[k]);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
  return e;
}

const app = document.getElementById("app");
let refs = {};

// Non-blocking toast (used for background events like bookmarklet capture).
function toast(msg) {
  let t = document.getElementById("edit-toast");
  if (!t) {
    t = el("div", { id: "edit-toast", style: "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:var(--paper);padding:10px 16px;border-radius:999px;font-size:13px;z-index:9999;box-shadow:0 8px 24px -8px rgba(0,0,0,.5);opacity:0;transition:opacity .2s;max-width:90%;text-align:center;" });
    document.body.append(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.opacity = "0"; }, 2200);
}

function buildShell() {
  app.innerHTML = "";

  // header
  const search = el("input", { placeholder: "名前・ブランド・タグで検索", oninput: (e) => { query = e.target.value; update(); } });
  const menu = el("div", { class: "menu", style: "position:relative;" });
  const menuBtn = el("button", { class: "btn btn-ghost", text: "⋯", style: "padding:7px 11px;", onclick: () => menu.classList.toggle("open") });
  const miStyle = "display:block;width:100%;text-align:left;background:transparent;padding:8px 9px;color:var(--inkSoft);";
  const fileInput = el("input", { type: "file", accept: "application/json,.json", style: "display:none;" });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) importJson(f);
    fileInput.value = ""; // allow re-importing the same file
    menu.classList.remove("open");
  });
  const menuPanel = el("div", { style: "display:none;position:absolute;right:0;top:38px;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:6px;width:190px;max-height:min(72vh,480px);overflow-y:auto;-webkit-overflow-scrolling:touch;box-shadow:0 16px 40px -20px rgba(0,0,0,.4);z-index:40;" }, [
    (!window.__EDIT_WEB__ && chrome.runtime && chrome.runtime.getURL) ? el("button", { class: "btn", style: miStyle, text: "タブで開く（全画面）", onclick: () => { chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?tab=1") }); if (window.close) window.close(); } }) : null,
    !window.__EDIT_WEB__ ? el("button", { class: "btn", style: miStyle, text: "右下ボタンの表示／非表示", onclick: async () => { const r = await chrome.storage.local.get("edit_hidebtn_v1"); const next = !(r && r.edit_hidebtn_v1); await chrome.storage.local.set({ edit_hidebtn_v1: next }); menu.classList.remove("open"); alert(next ? "右下の追加ボタンを非表示にしました（各ページは再読み込みで反映。右クリック「EDITに追加」は使えます）" : "右下の追加ボタンを表示にしました（再読み込みで反映）"); } }) : null,
    el("button", { class: "btn", style: miStyle, text: "カテゴリ設定", onclick: () => { menu.classList.remove("open"); openCategorySettings(); } }),
    el("button", { class: "btn", style: miStyle, text: "為替レート設定", onclick: () => { menu.classList.remove("open"); openFxSettings(); } }),
    el("button", { class: "btn", style: miStyle, text: "取得代行URLを設定", onclick: async () => { menu.classList.remove("open"); const cur = await getWorker(); const v = prompt("取得代行(Cloudflare Worker)のURL\n例: https://edit-extract.xxxx.workers.dev\n（空欄で無効化）", cur || ""); if (v !== null) { await setWorker(v); workerUrl = v.trim(); alert(v.trim() ? "設定しました。非Shopifyサイトも 共有→自動取得 を試します。" : "取得代行を無効化しました。"); } } }),
    window.__EDIT_WEB__ ? el("button", { class: "btn", style: miStyle, text: "ブックマークレット設定", onclick: () => { menu.classList.remove("open"); openBookmarkletHelp(); } }) : null,
    el("div", { style: "height:1px;background:var(--line);margin:5px 3px;" }),
    el("button", { class: "btn", style: miStyle, text: "エクスポート（JSON）", onclick: async () => { await exportJson(); menu.classList.remove("open"); } }),
    el("button", { class: "btn", style: miStyle, text: "インポート（JSON）", onclick: () => fileInput.click() }),
    el("button", { class: "btn", style: miStyle, text: "すべて更新（価格・在庫・実寸）", onclick: async () => { menu.classList.remove("open"); await updateAll(); } }),
    el("button", { class: "btn", style: miStyle, text: "サイズ基準を再登録（UNIQLO）", onclick: async () => { menu.classList.remove("open"); await reseedBase(); } }),
    el("div", { style: "height:1px;background:var(--line);margin:5px 3px;" }),
    el("button", { class: "btn", style: miStyle + "color:var(--stone);font-size:12px;", text: "データ管理（全消去…）", onclick: () => { menu.classList.remove("open"); openDangerZone(); } }),
    fileInput,
  ]);
  const mo = new MutationObserver(() => { menuPanel.style.display = menu.classList.contains("open") ? "block" : "none"; });
  mo.observe(menu, { attributes: true });
  menu.append(menuBtn, menuPanel);

  const hdr = el("div", { class: "hdr" }, [
    el("div", { class: "brand" }, [
      el("span", { class: "wm serif", text: "EDIT" }),
      el("span", { class: "sub", text: "横断クローゼット" }),
    ]),
    el("div", { class: "search" }, [el("span", { class: "ic", text: "⌕" }), search]),
    el("button", { class: "btn btn-ink", text: window.__EDIT_WEB__ ? "＋ 追加" : "＋ このページを追加", onclick: clipCurrent }),
    menu,
  ]);

  // view toggle: items / outfits (軸c)
  const toggle = el("div", { class: "vtoggle", style: "display:inline-flex;gap:4px;background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:3px;" });
  const mkTab = (mode, label) => el("button", {
    class: "btn", "data-mode": mode,
    style: "border:none;border-radius:999px;padding:5px 13px;font-size:12px;cursor:pointer;background:transparent;color:var(--stone);",
    text: label, onclick: () => { viewMode = mode; update(); },
  });
  toggle.append(mkTab("items", "アイテム"), mkTab("bases", "基準"), mkTab("outfits", "コーデ"));
  refs.toggle = toggle;

  // filters
  const chips = el("div", { id: "chips", style: "display:flex;flex-wrap:wrap;gap:6px;align-items:center;" });
  const sortSel = el("select", { onchange: (e) => { sort = e.target.value; update(); } }, [
    el("option", { value: "new", text: "新しい順" }),
    el("option", { value: "priceAsc", text: "価格が安い順" }),
    el("option", { value: "priceDesc", text: "価格が高い順" }),
    el("option", { value: "brand", text: "ブランド名順" }),
  ]);
  refs.sortSel = sortSel;
  const filters = el("div", { class: "filters" }, [toggle, chips, el("span", { class: "spacer" }), sortSel]);

  // category tabs (大カテゴリ / 中カテゴリ) — for genre-based browsing & compare
  const majorTabs = el("div", { class: "cattabs", style: "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:2px;" });
  const subTabs = el("div", { class: "cattabs sub", style: "display:none;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 0 0;margin-top:6px;border-top:1px dashed var(--line);" });
  refs.majorTabs = majorTabs; refs.subTabs = subTabs;

  const meta = el("div", { class: "meta", id: "meta" });
  const scroll = el("div", { class: "scroll" });
  const bar = el("div", { id: "barwrap" });

  app.append(hdr, filters, majorTabs, subTabs, meta, scroll, bar);
  refs = { ...refs, chips, majorTabs, subTabs, meta, scroll, bar };
}

// site / status / search filter, independent of category (used for tab counts)
function matchesBase(i) {
  if (fSite !== "すべて" && i.site !== fSite) return false;
  if (fStatus !== "すべて" && i.status !== fStatus) return false;
  if (fOfficialOnly && effectiveSource(i) !== "official") return false;
  if (query.trim()) {
    const q = query.toLowerCase();
    if (!`${i.name} ${i.brand} ${i.tags} ${i.note}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function visibleItems() {
  let list = items.filter((i) => {
    if (isBase(i)) return false; // size bases live in their own tab, not the wishlist
    if (!matchesBase(i)) return false;
    if (fMajor !== "すべて" && (i.major || "") !== fMajor) return false;
    if (fSub !== "すべて" && (i.sub || "") !== fSub) return false;
    return true;
  });
  list = [...list];
  if (sort === "priceAsc") list.sort((a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity));
  else if (sort === "priceDesc") list.sort((a, b) => (Number(b.price) || -Infinity) - (Number(a.price) || -Infinity));
  else if (sort === "brand") list.sort((a, b) => (a.brand || "").localeCompare(b.brand || "", "ja"));
  else list.sort((a, b) => (b._ts || 0) - (a._ts || 0));
  return list;
}

function renderChips() {
  refs.chips.innerHTML = "";
  const sites = ["すべて", ...Array.from(new Set(items.filter((i) => !isBase(i)).map((i) => i.site).filter(Boolean)))];
  sites.forEach((s) => refs.chips.append(chip(s, fSite === s, () => { fSite = s; update(); })));
  refs.chips.append(el("span", { class: "sep" }));
  ["すべて", ...STATUSES].forEach((s) => refs.chips.append(chip(s, fStatus === s, () => { fStatus = s; update(); }, s === "欲しい")));
  refs.chips.append(el("span", { class: "sep" }));
  refs.chips.append(chip("公式のみ", fOfficialOnly, () => { fOfficialOnly = !fOfficialOnly; update(); }));
}
function chip(label, on, onClick, dot) {
  return el("button", { class: "chip" + (on ? " on" : ""), onclick: onClick }, [
    dot ? el("span", { class: "dot" }) : null, label,
  ]);
}

// 大カテゴリ / 中カテゴリ のタブ（ジャンル別に比較検討するための絞り込み）
function catTab(label, count, on, onClick) {
  return el("button", { class: "chip" + (on ? " on" : ""), onclick: onClick }, [
    label, count != null ? el("span", { style: "opacity:.55;margin-left:5px;font-variant-numeric:tabular-nums;", text: String(count) }) : null,
  ]);
}

function renderCategoryTabs() {
  const base = items.filter((i) => !isBase(i) && matchesBase(i));
  const majorCount = (m) => base.filter((i) => (i.major || "") === m).length;

  refs.majorTabs.innerHTML = "";
  refs.majorTabs.append(catTab("すべて", base.length, fMajor === "すべて", () => { fMajor = "すべて"; fSub = "すべて"; update(); }));
  majorsOf(cats).forEach((m) => {
    const c = majorCount(m);
    refs.majorTabs.append(catTab(m, c, fMajor === m, () => { fMajor = m; fSub = "すべて"; update(); }));
  });
  const uncat = majorCount("");
  if (uncat > 0) refs.majorTabs.append(catTab("未分類", uncat, fMajor === "", () => { fMajor = ""; fSub = "すべて"; update(); }));

  // sub tabs only when a major with defined subs is active
  const subs = fMajor !== "すべて" ? subsOf(cats, fMajor) : [];
  if (fMajor !== "すべて" && (subs.length || base.some((i) => (i.major || "") === fMajor && i.sub))) {
    const inMajor = base.filter((i) => (i.major || "") === fMajor);
    const subCount = (s) => inMajor.filter((i) => (i.sub || "") === s).length;
    refs.subTabs.style.display = "flex";
    refs.subTabs.innerHTML = "";
    refs.subTabs.append(catTab("すべて", inMajor.length, fSub === "すべて", () => { fSub = "すべて"; update(); }));
    subs.forEach((s) => refs.subTabs.append(catTab(s, subCount(s), fSub === s, () => { fSub = s; update(); })));
    const noSub = subCount("");
    if (noSub > 0) refs.subTabs.append(catTab("未設定", noSub, fSub === "", () => { fSub = ""; update(); }));
  } else {
    refs.subTabs.style.display = "none";
    refs.subTabs.innerHTML = "";
  }
}

function tagEl(it) {
  const t = el("span", { class: "tag" }, [el("span", { class: "hole" })]);
  if (it.domain) {
    const img = el("img", { src: faviconUrl(it.domain), alt: "" });
    img.addEventListener("error", () => img.remove());
    t.append(img);
  }
  t.append(el("span", { text: it.site || it.domain || "サイト未設定" }));
  const src = effectiveSource(it);
  t.append(el("span", { text: SOURCE_LABEL[src], title: src === "official" ? "ブランド公式/直販サイト" : src === "mall" ? "モール/マーケットプレイス" : "その他", style: `margin-left:6px;font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;border:1px solid ${SOURCE_COLOR[src]};color:${SOURCE_COLOR[src]};` }));
  return t;
}

// Price element: symbol-formatted price + a ≈¥ conversion for foreign currency.
function priceEl(it, bought) {
  const kids = [el("span", { class: "price serif" + (bought ? " bought" : ""), text: fmtPrice(it.price, it.currency) })];
  const yen = toJPY(it.price, it.currency, fx);
  if (currencyCode(it.currency) !== "JPY" && yen != null) {
    kids.push(el("span", { style: "font-size:11px;color:var(--stone);margin-left:6px;", text: `≈¥${yen.toLocaleString()}` }));
  }
  return el("span", { style: "display:inline-flex;align-items:baseline;" }, kids);
}

function availBadge(a) {
  const m = AVAIL[a];
  if (!m) return null;
  return el("span", { text: m.label, style: `display:inline-block;font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;color:#fff;background:${m.color};` });
}

function thumbInner(it, onImgFail) {
  const a = el("a", { href: it.url || "#", target: "_blank", rel: "noreferrer" });
  if (it.image) {
    const img = el("img", { src: it.image, alt: "", referrerpolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => { a.innerHTML = ""; a.append(el("div", { class: "ph serif", text: (it.brand || it.name || "?").charAt(0) })); onImgFail && onImgFail(); });
    a.append(img);
  } else {
    a.append(el("div", { class: "ph serif", text: (it.brand || it.name || "?").charAt(0) }));
  }
  return a;
}

// ---- base garment & fit comparison helpers (軸b size) ----
// Bases are keyed per category (major/sub) so each of Tシャツ/ジャケット/コート/パンツ…
// has its own reference garment; an item compares only against its own category's base.
function isBase(it) { return !!it.major && bases[baseKey(it.major, it.sub)] === it.id; }
function baseItemFor(it) { const id = it && it.major ? bases[baseKey(it.major, it.sub)] : null; return id ? items.find((i) => i.id === id) : null; }
async function toggleBase(it) {
  if (!it.major) { alert("先に大カテゴリを設定してください（編集から）。"); return; }
  if (!measureFieldsFor(it.major).length) { alert(`「${it.major}」は実寸比較の対象外です。`); return; }
  const k = baseKey(it.major, it.sub);
  const next = { ...bases };
  if (next[k] === it.id) { delete next[k]; toast("基準を解除しました"); }
  else { next[k] = it.id; toast(`「${[it.major, it.sub].filter(Boolean).join(" / ")}」の基準にしました（「基準」タブへ）`); }
  bases = next; await setBases(bases); // storage change -> reload
}
// Human label for a base key ("トップス/Tシャツ" -> "トップス / Tシャツ").
function baseKeyLabel(k) { return String(k || "").split("/").filter(Boolean).join(" / "); }

// The measurements in effect for an item: the picked size's row from an
// auto-extracted size table, else manual measures, else the largest table row.
function effectiveMeasures(it) {
  const by = it.measuresBySize || {};
  if (it.sizePicked && by[it.sizePicked]) return by[it.sizePicked];
  if (it.measures && Object.keys(it.measures).length) return it.measures;
  const ks = Object.keys(by);
  return ks.length ? by[ks[ks.length - 1]] : {};
}

// A compact measurements line: shows each field's actual cm value, and — when
// a base garment is set for this major (and this isn't the base) — the ±diff.
function measuresLine(it) {
  if (!it.major) return null;
  const em = effectiveMeasures(it);
  const fields = measureFieldsFor(it.major).filter((f) => em[f]);
  if (!fields.length) return null;
  const b = baseItemFor(it);
  const useDiff = b && b.id !== it.id;
  const d = useDiff ? diffVsBase(em, effectiveMeasures(b)) : {};
  const wrap = el("div", { style: "display:flex;flex-wrap:wrap;gap:3px 9px;margin-top:5px;font-size:11.5px;font-variant-numeric:tabular-nums;" });
  fields.forEach((f) => {
    const val = em[f];
    let color = "var(--stone)", text = `${f} ${val}cm`;
    if (useDiff && d[f] && d[f].diff != null) {
      const diff = d[f].diff;
      const sign = diff > 0 ? `+${diff}` : diff < 0 ? String(diff) : "±0";
      color = diff > 0 ? "#3E7D5A" : diff < 0 ? "var(--accent)" : "var(--stone)";
      text = `${f} ${val}cm（${sign}）`;
    }
    wrap.append(el("span", { style: `color:${color};`, text }));
  });
  if (useDiff) wrap.append(el("span", { style: "color:var(--stone);opacity:.7;", text: `基準:${b.brand || b.name || "—"}` }));
  return wrap;
}

// A per-size selector shown when an item carries an auto-extracted size table,
// so the ±diff reflects the size you'd actually buy.
function sizePicker(it) {
  const by = it.measuresBySize || {};
  const ks = Object.keys(by);
  if (ks.length < 2) return null;
  const sel = el("select", { style: "font-size:11px;padding:2px 6px;border-radius:7px;border:1px solid var(--line);margin-top:4px;max-width:100%;", onchange: (e) => patchItem(it.id, { sizePicked: e.target.value }) },
    ks.map((k) => el("option", { value: k, text: `実寸サイズ: ${k}` })));
  sel.value = it.sizePicked || ks[ks.length - 1];
  return sel;
}

// When a size base is set for this major but the item has no 実寸 captured
// (e.g. an opaque numeric size on a site with no size chart), offer a quick way
// to add it manually so the ±comparison can work.
function measuresHint(it) {
  if (!it.major || !measureFieldsFor(it.major).length) return null;
  const b = baseItemFor(it);
  if (!b || b.id === it.id) return null; // only when there's a base to compare against
  const em = effectiveMeasures(it);
  if (measureFieldsFor(it.major).some((f) => em[f])) return null; // already has measures
  return el("button", {
    style: "margin-top:5px;font-size:11px;color:var(--accent);background:none;border:none;padding:0;cursor:pointer;text-align:left;",
    text: "＋ 実寸を追加して比較",
    onclick: () => openEdit(it),
  });
}

function card(it) {
  const want = it.status === "欲しい", bought = it.status === "購入済み";
  const thumb = el("div", { class: "thumb", style: "position:relative;" });
  thumb.append(thumbInner(it));
  thumb.append(el("button", { class: "heart", title: "欲しい/検討中を切替", html: want ? "&#9829;" : "&#9825;", style: `color:${want ? "var(--accent)" : "var(--stone)"};`, onclick: () => toggleStatus(it.id) }));
  thumb.append(el("div", { class: "acts" }, [
    el("button", { class: "iconbtn", title: "在庫・価格を再確認", text: "⟳", onclick: (e) => recheck(it, e.currentTarget) }),
    el("button", { class: "iconbtn", title: isBase(it) ? "基準を解除" : "この服を基準にする", text: "📏", onclick: () => toggleBase(it) }),
    el("button", { class: "iconbtn", title: "コーデに追加", text: "＋", onclick: () => openOutfitPicker(it) }),
    el("button", { class: "iconbtn", title: "編集", text: "✎", onclick: () => openEdit(it) }),
    el("button", { class: "iconbtn", title: "削除", text: "🗑", onclick: () => { if (confirm("このアイテムを削除しますか？" + (isBase(it) ? "\n（サイズ基準も解除されます）" : ""))) removeItem(it.id); } }),
  ]));
  // top-left stack of state badges (kept clear of the heart TR and acts bottom)
  const tl = el("div", { style: "position:absolute;top:8px;left:8px;z-index:3;display:flex;flex-direction:column;gap:4px;align-items:flex-start;max-width:calc(100% - 46px);" });
  const ab = availBadge(it.availability);
  if (ab) tl.append(ab);
  if (bought) tl.append(el("span", { text: "購入済み", style: "font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--ink);color:var(--paper);" }));
  if (isBase(it)) tl.append(el("span", { text: "基準", style: "font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:#3E5A57;color:#fff;" }));
  if (tl.children.length) thumb.append(tl);

  const body = el("div", { class: "body" }, [
    tagEl(it),
    it.brand ? el("div", { class: "brand-l", text: it.brand }) : null,
    el("a", { class: "name", href: it.url || "#", target: "_blank", rel: "noreferrer", text: it.name || "（名称なし）" }),
    it.color ? el("div", { style: "font-size:12px;color:var(--stone);margin-top:2px;", text: `カラー ${it.color}` }) : null,
    it.sizes ? el("div", { style: "font-size:12px;color:var(--stone);margin-top:2px;", text: `サイズ ${it.sizes}` }) : null,
    sizePicker(it),
    measuresLine(it),
    measuresHint(it),
    it.note ? el("div", { class: "note", text: it.note }) : null,
    el("div", { class: "foot" }, [
      priceEl(it, bought),
      el("label", { class: "cmp" }, [
        (() => { const c = el("input", { type: "checkbox" }); c.checked = compareIds.includes(it.id); c.addEventListener("change", () => toggleCompare(it.id)); return c; })(),
        "比較",
      ]),
    ]),
  ]);
  return el("div", { class: "card" }, [thumb, body]);
}

function renderGrid() {
  refs.scroll.innerHTML = "";
  if (!items.some((i) => !isBase(i))) { // no non-base items yet
    refs.scroll.append(el("div", { class: "empty" }, [
      el("div", { class: "t serif", text: "まだ何も掛かっていません" }),
      el("div", { text: window.__EDIT_WEB__
        ? "スマホでは、⋯→「ブックマークレット設定」で取り込み用ボタンを登録 → 商品ページでそれをタップすると追加されます。上の「＋ 追加」から手入力もできます。"
        : "気になった商品ページで、右下の「♥ EDITに追加」を押すか、上の「＋ このページを追加」で登録できます。名前・価格・画像・サイト名は自動で読み取ります。",
        style: "max-width:440px;margin:0 auto;line-height:1.7;font-size:13px;" }),
    ]));
    return;
  }
  const list = visibleItems();
  if (list.length === 0) {
    const g = el("div", { class: "grid" });
    g.append(el("div", { style: "color:var(--stone);padding:30px 0;text-align:center;grid-column:1/-1;", text: "条件に合うアイテムがありません。" }));
    refs.scroll.append(g);
    return;
  }

  // Grouping: by 大カテゴリ on the "すべて" tab; by 中カテゴリ when a major
  // (with subs) is selected and no specific sub is chosen. Otherwise flat.
  let groupBy = null, order = null, emptyLabel = null;
  if (fMajor === "すべて") {
    groupBy = (i) => i.major || ""; order = majorsOf(cats); emptyLabel = "未分類";
  } else if (fSub === "すべて" && (subsOf(cats, fMajor).length || list.some((i) => i.sub))) {
    groupBy = (i) => i.sub || ""; order = subsOf(cats, fMajor); emptyLabel = "未設定";
  }

  if (!groupBy) {
    const g = el("div", { class: "grid" });
    list.forEach((it) => g.append(card(it)));
    refs.scroll.append(g);
    return;
  }

  // build ordered, non-empty groups
  const buckets = new Map();
  list.forEach((it) => { const k = groupBy(it); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(it); });
  const keys = [...order.filter((k) => buckets.has(k)), ...[...buckets.keys()].filter((k) => k && !order.includes(k))];
  if (buckets.has("")) keys.push(""); // uncategorized last

  keys.forEach((k) => {
    const bucket = buckets.get(k);
    if (!bucket || !bucket.length) return;
    refs.scroll.append(el("div", { class: "grouphead", style: "display:flex;align-items:baseline;gap:8px;margin:14px 2px 8px;" }, [
      el("span", { class: "serif", style: "font-size:15px;font-weight:600;", text: k || emptyLabel }),
      el("span", { style: "font-size:12px;color:var(--stone);", text: `${bucket.length} 点` }),
    ]));
    const g = el("div", { class: "grid" });
    bucket.forEach((it) => g.append(card(it)));
    refs.scroll.append(g);
  });
}

function renderMeta() {
  const totalWant = items.filter((i) => i.status === "欲しい").reduce((s, i) => s + (toJPY(i.price, i.currency, fx) || 0), 0);
  refs.meta.innerHTML = "";
  refs.meta.append(
    el("span", { text: `${visibleItems().length} 件表示` }),
    el("span", {}, ["「欲しい」合計 ", el("b", { text: "¥" + totalWant.toLocaleString() })]),
  );
}

function renderBar() {
  refs.bar.innerHTML = "";
  if (compareIds.length === 0) return;
  refs.bar.append(el("div", { class: "bar" }, [
    el("span", { text: `${compareIds.length} 件選択中${compareIds.length < 2 ? "（あと1件で比較）" : ""}` }),
    el("div", { class: "spacer" }),
    el("button", { class: "btn btn-ghost", text: "クリア", onclick: () => { compareIds = []; update(); } }),
    (() => { const b = el("button", { class: "btn btn-light", text: "比較する", onclick: openCompare }); b.disabled = compareIds.length < 2; return b; })(),
  ]));
}

/* ---------- outfits view (軸c) ---------- */
function itemById(id) { return items.find((i) => i.id === id) || null; }

function outfitCard(o) {
  const members = o.itemIds.map(itemById).filter(Boolean);
  // Sum in yen via the FX table — members can be in different currencies.
  const totalJpy = members.reduce((s, it) => s + (toJPY(it.price, it.currency, fx) || 0), 0);
  const anyForeign = members.some((it) => it.price && currencyCode(it.currency) !== "JPY");
  const anyUnknown = members.some((it) => it.price && toJPY(it.price, it.currency, fx) == null);

  const thumbs = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;" });
  if (members.length === 0) {
    thumbs.append(el("div", { style: "color:var(--stone);font-size:12px;padding:6px 0;", text: "アイテム未登録。各アイテムの「＋」から追加できます。" }));
  } else {
    members.forEach((it) => {
      const cell = el("div", { style: "position:relative;width:52px;height:64px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--paper);", title: it.name || "" });
      const a = el("a", { href: it.url || "#", target: "_blank", rel: "noreferrer", style: "display:block;width:100%;height:100%;" });
      if (it.image) {
        const img = el("img", { src: it.image, alt: "", referrerpolicy: "no-referrer", style: "width:100%;height:100%;object-fit:cover;" });
        img.addEventListener("error", () => { a.innerHTML = ""; a.append(el("div", { class: "serif", style: "display:flex;align-items:center;justify-content:center;height:100%;color:var(--stone);", text: (it.brand || it.name || "?").charAt(0) })); });
        a.append(img);
      } else {
        a.append(el("div", { class: "serif", style: "display:flex;align-items:center;justify-content:center;height:100%;color:var(--stone);", text: (it.brand || it.name || "?").charAt(0) }));
      }
      cell.append(a);
      cell.append(el("button", { title: "コーデから外す", text: "×", style: "position:absolute;top:2px;right:2px;width:16px;height:16px;line-height:14px;border:none;border-radius:50%;background:rgba(27,26,24,.7);color:#fff;font-size:11px;cursor:pointer;padding:0;", onclick: () => toggleItemOutfit(o.id, it.id) }));
      thumbs.append(cell);
    });
  }

  return el("div", { class: "card", style: "padding:12px;" }, [
    el("div", { style: "display:flex;align-items:center;gap:8px;" }, [
      el("div", { class: "serif", style: "font-size:16px;font-weight:600;flex:1;cursor:text;", title: "クリックで名前を変更", text: o.name, onclick: () => renameOutfit(o) }),
      el("button", { class: "iconbtn", title: "コーデを削除", text: "🗑", onclick: () => deleteOutfit(o.id) }),
    ]),
    thumbs,
    el("div", { style: "display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding-top:8px;" }, [
      el("span", { style: "font-size:12px;color:var(--stone);", text: `${members.length} 点` }),
      el("span", { class: "price serif", title: anyForeign ? "為替換算した合計（円）" : "", text: (anyForeign ? "≈" : "") + fmtPrice(String(totalJpy), "JPY") + (anyUnknown ? " +未換算" : "") }),
    ]),
  ]);
}

function renderOutfits() {
  refs.scroll.innerHTML = "";
  const wrap = el("div", {});
  wrap.append(el("button", { class: "btn btn-ink", style: "margin-bottom:12px;", text: "＋ コーデを作成", onclick: createOutfit }));
  if (outfits.length === 0) {
    wrap.append(el("div", { class: "empty" }, [
      el("div", { class: "t serif", text: "コーデがありません" }),
      el("div", { style: "max-width:430px;margin:0 auto;line-height:1.7;font-size:13px;", text: "「＋ コーデを作成」で作り、各アイテムの「＋」から複数点をまとめられます。合計金額も出ます。" }),
    ]));
  } else {
    const g = el("div", { class: "grid" });
    outfits.slice().sort((a, b) => (b._ts || 0) - (a._ts || 0)).forEach((o) => g.append(outfitCard(o)));
    wrap.append(g);
  }
  refs.scroll.append(wrap);
}

function renderOutfitMeta() {
  refs.meta.innerHTML = "";
  refs.meta.append(el("span", { text: `${outfits.length} コーデ` }));
}

/* ---------- outfit actions ---------- */
async function createOutfit() {
  const name = prompt("コーデ名を入力してください", "新しいコーデ");
  if (name === null) return;
  outfits = [newOutfit(name), ...outfits];
  await setOutfits(outfits);
}
async function renameOutfit(o) {
  const name = prompt("コーデ名", o.name);
  if (name === null) return;
  outfits = outfits.map((x) => x.id === o.id ? { ...x, name: (name || x.name).slice(0, 80), _ts: Date.now() } : x);
  await setOutfits(outfits);
}
async function deleteOutfit(id) {
  if (!confirm("このコーデを削除しますか？（アイテム自体は消えません）")) return;
  outfits = outfits.filter((o) => o.id !== id);
  await setOutfits(outfits);
}
async function toggleItemOutfit(outfitId, itemId) {
  outfits = outfits.map((o) => o.id === outfitId ? toggleOutfitItem(o, itemId) : o);
  await setOutfits(outfits);
}

function openOutfitPicker(it) {
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const listWrap = el("div", { style: "max-height:220px;overflow:auto;margin:8px 0;" });
  const renderList = () => {
    listWrap.innerHTML = "";
    if (outfits.length === 0) { listWrap.append(el("div", { style: "color:var(--stone);font-size:13px;padding:8px 0;", text: "まだコーデがありません。下で作成できます。" })); return; }
    outfits.forEach((o) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = o.itemIds.includes(it.id);
      cb.addEventListener("change", async () => { await toggleItemOutfit(o.id, it.id); });
      listWrap.append(el("label", { style: "display:flex;gap:9px;align-items:center;padding:7px 4px;cursor:pointer;" }, [cb, `${o.name}（${o.itemIds.length}）`]));
    });
  };
  renderList();
  const nameNew = el("input", { placeholder: "新しいコーデ名" });
  const modal = el("div", { class: "modal sm", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "コーデに追加" }),
    listWrap,
    el("div", { class: "fld" }, [el("label", { text: "新規コーデを作って追加" }), el("div", { style: "display:flex;gap:6px;" }, [
      nameNew,
      el("button", { class: "btn btn-ink", text: "作成", onclick: async () => {
        const o = toggleOutfitItem(newOutfit(nameNew.value), it.id);
        outfits = [o, ...outfits];
        await setOutfits(outfits);
        nameNew.value = "";
      } }),
    ])]),
    el("div", { class: "modal-foot" }, [el("button", { class: "btn btn-ghost", text: "閉じる", onclick: () => overlay.remove() })]),
  ]);
  overlay.append(modal); document.body.append(overlay);
  // keep the picker's checkboxes/list live as storage changes
  overlay._refresh = renderList;
}

/* ---------- bases view (サイズ基準・カテゴリ別) ---------- */
function renderBasesMeta() {
  const n = Object.keys(bases).filter((k) => items.some((i) => i.id === bases[k])).length;
  refs.meta.innerHTML = "";
  refs.meta.append(el("span", { text: `${n} 件の基準` }));
}
function baseCard(it, key) {
  const thumb = el("div", { class: "thumb", style: "position:relative;" });
  thumb.append(thumbInner(it));
  thumb.append(el("div", { style: "position:absolute;top:8px;left:8px;z-index:3;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:#3E5A57;color:#fff;", text: "基準" }));
  const body = el("div", { class: "body" }, [
    el("div", { style: "font-size:11px;font-weight:600;color:#3E5A57;margin-bottom:2px;", text: (baseKeyLabel(key) || "未分類") + " の基準" }),
    it.brand ? el("div", { class: "brand-l", text: it.brand }) : null,
    el("a", { class: "name", href: it.url || "#", target: "_blank", rel: "noreferrer", text: it.name || "（名称なし）" }),
    it.sizes ? el("div", { style: "font-size:12px;color:var(--stone);margin-top:2px;", text: `サイズ ${it.sizes}` }) : null,
    sizePicker(it),
    measuresLine(it), // its own 実寸 (no ±, since it is the base)
    el("div", { class: "foot", style: "display:flex;gap:8px;align-items:center;" }, [
      el("button", { class: "iconbtn", title: "編集", text: "✎", onclick: () => openEdit(it) }),
      el("button", { class: "btn btn-ghost", style: "font-size:12px;color:var(--accent);", text: "基準を解除", onclick: async () => { const next = { ...bases }; delete next[key]; bases = next; toast("基準を解除しました"); await setBases(bases); } }),
    ]),
  ]);
  return el("div", { class: "card" }, [thumb, body]);
}
function renderBases() {
  refs.scroll.innerHTML = "";
  refs.scroll.append(el("div", { style: "font-size:12.5px;color:var(--stone);line-height:1.7;margin:2px 2px 12px;" }, [
    "サイズの基準にする服です。", el("b", { text: "Tシャツ・ジャケット・コート・パンツなどカテゴリごとに1つずつ" }),
    "設定でき、同じカテゴリのアイテムの実寸がこの基準と ±cm で比較されます。", el("br"),
    "基準にするには、アイテムのカードで 📏 を押します。",
  ]));
  const entries = Object.keys(bases).map((k) => ({ key: k, it: items.find((i) => i.id === bases[k]) })).filter((e) => e.it);
  entries.sort((a, b) => baseKeyLabel(a.key).localeCompare(baseKeyLabel(b.key), "ja"));
  if (!entries.length) {
    refs.scroll.append(el("div", { class: "empty" }, [
      el("div", { class: "t serif", text: "基準は未設定です" }),
      el("div", { text: "アイテムのカードで 📏 を押すと、そのカテゴリ（Tシャツ / ジャケット / パンツ…）の基準になります。", style: "max-width:440px;margin:0 auto;line-height:1.7;font-size:13px;" }),
    ]));
    return;
  }
  const g = el("div", { class: "grid" });
  entries.forEach(({ key, it }) => g.append(baseCard(it, key)));
  refs.scroll.append(g);
}

/* ---------- update ---------- */
function update() {
  // toggle active styling
  if (refs.toggle) {
    [...refs.toggle.children].forEach((b) => {
      const on = b.getAttribute("data-mode") === viewMode;
      b.style.background = on ? "var(--card)" : "transparent";
      b.style.color = on ? "var(--ink)" : "var(--stone)";
      b.style.boxShadow = on ? "0 1px 3px -1px rgba(0,0,0,.3)" : "none";
    });
  }
  const isOutfits = viewMode === "outfits";
  const isBasesView = viewMode === "bases";
  const special = isOutfits || isBasesView;
  if (refs.sortSel) refs.sortSel.style.display = special ? "none" : "";
  if (refs.majorTabs) refs.majorTabs.style.display = special ? "none" : "flex";
  if (special && refs.subTabs) refs.subTabs.style.display = "none";

  if (isOutfits) {
    refs.chips.innerHTML = "";
    renderOutfitMeta();
    renderOutfits();
    refs.bar.innerHTML = "";
  } else if (isBasesView) {
    refs.chips.innerHTML = "";
    renderBasesMeta();
    renderBases();
    refs.bar.innerHTML = "";
  } else {
    renderChips();
    renderCategoryTabs();
    renderMeta();
    renderGrid();
    renderBar();
    if (refs.sortSel) refs.sortSel.value = sort;
  }
  // refresh any open outfit picker
  const op = document.querySelector(".overlay");
  if (op && op._refresh) op._refresh();
}

/* ---------- actions ---------- */
async function reload() {
  await ensureSeeded();
  const raw = await getItems();
  items = raw.map(migrateItemCategory).map((it) => {
    if (it.major) return it; // already classified
    const g = guessCategory([it.name, it.sub, it.brand].join(" ")); // auto-classify existing 未分類 by name
    return g.major ? { ...it, major: g.major, sub: it.sub || g.sub } : it;
  });
  outfits = await getOutfits();
  cats = await getCategories();
  bases = await getBases();
  // migrate legacy major-only base keys ("トップス") -> "major/sub" ("トップス/Tシャツ")
  let basesChanged = false;
  for (const k of Object.keys(bases)) {
    if (k.includes("/")) continue;
    const it = items.find((i) => i.id === bases[k]);
    const nk = baseKey(k, it ? it.sub : "");
    if (nk && nk !== k) { if (!(nk in bases)) bases[nk] = bases[k]; delete bases[k]; basesChanged = true; }
  }
  if (basesChanged) await setBases(bases);
  fx = await getFx();
  workerUrl = await getWorker();
  // persist one-time category migration (idempotent on subsequent loads)
  const changed = items.some((it, i) => it.major !== raw[i].major || it.sub !== raw[i].sub);
  if (changed) await setItems(items);
  update();
}

async function toggleStatus(id) {
  items = items.map((i) => i.id === id ? { ...i, status: i.status === "欲しい" ? "検討中" : "欲しい" } : i);
  await setItems(items); update();
}
async function removeItem(id) {
  items = items.filter((i) => i.id !== id);
  compareIds = compareIds.filter((x) => x !== id);
  const pruned = pruneItemFromOutfits(outfits, id);
  await setItems(items);
  if (JSON.stringify(pruned) !== JSON.stringify(outfits)) { outfits = pruned; await setOutfits(outfits); }
  const prunedBases = pruneBaseItem(bases, id);
  if (JSON.stringify(prunedBases) !== JSON.stringify(bases)) { bases = prunedBases; await setBases(bases); }
  update();
}
function toggleCompare(id) {
  if (compareIds.includes(id)) compareIds = compareIds.filter((x) => x !== id);
  else if (compareIds.length < 4) compareIds.push(id);
  update();
}

/* ---------- stock / price re-check (軸b) ---------- */
async function recheck(it, btn) {
  if (!it.url) { alert("この項目にはURLがありません。編集からURLを設定してください。"); return; }
  const prevText = btn ? btn.textContent : "";
  if (btn) { btn.textContent = "…"; btn.disabled = true; }
  try {
    const patch = {};
    // Shopify stores: pull clean data from <product>.js first (no og/JSON-LD there)
    const jsUrl = shopifyProductJsonUrl(it.url);
    if (jsUrl) {
      try {
        const r = await fetch(jsUrl, { credentials: "omit", signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const s = shopifyFromJson(await r.json(), { currency: it.currency, href: it.url });
          if (s) for (const k of ["price", "availability", "image", "name", "brand", "sizes"]) if (s[k]) patch[k] = s[k];
        }
      } catch { /* fall through to generic */ }
    }
    // Generic fallback (static HTML) when Shopify didn't yield fields
    if (!patch.image || !patch.price) {
      const res = await fetch(it.url, { credentials: "omit", signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const loc = { href: it.url, hostname: new URL(it.url).hostname };
      const fresh = extractProduct(doc, loc, DOMAIN_RULES);
      for (const k of ["price", "currency", "availability", "sizes", "image", "name", "brand"]) {
        if (fresh[k] && !patch[k]) patch[k] = fresh[k];
      }
      if (fresh.measuresBySize && Object.keys(fresh.measuresBySize).length) patch.measuresBySize = fresh.measuresBySize;
    }
    if (!Object.keys(patch).length) {
      alert("このページからは自動取得できませんでした（アクセス制限のあるサイトの可能性）。\n商品ページを開いて右下の ♥ から取り込み直すと確実です。");
      return;
    }
    const msgs = [];
    if (patch.price && patch.price !== it.price) msgs.push(`価格：${fmtPrice(it.price, it.currency)} → ${fmtPrice(patch.price, patch.currency || it.currency)}`);
    if (patch.availability && patch.availability !== it.availability) msgs.push(`在庫：${availLabel(it.availability)} → ${availLabel(patch.availability)}`);
    if (patch.measuresBySize) msgs.push("実寸表を取得しました");
    await patchItem(it.id, patch); // triggers storage change -> reload
    alert(msgs.length ? "再取得しました：\n" + msgs.join("\n") : "最新の内容に更新しました。");
  } catch (e) {
    alert("再取得に失敗しました。商品ページを開いて右下の ♥ から取り込み直してください。\n" + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) { btn.textContent = prevText || "⟳"; btn.disabled = false; }
  }
}

/* ---------- export / import ---------- */
async function exportJson() {
  const data = toExport(await getItems(), { outfits: await getOutfits(), bases: await getBases(), categories: await getCategories() });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const a = el("a", { href: url, download: `edit-backup-${stamp}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      const incoming = itemsFromParsed(parsed);
      const { items: merged, added, updated } = mergeImport(await getItems(), incoming);
      await setItems(merged);
      // full-backup restore: outfits / bases / categories when present
      const extras = [];
      if (parsed && Array.isArray(parsed.outfits)) { await setOutfits(parsed.outfits); extras.push("コーデ"); }
      if (parsed && parsed.bases && typeof parsed.bases === "object") { await setBases(parsed.bases); extras.push("基準"); }
      if (parsed && Array.isArray(parsed.categories) && parsed.categories.length) { await setCategories(parsed.categories); extras.push("カテゴリ設定"); }
      alert(`インポート完了：追加 ${added} 件 / 更新 ${updated} 件` + (extras.length ? `\n復元：${extras.join("・")}` : ""));
    } catch (e) {
      alert("インポートに失敗しました：" + (e && e.message ? e.message : String(e)));
    }
  };
  reader.onerror = () => alert("ファイルの読み込みに失敗しました。");
  reader.readAsText(file);
}

function clipCurrent() {
  if (window.__EDIT_WEB__) { openWebAdd(); return; }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "DO_CLIP" }, () => {
      if (chrome.runtime.lastError) alert("このページは追加できません（拡張が動作しないページです）。商品ページで再度お試しください。");
    });
  });
}

/* ---------- web (PWA) capture: manual add + bookmarklet hash ---------- */
// On the phone there's no floating button; items arrive either via the
// bookmarklet (a #add=<json> hash this handles on boot) or manual entry.
// Guess a shop's currency from its domain TLD (Shopify .js omits currency).
function guessCurrencyByTld(host) {
  host = (host || "").toLowerCase();
  if (/\.jp$/.test(host)) return "JPY";
  if (/\.(co\.uk|uk)$/.test(host)) return "GBP";
  if (/\.(fr|de|it|es|nl|be|at|ie|fi|pt|se|dk|eu)$/.test(host)) return "EUR";
  if (/\.(kr|co\.kr)$/.test(host)) return "KRW";
  if (/\.(cn|com\.cn)$/.test(host)) return "CNY";
  return ""; // unknown (e.g. .com) — user picks; item opens for review
}

// Capture from a URL on the web/PWA. When an extract-proxy (worker) is set it is
// preferred — it fills name/price/image/category/sizes AND 実寸 (measuresBySize),
// and handles non-Shopify sites. Without a worker, Shopify still self-serves via
// its CORS-open <product>.js. Anything else falls back to the manual add modal.
async function webCaptureUrl(url, fallbackName) {
  url = (url || "").trim();
  if (await tryAutoCapture(url, fallbackName)) return true;
  openWebAdd({ url, name: fallbackName || "" }); // no proxy / failed: manual
  return false;
}

// Attempt auto-capture without the manual-modal fallback. Returns true on success.
async function tryAutoCapture(url, fallbackName) {
  if (workerUrl && await captureViaWorker(url, fallbackName)) return true;
  if (shopifyProductJsonUrl(url) && await captureShopifyClientSide(url, fallbackName)) return true;
  return false;
}

// After an add/update, open the just-saved item by its id — NOT items[0], which
// only holds the newest item; addItem updates an existing URL in place.
async function afterCapture(id, cur) {
  if (cur) { toast("♥ 自動で追加しました"); return; }
  toast("追加しました（通貨を選んでください）");
  const fresh = (await getItems()).find((i) => i.id === id);
  if (fresh) openEdit(fresh);
}

// GET the extract-proxy (worker) for a URL; returns parsed item data or null.
async function workerFetch(url) {
  if (!workerUrl) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(workerUrl.replace(/\/$/, "") + "/?url=" + encodeURIComponent(url), { signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const d = await r.json();
    return (d && !d.error && (d.name || d.image || d.price)) ? d : null;
  } catch { return null; }
}

// Server-side extract proxy: name/price/image/category/sizes + 実寸.
async function captureViaWorker(url, fallbackName) {
  const d = await workerFetch(url);
  if (!d) return false;
  let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* noop */ }
  const cur = d.currency || guessCurrencyByTld(host);
  const g = (d.major || d.sub) ? { major: d.major || "", sub: d.sub || "" } : guessCategory([d.name, fallbackName].join(" "));
  const { id } = await addItem({
    url, domain: host, site: d.site || siteNameFromDomain(host),
    name: d.name || fallbackName || "", brand: d.brand || "", price: d.price || "",
    currency: cur, image: d.image || "", availability: d.availability || "",
    sizes: d.sizes || "", colors: d.colors || "", color: d.color || "",
    measuresBySize: (d.measuresBySize && typeof d.measuresBySize === "object") ? d.measuresBySize : {},
    major: g.major, sub: g.sub,
  });
  await afterCapture(id, cur);
  return true;
}

// Shopify without a worker: the CORS-open <product>.js is enough (no 実寸).
async function captureShopifyClientSide(url, fallbackName) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000); // never hang on a slow/bad host
    const r = await fetch(shopifyProductJsonUrl(url), { credentials: "omit", signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return false;
    const host = new URL(url).hostname;
    const domain = host.replace(/^www\./, "");
    const cur = guessCurrencyByTld(host);
    const s = shopifyFromJson(await r.json(), { currency: cur, href: url });
    if (!s) return false;
    const g = guessCategory([s.name, fallbackName].join(" "));
    const { id } = await addItem({
      url, domain, site: siteNameFromDomain(domain),
      name: s.name || fallbackName || "", brand: s.brand, price: s.price,
      currency: cur, image: s.image, availability: s.availability,
      sizes: s.sizes, colors: s.colors, major: g.major, sub: g.sub,
    });
    await afterCapture(id, cur);
    return true;
  } catch { return false; }
}

// Web/PWA manual add — a closeable modal (no blocking prompt, no orphan item).
function openWebAdd(prefill = {}) {
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const urlI = el("input", { placeholder: "https://…（URLを貼り付け）", inputmode: "url" });
  const nameI = el("input", { placeholder: "商品名（任意）" });
  urlI.value = prefill.url || "";
  nameI.value = prefill.name || "";
  const modal = el("div", { class: "modal sm", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "追加" }),
    el("div", { style: "font-size:12.5px;color:var(--stone);line-height:1.7;margin-bottom:10px;" }, [
      "商品ページのURLを貼って「自動取得して追加」。ブランド公式(Shopify)なら名前・価格・画像・サイズ・カラーまで自動で入ります。", el("br"),
      "取れないサイトは項目を手入力してください。",
    ]),
    el("div", { class: "fld" }, [el("label", { text: "商品ページのURL" }), urlI]),
    el("div", { class: "fld" }, [el("label", { text: "商品名（自動で入らない時用）" }), nameI]),
    el("div", { class: "modal-foot" }, [
      el("button", { class: "btn btn-ghost", text: "キャンセル", onclick: () => overlay.remove() }),
      el("button", { class: "btn btn-ink", text: "自動取得して追加", onclick: async () => {
        const url = (urlI.value || "").trim(), name = (nameI.value || "").trim();
        if (!url && !name) { overlay.remove(); return; }
        overlay.remove();
        // Auto-capture (worker for any site, or Shopify .js). If it can't, store a
        // bare item and open the editor so the user can fill in the rest.
        if (await tryAutoCapture(url, name)) return;
        const domain = domainFromUrl(url);
        const { id } = await addItem({ url, domain, site: domain ? siteNameFromDomain(domain) : "", name });
        const fresh = (await getItems()).find((i) => i.id === id);
        if (fresh) openEdit(fresh);
      } }),
    ]),
  ]);
  overlay.append(modal); document.body.append(overlay);
}

// Re-fetch all Shopify items from their .js (heals existing items after a fix,
// e.g. corrected price / newly-supported fields). Non-Shopify items are skipped.
// Fetch fresh data for a URL: the worker (any site, incl 実寸) if configured,
// else Shopify's CORS-open .js. Returns a partial item (extracted fields) or null.
async function fetchItemData(url, fallbackName) {
  url = (url || "").trim();
  const d = await workerFetch(url); // worker handles Shopify + non-Shopify, and returns 実寸
  if (d) { if (!d.currency) d.currency = guessCurrencyByTld(d.domain || ""); return d; }
  const jsUrl = shopifyProductJsonUrl(url);
  if (jsUrl) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(jsUrl, { credentials: "omit", signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.ok) {
        const s = shopifyFromJson(await r.json(), { currency: "", href: url });
        if (s) { const g = guessCategory([s.name, fallbackName].join(" ")); return { ...s, major: g.major, sub: g.sub }; }
      }
    } catch { /* noop */ }
  }
  return null;
}

// One-tap bulk update: re-fetch every item and refresh price/stock/image/sizes
// AND 実寸 (measuresBySize) — also backfills size data into items saved before
// 実寸 extraction existed, so the user never has to re-add or touch the shop site.
async function updateAll() {
  const targets = (await getItems()).filter((it) => it.url);
  if (!targets.length) { alert("更新できるアイテムがありません。"); return; }
  if (!confirm(`${targets.length} 件を一括更新します。\n価格・在庫・画像・サイズ・実寸を取り直します（メモ・状態・カテゴリ・選択サイズはそのまま）。`)) return;
  let ok = 0, meas = 0, skip = 0, done = 0;
  toast(`一括更新中… 0/${targets.length}`);
  for (const it of targets) {
    try {
      const d = await fetchItemData(it.url, it.name);
      if (d) {
        const patch = {};
        for (const k of ["price", "image", "name", "brand", "availability", "sizes", "colors", "color"]) if (d[k]) patch[k] = d[k];
        if (d.measuresBySize && Object.keys(d.measuresBySize).length) { patch.measuresBySize = d.measuresBySize; meas++; }
        if (!it.major && d.major) { patch.major = d.major; patch.sub = d.sub || ""; } // backfill category only if未分類
        if (Object.keys(patch).length) { await patchItem(it.id, patch); ok++; } else skip++;
      } else skip++;
    } catch { skip++; }
    done++;
    if (done % 3 === 0 || done === targets.length) toast(`一括更新中… ${done}/${targets.length}`);
  }
  alert(`一括更新 完了\n${ok} 件を更新（うち実寸 ${meas} 件）/ ${skip} 件は取得できず。\n※ 取得できないサイトは、アイテムの ✎ から実寸を手入力できます。`);
}

// Re-add the UNIQLO size base (after an accidental "すべて削除").
async function reseedBase() {
  await addItem({ ...SEED_BASE });
  const added = (await getItems()).find((i) => i.url === SEED_BASE.url);
  if (added && added.major) {
    const b = await getBases();
    b[baseKey(added.major, added.sub)] = added.id;
    await setBases(b);
  }
  alert("UNIQLO エアリズムコットンT 2XL をサイズ基準として再登録しました。");
}

// Danger zone: full data wipe behind a typed confirmation + double confirm, with
// a backup shortcut. Separated from the one-tap menu so it can't be hit by accident.
function openDangerZone() {
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const n = items.length;
  const confirmInput = el("input", { placeholder: "削除", inputmode: "text", autocapitalize: "off", autocorrect: "off" });
  const delBtn = el("button", { class: "btn btn-ink", text: "全データを削除", style: "background:var(--accent);border-color:var(--accent);opacity:.5;pointer-events:none;" });
  const sync = () => {
    const ok = confirmInput.value.trim() === "削除";
    delBtn.style.opacity = ok ? "1" : ".5";
    delBtn.style.pointerEvents = ok ? "auto" : "none";
  };
  confirmInput.addEventListener("input", sync);
  delBtn.addEventListener("click", async () => {
    if (confirmInput.value.trim() !== "削除") return;
    if (!confirm(`本当に ${n} 件すべて（お気に入り・コーデ・サイズ基準）を削除しますか？\nこの操作は元に戻せません。`)) return;
    if (!confirm("最終確認：完全に消去します。よろしいですか？")) return;
    await setOutfits([]); await setBases({}); await setItems([]); // items last -> triggers reload
    overlay.remove();
    toast("すべて削除しました");
  });
  const modal = el("div", { class: "modal sm", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "データ管理" }),
    el("div", { style: "font-size:12.5px;color:var(--stone);line-height:1.7;margin-bottom:12px;" }, [
      `保存中の ${n} 件のお気に入り・コーデ・サイズ基準を`, el("b", { text: "すべて削除" }), "できます。",
      el("br"), el("b", { style: "color:var(--accent);", text: "元に戻せません。" }), " 先にバックアップの保存をおすすめします。",
    ]),
    el("button", { class: "btn btn-ghost", style: "width:100%;margin-bottom:14px;", text: "⬇ バックアップを保存（JSON）", onclick: async () => { await exportJson(); } }),
    el("div", { class: "fld" }, [el("label", { text: "確認のため「削除」と入力", style: "color:var(--accent);" }), confirmInput]),
    el("div", { class: "modal-foot" }, [
      el("button", { class: "btn btn-ghost", text: "キャンセル", onclick: () => overlay.remove() }),
      delBtn,
    ]),
  ]);
  sync();
  overlay.append(modal); document.body.append(overlay);
}

async function handleHashAdd() {
  const m = (location.hash || "").match(/[#&]add=([^&]+)/);
  if (!m) return false;
  try {
    const data = JSON.parse(decodeURIComponent(m[1]));
    if (data && (data.url || data.name)) {
      const r = await addItem(data);
      history.replaceState(null, "", location.pathname + location.search);
      toast(r.status === "updated" ? "♥ 情報を更新しました" : "♥ EDITに追加しました");
      return true;
    }
  } catch { /* ignore malformed */ }
  history.replaceState(null, "", location.pathname + location.search);
  return false;
}

// Web Share Target: the browser's "Share → EDIT" opens the app with the shared
// url/text/title as query params. Auto-capture from it (Shopify -> full auto).
function handleShareParam() {
  if (!window.__EDIT_WEB__) return false;
  const p = new URLSearchParams(location.search);
  let url = p.get("url") || "";
  const text = p.get("text") || "", title = p.get("title") || "";
  if (!url && text) { const m = text.match(/https?:\/\/\S+/); if (m) url = m[0]; }
  if (!url && !title) return false;
  history.replaceState(null, "", location.pathname);
  webCaptureUrl(url, title);
  return true;
}

/* ---------- edit modal ---------- */
function openEdit(it) {
  const f = { ...it };
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const field = (label, input) => el("div", { class: "fld" }, [el("label", { text: label }), input]);
  const inp = (val, on, attrs = {}) => { const e = el("input", attrs); e.value = val || ""; e.addEventListener("input", (ev) => on(ev.target.value)); return e; };

  const nameI = inp(f.name, (v) => f.name = v);
  const brandI = inp(f.brand, (v) => f.brand = v);
  const siteI = inp(f.site, (v) => f.site = v);
  const priceI = inp(f.price, (v) => f.price = v.replace(/[^\d.]/g, ""), { inputmode: "numeric" });
  const curSel = el("select", { onchange: (e) => f.currency = e.target.value, style: "width:82px;flex:0 0 auto;" }, CURRENCIES.map((c) => el("option", { value: c, text: curSymbol(c) + " " + c })));
  f.currency = currencyCode(f.currency); // normalize symbol/blank -> code (never drops KRW/CNY)
  curSel.value = f.currency;
  const subSel = el("select", {});
  const fillSubs = () => {
    subSel.innerHTML = "";
    subSel.append(el("option", { value: "", text: "（中カテゴリ：未設定）" }));
    subsOf(cats, f.major).forEach((s) => subSel.append(el("option", { value: s, text: s })));
    subSel.value = f.sub || "";
    subSel.disabled = subsOf(cats, f.major).length === 0;
  };
  // measurements (per-major fields; values normalized to cm on input)
  f.measures = { ...(f.measures || {}) };
  const measWrap = el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px;" });
  const fillMeasures = () => {
    measWrap.innerHTML = "";
    const fields = measureFieldsFor(f.major);
    if (!fields.length) {
      measWrap.append(el("div", { style: "grid-column:1/-1;color:var(--stone);font-size:12px;", text: "この大カテゴリは実寸比較の対象外です。" }));
      return;
    }
    fields.forEach((fld) => {
      const box = el("input", { placeholder: "cm / inch可", inputmode: "decimal" });
      box.value = f.measures[fld] || "";
      box.addEventListener("change", () => {
        const cm = toCm(box.value);
        if (cm == null) { delete f.measures[fld]; box.value = ""; }
        else { f.measures[fld] = String(cm); box.value = String(cm); }
      });
      measWrap.append(el("div", { class: "fld" }, [el("label", { text: fld, style: "font-size:11px;" }), box]));
    });
  };
  const majorSel = el("select", { onchange: (e) => { f.major = e.target.value; f.sub = ""; fillSubs(); fillMeasures(); } },
    [el("option", { value: "", text: "（大カテゴリ：未設定）" }), ...majorsOf(cats).map((m) => el("option", { value: m, text: m }))]);
  majorSel.value = f.major || "";
  subSel.addEventListener("change", (e) => { f.sub = e.target.value; });
  fillSubs();
  fillMeasures();
  const sizesI = inp(f.sizes, (v) => f.sizes = v, { placeholder: "S, M, L / 25.5 など" });
  const colorI = inp(f.color, (v) => f.color = v, { list: "edit-colors", placeholder: "例）ダスキーブルー" });
  const colorList = el("datalist", { id: "edit-colors" }, (f.colors ? f.colors.split(",").map((s) => s.trim()).filter(Boolean) : []).map((c) => el("option", { value: c })));
  const availSel = el("select", {}, AVAILABILITIES.map((a) => el("option", { value: a.v, text: a.label })));
  availSel.value = f.availability || "";
  availSel.addEventListener("change", (e) => f.availability = e.target.value);
  const srcSel = el("select", {}, [
    el("option", { value: "", text: `種別：自動（${SOURCE_LABEL[sourceKind(f.domain)]}）` }),
    el("option", { value: "official", text: "公式/直販" }),
    el("option", { value: "mall", text: "モール" }),
    el("option", { value: "other", text: "その他" }),
  ]);
  srcSel.value = f.source || "";
  srcSel.addEventListener("change", (e) => { f.source = e.target.value; });
  const noteI = inp(f.note, (v) => f.note = v);
  const tagsI = inp(f.tags, (v) => f.tags = v);
  const imgI = inp(f.image, (v) => f.image = v);
  const urlI = inp(f.url, (v) => { f.url = v; const d = domainFromUrl(v); f.domain = d; }, {});

  const seg = el("div", { class: "seg" }, STATUSES.map((s) => {
    const b = el("button", { class: f.status === s ? "on" : "", text: s, onclick: () => { f.status = s; [...seg.children].forEach((c, i) => c.className = STATUSES[i] === s ? "on" : ""); } });
    return b;
  }));

  const modal = el("div", { class: "modal sm", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "アイテムを編集" }),
    field("商品ページのURL", urlI),
    el("div", { class: "row" }, [field("ブランド", brandI), field("サイト名", siteI)]),
    field("商品名", nameI),
    el("div", { class: "fld" }, [el("label", { text: "価格" }), el("div", { style: "display:flex;gap:6px;" }, [curSel, priceI])]),
    el("div", { class: "fld" }, [el("label", { text: "カテゴリ（大 / 中）" }), el("div", { style: "display:flex;gap:6px;" }, [majorSel, subSel])]),
    el("div", { class: "fld" }, [el("label", { text: "実寸（cm・inch等は自動換算）" }), measWrap]),
    el("div", { class: "fld" }, [
      el("label", { text: "サイズ表を貼り付け → 実寸へ自動反映" }),
      (() => {
        const ta = el("textarea", { placeholder: "例）肩幅 52cm 身幅 62cm 着丈 77cm 袖丈 24cm", style: "width:100%;height:56px;font-size:12px;border:1px solid var(--line);border-radius:9px;padding:7px;font-family:inherit;" });
        const btn = el("button", { class: "btn btn-ghost", style: "margin-top:6px;", text: "貼り付けから反映", onclick: () => {
          const got = parseMeasures(ta.value, measureFieldsFor(f.major));
          const ks = Object.keys(got);
          if (!ks.length) { alert("実寸を読み取れませんでした。肩幅・身幅・着丈・袖丈などの語と数値を含むテキストを貼ってください。"); return; }
          Object.assign(f.measures, got);
          fillMeasures();
          alert("反映：" + ks.map((k) => `${k} ${got[k]}cm`).join(" / "));
        } });
        return el("div", {}, [ta, btn]);
      })(),
    ]),
    el("div", { class: "row" }, [field("カラー", el("span", {}, [colorI, colorList])), field("サイズ", sizesI)]),
    field("在庫", availSel),
    field("サイト種別（信頼性）", srcSel),
    el("div", { class: "fld" }, [el("label", { text: "状態" }), seg]),
    el("div", { class: "row" }, [field("メモ（色など）", noteI), field("タグ（カンマ区切り）", tagsI)]),
    field("画像URL", imgI),
    el("div", { class: "modal-foot" }, [
      el("button", { class: "btn btn-ghost", text: "キャンセル", onclick: () => overlay.remove() }),
      el("button", { class: "btn btn-ink", text: "更新", onclick: async () => { items = items.map((x) => x.id === f.id ? { ...x, ...f, _ts: Date.now() } : x); await setItems(items); overlay.remove(); update(); } }),
    ]),
  ]);
  overlay.append(modal); document.body.append(overlay);
}

/* ---------- compare modal ---------- */
function openCompare() {
  const list = items.filter((i) => compareIds.includes(i.id));
  const prices = list.map((i) => toJPY(i.price, i.currency, fx)).filter((n) => n != null && n > 0);
  const min = prices.length ? Math.min(...prices) : null;
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });

  const headRow = el("tr", {}, [el("th", { style: "width:78px;" })]);
  list.forEach((i) => {
    const ti = el("div", { class: "ti" });
    if (i.image) ti.append(el("img", { src: i.image, alt: "", referrerpolicy: "no-referrer" }));
    else ti.append(el("div", { class: "serif", style: "display:flex;align-items:center;justify-content:center;height:100%;font-size:26px;color:var(--stone);", text: (i.brand || i.name || "?").charAt(0) }));
    headRow.append(el("th", {}, [ti, el("div", { style: "font-size:12px;font-weight:500;line-height:1.3;", text: i.name || "（名称なし）" })]));
  });

  const rows = [
    ["ブランド", (i) => i.brand || "—"],
    ["カラー", (i) => i.color || "—"],
    ["サイト", (i) => i.site || i.domain || "—"],
    ["種別", (i) => SOURCE_LABEL[effectiveSource(i)]],
    ["価格", (i) => { const y = toJPY(i.price, i.currency, fx); return fmtPrice(i.price, i.currency) + (currencyCode(i.currency) !== "JPY" && y != null ? `（≈¥${y.toLocaleString()}）` : ""); }, true],
    ["在庫", (i) => availLabel(i.availability)],
    ["サイズ", (i) => i.sizes || "—"],
    ["カテゴリ", (i) => [i.major, i.sub].filter(Boolean).join(" / ") || "—"],
    ["状態", (i) => i.status || "—"],
    ["メモ", (i) => i.note || "—"],
  ];
  const body = el("tbody");
  rows.forEach(([lbl, fn, isPrice]) => {
    const tr = el("tr", {}, [el("td", { class: "lbl", text: lbl })]);
    list.forEach((i) => {
      const cheap = isPrice && min != null && toJPY(i.price, i.currency, fx) === min;
      const td = el("td", { class: cheap ? "cheap" : "" }, [cheap ? `${fn(i)}　最安` : fn(i)]);
      tr.append(td);
    });
    body.append(tr);
  });
  // measurement rows (cm), with ±diff vs each item's own base garment
  const emOf = (i) => effectiveMeasures(i);
  const measFields = [];
  list.forEach((i) => Object.keys(emOf(i)).forEach((f) => { if (!measFields.includes(f)) measFields.push(f); }));
  if (measFields.length) {
    const sep = el("tr", {}, [el("td", { class: "lbl", style: "color:var(--stone);", text: "実寸(cm)" })]);
    list.forEach(() => sep.append(el("td", {})));
    body.append(sep);
    measFields.forEach((f) => {
      const tr = el("tr", {}, [el("td", { class: "lbl", text: f })]);
      list.forEach((i) => {
        const v = emOf(i)[f];
        if (v === "" || v == null) { tr.append(el("td", {}, ["—"])); return; }
        const b = baseItemFor(i.major);
        const bv = b ? Number(emOf(b)[f]) : NaN;
        let diffTxt = "";
        if (!isNaN(bv) && (!b || b.id !== i.id)) {
          const dd = Math.round((Number(v) - bv) * 10) / 10;
          diffTxt = dd > 0 ? `（+${dd}）` : dd < 0 ? `（${dd}）` : "（±0）";
        }
        tr.append(el("td", {}, [`${v}${diffTxt}`]));
      });
      body.append(tr);
    });
  }

  const linkRow = el("tr", {}, [el("td", { class: "lbl", text: "リンク" })]);
  list.forEach((i) => linkRow.append(el("td", {}, [i.url ? el("a", { href: i.url, target: "_blank", rel: "noreferrer", style: "text-decoration:underline;font-size:12px;", text: "商品ページ →" }) : "—"])));
  body.append(linkRow);

  const modal = el("div", { class: "modal", style: "max-width:720px;", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "比較" }),
    el("div", { style: "overflow-x:auto;" }, [el("table", { class: "cmp-t" }, [el("thead", {}, [headRow]), body])]),
  ]);
  overlay.append(modal); document.body.append(overlay);
}

/* ---------- category settings modal ---------- */
function openCategorySettings() {
  let draft = cats.map((c) => ({ major: c.major, subs: [...c.subs] }));
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const listWrap = el("div", { style: "display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto;margin:8px 0;" });
  const render = () => {
    listWrap.innerHTML = "";
    draft.forEach((c, idx) => {
      const majorI = el("input", { value: c.major, placeholder: "大カテゴリ名", style: "font-weight:600;" });
      majorI.addEventListener("input", () => { c.major = majorI.value; });
      const subsI = el("input", { value: c.subs.join(", "), placeholder: "中カテゴリ（カンマ区切り・任意）" });
      subsI.addEventListener("input", () => { c.subs = subsI.value.split(",").map((s) => s.trim()).filter(Boolean); });
      const up = el("button", { class: "btn btn-ghost", text: "↑", style: "flex:0 0 auto;padding:6px 9px;", onclick: () => { if (idx > 0) { [draft[idx - 1], draft[idx]] = [draft[idx], draft[idx - 1]]; render(); } } });
      const del = el("button", { class: "btn btn-ghost", text: "削除", style: "flex:0 0 auto;", onclick: () => { draft.splice(idx, 1); render(); } });
      listWrap.append(el("div", { style: "border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;" }, [
        el("div", { style: "display:flex;gap:6px;align-items:center;" }, [majorI, up, del]),
        subsI,
      ]));
    });
  };
  render();
  const modal = el("div", { class: "modal", style: "max-width:520px;", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "カテゴリ設定" }),
    el("div", { style: "font-size:12px;color:var(--stone);line-height:1.6;", text: "不要な大カテゴリは「削除」。中カテゴリはカンマ区切りで編集できます。既存アイテムの分類ラベルはそのまま残ります。" }),
    listWrap,
    el("button", { class: "btn btn-ghost", text: "＋ 大カテゴリを追加", onclick: () => { draft.push({ major: "", subs: [] }); render(); } }),
    el("div", { class: "modal-foot" }, [
      el("button", { class: "btn btn-ghost", text: "初期化", onclick: () => { if (confirm("カテゴリを初期状態に戻しますか？")) { draft = defaultCategories(); render(); } } }),
      el("span", { style: "flex:1;" }),
      el("button", { class: "btn btn-ghost", text: "キャンセル", onclick: () => overlay.remove() }),
      el("button", { class: "btn btn-ink", text: "保存", onclick: async () => {
        const seen = new Set(), final = [];
        draft.map((c) => ({ major: (c.major || "").trim(), subs: c.subs })).filter((c) => c.major).forEach((c) => { if (!seen.has(c.major)) { seen.add(c.major); final.push(c); } });
        if (!final.length) { alert("大カテゴリを1つ以上残してください。"); return; }
        cats = final; await setCategories(cats);
        if (fMajor !== "すべて" && !majorsOf(cats).includes(fMajor)) { fMajor = "すべて"; fSub = "すべて"; }
        overlay.remove(); update();
      } }),
    ]),
  ]);
  overlay.append(modal); document.body.append(overlay);
}

/* ---------- bookmarklet help (web only) ---------- */
function openBookmarkletHelp() {
  const body = window.__EDIT_BOOKMARKLET__ || "";
  const appUrl = location.href.split("#")[0]; // works under GitHub Pages sub-paths
  const bm = body.replace(/__APPURL__/g, appUrl);
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const ta = el("textarea", { style: "width:100%;height:90px;font-size:11px;border:1px solid var(--line);border-radius:8px;padding:8px;", readonly: "readonly" });
  ta.value = bm;
  const modal = el("div", { class: "modal", style: "max-width:520px;", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "スマホで商品を取り込む" }),
    el("div", { style: "font-size:13px;line-height:1.7;color:var(--inkSoft);" }, [
      el("b", { text: "ブックマークレットを登録すると、商品ページから1タップで保存できます。" }),
      el("div", { style: "margin-top:8px;", text: "① 下のコードをコピー" }),
    ]),
    ta,
    el("button", { class: "btn btn-ink", style: "margin:8px 0;", text: "コピー", onclick: async () => { try { await navigator.clipboard.writeText(bm); alert("コピーしました"); } catch { ta.select(); document.execCommand && document.execCommand("copy"); } } }),
    el("div", { style: "font-size:12.5px;line-height:1.8;color:var(--stone);" }, [
      el("div", { text: "② iPhone(Safari)：適当なページを一度ブックマーク → ブックマーク編集で「名前=EDITに追加」「アドレス=貼り付けたコード」に置き換え。" }),
      el("div", { text: "③ Android(Chrome)：ブックマークを作成 → 編集でURLを貼り付け → 使うときはアドレスバーにブックマーク名を入力して選択。" }),
      el("div", { text: "商品ページでこのブックマークを開くと、EDIT に商品が追加されます。" }),
      el("div", { style: "margin-top:6px;opacity:.8;", text: "※ 取り込みが難しいサイトは、＋ボタンから手入力で追加できます。" }),
    ]),
    el("div", { class: "modal-foot" }, [el("button", { class: "btn btn-ghost", text: "閉じる", onclick: () => overlay.remove() })]),
  ]);
  overlay.append(modal); document.body.append(overlay);
}

/* ---------- FX (為替レート) settings ---------- */
function openFxSettings() {
  const draft = { ...defaultFx(), ...fx };
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const rows = Object.keys(draft).map((code) => {
    const inp = el("input", { inputmode: "decimal", value: String(draft[code]) });
    inp.addEventListener("input", () => { const v = parseFloat(inp.value); if (!isNaN(v)) draft[code] = v; });
    return el("div", { class: "fld", style: "display:flex;align-items:center;gap:8px;margin-bottom:8px;" }, [
      el("label", { style: "width:64px;margin:0;", text: `1 ${code}` }),
      el("span", { style: "color:var(--stone);", text: "＝" }),
      inp,
      el("span", { style: "color:var(--stone);", text: "円" }),
    ]);
  });
  const modal = el("div", { class: "modal sm", onclick: (e) => e.stopPropagation() }, [
    el("button", { class: "x", text: "×", onclick: () => overlay.remove() }),
    el("h2", { class: "serif", text: "為替レート設定" }),
    el("div", { style: "font-size:12px;color:var(--stone);line-height:1.6;margin-bottom:10px;", text: "外貨価格を円換算(≈¥)する際のレート。手動設定です（自動取得はしません）。おおよそで構いません。" }),
    ...rows,
    el("div", { class: "modal-foot" }, [
      el("button", { class: "btn btn-ghost", text: "キャンセル", onclick: () => overlay.remove() }),
      el("button", { class: "btn btn-ink", text: "保存", onclick: async () => { fx = draft; await setFx(fx); overlay.remove(); update(); } }),
    ]),
  ]);
  overlay.append(modal); document.body.append(overlay);
}

/* ---------- boot ---------- */
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") reload(); });
buildShell();
reload().then(() => { handleHashAdd(); handleShareParam(); });
