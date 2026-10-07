// An example as an Android app: a NativeActivity (android_native_app_glue) running the example's
// TypeScript main on the glue's thread, with GLFW's Android platform giving Donut the activity's
// window (patches/glfw-android-platform.patch). Built into lib<example>.so with the example, and
// packaged with its shaders and media by tools/package_apk.py (the <example>_apk targets).

#include <android/asset_manager.h>
#include <android/log.h>
#include <android/looper.h>
#include <android/native_activity.h>
#include <android_native_app_glue.h>

#define GLFW_INCLUDE_NONE
#define GLFW_EXPOSE_NATIVE_ANDROID
#include <GLFW/glfw3.h>
#include <GLFW/glfw3native.h>

#include <dlfcn.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

// The example's TypeScript entry point: a C symbol named main, which clang's -Wmain flags in a
// declaration (it is only declared here, never defined)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmain"
extern "C" int main(int argc, char** argv);
#pragma clang diagnostic pop

// core/donut_interop.cpp
extern "C" void Donut_SetExecutablePath(const char* path);

// android_native_app_glue.c is compiled with its ANativeActivity_onCreate renamed to this (see
// add_tslang_example in CMakeLists.txt), so that the one below runs first
extern "C" void glue_ANativeActivity_onCreate(ANativeActivity* activity, void* savedState, size_t savedStateSize);

#if TSLANG_MEMORY_MODEL_GC
// Boehm's thread registration (gc.h, which tslang doesn't install); the stack base is one
// pointer on arm64 and x86_64
extern "C"
{
    struct GC_stack_base
    {
        void* mem_base;
    };

    int GC_is_init_called(void);
    void GC_init(void);
    void GC_allow_register_threads(void);
    int GC_get_stack_base(struct GC_stack_base*);
    int GC_register_my_thread(const struct GC_stack_base*);
    int GC_unregister_my_thread(void);
}

constexpr int GC_SUCCESS = 0;
#endif

namespace
{
    std::string g_LogTag = "donut";

    // The name of this library, lib<name>.so: the example's name
    std::string LibraryName()
    {
        Dl_info info = {};
        if (!dladdr(reinterpret_cast<void*>(&LibraryName), &info) || !info.dli_fname)
            return "app";

        std::string name = std::filesystem::path(info.dli_fname).stem().string();
        if (name.rfind("lib", 0) == 0)
            name = name.substr(3);
        return name;
    }

    // Everything the program prints - TypeScript's print and console.log, Donut's log - goes to
    // stdout and stderr, which an app's process sends nowhere: copy both into logcat, line by line.
    int g_StdioPipe[2] = { -1, -1 };

    void* StdioToLogcat(void*)
    {
        std::string line;
        char buffer[1024];
        for (;;)
        {
            const ssize_t count = read(g_StdioPipe[0], buffer, sizeof(buffer));
            if (count <= 0)
                break;

            for (ssize_t i = 0; i < count; ++i)
            {
                if (buffer[i] == '\n')
                {
                    __android_log_write(ANDROID_LOG_INFO, g_LogTag.c_str(), line.c_str());
                    line.clear();
                }
                else
                    line += buffer[i];
            }
        }
        return nullptr;
    }

    void RedirectStdioToLogcat()
    {
        if (pipe(g_StdioPipe) != 0)
            return;

        setvbuf(stdout, nullptr, _IOLBF, 0);
        setvbuf(stderr, nullptr, _IONBF, 0);
        dup2(g_StdioPipe[1], STDOUT_FILENO);
        dup2(g_StdioPipe[1], STDERR_FILENO);

        // A plain thread: it never touches the collector's heap, so the collector needn't know it
        pthread_t thread;
        if (pthread_create(&thread, nullptr, StdioToLogcat, nullptr) == 0)
            pthread_detach(thread);
    }

    std::string ReadAsset(AAssetManager* assets, const char* path)
    {
        AAsset* asset = AAssetManager_open(assets, path, AASSET_MODE_STREAMING);
        if (!asset)
            return {};

        std::string content;
        char buffer[64 * 1024];
        int count;
        while ((count = AAsset_read(asset, buffer, sizeof(buffer))) > 0)
            content.append(buffer, count);

        AAsset_close(asset);
        return content;
    }

    std::string ReadFile(const std::filesystem::path& path)
    {
        std::ifstream file(path, std::ios::binary);
        std::stringstream content;
        content << file.rdbuf();
        return content.str();
    }

    bool WriteFile(const std::filesystem::path& path, const std::string& content)
    {
        std::error_code ec;
        std::filesystem::create_directories(path.parent_path(), ec);
        std::ofstream file(path, std::ios::binary | std::ios::trunc);
        file.write(content.data(), std::streamsize(content.size()));
        return bool(file);
    }

    // Donut reads its shaders and media from files next to the executable, and an APK's assets
    // are no files: they are copied into the app's internal storage, which then stands in for the
    // executable's folder. assets.txt, written by tools/package_apk.py, lists them under a first
    // line that tells the build apart; a copy of it there means its files are there already.
    bool ExtractAssets(ANativeActivity* activity, const std::filesystem::path& folder)
    {
        const std::string list = ReadAsset(activity->assetManager, "assets.txt");
        if (list.empty())
        {
            fprintf(stderr, "No assets.txt in the APK: it wasn't packaged by tools/package_apk.py\n");
            return false;
        }

        const std::filesystem::path listCopy = folder / "assets.txt";
        if (ReadFile(listCopy) == list)
            return true;

        std::istringstream lines(list);
        std::string path;
        std::getline(lines, path); // the build's line
        int count = 0;
        while (std::getline(lines, path))
        {
            if (path.empty())
                continue;

            const std::string content = ReadAsset(activity->assetManager, path.c_str());
            if (!WriteFile(folder / path, content))
            {
                fprintf(stderr, "Can't extract the asset %s into %s\n", path.c_str(), folder.c_str());
                return false;
            }
            ++count;
        }

        // last, so that an interrupted extraction is done again
        WriteFile(listCopy, list);
        printf("Extracted %d assets into %s\n", count, folder.c_str());
        return true;
    }

    // Runs the activity's events (its commands, through the glue) for up to timeoutMillis
    void PumpEvents(struct android_app* app, int timeoutMillis)
    {
        int events;
        struct android_poll_source* source = nullptr;
        if (ALooper_pollOnce(timeoutMillis, nullptr, &events, reinterpret_cast<void**>(&source)) >= 0 && source)
            source->process(app, source);
    }
}

// The activity's UI thread, which is the process's main thread.
//
// GC_init takes the thread it runs on for the main thread and scans that one's stack up to the
// main stack's bottom, which it finds from /proc; on the glue's thread that would be a stack the
// thread doesn't have. So the collector starts here, and as the TypeScript code runs on the glue's
// thread, this one then leaves it (gc.h allows the main thread to unregister once): it isn't
// stopped for collections while it runs the activity's Java code. The TypeScript main's own
// GC_init then finds the collector started.
extern "C" JNIEXPORT void ANativeActivity_onCreate(ANativeActivity* activity, void* savedState, size_t savedStateSize)
{
#if TSLANG_MEMORY_MODEL_GC
    static bool collectorStarted = false;
    if (!collectorStarted)
    {
        collectorStarted = true;
        // The library's static initializers may have allocated already, which starts it as well
        if (!GC_is_init_called())
            GC_init();
        GC_allow_register_threads();
        GC_unregister_my_thread();
    }
#endif

    glue_ANativeActivity_onCreate(activity, savedState, savedStateSize);
}

extern "C" void android_main(struct android_app* app)
{
    std::string name = LibraryName();
    g_LogTag = name;
    RedirectStdioToLogcat();

    const std::filesystem::path folder = app->activity->internalDataPath;
    int result = 1;
    if (ExtractAssets(app->activity, folder))
    {
        Donut_SetExecutablePath((folder / name).c_str());
        glfwSetAndroidApp(app);

#if TSLANG_MEMORY_MODEL_GC
        struct GC_stack_base stackBase = {};
        const bool registered = GC_get_stack_base(&stackBase) == GC_SUCCESS && GC_register_my_thread(&stackBase) == GC_SUCCESS;
#endif

        std::vector<char> argv0(name.begin(), name.end());
        argv0.push_back('\0');
        char* argv[] = { argv0.data(), nullptr };
        result = main(1, argv);

#if TSLANG_MEMORY_MODEL_GC
        if (registered)
            GC_unregister_my_thread();
#endif
    }

    // An example runs once: when it returns, the activity finishes and the process ends with it,
    // as the same TypeScript program can't run again in it (its globals and the collector stay
    // as they are). Waits a while for the activity to be destroyed, so that it isn't restarted.
    printf("%s exited with %d\n", name.c_str(), result);
    ANativeActivity_finish(app->activity);
    for (int i = 0; i < 50 && !app->destroyRequested; ++i)
        PumpEvents(app, 100);

    // the last lines, through the pipe to logcat
    fflush(stdout);
    fflush(stderr);
    usleep(100 * 1000);
    exit(result);
}
