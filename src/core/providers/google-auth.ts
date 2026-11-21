import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "./http.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

type AuthorizedUser = {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
};
type ServiceAccount = { type: "service_account"; client_email: string; private_key: string; token_uri?: string };
type Credentials = AuthorizedUser | ServiceAccount;

/** The Application Default Credentials chain: explicit path, $GOOGLE_APPLICATION_CREDENTIALS, then gcloud's file. */
export function findGoogleCredentials(explicit?: string): string | undefined {
  const candidates = [
    explicit?.replace(/^~(?=\/)/, homedir()),
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    join(homedir(), ".config", "gcloud", "application_default_credentials.json"),
  ];
  return candidates.find((c): c is string => !!c && existsSync(c));
}

/**
 * Google OAuth over plain HTTP: a user's refresh token (gcloud ADC) or a service account's signed JWT, exchanged
 * for an access token that is cached until shortly before it expires.
 */
export class GoogleAuth {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly path?: string,
    private readonly tokenUrl = TOKEN_URL,
  ) {}

  /** A one-line description of which credentials will be used, without touching the network. */
  describe(): string {
    const path = findGoogleCredentials(this.path);
    if (!path) return "no Google credentials (run: gcloud auth application-default login)";
    try {
      const c = this.load();
      if (c.type === "service_account") return `service account ${c.client_email}`;
      return `gcloud ADC (user)${c.quota_project_id ? ` · quota ${c.quota_project_id}` : ""}`;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async headers(): Promise<Record<string, string>> {
    const c = this.load();
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token(c)}` };
    if (c.type === "authorized_user" && c.quota_project_id) headers["x-goog-user-project"] = c.quota_project_id;
    return headers;
  }

  private load(): Credentials {
    const path = findGoogleCredentials(this.path);
    if (!path) throw new Error("no Google credentials (run: gcloud auth application-default login)");
    const c = JSON.parse(readFileSync(path, "utf8")) as Credentials;
    if (c.type !== "authorized_user" && c.type !== "service_account")
      throw new Error(`unsupported Google credentials type "${(c as { type?: string }).type}" in ${path}`);
    return c;
  }

  private async token(c: Credentials): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    const url = c.type === "service_account" ? (c.token_uri ?? this.tokenUrl) : this.tokenUrl;
    const form: Record<string, string> =
      c.type === "authorized_user"
        ? { grant_type: "refresh_token", client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token }
        : { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signJwt(c, url) };
    const response = await fetch(url, { method: "POST", body: new URLSearchParams(form) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Google token request failed (HTTP ${response.status}): ${errorMessage(text)}`);
    const { access_token, expires_in } = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.cached = { token: access_token, expiresAt: Date.now() + ((expires_in ?? 3600) - 60) * 1000 };
    return access_token;
  }
}

async function signJwt(sa: ServiceAccount, audience: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: sa.client_email, scope: SCOPE, aud: audience, iat: now, exp: now + 3600 })}`;
  const der = Buffer.from(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}
