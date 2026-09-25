package io.github.nomataiga.edit;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;

/**
 * EDIT Android shell.
 *
 * The app itself is the live web app (https://nomataiga-del.github.io/edit-app/)
 * loaded in THIS app's private WebView, so all of its storage lives in this
 * app's own data directory: the browser's "clear browsing data", cleaner apps,
 * storage eviction and PWA re-installs cannot touch it. The web app updates
 * itself; this shell never needs to be reinstalled for UI changes.
 *
 * The only native duty is Android's share sheet (共有 → EDIT): ACTION_SEND text
 * is handed to the web app through the same ?text=&title= query that the PWA
 * share_target already understands (handleShareParam in popup.js).
 */
public class MainActivity extends BridgeActivity {
  private static final String TAG = "EDIT";
  private static final String APP_URL = "https://nomataiga-del.github.io/edit-app/";

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    handleShare(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleShare(intent);
  }

  private void handleShare(Intent intent) {
    if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
    String text = intent.getStringExtra(Intent.EXTRA_TEXT);
    String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
    if (text == null && subject == null) return;
    Uri.Builder b = Uri.parse(APP_URL).buildUpon();
    if (text != null) b.appendQueryParameter("text", text);
    if (subject != null) b.appendQueryParameter("title", subject);
    final String url = b.build().toString();
    Log.i(TAG, "share -> " + url);
    if (getBridge() != null && getBridge().getWebView() != null) {
      getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }
  }
}
