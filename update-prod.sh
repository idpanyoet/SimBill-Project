#!/usr/bin/env bash
# ============================================================================
#  update-prod.sh — Update billing PRODUKSI dari SimBill-Source (plain).
#  Aman & terkontrol: backup dulu -> pull -> npm install -> pm2 restart.
#  Cocok untuk VPS produksimu sendiri (origin = SimBill-Source).
#  JANGAN dipakai di server pelanggan (mereka pakai SimBill-Project public).
# ============================================================================
set -e
APP="/opt/simbill"
PM2_NAME="billing-radius"
cd "$APP"

# 0) Pastikan origin = SimBill-Source (cegah salah tarik repo customer)
ORIGIN="$(git remote get-url origin)"
case "$ORIGIN" in
  *SimBill-Source*) : ;;
  *) echo "✗ origin bukan SimBill-Source ($ORIGIN). Batal demi keamanan."; exit 1 ;;
esac

# 1) Backup kode (jaga-jaga rollback)
STAMP="$(date +%Y%m%d-%H%M)"
tar czf "/opt/simbill-backup-${STAMP}.tar.gz" \
  --exclude=node_modules --exclude=_backup --exclude=.git \
  --exclude=frontend/uploads -C "$APP" . && echo "✓ backup: /opt/simbill-backup-${STAMP}.tar.gz"

# 2) Ambil & terapkan versi terbaru dari SimBill-Source
git fetch origin master
BEFORE="$(git rev-parse --short HEAD)"
# Tampilkan apa yang akan masuk
echo "=== commit baru yang akan masuk ==="
git log --oneline HEAD..origin/master || true
git reset --hard origin/master
AFTER="$(git rev-parse --short HEAD)"
echo "✓ kode: ${BEFORE} -> ${AFTER}"

# 3) Install dependensi bila package.json berubah (aman dijalankan selalu)
if [ -f backend/package.json ]; then
  ( cd backend && npm install --no-audit --no-fund ) && echo "✓ dependensi siap"
fi

c_ok(){ echo "[OK] $1"; }; c_info(){ echo "[ii] $1"; }
# ============================================================================
#  WA Gateway Mandiri (opsional / OPT-IN) — auto-setup.
#  DIJALANKAN SEBELUM restart billing-radius: saat update dipicu dari tombol
#  panel, script berjalan sebagai proses anak billing-radius; jika gateway
#  disiapkan SETELAH restart, restart itu bisa membunuh script sebelum blok ini
#  jalan. Maka blok ini diletakkan sebelum restart aplikasi.
#  Best-effort: kegagalan di sini TIDAK menggagalkan update SimBill.
#  TIDAK mengubah provider WA aktif pelanggan (opt-in via panel).
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

// QR dalam bentuk JSON (data URL) — dipakai panel SimBill untuk menampilkan QR di modal.
app.get('/qr.json', checkToken, (req, res) => {
  res.json({ connected, user: meUser?.id || null, hasQR: !!currentQR, qr: connected ? null : currentQR });
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

    if [ ! -f "${WG_DIR}/.env" ]; then
        local TOK
        TOK="$(openssl rand -hex 48 2>/dev/null)"
        [ -z "$TOK" ] && TOK="$(head -c 48 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n')"
        [ -z "$TOK" ] && TOK="simbill$(date +%s)$$RANDOM"
        printf 'WA_PORT=%s\nWA_TOKEN=%s\n' "$WG_PORT" "$TOK" > "${WG_DIR}/.env"
        chmod 600 "${WG_DIR}/.env" 2>/dev/null || true
        c_ok "WA Gateway: token dibuat (${WG_DIR}/.env)"
    fi

    if ( cd "$WG_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ); then
        c_ok "WA Gateway: dependensi siap"
    else
        c_info "WA Gateway: npm install ada kendala (dilewati, update SimBill tetap lanjut)"
    fi

    if pm2 describe "$PM2_WG" >/dev/null 2>&1; then
        ( cd "$WG_DIR" && pm2 restart "$PM2_WG" >/dev/null 2>&1 ) && c_ok "WA Gateway di-restart" || c_info "WA Gateway: restart gagal"
    else
        ( cd "$WG_DIR" && pm2 start server.js --name "$PM2_WG" >/dev/null 2>&1 ) \
            && c_ok "WA Gateway aktif (127.0.0.1:${WG_PORT}). Aktifkan di panel: Setting > WhatsApp > Mandiri (token otomatis)." \
            || c_info "WA Gateway: gagal start (dilewati)"
    fi
    pm2 save >/dev/null 2>&1 || true
    return 0
}
setup_wa_gateway || c_info "WA Gateway Mandiri dilewati (non-fatal)"

# ============================================================================
#  ACS Lite (GoACS) — auto-setup OPSIONAL untuk TR-069 mandiri.
#  Ringan (1 binary Go) tapi butuh: MariaDB (bikin DB 'acs' + user khusus,
#  TIDAK mengubah root), systemd, dan port 7547 bebas. Binary diunduh dari
#  repo (override via env ACSLITE_BASE). Best-effort: kegagalan TIDAK
#  menggagalkan update. Idempotent: kalau sudah terpasang, hanya di-restart.
#  Aktivasi tetap manual di panel (Jaringan > ACS Lite) — install != pakai.
# ============================================================================
setup_acslite() {
    local ACS_DIR="/opt/acs"
    local ACS_PORT="7547"
    local SVC="acslite"
    local ACS_BASE="${ACSLITE_BASE:-https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/acslite}"

    command -v systemctl >/dev/null 2>&1 || { c_info "ACS Lite dilewati (systemd tidak ada)"; return 0; }
    command -v mysql >/dev/null 2>&1     || { c_info "ACS Lite dilewati (MariaDB tidak ada)"; return 0; }
    { command -v wget >/dev/null 2>&1 || command -v curl >/dev/null 2>&1; } || { c_info "ACS Lite dilewati (wget/curl tidak ada)"; return 0; }

    local MEM_MB; MEM_MB="$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')"
    if [ -n "$MEM_MB" ] && [ "$MEM_MB" -lt 1024 ]; then
        c_info "ACS Lite dilewati (RAM ${MEM_MB}MB < 1024MB)"; return 0
    fi

    # Sudah terpasang (binary + .env) → cukup pastikan jalan, jangan setup ulang.
    if [ -x "${ACS_DIR}/acs" ] && [ -f "${ACS_DIR}/.env" ]; then
        systemctl restart "$SVC" >/dev/null 2>&1 && c_ok "ACS Lite: service di-restart" || c_info "ACS Lite: restart dilewati"
        return 0
    fi

    # Port 7547 sudah dipakai (mis. GenieACS di server yang sama) → jangan pasang.
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${ACS_PORT} "; then
        c_info "ACS Lite dilewati (port ${ACS_PORT} sudah dipakai layanan lain)"; return 0
    fi

    local ARCH BINF
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64)  BINF="acs-linux-amd64" ;;
        aarch64) BINF="acs-linux-arm64" ;;
        *) c_info "ACS Lite dilewati (arsitektur $ARCH tidak didukung)"; return 0 ;;
    esac

    c_info "Menyiapkan ACS Lite (GoACS) di ${ACS_DIR} ..."
    mkdir -p "${ACS_DIR}/web/templates" || { c_info "ACS Lite: gagal buat folder"; return 0; }

    _acs_dl() { if command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"; else curl -fsSL -o "$2" "$1"; fi; }

    if ! _acs_dl "${ACS_BASE}/build/${BINF}" "${ACS_DIR}/acs"; then
        c_info "ACS Lite dilewati (gagal unduh binary — belum tersedia di repo)"; return 0
    fi
    if [ "$(stat -c%s "${ACS_DIR}/acs" 2>/dev/null || echo 0)" -lt 1000000 ]; then
        c_info "ACS Lite dilewati (binary tidak valid / 404)"; rm -f "${ACS_DIR}/acs"; return 0
    fi
    chmod +x "${ACS_DIR}/acs"
    _acs_dl "${ACS_BASE}/web/templates/index.html" "${ACS_DIR}/web/templates/index.html" || true

    # === Siapkan database untuk GoACS ===
    # 1) root via socket  -> DB 'acs' TERPISAH + user khusus (paling bersih).
    # 2) kredensial SimBill (backend/.env):
    #    a) coba DB 'acs' terpisah (kalau user berhak CREATE DATABASE), ATAU
    #    b) numpang di DB SimBill (GoACS bikin 2 tabel: devices, tasks) SETELAH
    #       cek tidak ada tabel bentrok. TIDAK mengubah password root MariaDB.
    local ENVF="/opt/simbill/backend/.env"
    _acs_envget() { local k v; for k in "$@"; do v="$(sed -n "s/^[[:space:]]*${k}=//p" "$ENVF" 2>/dev/null | head -1 | tr -d '"\r' | sed 's/[[:space:]]*$//')"; [ -n "$v" ] && { printf '%s' "$v"; return 0; }; done; }
    local DBPASS APIKEY DSN=""
    DBPASS="$(openssl rand -hex 16 2>/dev/null || echo simbillacs$RANDOM$RANDOM)"
    APIKEY="$(openssl rand -hex 24 2>/dev/null || echo k$(date +%s)$RANDOM)"

    if mysql -e "SELECT 1" >/dev/null 2>&1; then
        if mysql <<SQL 2>/dev/null
CREATE DATABASE IF NOT EXISTS acs;
CREATE USER IF NOT EXISTS 'acs_user'@'127.0.0.1' IDENTIFIED BY '${DBPASS}';
ALTER USER 'acs_user'@'127.0.0.1' IDENTIFIED BY '${DBPASS}';
GRANT ALL PRIVILEGES ON acs.* TO 'acs_user'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
        then DSN="acs_user:${DBPASS}@tcp(127.0.0.1:3306)/acs?parseTime=true"; c_ok "ACS Lite: DB 'acs' terpisah dibuat (root socket)"; fi
    elif [ -f "$ENVF" ]; then
        local MZ_H MZ_PORT MZ_U MZ_P MZ_DB
        MZ_H="$(_acs_envget DB_HOST MYSQL_HOST)"; [ -z "$MZ_H" ] && MZ_H="127.0.0.1"
        MZ_PORT="$(_acs_envget DB_PORT MYSQL_PORT)"; [ -z "$MZ_PORT" ] && MZ_PORT="3306"
        MZ_U="$(_acs_envget DB_USER DB_USERNAME MYSQL_USER)"
        MZ_P="$(_acs_envget DB_PASSWORD DB_PASS MYSQL_PASSWORD MYSQL_PASS)"
        MZ_DB="$(_acs_envget DB_NAME DB_DATABASE MYSQL_DATABASE)"
        if [ -n "$MZ_U" ] && mysql -h"$MZ_H" -P"$MZ_PORT" -u"$MZ_U" ${MZ_P:+-p"$MZ_P"} -e "SELECT 1" >/dev/null 2>&1; then
            if mysql -h"$MZ_H" -P"$MZ_PORT" -u"$MZ_U" ${MZ_P:+-p"$MZ_P"} -e "CREATE DATABASE IF NOT EXISTS acs;" >/dev/null 2>&1; then
                DSN="${MZ_U}:${MZ_P}@tcp(${MZ_H}:${MZ_PORT})/acs?parseTime=true"
                c_ok "ACS Lite: DB 'acs' terpisah dibuat (kredensial SimBill)"
            elif [ -n "$MZ_DB" ]; then
                local BENTROK
                BENTROK="$(mysql -N -h"$MZ_H" -P"$MZ_PORT" -u"$MZ_U" ${MZ_P:+-p"$MZ_P"} "$MZ_DB" -e "SHOW TABLES LIKE 'devices'; SHOW TABLES LIKE 'tasks';" 2>/dev/null)"
                if [ -z "$BENTROK" ]; then
                    DSN="${MZ_U}:${MZ_P}@tcp(${MZ_H}:${MZ_PORT})/${MZ_DB}?parseTime=true"
                    c_info "ACS Lite: GoACS numpang di database SimBill (${MZ_DB}); tabel devices & tasks."
                else
                    c_info "ACS Lite dilewati (tabel devices/tasks sudah ada di ${MZ_DB} - hindari bentrok)"; return 0
                fi
            fi
        fi
    fi

    if [ -z "$DSN" ]; then
        c_info "ACS Lite dilewati (tidak bisa siapkan database - install manual dgn root)"; return 0
    fi

    umask 177
    cat > "${ACS_DIR}/.env" <<EOF
ACS_PORT=${ACS_PORT}
DB_DSN=${DSN}
API_KEY=${APIKEY}
EOF
    umask 022
    chmod 600 "${ACS_DIR}/.env" 2>/dev/null || true

    cat > /etc/systemd/system/${SVC}.service <<EOF
[Unit]
Description=ACS Lite (GoACS) TR-069
After=network.target mariadb.service mysql.service
[Service]
Type=simple
User=root
WorkingDirectory=${ACS_DIR}
ExecStart=${ACS_DIR}/acs
EnvironmentFile=${ACS_DIR}/.env
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1
    systemctl enable "$SVC" >/dev/null 2>&1
    systemctl restart "$SVC" >/dev/null 2>&1
    sleep 2
    if systemctl is-active --quiet "$SVC"; then
        c_ok "ACS Lite aktif (127.0.0.1:${ACS_PORT}). Aktifkan di panel: Jaringan > ACS Lite (key otomatis)."
    else
        c_info "ACS Lite terpasang tapi belum aktif — cek: journalctl -u ${SVC} -e"
    fi
    return 0
}
setup_acslite || c_info "ACS Lite dilewati (non-fatal)"

# 4) Restart app
pm2 restart "$PM2_NAME" && echo "✓ ${PM2_NAME} di-restart"

echo "✅ Update produksi dari SimBill-Source selesai (${BEFORE} -> ${AFTER})."
echo "   Rollback bila perlu: cd $APP && tar xzf /opt/simbill-backup-${STAMP}.tar.gz && pm2 restart $PM2_NAME"
