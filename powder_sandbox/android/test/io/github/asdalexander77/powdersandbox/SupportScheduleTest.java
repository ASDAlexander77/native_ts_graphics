package io.github.asdalexander77.powdersandbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class SupportScheduleTest {
    /** The preferences, in memory. */
    static final class MapStore implements SupportSchedule.Store {
        final Map<String, Object> values = new HashMap<>();
        public long getLong(String key, long fallback) { return (Long) values.getOrDefault(key, fallback); }
        public boolean getBoolean(String key, boolean fallback) { return (Boolean) values.getOrDefault(key, fallback); }
        public void put(String key, long value) { values.put(key, value); }
        public void put(String key, boolean value) { values.put(key, value); }
    }

    static final long MINUTE = 60_000L;
    final MapStore store = new MapStore();

    SupportSchedule schedule() {
        return new SupportSchedule(store, SupportSchedule.FIRST_MS, SupportSchedule.REPEAT_MS, SupportSchedule.LAUNCH_GRACE_MS);
    }

    @Test
    public void constantsAreTheSpecs() {
        assertEquals(10 * MINUTE, SupportSchedule.FIRST_MS);
        assertEquals(20 * MINUTE, SupportSchedule.REPEAT_MS);
        assertEquals(2 * MINUTE, SupportSchedule.LAUNCH_GRACE_MS);
    }

    @Test
    public void notDueBeforeTenMinutes() {
        SupportSchedule s = schedule();
        s.addPlayTime(599_999);
        assertFalse(s.isDue(10 * MINUTE, true));
        s.addPlayTime(1);
        assertTrue(s.isDue(10 * MINUTE, true));
    }

    @Test
    public void repeatsEveryTwentyAfterAnswer() {
        SupportSchedule s = schedule();
        s.addPlayTime(600_000);
        s.onAnswered();
        assertEquals(0L, store.getLong("playMs", -1));
        s.addPlayTime(1_199_999);
        assertFalse(s.isDue(60 * MINUTE, true));
        s.addPlayTime(1);
        assertTrue(s.isDue(60 * MINUTE, true));
    }

    @Test
    public void declineAndWatchAreTheSame() {
        SupportSchedule s = schedule();
        s.addPlayTime(600_000);
        s.onAnswered();
        assertTrue(store.getBoolean("prompted", false));
        assertEquals(0L, store.getLong("playMs", -1));
    }

    @Test
    public void neverDueWithoutAd() {
        SupportSchedule s = schedule();
        s.addPlayTime(3_600_000);
        assertFalse(s.isDue(10 * MINUTE, false));
    }

    @Test
    public void neverDueInLaunchGrace() {
        SupportSchedule s = schedule();
        s.addPlayTime(3_600_000);
        assertFalse(s.isDue(119_999, true));
        assertTrue(s.isDue(120_000, true));
    }

    @Test
    public void answeredPersistsAcrossReload() {
        SupportSchedule s = schedule();
        s.addPlayTime(600_000);
        s.onAnswered();
        s.addPlayTime(300_000);
        SupportSchedule reloaded = schedule();
        assertFalse(reloaded.isDue(60 * MINUTE, true));
        reloaded.addPlayTime(899_999);
        assertFalse(reloaded.isDue(60 * MINUTE, true));
        reloaded.addPlayTime(1);
        assertTrue(reloaded.isDue(60 * MINUTE, true));
    }
}
