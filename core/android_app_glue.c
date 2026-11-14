/*
 * Copyright (C) 2010 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The NDK's android_native_app_glue (sources/android/native_app_glue), changed so that the app's
// thread - the one running android_main, and the example's TypeScript main in it - outlives the
// activity it started with. Its struct android_app, its commands and its looper sources are the
// NDK's (android_native_app_glue.h), so GLFW's Android platform and core/android_main.cpp use it
// as they would the NDK's.
//
// The NDK's glue makes an android_app and a thread per activity, and an activity's onDestroy
// waits for android_main to return. Android destroys and creates the activity again for any
// configuration change the manifest doesn't declare in android:configChanges, and for some no
// app can declare (CONFIG_ASSETS_PATHS, when Play services, WebView or a theme overlay are
// updated), which with the NDK's glue ended the example: a TypeScript program runs only once per
// process. Here:
//   - the first activity makes the one android_app, its command pipe and its thread;
//   - an activity destroyed but not finishing (a relaunch) only lets go of the android_app: its
//     onDestroy waits for the app's thread to take app->activity away (APP_CMD_DETACH below), so
//     that nothing calls into the activity after Android has freed it, not for android_main to
//     return;
//   - the next activity takes the android_app over (app->activity is its, and the app is told of
//     the configuration it may have changed: APP_CMD_CONFIG_CHANGED), and its window, input queue
//     and state reach the app as the first activity's did;
//   - only an activity that is finishing (Back, Activity.finish) sends APP_CMD_DESTROY
//     (destroyRequested), and waits for android_main to return, as the NDK's does.
// Callbacks from an activity that isn't the app's (one destroyed already) are ignored.
//
// app->activity is NULL between two activities; it is only changed on the app's thread (while it
// runs a command), so code on that thread can use it between two looper polls.

#include "android_native_app_glue.h"

#include <jni.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <android/log.h>

#define LOGI(...) ((void)__android_log_print(ANDROID_LOG_INFO, "threaded_app", __VA_ARGS__))
#define LOGE(...) ((void)__android_log_print(ANDROID_LOG_ERROR, "threaded_app", __VA_ARGS__))

// The app's own commands, after the NDK's (which GLFW's handler ignores, as any it doesn't know).
enum
{
    // The activity is being destroyed but not finishing: app->activity becomes NULL.
    APP_CMD_DETACH = 100,
    // Another activity takes the app over: app->activity becomes pendingActivity.
    APP_CMD_ATTACH = 101,
};

// The one android_app of the process, made by the first activity.
static struct android_app* g_App = NULL;
// The activity APP_CMD_ATTACH hands the app to (under the app's mutex).
static ANativeActivity* g_PendingActivity = NULL;

static void free_saved_state(struct android_app* android_app) {
    pthread_mutex_lock(&android_app->mutex);
    if (android_app->savedState != NULL) {
        free(android_app->savedState);
        android_app->savedState = NULL;
        android_app->savedStateSize = 0;
    }
    pthread_mutex_unlock(&android_app->mutex);
}

int8_t android_app_read_cmd(struct android_app* android_app) {
    int8_t cmd;
    if (read(android_app->msgread, &cmd, sizeof(cmd)) != sizeof(cmd)) {
        LOGE("No data on command pipe!");
        return -1;
    }
    if (cmd == APP_CMD_SAVE_STATE) free_saved_state(android_app);
    return cmd;
}

static void update_config(struct android_app* android_app) {
    if (android_app->activity != NULL)
        AConfiguration_fromAssetManager(android_app->config, android_app->activity->assetManager);
}

void android_app_pre_exec_cmd(struct android_app* android_app, int8_t cmd) {
    switch (cmd) {
        case APP_CMD_INPUT_CHANGED:
            pthread_mutex_lock(&android_app->mutex);
            if (android_app->inputQueue != NULL) {
                AInputQueue_detachLooper(android_app->inputQueue);
            }
            android_app->inputQueue = android_app->pendingInputQueue;
            if (android_app->inputQueue != NULL) {
                AInputQueue_attachLooper(android_app->inputQueue,
                        android_app->looper, LOOPER_ID_INPUT, NULL,
                        &android_app->inputPollSource);
            }
            pthread_cond_broadcast(&android_app->cond);
            pthread_mutex_unlock(&android_app->mutex);
            break;

        case APP_CMD_INIT_WINDOW:
            pthread_mutex_lock(&android_app->mutex);
            android_app->window = android_app->pendingWindow;
            pthread_cond_broadcast(&android_app->cond);
            pthread_mutex_unlock(&android_app->mutex);
            break;

        case APP_CMD_TERM_WINDOW:
            pthread_cond_broadcast(&android_app->cond);
            break;

        case APP_CMD_RESUME:
        case APP_CMD_START:
        case APP_CMD_PAUSE:
        case APP_CMD_STOP:
            pthread_mutex_lock(&android_app->mutex);
            android_app->activityState = cmd;
            pthread_cond_broadcast(&android_app->cond);
            pthread_mutex_unlock(&android_app->mutex);
            break;

        case APP_CMD_CONFIG_CHANGED:
            update_config(android_app);
            break;

        case APP_CMD_DESTROY:
            android_app->destroyRequested = 1;
            break;

        case APP_CMD_DETACH:
            pthread_mutex_lock(&android_app->mutex);
            android_app->activity = NULL;
            pthread_cond_broadcast(&android_app->cond);
            pthread_mutex_unlock(&android_app->mutex);
            break;

        case APP_CMD_ATTACH:
            pthread_mutex_lock(&android_app->mutex);
            android_app->activity = g_PendingActivity;
            g_PendingActivity = NULL;
            // a new activity starts in the state the NDK's glue's would (none of its callbacks
            // ran yet), and may come with another configuration
            android_app->activityState = 0;
            android_app->stateSaved = 0;
            update_config(android_app);
            pthread_cond_broadcast(&android_app->cond);
            pthread_mutex_unlock(&android_app->mutex);
            break;
    }
}

void android_app_post_exec_cmd(struct android_app* android_app, int8_t cmd) {
    switch (cmd) {
        case APP_CMD_TERM_WINDOW:
            pthread_mutex_lock(&android_app->mutex);
            android_app->window = NULL;
            pthread_cond_broadcast(&android_app->cond);
            pthread_mutex_unlock(&android_app->mutex);
            break;

        case APP_CMD_SAVE_STATE:
            pthread_mutex_lock(&android_app->mutex);
            android_app->stateSaved = 1;
            pthread_cond_broadcast(&android_app->cond);
            pthread_mutex_unlock(&android_app->mutex);
            break;

        case APP_CMD_RESUME:
            free_saved_state(android_app);
            break;
    }
}

void app_dummy() {
}

static void android_app_destroy(struct android_app* android_app) {
    free_saved_state(android_app);
    pthread_mutex_lock(&android_app->mutex);
    if (android_app->inputQueue != NULL) {
        AInputQueue_detachLooper(android_app->inputQueue);
    }
    AConfiguration_delete(android_app->config);
    android_app->destroyed = 1;
    pthread_cond_broadcast(&android_app->cond);
    pthread_mutex_unlock(&android_app->mutex);
    // Can't touch android_app object after this.
}

static void process_input(struct android_app* app, struct android_poll_source* source) {
    AInputEvent* event = NULL;
    while (AInputQueue_getEvent(app->inputQueue, &event) >= 0) {
        if (AInputQueue_preDispatchEvent(app->inputQueue, event)) {
            continue;
        }
        int32_t handled = 0;
        if (app->onInputEvent != NULL) handled = app->onInputEvent(app, event);
        AInputQueue_finishEvent(app->inputQueue, event, handled);
    }
}

static void process_cmd(struct android_app* app, struct android_poll_source* source) {
    int8_t cmd = android_app_read_cmd(app);
    android_app_pre_exec_cmd(app, cmd);
    if (app->onAppCmd != NULL) app->onAppCmd(app, cmd);
    android_app_post_exec_cmd(app, cmd);
}

static void* android_app_entry(void* param) {
    struct android_app* android_app = (struct android_app*)param;

    android_app->config = AConfiguration_new();
    update_config(android_app);

    android_app->cmdPollSource.id = LOOPER_ID_MAIN;
    android_app->cmdPollSource.app = android_app;
    android_app->cmdPollSource.process = process_cmd;
    android_app->inputPollSource.id = LOOPER_ID_INPUT;
    android_app->inputPollSource.app = android_app;
    android_app->inputPollSource.process = process_input;

    ALooper* looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
    ALooper_addFd(looper, android_app->msgread, LOOPER_ID_MAIN, ALOOPER_EVENT_INPUT, NULL,
            &android_app->cmdPollSource);
    android_app->looper = looper;

    pthread_mutex_lock(&android_app->mutex);
    android_app->running = 1;
    pthread_cond_broadcast(&android_app->cond);
    pthread_mutex_unlock(&android_app->mutex);

    android_main(android_app);

    android_app_destroy(android_app);
    return NULL;
}

// --------------------------------------------------------------------
// Native activity interaction (called from main thread)
// --------------------------------------------------------------------

static struct android_app* android_app_create(ANativeActivity* activity,
                                              void* savedState, size_t savedStateSize) {
    struct android_app* android_app = calloc(1, sizeof(struct android_app));
    android_app->activity = activity;

    pthread_mutex_init(&android_app->mutex, NULL);
    pthread_cond_init(&android_app->cond, NULL);

    if (savedState != NULL) {
        android_app->savedState = malloc(savedStateSize);
        android_app->savedStateSize = savedStateSize;
        memcpy(android_app->savedState, savedState, savedStateSize);
    }

    int msgpipe[2];
    if (pipe(msgpipe)) {
        LOGE("could not create pipe: %s", strerror(errno));
        return NULL;
    }
    android_app->msgread = msgpipe[0];
    android_app->msgwrite = msgpipe[1];

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_create(&android_app->thread, &attr, android_app_entry, android_app);

    // Wait for thread to start.
    pthread_mutex_lock(&android_app->mutex);
    while (!android_app->running) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }
    pthread_mutex_unlock(&android_app->mutex);

    return android_app;
}

static void android_app_write_cmd(struct android_app* android_app, int8_t cmd) {
    if (write(android_app->msgwrite, &cmd, sizeof(cmd)) != sizeof(cmd)) {
        LOGE("Failure writing android_app cmd: %s", strerror(errno));
    }
}

// The app's thread has run its last command (android_main returned): no handshake would end.
static int android_app_gone(struct android_app* android_app) {
    return android_app->destroyed;
}

static void android_app_set_input(struct android_app* android_app, AInputQueue* inputQueue) {
    pthread_mutex_lock(&android_app->mutex);
    android_app->pendingInputQueue = inputQueue;
    android_app_write_cmd(android_app, APP_CMD_INPUT_CHANGED);
    while (android_app->inputQueue != android_app->pendingInputQueue && !android_app_gone(android_app)) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }
    pthread_mutex_unlock(&android_app->mutex);
}

static void android_app_set_window(struct android_app* android_app, ANativeWindow* window) {
    pthread_mutex_lock(&android_app->mutex);
    if (android_app->pendingWindow != NULL) {
        android_app_write_cmd(android_app, APP_CMD_TERM_WINDOW);
    }
    android_app->pendingWindow = window;
    if (window != NULL) {
        android_app_write_cmd(android_app, APP_CMD_INIT_WINDOW);
    }
    while (android_app->window != android_app->pendingWindow && !android_app_gone(android_app)) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }
    pthread_mutex_unlock(&android_app->mutex);
}

static void android_app_set_activity_state(struct android_app* android_app, int8_t cmd) {
    pthread_mutex_lock(&android_app->mutex);
    android_app_write_cmd(android_app, cmd);
    while (android_app->activityState != cmd && !android_app_gone(android_app)) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }
    pthread_mutex_unlock(&android_app->mutex);
}

// Activity.isFinishing(), on the activity's thread: Back, or finish(); not a relaunch.
static int is_finishing(ANativeActivity* activity) {
    JNIEnv* env = activity->env;
    jclass activityClass = (*env)->GetObjectClass(env, activity->clazz);
    jmethodID isFinishing = (*env)->GetMethodID(env, activityClass, "isFinishing", "()Z");
    int finishing = 1;
    if (isFinishing != NULL && !(*env)->ExceptionCheck(env))
        finishing = (*env)->CallBooleanMethod(env, activity->clazz, isFinishing) ? 1 : 0;
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
        finishing = 1;
    }
    (*env)->DeleteLocalRef(env, activityClass);
    return finishing;
}

// The activity finishes: android_main is asked to return (destroyRequested), and is waited for.
static void android_app_free(struct android_app* android_app) {
    pthread_mutex_lock(&android_app->mutex);
    android_app_write_cmd(android_app, APP_CMD_DESTROY);
    while (!android_app->destroyed) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }
    pthread_mutex_unlock(&android_app->mutex);

    // The app's state stays (android_main doesn't run again in this process; core/android_main.cpp
    // ends it), so that callbacks still to come find it.
}

// The activity is destroyed to be made again: the app lets go of it and goes on running.
static void android_app_detach(struct android_app* android_app) {
    pthread_mutex_lock(&android_app->mutex);
    android_app_write_cmd(android_app, APP_CMD_DETACH);
    while (android_app->activity != NULL && !android_app_gone(android_app)) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }
    pthread_mutex_unlock(&android_app->mutex);
    LOGI("The activity was destroyed to be made again: the app goes on without it");
}

// A new activity takes the app over (after the last one's detached).
static void android_app_attach(struct android_app* android_app, ANativeActivity* activity) {
    pthread_mutex_lock(&android_app->mutex);
    g_PendingActivity = activity;
    android_app_write_cmd(android_app, APP_CMD_ATTACH);
    while (android_app->activity != activity && !android_app_gone(android_app)) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }
    pthread_mutex_unlock(&android_app->mutex);
    // its configuration (font scale, density, ...) may differ from the last one's
    android_app_write_cmd(android_app, APP_CMD_CONFIG_CHANGED);
    LOGI("A new activity took the app over");
}

// The app, if the activity is the one it runs with (callbacks of any other are ignored).
static struct android_app* ToApp(ANativeActivity* activity) {
    struct android_app* app = (struct android_app*) activity->instance;
    if (app == NULL || app->activity != activity || android_app_gone(app))
        return NULL;
    return app;
}

static void onDestroy(ANativeActivity* activity) {
    struct android_app* app = ToApp(activity);
    activity->instance = NULL;
    if (app == NULL)
        return;
    if (is_finishing(activity))
        android_app_free(app);
    else
        android_app_detach(app);
}

static void onStart(ANativeActivity* activity) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_activity_state(app, APP_CMD_START);
}

static void onResume(ANativeActivity* activity) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_activity_state(app, APP_CMD_RESUME);
}

static void* onSaveInstanceState(ANativeActivity* activity, size_t* outLen) {
    struct android_app* android_app = ToApp(activity);
    void* savedState = NULL;
    if (android_app == NULL)
        return NULL;

    pthread_mutex_lock(&android_app->mutex);
    android_app->stateSaved = 0;
    android_app_write_cmd(android_app, APP_CMD_SAVE_STATE);
    while (!android_app->stateSaved && !android_app_gone(android_app)) {
        pthread_cond_wait(&android_app->cond, &android_app->mutex);
    }

    if (android_app->savedState != NULL) {
        savedState = android_app->savedState;
        *outLen = android_app->savedStateSize;
        android_app->savedState = NULL;
        android_app->savedStateSize = 0;
    }

    pthread_mutex_unlock(&android_app->mutex);

    return savedState;
}

static void onPause(ANativeActivity* activity) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_activity_state(app, APP_CMD_PAUSE);
}

static void onStop(ANativeActivity* activity) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_activity_state(app, APP_CMD_STOP);
}

static void onConfigurationChanged(ANativeActivity* activity) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_write_cmd(app, APP_CMD_CONFIG_CHANGED);
}

static void onContentRectChanged(ANativeActivity* activity, const ARect* r) {
    struct android_app* android_app = ToApp(activity);
    if (android_app == NULL)
        return;
    pthread_mutex_lock(&android_app->mutex);
    android_app->contentRect = *r;
    pthread_mutex_unlock(&android_app->mutex);
    android_app_write_cmd(android_app, APP_CMD_CONTENT_RECT_CHANGED);
}

static void onLowMemory(ANativeActivity* activity) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_write_cmd(app, APP_CMD_LOW_MEMORY);
}

static void onWindowFocusChanged(ANativeActivity* activity, int focused) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_write_cmd(app, focused ? APP_CMD_GAINED_FOCUS : APP_CMD_LOST_FOCUS);
}

static void onNativeWindowCreated(ANativeActivity* activity, ANativeWindow* window) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_window(app, window);
}

static void onNativeWindowDestroyed(ANativeActivity* activity, ANativeWindow* window) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_window(app, NULL);
}

static void onNativeWindowRedrawNeeded(ANativeActivity* activity, ANativeWindow* window) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_write_cmd(app, APP_CMD_WINDOW_REDRAW_NEEDED);
}

static void onNativeWindowResized(ANativeActivity* activity, ANativeWindow* window) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_write_cmd(app, APP_CMD_WINDOW_RESIZED);
}

static void onInputQueueCreated(ANativeActivity* activity, AInputQueue* queue) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_input(app, queue);
}

static void onInputQueueDestroyed(ANativeActivity* activity, AInputQueue* queue) {
    struct android_app* app = ToApp(activity);
    if (app) android_app_set_input(app, NULL);
}

// Called by core/android_main.cpp's ANativeActivity_onCreate.
void android_app_glue_onCreate(ANativeActivity* activity, void* savedState, size_t savedStateSize) {
    activity->callbacks->onConfigurationChanged = onConfigurationChanged;
    activity->callbacks->onContentRectChanged = onContentRectChanged;
    activity->callbacks->onDestroy = onDestroy;
    activity->callbacks->onInputQueueCreated = onInputQueueCreated;
    activity->callbacks->onInputQueueDestroyed = onInputQueueDestroyed;
    activity->callbacks->onLowMemory = onLowMemory;
    activity->callbacks->onNativeWindowCreated = onNativeWindowCreated;
    activity->callbacks->onNativeWindowDestroyed = onNativeWindowDestroyed;
    activity->callbacks->onNativeWindowRedrawNeeded = onNativeWindowRedrawNeeded;
    activity->callbacks->onNativeWindowResized = onNativeWindowResized;
    activity->callbacks->onPause = onPause;
    activity->callbacks->onResume = onResume;
    activity->callbacks->onSaveInstanceState = onSaveInstanceState;
    activity->callbacks->onStart = onStart;
    activity->callbacks->onStop = onStop;
    activity->callbacks->onWindowFocusChanged = onWindowFocusChanged;

    if (g_App == NULL) {
        g_App = android_app_create(activity, savedState, savedStateSize);
    } else if (!android_app_gone(g_App)) {
        // a relaunch: the app's thread goes on, with this activity (its saved state is the app's
        // own, which it still has)
        android_app_attach(g_App, activity);
    } else {
        // android_main returned already (the example exited, the process is ending): this
        // activity has nothing to run, and finishes
        activity->instance = NULL;
        ANativeActivity_finish(activity);
        return;
    }
    activity->instance = g_App;
}
