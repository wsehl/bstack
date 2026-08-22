import { formatCommand } from "./command";

export interface Reporter {
  progress(message: string): void;
}

export class ConsoleReporter implements Reporter {
  progress(message: string) {
    process.stderr.write(`[bstack] ${message}\n`);
  }

  command(command: readonly string[]) {
    this.progress(`$ ${formatCommand(command)}`);
  }
}
