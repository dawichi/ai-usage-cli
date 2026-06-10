#!/usr/bin/env node

import { main } from "./src/dashboard.mjs";

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
