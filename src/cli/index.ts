#!/usr/bin/env node
import { createProgram } from './program';

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  process.stderr.write(`Analyzer error: ${(error as Error).message}\n`);
  process.exit(2);
});
