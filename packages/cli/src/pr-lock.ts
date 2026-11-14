/** Thrown when a pull request change starts while another is still running. */
export class PrBusy extends Error {}

/** Lets one pull request change run at a time: a push, pull request, merge, or test repair. */
export class PrLock {
  /** What holds the lock, such as "the merge", or null when free. */
  label: string | null = null;

  async hold<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (this.label) throw new PrBusy(`wait for ${this.label} to finish`);
    this.label = label;
    try {
      return await work();
    } finally {
      this.label = null;
    }
  }

  /** For background work that should queue behind a user's change instead of failing. */
  async whenFree(pollMs: number): Promise<void> {
    while (this.label) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
