#!/bin/sh
# Logical backup of the MongoDB replica set (the ONLY system of record; Redis is a rebuildable cache).
#   MONGO_URI="mongodb://user:pass@mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&authSource=admin" ./deploy/backup.sh /backups
# Run it against a SECONDARY (readPreference) so it never loads the primary; schedule it (cron / k8s CronJob)
# and ship the archive off the host. Restore: see docs/RUNBOOK.md.
set -eu
dir="${1:-./backups}"
mkdir -p "$dir"
file="$dir/emailq-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
mongodump --uri "${MONGO_URI:?set MONGO_URI}" --db "${MONGO_DB:-emailq}" --readPreference secondary --archive="$file" --gzip
echo "backup written: $file"
