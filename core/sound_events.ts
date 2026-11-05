// Sounds for events a simulation counts (splashes, explosions, ...): a sound plays when a frame has
// enough of its events, louder the more, then not again for its cooldown (jittered, so repeats
// don't beat), its pitch varied a little, or lower the more there are (a bigger boom). The totals
// are kept for a test to check.
//
// Imported with `import { SoundEvents } from "../core/sound_events";` (add_tslang_nri_example adds
// it to the app's sources). add() each sound (in NriAudio.playSound's order), then update() each
// with a frame's events.

/// <reference path="nri/nri_interop.d.ts" />
import { NriAudio } from "./nri";

@final
export class SoundEvents {
    private minEvents: int[] = [];
    private loudEvents: int[] = [];
    private cooldownTimes: number[] = [];
    private lowerWhenMore: boolean[] = [];
    private totals: int[] = [];
    private cooldowns: number[] = [];

    // The next sound: the fewest events it needs, how many make it full volume, the time (seconds)
    // before it plays again, and whether more events lower its pitch (else it's varied at random).
    add(minEvents: int, loudEvents: int, cooldown: number, lowerWhenMore: boolean) {
        this.minEvents.push(minEvents);
        this.loudEvents.push(loudEvents);
        this.cooldownTimes.push(cooldown);
        this.lowerWhenMore.push(lowerWhenMore);
        this.totals.push(0);
        this.cooldowns.push(0.0);
    }

    count(): int {
        return this.totals.length;
    }

    // Sound k's events counted so far.
    total(k: int): int {
        return this.totals[k];
    }

    // A frame (frameTime seconds) with events of sound k's events: counted, and the sound played
    // through audio when play and they're enough and its cooldown's over.
    update(k: int, events: int, frameTime: number, audio: NriAudio | null, play: boolean) {
        this.totals[k] += events;
        this.cooldowns[k] -= frameTime;
        if (audio) {
            if (play && events >= this.minEvents[k] && this.cooldowns[k] <= 0.0) {
                const loud = this.loudEvents[k];
                const loudness = Math.min(0.25 + 0.75 * Math.log(1.0 + events) / Math.log(1.0 + loud), 1.0);
                const pitch = this.lowerWhenMore[k] ? 1.2 - 0.5 * Math.min(events / loud, 1.0) : 0.85 + 0.3 * Math.random();
                audio.playSound(k, loudness, pitch);
                this.cooldowns[k] = this.cooldownTimes[k] * (0.8 + 0.4 * Math.random());
            }
        }
    }
}
