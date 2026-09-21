/**
 * A strict FIFO of async jobs, one at a time.
 *
 * Every transaction from the relayer key goes through one of these, from nonce assignment to
 * receipt, so two requests arriving together can never sign the same nonce. A failed job never
 * stalls the ones behind it.
 */

export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** Jobs waiting or running. */
  get depth(): number {
    return this.#depth;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const result = this.#tail.then(job, job);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#depth -= 1;
    });
  }

  /** Resolves once every job queued so far has settled. */
  async drain(): Promise<void> {
    await this.#tail;
  }
}
