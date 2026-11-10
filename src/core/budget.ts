/**
 * Spend guard. Every paid call must reserve its worst-case price first; the
 * reservation is settled to the actual price (or released) when the call ends.
 * Reservations make the guard safe under parallel fan-out: N concurrent calls
 * can never jointly exceed the cap.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: string,
    public readonly requestedUsd: number,
    public readonly remainingUsd: number,
  ) {
    super(`budget exceeded (${scope}): need $${requestedUsd.toFixed(4)}, $${remainingUsd.toFixed(4)} left`);
    this.name = "BudgetExceededError";
  }
}

export interface Reservation {
  readonly id: number;
  readonly amountUsd: number;
}

export class Budget {
  private spent = 0;
  private reserved = new Map<number, number>();
  private seq = 0;

  constructor(
    public readonly limitUsd: number,
    public readonly scope: string,
    private readonly parent?: Budget,
  ) {}

  get spentUsd(): number {
    return round(this.spent);
  }

  get remainingUsd(): number {
    let r = 0;
    for (const v of this.reserved.values()) r += v;
    return round(this.limitUsd - this.spent - r);
  }

  /** A child budget whose spend also counts against this one. */
  child(limitUsd: number, scope: string): Budget {
    return new Budget(limitUsd, scope, this);
  }

  reserve(amountUsd: number): Reservation {
    if (amountUsd > this.remainingUsd + 1e-9) {
      throw new BudgetExceededError(this.scope, amountUsd, this.remainingUsd);
    }
    // Reserve in the parent first so a parent failure leaves no dangling child reservation.
    const parentRes = this.parent?.reserve(amountUsd);
    const id = ++this.seq;
    this.reserved.set(id, amountUsd);
    if (parentRes) this.parentLinks.set(id, parentRes);
    return { id, amountUsd };
  }

  private parentLinks = new Map<number, Reservation>();

  /** Convert a reservation into actual spend (actual may be lower than reserved). */
  settle(res: Reservation, actualUsd: number): void {
    if (!this.reserved.delete(res.id)) return;
    const charged = Math.max(0, actualUsd);
    this.spent += charged;
    const p = this.parentLinks.get(res.id);
    this.parentLinks.delete(res.id);
    if (p && this.parent) this.parent.settle(p, charged);
  }

  release(res: Reservation): void {
    this.settle(res, 0);
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
