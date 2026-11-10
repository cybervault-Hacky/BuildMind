/* ==========================================================================
   BuildMind API — providers/roblox/robloxProvider.ts
   Roblox OAuth 2.0 adapter (authorization code flow).

   What this genuinely does, per Roblox's current documented API surface:
     * builds an authorization URL with the configured client id and scopes
     * exchanges an authorization code for tokens at /oauth/v1/token
     * fetches the connected account's identity at /oauth/v1/userinfo

   What it does NOT do, and cannot at this boundary:
     * publish, upload or update an experience — that requires the Open Cloud
       Universes/Places APIs with a different credential model (an API key),
       not the OAuth user token used here
     * create a game from generated Luau — no official API accepts source code
       and produces a published experience

   Rather than pretend, `capabilities()` reports the limitation and the UI can
   state it. `connect()` never reports success unless a token exchange and a
   userinfo call both succeeded.

   If client credentials are absent, every method reports NOT_CONFIGURED.
   ========================================================================== */

import { AppError } from '../../errors/AppError.js';
import { postJson } from '../ai/http.js';

const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';

export interface RobloxConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface RobloxTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string;
}

export interface RobloxIdentity {
  userId: string;
  displayName: string;
}

/** Opaque state value is minted and verified by the service, not here. */
export function buildAuthorizeUrl(config: RobloxConfig, state: string, scopes: string[]): string {
  if (!config.clientId || !config.redirectUri) {
    throw new AppError('ROBLOX_NOT_CONFIGURED', { cause: 'missing client id or redirect uri' });
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export class RobloxProvider {
  constructor(private readonly config: RobloxConfig) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri);
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new AppError('ROBLOX_NOT_CONFIGURED', { cause: 'roblox credentials absent' });
    }
  }

  async exchangeCode(code: string): Promise<RobloxTokens> {
    this.requireConfigured();
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, 'utf8').toString('base64');

    const res = await postJson({
      url: TOKEN_URL,
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
      },
      timeoutMs: 20_000,
    });

    const body = res.json as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    } | null;

    if (!body?.access_token) {
      throw new AppError('ROBLOX_UNAVAILABLE', { cause: 'token exchange returned no access token' });
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 900) * 1000),
      scopes: body.scope ?? '',
    };
  }

  async fetchIdentity(accessToken: string): Promise<RobloxIdentity> {
    const res = await postJson({
      url: USERINFO_URL,
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs: 15_000,
    });
    const body = res.json as { sub?: string; preferred_username?: string; nickname?: string } | null;
    if (!body?.sub) throw new AppError('ROBLOX_UNAVAILABLE', { cause: 'userinfo returned no subject' });
    return { userId: body.sub, displayName: body.nickname || body.preferred_username || 'Roblox user' };
  }

  /**
   * An honest capability report. This is what the API returns to the
   * frontend so the UI can say "connected, but publishing needs Open Cloud"
   * instead of implying a full pipeline exists.
   */
  capabilities(): {
    configured: boolean;
    oauthConnect: boolean;
    identity: boolean;
    publishExperience: false;
    uploadSource: false;
    reason: string;
  } {
    return {
      configured: this.configured,
      oauthConnect: this.configured,
      identity: this.configured,
      publishExperience: false,
      uploadSource: false,
      reason:
        'Publishing an experience and uploading Luau source are not part of Roblox OAuth. ' +
        'They require the Open Cloud APIs with a separate API-key credential, which this build does not implement.',
    };
  }
}
