package io.github.asdalexander77.powdersandbox;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Toast;
import androidx.annotation.NonNull;
import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.RequestConfiguration;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The "support the app" prompt: counts play time (SupportSchedule), and when it's due and a rewarded
 * ad is loaded, asks whether the player would watch it. Consent (UMP) comes first: no ad is requested
 * where it's needed and not given. All on the activity's main thread.
 */
final class SupportAds {
    private static final String TAG = "PowderSupportAds";
    private static final long TICK_MS = 1000;
    private static final long RETRY_MS = 60_000;

    private final Activity activity;
    private final SupportSchedule schedule;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final long launchedAt = SystemClock.elapsedRealtime();
    private final AtomicBoolean adsStarted = new AtomicBoolean();
    private final ConsentInformation consent;

    private RewardedAd ad;
    private boolean loading;
    private boolean resumed;
    private boolean focused;
    private boolean prompting;   // the dialog, or the ad, is up
    private long lastTick = SystemClock.elapsedRealtime();

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            long now = SystemClock.elapsedRealtime();
            if (resumed && focused && !prompting) {
                schedule.addPlayTime(now - lastTick);
                if (schedule.isDue(now - launchedAt, ad != null)) {
                    showPrompt();
                }
            }
            lastTick = now;
            handler.postDelayed(this, TICK_MS);
        }
    };

    private final Runnable retryLoad = this::loadAd;

    SupportAds(Activity activity, SupportSchedule schedule) {
        this.activity = activity;
        this.schedule = schedule;
        consent = UserMessagingPlatform.getConsentInformation(activity);
        ConsentRequestParameters parameters = new ConsentRequestParameters.Builder()
            .setTagForUnderAgeOfConsent(false)
            .build();
        consent.requestConsentInfoUpdate(activity, parameters,
            () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, formError -> {
                if (formError != null) {
                    Log.w(TAG, "consent form: " + formError.getMessage());
                }
                startAdsIfAllowed();
            }),
            requestError -> {
                Log.w(TAG, "consent info: " + requestError.getMessage());
                startAdsIfAllowed();
            });
        // consent given in an earlier launch: no need to wait for the update
        startAdsIfAllowed();
    }

    /** The preferences the schedule is kept in. */
    static SupportSchedule.Store preferences(Context context) {
        SharedPreferences preferences = context.getSharedPreferences("support_ads", Context.MODE_PRIVATE);
        return new SupportSchedule.Store() {
            public long getLong(String key, long fallback) { return preferences.getLong(key, fallback); }
            public boolean getBoolean(String key, boolean fallback) { return preferences.getBoolean(key, fallback); }
            public void put(String key, long value) { preferences.edit().putLong(key, value).apply(); }
            public void put(String key, boolean value) { preferences.edit().putBoolean(key, value).apply(); }
        };
    }

    void onResume() {
        resumed = true;
        lastTick = SystemClock.elapsedRealtime();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
    }

    void onPause() {
        resumed = false;
        handler.removeCallbacks(tick);
    }

    void onWindowFocusChanged(boolean hasFocus) {
        focused = hasFocus;
        lastTick = SystemClock.elapsedRealtime();
    }

    private void startAdsIfAllowed() {
        if (!consent.canRequestAds() || !adsStarted.compareAndSet(false, true)) {
            return;
        }
        MobileAds.setRequestConfiguration(new RequestConfiguration.Builder()
            .setMaxAdContentRating(RequestConfiguration.MAX_AD_CONTENT_RATING_T)
            .setTagForChildDirectedTreatment(RequestConfiguration.TAG_FOR_CHILD_DIRECTED_TREATMENT_FALSE)
            .build());
        // initialize off the main thread (it's slow), then load on it
        new Thread(() -> MobileAds.initialize(activity, status -> handler.post(this::loadAd)), "PowderAdsInit").start();
    }

    private void loadAd() {
        if (ad != null || loading || activity.isFinishing()) {
            return;
        }
        loading = true;
        RewardedAd.load(activity, BuildConfig.ADMOB_REWARDED_ID, new AdRequest.Builder().build(),
            new RewardedAdLoadCallback() {
                @Override public void onAdLoaded(@NonNull RewardedAd loaded) {
                    loading = false;
                    ad = loaded;
                    Log.i(TAG, "rewarded ad loaded");
                }

                @Override public void onAdFailedToLoad(@NonNull LoadAdError error) {
                    loading = false;
                    Log.i(TAG, "rewarded ad not loaded (" + error.getCode() + "): retrying in " + RETRY_MS / 1000 + " s");
                    handler.removeCallbacks(retryLoad);
                    handler.postDelayed(retryLoad, RETRY_MS);
                }
            });
    }

    private void showPrompt() {
        prompting = true;
        AtomicBoolean answered = new AtomicBoolean();
        AtomicBoolean watch = new AtomicBoolean();
        AlertDialog dialog = new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(R.string.support_title)
            .setMessage(R.string.support_message)
            .setPositiveButton(R.string.support_watch, (d, which) -> watch.set(true))
            .setNegativeButton(R.string.support_not_now, null)
            .setCancelable(true)
            .create();
        dialog.setOnDismissListener(d -> {
            if (!answered.compareAndSet(false, true)) {
                return;
            }
            schedule.onAnswered();
            if (watch.get()) {
                showAd();
            } else {
                prompting = false;
            }
        });
        dialog.show();
    }

    private void showAd() {
        RewardedAd shown = ad;
        ad = null;
        if (shown == null) {
            finishAd(R.string.support_thanks_anyway);
            return;
        }
        AtomicBoolean rewarded = new AtomicBoolean();
        shown.setFullScreenContentCallback(new FullScreenContentCallback() {
            @Override public void onAdDismissedFullScreenContent() {
                // thanked once the game is back (a toast over the ad would go unseen)
                finishAd(rewarded.get() ? R.string.support_thanks : 0);
            }

            @Override public void onAdFailedToShowFullScreenContent(@NonNull AdError error) {
                Log.w(TAG, "rewarded ad not shown: " + error.getMessage());
                finishAd(R.string.support_thanks_anyway);
            }
        });
        shown.show(activity, reward -> rewarded.set(true));
    }

    /** The ad is over (a toast to show, or 0 for none): count play time again, load the next one. */
    private void finishAd(int toast) {
        if (toast > 0) {
            Toast.makeText(activity, toast, Toast.LENGTH_LONG).show();
        }
        prompting = false;
        lastTick = SystemClock.elapsedRealtime();
        loadAd();
    }
}
