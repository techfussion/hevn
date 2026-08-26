import { logger } from "../../utils/logger";

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number; // Number of failures before tripping to OPEN (default 3)
  coolDownMs?: number; // Time in OPEN state before transitioning to HALF_OPEN (default 30000ms)
  samplingWindowMs?: number; // Rolling window for failure counting (default 60000ms)
  name?: string;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private failureTimestamps: number[] = [];
  private lastStateChange: number = Date.now();
  private halfOpenProbeInFlight: boolean = false;

  private failureThreshold: number;
  private coolDownMs: number;
  private samplingWindowMs: number;
  public readonly name: string;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.coolDownMs = options?.coolDownMs ?? 30000;
    this.samplingWindowMs = options?.samplingWindowMs ?? 60000;
    this.name = options?.name || "default";
  }

  getState(): CircuitBreakerState {
    const now = Date.now();
    if (this.state === "OPEN" && now - this.lastStateChange >= this.coolDownMs) {
      this.state = "HALF_OPEN";
      this.lastStateChange = now;
      this.halfOpenProbeInFlight = false;
      logger.info({ circuit: this.name, coolDownMs: this.coolDownMs }, "Circuit breaker transitioned: OPEN -> HALF_OPEN (probing)");
    }
    return this.state;
  }

  /**
   * Executes an action protected by the circuit breaker.
   */
  async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "OPEN") {
      throw new Error(`Circuit breaker '${this.name}' is OPEN (fast failure)`);
    }

    if (currentState === "HALF_OPEN" && this.halfOpenProbeInFlight) {
      throw new Error(`Circuit breaker '${this.name}' is HALF_OPEN (probe already in flight)`);
    }

    if (currentState === "HALF_OPEN") {
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    } finally {
      if (currentState === "HALF_OPEN") {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  recordSuccess() {
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED";
      this.lastStateChange = Date.now();
      this.failureTimestamps = [];
      logger.info({ circuit: this.name }, "Circuit breaker probe succeeded: HALF_OPEN -> CLOSED");
    } else if (this.state === "CLOSED") {
      // Prune old failures outside window
      this.pruneOldFailures();
    }
  }

  recordFailure(err?: unknown) {
    const now = Date.now();
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.lastStateChange = now;
      logger.warn({ circuit: this.name, err }, "Circuit breaker probe failed: HALF_OPEN -> OPEN");
      return;
    }

    if (this.state === "CLOSED") {
      this.failureTimestamps.push(now);
      this.pruneOldFailures();

      if (this.failureTimestamps.length >= this.failureThreshold) {
        this.state = "OPEN";
        this.lastStateChange = now;
        logger.error(
          {
            circuit: this.name,
            failures: this.failureTimestamps.length,
            threshold: this.failureThreshold,
            err,
          },
          "Circuit breaker tripped: CLOSED -> OPEN"
        );
      }
    }
  }

  reset() {
    this.state = "CLOSED";
    this.failureTimestamps = [];
    this.lastStateChange = Date.now();
    this.halfOpenProbeInFlight = false;
  }

  private pruneOldFailures() {
    const cutoff = Date.now() - this.samplingWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
  }
}
