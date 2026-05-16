/**
 * Optional STARTTLS support for the email push SMTP server.
 *
 * To enable TLS, drop `cert.pem` and `key.pem` under
 * `${DATA_PATH}/email-push-tls/`. We deliberately do NOT auto-generate a
 * self-signed cert in the manager process: doing so portably across Node
 * versions requires a heavy dependency (`selfsigned`, `node-forge`), and
 * Reolink cameras typically accept self-signed certs only when the user
 * has consciously opted into TLS.
 *
 * If the files are missing we return `undefined` so the server starts in
 * plain mode and logs a warning — TLS is opt-in by configuration.
 */

import fs from "node:fs";
import path from "node:path";
import { createSourceLogger } from "./logger.js";

const logger = createSourceLogger("email-push-tls");

const DATA_DIR = process.env.DATA_PATH || ".";
const TLS_DIR = path.join(DATA_DIR, "email-push-tls");
const CERT_PATH = path.join(TLS_DIR, "cert.pem");
const KEY_PATH = path.join(TLS_DIR, "key.pem");

export interface EmailPushTlsOptions {
  cert: Buffer;
  key: Buffer;
}

/**
 * Read the user-provided cert/key pair. Returns `undefined` (and logs a
 * warning) when either file is missing.
 */
export async function createSelfSignedTlsCert(): Promise<
  EmailPushTlsOptions | undefined
> {
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
    logger.warn(
      `Email push TLS requested but ${CERT_PATH} or ${KEY_PATH} is missing. ` +
        "Place a PEM cert+key under email-push-tls/ to enable STARTTLS, or " +
        "disable emailPush.tls to silence this warning.",
    );
    return undefined;
  }

  return {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  };
}
