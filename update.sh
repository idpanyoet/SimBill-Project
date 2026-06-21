#!/usr/bin/env bash
# =============================================================================
#  SimBill — Update (tarik versi terbaru dari GitHub, lalu restart)
#  Pakai (one-liner):
#     wget -qO- https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/update.sh | sudo bash
# =============================================================================
set -euo pipefail

GITHUB_BRANCH="${GITHUB_BRANCH:-master}"
INSTALL_DIR="${INSTALL_DIR:-/opt/simbill}"
PM2_NAME="${PM2_NAME:-billing-radius}"

C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_B=$'\e[1m'; C_R=$'\e[0m'
ok(){ echo "${C_OK}✔${C_R} $*"; }
step(){ echo; echo "${C_B}── $* ──${C_R}"; }
die(){ echo "${C_ERR}✘ $*${C_R}" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Jalankan sebagai root (pakai sudo)."
[ -d "${INSTALL_DIR}/.git" ] || die "Folder ${INSTALL_DIR} bukan repo git. Jalankan install.sh dulu."

cd "$INSTALL_DIR"

step "Backup .env"
[ -f backend/.env ] && cp backend/.env "/root/.simbill-env-backup-$(date +%F_%H%M%S)" && ok "backend/.env dibackup ke /root/"

step "Tarik versi terbaru (${GITHUB_BRANCH})"
git fetch --depth 1 origin "$GITHUB_BRANCH" -q
OLD="$(git rev-parse --short HEAD 2>/dev/null || echo '-')"
git reset --hard "origin/${GITHUB_BRANCH}" -q
NEW="$(git rev-parse --short HEAD)"
ok "Kode diperbarui (${OLD} → ${NEW})"
# .env & node_modules & uploads tetap aman (untracked, tidak dihapus reset --hard)

step "Update dependency"
( cd backend && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || ( cd backend && npm install --production )
ok "Dependency backend up-to-date"

step "Restart aplikasi"
cd backend
pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 || pm2 start server.js --name "$PM2_NAME"
pm2 save >/dev/null
ok "Aplikasi di-restart (pm2: ${PM2_NAME})"

VER="$(cat "${INSTALL_DIR}/VERSION" 2>/dev/null || echo '?')"
echo
echo "${C_B}════════ UPDATE SELESAI ════════${C_R}"
echo "  Versi sekarang : ${C_OK}${VER}${C_R}"
echo "  Cek log        : pm2 logs ${PM2_NAME}"
echo "${C_B}════════════════════════════════${C_R}"
