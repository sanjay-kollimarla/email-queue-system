import { sign, verify } from "hono/jwt";
import { ObjectId } from "mongodb";
import type { AccessTokenSigner, CapabilityTokens, OpaqueTokens, PasswordHasher, SecretBox } from "../../core/api/ports.ts";
import { decrypt, encrypt, randomToken, sha256, signToken, verifyToken } from "../../lib/crypto.ts";

export class ArgonPasswordHasher implements PasswordHasher {
  private dummy?: Promise<string>;
  hash(plain: string) {
    return Bun.password.hash(plain, { algorithm: "argon2id" });
  }
  verify(plain: string, hash: string) {
    return Bun.password.verify(plain, hash);
  }
  async verifyDummy(plain: string): Promise<void> {
    this.dummy ??= this.hash("dummy-password-for-timing");
    await this.verify(plain, await this.dummy);
  }
}

export class JwtAccessTokenSigner implements AccessTokenSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlSec: number,
  ) {}

  async sign(userId: ObjectId) {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ sub: String(userId), iat: now, exp: now + this.ttlSec }, this.secret, "HS256");
    return { token, expiresInSec: this.ttlSec };
  }

  async verify(token: string): Promise<ObjectId> {
    const payload = await verify(token, this.secret, "HS256");
    if (typeof payload.sub !== "string" || !ObjectId.isValid(payload.sub)) throw new Error("bad subject");
    return new ObjectId(payload.sub);
  }
}

export class AesSecretBox implements SecretBox {
  encrypt(plain: string) {
    return encrypt(plain);
  }
  decrypt(payload: string) {
    return decrypt(payload);
  }
}

export class Sha256OpaqueTokens implements OpaqueTokens {
  generate() {
    return randomToken(48);
  }
  hash(token: string) {
    return sha256(token);
  }
}

export class HmacCapabilityTokens implements CapabilityTokens {
  sign(payload: string) {
    return signToken(payload);
  }
  verify(token: string) {
    return verifyToken(token);
  }
}
