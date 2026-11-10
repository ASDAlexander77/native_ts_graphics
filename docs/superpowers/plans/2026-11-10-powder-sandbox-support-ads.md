# Powder Sandbox Support Ads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Powder Sandbox's Android build, ask after 10 minutes of play (then every 20) whether the player wants to watch a rewarded AdMob ad to support the app.

**Architecture:** A Java `NativeActivity` subclass (`PowderActivity`) owns the play-time schedule, the consent flow (UMP), the dialog and the rewarded ad. The native game is unchanged. Powder Sandbox's ads builds are packaged by Gradle: `tools/package_apk.py --gradle` stages the same assets/libraries it already stages, then runs a fetched Gradle distribution on the module in `powder_sandbox/android/`. Everything else, including the `powder_sandbox_nri_apk` used by tests, stays on the existing aapt2 pipeline.

**Tech Stack:** Java 17, Android Gradle Plugin 8.x, Gradle (distribution fetched at build time like bundletool), `com.google.android.gms:play-services-ads`, `com.google.android.ump:user-messaging-platform`, JUnit 4, CMake, Python.

**Spec:** `docs/superpowers/specs/2026-11-10-powder-sandbox-support-ads-design.md`

## Global Constraints

- First prompt after **10 minutes** of play; then every **20 minutes**, whether the ad was watched or declined.
- Play time = foreground with the window focused, excluding the dialog and the ad; persisted across launches.
- Never prompt in the first **2 minutes** of a launch; never prompt unless a rewarded ad is loaded.
- Ad requests: not child-directed, `MAX_AD_CONTENT_RATING_T`. UMP consent gathered before the first ad request.
- Google test IDs: app `ca-app-pub-3940256099942544~3347511713`, rewarded `ca-app-pub-3940256099942544/5224354917`.
- Real IDs come only from env vars `POWDER_ADMOB_APP_ID` / `POWDER_ADMOB_REWARDED_ID` (release only); unset → test IDs + a loud `WARNING` line. Debug always uses test IDs. Never commit real IDs, passwords, Gradle distributions or Maven artifacts.
- `powder_sandbox_nri_apk`, other examples, `tools/android.py` and ctest behaviour unchanged.
- `build_release_apk_for_deployment.bat` still yields `bin/powder_sandbox_nri-release.aab`, `-release.apk` (both ABIs) and `-native-debug-symbols.zip`, signed with `ANDROID_RELEASE_KEYSTORE`.
- minSdk stays `TSLANG_ANDROID_MIN_SDK` (29), targetSdk 36. Package `io.github.asdalexander77.powdersandbox`.

## Review Focus

- **Returning from the ad** (window destroyed/recreated under the ad's activity): the game must keep drawing and keep its state afterwards. Task 3 Step 6 checks this on the emulator.
- **Offline / no fill:** no dialog appears, nothing crashes, and the prompt shows once an ad loads. Task 2 tests `isDue` with `adReady=false`; Task 3 Step 7 runs with networking off.
- **Rotation while the dialog is up:** the activity is not recreated (configChanges), so the dialog must survive and still work. Task 3 Step 6.
- **Process killed between prompt and answer:** the persisted counter must not reset to zero, and the prompt must not repeat at once. Task 2 test `answeredPersistsAcrossReload`.
- **Release built without the ID env vars:** the build warns and doesn't fail. Task 4 Step 3.

---

### Task 1: Gradle packaging path producing the same game APK

**Files:**
- Create: `powder_sandbox/android/build.gradle`, `powder_sandbox/android/settings.gradle`, `powder_sandbox/android/gradle.properties`, `powder_sandbox/android/AndroidManifest.xml`, `powder_sandbox/android/java/io/github/asdalexander77/powdersandbox/PowderActivity.java`, `powder_sandbox/android/.gitignore` (`.gradle/`, `build/`, `local.properties`)
- Modify: `tools/package_apk.py` (add `--gradle`, `--gradle-task`, `fetch_gradle()`), `CMakeLists.txt:1127-1179` (`add_tslang_android_release` gains a `GRADLE <dir>` keyword and also defines `<name>_ads_apk`), `powder_sandbox/powder_sandbox.cmake:121` (pass `GRADLE powder_sandbox/android`)

**Interfaces:**
- Produces: `package_apk.py --gradle <module dir> --gradle-task <assembleDebug|release>`. It stages into `<work>/gradle-input/` (`assets/` with `assets.txt` exactly as today, `jniLibs/<abi>/lib*.so` stripped) and writes `<work>/gradle-input/build.properties` with `package`, `label`, `versionCode`, `versionName`, `minSdk`, `targetSdk`, `vulkanVersion`, `appCategory`, `admobAppId`, `admobRewardedId`, `keystore`, `keyAlias`, `storePassEnv`, `keyPassEnv`. It runs Gradle with `-PpowderInput=<work>/gradle-input` and `--project-cache-dir <work>/gradle-cache`, with `JAVA_HOME` from `--java-home` and `ANDROID_HOME` from `--sdk`. Gradle's output dir is `<work>/gradle-build`.
- Produces: CMake target `powder_sandbox_nri_ads_apk` → `bin/powder_sandbox_nri-ads-debug.apk` (debug-signed with `ANDROID_DEBUG_KEYSTORE`, alias/password = `package_apk.py`'s `KEY_ALIAS`/`KEY_PASSWORD`, test IDs, `debuggable`).
- Produces: `PowderActivity extends android.app.NativeActivity`, launched as `.PowderActivity` with `android.app.lib_name` meta-data = `powder_sandbox_nri`.

- [ ] **Step 1:** Write the Gradle module. `build.gradle` reads `powderInput/build.properties`. Source sets: `manifest.srcFile 'AndroidManifest.xml'`, `java.srcDirs ['java']`, `res.srcDirs ['res']`, `assets.srcDirs [powderInput/assets]`, `jniLibs.srcDirs [powderInput/jniLibs]`. Set `packaging.jniLibs.useLegacyPackaging false` (uncompressed, page-aligned, like today) and `manifestPlaceholders` for label/vulkanVersion/appCategory/admobAppId. Add a `buildConfigField` for the rewarded ID, and signing configs from the properties (passwords read via `System.getenv(storePassEnv)`). The release build type has `minifyEnabled false`, `debuggable false`, and `ndk.debugSymbolLevel` unset (package_apk makes the symbols zip). Copy the manifest's activity attributes (launchMode, theme, configChanges, intent filter) and the `allowBackup="false"` / `extractNativeLibs="false"` from `tools/android/AndroidManifest.xml.in`, but use `android:name=".PowderActivity"` and drop `hasCode`.
- [ ] **Step 2:** Implement `fetch_gradle(path)` in `package_apk.py` like `fetch_bundletool`. `GRADLE_VERSION` is pinned to what the chosen AGP requires, and the source is `https://services.gradle.org/distributions/gradle-<v>-bin.zip`, unzipped into `<build>/android/gradle-<v>/`. Implement the `--gradle` branch: it reuses `stage_assets` and the strip loop, writes `build.properties`, runs `gradle -p <module> <task>`, then copies Gradle's APK/AAB to `--out`/`--bundle`. The symbols zip is unchanged.
- [ ] **Step 3:** Wire `GRADLE` into `add_tslang_android_release`, which adds the `<name>_ads_apk` target (debug, `--gradle-task assembleDebug`) depending on `<name>_apk`.
- [ ] **Step 4:** Build and run it. `cmake --build --preset android-x86_64 --target powder_sandbox_nri_ads_apk` should print `package_apk: ...powder_sandbox_nri-ads-debug.apk`. Then `adb install -r` it on the emulator and `adb shell am start -W -n io.github.asdalexander77.powdersandbox/.PowderActivity`, and take a screenshot. Expected: the game draws the same as `powder_sandbox_nri.apk` with no crash in `logcat`. Uninstall afterwards (it shares the release package ID).
- [ ] **Step 5:** Check that nothing else changed. `cmake --build --preset android-x86_64 --target powder_sandbox_nri_apk` should still produce an APK with `hasCode=false` (check with `aapt2 dump badging`).
- [ ] **Step 6:** Commit: `git commit -m "powder_sandbox: Gradle-packaged ads build path (PowderActivity, no ads yet)"`.

### Task 2: Play-time schedule (pure Java, unit tested)

**Files:**
- Create: `powder_sandbox/android/java/io/github/asdalexander77/powdersandbox/SupportSchedule.java`, `powder_sandbox/android/test/io/github/asdalexander77/powdersandbox/SupportScheduleTest.java`
- Modify: `powder_sandbox/android/build.gradle` (`test.java.srcDirs ['test']`, `testImplementation 'junit:junit:4.13.2'`)

**Interfaces:**
- Produces: `final class SupportSchedule` with `interface Store { long getLong(String k, long d); boolean getBoolean(String k, boolean d); void put(String k, long v); void put(String k, boolean v); }`; `SupportSchedule(Store store, long firstMs, long repeatMs, long launchGraceMs)`; `void addPlayTime(long ms)`; `boolean isDue(long sinceLaunchMs, boolean adReady)`; `void onAnswered()`; constants `FIRST_MS = 10*60_000L`, `REPEAT_MS = 20*60_000L`, `LAUNCH_GRACE_MS = 2*60_000L`. Keys: `"playMs"`, `"prompted"`.

- [ ] **Step 1: Write failing tests** (in-memory `Store` map):
  - `notDueBeforeTenMinutes`: add 599_999 → `isDue(10*60_000, true)` false; add 1 → true.
  - `repeatsEveryTwentyAfterAnswer`: add 600_000, `onAnswered()` → playMs 0; add 1_199_999 → not due; add 1 → due.
  - `declineAndWatchAreTheSame`: there is only `onAnswered()`; assert `prompted` is true and `playMs` is 0 after it.
  - `neverDueWithoutAd`: add 3_600_000 → `isDue(600_000, false)` false.
  - `neverDueInLaunchGrace`: add 3_600_000 → `isDue(119_999, true)` false, `isDue(120_000, true)` true.
  - `answeredPersistsAcrossReload`: answer, add 300_000, build a new `SupportSchedule` on the same store, then `isDue(...)` stays false until 1_200_000 total.
- [ ] **Step 2:** Run `gradle -p powder_sandbox/android testDebugUnitTest -PpowderInput=<an existing gradle-input>`. Expected: compile FAIL (no `SupportSchedule`).
- [ ] **Step 3:** Implement `SupportSchedule`. Threshold is `prompted ? repeatMs : firstMs`. It persists on every `addPlayTime` and `onAnswered`.
- [ ] **Step 4:** Run the tests again. Expected: 6 PASS.
- [ ] **Step 5:** Commit: `"powder_sandbox: support-ad play-time schedule"`.

### Task 3: Consent, dialog and rewarded ad in PowderActivity

**Files:**
- Create: `powder_sandbox/android/java/io/github/asdalexander77/powdersandbox/SupportAds.java`
- Modify: `PowderActivity.java`, `build.gradle` (deps `play-services-ads`, `user-messaging-platform`, latest stable at implementation time), `AndroidManifest.xml` (`com.google.android.gms.ads.APPLICATION_ID` = `${admobAppId}`), `powder_sandbox/android/res/values/strings.xml` (new)

**Interfaces:**
- Consumes: `SupportSchedule` (Task 2), `BuildConfig.ADMOB_REWARDED_ID`, `BuildConfig.DEBUG`.
- Produces: `SupportAds(Activity a, SupportSchedule s)` with `onResume()`, `onPause()`, `onWindowFocusChanged(boolean)`. PowderActivity forwards these after `super`.

- [ ] **Step 1:** Consent. In `PowderActivity.onCreate` → `SupportAds`: `UserMessagingPlatform.getConsentInformation(...).requestConsentInfoUpdate(...)`, then `loadAndShowConsentFormIfRequired`. Only when `canRequestAds()` is true: `MobileAds.initialize`, then `MobileAds.setRequestConfiguration` with `setMaxAdContentRating(MAX_AD_CONTENT_RATING_T)` and `setTagForChildDirectedTreatment(TAG_FOR_CHILD_DIRECTED_TREATMENT_FALSE)`, then preload a `RewardedAd`. A failed load retries after 60 s, and again after each ad is shown.
- [ ] **Step 2:** Ticking. A main-thread `Handler` ticks every 1 s while resumed and focused and no dialog or ad is showing. Each tick calls `addPlayTime(elapsed)`, then `if (isDue(sinceLaunch, ad != null)) showPrompt()`. `sinceLaunch` = `SystemClock.elapsedRealtime()` minus the time at `onCreate`.
- [ ] **Step 3:** Dialog. An `AlertDialog` (`Theme.DeviceDefault.Dialog.Alert`, `setCancelable(true)`) with these strings: title "Enjoying Powder Sandbox?", message "Would you like to watch a short ad to support the app?", positive "Watch ad", negative "Not now". Any dismissal (button, back, outside tap) calls `onAnswered()` once. Watch ad → `ad.show(activity, reward -> toast "Thank you for your support!")`. `onAdFailedToShowFullScreenContent` → toast "Thanks anyway!". `onAdDismissedFullScreenContent` → preload the next ad.
- [ ] **Step 4:** Debug timer. Only when `BuildConfig.DEBUG`, the intent extra `ads_fast` (`--ez ads_fast true`) builds the schedule with 10 s / 20 s / 5 s instead.
- [ ] **Step 5:** Build `powder_sandbox_nri_ads_apk` and install it on the emulator. Launch with `adb shell am start -n io.github.asdalexander77.powdersandbox/.PowderActivity --ez ads_fast true`. Expected: the dialog appears about 10 s in. Tap Watch ad: the test rewarded ad plays, the thank-you toast shows on reward, and the game draws again after closing it (screenshot before and after shows the same scene). Tap Not now: the next prompt comes about 20 s later.
- [ ] **Step 6:** Review Focus checks on the emulator. (a) Rotate (`adb emu rotate`) with the dialog up: it stays, and the buttons work. (b) After the ad closes, `logcat` shows no `FATAL`/`AndroidRuntime` lines and the game still responds to a tap. (c) Kill the process (`am force-stop`) after answering, relaunch with `ads_fast`: no prompt before 20 s of play.
- [ ] **Step 7:** Offline. `adb shell svc wifi disable; svc data disable`, cold launch with `ads_fast`, wait 60 s. Expected: no dialog, no crash. Re-enable networking. Expected: the dialog appears within about 70 s (retry plus tick).
- [ ] **Step 8:** Commit: `"powder_sandbox: opt-in rewarded support ad with UMP consent"`.

### Task 4: Release through Gradle

**Files:**
- Modify: `CMakeLists.txt` (`add_tslang_android_release`: with `GRADLE`, `<name>_release` calls `package_apk.py --gradle --gradle-task release` with the existing release arguments), `tools/package_apk.py`, `powder_sandbox/powder_sandbox.cmake` (`VERSION_CODE 11`, `VERSION_NAME 0.8`)

**Interfaces:**
- Consumes: Task 1's `--gradle` path.
- Produces: `--gradle-task release` runs `bundleRelease assembleRelease` and copies them to `--bundle` / `--out`. IDs come from `os.environ` `POWDER_ADMOB_APP_ID` / `POWDER_ADMOB_REWARDED_ID` into `build.properties`.

- [ ] **Step 1:** Implement the ID choice in `package_apk.py`: `admob_ids(release: bool) -> (app_id, rewarded_id, from_env: bool)`. Debug always returns the test IDs. Release returns the env values when both are set; otherwise it returns the test IDs and prints `package_apk: WARNING: POWDER_ADMOB_APP_ID / POWDER_ADMOB_REWARDED_ID not set — this release shows Google's TEST ads`.
- [ ] **Step 2:** Run `powder_sandbox\config_release_apk_for_deployment.bat`, then `build_release_apk_for_deployment.bat`, with the keystore passwords set and without the ID vars. Expected: the WARNING line appears, and `bin/powder_sandbox_nri-release.aab`, `-release.apk` and `-native-debug-symbols.zip` exist.
- [ ] **Step 3:** Verify the outputs. `java -jar <build>/android/bundletool.jar validate --bundle bin/powder_sandbox_nri-release.aab` should pass. `apksigner verify --print-certs bin/powder_sandbox_nri-release.apk` should show the upload key. `aapt2 dump badging` should show both ABIs, `versionCode='11'` and the `INTERNET` and `AD_ID` permissions. If the user has no keystore passwords at hand, ask them to run Step 2 instead.
- [ ] **Step 4:** Install the release APK on the emulator and launch it. Expected: the game runs. No ad check is needed here (the 10-minute timer).
- [ ] **Step 5:** Run the Android ctest regression: `python tools/android.py ctest -R powder_sandbox_nri` (or the repo's usual headless invocation). Expected: the same pass list as on `main`.
- [ ] **Step 6:** Commit: `"powder_sandbox: release built by Gradle with AdMob (v0.8)"`.

### Task 5: Store paperwork and docs

**Files:**
- Modify: `powder_sandbox/store/PRIVACY.md`, `powder_sandbox/store/README.md`, `powder_sandbox/README.md`
- Create: `powder_sandbox/store/listing/en-US/changelogs/11.txt`

- [ ] **Step 1:** PRIVACY.md. Replace "No data collected / No internet / No permissions" with accurate text. The app shows optional ads through Google AdMob, which uses the internet and the device's advertising ID and may collect device and usage information as described in Google's policy (link https://policies.google.com/technologies/partner-sites). Players in the EEA/UK/Switzerland are asked for consent first. Ads are only shown when the player chooses to watch one. Keep the on-device-data paragraph. Update the effective date to the commit date.
- [ ] **Step 2:** store/README.md, Play Console checklist. Ads: "Contains ads". Target audience: 13+ (not children). Data safety: Device or other IDs, collected and shared, for Advertising (by the AdMob SDK), and the same for app interactions/diagnostics as AdMob's disclosure guide lists. AdMob account: create the app and a rewarded unit, then set `POWDER_ADMOB_APP_ID` / `POWDER_ADMOB_REWARDED_ID` before `build_release_apk_for_deployment.bat`. Also add `app-ads.txt`. Follow-up: add a privacy-options entry point.
- [ ] **Step 3:** changelogs/11.txt (one line): "Optional: after a while of play the app asks whether you'd like to watch an ad to support it. You can always say no." Add a README line on the `_ads_apk` debug target and the `ads_fast` extra.
- [ ] **Step 4:** Commit: `"powder_sandbox: privacy policy and store notes for support ads"`.
