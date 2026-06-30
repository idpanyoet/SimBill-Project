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
RADIUS_SECRET="${RADIUS_SECRET:-}"     # kosong = digenerate otomatis
INSTALL_RADIUS="${INSTALL_RADIUS:-}"   # y | n  (FreeRADIUS terpasang default; set n untuk skip)
INSTALL_VPN="${INSTALL_VPN:-y}"        # y | n  (tools WireGuard & L2TP)
TZ_REGION="${TZ_REGION:-Asia/Jakarta}" # timezone server
DOMAIN="${DOMAIN:-}"                    # mis. simbill.domain.com → pasang Nginx+SSL (opsional)
EMAIL_SSL="${EMAIL_SSL:-}"             # email untuk Let's Encrypt (jika DOMAIN diisi)
MAKE_SWAP="${MAKE_SWAP:-y}"            # y | n  (buat swap bila RAM kecil)
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
[ -z "$RADIUS_SECRET" ] && RADIUS_SECRET="$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)"

# ── Timezone (penting untuk cron tagihan/reminder & tanggal invoice) ──
timedatectl set-timezone "$TZ_REGION" >/dev/null 2>&1 || ln -sf "/usr/share/zoneinfo/${TZ_REGION}" /etc/localtime 2>/dev/null || true
ok "Timezone: ${TZ_REGION}"

# ── Swap (Chromium x2 berat — cegah OOM di VPS RAM kecil) ──
if [[ "${MAKE_SWAP,,}" == y* ]]; then
  RAM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 2048)
  if [ "${RAM_MB:-2048}" -lt 2048 ] && ! swapon --show 2>/dev/null | grep -q .; then
    if fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 2>/dev/null; then
      chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null || true
      grep -q '/swapfile' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      ok "Swap 2GB dibuat (RAM ${RAM_MB}MB)"
    fi
  fi
fi

step "1/7 Paket dasar"
apt-get update -y -qq
apt-get install -y -qq curl wget git ca-certificates gnupg lsb-release openssl build-essential unzip tar iproute2 cron >/dev/null
ok "Paket dasar terpasang"

step "2/7 Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || [ "$(node -v | grep -oE '[0-9]+' | head -1)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v) • npm $(npm -v)"
npm install -g pm2 >/dev/null 2>&1 || npm install -g pm2
ok "pm2 $(pm2 -v)"

step "2b/7 Dependency Chromium (cetak invoice/voucher PDF & WhatsApp QR)"
# Puppeteer & whatsapp-web.js menjalankan Chromium headless yang butuh library ini.
# Diinstall satu per satu agar tahan perbedaan nama paket antar Ubuntu 22/24 & Debian.
CHROME_DEPS="ca-certificates fonts-liberation fonts-noto-color-emoji fontconfig \
libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 \
libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 \
libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libxshmfence1 libxcb1 libx11-xcb1 \
libxss1 libglib2.0-0 libasound2 libasound2t64"
INSTALLED=0
for pkg in $CHROME_DEPS; do
  apt-get install -y -qq "$pkg" >/dev/null 2>&1 && INSTALLED=$((INSTALLED+1)) || true
done
ok "Library Chromium terpasang (${INSTALLED} paket)"

# Browser Chromium sistem — dipakai Puppeteer agar TIDAK perlu mengunduh Chrome
# bawaan (~170MB). Ini mencegah kegagalan "ENOSPC: no space left" di VPS kecil.
CHROME_BIN=""
for cand in chromium-browser chromium; do
  if apt-get install -y -qq "$cand" >/dev/null 2>&1; then
    CHROME_BIN="$(command -v "$cand" 2>/dev/null || true)"
    [ -n "$CHROME_BIN" ] && break
  fi
done
if [ -n "$CHROME_BIN" ]; then
  ok "Chromium browser: ${CHROME_BIN} (Puppeteer pakai ini, skip unduh Chrome)"
else
  info "Chromium browser sistem tak tersedia — Puppeteer akan mengunduh Chrome sendiri (butuh ruang disk)"
fi

step "2c/7 Tools VPN (WireGuard & L2TP/IPSec)"
# Dipakai fitur 'VPN Server' SimBill (app memanggil wg/wg-quick; cek xl2tpd & ipsec).
# Konfigurasi VPN dilakukan dari menu VPN di dashboard — ini hanya menyiapkan binary-nya.
INSTALL_VPN="${INSTALL_VPN:-y}"
if [[ "${INSTALL_VPN,,}" == y* ]]; then
  VPN_OK=0
  for pkg in wireguard-tools ppp xl2tpd strongswan strongswan-pki libcharon-extra-plugins; do
    apt-get install -y -qq "$pkg" >/dev/null 2>&1 && VPN_OK=$((VPN_OK+1)) || true
  done
  ok "Tools VPN terpasang (${VPN_OK} paket) — konfigurasi via menu VPN SimBill"
else
  info "Tools VPN dilewati (INSTALL_VPN=n)"
fi

step "3/7 MariaDB"
apt-get install -y -qq mariadb-server mariadb-client >/dev/null
systemctl enable --now mariadb >/dev/null 2>&1 || service mariadb start
ok "MariaDB aktif"

step "4/7 Database '${DB_NAME}' & user '${DB_USER}'"
mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
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
RADIUS_SECRET=${RADIUS_SECRET}
ENV
  # Puppeteer pakai Chromium sistem bila ada (hemat ruang, hindari ENOSPC)
  if [ -n "${CHROME_BIN:-}" ]; then
    { echo "PUPPETEER_SKIP_DOWNLOAD=true"; echo "PUPPETEER_EXECUTABLE_PATH=${CHROME_BIN}"; } >> "$ENV_FILE"
  fi
  ok ".env dibuat (JWT_SECRET digenerate)"
else
  info ".env sudah ada → dibiarkan"
fi

# Skip unduh Chrome bawaan Puppeteer bila Chromium sistem tersedia (hemat ~170MB,
# cegah ENOSPC). Bila tidak ada Chromium sistem, biarkan Puppeteer mengunduh sendiri.
PPTR_ENV=""
[ -n "${CHROME_BIN:-}" ] && PPTR_ENV="PUPPETEER_SKIP_DOWNLOAD=true"
( cd "${INSTALL_DIR}/backend" && env $PPTR_ENV npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || ( cd "${INSTALL_DIR}/backend" && env $PPTR_ENV npm install --production )
ok "Dependency backend terpasang"

# Safety-net dependensi modul OLT. ssh2 WAJIB untuk services/olt.js; net-snmp
# untuk monitoring SNMP. Mode install di atas pakai --omit=dev/--production,
# jadi normalnya keduanya ikut (bukan devDependency). Verifikasi tetap agar
# VPS baru tidak crash saat start ("Cannot find module 'ssh2'") bila npm
# install sempat gagal sebagian / package.json rilis tertinggal.
for mod in ssh2 net-snmp; do
  if ! ( cd "${INSTALL_DIR}/backend" && node -e "require('${mod}')" >/dev/null 2>&1 ); then
    info "Dependensi '${mod}' belum terpasang — menginstal ..."
    ( cd "${INSTALL_DIR}/backend" && npm install "${mod}" --no-audit --no-fund >/dev/null 2>&1 ) \
      && ok "'${mod}' terpasang" \
      || info "Gagal pasang '${mod}' — jalankan manual: cd ${INSTALL_DIR}/backend && npm install ${mod}"
  fi
done

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

# ── Perbaikan skema RADIUS yang sering terlewat ──
# 1) Tabel nasreload: dibutuhkan FreeRADIUS untuk deteksi perubahan NAS.
#    Tanpa tabel ini, radius.log dibanjiri "ERROR 1146 ... nasreload doesn't exist".
# 2) Bersihkan atribut Mikrotik-Keepalive-Timeout: TIDAK dikenal dictionary
#    FreeRADIUS 3.2.x → membuat SELURUH auth group gagal (semua user hotspot
#    di group itu tak bisa login). Aman dihapus; keepalive diatur di MikroTik.
mysql "${DB_NAME}" <<'SQL' 2>/dev/null || true
CREATE TABLE IF NOT EXISTS nasreload (
  nasipaddress varchar(15) NOT NULL,
  reloadtime datetime NOT NULL,
  PRIMARY KEY (nasipaddress)
);
DELETE FROM radgroupreply WHERE attribute='Mikrotik-Keepalive-Timeout';
DELETE FROM radreply      WHERE attribute='Mikrotik-Keepalive-Timeout';
SQL
ok "Tabel nasreload dipastikan ada + atribut RADIUS bermasalah dibersihkan"

# ── Kolom tabel 'paket' yang sering belum ada di schema dasar ──
# Tanpa kolom ini, sinkronisasi radcheck saat startup gagal ("Unknown column
# 'pk.rate_limit'") dan GET /voucher/paket error ("Unknown column 'izin_voucher'").
# Migrasi di kode dijalankan terlalu lambat (setelah sync), jadi dipastikan di sini.
mysql "${DB_NAME}" <<'SQL' 2>/dev/null || true
ALTER TABLE paket ADD COLUMN IF NOT EXISTS rate_limit   VARCHAR(128) NULL;
ALTER TABLE paket ADD COLUMN IF NOT EXISTS izin_voucher TINYINT(1)   NOT NULL DEFAULT 0;
ALTER TABLE paket ADD COLUMN IF NOT EXISTS share_users  INT UNSIGNED NOT NULL DEFAULT 1;
SQL
ok "Kolom tabel 'paket' dipastikan lengkap (rate_limit, izin_voucher, share_users)"

# ── Set password admin default (hash bcrypt asli, bukan placeholder) ──
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
ADMIN_HASH="$(cd "${INSTALL_DIR}/backend" && node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" "$ADMIN_PASS" 2>/dev/null || true)"
if [ -n "$ADMIN_HASH" ]; then
  mysql "${DB_NAME}" <<SQL 2>/dev/null || true
INSERT INTO admin (username, nama, email, password, role, aktif)
VALUES ('${ADMIN_USER}', 'Super Admin', 'admin@billing.id', '${ADMIN_HASH}', 'superadmin', 1)
ON DUPLICATE KEY UPDATE password = VALUES(password), aktif = 1, role = VALUES(role);
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

# ── FreeRADIUS (terpasang default; matikan dengan INSTALL_RADIUS=n) ──
if [ -z "$INSTALL_RADIUS" ]; then
  if [ -t 0 ]; then
    read -r -p "Pasang FreeRADIUS sekarang? [Y/n]: " INSTALL_RADIUS || true
    INSTALL_RADIUS="${INSTALL_RADIUS:-y}"   # Enter = Ya (default pasang)
  else
    INSTALL_RADIUS=y                         # non-interaktif (curl|bash) → tetap pasang
  fi
fi
if [[ "${INSTALL_RADIUS,,}" == y* ]]; then
  step "FreeRADIUS + integrasi DB"
  apt-get install -y -qq freeradius freeradius-mysql freeradius-utils >/dev/null
  systemctl stop freeradius >/dev/null 2>&1 || true

  RADDIR="$(ls -d /etc/freeradius/*/ 2>/dev/null | head -1)"
  SQLMOD="${RADDIR}mods-available/sql"
  if [ -z "$RADDIR" ] || [ ! -f "$SQLMOD" ]; then
    info "Direktori config FreeRADIUS tak ditemukan — lewati auto-config"
  else
    # 1) Modul sql → arahkan ke DB SimBill (dialect mysql)
    #    server/login/password di Ubuntu 22/24 ter-comment ('#') by default,
    #    jadi pola harus menerima '#?' (uncomment + set). Target nilai default
    #    "localhost"/"radius"/"radpass" agar TIDAK menyentuh contoh mongodb/postgres.
    sed -i -E \
      -e 's|^([[:space:]]*)dialect = .*|\1dialect = "mysql"|' \
      -e 's|^([[:space:]]*)driver = "rlm_sql_null"|\1driver = "rlm_sql_mysql"|' \
      -e "s|^([[:space:]]*)#?[[:space:]]*server = \"localhost\".*|\1server = \"127.0.0.1\"|" \
      -e "s|^([[:space:]]*)#?[[:space:]]*login = \"radius\".*|\1login = \"${DB_USER}\"|" \
      -e "s|^([[:space:]]*)#?[[:space:]]*password = \"radpass\".*|\1password = \"${DB_PASS}\"|" \
      -e "s|^([[:space:]]*)radius_db = .*|\1radius_db = \"${DB_NAME}\"|" \
      -e 's|^([[:space:]]*)#?[[:space:]]*read_clients = yes|\1read_clients = yes|' \
      -e 's|^([[:space:]]*)#?[[:space:]]*client_table = .*|\1client_table = "nas"|' \
      "$SQLMOD"

    # 1b) JARING PENGAMAN (Python): pastikan server/login/password/radius_db
    #     benar-benar ada & uncommented di blok sql{}. Menangani baris ber-'#'
    #     dan password berkarakter khusus (nilai dilewatkan via argv, bukan regex).
    #     Hanya occurrence PERTAMA tiap kunci yang di-set (hindari contoh mongodb/pg).
    python3 - "$SQLMOD" "$DB_USER" "$DB_PASS" "$DB_NAME" <<'PY'
import sys, re
f, user, pw, db = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def esc(v): return v.replace('\\', '\\\\').replace('"', '\\"')
want = {'server': '127.0.0.1', 'login': user, 'password': pw, 'radius_db': db}
lines = open(f).read().splitlines()
seen, out = set(), []
for ln in lines:
    m = re.match(r'^(\s*)#?\s*(server|login|password|radius_db)\s*=\s*"[^"]*"\s*$', ln)
    if m and m.group(2) not in seen:
        k = m.group(2); seen.add(k)
        out.append('%s%s = "%s"' % (m.group(1), k, esc(want[k])))
    else:
        out.append(ln)
missing = [k for k in want if k not in seen]
if missing:
    res = []
    for ln in out:
        res.append(ln)
        if re.match(r'^\s*driver\s*=\s*"rlm_sql_mysql"', ln):
            ind = re.match(r'^(\s*)', ln).group(1)
            for k in missing:
                res.append('%s%s = "%s"' % (ind, k, esc(want[k])))
    out = res
open(f, 'w').write('\n'.join(out) + '\n')
PY

    # 1b) BUANG blok tls{} secara utuh (brace-aware). Penting di Ubuntu 24:
    #     mods-available/sql bawaan punya tls{ ca_file="/etc/ssl/certs/my_ca.crt" }
    #     yang menunjuk file tak ada → modul sql gagal di-instantiate → FreeRADIUS
    #     menolak start. Mengomentari sebagian akan merusak pasangan kurung, jadi
    #     blok-nya dihapus utuh dengan menghitung kedalaman { }.
    python3 - "$SQLMOD" <<'PY'
import sys, re
f = sys.argv[1]
lines = open(f).read().splitlines()
out, skip, depth = [], False, 0
for ln in lines:
    st = ln.strip().lstrip('#').strip()
    if not skip and re.match(r'tls\s*\{', st):
        skip = True
        depth = ln.count('{') - ln.count('}')
        if depth <= 0: skip = False
        continue
    if skip:
        depth += ln.count('{') - ln.count('}')
        if depth <= 0: skip = False
        continue
    out.append(ln)
open(f, 'w').write('\n'.join(out) + '\n')
PY

    # 2) Aktifkan modul sql
    ln -sf ../mods-available/sql "${RADDIR}mods-enabled/sql"

    # 3) Aktifkan sql di sites (uncomment baris '#sql' di authorize/accounting/post-auth/session)
    for site in "${RADDIR}sites-enabled/default" "${RADDIR}sites-enabled/inner-tunnel"; do
      [ -f "$site" ] && sed -i 's/^\([[:space:]]*\)#[[:space:]]*sql[[:space:]]*$/\1sql/' "$site"
    done

    # 4) Hak akses (radius perlu baca config berisi password DB)
    chgrp -h freerad "${RADDIR}mods-enabled/sql" 2>/dev/null || true
    chown freerad:freerad "$SQLMOD" 2>/dev/null || true
    chmod 640 "$SQLMOD" 2>/dev/null || true

    # 4c) BlastRADIUS (CVE-2024-3596): FreeRADIUS 3.2.5+ default-nya
    #     'require_message_authenticator = auto' → request PERTAMA tiap NAS baru
    #     sempat di-drop ("no response") sambil server "belajar". MikroTik kirim
    #     Message-Authenticator, jadi aman dipaksa 'yes' supaya tanpa drop awal.
    RADCONF="${RADDIR}radiusd.conf"
    if [ -f "$RADCONF" ]; then
      if grep -qE '^[[:space:]]*require_message_authenticator[[:space:]]*=' "$RADCONF"; then
        sed -i -E 's|^([[:space:]]*)require_message_authenticator[[:space:]]*=.*|\1require_message_authenticator = yes|' "$RADCONF"
        ok "BlastRADIUS: require_message_authenticator = yes"
      else
        # Direktif belum ada (versi lama / dihapus) → sisipkan ke blok security {}
        python3 - "$RADCONF" <<'PY'
import sys, re
f = sys.argv[1]
lines = open(f).read().splitlines()
out, done = [], False
for ln in lines:
    out.append(ln)
    if not done and re.match(r'^\s*security\s*\{', ln):
        ind = re.match(r'^(\s*)', ln).group(1) + '\t'
        out.append('%srequire_message_authenticator = yes' % ind)
        done = True
open(f, 'w').write('\n'.join(out) + '\n')
PY
      fi
    fi

    # 5) Cek config & jalankan
    if freeradius -XC >/tmp/simbill-fr-check.log 2>&1; then
      systemctl enable --now freeradius >/dev/null 2>&1 || true
      ok "FreeRADIUS aktif → DB '${DB_NAME}', NAS dibaca dari tabel 'nas'"
    else
      systemctl enable freeradius >/dev/null 2>&1 || true
      info "FreeRADIUS terpasang tapi cek config gagal. 15 baris terakhir:"
      tail -15 /tmp/simbill-fr-check.log | sed 's/^/    /'
      info "Debug manual: ${C_B}freeradius -X${C_R}"
    fi
    info "Daftarkan MikroTik di menu RADIUS/NAS SimBill, lalu: systemctl restart freeradius"
  fi
fi

# ── Safety-net config xl2tpd (L2TP) ──────────────────────────────────────────
# Ubuntu memasang /etc/xl2tpd/xl2tpd.conf berisi CONTOH (semua baris diawali ';')
# sehingga TIDAK ada [lns] aktif → semua peer ditolak "No Authorization".
# Tulis config benar HANYA jika belum ada [lns] aktif. Config valid (skema IP
# milikmu sendiri) TIDAK akan disentuh.
if command -v xl2tpd >/dev/null 2>&1; then
  if ! grep -qE '^[[:space:]]*\[lns' /etc/xl2tpd/xl2tpd.conf 2>/dev/null; then
    info "xl2tpd.conf belum punya [lns] aktif — menulis config default SimBill"
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
    ok "xl2tpd.conf diperbaiki ([lns default] aktif)"
  fi
fi

# ── Jaringan: ip_forward + buka port RADIUS/VPN (idempotent, non-destruktif) ──
# Banyak VPS (mis. Tencent/Alibaba) punya INPUT policy DROP → paket RADIUS (1812/1813)
# & L2TP (1701) diblok diam-diam sehingga "server tidak merespon". Plus L2TP butuh
# IP forwarding. Hanya dijalankan bila RADIUS atau VPN dipasang.
if [[ "${INSTALL_RADIUS,,}" == y* || "${INSTALL_VPN,,}" == y* ]]; then
  step "Jaringan (ip_forward + firewall RADIUS/L2TP)"
  sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
  echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-simbill.conf

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "Status: active"; then
    # Hormati ufw bila sedang dipakai — buka port lewat ufw (persist sendiri)
    for p in 1812 1813 1701; do ufw allow ${p}/udp >/dev/null 2>&1 || true; done
    ok "Port RADIUS/L2TP dibuka via ufw (UDP 1812/1813/1701)"
  else
    # Tanpa ufw aktif → pakai iptables langsung (idempotent: -C cek dulu, -I bila belum ada)
    for p in 1812 1813 1701; do
      iptables -C INPUT -p udp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport $p -j ACCEPT
    done
    iptables -C INPUT -i ppp+ -j ACCEPT 2>/dev/null || iptables -I INPUT -i ppp+ -j ACCEPT
    command -v netfilter-persistent >/dev/null 2>&1 || apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    mkdir -p /etc/iptables; iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    ok "Port RADIUS/L2TP dibuka via iptables (UDP 1812/1813/1701 + ppp+)"
  fi
  info "Jika VPS di belakang firewall cloud (Security Group), buka juga UDP 1812/1813/1701 di panel."
fi

# ── Nginx + SSL (opsional, jika DOMAIN diisi) — penting untuk webhook payment HTTPS ──
ACCESS_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${APP_PORT}"
if [ -n "$DOMAIN" ]; then
  step "Nginx + SSL untuk ${DOMAIN}"
  apt-get install -y -qq nginx >/dev/null 2>&1 || true
  cat > /etc/nginx/sites-available/simbill <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/simbill /etc/nginx/sites-enabled/simbill
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || true
  ok "Nginx reverse-proxy aktif (:80 → :${APP_PORT})"
  # SSL via certbot
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1 || true
  CB_EMAIL_ARG="--register-unsafely-without-email"
  [ -n "$EMAIL_SSL" ] && CB_EMAIL_ARG="-m ${EMAIL_SSL}"
  if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos ${CB_EMAIL_ARG} --redirect >/dev/null 2>&1; then
    ok "SSL aktif → https://${DOMAIN}"
    ACCESS_URL="https://${DOMAIN}"
  else
    info "Nginx aktif, tapi SSL gagal (cek: DNS ${DOMAIN} sudah arah ke IP ini?). Jalankan ulang: certbot --nginx -d ${DOMAIN}"
    ACCESS_URL="http://${DOMAIN}"
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "${C_B}════════════════ SELESAI ════════════════${C_R}"
echo "  URL aplikasi : ${C_OK}${ACCESS_URL}${C_R}"
echo "  Folder       : ${INSTALL_DIR}"
echo "  pm2 name     : ${PM2_NAME}"
echo "  Database     : ${DB_NAME}"
echo "  DB user/pass : ${DB_USER} / ${C_WARN}${DB_PASS}${C_R}"
echo "  ${C_WARN}↑ Simpan kredensial DB ini.${C_R}"
echo
echo "  Login admin  : ${C_OK}${ADMIN_USER}${C_R} / ${C_WARN}${ADMIN_PASS}${C_R}"
echo "  ${C_WARN}↑ Ganti password admin segera setelah login.${C_R}"
echo
echo "  Port yang dipakai (buka juga di firewall cloud bila perlu):"
echo "    3000 (app) · 7547 (TR-069/ACS)"
echo "    1812-1813/udp (RADIUS) · 51820/udp (WireGuard) · 1701/500/4500/udp (L2TP/IPSec)"
echo "  Update nanti :"
echo "    wget -qO- https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/update.sh | sudo bash"
echo "${C_B}═════════════════════════════════════════${C_R}"
