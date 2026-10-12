/** A pause in the tab longer than this does not count as active interviewing. */
export const HIDDEN_GRACE_MS = 30_000;

/**
 * Interview timing on a monotonic clock (`performance.now()`), anchored to the server's time
 * so a wrong or changed device clock cannot distort durations. Active time leaves out pauses
 * and periods with the page hidden for more than 30 seconds.
 */
export class InterviewClock {
  private readonly origin: number;
  private readonly serverAtOrigin: number;
  private pausedAt: number | null = null;
  private hiddenAt: number | null = null;
  private excluded = 0;
  private question: { key: string; since: number } | null = null;

  constructor(
    serverTime: string,
    private readonly mono: () => number = () => performance.now(),
    /** Time already spent before this visit (from the server or the device copy). */
    private readonly carried = { activeMs: 0, totalMs: 0 },
  ) {
    this.origin = mono();
    this.serverAtOrigin = Date.parse(serverTime);
  }

  /** Milliseconds since this visit began. */
  elapsed(): number {
    return this.mono() - this.origin;
  }

  /** Wall time for an event, on the server's clock. */
  at(): { at: string; monotonicMs: number } {
    const e = this.elapsed();
    return { at: new Date(this.serverAtOrigin + e).toISOString(), monotonicMs: Math.round(e) };
  }

  totalMs(): number {
    return this.carried.totalMs + this.elapsed();
  }

  activeMs(): number {
    const now = this.mono();
    let excluded = this.excluded;
    if (this.pausedAt !== null) excluded += now - this.pausedAt;
    else if (this.hiddenAt !== null && now - this.hiddenAt > HIDDEN_GRACE_MS)
      excluded += now - this.hiddenAt;
    return Math.max(0, this.carried.activeMs + now - this.origin - excluded);
  }

  get paused() {
    return this.pausedAt !== null;
  }

  pause() {
    if (this.pausedAt === null) this.pausedAt = this.mono();
  }

  /** Returns how long the pause lasted. */
  resume(): number {
    if (this.pausedAt === null) return 0;
    const d = this.mono() - this.pausedAt;
    this.excluded += d;
    this.pausedAt = null;
    return d;
  }

  hidden() {
    if (this.hiddenAt === null) this.hiddenAt = this.mono();
  }

  /** Back on screen; returns how long it was hidden. */
  visible(): number {
    if (this.hiddenAt === null) return 0;
    const d = this.mono() - this.hiddenAt;
    if (d > HIDDEN_GRACE_MS && this.pausedAt === null) this.excluded += d;
    this.hiddenAt = null;
    return d;
  }

  /** The question on screen changed; returns the time spent on the previous one. */
  enter(key: string | null): { left: string; ms: number } | null {
    const now = this.mono();
    const prev = this.question;
    this.question = key ? { key, since: now } : null;
    return prev ? { left: prev.key, ms: Math.round(now - prev.since) } : null;
  }

  /** Time on the question now on screen. */
  onQuestionMs(): number {
    return this.question ? this.mono() - this.question.since : 0;
  }
}
