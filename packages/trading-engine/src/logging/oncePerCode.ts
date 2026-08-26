/**
 * Emit one structured log per distinct code (or after a successful reset).
 * Prevents heartbeat/reconcile from flooding the same error every 15s.
 */
export class OncePerCodeLogger {
  private lastCode: string | null = null;

  emit(code: string, write: () => void): boolean {
    if (this.lastCode === code) return false;
    this.lastCode = code;
    write();
    return true;
  }

  reset(code = "OK"): boolean {
    if (this.lastCode === code) return false;
    const changed = this.lastCode != null && this.lastCode !== code;
    this.lastCode = code;
    return changed;
  }

  current(): string | null {
    return this.lastCode;
  }
}
