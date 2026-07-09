// routes/wa-command.js — Bot perintah via WhatsApp (webhook incoming, PUBLIK).
// Arsitektur multi-provider (adapter): Fonnte dulu; Wablas/WA Business/WAHA/Mandiri
// tinggal tambah 1 adapter (parse payload masuk + reply). Logic perintah SAMA.
//
// Peran (Opsi B):
//   - nomor ∈ setting.wa_cmd_admins  → ADMIN/TEKNISI: redaman/pelanggan/tiket siapa saja
//   - cocok pelanggan.no_hp          → PELANGGAN (self-service akun sendiri):
//        redaman · ganti ssid <x> · ganti sandi <x> · status · tiket <keluhan>
//   - tak dikenal                    → DIABAIKAN (silent; cegah amplifikasi WA)
//
// Config di tabel `setting`:
//   wa_cmd_enabled      '1'/'0'   (master switch)
//   wa_cmd_secret       token wajib di URL: /webhook/wa/:provider?token=xxx
//   wa_cmd_admins       daftar nomor admin/teknisi, pisah koma
//   wa_cmd_selfservice  '1'/'0'   (izinkan pelanggan tulis SSID/sandi)
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const fs      = require('fs');
const { query, queryOne } = require('../config/db');

const genie      = require('../services/genieacs');
const waService  = require('../services/whatsapp');
let tele = { notif: async () => {} };
try { tele = require('../services/telegram'); } catch (e) {}
let tulisLog = () => {};
try { tulisLog = require('./log').tulisLog || tulisLog; } catch (e) {}

// ── Util ───────────────────────────────────────────────────
async function getCfg() {
    const rows = await query("SELECT kunci, nilai FROM setting WHERE kunci LIKE 'wa_cmd_%'").catch(() => []);
    const m = {}; rows.forEach(r => m[r.kunci] = r.nilai);
    return m;
}
function normPhone(s) {
    let d = String(s || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('0')) d = '62' + d.slice(1);
    else if (d.startsWith('8')) d = '62' + d;
    else if (d.startsWith('620')) d = '62' + d.slice(3);
    return d;
}
// HTML (format Telegram) → format WhatsApp
function html2wa(s) {
    return String(s || '')
        .replace(/<b>(.*?)<\/b>/gs, '*$1*').replace(/<\/?b>/g, '*')
        .replace(/<code>(.*?)<\/code>/gs, '`$1`').replace(/<\/?code>/g, '`')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

// ── Resolusi device pelanggan (GenieACS → ACS Lite) ────────
async function _serialDari(pelId) {
    try { const l = await queryOne('SELECT serial_number FROM acs_link WHERE pelanggan_id=? LIMIT 1', [pelId]); if (l) return String(l.serial_number || '').toLowerCase(); } catch (e) {}
    return null;
}
async function resolveGenie(pel) {
    const devs = await genie.listDevices({ limit: 2000 }).catch(() => []);
    const serial = await _serialDari(pel.id);
    const key = String(pel.username || '').toLowerCase();
    return devs.find(d =>
        (serial && String(d.serial_number || '').toLowerCase() === serial) ||
        String(d.pppoe_username || '').toLowerCase() === key) || null;
}
// ACS Lite (replikasi ringan config acslite.js)
function acsliteKey() {
    try { const t = fs.readFileSync('/opt/acs/.env', 'utf8'); const m = t.match(/^\s*API_KEY\s*=\s*(.+?)\s*$/m); if (m && m[1]) return m[1].replace(/^["']|["']$/g, ''); } catch (e) {}
    return '';
}
async function acsliteCfg() {
    const rows = await query("SELECT kunci,nilai FROM setting WHERE kunci IN ('acslite_url','acslite_api_key')").catch(() => []);
    const m = {}; rows.forEach(r => m[r.kunci] = r.nilai);
    return { url: (m.acslite_url || 'http://127.0.0.1:7547').replace(/\/+$/, ''), key: acsliteKey() || (m.acslite_api_key || '').trim() };
}
function _litePPPoE(d) { if (d && d.wan_services) for (const k in d.wan_services) { const w = d.wan_services[k]; if (w && w.username_path && d.parameters && d.parameters[w.username_path]) return d.parameters[w.username_path]; } return null; }
function _liteWifiPaths(d) { if (d && d.wifi_services) for (const k in d.wifi_services) { const w = d.wifi_services[k]; if (w && w.ssid_path) return { ssid_path: w.ssid_path, pass_path: w.password_path || null }; } return { ssid_path: null, pass_path: null }; }
async function resolveLite(pel) {
    const cfg = await acsliteCfg(); const hdr = cfg.key ? { 'X-API-Key': cfg.key } : {};
    const serial = await _serialDari(pel.id); const key = String(pel.username || '').toLowerCase();
    const r = await axios.get(`${cfg.url}/api/devices`, { headers: hdr, params: { page: 1, per_page: 1000 }, timeout: 15000 });
    const raw = r.data; const list = Array.isArray(raw) ? raw : (raw.data || []);
    for (const d of list) {
        const ppp = String(_litePPPoE(d) || '').toLowerCase(); const sn = String(d.serial_number || '').toLowerCase();
        if ((serial && sn === serial) || (ppp && ppp === key)) {
            const wp = _liteWifiPaths(d);
            return { cfg, hdr, sn: d.serial_number, ssid_path: wp.ssid_path, pass_path: wp.pass_path };
        }
    }
    return null;
}
async function gantiWifi(pel, { ssid, password }) {
    const g = await resolveGenie(pel).catch(() => null);
    if (g && g.genie_id) { await genie.setWifi(g.genie_id, { ssid, password, manufacturer: g.manufacturer }); return { acs: 'GenieACS', dev: g.serial_number }; }
    const l = await resolveLite(pel).catch(() => null);
    if (l) {
        const parameters = {};
        if (l.ssid_path && ssid) parameters[l.ssid_path] = ssid;
        if (l.pass_path && password) parameters[l.pass_path] = password;
        if (!Object.keys(parameters).length) throw new Error('Path WiFi tidak ditemukan di perangkat');
        await axios.post(`${l.cfg.url}/api/tasks`, { name: 'SetParameterValues', payload: { parameters } }, { headers: { ...l.hdr, 'Content-Type': 'application/json' }, params: { sn: l.sn }, timeout: 15000 });
        return { acs: 'ACS Lite', dev: l.sn };
    }
    return null;
}

// ── Buat tiket gangguan (konsisten dgn panel) ──────────────
async function buatTiket(pel, keluhan) {
    const judul = (keluhan || '').slice(0, 80) || 'Gangguan (via WA)';
    const r = await query(
        "INSERT INTO tiket (pelanggan_id, judul, pesan, kategori, prioritas, status, created_at, updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW())",
        [pel.id, judul, keluhan || judul, 'gangguan', 'sedang', 'open']);
    try {
        await tele.notif('tiket',
            `🛠️ <b>Tiket Baru (via WA)</b>\n\nPelanggan: ${pel.nama || '-'} (${pel.username})\n` +
            (pel.alamat ? `Alamat: ${pel.alamat}\n` : '') + `Keluhan: ${keluhan || '-'}`);
    } catch (e) {}
    return r.insertId;
}

// ── Cari pelanggan ─────────────────────────────────────────
async function pelangganByPhone(no) {
    const target = normPhone(no); if (!target) return null;
    const rows = await query("SELECT id, nama, username, no_hp, alamat, status FROM pelanggan WHERE status<>'nonaktif'").catch(() => []);
    return rows.find(p => normPhone(p.no_hp) === target) || null;
}
async function statusPelanggan(pel) {
    const p = await queryOne(
        `SELECT p.nama, p.username, p.status, p.tgl_expired, pk.nama AS paket
         FROM pelanggan p LEFT JOIN paket pk ON pk.id=p.paket_id WHERE p.id=?`, [pel.id]).catch(() => null);
    if (!p) return '❌ Data tidak ditemukan.';
    const st = { aktif: '🟢 Aktif', suspended: '🟠 Suspend', nonaktif: '🔴 Nonaktif' }[p.status] || p.status;
    const exp = p.tgl_expired ? new Date(p.tgl_expired).toLocaleDateString('id-ID') : '-';
    return `👤 *${p.nama}* (${p.username})\n📦 Paket: ${p.paket || '-'}\nStatus: ${st}\nAktif s/d: ${exp}`;
}

// ── Handler perintah (dipakai semua provider) ──────────────
// ── Reboot modem (GenieACS → ACS Lite) ─────────────────────
async function rebootModem(pel) {
    const g = await resolveGenie(pel).catch(() => null);
    if (g && g.genie_id) { await genie.rebootDevice(g.genie_id); return { acs: 'GenieACS', dev: g.serial_number }; }
    const l = await resolveLite(pel).catch(() => null);
    if (l) { await axios.post(`${l.cfg.url}/api/reboot`, null, { headers: l.hdr, params: { sn: l.sn }, timeout: 15000 }); return { acs: 'ACS Lite', dev: l.sn }; }
    return null;
}

// ── Pengguna WiFi / perangkat terhubung (Host table TR-069) ─
function _v(node) { return (node && typeof node === 'object' && '_value' in node) ? node._value : node; }
function _parseHosts(raw) {
    const roots = [];
    try { const h = raw && raw.InternetGatewayDevice && raw.InternetGatewayDevice.LANDevice && raw.InternetGatewayDevice.LANDevice['1'] && raw.InternetGatewayDevice.LANDevice['1'].Hosts && raw.InternetGatewayDevice.LANDevice['1'].Hosts.Host; if (h) roots.push(h); } catch (e) {}
    try { const h = raw && raw.Device && raw.Device.Hosts && raw.Device.Hosts.Host; if (h) roots.push(h); } catch (e) {}
    const out = []; const seen = new Set();
    for (const host of roots) {
        for (const k of Object.keys(host)) {
            if (k[0] === '_') continue;
            const e = host[k]; if (!e || typeof e !== 'object') continue;
            const active = _v(e.Active);
            if (active === false || active === 'false' || active === 0 || active === '0') continue;
            const mac  = _v(e.MACAddress) || _v(e.PhysAddress) || '';
            const name = _v(e.HostName) || '';
            const ip   = _v(e.IPAddress) || '';
            const iface = String(_v(e.InterfaceType) || _v(e.Layer1Interface) || '');
            if (!mac && !ip && !name) continue;
            const key = String(mac || name || ip).toLowerCase();
            if (seen.has(key)) continue; seen.add(key);
            out.push({ name: name || '(tanpa nama)', ip, mac, wifi: /wlan|wifi|802\.11/i.test(iface) });
        }
    }
    return out;
}
async function cekPenggunaWifi(pel) {
    const g = await resolveGenie(pel).catch(() => null);
    if (!g || !g.genie_id) return '❌ Perangkat tidak ditemukan di GenieACS. (Fitur ini baru untuk perangkat GenieACS.)';
    let raw = null;
    try { raw = await genie.getDevice(g.genie_id); } catch (e) { return `❌ Gagal ambil data ONU: ${e.message}`; }
    const hosts = _parseHosts(raw);
    try { await genie.refreshDevice(g.genie_id); } catch (e) {}
    if (!hosts.length) return `📶 *Perangkat Terhubung* — ${pel.nama || pel.username}\nSN: ${g.serial_number || '-'}\n\n_Belum ada data / ONU belum melaporkan daftar host._\n🔄 Refresh dikirim — coba ulang ~30 detik.`;
    let t = `📶 *Perangkat Terhubung* — ${pel.nama || pel.username}\nSN: ${g.serial_number || '-'} · Total: *${hosts.length}*\n`;
    hosts.slice(0, 30).forEach((h, i) => {
        t += `\n${i + 1}. *${h.name}*${h.wifi ? ' 📶' : ''}\n   ${h.ip || '-'} · ${h.mac || '-'}`;
    });
    if (hosts.length > 30) t += `\n\n… dan ${hosts.length - 30} lainnya.`;
    return t;
}

const MENU_ADMIN =
    '🤖 *Perintah Admin / Teknisi*\n\n' +
    '📡 `/cekredaman <user/serial>`\n' +
    '👤 `/cekpelanggan <nama>`\n' +
    '📶 `/cekpenggunawifi <user>`\n' +
    '📶 `/gantissid <user> <nama wifi>`\n' +
    '🔑 `/gantisandi <user> <sandi>`\n' +
    '🔄 `/reboot <user>`\n' +
    '🎫 `/tiket <user> <keluhan>`\n' +
    'ℹ️ `/menu`';

function menuPelanggan(self) {
    return '🤖 *Menu Layanan Mandiri*\n\n' +
        '📡 `/cekredaman` — cek sinyal ONU\n' +
        '📶 `/cekpenggunawifi` — perangkat terhubung\n' +
        '📊 `/status` — status akun\n' +
        '🔄 `/reboot` — restart modem\n' +
        (self ? '📶 `/gantissid <nama wifi>`\n🔑 `/gantisandi <min 8 huruf>`\n' : '') +
        '🎫 `/tiket <keluhan>` — lapor gangguan\n' +
        'ℹ️ `/menu`';
}

// Normalisasi: terima bentuk tanpa spasi & berspasi → bentuk kanonik internal.
// cekredaman/cek redaman → redaman ; gantissid/ganti ssid → ganti ssid ; dst.
function _norm(s) {
    let t = s.trim();
    t = t.replace(/^cek\s*pengguna\s*wifi\b/i, 'penggunawifi')
         .replace(/^cek\s*redaman\b/i, 'redaman')
         .replace(/^cek\s*pelanggan\b/i, 'pelanggan')
         .replace(/^ganti\s*ssid\b/i, 'ganti ssid')
         .replace(/^ganti\s*(?:sandi|password|pass)\b/i, 'ganti sandi')
         .replace(/^cek\s+/i, '');
    return t;
}

async function handleCommand(msg) {
    try { return await _handleCmd(msg); }
    catch (e) { console.warn('[wa-command] err:', e.stack || e.message); return `❌ Terjadi kesalahan: ${e.message}`; }
}
async function _handleCmd({ dari, teks }) {
    const raw0 = String(teks || '').trim();
    if (!raw0) return null;
    const lowFull = raw0.toLowerCase();
    const isSlash = raw0.startsWith('/');
    const isMenuWord = ['menu', 'help', 'start'].includes(lowFull);
    // Hanya proses jika diawali '/' atau kata menu/help/start.
    // Selain itu DIAM — mis. pelanggan kirim slip pembayaran / obrolan biasa → jangan balas menu.
    if (!isSlash && !isMenuWord) return null;

    const raw = _norm(raw0.replace(/^\/+/, '').trim());   // buang '/' lalu normalisasi
    const low = raw.toLowerCase();
    const cfg = await getCfg();
    const admins = String(cfg.wa_cmd_admins || '').split(',').map(x => normPhone(x)).filter(Boolean);
    const selfOn = cfg.wa_cmd_selfservice === '1';
    const isAdmin = admins.includes(normPhone(dari));
    const pel = isAdmin ? null : await pelangganByPhone(dari);
    console.log(`[wa-command] dari=${normPhone(dari)} teks="${raw0}" role=${isAdmin ? 'ADMIN' : (pel ? 'PELANGGAN(' + pel.username + ')' : 'UNKNOWN')}`);

    // ===== ADMIN / TEKNISI =====
    if (isAdmin) {
        if (low === 'menu' || low === 'help' || low === 'start' || low === '') return MENU_ADMIN;
        if (low.startsWith('redaman'))   { const a = raw.slice(7).trim(); if (!a) return '⚠️ Format: `cek redaman <user/serial>`'; return html2wa(await tele.cekRedaman(a)); }
        if (low.startsWith('pelanggan')) { const a = raw.slice(9).trim(); if (!a) return '⚠️ Format: `cek pelanggan <nama>`';     return html2wa(await tele.cekPelanggan(a)); }
        if (low.startsWith('penggunawifi')) {
            const u = raw.slice(12).trim(); if (!u) return '⚠️ Format: `cekpenggunawifi <user>`';
            const p = await queryOne("SELECT id, nama, username FROM pelanggan WHERE username=? LIMIT 1", [u]).catch(() => null);
            if (!p) return `❌ Pelanggan \`${u}\` tidak ditemukan.`;
            return await cekPenggunaWifi(p);
        }
        let m = raw.match(/^ganti\s+ssid\s+(\S+)\s+(.+)$/i);
        if (m) return await _adminWifi(m[1], { ssid: m[2].trim() });
        m = raw.match(/^ganti\s+(?:sandi|password|pass)\s+(\S+)\s+(.+)$/i);
        if (m) return await _adminWifi(m[1], { password: m[2].trim() });
        if (low.startsWith('reboot')) { const u = raw.slice(6).trim(); if (!u) return '⚠️ Format: `reboot <user>`'; return await _adminReboot(u); }
        if (low.startsWith('tiket')) {
            const rest = raw.slice(5).trim(); const sp = rest.indexOf(' ');
            if (sp < 1) return '⚠️ Format: `tiket <user> <keluhan>`';
            const uname = rest.slice(0, sp).trim(); const keluhan = rest.slice(sp + 1).trim();
            const p = await queryOne("SELECT id, nama, username, alamat FROM pelanggan WHERE username=? LIMIT 1", [uname]).catch(() => null);
            if (!p) return `❌ Pelanggan \`${uname}\` tidak ditemukan.`;
            const id = await buatTiket(p, keluhan);
            return `✅ Tiket #${id} dibuat untuk *${p.nama}*.`;
        }
        return MENU_ADMIN;
    }

    // ===== PELANGGAN (self-service) =====
    if (!pel) return null; // nomor tak dikenal → diam

    if (low === 'menu' || low === 'help' || low === 'start' || low === '') return menuPelanggan(selfOn);
    if (low === 'status') return await statusPelanggan(pel);
    if (low.startsWith('redaman')) return html2wa(await tele.cekRedaman(pel.username));
    if (low.startsWith('penggunawifi')) return await cekPenggunaWifi(pel);
    if (low.startsWith('reboot')) {
        try { const r = await rebootModem(pel); if (!r) return '❌ Perangkat kamu tidak ditemukan di ACS. Hubungi admin.';
            tulisLog({ kategori: 'WA-Command', pelaku: `${pel.nama} (${normPhone(dari)})`, aksi: 'Reboot Modem', target: pel.username, detail: r.acs });
            return `🔄 Perintah restart modem dikirim (${r.acs}). Modem menyala ulang ~1–2 menit.`;
        } catch (e) { return `❌ Gagal reboot: ${e.message}`; }
    }
    if (low.startsWith('tiket')) { const keluhan = raw.slice(5).trim(); if (!keluhan) return '⚠️ Format: `tiket <keluhan>`'; const id = await buatTiket(pel, keluhan); return `✅ Laporan gangguan diterima. Tiket #${id}. Tim kami akan menindaklanjuti.`; }

    // Tulis SSID / sandi (butuh self-service ON)
    const mSsid = raw.match(/^ganti\s+ssid\s+(.+)$/i);
    const mPass = raw.match(/^ganti\s+(?:sandi|password|pass)\s+(.+)$/i);
    if (mSsid || mPass) {
        if (!selfOn) return '⚠️ Layanan ubah WiFi sedang dinonaktifkan. Hubungi admin.';
        try {
            if (mSsid) {
                const ssid = mSsid[1].trim();
                if (ssid.length < 1 || ssid.length > 32) return '⚠️ Nama WiFi (SSID) harus 1–32 karakter.';
                const r = await gantiWifi(pel, { ssid });
                if (!r) return '❌ Perangkat kamu tidak ditemukan di ACS. Hubungi admin.';
                tulisLog({ kategori: 'WA-Command', pelaku: `${pel.nama} (${normPhone(dari)})`, aksi: 'Ganti SSID', target: pel.username, detail: `${r.acs} → "${ssid}"` });
                return `✅ Nama WiFi diubah jadi *${ssid}* (${r.acs}).\n⚠️ Perangkatmu akan terputus sesaat — sambungkan ulang ke WiFi baru.`;
            } else {
                const pass = mPass[1].trim();
                if (pass.length < 8) return '⚠️ Sandi WiFi minimal 8 karakter (syarat WPA).';
                if (pass.length > 63) return '⚠️ Sandi WiFi maksimal 63 karakter.';
                const r = await gantiWifi(pel, { password: pass });
                if (!r) return '❌ Perangkat kamu tidak ditemukan di ACS. Hubungi admin.';
                tulisLog({ kategori: 'WA-Command', pelaku: `${pel.nama} (${normPhone(dari)})`, aksi: 'Ganti Sandi WiFi', target: pel.username, detail: r.acs });
                return `✅ Sandi WiFi berhasil diubah (${r.acs}).\n⚠️ Perangkatmu akan terputus sesaat — sambungkan ulang dengan sandi baru.`;
            }
        } catch (e) { return `❌ Gagal mengubah WiFi: ${e.message}`; }
    }

    return menuPelanggan(selfOn);
}

// Helper admin: ganti wifi / reboot untuk <user>
async function _adminWifi(uname, opts) {
    const p = await queryOne("SELECT id, nama, username FROM pelanggan WHERE username=? LIMIT 1", [uname]).catch(() => null);
    if (!p) return `❌ Pelanggan \`${uname}\` tidak ditemukan.`;
    if (opts.ssid && (opts.ssid.length < 1 || opts.ssid.length > 32)) return '⚠️ SSID harus 1–32 karakter.';
    if (opts.password && (opts.password.length < 8 || opts.password.length > 63)) return '⚠️ Sandi WiFi 8–63 karakter.';
    try {
        const r = await gantiWifi(p, opts);
        if (!r) return `❌ Perangkat *${p.nama}* tidak ditemukan di ACS.`;
        tulisLog({ kategori: 'WA-Command', pelaku: 'Admin (WA)', aksi: opts.ssid ? 'Ganti SSID' : 'Ganti Sandi WiFi', target: p.username, detail: r.acs });
        return `✅ ${opts.ssid ? 'SSID' : 'Sandi WiFi'} *${p.nama}* diubah (${r.acs}).`;
    } catch (e) { return `❌ Gagal: ${e.message}`; }
}
async function _adminReboot(uname) {
    const p = await queryOne("SELECT id, nama, username FROM pelanggan WHERE username=? LIMIT 1", [uname]).catch(() => null);
    if (!p) return `❌ Pelanggan \`${uname}\` tidak ditemukan.`;
    try { const r = await rebootModem(p); if (!r) return `❌ Perangkat *${p.nama}* tidak ditemukan di ACS.`;
        tulisLog({ kategori: 'WA-Command', pelaku: 'Admin (WA)', aksi: 'Reboot Modem', target: p.username, detail: r.acs });
        return `🔄 Reboot modem *${p.nama}* dikirim (${r.acs}).`;
    } catch (e) { return `❌ Gagal reboot: ${e.message}`; }
}

// ── ADAPTER PER-PROVIDER ───────────────────────────────────
// parse(req) → { dari, teks } | null ;  reply(dari, pesan) → kirim balasan
const adapters = {
    // Fonnte: incoming webhook kirim field sender/message/name (form-url-encoded/JSON)
    fonnte: {
        parse(req) {
            const b = req.body || {};
            const dari = b.sender || b.pengirim || b.from;
            const teks = b.message || b.pesan || b.text;
            if (!dari || teks == null) return null;
            // Abaikan pesan dari grup / status
            if (String(b.group || b.grup || '').length > 0) return null;
            return { dari: String(dari), teks: String(teks) };
        },
        async reply(dari, pesan) {
            // Balasan bot harus instan (jangan masuk antrian throttle 30-60s).
            const kirim = waService.kirimPesanLangsung || waService.kirimPesan;
            await kirim(dari, pesan, null, 'manual');
        }
    },
    // Placeholder — tinggal isi saat aktifkan provider lain:
    // wablas: {...}, cloud: {...}(WA Business API), waha: {...}, mandiri: {...}
};

// ── ROUTE ──────────────────────────────────────────────────
router.get('/:provider', (req, res) => res.json({ ok: true, provider: req.params.provider, hint: 'Gunakan POST untuk webhook.' }));

router.post('/:provider', async (req, res) => {
    const provider = req.params.provider;
    try {
        const cfg = await getCfg();
        // 1) Master switch
        if (cfg.wa_cmd_enabled !== '1') return res.json({ ok: true, ignored: 'disabled' });
        // 2) Secret wajib
        if (!cfg.wa_cmd_secret) return res.status(503).json({ error: 'wa_cmd_secret belum dikonfigurasi' });
        if ((req.query.token || '') !== cfg.wa_cmd_secret) return res.status(403).json({ error: 'token salah' });
        // 3) Adapter
        const ad = adapters[provider];
        if (!ad) return res.status(404).json({ error: `provider '${provider}' belum didukung` });

        const msg = ad.parse(req);
        if (!msg) return res.json({ ok: true, ignored: 'no-message' });

        // Balas cepat ke webhook; proses async agar tidak timeout provider
        res.json({ ok: true });
        try {
            const balasan = await handleCommand(msg);
            if (balasan) await ad.reply(msg.dari, balasan);
        } catch (e) { console.warn('[wa-command] handle:', e.message); }
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

module.exports = router;
