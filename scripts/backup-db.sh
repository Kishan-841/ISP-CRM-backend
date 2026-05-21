#!/usr/bin/env bash
#
# ISP CRM — daily Postgres backup
#
# Runs once a day at 00:00 IST via cron on the prod host. Steps:
#   1. pg_dump the running Docker container into a gzipped file
#   2. Upload to a Google Drive folder via rclone (15 GB free per account)
#   3. Prune local copies older than 14 days
#   4. Prune remote copies older than the retention tiers below
#   5. On any failure, send an alert email via the existing Resend API
#
# The script is idempotent and safe to re-run. If you re-run it twice in the
# same minute the second copy just overwrites the first — the timestamp has
# second-resolution.
#
# First-time setup: scripts/README-backup.md walks through rclone OAuth
# and the cron entry.
#
# Exit codes:
#   0  — backup uploaded + local prune succeeded
#   1  — pg_dump failed
#   2  — rclone upload failed
#   3  — config missing (env vars unset, rclone not installed, etc.)

set -euo pipefail

# ────────────────────────────────────────────────────────────────────────────
# CONFIG — keep all knobs here so cron doesn't need to be edited.
# ────────────────────────────────────────────────────────────────────────────

# Path to docker-compose.yml on the prod host
COMPOSE_FILE="${COMPOSE_FILE:-/opt/isp-crm/backend/docker-compose.yml}"

# Postgres credentials (must match docker-compose.yml)
PG_DB="${PG_DB:-isp_crm}"
PG_USER="${PG_USER:-isp_crm_user}"

# Where local copies live before upload
LOCAL_DIR="${LOCAL_DIR:-/var/backups/isp-crm}"

# rclone remote name + Drive folder. After `rclone config`, the remote name
# is whatever you typed when prompted (e.g. "gdrive"). The folder gets
# created on first upload.
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive}"
RCLONE_PATH="${RCLONE_PATH:-isp-crm-backups}"

# Retention windows
LOCAL_KEEP_DAYS="${LOCAL_KEEP_DAYS:-14}"
REMOTE_DAILY_KEEP_DAYS="${REMOTE_DAILY_KEEP_DAYS:-30}"

# Failure alerts via Resend (matches the keys already in backend/.env)
# If RESEND_API_KEY is unset, failures still log loudly but no email is sent.
RESEND_API_KEY="${RESEND_API_KEY:-}"
ALERT_FROM="${ALERT_FROM:-kishan@gazonindia.com}"
ALERT_TO="${ALERT_TO:-paras@gazonindia.com}"

# ────────────────────────────────────────────────────────────────────────────

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${LOCAL_DIR}/isp_crm-${TS}.sql.gz"
LOG="${LOCAL_DIR}/last-run.log"

mkdir -p "${LOCAL_DIR}"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "${LOG}"; }

send_alert() {
  local subject="$1"
  local body="$2"
  if [[ -z "${RESEND_API_KEY}" ]]; then
    log "ALERT (no RESEND_API_KEY set, email skipped): ${subject}"
    return
  fi
  # Resend API — minimal JSON, no attachments needed for the alert itself.
  # The body carries enough log context for the on-call to act.
  curl -fsS -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H "Content-Type: application/json" \
    --data @- <<EOF >/dev/null || log "ALERT FAILED to send via Resend"
{
  "from": "${ALERT_FROM}",
  "to": ["${ALERT_TO}"],
  "subject": "${subject}",
  "text": "${body}"
}
EOF
}

# Fail-safe wrapper — any non-zero from the script triggers an alert with the
# tail of the log so the on-call sees what broke without SSH'ing in.
on_error() {
  local rc=$?
  local snippet
  snippet=$(tail -n 30 "${LOG}" 2>/dev/null | sed 's/"/\\"/g' || true)
  send_alert \
    "[ISP CRM backup FAILED ${TS}] exit=${rc}" \
    "Backup script exited ${rc}.\\n\\nLast 30 log lines:\\n${snippet}"
  exit $rc
}
trap on_error ERR

# ────────────────────────────────────────────────────────────────────────────
# 0. Sanity checks — surface config problems BEFORE wasting a pg_dump
# ────────────────────────────────────────────────────────────────────────────
command -v docker  >/dev/null || { log "docker not on PATH"; exit 3; }
command -v rclone  >/dev/null || { log "rclone not installed — see scripts/README-backup.md"; exit 3; }
command -v gzip    >/dev/null || { log "gzip not installed"; exit 3; }
[[ -f "${COMPOSE_FILE}" ]] || { log "compose file not found: ${COMPOSE_FILE}"; exit 3; }
rclone listremotes 2>/dev/null | grep -q "^${RCLONE_REMOTE}:" || {
  log "rclone remote '${RCLONE_REMOTE}' not configured — run 'rclone config' once"; exit 3;
}

# ────────────────────────────────────────────────────────────────────────────
# 1. pg_dump + gzip into a local file
# ────────────────────────────────────────────────────────────────────────────
log "starting pg_dump → ${OUT}"
# --no-owner + --clean + --if-exists keeps restore portable: dropping &
# re-creating without trying to enforce the original owner that may not
# exist on the restore host.
if ! docker compose -f "${COMPOSE_FILE}" exec -T db \
       pg_dump -U "${PG_USER}" -d "${PG_DB}" --no-owner --clean --if-exists \
     | gzip -9 > "${OUT}"; then
  log "pg_dump failed"
  rm -f "${OUT}"
  exit 1
fi
SIZE=$(du -h "${OUT}" | awk '{print $1}')
log "pg_dump succeeded — ${SIZE} written"

# ────────────────────────────────────────────────────────────────────────────
# 2. Upload to Google Drive
# ────────────────────────────────────────────────────────────────────────────
log "uploading ${OUT} → ${RCLONE_REMOTE}:${RCLONE_PATH}/"
if ! rclone copy "${OUT}" "${RCLONE_REMOTE}:${RCLONE_PATH}/" \
       --transfers=1 \
       --retries=3 \
       --retries-sleep=30s \
       --log-file="${LOG}" --log-level INFO; then
  log "rclone upload failed"
  exit 2
fi
log "upload complete"

# ────────────────────────────────────────────────────────────────────────────
# 3. Local prune — keep last N days only
# ────────────────────────────────────────────────────────────────────────────
log "pruning local files older than ${LOCAL_KEEP_DAYS} days"
find "${LOCAL_DIR}" -name "isp_crm-*.sql.gz" -mtime "+${LOCAL_KEEP_DAYS}" -delete -print | tee -a "${LOG}"

# ────────────────────────────────────────────────────────────────────────────
# 4. Remote prune — delete daily snapshots older than REMOTE_DAILY_KEEP_DAYS.
# This is intentionally conservative — a separate monthly/yearly snapshot
# script can promote a daily copy into a long-term folder if you decide to
# add that tier later (Indian GST/IT-Act needs 7 years of FINANCIAL data,
# which the daily window doesn't satisfy on its own).
# ────────────────────────────────────────────────────────────────────────────
log "pruning remote files older than ${REMOTE_DAILY_KEEP_DAYS} days"
rclone delete "${RCLONE_REMOTE}:${RCLONE_PATH}/" \
  --min-age "${REMOTE_DAILY_KEEP_DAYS}d" \
  --include "isp_crm-*.sql.gz" \
  --log-file="${LOG}" --log-level INFO || log "remote prune had non-fatal warnings (not aborting)"

log "backup OK — ${OUT} (${SIZE})"
