#!/usr/bin/env bash
# =============================================================================
#  SimBill — Update Script
#  Jalankan: wget -qO- https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/update.sh | sudo bash
#
#  Update aman berbasis git:
#   - backup kode + .env dulu (untuk rollback)
#   - git pull versi terbaru dari master repo customer (SimBill-Project, PUBLIC,
#     isinya build TEROBFUSCATE) — JAGA .env, uploads, node_modules
#   - npm install dependensi baru
#   - restart pm2
#
#  CATATAN: repo customer (SimBill-Project) master = build terobfuscate.
#  Source plain ada di repo TERPISAH & PRIVAT (SimBill-Source) — tidak disentuh
#  script ini. 'git reset --hard origin/master' memakai origin repo LOKAL,
#  jadi commit/perubahan lokal yang belum di-commit akan hilang: commit dulu.
# =============================================================================
set -e

APP_DIR="/opt/simbill"
BACKEND_DIR="${APP_DIR}/backend"
BACKUP_DIR="${APP_DIR}/_backup"
PM2_NAME="billing-radius"
BRANCH="master"

c_ok()   { echo -e "\033[32m✓\033[0m $1"; }
c_info() { echo -e "\033[36mℹ\033[0m $1"; }
c_err()  { echo -e "\033[31m✗\033[0m $1"; }

echo "============================================================"
echo "  SimBill — Update"
echo "============================================================"

# 0) Pastikan berjalan di folder app + ada git
if [ ! -d "$APP_DIR/.git" ]; then
    c_err "Folder $APP_DIR bukan repo git. Update via git tidak bisa dijalankan."
    c_info "Pastikan SimBill di-clone dari GitHub (ada folder .git)."
    exit 1
fi
cd "$APP_DIR"

# 1) Backup kode + .env (untuk rollback)
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/backup-${STAMP}.tar.gz"
c_info "Membuat backup ke ${BACKUP_FILE} ..."
tar czf "$BACKUP_FILE" \
    --exclude=node_modules \
    --exclude=_backup \
    --exclude=.git \
    -C "$APP_DIR" . 2>/dev/null && c_ok "Backup dibuat" \
    || c_info "Backup best-effort (lanjut)"

# 2) Simpan .env (jaga-jaga) + pastikan tidak ke-overwrite git
if [ -f "${BACKEND_DIR}/.env" ]; then
    cp "${BACKEND_DIR}/.env" "${BACKUP_DIR}/.env.${STAMP}"
    c_ok ".env diamankan"
fi

# 3) Pastikan perubahan lokal (selain .env/uploads) tidak menghalangi pull
#    .env & uploads sudah di .gitignore, jadi aman. Reset file kode lokal
#    agar git pull mulus (file kode = ikut versi GitHub).
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
VERSI_LAMA=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
c_info "Versi saat ini: ${VERSI_LAMA}"

# Stash perubahan lokal yang tidak perlu (kalau ada), lalu pull
git fetch origin "$BRANCH" 2>&1 | tail -1
# buang perubahan lokal pada file yang dilacak (kode), JANGAN sentuh untracked (.env, uploads)
git checkout -- . 2>/dev/null || true
git reset --hard "origin/${BRANCH}" 2>&1 | tail -1
c_ok "Kode diperbarui ke versi terbaru"

VERSI_BARU=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
c_info "Versi baru: ${VERSI_BARU}"

# 4) Install dependensi (kalau package.json berubah)
if [ -f "${BACKEND_DIR}/package.json" ]; then
    cd "$BACKEND_DIR"

    # Pastikan registry npm resmi SEBELUM install. Sebagian VPS (Tencent Cloud/China)
    # default memakai mirror lokal (mirrors.tencentyun.com) yang kerap tidak dapat
    # diakses → npm install gagal "ENOTFOUND / network" & update mati di tengah.
    CUR_REG="$(npm config get registry 2>/dev/null)"
    case "$CUR_REG" in
      *registry.npmjs.org*)
        curl -fsS -m 8 -o /dev/null https://registry.npmjs.org/express 2>/dev/null \
          || npm config set registry https://registry.npmjs.org/ >/dev/null 2>&1 ;;
      *)
        c_info "Registry npm ($CUR_REG) bukan resmi — mengalihkan ke registry.npmjs.org"
        npm config set registry https://registry.npmjs.org/ >/dev/null 2>&1 ;;
    esac
    npm config delete proxy >/dev/null 2>&1 || true
    npm config delete https-proxy >/dev/null 2>&1 || true
    npm config set fetch-retries 5 >/dev/null 2>&1 || true
    npm config set fetch-timeout 300000 >/dev/null 2>&1 || true

    c_info "Menginstal dependensi (npm install) ..."
    # JANGAN exit bila npm gagal: dependensi lama kemungkinan sudah ada, dan
    # menghentikan update di tengah (kode sudah ter-pull) justru merusak. Cukup
    # peringatkan; safety-net ensure_dep di bawah akan memverifikasi modul kritis.
    npm install --no-audit --no-fund 2>&1 | tail -3
    if [ "${PIPESTATUS[0]}" -eq 0 ]; then
        c_ok "Dependensi siap"
    else
        c_info "npm install ada peringatan (lanjut; modul kritis dicek di tahap berikutnya)"
    fi
else
    c_err "package.json tidak ditemukan di ${BACKEND_DIR} — lewati npm install"
fi

# 4a) Safety-net dependensi modul OLT.
#     ssh2 pernah hilang dari package.json rilis lama → server crash-loop
#     ("Cannot find module 'ssh2'") & semua endpoint /api/olt jadi 404.
#     Di sini kita VERIFIKASI tiap modul kritis benar-benar bisa di-require;
#     kalau belum ada (mis. node_modules nyangkut / rilis lama), pasang otomatis.
ensure_dep() {
    local mod="$1"
    if node -e "require('${mod}')" >/dev/null 2>&1; then
        return 0
    fi
    c_info "Dependensi '${mod}' belum terpasang — menginstal ..."
    if npm install "${mod}" --no-audit --no-fund >/dev/null 2>&1; then
        c_ok "'${mod}' terpasang"
    else
        c_err "Gagal pasang '${mod}' — coba manual: cd ${BACKEND_DIR} && npm install ${mod}"
    fi
    return 0
}
if [ -d "$BACKEND_DIR" ]; then
    cd "$BACKEND_DIR"
    ensure_dep ssh2
    ensure_dep net-snmp
fi

# 4a-2) BlastRADIUS (CVE-2024-3596): paksa require_message_authenticator = yes.
#   Default FreeRADIUS 3.2.5+ = 'auto' → request PERTAMA tiap NAS baru di-drop
#   ("no response") sambil "belajar". MikroTik kirim Message-Authenticator,
#   jadi aman dipaksa 'yes'. Idempotent: dijalankan tiap update.
RADDIR="$(ls -d /etc/freeradius/*/ 2>/dev/null | head -1)"
if [ -n "$RADDIR" ] && [ -f "${RADDIR}radiusd.conf" ]; then
    RADCONF="${RADDIR}radiusd.conf"
    if grep -qE '^[[:space:]]*require_message_authenticator[[:space:]]*=' "$RADCONF"; then
        if ! grep -qE '^[[:space:]]*require_message_authenticator[[:space:]]*=[[:space:]]*yes' "$RADCONF"; then
            sed -i -E 's|^([[:space:]]*)require_message_authenticator[[:space:]]*=.*|\1require_message_authenticator = yes|' "$RADCONF"
            systemctl restart freeradius >/dev/null 2>&1 || true
            c_ok "BlastRADIUS: require_message_authenticator = yes"
        fi
    fi
fi

# 4a-3) Safety-net config xl2tpd: kalau xl2tpd terpasang tapi /etc/xl2tpd/xl2tpd.conf
#   masih file CONTOH (semua ';', tidak ada [lns] aktif) → semua peer L2TP ditolak
#   "No Authorization". Tulis config benar HANYA jika belum ada [lns] aktif; config
#   valid (skema IP-mu sendiri) TIDAK disentuh.
if command -v xl2tpd >/dev/null 2>&1; then
    if ! grep -qE '^[[:space:]]*\[lns' /etc/xl2tpd/xl2tpd.conf 2>/dev/null; then
        c_info "xl2tpd.conf belum punya [lns] aktif — menulis config default SimBill"
        mkdir -p /etc/xl2tpd
        cat > /etc/xl2tpd/xl2tpd.conf <<'XL2'
[global]
[lns default]
  ip range = 10.10.29.10-10.10.29.100
  local ip = 10.10.29.1
  require chap = yes
  refuse pap = no
  require authentication = yes
  ppp debug = yes
  pppoptfile = /etc/ppp/options.l2tpd.lns
  length bit = yes
XL2
        [ -f /etc/ppp/options.l2tpd.lns ] || cat > /etc/ppp/options.l2tpd.lns <<'PPPO'
ipcp-accept-local
ipcp-accept-remote
require-chap
refuse-pap
auth
name l2tpd
ms-dns 8.8.8.8
ms-dns 1.1.1.1
asyncmap 0
noccp
nodefaultroute
proxyarp
mtu 1400
mru 1400
lcp-echo-interval 30
lcp-echo-failure 4
connect-delay 5000
PPPO
        systemctl restart xl2tpd >/dev/null 2>&1 || true
        c_ok "xl2tpd.conf diperbaiki ([lns default] aktif)"
    fi
fi

# 4b) Selaraskan versi yang ditampilkan panel dengan rilis GitHub terbaru.
#     Panel baca file VERSION (prioritas pertama). Ambil tag rilis terbaru;
#     jika belum ada rilis, pakai short commit sebagai versi.
REPO_OWNER="idpanyoet"
REPO_NAME="SimBill-Project"
c_info "Menyelaraskan versi ..."
LATEST_TAG=$(wget -qO- "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
if [ -z "$LATEST_TAG" ]; then
    LATEST_TAG="git-${VERSI_BARU}"
fi
echo "$LATEST_TAG" > "${APP_DIR}/VERSION"
c_ok "Versi di-set ke ${LATEST_TAG}"

# 5) Restart pm2
c_info "Restart aplikasi (pm2: ${PM2_NAME}) ..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 restart "$PM2_NAME" 2>&1 | tail -2 && c_ok "Aplikasi di-restart" \
        || c_info "pm2 restart gagal — restart manual: pm2 restart ${PM2_NAME}"
else
    c_err "pm2 tidak ditemukan — restart manual aplikasi."
fi

echo "============================================================"
c_ok "UPDATE SELESAI: ${VERSI_LAMA} → ${VERSI_BARU}"
echo "  Backup: ${BACKUP_FILE}"
echo "  Rollback bila perlu:"
echo "    cd ${APP_DIR} && tar xzf ${BACKUP_FILE} && pm2 restart ${PM2_NAME}"
echo "============================================================"
