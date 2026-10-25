import { ObjectId } from "mongodb";
import type { SmtpAccountDoc, SmtpLimits } from "../../db/mongo.ts";
import { MissingRateError, resolveRate, type ResolvedRate } from "../../smtp/presets.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import type { AuditLog, HostPolicy, RateStateReader, SecretBox, SmtpAccountRepository, SmtpConnectionTester } from "./ports.ts";

const MAX_ACCOUNTS_PER_USER = 20;

export interface NewSmtpAccount {
  name: string;
  host: string;
  port: number;
  secure?: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string;
  limits: SmtpLimits;
  maxConnections: number;
  skipVerify: boolean;
}

export type SmtpAccountPatch = Partial<Omit<NewSmtpAccount, "skipVerify">>;

export interface SmtpAccountView {
  account: SmtpAccountDoc;
  rate: { currentPerSec?: number; learnedLimitPerSec?: number; pausedUntil: Date | null };
  hint?: ResolvedRate["hint"];
}

export class SmtpAccountService {
  constructor(
    private readonly accounts: SmtpAccountRepository,
    private readonly secrets: SecretBox,
    private readonly tester: SmtpConnectionTester,
    private readonly hosts: HostPolicy,
    private readonly rates: RateStateReader,
    private readonly audit: AuditLog,
  ) {}

  async create(userId: ObjectId, input: NewSmtpAccount): Promise<SmtpAccountView> {
    if ((await this.accounts.count(userId)) >= MAX_ACCOUNTS_PER_USER) {
      throw new ConflictError(`limit of ${MAX_ACCOUNTS_PER_USER} smtp accounts reached`);
    }
    await this.assertHost(input.host);
    const rate = this.resolve(input.host, input.limits);

    const doc: SmtpAccountDoc = {
      _id: new ObjectId(),
      userId,
      name: input.name,
      host: input.host,
      port: input.port,
      secure: input.secure ?? input.port === 465,
      username: input.username,
      passwordEnc: this.secrets.encrypt(input.password),
      fromEmail: input.fromEmail,
      ...(input.fromName ? { fromName: input.fromName } : {}),
      provider: rate.provider,
      limits: input.limits,
      ceilingPerSec: rate.ceilingPerSec,
      ...(rate.dailyCap ? { dailyCap: rate.dailyCap } : {}),
      maxConnections: input.maxConnections,
      health: "ok",
      createdAt: new Date(),
    };
    if (!input.skipVerify) {
      await this.verifyOrThrow(doc);
      doc.verifiedAt = new Date();
    }
    await this.accounts.insert(doc);
    this.audit.record("smtp.created", { userId, meta: { smtpId: String(doc._id), host: doc.host, ceilingPerSec: doc.ceilingPerSec } });
    return { ...(await this.view(doc)), hint: rate.hint };
  }

  async list(userId: ObjectId): Promise<SmtpAccountView[]> {
    return Promise.all((await this.accounts.list(userId)).map((a) => this.view(a)));
  }

  async get(userId: ObjectId, id: ObjectId): Promise<SmtpAccountView> {
    return this.view(await this.owned(userId, id));
  }

  /** Resolve the account an email should use: the named one, or the user's only one. */
  async resolveForSending(userId: ObjectId, id: ObjectId | undefined): Promise<SmtpAccountDoc> {
    const account = id ? await this.owned(userId, id) : await this.onlyAccount(userId);
    if (account.health !== "ok") {
      throw new ConflictError(
        `smtp account is ${account.health}: ${account.healthDetail ?? "fix credentials"} (PATCH it, then POST /v1/smtp/:id/verify)`,
      );
    }
    return account;
  }

  async update(userId: ObjectId, id: ObjectId, patch: SmtpAccountPatch): Promise<SmtpAccountView> {
    const current = await this.owned(userId, id);
    if (patch.host) await this.assertHost(patch.host);

    const set: Partial<SmtpAccountDoc> = {};
    const unset: string[] = [];
    for (const key of ["name", "host", "port", "secure", "username", "fromEmail", "fromName", "maxConnections"] as const) {
      if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key];
    }
    if (patch.password !== undefined) set.passwordEnc = this.secrets.encrypt(patch.password);

    const rateChanged = patch.limits !== undefined || patch.host !== undefined;
    if (rateChanged) {
      const limits = patch.limits ?? current.limits;
      const rate = this.resolve(patch.host ?? current.host, limits);
      Object.assign(set, { provider: rate.provider, limits, ceilingPerSec: rate.ceilingPerSec });
      if (rate.dailyCap) set.dailyCap = rate.dailyCap;
      else unset.push("dailyCap");
      unset.push("learnedRate"); // what was learned against the old limits no longer applies
    }

    if (["host", "port", "secure", "username", "password"].some((k) => k in patch)) {
      await this.verifyOrThrow({ ...current, ...set });
      set.verifiedAt = new Date();
      set.health = "ok";
      unset.push("healthDetail");
    }

    const updated = await this.accounts.update(userId, id, { set, unset });
    if (!updated) throw new NotFoundError("smtp account not found");
    if (rateChanged) await this.rates.reset(String(id));
    this.audit.record("smtp.updated", {
      userId,
      meta: {
        smtpId: String(id),
        fields: Object.keys(patch).filter((k) => k !== "password"),
        passwordChanged: patch.password !== undefined,
      },
    });
    return this.view(updated);
  }

  async verify(userId: ObjectId, id: ObjectId): Promise<void> {
    const account = await this.owned(userId, id);
    try {
      await this.tester.verify(account);
    } catch (e) {
      await this.accounts.update(userId, id, {
        set: { health: "auth_failed", healthDetail: (e as Error).message.slice(0, 300) },
      });
      throw new ValidationError(`verification failed: ${(e as Error).message}`);
    }
    await this.accounts.update(userId, id, { set: { health: "ok", verifiedAt: new Date() }, unset: ["healthDetail"] });
  }

  async delete(userId: ObjectId, id: ObjectId): Promise<void> {
    const account = await this.owned(userId, id);
    await this.accounts.delete(account._id);
    await this.rates.reset(String(account._id));
    this.audit.record("smtp.deleted", { userId, meta: { smtpId: String(id) } });
  }

  // ---------- internals ----------
  private async owned(userId: ObjectId, id: ObjectId): Promise<SmtpAccountDoc> {
    const account = await this.accounts.find(userId, id);
    if (!account) throw new NotFoundError("smtp account not found");
    return account;
  }

  private async onlyAccount(userId: ObjectId): Promise<SmtpAccountDoc> {
    const all = await this.accounts.firstN(userId, 2);
    if (all.length === 0) throw new ConflictError("add an SMTP account first (POST /v1/smtp)");
    if (all.length > 1) throw new ValidationError("smtpId is required when you have several SMTP accounts");
    return all[0]!;
  }

  private async view(account: SmtpAccountDoc): Promise<SmtpAccountView> {
    const st = await this.rates.state(String(account._id));
    return {
      account,
      rate: {
        currentPerSec: st.rate,
        learnedLimitPerSec: st.ssthresh ?? account.learnedRate,
        pausedUntil: st.pauseUntil > Date.now() ? new Date(st.pauseUntil) : null,
      },
    };
  }

  private resolve(host: string, limits: SmtpLimits): ResolvedRate {
    try {
      return resolveRate(host, limits);
    } catch (e) {
      if (e instanceof MissingRateError) throw new ValidationError(e.message);
      throw e;
    }
  }

  private async assertHost(host: string): Promise<void> {
    try {
      await this.hosts.assertAllowed(host);
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  }

  private async verifyOrThrow(account: SmtpAccountDoc): Promise<void> {
    try {
      await this.tester.verify(account);
    } catch (e) {
      throw new ValidationError(`could not connect/authenticate to the SMTP server: ${(e as Error).message}`);
    }
  }
}
