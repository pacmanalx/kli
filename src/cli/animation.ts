import type { Look, Pose } from "./mascot.ts";

/**
 * What the golem does, from what Kli is doing. It says hello when Kli opens, blinks every 3 s, waves every 30 s
 * while nobody types, walks while a model is asked (faster while the answer arrives, the inscription being written
 * letter by letter), shakes its head when a provider fails over to the fallback, collapses on an error and falls
 * asleep after 5 min without input.
 *
 * Only computes: the screen asks for the look at a moment and for how long it lasts, and draws again only then.
 */
export type Activity = "idle" | "waiting" | "streaming" | "error";

export const TIMING = {
  blinkEvery: 3000,
  blinkFor: 150,
  hello: 1200,
  waveEvery: 30_000,
  wave: 1600,
  waveStep: 200,
  walkStep: 200,
  runStep: 120,
  writeStep: 240,
  shake: 600,
  shakeStep: 150,
  crouch: 250,
  sleepAfter: 5 * 60_000,
};

const WALK: Pose[] = ["step-left", "stand", "step-right", "stand"];
const WAVE: Pose[] = ["wave-up", "wave-out"];
const SHAKE: Pose[] = ["shake-left", "stand", "shake-right", "stand"];
const WRITING: Look["lit"][] = [1, 2, 3, 3];

export class Animator {
  private activity: Activity = "idle";
  private since: number;
  /** The last key, or the end of the last activity: the idle clock (waves, sleep) counts from here. */
  private quiet: number;
  private helloUntil: number;
  private shakeFrom = 0;

  constructor(
    private readonly start: number,
    private readonly enabled = true,
  ) {
    this.since = this.quiet = start;
    this.helloUntil = start + TIMING.hello;
  }

  /** Follows Kli's status; a new activity restarts its clock. */
  sync(activity: Activity, now: number): void {
    if (activity === this.activity) return;
    this.activity = activity;
    this.since = this.quiet = now;
    this.helloUntil = 0;
  }

  /** A key was pressed: no waving while someone types, and the golem wakes up. */
  input(now: number): void {
    this.quiet = now;
    this.helloUntil = 0;
  }

  /** A provider failed and the fallback was asked. */
  fallback(now: number): void {
    this.shakeFrom = now;
  }

  /** The look at `now` and how many ms it lasts (Infinity: until something happens). */
  look(now: number): { look: Look; next: number } {
    if (!this.enabled)
      return { look: this.activity === "error" ? { pose: "stand", eyes: false, lit: 0, dead: true } : { pose: "stand", eyes: true, lit: 3 }, next: Infinity };

    if (this.activity === "error") {
      const t = now - this.since;
      return t < TIMING.crouch
        ? { look: { pose: "crouch", eyes: false, lit: 0, dead: true }, next: TIMING.crouch - t }
        : { look: { pose: "sit", eyes: false, lit: 0, dead: true }, next: Infinity };
    }
    if (this.activity === "idle" && now - this.quiet >= TIMING.sleepAfter) return { look: { pose: "stand", eyes: false, lit: 0 }, next: Infinity };

    // every pending change adds how far away it is; the nearest one is when to draw again
    const changes: number[] = [];
    const frame = <T>(sequence: T[], step: number, t: number): T => {
      changes.push(step - (t % step));
      return sequence[Math.floor(t / step) % sequence.length]!;
    };

    const b = (now - this.start) % TIMING.blinkEvery;
    const blinking = b >= TIMING.blinkEvery - TIMING.blinkFor;
    changes.push(blinking ? TIMING.blinkEvery - b : TIMING.blinkEvery - TIMING.blinkFor - b);

    let pose: Pose = "stand";
    let lit: Look["lit"] = 3;
    if (this.activity === "idle") {
      const t = now - this.quiet;
      if (now < this.helloUntil) {
        pose = frame(WAVE, TIMING.waveStep, now - this.start);
        changes.push(this.helloUntil - now);
      } else {
        const cycle = t % TIMING.waveEvery;
        if (t >= TIMING.waveEvery && cycle < TIMING.wave) {
          pose = frame(WAVE, TIMING.waveStep, cycle);
          changes.push(TIMING.wave - cycle);
        } else changes.push(TIMING.waveEvery - cycle);
        changes.push(TIMING.sleepAfter - t);
      }
    } else {
      const t = now - this.since;
      const shaking = now - this.shakeFrom;
      if (shaking < TIMING.shake) {
        pose = frame(SHAKE, TIMING.shakeStep, shaking);
        changes.push(TIMING.shake - shaking);
      } else if (this.activity === "waiting") pose = frame(WALK, TIMING.walkStep, t);
      else {
        pose = frame(WALK, TIMING.runStep, t);
        lit = frame(WRITING, TIMING.writeStep, t);
      }
    }
    return { look: { pose, eyes: !blinking, lit }, next: Math.max(1, Math.min(...changes)) };
  }
}
