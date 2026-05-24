import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    browserName: 'chromium',
  },
  webServer: {
    command: 'npx serve . -l 4321',
    url: 'http://localhost:4321',
    reuseExistingServer: true,
  },
});
