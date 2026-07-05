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

# 4) Restart app
pm2 restart "$PM2_NAME" && echo "✓ ${PM2_NAME} di-restart"

echo "✅ Update produksi dari SimBill-Source selesai (${BEFORE} -> ${AFTER})."
echo "   Rollback bila perlu: cd $APP && tar xzf /opt/simbill-backup-${STAMP}.tar.gz && pm2 restart $PM2_NAME"
