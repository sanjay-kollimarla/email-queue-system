import type { ObjectId } from "mongodb";
import type { EmailStatus } from "../../db/mongo.ts";
import type { DeliveryActivityRepository } from "./ports.ts";
import type { EmailQueryService } from "./query-services.ts";
import type { SmtpAccountService, SmtpAccountView } from "./smtp-account-service.ts";

const BUCKET_SEC = 5;
const WINDOW_SEC = 3 * 60;

export interface DashboardSnapshot {
  now: Date;
  counts: Record<EmailStatus, number>;
  total: number;
  throughput: { bucketSec: number; points: Array<{ at: Date; sent: number }>; sentPerSecNow: number; peakPerSec: number };
  accounts: SmtpAccountView[];
  problems: Array<{ id: string; to: string; status: EmailStatus; reason?: string; at: Date }>;
}

/**
 * Everything the dashboard screen needs in ONE call (one round trip per poll instead of five), assembled from
 * the existing read services. Empty time buckets are filled in here so the chart has a continuous axis.
 */
export class DashboardService {
  constructor(
    private readonly queries: EmailQueryService,
    private readonly accounts: SmtpAccountService,
    private readonly activity: DeliveryActivityRepository,
  ) {}

  async snapshot(userId: ObjectId, now = new Date()): Promise<DashboardSnapshot> {
    const since = new Date(Math.floor((now.getTime() - WINDOW_SEC * 1000) / (BUCKET_SEC * 1000)) * BUCKET_SEC * 1000);
    const [stats, accounts, raw, problems] = await Promise.all([
      this.queries.stats(userId),
      this.accounts.list(userId),
      this.activity.sentPerBucket(userId, since, BUCKET_SEC),
      this.activity.recentProblems(userId, 8),
    ]);

    const bySlot = new Map(raw.map((p) => [p.at.getTime(), p.sent]));
    const points: Array<{ at: Date; sent: number }> = [];
    for (let t = since.getTime(); t <= now.getTime(); t += BUCKET_SEC * 1000) {
      points.push({ at: new Date(t), sent: bySlot.get(t) ?? 0 });
    }
    // the newest bucket is still filling, so the "current rate" uses the last complete one
    const lastComplete = points.length >= 2 ? points[points.length - 2]!.sent : 0;
    const peak = points.reduce((m, p) => Math.max(m, p.sent), 0);

    return {
      now,
      counts: stats.counts,
      total: stats.total,
      throughput: {
        bucketSec: BUCKET_SEC,
        points,
        sentPerSecNow: lastComplete / BUCKET_SEC,
        peakPerSec: peak / BUCKET_SEC,
      },
      accounts,
      problems: problems.map((p) => ({ ...p, id: String(p.id) })),
    };
  }
}
