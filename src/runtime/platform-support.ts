export const LINUX_ARM64_UNSUPPORTED_CODE = 'LINUX_ARM64_UNSUPPORTED';
export const LINUX_ARM64_UNSUPPORTED_MESSAGE = [
  'Linux arm64 is not supported by this CLI for local Chrome-based execution.',
  'Chrome for Testing does not currently provide a Linux arm64 package for the runtime browser.',
  'Use Linux x64, macOS x64/arm64, Windows x64, or run the task in cloud mode.'
].join(' ');

export function isLinuxArm64Runtime(platform = process.platform, arch = process.arch): boolean {
  return platform === 'linux' && arch === 'arm64';
}

export function isLocalChromeRuntimeSupported(): boolean {
  return !isLinuxArm64Runtime();
}

export function supportedLocalChromePlatforms(): string[] {
  return ['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64'];
}

export function unsupportedLocalChromePlatforms(): string[] {
  return ['linux-arm64'];
}

export function localChromePlatformNote(): string {
  return 'Linux arm64 is not supported because Chrome for Testing does not provide a Linux arm64 browser package.';
}
