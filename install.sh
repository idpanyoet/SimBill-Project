#!/usr/bin/env bash
# =============================================================================
#  SimBill — Installer VPS (clone dari GitHub publik)
#  Stack : Node.js + Express, MariaDB, pm2   |   Target: Ubuntu 22/24 & Debian 11/12
#
#  Pakai (one-liner):
#     wget -qO- https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/install.sh | sudo bash
#
#  Non-interaktif (lewati pertanyaan), contoh:
#     curl -fsSL .../install.sh | sudo DB_PASS=Rahasia123 INSTALL_RADIUS=n bash
# =============================================================================
set -euo pipefail

# ───────────────────────── KONFIGURASI (ganti sesuai repo-mu) ────────────────
GITHUB_USER="${GITHUB_USER:-idpanyoet}"
GITHUB_REPO="${GITHUB_REPO:-SimBill-Project}"
GITHUB_BRANCH="${GITHUB_BRANCH:-master}"

INSTALL_DIR="${INSTALL_DIR:-/opt/simbill}"
APP_PORT="${APP_PORT:-3000}"
PM2_NAME="${PM2_NAME:-billing-radius}"
NODE_MAJOR="${NODE_MAJOR:-20}"

DB_NAME="${DB_NAME:-billing_radius}"
DB_USER="${DB_USER:-billing}"
DB_PASS="${DB_PASS:-}"                 # kosong = digenerate otomatis
INSTALL_RADIUS="${INSTALL_RADIUS:-}"   # y | n  (FreeRADIUS opsional)
# ─────────────────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/${GITHUB_USER}/${GITHUB_REPO}.git"
C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_B=$'\e[1m'; C_R=$'\e[0m'
ok(){ echo "${C_OK}✔${C_R} $*"; }
info(){ echo "  $*"; }
step(){ echo; echo "${C_B}── $* ──${C_R}"; }
die(){ echo "${C_ERR}✘ $*${C_R}" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Jalankan sebagai root (pakai sudo)."

# ── Deteksi OS ──
. /etc/os-release 2>/dev/null || die "Tidak bisa deteksi OS."
case "${ID:-}" in
  ubuntu|debian) ok "OS: ${PRETTY_NAME}";;
  *) [[ "${ID_LIKE:-}" == *debian* ]] && ok "OS mirip Debian: ${PRETTY_NAME}" \
        || die "OS tidak didukung (${ID:-?}). Hanya Ubuntu/Debian.";;
esac

export DEBIAN_FRONTEND=noninteractive
[ -z "$DB_PASS" ] && DB_PASS="$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)"

step "1/7 Paket dasar"
apt-get update -y -qq
apt-get install -y -qq curl wget git ca-certificates gnupg lsb-release openssl build-essential >/dev/null
ok "Paket dasar terpasang"

step "2/7 Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || [ "$(node -v | grep -oE '[0-9]+' | head -1)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v) • npm $(npm -v)"
npm install -g pm2 >/dev/null 2>&1 || npm install -g pm2
ok "pm2 $(pm2 -v)"

step "3/7 MariaDB"
apt-get install -y -qq mariadb-server mariadb-client >/dev/null
systemctl enable --now mariadb >/dev/null 2>&1 || service mariadb start
ok "MariaDB aktif"

step "4/7 Database '${DB_NAME}' & user '${DB_USER}'"
mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
ok "Database & user siap"

step "5/7 Ambil kode dari ${GITHUB_USER}/${GITHUB_REPO} (${GITHUB_BRANCH})"
if [ -d "${INSTALL_DIR}/.git" ]; then
  info "Folder sudah ada → menarik update"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$GITHUB_BRANCH" -q
  git -C "$INSTALL_DIR" reset --hard "origin/${GITHUB_BRANCH}" -q
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 -b "$GITHUB_BRANCH" "$REPO_URL" "$INSTALL_DIR" -q \
    || die "Gagal clone. Pastikan repo PUBLIK & branch '${GITHUB_BRANCH}' benar."
fi
[ -d "${INSTALL_DIR}/backend" ] || die "Struktur repo tak sesuai (folder 'backend' tak ada)."
ok "Kode tersimpan di ${INSTALL_DIR}"

step "6/7 .env, dependency & impor database"
ENV_FILE="${INSTALL_DIR}/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
  JWT="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  cat > "$ENV_FILE" <<ENV
PORT=${APP_PORT}
NODE_ENV=production
APP_URL=http://localhost:${APP_PORT}
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}
JWT_SECRET=${JWT}
JWT_EXPIRES=8h
RADIUS_HOST=127.0.0.1
RADIUS_SECRET=testing123
ENV
  ok ".env dibuat (JWT_SECRET digenerate)"
else
  info ".env sudah ada → dibiarkan"
fi

( cd "${INSTALL_DIR}/backend" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || ( cd "${INSTALL_DIR}/backend" && npm install --production )
ok "Dependency backend terpasang"

SCHEMA=""
for f in "${INSTALL_DIR}/database/schema.sql" "${INSTALL_DIR}/backend/database/schema.sql"; do
  [ -f "$f" ] && SCHEMA="$f" && break
done
if [ -n "$SCHEMA" ]; then
  mysql "${DB_NAME}" < "$SCHEMA" 2>/dev/null && ok "Schema diimpor" \
    || info "Schema sudah ada / sebagian dilewati (aman jika ini reinstall)"
else
  info "schema.sql tidak ditemukan — lewati impor"
fi

# ── Set password admin default (hash bcrypt asli, bukan placeholder) ──
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
ADMIN_HASH="$(cd "${INSTALL_DIR}/backend" && node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" "$ADMIN_PASS" 2>/dev/null || true)"
if [ -n "$ADMIN_HASH" ]; then
  mysql "${DB_NAME}" <<SQL 2>/dev/null || true
INSERT INTO admin (username, nama, email, password, role, aktif)
VALUES ('${ADMIN_USER}', 'Super Admin', 'admin@billing.id', '${ADMIN_HASH}', 'superadmin', 1)
ON DUPLICATE KEY UPDATE password = VALUES(password), aktif = 1;
SQL
  ok "Password admin di-set"
else
  info "Lewati set password admin (bcryptjs belum siap) — set manual nanti"
fi

step "7/7 Jalankan dengan pm2"
cd "${INSTALL_DIR}/backend"
pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
pm2 start server.js --name "$PM2_NAME"
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
ok "Aplikasi berjalan (pm2: ${PM2_NAME})"

# ── FreeRADIUS (opsional) ──
if [ -z "$INSTALL_RADIUS" ]; then
  if [ -t 0 ]; then read -r -p "Pasang FreeRADIUS sekarang? [y/N]: " INSTALL_RADIUS || true; else INSTALL_RADIUS=n; fi
fi
if [[ "${INSTALL_RADIUS,,}" == y* ]]; then
  step "FreeRADIUS"
  apt-get install -y -qq freeradius freeradius-mysql freeradius-utils >/dev/null
  systemctl enable --now freeradius >/dev/null 2>&1 || true
  ok "FreeRADIUS terpasang (konfigurasi modul SQL→DB perlu disetel manual)"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "${C_B}════════════════ SELESAI ════════════════${C_R}"
echo "  URL aplikasi : ${C_OK}http://${IP}:${APP_PORT}${C_R}"
echo "  Folder       : ${INSTALL_DIR}"
echo "  pm2 name     : ${PM2_NAME}"
echo "  Database     : ${DB_NAME}"
echo "  DB user/pass : ${DB_USER} / ${C_WARN}${DB_PASS}${C_R}"
echo "  ${C_WARN}↑ Simpan kredensial DB ini.${C_R}"
echo
echo "  Login admin  : ${C_OK}${ADMIN_USER}${C_R} / ${C_WARN}${ADMIN_PASS}${C_R}"
echo "  ${C_WARN}↑ Ganti password admin segera setelah login.${C_R}"
echo "  Update nanti :"
echo "    wget -qO- https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/update.sh | sudo bash"
echo "${C_B}═════════════════════════════════════════${C_R}"
