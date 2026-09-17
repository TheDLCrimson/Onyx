import type { Client } from "discord.js";

/** The subset of `Client` the login helper needs, so tests need no real client. */
export type Loggable = Pick<Client, "login">;

/** TLS failures that always mean "something is intercepting HTTPS", not "bad config". */
const TLS_INTERCEPTION_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

/**
 * Turn a Discord login failure into one actionable line.
 *
 * The two failures operators actually hit are an intercepting proxy and a bad
 * token, and neither is obvious from the raw error, so both get named remedies.
 */
export function describeLoginFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (typeof code === "string" && TLS_INTERCEPTION_CODES.has(code)) {
    return (
      `TLS certificate could not be verified (${code}). ` +
      "A proxy or antivirus is intercepting HTTPS. " +
      "In Docker, mount your proxy's root CA into the container and point NODE_EXTRA_CA_CERTS at it. " +
      "Outside Docker, set NODE_OPTIONS=--use-system-ca."
    );
  }

  if (/token|unauthorized|401/i.test(message)) {
    return `Discord rejected the bot token (${message}). Check DISCORD_TOKEN in .env.`;
  }

  return message;
}

/**
 * Log in to Discord, exiting non-zero if it fails.
 *
 * Without this the rejected login is only logged. Nothing else holds the event
 * loop open, so Node exits with status 0 - which Docker, Railway, Fly and
 * Kubernetes all read as a clean shutdown. A bot that never connects then
 * restarts forever while every health check reports success.
 */
export async function loginOrExit(
  client: Loggable,
  token: string | undefined,
  exit: (code: number) => void = process.exit,
  log: (message: string) => void = console.error,
): Promise<void> {
  try {
    await client.login((token || "").trim());
  } catch (error) {
    log(`[fatal] could not log in to Discord - exiting: ${describeLoginFailure(error)}`);
    exit(1);
  }
}
