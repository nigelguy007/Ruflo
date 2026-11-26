import { delimiter, isAbsolute } from 'node:path';

/**
 * Environments for child processes. Configuration is read once in config.ts;
 * this module only decides which of the server's variables a child inherits.
 */

export type Environment = Record<string, string>;
type EnvironmentSource = Record<string, string | undefined>;

/**
 * Switchyard's own credentials. A coding session that could read the API token
 * could approve its own gate, and one that could read a webhook secret could
 * forge the signal that starts a run, so no child ever sees them.
 */
const OWN_SECRETS: ReadonlySet<string> = new Set([
  'SWITCHYARD_TOKEN',
  'SENTRY_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
]);

/**
 * PATH with only absolute entries. A child resolves its binary against PATH
 * after changing into its working directory, so an empty or relative entry
 * ("", ".", "bin") would let an executable planted in the checkout run in
 * place of the allow-listed one.
 */
export function absoluteSearchPath(path: string): string {
  return path
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
    .join(delimiter);
}

function withSafePath(environment: Environment): Environment {
  return typeof environment.PATH === 'string'
    ? { ...environment, PATH: absoluteSearchPath(environment.PATH) }
    : environment;
}

/** Everything the server has except its own secrets, with a safe PATH; for agent sessions. */
export function inheritedEnvironment(source: EnvironmentSource = process.env): Environment {
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && !OWN_SECRETS.has(entry[0]),
  );
  return withSafePath(Object.fromEntries(entries));
}

/** PATH (absolute entries only) and HOME, nothing else from `source`. */
export function pathAndHome(source: EnvironmentSource = process.env): Environment {
  const kept = (['PATH', 'HOME'] as const).flatMap((name) => {
    const value = source[name];
    return typeof value === 'string' ? [[name, value] as const] : [];
  });
  return withSafePath(Object.fromEntries(kept));
}

/** PATH, HOME and CI=1; for commands the engine runs itself. */
export function minimalEnvironment(source: EnvironmentSource = process.env): Environment {
  return { ...pathAndHome(source), CI: '1' };
}
