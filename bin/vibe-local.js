#!/usr/bin/env node
import { run } from '../src/cli.js';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`\n出错了：${err?.stack ?? err}\n`);
  process.exitCode = 1;
}
