#!/usr/bin/env bash
# SimBill — One-line Updater (AMAN: tidak menyentuh .env / uploads / node_modules)
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/simbill}"
REPO="${REPO:-idpanyoet/SimBill-Project}"
BRANCH="${BRANCH:-master}"
PM2_NAME="${PM2_NAME:-billing-radius}"
BACKUP_DIR="${BACKUP_DIR:-/opt/simbill-backups}"

BACKEND_DIR="$APP_ROOT/backend"
ENV_FILE="$BACKEND_DIR/.env"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"

log(){ echo -e "\033[1;36m[update]\033[0m $*"; }
err(){ echo -e "\033[1;31m[update]\033[0m $*" >&2; }
die(){ err "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Jalankan sebagai root (pakai sudo)."
command -v rsync >/dev/null 2>&1 || { log "Memasang rsync..."; apt-get install -y rsync >/dev/null 2>&1 || true; }
command -v rsync >/dev/null 2>&1 || die "rsync wajib ada. Jalankan: apt-get install -y rsync"
[ -d "$BACKEND_DIR" ] || die "Tidak menemukan $BACKEND_DIR — APP_ROOT salah?"

# 1) Backup .env DULU
ENV_BAK=""
if [ -f "$ENV_FILE" ]; then
    ENV_BAK="/root/.simbill-env-backup-$STAMP"
    cp -a "$ENV_FILE" "$ENV_BAK"; chmod 600 "$ENV_BAK"
    log ".env dibackup -> $ENV_BAK"
else
    err "PERINGATAN: $ENV_FILE belum ada sebelum update."
fi

# 2) Ambil kode terbaru ke direktori sementara
TMP="$(mktemp -d /tmp/simbill-upd-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
log "Mengunduh $REPO@$BRANCH ..."
if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/repo" >/dev/null 2>&1 \
        || die "git clone gagal (cek koneksi / repo / branch)."
else
    command -v tar >/dev/null 2>&1 || die "Butuh git atau tar+wget."
    wget -qO "$TMP/src.tar.gz" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" || die "Unduh tarball gagal."
    mkdir -p "$TMP/repo" && tar xzf "$TMP/src.tar.gz" -C "$TMP/repo" --strip-components=1
fi
SRC_BASE="$TMP/repo"

# 3) Deteksi root kode (folder yang memuat backend/server.js)
SRV="$(find "$SRC_BASE" -maxdepth 4 -path '*backend/server.js' -print -quit 2>/dev/null || true)"
[ -n "$SRV" ] || die "Struktur repo tidak dikenali (backend/server.js tak ditemukan)."
SRC_ROOT="$(cd "$(dirname "$SRV")/.." && pwd)"
[ -f "$SRC_ROOT/backend/package.json" ] || die "backend/package.json tidak ada di $SRC_ROOT."
log "Sumber kode: $SRC_ROOT"

# 4) Backup kode lama
mkdir -p "$BACKUP_DIR"
OLD_VER="$(cat "$APP_ROOT/VERSION" 2>/dev/null | tr -d '\n' || echo lama)"
tar czf "$BACKUP_DIR/backup-${OLD_VER}-${STAMP}.tar.gz" \
    --exclude='node_modules' --exclude='.git' --exclude='wa-session' \
    -C "$APP_ROOT" . 2>/dev/null || err "Backup tarball gagal (lanjut)."

# 5) Sinkron kode baru — JAGA .env/uploads/node_modules/wa-session
log "Menyinkronkan file..."
rsync -a --delete \
    --exclude='.env' --exclude='backend/.env' \
    --exclude='node_modules' --exclude='backend/node_modules' \
    --exclude='frontend/uploads' \
    --exclude='backend/wa-session' --exclude='wa-session' \
    --exclude='.git' --exclude='VERSION' \
    "$SRC_ROOT/" "$APP_ROOT/"

# 6) Jaring pengaman: kembalikan .env bila hilang
if [ ! -f "$ENV_FILE" ] && [ -n "$ENV_BAK" ] && [ -f "$ENV_BAK" ]; then
    err ".env hilang setelah sync — memulihkan dari backup."
    cp -a "$ENV_BAK" "$ENV_FILE"
fi
[ -f "$ENV_FILE" ] && chmod 600 "$ENV_FILE"

# 7) Dependensi
log "npm install ..."
( cd "$BACKEND_DIR" && npm install --no-audit --no-fund ) || err "npm install bermasalah (cek manual)."

# 8) Tulis versi baru
[ -f "$SRC_ROOT/VERSION" ] && { cp -a "$SRC_ROOT/VERSION" "$APP_ROOT/VERSION"; log "Versi -> $(cat "$APP_ROOT/VERSION" | tr -d '\n')"; }

# 9) Restart (migrasi DB jalan otomatis saat boot)
log "Restart $PM2_NAME ..."
pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 \
    || systemctl restart "$PM2_NAME" 2>/dev/null \
    || err "Gagal restart otomatis — jalankan: pm2 restart $PM2_NAME"

sleep 2
log "Selesai. Cek log: pm2 logs $PM2_NAME --lines 20 --nostream"
