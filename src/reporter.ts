export interface Reporter {
  progress(message: string): void;
}

export class ConsoleReporter implements Reporter {
  constructor(private readonly enabled = true) {}

  progress(message: string): void {
    if (this.enabled) process.stderr.write(`[bstack] ${message}\n`);
  }
}
