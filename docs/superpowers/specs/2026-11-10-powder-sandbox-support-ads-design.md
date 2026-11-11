# Powder Sandbox: "support the app" rewarded ads (Android)

Date: 2026-11-10. Status: approved 2026-11-10.

## Intent

Powder Sandbox is on Google Play, free, with no ads. The owner wants a gentle way for players who
enjoy it to support it: after a while of play the app asks whether they would watch an ad to
support the app. Watching is always the player's choice; the game never forces an ad.

## Behaviour (owner's decisions)

- First prompt after **10 minutes** of play; after that, every **20 minutes**, whether the
  player watched the ad or said no.
- The prompt is a dialog along the lines of: *"Enjoying Powder Sandbox? Would you like to watch a
  short ad to support the app?"* with **Watch ad** and **Not now**.
- Ad IDs: Google's published **test** IDs for now; the owner adds the real AdMob app ID and ad
  unit ID later. They must be easy to find and change in one place.

## Calls made by Claude (owner may override)

- **Ad network: Google AdMob, rewarded ad format** (full-screen ad the user opts into). "Reward" is
  just a thank-you message, there is no in-game reward. Rewarded interstitial is not used.
- **Play time** = time the app is in the foreground with the game's window showing. It is
  counted across launches (kept in the app's private preferences), so players with short sessions
  still reach 10 minutes. Time spent in the dialog or in the ad doesn't count. After the prompt is
  answered (either way), or after the ad closes, the counter restarts toward the next 20 minutes.
- **No ad ready → no prompt.** The ad is preloaded in the background. If it isn't loaded when the
  prompt is due (offline, no fill), the prompt waits. It shows as soon as an ad loads, but never
  in the first 2 minutes of a launch, so it never looks like an ad at launch. An overdue prompt
  from an earlier launch follows the same rule. It never shows the dialog and then fails. If the player taps Watch ad and showing fails anyway,
  they get a short "Thanks anyway" toast.
- **Thank-you**: after the ad is watched to the reward point, a toast says thanks.
- **All of it lives in Java**, in a small `NativeActivity` subclass in the Powder Sandbox Android
  folder. The timer, dialog and ad live there, and the TypeScript game and `core/android_main.cpp`
  are untouched. The native game keeps its existing pause/resume handling when the ad's activity
  covers it, which it already does for app switching. If, while building, the game turns out to
  need to pause its simulation behind the dialog, that is a small JNI addition left to the
  builder.
- **Consent**: Google's User Messaging Platform (UMP) SDK asks for consent where the law requires
  it (EEA/UK/Switzerland) before any ad request. A "Privacy options" entry is not added now,
  because the game has no settings screen reachable from Java. It is noted as a follow-up for the
  store review.
- **Build**: Powder Sandbox's Android package moves to a small **Gradle** project
  (`powder_sandbox/android/` as an Android application module). It packages the native libraries
  that the existing CMake/tslang build already produces (both ABIs), the media assets and the
  resources, and it depends on `com.google.android.gms:play-services-ads` and
  `com.google.android.ump:user-messaging-platform`. Gradle is used because AdMob brings ~20
  transitive AARs plus manifest merging, which `tools/package_apk.py` (aapt2, no Java) cannot do
  reliably. The existing `powder_sandbox_nri_release` CMake target invokes the Gradle build, so
  `build_release_apk_for_deployment.bat` keeps working and still outputs the signed `.aab`,
  `.apk` and native debug symbols with the same names and release keystore settings. The version
  code is bumped.
- **Other examples and tests are unchanged.** The dev/test APK (`powder_sandbox_nri_apk`, used by
  `tools/android.py` headless runs and ctest) stays on the old no-Java pipeline, so tests never
  show ads or need network. The ads build is the Gradle one: debug (test IDs, debug key) for
  trying it on a phone, release for Play.
- **Permissions**: INTERNET and ACCESS_NETWORK_STATE (from the AdMob manifest), plus
  `com.google.android.gms.permission.AD_ID`.
- **Store paperwork drafted, not submitted**: update `powder_sandbox/store/PRIVACY.md` (ads via
  AdMob, advertising ID, internet), a changelog entry, and a short note in
  `powder_sandbox/store/README.md` on what to change in Play Console: "Contains ads", Data
  safety (device or other IDs, collected and shared by the AdMob SDK, for advertising), and where
  to put the real IDs.

## Audience (owner's decision)

- No ads for children. Play target audience is set to 13 and over, so the app is not in the
  Families program. Ad requests are not tagged child-directed. Claude's call: ad content is capped
  at Teen (`MAX_AD_CONTENT_RATING_T`) to suit a sandbox game. The store README notes the
  target-audience setting for Play Console.

## Goals

- Opt-in rewarded ad prompt on the 10 / 20-minute schedule in the Play build.
- Real IDs drop in without being committed. Like the keystore passwords, the release build reads
  them from environment variables (`POWDER_ADMOB_APP_ID`, `POWDER_ADMOB_REWARDED_ID`) and passes
  them to Gradle (`manifestPlaceholders`/`buildConfigField`). When they are unset, it falls back
  to Google's test IDs and prints a loud warning, so a release built without them is easy to
  spot. Debug builds always use test IDs.
- The build may download Maven dependencies (AGP, AdMob, UMP) at build time, as it already
  fetches bundletool. Nothing downloaded is committed.
- The release script still produces an uploadable, signed `.aab`.

## Non-goals

- iOS, desktop, other examples.
- Banners, interstitials, ads at launch, or paid "remove ads".
- In-game rewards.

## Anti-goals (would be a failure even if it works)

- An ad that shows without the player choosing it, or a prompt more often than the schedule.
- Breaking the headless/ctest Android runs, or the other examples' APKs.
- Committing real AdMob IDs, keystore passwords or downloaded SDKs.
- The game crashing or losing its surface/state when returning from the ad.

## Left to the builder

- Gradle/AGP versions, Gradle wrapper, how CMake hands the built `.so` files and media to Gradle.
- Exact dialog wording and styling (a plain Android `AlertDialog` is fine).
- Whether the dialog waits for a moment with no finger on the screen (nice to have, skip it if
  NativeActivity's input queue makes it awkward).
- minSdk handling if the current one is below what play-services-ads requires (raise it for the
  Gradle build).

## Verification

- Debug ads build on the emulator/phone: with a debug-only shortened timer (e.g. an intent extra
  making it 10 s / 20 s), the prompt appears, the test rewarded ad plays, the game resumes and
  keeps drawing, and "Not now" reschedules.
- Release target produces signed `.aab`/`.apk`; `bundletool` validates the bundle.
- Existing Android headless ctest for powder_sandbox_nri still passes.
