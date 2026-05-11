import { hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope } from '../cli/output.js';
import { API_BASE_URL_ENV, PROD_API_BASE_URL, PRE_API_BASE_URL } from '../runtime/api-client.js';
import { configFilePath, readCliConfig, saveCliConfig } from '../runtime/config.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

export async function hiddenEnvCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');

  if (subcommand === 'status' || !subcommand) {
    const config = await readCliConfig();
    const effectiveBaseUrl = valueAfter(args, '--api-base-url') ?? process.env[API_BASE_URL_ENV] ?? config.apiBaseUrl ?? PROD_API_BASE_URL;
    const data = {
      apiEnv: config.apiEnv ?? (effectiveBaseUrl.includes('pre-') ? 'pre' : 'prod'),
      apiBaseUrl: effectiveBaseUrl,
      configFile: configFilePath(),
      envOverride: Boolean(process.env[API_BASE_URL_ENV])
    };
    if (json) printEnvelope(true, data);
    else {
      console.log(`API env: ${data.apiEnv}`);
      console.log(`API base URL: ${data.apiBaseUrl}`);
      console.log(`Config: ${data.configFile}`);
      if (data.envOverride) console.log(`${API_BASE_URL_ENV} is set and overrides local config.`);
    }
    return EXIT_OK;
  }

  const next = resolveEnvTarget(subcommand);
  if (!next) {
    const message = 'Usage: octoparse env <pre|prod|online|status> [--json]';
    if (json) printEnvelope(false, undefined, 'INVALID_ENV', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  const config = await saveCliConfig({
    apiEnv: next.apiEnv,
    apiBaseUrl: next.apiBaseUrl
  });
  const data = {
    apiEnv: config.apiEnv,
    apiBaseUrl: config.apiBaseUrl,
    configFile: configFilePath()
  };

  if (json) printEnvelope(true, data);
  else {
    console.log(`API env switched to: ${data.apiEnv}`);
    console.log(`API base URL: ${data.apiBaseUrl}`);
    console.log(`Config: ${data.configFile}`);
    if (process.env[API_BASE_URL_ENV]) {
      console.log(`${API_BASE_URL_ENV} is currently set and will still override this config.`);
    }
  }
  return EXIT_OK;
}

function resolveEnvTarget(value: string): { apiEnv: 'pre' | 'prod'; apiBaseUrl: string } | undefined {
  if (value === 'pre') return { apiEnv: 'pre', apiBaseUrl: PRE_API_BASE_URL };
  if (value === 'prod' || value === 'online' || value === 'production') {
    return { apiEnv: 'prod', apiBaseUrl: PROD_API_BASE_URL };
  }
  return undefined;
}
