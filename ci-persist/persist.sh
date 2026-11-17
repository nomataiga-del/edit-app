#!/usr/bin/env bash
# Android 版が「消えない」を、エミュレータの実物で確かめる。結果は「結果[...]」の行に出る。
# 途中で止まらないよう、失敗しても最後まで進める（判定はログを読んで行う）。
set -uo pipefail
PKG=io.github.nomataiga.edit
APK=apk-debug/EDIT-android-debug.apk
CDP="node ci-persist/cdp.mjs"
export RUN="persist-$(date +%s)"
export PASS="ci $(date +%s) ${RANDOM}${RANDOM} check"
echo "試験の名前: $RUN"

attach() {
  adb forward --remove tcp:9222 >/dev/null 2>&1 || true
  local sock=""
  for i in $(seq 1 24); do
    sleep 5
    sock=$(adb shell cat /proc/net/unix 2>/dev/null | grep -o "webview_devtools_remote_[0-9]*" | head -1 | tr -cd "a-z_0-9" || true)
    [ -n "$sock" ] && break
  done
  if [ -z "$sock" ]; then
    echo "結果[接続]: アプリの中につながらない"
    adb logcat -d | grep -aE "FATAL|AndroidRuntime" | tail -20 || true
    return 1
  fi
  adb forward tcp:9222 "localabstract:$sock" >/dev/null
  sleep 12
}
launch() { adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true; attach; }
stop_app() { adb shell am force-stop "$PKG" || true; sleep 3; }
sizes() { adb shell run-as "$PKG" sh -c 'du -sk app_webview cache 2>/dev/null' | tr '\n' ' ' || true; echo; }

echo "### 1 入れて開く"
adb install -r "$APK"
launch && $CDP info "入れた直後"

echo "### 2 合言葉でログイン（新しいアカウント）"
$CDP login "初回のログイン"
$CDP info "ログインのあと"

echo "### 3 お気に入りを 1 件足す"
$CDP add
sleep 15
$CDP check "足した直後"

echo "### 4 自動でクラウドに届くのを待つ（45 秒）"
sleep 45
$CDP cloud "自動の保存"

echo "### 5 アプリを強制終了して開き直す"
stop_app
launch && $CDP check "強制終了のあと"

echo "### 6 端末のキャッシュを全部消して開き直す（クリーナー・容量整理に当たる）"
stop_app
echo -n "  消す前の大きさ(KB): "; sizes
adb shell pm trim-caches 999999999999 || true
echo -n "  消した後の大きさ(KB): "; sizes
launch && $CDP check "キャッシュ全消去のあと"

echo "### 7 Chrome のデータを全部消して開き直す（閲覧データの削除に当たる）"
stop_app
echo "  Chrome の有無: $(adb shell pm list packages 2>/dev/null | grep -c 'com.android.chrome')"
adb shell pm clear com.android.chrome || true
launch && $CDP check "Chrome のデータ全消去のあと"

echo "### 8 同じ署名で上書きインストールして開き直す（アプリの更新に当たる）"
stop_app
adb install -r "$APK"
launch && $CDP check "上書きインストールのあと"

echo "### 9 端末を再起動して開き直す"
adb reboot || true
sleep 25
adb wait-for-device
for i in $(seq 1 60); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -cd '0-9')" = "1" ] && break
  sleep 5
done
sleep 20
launch && $CDP check "端末の再起動のあと"

echo "### 10 アプリのデータを消す（アンインストールに当たる）→ 同じ合言葉で戻るか"
stop_app
adb shell pm clear "$PKG" || true
launch && $CDP check "アプリのデータを消したあと（ここは消えていて正しい）"
$CDP login "入れ直しのログイン"
sleep 6
$CDP check "同じ合言葉でログインし直したあと"

echo "### 11 アプリの組み込み通信で、取得代行に断られる商品ページを読めるか（参考）"
CAMBIO="https://www.cambio.co.jp/c/brand/jihnunc/mp15204"
MUSINSA="https://global.musinsa.com/jp/products/5915362"
$CDP native "組み込み通信で CAMBIO" "$CAMBIO"
$CDP native "組み込み通信で MUSINSA" "$MUSINSA"

echo "### 12 共有で CAMBIO の商品を足す（取得代行は 406 で断る）→ 写真が入るか"
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "$CAMBIO" -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
sleep 30
$CDP captured "共有で足した CAMBIO" "$CAMBIO"

echo "### 13 試験の品を消して、すぐ共有で開き直す → 消した物が戻らないか"
$CDP delete "画面の削除ボタンで消す"
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "https://example.com/products/after-delete-check" -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
sleep 25
$CDP check "消して共有で開き直したあと（残っている=false が正しい）"
sleep 10
$CDP cloud "消したあとのクラウド（届いている=false が正しい）"
stop_app
launch && $CDP check "もう一度開き直したあと（残っている=false が正しい）"

echo "### 後片づけ"
$CDP cleanup
echo "試験おわり"
exit 0
