// routes/telegram.js — Konfigurasi Integrasi Telegram
const router = require('express').Router();
const { query } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const tg = require('../services/telegram');

router.use(authMiddleware);

const KEYS = [
    'tg_enabled', 'tg_bot_token', 'tg_username_bot', 'tg_api_url',
    'tg_chat_teknisi', 'tg_chat_owner', 'tg_chat_cs',
    'tg_ev_tiket', 'tg_ev_pelanggan', 'tg_ev_pembayaran', 'tg_ev_expired', 'tg_ev_suspend', 'tg_ev_pendaftaran', 'tg_ev_redaman', 'tg_ev_olt',
    'tg_keterangan'
];

// GET /api/telegram/config
router.get('/config', async (req, res, next) => {
    try {
        const rows = await query("SELECT kunci, nilai FROM setting WHERE kunci LIKE 'tg_%'");
        const m = {};
        rows.forEach(r => m[r.kunci] = r.nilai);
        const tokenSet = !!m.tg_bot_token;
        if (m.tg_bot_token) m.tg_bot_token = '••••••';   // jangan bocorkan token
        res.json({ ...m, tg_bot_token_set: tokenSet });
    } catch (e) { next(e); }
});

// PUT /api/telegram/config
router.put('/config', requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        for (const k of KEYS) {
            if (!(k in body)) continue;
            let v = body[k];
            // jangan timpa token kalau dikirim kosong / masih masked
            if (k === 'tg_bot_token' && (v === '' || v === '••••••' || v == null)) continue;
            v = (v === undefined || v === null) ? '' : String(v).trim();
            await query(
                'INSERT INTO setting (kunci, nilai) VALUES (?, ?) ON DUPLICATE KEY UPDATE nilai = ?',
                [k, v, v]
            );
        }
        res.json({ pesan: 'Konfigurasi Telegram disimpan' });
    } catch (e) { next(e); }
});

// POST /api/telegram/test — kirim pesan uji
router.post('/test', requireAdmin, async (req, res, next) => {
    try {
        const cfg = await tg.getCfg();
        const target = (req.body && req.body.chat_id) || cfg.tg_chat_teknisi || cfg.tg_chat_owner;
        if (!cfg.tg_bot_token) return res.status(400).json({ error: 'Bot token belum diisi & disimpan' });
        if (!target) return res.status(400).json({ error: 'Chat ID tujuan belum diisi' });
        const data = await tg.kirim(target,
            '✅ <b>Test Notifikasi SimBill</b>\n\nIntegrasi Telegram berhasil terhubung. Notifikasi akan dikirim ke chat ini.');
        res.json({ pesan: 'Pesan test terkirim ✅', data });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.description || e.message });
    }
});

// ── WEBHOOK (perintah dua arah) ──
const crypto = require('crypto');

router.post('/webhook/aktifkan', requireAdmin, async (req, res, next) => {
    try {
        const cfg = await tg.getCfg();
        if (!cfg.tg_bot_token) return res.status(400).json({ error: 'Bot token belum diisi & disimpan' });
        const baseRow = await query("SELECT nilai FROM setting WHERE kunci='app_url' LIMIT 1");
        const appUrl = (baseRow[0]?.nilai || process.env.APP_URL || '').replace(/\/+$/, '');
        if (!appUrl || appUrl.includes('localhost')) return res.status(400).json({ error: 'Setting "app_url" harus berisi domain publik HTTPS (mis. https://simbill.rfnet.id)' });

        const secret = crypto.randomBytes(16).toString('hex');
        await query("INSERT INTO setting (kunci,nilai) VALUES ('tg_webhook_secret',?) ON DUPLICATE KEY UPDATE nilai=?", [secret, secret]);
        const data = await tg.setWebhook(`${appUrl}/webhook/telegram`, secret);
        res.json({ pesan: 'Webhook bot aktif. Teknisi bisa ketik /redaman di grup.', data, url: `${appUrl}/webhook/telegram` });
    } catch (e) { res.status(500).json({ error: e.response?.data?.description || e.message }); }
});

router.post('/webhook/nonaktif', requireAdmin, async (req, res, next) => {
    try {
        const data = await tg.hapusWebhook();
        res.json({ pesan: 'Webhook bot dinonaktifkan', data });
    } catch (e) { res.status(500).json({ error: e.response?.data?.description || e.message }); }
});

router.get('/webhook/status', async (req, res, next) => {
    try {
        const data = await tg.infoWebhook();
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.response?.data?.description || e.message }); }
});

module.exports = router;
