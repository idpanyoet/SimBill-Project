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

module.exports = { getCfg, kirim, notif };
