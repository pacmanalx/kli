import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAuth } from "../src/core/providers/google-auth.ts";

const dir = mkdtempSync(join(tmpdir(), "kli-auth-"));
const forms: URLSearchParams[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const form = new URLSearchParams(await req.text());
    forms.push(form);
    if (form.get("refresh_token") === "revoked") return Response.json({ error: "invalid_grant", error_description: "Token has been revoked" }, { status: 400 });
    return Response.json({ access_token: `token-${forms.length}`, expires_in: 3600 });
  },
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});
const file = (name: string, content: object) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
};
const tokenUrl = () => `${server.url.origin}/token`;

test("gcloud user credentials: refresh token exchanged once, cached, quota project header", async () => {
  const path = file("user.json", { type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "r1", quota_project_id: "quota-x" });
  const auth = new GoogleAuth(path, tokenUrl());
  const first = await auth.headers();
  const second = await auth.headers();
  expect(first).toEqual({ Authorization: "Bearer token-1", "x-goog-user-project": "quota-x" });
  expect(second).toEqual(first);
  expect(forms.length).toBe(1);
  expect(forms[0]!.get("grant_type")).toBe("refresh_token");
  expect(auth.describe()).toBe("gcloud ADC (user) · quota quota-x");
});

test("service account: a signed JWT that the matching public key verifies", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const path = file("sa.json", { type: "service_account", client_email: "kli@proj.iam.gserviceaccount.com", private_key: pem, token_uri: tokenUrl() });
  const auth = new GoogleAuth(path);
  expect(await auth.headers()).toEqual({ Authorization: `Bearer token-${forms.length}` });
  const form = forms.at(-1)!;
  expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [head, claims, signature] = form.get("assertion")!.split(".");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${head}.${claims}`));
  expect(ok).toBe(true);
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ iss: "kli@proj.iam.gserviceaccount.com", aud: tokenUrl() });
  expect(auth.describe()).toBe("service account kli@proj.iam.gserviceaccount.com");
});

test("a refused refresh token explains why", async () => {
  const path = file("revoked.json", { type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "revoked" });
  await expect(new GoogleAuth(path, tokenUrl()).headers()).rejects.toThrow(/HTTP 400: Token has been revoked|invalid_grant/);
});
