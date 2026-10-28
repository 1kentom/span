const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: '../../artifacts/download-tests',
  reporter: 'list',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:1431', headless: true },
  webServer: {
    command: 'python3 -m http.server 1431 --bind 127.0.0.1 --directory .',
    cwd: __dirname,
    url: 'http://127.0.0.1:1431/download/',
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
