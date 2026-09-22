// The scheduler's notion of "now" = real time + a persisted offset. Advancing the
// offset lets a demo (or test) say "it is now tomorrow 09:00" without waiting, and
// because the offset lives in the DB, the web process and the worker process agree.
// Leases (worker liveness) deliberately use REAL time, never this clock.
export class Clock {
  constructor(settingsRepo) {
    this.settings = settingsRepo;
  }
  offsetMs() {
    return Number(this.settings.get('clock_offset_ms') ?? 0);
  }
  now() {
    return Date.now() + this.offsetMs();
  }
  advance(ms) {
    this.settings.set('clock_offset_ms', String(this.offsetMs() + ms));
    return this.now();
  }
  reset() {
    this.settings.set('clock_offset_ms', '0');
    return this.now();
  }
}
