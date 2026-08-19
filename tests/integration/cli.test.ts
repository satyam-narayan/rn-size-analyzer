import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

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
    assert.match(result.stdout, /0\.1\.2/);
  });

  it('prints help', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /analyze/);
    assert.match(result.stdout, /\[platform\]/);
    assert.doesNotMatch(result.stdout, /compare/);
    assert.doesNotMatch(result.stdout, /check/);
  });

  it('exits 3 on invalid project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-empty-'));
    const result = run(['analyze', '--cwd', dir]);
    assert.equal(result.status, 3);
  });

  it('rejects a specific artifact path', () => {
    const result = run(['analyze', 'MyApp.ipa', '--cwd', FIXTURE]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /rn-size-analyzer android/);
    assert.match(result.stderr, /Do not pass an APK, AAB, or IPA path/);
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

  it('supports analyze ios', () => {
    const out = mkdtempSync(join(tmpdir(), 'rnsa-ios-alias-'));
    const result = run(['analyze', 'ios', '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ios.detected, true);
    assert.equal(json.android.detected, false);
  });

  it('supports analyze android', () => {
    const out = mkdtempSync(join(tmpdir(), 'rnsa-android-alias-'));
    const result = run(['analyze', 'android', '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.android.detected, true);
    assert.equal(json.ios.detected, false);
  });

  it('supports analyze ios with trailing comma', () => {
    const out = mkdtempSync(join(tmpdir(), 'rnsa-ios-comma-'));
    const result = run(['analyze', 'ios,', '--cwd', FIXTURE, '--format', 'json', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ios.detected, true);
    assert.equal(json.android.detected, false);
  });
});
