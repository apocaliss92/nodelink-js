/**
 * Optional STARTTLS support for the email-push SMTP server.
 *
 * The library does NOT auto-generate a self-signed cert: doing so portably
 * across Node versions requires a heavy dependency (`selfsigned` /
 * `node-forge`), and Reolink cameras typically accept self-signed certs
 * only when the user has consciously opted into TLS.
 *
 * Consumers point `loadEmailPushTls` at a directory containing `cert.pem`
 * and `key.pem`. When either is missing the function returns `undefined`
 * and logs through the provided logger (or `console.warn` by default).
 */

import fs from "node:fs";
import path from "node:path";

export interface EmailPushTlsOptions {
  cert: Buffer;
  key: Buffer;
}

export interface LoadTlsParams {
  /** Directory holding `cert.pem` + `key.pem`. */
  dir: string;
  /** Optional logger; defaults to console-based warn. */
  warn?: (msg: string) => void;
}

/**
 * Read the user-provided cert/key pair. Returns `undefined` (and logs a
 * warning) when either file is missing.
 */
export async function loadEmailPushTls(
  params: LoadTlsParams,
): Promise<EmailPushTlsOptions | undefined> {
  const certPath = path.join(params.dir, "cert.pem");
  const keyPath = path.join(params.dir, "key.pem");
  const warn = params.warn ?? ((m) => console.warn(`[email-push-tls] ${m}`));

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    warn(
      `Email-push TLS requested but ${certPath} or ${keyPath} is missing. ` +
        "Place a PEM cert+key under that directory to enable STARTTLS, or " +
        "disable TLS in the consumer config to silence this warning.",
    );
    return undefined;
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}
