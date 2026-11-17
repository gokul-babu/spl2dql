#!/usr/bin/env node
import { run } from '../dist/main.js';

// A reader that closes early (`spl2dql commands | head`) is normal for a CLI: stop quietly
// instead of crashing with an unhandled EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
});
process.exitCode = code;
