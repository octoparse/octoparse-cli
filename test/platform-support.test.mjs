import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LINUX_ARM64_UNSUPPORTED_CODE,
  isLinuxArm64Runtime,
  localChromePlatformNote,
  supportedLocalChromePlatforms,
  unsupportedLocalChromePlatforms
} from '../dist/runtime/platform-support.js';

test('platform support marks Linux arm64 unsupported for local Chrome runtime', () => {
  assert.equal(LINUX_ARM64_UNSUPPORTED_CODE, 'LINUX_ARM64_UNSUPPORTED');
  assert.equal(isLinuxArm64Runtime('linux', 'arm64'), true);
  assert.equal(isLinuxArm64Runtime('linux', 'x64'), false);
  assert.equal(isLinuxArm64Runtime('darwin', 'arm64'), false);
  assert.deepEqual(unsupportedLocalChromePlatforms(), ['linux-arm64']);
  assert.ok(supportedLocalChromePlatforms().includes('linux-x64'));
  assert.match(localChromePlatformNote(), /Chrome for Testing/);
});
