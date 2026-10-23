import { defineConfig } from '@playwright/test';
import { createHash } from 'crypto';

// Each checkout (main repo or any git worktree) gets its own static server.
// The default port is derived deterministically from the checkout path, so two
// worktrees running `npm test` concurrently land on different ports with no
// manual setup. Override with PLAYWRIGHT_PORT (or PORT) when needed.
//
// The resolved port is written back to process.env so Playwright's worker
// processes (which re-evaluate this file) agree on the same value.
function defaultPortForCheckout(dir: string): number {
  const hash = createHash('sha1').update(dir).digest();
  return 20000 + (hash.readUInt32BE(0) % 10000); // 20000–29999
}

const port = Number(
  process.env.PLAYWRIGHT_PORT || process.env.PORT || defaultPortForCheckout(__dirname),
);
process.env.PLAYWRIGHT_PORT = String(port);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests',
  use: {
    browserName: 'chromium',
    baseURL,
  },
  webServer: {
    // --no-port-switching: fail loudly instead of serving on a surprise port.
    command: `npx serve . -l ${port} --no-port-switching`,
    url: baseURL,
    // Never adopt an already-running server: it might be another worktree's
    // checkout, which would silently test the wrong code. If the port is taken,
    // Playwright errors out; pick another with PLAYWRIGHT_PORT.
    reuseExistingServer: false,
  },
});
