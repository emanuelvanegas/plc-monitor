import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'plc-monitor-e2e-'));
const port = Number(process.env.PLC_E2E_PORT ?? '18088');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const args = [resolve(root, 'target/debug/plc-monitor'), '--demo', '--demo-base-port', '0', '--listen', `127.0.0.1:${port}`, '--database', join(temporary, 'monitor.db'), '--frontend', resolve(root, 'frontend/dist')];

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],
  webServer: {
    command: args.map(quote).join(' '),
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
