// services/telegram.js — Integrasi notifikasi Telegram Bot
'use strict';
const axios = require('axios');
const { query } = require('../config/db');
const genie = require('./genieacs');

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
    const key = id.toLowerCase();

    // Sumber data = LIVE dari GenieACS (sama seperti panel ACS), BUKAN tabel
    // acs_device (yang tidak di-maintain). Cocokkan ke serial ATAU username PPPoE.
    let list = [];
    try {
        list = await genie.listDevices({ limit: 2000 });
    } catch (e) {
        return `⚠️ Gagal hubungi GenieACS: ${e.message}`;
    }

    // Map link manual (acs_link) + pelanggan, untuk resolusi by username pelanggan.
    let linkMap = {};   // serial → {id,nama,username,alamat}
    let pelByUser = {}; // username(lower) → {id,nama,alamat}
    try {
        const links = await query(
            `SELECT l.serial_number, p.id, p.nama, p.username, p.alamat
             FROM acs_link l LEFT JOIN pelanggan p ON p.id = l.pelanggan_id`);
        links.forEach(l => { linkMap[l.serial_number] = { id: l.id, nama: l.nama, username: l.username, alamat: l.alamat }; });
        const pels = await query('SELECT id, username, nama, alamat FROM pelanggan');
        pels.forEach(p => { if (p.username) pelByUser[p.username.toLowerCase()] = { id: p.id, nama: p.nama, alamat: p.alamat }; });
    } catch (e) {}

    // Cari device yang cocok: serial == id, ATAU pppoe_username == id,
    // ATAU username pelanggan (lewat acs_link / auto-match) == id.
    const match = list.find(d => {
        const serial = String(d.serial_number || '').toLowerCase();
        const ppp    = String(d.pppoe_username || d.username || '').toLowerCase();
        if (serial === key || ppp === key) return true;
        // via acs_link → username pelanggan
        const lk = linkMap[d.serial_number];
        if (lk && lk.username && lk.username.toLowerCase() === key) return true;
        // via auto-match PPPoE → pelanggan
        if (ppp && pelByUser[ppp] && pelByUser[ppp].nama) {
            // id mungkin username pelanggan yang == ppp (sudah dicek di atas)
        }
        return false;
    });

    if (!match) return `❌ ONU untuk <b>${id}</b> tidak ditemukan di ACS.`;

    // Nama & alamat pelanggan: prioritas acs_link > auto-match PPPoE > kosong.
    const lk = linkMap[match.serial_number];
    const ppp = String(match.pppoe_username || match.username || '');
    const pp = ppp ? pelByUser[ppp.toLowerCase()] : null;
    let nama = lk?.nama || pp?.nama || '';
    let uname = lk?.username || ppp || id;
    let alamat = lk?.alamat || pp?.alamat || '';

    // Antri refresh redaman agar nilai ter-update saat Inform berikutnya.
    try { if (match.genie_id) await genie.refreshDevice(match.genie_id); } catch (e) {}

    const online = (match.status === 'online');
    const waktu = match.last_inform ? new Date(match.last_inform).toLocaleString('id-ID') : '-';
    const rx = (match.rx_power !== null && match.rx_power !== undefined) ? match.rx_power : null;

    let teks = `📡 <b>Redaman ONU</b> — ${nama || '-'} (${uname})\n` +
        (alamat ? `📍 ${alamat}\n` : '') +
        `🔧 ${match.manufacturer || '-'} ${match.product_class || match.model || ''} · SN: ${match.serial_number || '-'}\n` +
        `${online ? '🟢 Online' : '🔴 Offline'} · update: ${waktu}\n\n`;
    if (rx !== null) {
        teks += `⬇️ RX Power: <b>${rx} dBm</b>\n`;
        teks += `\n🔄 Permintaan refresh dikirim ke ONU; ketik ulang ~30 dtk untuk nilai terbaru.`;
    } else {
        teks += `⏳ Data RX belum tersedia. Permintaan dikirim ke ONU — ketik ulang ~30 detik setelah ONU sinkron.`;
    }
    return teks;
}

// ── /cekpelanggan <nama> — detail lengkap pelanggan ──
// Gabungan 3 sumber: DB (pelanggan+paket), GenieACS (ONU live), olt_link (port).
// Pencarian by NAMA (boleh sebagian, case-insensitive). Bila >1 cocok →
// tampilkan daftar agar teknisi pilih yang tepat.
async function cekPelanggan(nama) {
    const q = String(nama || '').trim();
    if (!q) return '⚠️ Format: /cekpelanggan <nama pelanggan>';

    // 1) Cari pelanggan by nama (LIKE) + paket
    let rows = [];
    try {
        rows = await query(
            `SELECT p.id, p.nama, p.username, p.alamat, p.no_hp, p.status, p.tgl_expired,
                    pk.nama AS paket_nama, pk.kecepatan_up, pk.kecepatan_dn
             FROM pelanggan p LEFT JOIN paket pk ON pk.id = p.paket_id
             WHERE p.nama LIKE ? OR p.username LIKE ?
             ORDER BY (p.nama = ?) DESC, p.nama ASC
             LIMIT 11`,
            [`%${q}%`, `%${q}%`, q]);
    } catch (e) { return `⚠️ Gagal akses database: ${e.message}`; }

    if (!rows.length) return `❌ Pelanggan dengan nama <b>${q}</b> tidak ditemukan.`;

    // Bila banyak hasil → tampilkan daftar untuk dipilih
    if (rows.length > 1) {
        const list = rows.slice(0, 10).map((r, i) =>
            `${i + 1}. <b>${r.nama}</b> (@${r.username})`).join('\n');
        const more = rows.length > 10 ? '\n… (dipersempit, ketik nama lebih spesifik)' : '';
        return `🔎 Ditemukan ${rows.length} pelanggan untuk "<b>${q}</b>":\n${list}${more}\n\nKetik lebih spesifik, mis: <code>/cekpelanggan ${rows[0].nama}</code>`;
    }

    const p = rows[0];

    // 2) Port dari olt_link (by pelanggan_id atau sn)
    let port = '', oltId = '';
    try {
        const ol = await query(
            `SELECT olt_id, onu_index, sn FROM olt_link WHERE pelanggan_id = ? LIMIT 1`, [p.id]);
        if (ol.length) { port = ol[0].onu_index || ''; oltId = ol[0].olt_id || ''; }
    } catch (e) {}

    // 3) Data ONU live dari GenieACS (match by PPPoE username = p.username)
    let dev = null;
    try {
        const list = await genie.listDevices({ limit: 5000 });
        const uname = (p.username || '').toLowerCase();
        dev = list.find(d => String(d.pppoe_username || d.username || '').toLowerCase() === uname) || null;
        // fallback: lewat olt_link.sn → serial ONU
        if (!dev && port) {
            const ol = await query(`SELECT sn FROM olt_link WHERE pelanggan_id = ? LIMIT 1`, [p.id]);
            if (ol.length && ol[0].sn) {
                const sn = String(ol[0].sn).toLowerCase();
                dev = list.find(d => String(d.serial_number || '').toLowerCase() === sn) || null;
            }
        }
    } catch (e) {}

    // 4) Status billing
    const expired = p.tgl_expired ? String(p.tgl_expired).slice(0, 10) : '-';
    const statusMap = { aktif: '✅ Aktif', suspend: '🔒 Suspend', nonaktif: '⚫ Nonaktif', isolir: '🔒 Isolir' };
    const statusTxt = statusMap[p.status] || p.status || '-';

    // 5) Rangkai pesan
    let t = `👤 <b>DETAIL PELANGGAN</b>\n`;
    t += `━━━━━━━━━━━━━━━\n`;
    t += `📛 Nama: <b>${p.nama}</b>\n`;
    t += `🔑 User: <code>${p.username}</code>\n`;
    if (p.alamat) t += `🏠 Alamat: ${p.alamat}\n`;
    if (p.no_hp) t += `📱 HP: ${p.no_hp}\n`;
    t += `📦 Paket: ${p.paket_nama || '-'}`;
    if (p.kecepatan_dn) t += ` (${p.kecepatan_dn}↓/${p.kecepatan_up}↑ Mbps)`;
    t += `\n`;
    t += `💳 Status: ${statusTxt}${expired !== '-' ? ` (exp ${expired})` : ''}\n`;
    t += `━━━━━━━━━━━━━━━\n`;
    t += `📡 <b>Perangkat (ONU)</b>\n`;
    if (port) t += `🔌 Port: <code>${port}</code>${oltId ? ` (${oltId})` : ''}\n`;
    if (dev) {
        t += `🏷️ Brand: ${dev.manufacturer || '-'}\n`;
        t += `📟 Jenis: ${dev.product_class || dev.model || '-'}\n`;
        if (dev.serial_number) t += `🔖 SN/Host: <code>${dev.serial_number}</code>\n`;
        if (dev.ip_address) t += `🌐 IP: <code>${dev.ip_address}</code>\n`;
        if (dev.vlan_inet) t += `🔢 VLAN inet: <code>${dev.vlan_inet}</code>\n`;
        const rx = (dev.rx_power !== null && dev.rx_power !== undefined) ? dev.rx_power : null;
        if (rx !== null) {
            const ikon = rx <= -27 ? '🚨' : (rx <= -25 ? '⚠️' : '🟢');
            t += `⬇️ Redaman: ${ikon} <b>${rx} dBm</b>\n`;
        } else {
            t += `⬇️ Redaman: — (belum tersedia)\n`;
        }
        const online = (dev.status === 'online');
        const waktu = dev.last_inform ? new Date(dev.last_inform).toLocaleString('id-ID') : '-';
        t += `${online ? '🟢 Online' : '🔴 Offline'} · update: ${waktu}\n`;
    } else {
        t += `⚠️ Perangkat ONU tidak ditemukan di ACS (cek SN/PPPoE atau ONU offline).\n`;
    }
    return t;
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

module.exports = { getCfg, kirim, kirimFoto, notif, notifPendaftaran, cekRedaman, cekPelanggan, setWebhook, hapusWebhook, infoWebhook };
