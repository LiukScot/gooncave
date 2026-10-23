const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Dependabot bumps package.json; the Flatpak ships the release its manifest names.
test('the Flatpak ships the Electron version development uses', () => {
  const { devDependencies } = require('./package.json');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'flatpak', 'app.gooncave.desktop.yml'), 'utf8');
  const shipped = manifest.match(/electron\/releases\/download\/v([\d.]+)\//)?.[1];
  assert.equal(shipped, devDependencies.electron);
});
