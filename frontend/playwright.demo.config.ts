import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './demo-tests',
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  use: { baseURL: 'http://127.0.0.1:18089/plc-monitor/', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../test-results-demo',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report-demo', open: 'never' }]],
  webServer: {
    command: 'npm run preview:demo -- --port 18089 --strictPort',
    url: 'http://127.0.0.1:18089/plc-monitor/',
    reuseExistingServer: false,
  },
});
