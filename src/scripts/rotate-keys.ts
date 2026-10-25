/**
 * Re-encrypt every stored SMTP password with the ACTIVE encryption key.
 *
 *  1. generate a new key:        openssl rand -hex 32
 *  2. deploy with ENCRYPTION_KEY=<new> ENCRYPTION_KEY_ID=k2 ENCRYPTION_OLD_KEYS=k1:<old>
 *     (everything keeps working: reads use the key id stored in each ciphertext)
 *  3. bun run rotate-keys        (idempotent, safe to re-run, resumable)
 *  4. when it reports "remaining 0", remove k1 from ENCRYPTION_OLD_KEYS
 *
 *  --dry-run   only count what would be rotated
 */
import { col, connectMongo, mongo } from "../db/mongo.ts";
import { decrypt, encrypt, needsRotation } from "../lib/crypto.ts";

const dryRun = process.argv.includes("--dry-run");
await connectMongo();

let rotated = 0;
let remaining = 0;
for await (const acct of col.smtpAccounts().find({}, { projection: { passwordEnc: 1 } })) {
  if (!needsRotation(acct.passwordEnc)) continue;
  if (dryRun) {
    remaining++;
    continue;
  }
  // compare-and-set on the old ciphertext: a concurrent PATCH of the password is never overwritten
  const res = await col
    .smtpAccounts()
    .updateOne({ _id: acct._id, passwordEnc: acct.passwordEnc }, { $set: { passwordEnc: encrypt(decrypt(acct.passwordEnc)) } });
  res.modifiedCount === 1 ? rotated++ : remaining++;
}
console.log(dryRun ? `would rotate ${remaining} secrets` : `rotated ${rotated}, remaining ${remaining}`);
await mongo.close();
