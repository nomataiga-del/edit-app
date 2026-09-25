# EDIT Android 版（消えない版）

スマホの **ブラウザの中** にデータを置く限り、「閲覧データの削除」「クリーナーアプリ」「ホーム画面アイコンの入れ直し」「ブラウザの容量整理」のどれか 1 つで全部消えます。
この Android 版は、同じ EDIT（ライブの Web アプリ）を **EDIT アプリ専用の保存領域** の中で動かします。ブラウザの都合では消えません。消えるのは「EDIT アプリをアンインストールした時」だけです（その場合もクラウドに残っています）。

- 中身はいつもの https://nomataiga-del.github.io/edit-app/ です。**画面の更新は自動**（アプリの入れ直し不要）。
- 「共有 → EDIT」もそのまま使えます。
- PC 拡張とは、同じ合言葉でログインすれば同じデータになります。

## インストール（1 回だけ）

1. スマホで https://github.com/nomataiga-del/edit-app/releases を開き、最新の `EDIT-android.apk` をダウンロード。
2. ダウンロードしたファイルを開く → 「提供元不明のアプリ」を許可（Chrome に許可）→ インストール。
3. EDIT を開く → ログイン画面に **PC と同じ合言葉** を入れる → 全部戻ります。
4. 以前のホーム画面アイコン（Chrome の PWA）は削除して構いません（データはこのアプリとクラウドにあります）。

## 更新について

- 画面・機能の更新は Web 側で自動反映。APK を入れ直すのは、このシェル自体（共有の受け取りなど）を直した時だけです。
- APK は必ず同じ署名鍵で作ります（鍵は PC の `edit/android-keys/` と GitHub Secrets に保管）。同じ鍵なので **上書きインストールでデータは残ります**。

## 仕組み（開発者向け）

- Capacitor 8 の Android プロジェクト（`android/`）。`capacitor.config.json` の `server.url` でライブの Web アプリを WebView に読み込む。
- WebView の localStorage はこのアプリのデータ領域（`/data/data/io.github.nomataiga.edit/`）に保存される＝ Chrome の site data とは別物。
- `MainActivity.java` が Android の共有（ACTION_SEND）を受け取り、PWA の share_target と同じ `?text=&title=` で Web アプリへ渡す。
- ビルドは GitHub Actions（`.github/workflows/android.yml`）。push すると署名付き APK を Release `android-v<version>` に添付し、エミュレータで起動＋共有の煙テストを行う。
- ローカルで Android SDK は不要。`npm ci && npx cap sync android` までは PC で、Gradle ビルドは CI。
