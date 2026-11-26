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

/** Everything the server has except its own secrets; for agent sessions and the Ruflo server. */
export function inheritedEnvironment(source: EnvironmentSource = process.env): Environment {
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && !OWN_SECRETS.has(entry[0]),
  );
  return Object.fromEntries(entries);
}

/** PATH, HOME and CI=1; for commands the engine runs itself. */
export function minimalEnvironment(source: EnvironmentSource = process.env): Environment {
  const kept = (['PATH', 'HOME'] as const).flatMap((name) => {
    const value = source[name];
    return typeof value === 'string' ? [[name, value] as const] : [];
  });
  return { ...Object.fromEntries(kept), CI: '1' };
}
