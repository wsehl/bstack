import { formatCommand } from "./command";

export interface Reporter {
  progress(message: string): void;
}

export class ConsoleReporter implements Reporter {
  progress(message: string): void {
    process.stderr.write(`[bstack] ${message}\n`);
  }

  command(command: readonly string[]): void {
    this.progress(`$ ${formatCommand(command)}`);
  }
}
