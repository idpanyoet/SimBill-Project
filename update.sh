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

# 4a-4) Safety-net WireGuard: kalau wireguard-tools TERPASANG & kernel MENDUKUNG,
#   tapi /etc/wireguard/wg0.conf BELUM ADA → tombol "Start" WireGuard di panel
#   gagal ("wg0.conf does not exist"). Buat config server minimal (keypair + NAT +
#   ListenPort) + aktifkan ip_forward + buka UDP 51820. Idempotent & aman:
#   config yang SUDAH ADA sama sekali TIDAK disentuh; hanya dibuat bila belum ada.
if command -v wg >/dev/null 2>&1 && [ ! -f /etc/wireguard/wg0.conf ]; then
    # Pastikan kernel benar-benar bisa membuat interface wireguard dulu
    if modprobe wireguard 2>/dev/null && ip link add dev _wgchk type wireguard 2>/dev/null; then
        ip link del _wgchk 2>/dev/null || true
        c_info "WireGuard terpasang tapi belum ada wg0.conf — membuat config server ..."
        mkdir -p /etc/wireguard && chmod 700 /etc/wireguard
        WG_IFACE="$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'dev \K\S+' | head -1)"
        [ -z "$WG_IFACE" ] && WG_IFACE="eth0"
        (
          umask 077
          WG_PRIV="$(wg genkey)"
          printf '%s' "$WG_PRIV" | wg pubkey > /etc/wireguard/server_public.key
          cat > /etc/wireguard/wg0.conf <<WGCONF
[Interface]
Address = 10.10.28.1/24
ListenPort = 51820
PrivateKey = ${WG_PRIV}
PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o ${WG_IFACE} -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o ${WG_IFACE} -j MASQUERADE
WGCONF
          chmod 600 /etc/wireguard/wg0.conf
        ) && c_ok "wg0.conf dibuat (NAT via ${WG_IFACE})" || c_err "Gagal membuat wg0.conf"
        # ip_forward (wajib untuk routing tunnel), permanen
        sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
        grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf 2>/dev/null || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
        # buka UDP 51820 (idempotent — cek dulu sebelum insert)
        iptables -C INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null \
            || iptables -I INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null || true
        c_ok "WireGuard siap. Aktifkan lewat tombol Start di panel (atau: systemctl enable --now wg-quick@wg0)"
    else
        ip link del _wgchk 2>/dev/null || true
        c_info "WireGuard terpasang tapi kernel tidak mendukung interface wg — dilewati"
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

# ============================================================================
#  WA Gateway Mandiri (opsional / OPT-IN) — auto-setup.
#  Menyiapkan gateway WhatsApp mandiri (Baileys) di /opt/wa-gateway TANPA
#  mengubah provider WA aktif pelanggan. Pelanggan tetap harus memilih provider
#  "Mandiri" + scan QR di panel untuk mengaktifkannya.
#  Best-effort: kegagalan di sini TIDAK menggagalkan update SimBill.
# ============================================================================
setup_wa_gateway() {
    local WG_DIR="/opt/wa-gateway"
    local PM2_WG="wa-gateway"
    local WG_PORT="3200"

    command -v pm2 >/dev/null 2>&1 || { c_info "WA Gateway dilewati (pm2 tidak ada)"; return 0; }

    local NODE_MAJOR
    NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
        c_info "WA Gateway Mandiri dilewati (butuh Node >= 18; terpasang: ${NODE_MAJOR:-?})"
        return 0
    fi

    local MEM_MB
    MEM_MB="$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')"
    if [ -n "$MEM_MB" ] && [ "$MEM_MB" -lt 900 ]; then
        c_info "WA Gateway Mandiri dilewati (RAM ${MEM_MB}MB < 900MB, hindari OOM)"
        return 0
    fi

    c_info "Menyiapkan WA Gateway Mandiri di ${WG_DIR} ..."
    mkdir -p "$WG_DIR" || { c_info "WA Gateway: gagal buat folder (dilewati)"; return 0; }

    cat > "${WG_DIR}/package.json" <<'WA_PKG_EOF'
{
  "name": "simbill-wa-gateway-mandiri",
  "version": "1.0.1",
  "description": "WA Gateway mandiri (self-hosted, Baileys) untuk SimBill.",
  "type": "module",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "@hapi/boom": "^10.0.1",
    "@whiskeysockets/baileys": "^6.7.0",
    "express": "^4.19.2",
    "pino": "^9.0.0",
    "qrcode": "^1.5.3"
  }
}
WA_PKG_EOF

    cat > "${WG_DIR}/server.js" <<'WA_SERVER_EOF'
/**
 * SimBill — WA Gateway Mandiri (self-hosted, Baileys)
 * -------------------------------------------------------------
 * Service kecil terpisah dari billing-radius. Menjalankan koneksi
 * WhatsApp Web (multi-device) via Baileys, mengekspos HTTP API
 * yang dipanggil SimBill (provider "mandiri").
 *
 * Endpoint:
 *   GET  /                 -> health check ringkas (publik)
 *   GET  /status?token=... -> { connected, user, hasQR }
 *   GET  /qr?token=...     -> halaman HTML berisi QR untuk di-scan
 *   POST /send             -> kirim pesan (Authorization: Bearer <TOKEN>)
 *
 * Konfigurasi via ENV atau file .env (folder yang sama):
 *   WA_PORT (default 3200), WA_TOKEN (WAJIB), WA_SESSION_DIR (default <dir>/auth)
 *
 * PERINGATAN: Baileys = WhatsApp Web tidak resmi (melanggar ToS WA).
 * Nomor bisa kena banned, terutama OTP/broadcast volume tinggi. Pakai nomor khusus.
 */
import { Boom } from '@hapi/boom';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import { readFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Muat .env sederhana (tanpa dependency). ENV dari pm2 tetap diprioritaskan.
try {
  const envTxt = readFileSync(join(__dirname, '.env'), 'utf8');
  envTxt.split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
} catch { /* .env tidak ada — pakai ENV / default */ }

const PORT        = parseInt(process.env.WA_PORT || '3200', 10);
const TOKEN       = process.env.WA_TOKEN || 'GANTI-TOKEN-INI';
const SESSION_DIR = process.env.WA_SESSION_DIR || join(__dirname, 'auth');

const logger = pino({ level: 'silent' });

let sock = null;
let connected = false;
let meUser = null;
let currentQR = null;
let starting = false;

async function startSocket() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.ubuntu('SimBill'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try { currentQR = await QRCode.toDataURL(qr); } catch { currentQR = null; }
        connected = false;
        console.log('[WA] QR baru dibuat — buka /qr untuk scan.');
      }

      if (connection === 'open') {
        connected = true;
        currentQR = null;
        meUser = sock.user || null;
        console.log('[WA] Tersambung sebagai', meUser?.id || '(?)');
      }

      if (connection === 'close') {
        connected = false;
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log('[WA] Koneksi tertutup. code=', code, 'loggedOut=', loggedOut);

        if (loggedOut) {
          try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
          meUser = null;
        }
        starting = false;
        setTimeout(() => { startSocket().catch(e => console.error('[WA] restart gagal', e)); }, 2500);
        return;
      }
    });
  } catch (e) {
    console.error('[WA] startSocket error:', e?.message || e);
    setTimeout(() => { starting = false; startSocket().catch(()=>{}); }, 5000);
    return;
  }
  starting = false;
}

function toJid(raw) {
  let n = String(raw || '').replace(/[^0-9]/g, '');
  if (!n) return null;
  if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (n.startsWith('620')) n = '62' + n.slice(3);
  return n + '@s.whatsapp.net';
}

const app = express();
app.use(express.json({ limit: '2mb' }));

function checkToken(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const q = req.query.token;
  if (bearer === TOKEN || q === TOKEN) return next();
  return res.status(401).json({ error: 'Token tidak valid' });
}

app.get('/', (req, res) => {
  res.json({ service: 'simbill-wa-gateway-mandiri', connected, hasQR: !!currentQR });
});

app.get('/status', checkToken, (req, res) => {
  res.json({ connected, user: meUser?.id || null, hasQR: !!currentQR });
});

app.get('/qr', checkToken, (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (connected) {
    return res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2 style="color:#16a34a">✅ WhatsApp sudah tersambung</h2>
      <p>${meUser?.id || ''}</p></body>`);
  }
  const img = currentQR
    ? `<img src="${currentQR}" style="width:300px;height:300px">`
    : `<p>Menyiapkan QR… tunggu beberapa detik lalu halaman akan refresh.</p>`;
  res.send(`<!doctype html><meta charset="utf-8">
    <meta http-equiv="refresh" content="5">
    <body style="font-family:sans-serif;text-align:center;padding:30px">
      <h2>Scan QR — WA Gateway Mandiri</h2>
      <p>WhatsApp di HP → <b>Perangkat Tertaut</b> → <b>Tautkan Perangkat</b> → scan.</p>
      ${img}
      <p style="color:#888;font-size:12px">Halaman refresh otomatis tiap 5 detik.</p>
    </body>`);
});

app.post('/send', checkToken, async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ error: 'WA belum tersambung. Scan QR dulu.' });
    const { to, message } = req.body || {};
    const jid = toJid(to);
    if (!jid) return res.status(400).json({ error: 'Nomor tujuan tidak valid' });
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Pesan kosong' });

    const sent = await sock.sendMessage(jid, { text: String(message) });
    res.json({ success: true, id: sent?.key?.id || null, to: jid });
  } catch (e) {
    console.error('[WA] send error:', e?.message || e);
    res.status(500).json({ error: 'Gagal kirim: ' + (e?.message || 'unknown') });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[WA] Gateway mandiri jalan di http://127.0.0.1:${PORT}`);
  if (TOKEN === 'GANTI-TOKEN-INI') console.warn('[WA] ⚠️  WA_TOKEN belum diset (ENV atau .env)!');
  startSocket().catch(e => console.error('[WA] start gagal', e));
});
WA_SERVER_EOF

    # .env: token ACAK, dibuat SEKALI (jangan overwrite bila sudah ada -> jaga token & sesi)
    if [ ! -f "${WG_DIR}/.env" ]; then
        local TOK
        TOK="$(openssl rand -hex 48 2>/dev/null)"
        [ -z "$TOK" ] && TOK="$(head -c 48 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n')"
        [ -z "$TOK" ] && TOK="simbill$(date +%s)$$RANDOM"
        printf 'WA_PORT=%s\nWA_TOKEN=%s\n' "$WG_PORT" "$TOK" > "${WG_DIR}/.env"
        chmod 600 "${WG_DIR}/.env" 2>/dev/null || true
        c_ok "WA Gateway: token dibuat (${WG_DIR}/.env)"
    fi

    # dependensi (best-effort; jangan gagalkan update utama)
    if ( cd "$WG_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ); then
        c_ok "WA Gateway: dependensi siap"
    else
        c_info "WA Gateway: npm install ada kendala (dilewati, update SimBill tetap lanjut)"
    fi

    # start / restart (idempotent, cegah instance dobel)
    if pm2 describe "$PM2_WG" >/dev/null 2>&1; then
        ( cd "$WG_DIR" && pm2 restart "$PM2_WG" >/dev/null 2>&1 ) && c_ok "WA Gateway di-restart" || c_info "WA Gateway: restart gagal"
    else
        ( cd "$WG_DIR" && pm2 start server.js --name "$PM2_WG" >/dev/null 2>&1 ) \
            && c_ok "WA Gateway aktif (127.0.0.1:${WG_PORT}). Aktifkan di panel: Setting > WhatsApp > Mandiri (token ada di ${WG_DIR}/.env)." \
            || c_info "WA Gateway: gagal start (dilewati)"
    fi
    pm2 save >/dev/null 2>&1 || true
    return 0
}
setup_wa_gateway || c_info "WA Gateway Mandiri dilewati (non-fatal)"

echo "============================================================"
c_ok "UPDATE SELESAI: ${VERSI_LAMA} → ${VERSI_BARU}"
echo "  Backup: ${BACKUP_FILE}"
echo "  Rollback bila perlu:"
echo "    cd ${APP_DIR} && tar xzf ${BACKUP_FILE} && pm2 restart ${PM2_NAME}"
echo "============================================================"
