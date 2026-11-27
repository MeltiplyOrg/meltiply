interface PendingFlight<T> {
  readonly promise: Promise<T>;
  readonly settle: (value: T) => void;
}

export interface SingleFlight<T> extends PendingFlight<T> {
  readonly leader: boolean;
  readonly release: () => void;
}

export class SingleFlightGroup<T> {
  private readonly pending = new Map<string, PendingFlight<T>>();

  constructor(private readonly maxPending: number) {}

  clear(): void {
    this.pending.clear();
  }

  acquire(key: string): SingleFlight<T> | undefined {
    const existing = this.pending.get(key);
    if (existing) return { ...existing, leader: false, release: () => undefined };
    if (this.pending.size >= this.maxPending) return undefined;

    let settle!: PendingFlight<T>["settle"];
    const promise = new Promise<T>((resolve) => {
      settle = resolve;
    });
    const entry: PendingFlight<T> = { promise, settle };
    this.pending.set(key, entry);
    return {
      ...entry,
      leader: true,
      release: () => {
        if (this.pending.get(key) === entry) this.pending.delete(key);
      },
    };
  }
}
