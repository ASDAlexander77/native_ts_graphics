package io.github.asdalexander77.powdersandbox;

/**
 * When to ask whether the player would watch an ad to support the app: after FIRST_MS of play,
 * then REPEAT_MS after each answer (watched or not), never in a launch's first LAUNCH_GRACE_MS and
 * never without an ad loaded. The play time is kept in the store, across launches.
 */
final class SupportSchedule {
    static final long FIRST_MS = 10 * 60_000L;
    static final long REPEAT_MS = 20 * 60_000L;
    static final long LAUNCH_GRACE_MS = 2 * 60_000L;

    /** Where it's kept (the app's SharedPreferences). */
    interface Store {
        long getLong(String key, long fallback);
        boolean getBoolean(String key, boolean fallback);
        void put(String key, long value);
        void put(String key, boolean value);
    }

    private static final String PLAY_MS = "playMs";
    private static final String PROMPTED = "prompted";

    private final Store store;
    private final long firstMs;
    private final long repeatMs;
    private final long launchGraceMs;

    SupportSchedule(Store store, long firstMs, long repeatMs, long launchGraceMs) {
        this.store = store;
        this.firstMs = firstMs;
        this.repeatMs = repeatMs;
        this.launchGraceMs = launchGraceMs;
    }

    /** Play time since the last answer (or since the first launch). */
    void addPlayTime(long ms) {
        if (ms > 0) {
            store.put(PLAY_MS, store.getLong(PLAY_MS, 0) + ms);
        }
    }

    boolean isDue(long sinceLaunchMs, boolean adReady) {
        long threshold = store.getBoolean(PROMPTED, false) ? repeatMs : firstMs;
        return adReady && sinceLaunchMs >= launchGraceMs && store.getLong(PLAY_MS, 0) >= threshold;
    }

    /** The player answered the prompt, either way: the next one is repeatMs of play away. */
    void onAnswered() {
        store.put(PLAY_MS, 0L);
        store.put(PROMPTED, true);
    }
}
