// services/telegram.js — Integrasi notifikasi Telegram Bot
'use strict';
const axios = require('axios');
const { query } = require('../config/db');

async function getCfg() {
    const rows = await query("SELECT kunci, nilai FROM setting WHERE kunci LIKE 'tg_%'");
    const m = {};
    rows.forEach(r => m[r.kunci] = r.nilai);
    return m;
}

// Kirim pesan mentah ke satu chat_id (cek token & chat saja, tidak cek enabled)
async function kirim(chatId, pesan) {
    const cfg = await getCfg();
    if (!cfg.tg_bot_token) throw new Error('Bot token Telegram belum dikonfigurasi');
    if (!chatId) throw new Error('Chat ID tujuan kosong');
    const base = (cfg.tg_api_url || 'https://api.telegram.org').replace(/\/+$/, '');
    const url = `${base}/bot${cfg.tg_bot_token}/sendMessage`;
    const r = await axios.post(url, {
        chat_id: chatId,
        text: pesan,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    }, { timeout: 12000 });
    return r.data;
}

// Pemetaan event → toggle setting + target chat
function eventConfig(cfg, event) {
    const teknisi = cfg.tg_chat_teknisi || '';
    const owner   = cfg.tg_chat_owner || '';
    const map = {
        tiket:          { toggle: 'tg_ev_tiket',      target: teknisi },
        pelanggan_baru: { toggle: 'tg_ev_pelanggan',  target: teknisi },
        suspend:        { toggle: 'tg_ev_suspend',    target: teknisi },
        expired:        { toggle: 'tg_ev_expired',    target: teknisi },
        pembayaran:     { toggle: 'tg_ev_pembayaran', target: owner || teknisi }
    };
    return map[event] || null;
}

// Notifikasi event (best-effort, cek enabled + toggle + target)
async function notif(event, pesan) {
    try {
        const cfg = await getCfg();
        if (cfg.tg_enabled !== '1') return;
        const ev = eventConfig(cfg, event);
        if (!ev || cfg[ev.toggle] !== '1' || !ev.target) return;
        await kirim(ev.target, pesan);
    } catch (err) {
        console.warn('[telegram] notif', event, 'gagal:', err.response?.data?.description || err.message);
    }
}

// Kirim foto (KTP dll) dengan caption
async function kirimFoto(chatId, fotoUrl, caption) {
    const cfg = await getCfg();
    if (!cfg.tg_bot_token) throw new Error('Bot token Telegram belum dikonfigurasi');
    if (!chatId) throw new Error('Chat ID tujuan kosong');
    const base = (cfg.tg_api_url || 'https://api.telegram.org').replace(/\/+$/, '');
    const url = `${base}/bot${cfg.tg_bot_token}/sendPhoto`;
    const r = await axios.post(url, {
        chat_id: chatId,
        photo: fotoUrl,
        caption: caption,
        parse_mode: 'HTML'
    }, { timeout: 15000 });
    return r.data;
}

async function getBaseUrl() {
    try {
        const r = await query("SELECT nilai FROM setting WHERE kunci='app_url' LIMIT 1");
        return (r[0]?.nilai || process.env.APP_URL || '').replace(/\/+$/, '');
    } catch (e) { return (process.env.APP_URL || '').replace(/\/+$/, ''); }
}

// Notifikasi pendaftaran pelanggan baru — data lengkap + foto KTP + link maps
async function notifPendaftaran(data) {
    try {
        const cfg = await getCfg();
        if (cfg.tg_enabled !== '1' || cfg.tg_ev_pendaftaran !== '1') return;
        const target = cfg.tg_chat_teknisi || cfg.tg_chat_owner;
        if (!target) return;

        const { nama, alamat, paket, latitude, longitude, no_hp, username, ktp_url } = data;
        const maps = (latitude && longitude) ? `https://maps.google.com/?q=${latitude},${longitude}` : '';
        let teks = `🆕 <b>Pendaftaran Pelanggan Baru</b>\n\n`
            + `👤 <b>${nama || '-'}</b>\n`
            + (username ? `🔑 ${username}\n` : '')
            + `📦 Paket: ${paket || '-'}\n`
            + `📍 Alamat: ${alamat || '-'}\n`
            + (no_hp ? `📞 ${no_hp}\n` : '')
            + ((latitude && longitude) ? `📌 Titik Koordinat: ${latitude}, ${longitude}\n` : '')
            + (maps ? `🗺️ ${maps}` : '');

        let fotoUrl = '';
        if (ktp_url) fotoUrl = String(ktp_url).startsWith('http') ? ktp_url : (await getBaseUrl()) + ktp_url;

        if (fotoUrl) {
            try { await kirimFoto(target, fotoUrl, teks); return; }
            catch (e) {
                console.warn('[telegram] sendPhoto KTP gagal, fallback teks:', e.response?.data?.description || e.message);
                teks += `\n\n🪪 Foto KTP: ${fotoUrl}`;
            }
        }
        await kirim(target, teks);
    } catch (err) {
        console.warn('[telegram] notifPendaftaran gagal:', err.response?.data?.description || err.message);
    }
}

// ── Cek Redaman ONU via ACS (perintah grup) ──
function parseRedaman(cache) {
    const out = { rx: null, tx: null, suhu: null, tegangan: null };
    for (const k in cache) {
        const v = cache[k];
        if (v === '' || v == null) continue;
        if (out.rx == null && /(RXPower|RxPower|RXOpticalPower|RxOpticalLevel|OpticalSignalLevel)$/i.test(k)) out.rx = { key: k, val: v };
        else if (out.tx == null && /(TXPower|TxPower|TXOpticalPower)$/i.test(k)) out.tx = { key: k, val: v };
        else if (out.suhu == null && /(Temperature)$/i.test(k)) out.suhu = { key: k, val: v };
        else if (out.tegangan == null && /(Voltage|SupplyVoltage)$/i.test(k)) out.tegangan = { key: k, val: v };
    }
    return out;
}

function fmtDbm(raw) {
    if (raw == null || raw === '') return '-';
    let n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
    if (isNaN(n)) return String(raw);
    // Heuristik unit: banyak ONU melaporkan dalam skala (0.01 / 0.1 dBm) atau 2's complement
    if (Math.abs(n) >= 10000) n = n / 1000;
    else if (Math.abs(n) >= 1000) n = n / 100;
    else if (Math.abs(n) >= 100) n = n / 10;
    return `${n.toFixed(2)} dBm`;
}

async function cekRedaman(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return '⚠️ Format: /redaman <username | serial ONU>';
    const dev = await query(`
        SELECT d.id, d.param_cache, d.manufacturer, d.product_class, d.serial_number, d.ip_address,
               d.status, d.last_inform, p.nama, p.username
        FROM acs_device d LEFT JOIN pelanggan p ON d.pelanggan_id = p.id
        WHERE p.username = ? OR d.serial_number = ?
        ORDER BY d.last_inform DESC LIMIT 1
    `, [id, id]);
    if (!dev.length) return `❌ ONU untuk <b>${id}</b> tidak ditemukan di ACS.`;
    const d = dev[0];

    // Antri refresh redaman (sekali) agar data ter-update saat Inform berikutnya
    try {
        const ada = await query("SELECT id FROM acs_task WHERE device_id=? AND type='GetRedaman' AND status IN ('pending','running') LIMIT 1", [d.id]);
        if (!ada.length) await query("INSERT INTO acs_task (device_id, type, status, created_by) VALUES (?,?,?,?)", [d.id, 'GetRedaman', 'pending', 'telegram']);
    } catch (e) {}

    let cache = {}; try { cache = JSON.parse(d.param_cache || '{}'); } catch (e) {}
    const r = parseRedaman(cache);
    const online = d.status === 'online';
    const waktu = d.last_inform ? new Date(d.last_inform).toLocaleString('id-ID') : '-';

    let teks = `📡 <b>Redaman ONU</b> — ${d.nama || '-'} (${d.username || id})\n` +
        `🔧 ${d.manufacturer || '-'} ${d.product_class || ''} · SN: ${d.serial_number || '-'}\n` +
        `${online ? '🟢 Online' : '🔴 Offline'} · update: ${waktu}\n\n`;
    if (r.rx || r.tx) {
        if (r.rx) teks += `⬇️ RX Power: <b>${fmtDbm(r.rx.val)}</b> <i>(raw ${r.rx.val})</i>\n`;
        if (r.tx) teks += `⬆️ TX Power: <b>${fmtDbm(r.tx.val)}</b> <i>(raw ${r.tx.val})</i>\n`;
        if (r.suhu) teks += `🌡️ Suhu: ${r.suhu.val}\n`;
        teks += `\n🔄 Permintaan refresh dikirim ke ONU; ketik ulang ~30 dtk untuk nilai terbaru.`;
    } else {
        teks += `⏳ Data redaman belum tersedia di cache. Permintaan dikirim ke ONU — ketik ulang dalam ~30 detik setelah ONU sinkron.`;
    }
    return teks;
}

// ── Webhook (perintah dua arah) ──
async function setWebhook(url, secret) {
    const cfg = await getCfg();
    if (!cfg.tg_bot_token) throw new Error('Bot token belum diisi');
    const base = (cfg.tg_api_url || 'https://api.telegram.org').replace(/\/+$/, '');
    const r = await axios.post(`${base}/bot${cfg.tg_bot_token}/setWebhook`,
        { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }, { timeout: 12000 });
    return r.data;
}
async function hapusWebhook() {
    const cfg = await getCfg();
    if (!cfg.tg_bot_token) throw new Error('Bot token belum diisi');
    const base = (cfg.tg_api_url || 'https://api.telegram.org').replace(/\/+$/, '');
    const r = await axios.post(`${base}/bot${cfg.tg_bot_token}/deleteWebhook`, { drop_pending_updates: true }, { timeout: 12000 });
    return r.data;
}
async function infoWebhook() {
    const cfg = await getCfg();
    if (!cfg.tg_bot_token) throw new Error('Bot token belum diisi');
    const base = (cfg.tg_api_url || 'https://api.telegram.org').replace(/\/+$/, '');
    const r = await axios.get(`${base}/bot${cfg.tg_bot_token}/getWebhookInfo`, { timeout: 12000 });
    return r.data;
}

module.exports = { getCfg, kirim, kirimFoto, notif, notifPendaftaran, cekRedaman, setWebhook, hapusWebhook, infoWebhook };
