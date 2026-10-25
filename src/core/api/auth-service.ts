import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import type { UserDoc } from "../../db/mongo.ts";
import { ConflictError, DuplicateKeyError, UnauthorizedError, ValidationError } from "../errors.ts";
import type { AccessTokenSigner, AuditLog, OpaqueTokens, PasswordHasher, RefreshTokenRepository, UserRepository } from "./ports.ts";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

export interface PublicUser {
  id: string;
  email: string;
}

/** Request metadata the core may record but never interprets. */
export interface RequestContext {
  ip?: string;
}

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly hasher: PasswordHasher,
    private readonly signer: AccessTokenSigner,
    private readonly opaque: OpaqueTokens,
    private readonly audit: AuditLog,
    private readonly refreshTtlSec: number,
  ) {}

  async register(email: string, password: string, ctx: RequestContext = {}): Promise<{ user: PublicUser } & TokenPair> {
    const user: UserDoc = {
      _id: new ObjectId(),
      email,
      passwordHash: await this.hasher.hash(password),
      createdAt: new Date(),
    };
    try {
      await this.users.insert(user);
    } catch (e) {
      if (e instanceof DuplicateKeyError) throw new ConflictError("email already registered");
      throw e;
    }
    this.audit.record("auth.register", { userId: user._id, ip: ctx.ip });
    return { user: { id: String(user._id), email }, ...(await this.issue(user._id, randomUUID())) };
  }

  async login(email: string, password: string, ctx: RequestContext = {}): Promise<{ user: PublicUser } & TokenPair> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      await this.hasher.verifyDummy(password);
      this.audit.record("auth.login_failed", { ip: ctx.ip, meta: { reason: "unknown_user" } });
      throw new UnauthorizedError("invalid credentials");
    }
    if (!(await this.hasher.verify(password, user.passwordHash))) {
      this.audit.record("auth.login_failed", { userId: user._id, ip: ctx.ip, meta: { reason: "bad_password" } });
      throw new UnauthorizedError("invalid credentials");
    }
    this.audit.record("auth.login", { userId: user._id, ip: ctx.ip });
    return { user: { id: String(user._id), email }, ...(await this.issue(user._id, randomUUID())) };
  }

  /**
   * Refresh-token rotation with reuse detection: each token works once. If an already-used token
   * shows up again it was stolen, so the whole family (every token descended from one login) is
   * revoked and both the thief and the victim must log in again.
   */
  async refresh(token: string, ctx: RequestContext = {}): Promise<TokenPair> {
    const hash = this.opaque.hash(token);
    const claimed = await this.refreshTokens.consume(hash);
    if (claimed) return this.issue(claimed.userId, claimed.family);

    const existing = await this.refreshTokens.findByHash(hash);
    if (existing?.usedAt) {
      await this.refreshTokens.deleteFamily(existing.family);
      this.audit.record("auth.refresh_reuse_detected", { userId: existing.userId, ip: ctx.ip });
    }
    throw new UnauthorizedError("invalid refresh token");
  }

  async logout(token: string): Promise<void> {
    const doc = await this.refreshTokens.findByHash(this.opaque.hash(token));
    if (doc) {
      await this.refreshTokens.deleteFamily(doc.family);
      this.audit.record("auth.logout", { userId: doc.userId });
    }
  }

  /** Changing the password signs the user out everywhere: every refresh token is revoked. */
  async changePassword(userId: ObjectId, current: string, next: string, ctx: RequestContext = {}): Promise<TokenPair> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError("user no longer exists");
    if (!(await this.hasher.verify(current, user.passwordHash))) {
      this.audit.record("auth.password_change_failed", { userId, ip: ctx.ip });
      throw new UnauthorizedError("current password is incorrect");
    }
    if (current === next) throw new ValidationError("new password must differ from the current one");
    await this.users.updatePasswordHash(userId, await this.hasher.hash(next));
    await this.refreshTokens.deleteAllForUser(userId);
    this.audit.record("auth.password_changed", { userId, ip: ctx.ip });
    return this.issue(userId, randomUUID());
  }

  async me(userId: ObjectId): Promise<{ id: string; email: string; createdAt: Date }> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError("user no longer exists");
    return { id: String(user._id), email: user.email, createdAt: user.createdAt };
  }

  private async issue(userId: ObjectId, family: string): Promise<TokenPair> {
    const { token, expiresInSec } = await this.signer.sign(userId);
    const refreshToken = this.opaque.generate();
    await this.refreshTokens.insert({
      _id: new ObjectId(),
      userId,
      tokenHash: this.opaque.hash(refreshToken),
      family,
      expiresAt: new Date(Date.now() + this.refreshTtlSec * 1000),
      createdAt: new Date(),
    });
    return { accessToken: token, refreshToken, tokenType: "Bearer", expiresIn: expiresInSec };
  }
}
