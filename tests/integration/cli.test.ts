import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { writeZip } from '../helpers/zip';

const ROOT = resolve(__dirname, '..', '..', '..');
const CLI = resolve(ROOT, 'dist', 'cli', 'index.js');
const FIXTURE = resolve(ROOT, 'tests', 'fixtures', 'sample-rn-project');

function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

describe('CLI', () => {
  it('prints version', () => {
    const result = run(['--version']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /0\.1\.0/);
  });

  it('prints help', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /analyze/);
    assert.match(result.stdout, /compare/);
    assert.match(result.stdout, /check/);
  });

  it('exits 3 on invalid project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-empty-'));
    const result = run(['analyze', '--cwd', dir]);
    assert.equal(result.status, 3);
  });

  it('analyzes the fixture project and writes JSON', () => {
    const out = mkdtempSync(join(tmpdir(), 'rnsa-out-'));
    const result = run(['analyze', '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.overview.androidDetected, true);
    assert.equal(json.overview.iosDetected, true);
    assert.ok(json.android.build.hermesEnabled);
  });

  it('analyzes an APK path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-cli-apk-'));
    const apk = join(dir, 'app-release.apk');
    writeZip(apk, [
      { name: 'lib/arm64-v8a/libfoo.so', data: Buffer.alloc(256, 1) },
      { name: 'assets/index.android.bundle', data: 'js' },
    ]);
    const out = join(dir, 'report');
    const result = run(['analyze', apk, '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.android.artifact.kind, 'apk');
  });

  it('supports analyze ios alias target', () => {
    const out = mkdtempSync(join(tmpdir(), 'rnsa-ios-alias-'));
    const result = run(['analyze', 'ios', '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ios.detected, true);
    assert.equal(json.android.detected, false);
  });

  it('supports analyze ios with trailing comma', () => {
    const out = mkdtempSync(join(tmpdir(), 'rnsa-ios-comma-'));
    const result = run(['analyze', 'ios,', '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ios.detected, true);
    assert.equal(json.android.detected, false);
  });

  it('check fails when max-size is exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-check-'));
    const apk = join(dir, 'app-release.apk');
    writeZip(apk, [{ name: 'classes.dex', data: Buffer.alloc(8000, 7) }]);
    const result = run([
      'check',
      apk,
      '--cwd',
      FIXTURE,
      '--max-size',
      '100B',
      '--fail-on',
      'never',
    ]);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /BUILD FAILED/);
  });

  it('check fails when increase exceeds threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-inc-'));
    const oldApk = join(dir, 'old.apk');
    const newApk = join(dir, 'new.apk');
    writeZip(oldApk, [{ name: 'a.txt', data: Buffer.alloc(100, 1) }]);
    writeZip(newApk, [{ name: 'a.txt', data: Buffer.alloc(5000, 1) }]);
    const baseline = join(dir, 'baseline.json');
    writeFileSync(baseline, JSON.stringify({ androidBytes: statSync(oldApk).size }));
    const result = run([
      'check',
      newApk,
      '--cwd',
      FIXTURE,
      '--baseline',
      baseline,
      '--max-increase',
      '100B',
      '--fail-on',
      'never',
    ]);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /increased by/);
  });

  it('compare produces JSON with deltas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-cmp-cli-'));
    const oldApk = join(dir, 'old.apk');
    const newApk = join(dir, 'new.apk');
    writeZip(oldApk, [{ name: 'lib/arm64-v8a/a.so', data: Buffer.alloc(10, 1) }]);
    writeZip(newApk, [{ name: 'lib/arm64-v8a/a.so', data: Buffer.alloc(2000, 1) }]);
    const out = join(dir, 'report');
    const result = run(['compare', oldApk, newApk, '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.ok(json.comparison);
    assert.ok(json.comparison.total.deltaBytes > 0);
  });
});
