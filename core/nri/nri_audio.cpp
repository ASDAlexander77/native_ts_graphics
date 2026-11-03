// Sound for the NRI examples: a playback device on the default output (miniaudio: WASAPI on
// Windows, AAudio or OpenSL ES on Android) and a few sounds synthesized from noise and a sine (no
// audio files), mixed in its callback. Nri_CreateAudio, Nri_PlaySound, Nri_DestroyAudio
// (core/nri/nri_interop.d.ts).

#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#include <miniaudio.h>

#include <cmath>
#include <cstdint>
#include <mutex>

#ifdef _WIN32
#define NRI_INTEROP_API __declspec(dllexport)
#else
#define NRI_INTEROP_API __attribute__((visibility("default")))
#endif

namespace
{
    constexpr int SAMPLE_RATE = 48000;
    constexpr int MAX_VOICES = 24;

    // Nri_PlaySound's sounds, and how long each lasts (seconds).
    enum Sound
    {
        SOUND_SPLASH,
        SOUND_FIZZ,
        SOUND_CRACKLE,
        SOUND_BOOM,
        SOUND_COUNT
    };
    constexpr float SOUND_LENGTHS[SOUND_COUNT] = { 0.5f, 0.6f, 0.25f, 1.5f };

    struct Voice
    {
        int sound = -1;
        float time = 0.0f;
        float volume = 0.0f;
        float pitch = 1.0f;
        float phase = 0.0f;
        // One-pole filters' states (and the crackle's click).
        float low = 0.0f;
        float click = 0.0f;
        uint32_t seed = 1;
    };

    struct Audio
    {
        ma_device device;
        Voice voices[MAX_VOICES];
        // Started by Nri_PlaySound, taken into voices by the callback (which only tries the lock).
        std::mutex mutex;
        Voice started[MAX_VOICES];
        int startedCount = 0;
        // (each voice's noise its own)
        uint32_t seeds = 0;
    };

    // White noise, -1 .. 1.
    float Noise(uint32_t& seed)
    {
        seed = seed * 1664525u + 1013904223u;
        return float(seed >> 8) * (2.0f / 16777216.0f) - 1.0f;
    }

    // A voice's next sample (dt: a sample's time).
    float Sample(Voice& v, float dt)
    {
        const float t = v.time;
        float out = 0.0f;
        switch (v.sound)
        {
        case SOUND_SPLASH:
        {
            // Noise low-passed, its cutoff falling as it fades: a splash.
            const float cutoff = (0.04f + 0.3f * expf(-t * 8.0f)) * v.pitch;
            v.low += fminf(cutoff, 1.0f) * (Noise(v.seed) - v.low);
            out = 2.5f * v.low * expf(-t * 10.0f) * (1.0f - expf(-t * 400.0f));
            break;
        }
        case SOUND_FIZZ:
        {
            // Noise high-passed, flickering: acid eating, water on lava.
            const float n = Noise(v.seed);
            v.low += 0.3f * (n - v.low);
            out = 0.7f * (n - v.low) * expf(-t * 4.0f) * (0.6f + 0.4f * Noise(v.seed));
            break;
        }
        case SOUND_CRACKLE:
        {
            // Sharp clicks now and then: fire.
            if (Noise(v.seed) > 0.996f)
            {
                v.click = 1.0f;
            }
            v.click *= 0.92f;
            out = v.click * Noise(v.seed) * expf(-t * 6.0f);
            break;
        }
        case SOUND_BOOM:
        {
            // A low thump falling in pitch, under rumbling noise: gunpowder.
            const float frequency = 45.0f * v.pitch * (1.0f + 2.0f * expf(-t * 10.0f));
            v.phase += frequency * dt;
            v.phase -= floorf(v.phase);
            v.low += 0.02f * (Noise(v.seed) - v.low);
            out = (0.8f * sinf(6.2831853f * v.phase) + 3.0f * v.low) * expf(-t * 3.0f) * (1.0f - expf(-t * 200.0f));
            break;
        }
        default:
            break;
        }
        v.time += dt;
        return out * v.volume;
    }

    void Mix(ma_device* device, void* output, const void*, ma_uint32 frames)
    {
        Audio* audio = static_cast<Audio*>(device->pUserData);
        if (audio->mutex.try_lock())
        {
            for (int s = 0; s < audio->startedCount; s++)
            {
                for (Voice& voice : audio->voices)
                {
                    if (voice.sound < 0)
                    {
                        voice = audio->started[s];
                        break;
                    }
                }
            }
            audio->startedCount = 0;
            audio->mutex.unlock();
        }
        float* out = static_cast<float*>(output);
        const float dt = 1.0f / float(device->sampleRate);
        for (ma_uint32 f = 0; f < frames; f++)
        {
            float sum = 0.0f;
            for (Voice& voice : audio->voices)
            {
                if (voice.sound < 0)
                {
                    continue;
                }
                sum += Sample(voice, dt);
                if (voice.time >= SOUND_LENGTHS[voice.sound])
                {
                    voice.sound = -1;
                }
            }
            // (soft-clipped: many voices at once stay in range)
            const float value = tanhf(sum);
            out[f * 2] = value;
            out[f * 2 + 1] = value;
        }
    }
}

extern "C"
{
    // A playback device on the default output, started; null if there's none or it won't start.
    NRI_INTEROP_API Audio* Nri_CreateAudio()
    {
        Audio* audio = new Audio();
        ma_device_config config = ma_device_config_init(ma_device_type_playback);
        config.playback.format = ma_format_f32;
        config.playback.channels = 2;
        config.sampleRate = SAMPLE_RATE;
        config.dataCallback = Mix;
        config.pUserData = audio;
        if (ma_device_init(nullptr, &config, &audio->device) != MA_SUCCESS)
        {
            delete audio;
            return nullptr;
        }
        if (ma_device_start(&audio->device) != MA_SUCCESS)
        {
            ma_device_uninit(&audio->device);
            delete audio;
            return nullptr;
        }
        return audio;
    }

    // Starts a sound (0 splash, 1 fizz, 2 crackle, 3 boom) at volume (0 .. 1) and pitch (1 its own);
    // dropped when MAX_VOICES are already starting.
    NRI_INTEROP_API void Nri_PlaySound(Audio* audio, int sound, double volume, double pitch)
    {
        if (sound < 0 || sound >= SOUND_COUNT)
        {
            return;
        }
        std::lock_guard<std::mutex> lock(audio->mutex);
        if (audio->startedCount >= MAX_VOICES)
        {
            return;
        }
        Voice& voice = audio->started[audio->startedCount++];
        voice = Voice();
        voice.sound = sound;
        voice.volume = float(fmin(fmax(volume, 0.0), 1.0));
        voice.pitch = float(fmax(pitch, 0.1));
        voice.seed = 0x9E3779B9u * ++audio->seeds + 1u;
    }

    NRI_INTEROP_API void Nri_DestroyAudio(Audio* audio)
    {
        ma_device_uninit(&audio->device);
        delete audio;
    }
}
