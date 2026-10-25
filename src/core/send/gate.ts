/**
 * Bulkhead: bounds how much of this process one SMTP account may use, in two tiers.
 *
 *   active   at most `activeLimit` jobs run at once for the account. This is sized to the SMTP connection pool, so an
 *            email is only CLAIMED (status "sending") when a connection is about to be free. Without it a slow server
 *            (say 3 s per message) leaves hundreds of emails marked "sending" while they merely queue inside the SMTP
 *            library, which misreports their state and, past the reaper's lease, gets live mails re-queued as duplicates.
 *   waiting  up to `maxWaiters` further jobs PARK here in memory (no claim, no Redis traffic) for up to `timeoutMs`.
 *            Parking is cheap, bouncing a job through Redis is not.
 *
 * Beyond both tiers (or after the timeout) acquire() returns false and the caller defers the job, so one slow account can
 * never occupy more than activeLimit + maxWaiters of the process's job slots: other tenants keep flowing.
 */
export class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  get inUse(): number {
    return this.active;
  }
  get parked(): number {
    return this.waiters.length;
  }

  async acquire(activeLimit: number, maxWaiters: number, timeoutMs: number): Promise<boolean> {
    if (this.active < activeLimit) {
      this.active++;
      return true;
    }
    if (this.waiters.length >= maxWaiters) return false;
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true); // the slot is handed over directly: `active` stays the same
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

export class GateRegistry {
  private readonly gates = new Map<string, Gate>();
  for(key: string): Gate {
    const existing = this.gates.get(key);
    if (existing) return existing;
    const gate = new Gate();
    this.gates.set(key, gate);
    return gate;
  }
}
