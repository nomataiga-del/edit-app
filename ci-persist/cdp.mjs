// Android 版（debug 変種）の WebView に DevTools でつなぎ、アプリの中で操作と確認を行う。
// 使い方: RUN=<試験の名前> PASS=<試験用の合言葉> node ci-persist/cdp.mjs <手順> [ラベル]
import { pbkdf2Sync } from "node:crypto";

const step = process.argv[2];
const label = process.argv[3] || "";
const RUN = process.env.RUN || "persist-x";
const PASS = process.env.PASS || "";
const W = "https://fragrant-dust-0d49.noma-taiga.workers.dev";
const ITEM = { url: `https://example.com/products/${RUN}`, name: `保持試験 ${RUN}`, brand: "TEST", price: "100", currency: "JPY", major: "トップス", sub: "ジャケット" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  const list = await (await fetch("http://127.0.0.1:9222/json")).json();
  return list.find((t) => t.type === "page" && /edit-app/.test(t.url)) || null;
}

async function evaluate(expression, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const t = await target();
      if (!t) throw new Error("アプリのページが見つからない");
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("応答なし")), 90000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); resolve(m); } };
        ws.onerror = () => { clearTimeout(timer); reject(new Error("接続エラー")); };
        ws.onclose = () => { clearTimeout(timer); reject(new Error("接続が切れた")); };
      });
      try { ws.close(); } catch { /* 無視 */ }
      if (res.error) throw new Error(JSON.stringify(res.error));
      if (res.result.exceptionDetails) throw new Error("ページ内の例外: " + JSON.stringify(res.result.exceptionDetails).slice(0, 500));
      return res.result.result.value;
    } catch (e) { lastErr = e; await sleep(4000); }
  }
  throw lastErr;
}

const STATE = `(async () => {
  const g = (k) => { try { return JSON.parse(localStorage.getItem("edit_ls_" + k)); } catch { return null; } };
  const items = g("edit_items_v1") || [];
  let persisted = null; try { persisted = await navigator.storage.persisted(); } catch {}
  return JSON.stringify({
    ua: navigator.userAgent,
    loginGate: !!document.getElementById("edit-login"),
    loggedIn: g("edit_sync_enabled_v1") === true && !!g("edit_sync_token_v1"),
    lastPush: g("edit_sync_last_push_v1") || 0,
    lastPull: g("edit_sync_last_pull_v1") || 0,
    count: items.length,
    hasRunItem: items.some((i) => String(i.url || "").includes(${JSON.stringify(RUN)})),
    persisted,
    cap: !!window.Capacitor,
    capNative: !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform()),
    capPlatform: (window.Capacitor && typeof window.Capacitor.getPlatform === "function") ? window.Capacitor.getPlatform() : null,
    moveGuide: !!document.getElementById("edit-move"),
    keys: Object.keys(localStorage).length,
    shown: (document.getElementById("app") || {}).textContent ? document.getElementById("app").textContent.includes(${JSON.stringify(RUN)}) : false,
  });
})()`;

const LOGIN = `(async () => {
  window.__dlg = [];
  window.alert = (m) => { window.__dlg.push("知らせ: " + String(m).slice(0, 60)); };
  window.confirm = (m) => { window.__dlg.push("確認: " + String(m).slice(0, 60)); return true; };
  const gate = document.getElementById("edit-login");
  if (!gate) return JSON.stringify({ error: "ログイン画面が出ていない" });
  gate.querySelector("input").value = ${JSON.stringify(PASS)};
  const btn = [...gate.querySelectorAll("button")].find((b) => b.textContent === "ログイン");
  if (!btn) return JSON.stringify({ error: "ログインのボタンが無い" });
  btn.click();
  const t0 = Date.now();
  while (document.getElementById("edit-login") && Date.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 4000));
  return JSON.stringify({ gateGone: !document.getElementById("edit-login"), dialogs: window.__dlg, toast: (document.getElementById("edit-toast") || {}).textContent || "" });
})()`;

const ADD = `(() => { setTimeout(() => { location.hash = "#add=" + encodeURIComponent(${JSON.stringify(JSON.stringify(ITEM))}); location.reload(); }, 300); return "追加を予約"; })()`;

const tokenOf = (pass) => pbkdf2Sync(String(pass).normalize("NFKC").trim().replace(/\s+/g, " "), "edit-sync-v1", 120000, 32, "sha256").toString("base64url");
const jst = (ms) => (ms ? new Date(Number(ms) + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "なし");

try {
  if (step === "info") {
    const s = JSON.parse(await evaluate(STATE));
    console.log(`結果[${label || "状態"}]: 端末の種類=${/; wv\)/.test(s.ua) ? "アプリ内の WebView" : "ブラウザ"} / ログイン画面=${s.loginGate} / ログイン中=${s.loggedIn} / 件数=${s.count} / 保存キーの数=${s.keys} / 保存の保護=${s.persisted}`);
    console.log("  UA: " + s.ua);
    console.log(`  アプリの印: Capacitor あり=${s.cap} / ネイティブ=${s.capNative} / 種類=${s.capPlatform} / 「Android 版へ」の案内が出ている=${s.moveGuide}`);
  } else if (step === "login") {
    const r = JSON.parse(await evaluate(LOGIN));
    console.log(`結果[${label || "ログイン"}]: ${r.error ? "失敗 " + r.error : "ログイン画面が消えた=" + r.gateGone + " / 出た表示=" + JSON.stringify(r.dialogs) + " / お知らせ=" + r.toast}`);
  } else if (step === "add") {
    console.log("  " + (await evaluate(ADD)));
  } else if (step === "check") {
    const s = JSON.parse(await evaluate(STATE));
    console.log(`結果[${label}]: 試験の品が残っている=${s.hasRunItem} / 画面に出ている=${s.shown} / ログイン中=${s.loggedIn} / 件数=${s.count} / ログイン画面=${s.loginGate} / 「Android 版へ」の案内=${s.moveGuide} / 最後の保存=${jst(s.lastPush)}`);
  } else if (step === "cloud") {
    const r = await fetch(`${W}/sync?token=${tokenOf(PASS)}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.log(`結果[${label || "クラウド"}]: 応答 ${r.status}（まだ何も無い）`); }
    else {
      const j = await r.json();
      const has = (j.items || []).some((i) => String(i.url || "").includes(RUN));
      const ua = (j.diag || []).map((e) => (e.env && e.env.ua) || "").pop() || "";
      console.log(`結果[${label || "クラウド"}]: 試験の品が届いている=${has} / 件数=${(j.items || []).length} / 保存した時刻=${jst(Date.parse(j.exportedAt))}${ua ? " / 保存した端末=" + (/; wv\)/.test(ua) ? "アプリ内の WebView" : "ブラウザ") : ""}`);
    }
  } else if (step === "cleanup") {
    const body = JSON.stringify({ app: "EDIT", kind: "edit-export", version: 1, exportedAt: new Date().toISOString(), count: 0, items: [], outfits: [], bases: {}, categories: [] });
    const r = await fetch(`${W}/sync?token=${tokenOf(PASS)}&force=1`, { method: "PUT", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(20000) });
    console.log(`  試験用のクラウドの中身を空にした（応答 ${r.status}）`);
  } else {
    console.log("手順の名前が違う: " + step);
  }
} catch (e) {
  console.log(`結果[${label || step}]: 確かめられなかった（${e && e.message ? e.message : e}）`);
}
