/**
 * Regression tests for BaichuanRtspServer Digest authentication with both
 * plaintext `password` and pre-computed `ha1` credentials.
 *
 * Background: the manager reuses dashboard-user HA1 values — which are
 * persisted once at password-set time — so the running server must be able
 * to validate Digest responses without ever holding the plaintext.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { BaichuanRtspServer } from "../../src/baichuan/stream/BaichuanRtspServer.js";

const REALM = "nodelink-js-rtsp";
const USERNAME = "admin";
const PASSWORD = "s3cret";
const METHOD = "DESCRIBE";
const URI = "rtsp://127.0.0.1:8554/cam/main";

const md5 = (data: string) =>
  crypto.createHash("md5").update(data).digest("hex");
const HA1 = md5(`${USERNAME}:${REALM}:${PASSWORD}`);

function buildDigestHeader(params: {
  username: string;
  realm: string;
  nonce: string;
  uri: string;
  response: string;
}): string {
  return (
    `Digest username="${params.username}", realm="${params.realm}", ` +
    `nonce="${params.nonce}", uri="${params.uri}", response="${params.response}"`
  );
}

function computeExpectedResponse(params: {
  ha1: string;
  nonce: string;
  method: string;
  uri: string;
}): string {
  const ha2 = md5(`${params.method}:${params.uri}`);
  return md5(`${params.ha1}:${params.nonce}:${ha2}`);
}

function makeServer(credentials: Array<
  | { username: string; password: string }
  | { username: string; ha1: string }
>) {
  // Cast: BaichuanRtspServer's constructor requires an `api` instance. We
  // never invoke anything that touches `api` from the Digest validator, so
  // a minimal stub is enough for these unit tests.
  const api = {
    client: { getTransport: () => "tcp" as const },
  } as unknown as ConstructorParameters<typeof BaichuanRtspServer>[0]["api"];

  return new BaichuanRtspServer({
    api,
    channel: 0,
    profile: "main",
    listenHost: "127.0.0.1",
    listenPort: 0,
    path: "/cam/main",
    logger: console,
    credentials,
    requireAuth: true,
    authRealm: REALM,
  });
}

// The tests reach into private members for brevity — they're regression
// tests for wire-level Digest behavior, not an API shape contract.
type ServerPrivates = {
  authNonces: Map<string, { nonce: string; timestamp: number }>;
  validateDigestAuth: (
    header: string,
    method: string,
    uri: string,
    clientId: string,
  ) => boolean;
};

describe("BaichuanRtspServer Digest auth", () => {
  const clientId = "127.0.0.1:41234";
  const nonce = "test-nonce-1234";

  it("accepts a valid response when credentials carry plaintext password", () => {
    const server = makeServer([{ username: USERNAME, password: PASSWORD }]);
    const priv = server as unknown as ServerPrivates;
    priv.authNonces.set(clientId, { nonce, timestamp: Date.now() });

    const response = computeExpectedResponse({
      ha1: HA1,
      nonce,
      method: METHOD,
      uri: URI,
    });
    const header = buildDigestHeader({
      username: USERNAME,
      realm: REALM,
      nonce,
      uri: URI,
      response,
    });

    expect(priv.validateDigestAuth(header, METHOD, URI, clientId)).toBe(true);
  });

  it("accepts a valid response when credentials carry pre-computed HA1 only", () => {
    const server = makeServer([{ username: USERNAME, ha1: HA1 }]);
    const priv = server as unknown as ServerPrivates;
    priv.authNonces.set(clientId, { nonce, timestamp: Date.now() });

    const response = computeExpectedResponse({
      ha1: HA1,
      nonce,
      method: METHOD,
      uri: URI,
    });
    const header = buildDigestHeader({
      username: USERNAME,
      realm: REALM,
      nonce,
      uri: URI,
      response,
    });

    expect(priv.validateDigestAuth(header, METHOD, URI, clientId)).toBe(true);
  });

  it("rejects when the client presents a different realm than the server advertises", () => {
    const server = makeServer([{ username: USERNAME, ha1: HA1 }]);
    const priv = server as unknown as ServerPrivates;
    priv.authNonces.set(clientId, { nonce, timestamp: Date.now() });

    const ha1WrongRealm = md5(`${USERNAME}:wrong-realm:${PASSWORD}`);
    const response = computeExpectedResponse({
      ha1: ha1WrongRealm,
      nonce,
      method: METHOD,
      uri: URI,
    });
    const header = buildDigestHeader({
      username: USERNAME,
      realm: "wrong-realm",
      nonce,
      uri: URI,
      response,
    });

    expect(priv.validateDigestAuth(header, METHOD, URI, clientId)).toBe(false);
  });

  it("rejects when the response is computed with the wrong password", () => {
    const server = makeServer([{ username: USERNAME, ha1: HA1 }]);
    const priv = server as unknown as ServerPrivates;
    priv.authNonces.set(clientId, { nonce, timestamp: Date.now() });

    const wrongHa1 = md5(`${USERNAME}:${REALM}:wrong-password`);
    const response = computeExpectedResponse({
      ha1: wrongHa1,
      nonce,
      method: METHOD,
      uri: URI,
    });
    const header = buildDigestHeader({
      username: USERNAME,
      realm: REALM,
      nonce,
      uri: URI,
      response,
    });

    expect(priv.validateDigestAuth(header, METHOD, URI, clientId)).toBe(false);
  });
});
