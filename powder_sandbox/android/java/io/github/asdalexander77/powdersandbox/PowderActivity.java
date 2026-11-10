package io.github.asdalexander77.powdersandbox;

import android.app.NativeActivity;
import android.os.Bundle;

/**
 * The game's NativeActivity (lib powder_sandbox_nri.so runs in it, as in the other examples), with
 * the "support the app" ads (SupportAds). A debug build started with `--ez ads_fast true` asks after
 * 10 s, then every 20 s, from 5 s into the launch.
 */
public class PowderActivity extends NativeActivity {
    private SupportAds ads;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean fast = BuildConfig.DEBUG && getIntent().getBooleanExtra("ads_fast", false);
        SupportSchedule schedule = fast
            ? new SupportSchedule(SupportAds.preferences(this), 10_000L, 20_000L, 5_000L)
            : new SupportSchedule(SupportAds.preferences(this), SupportSchedule.FIRST_MS,
                SupportSchedule.REPEAT_MS, SupportSchedule.LAUNCH_GRACE_MS);
        ads = new SupportAds(this, schedule);
    }

    @Override
    protected void onResume() {
        super.onResume();
        ads.onResume();
    }

    @Override
    protected void onPause() {
        ads.onPause();
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        ads.onWindowFocusChanged(hasFocus);
    }
}
