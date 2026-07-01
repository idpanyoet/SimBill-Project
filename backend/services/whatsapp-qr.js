// services/whatsapp-qr.js — Koneksi WhatsApp via scan QR (whatsapp-web.js)
//
// Ini adalah JALUR ALTERNATIF dari services/whatsapp.js (yang memakai provider
// API berbayar seperti Fonnte/Wablas). Mode ini gratis dan memakai nomor WA
// pribadi/bisnis Anda sendiri, tapi membutuhkan VPS yang bisa menjalankan
// Chromium (whatsapp-web.js berjalan dengan mengotomasi WhatsApp Web asli
// lewat Puppeteer). Sesi disimpan di disk (LocalAuth) supaya tidak perlu
// scan ulang setiap kali server di-restart.
const path = require('path');
const { query } = require('../config/db');

let client = null;
let Client, LocalAuth, QRCode;
try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    QRCode = require('qrcode');
} catch (e) {
    // Library belum terinstall (npm install belum dijalankan dengan dependency
    // baru) — modul ini akan tetap bisa di-require tanpa crash, tapi semua
    // fungsi akan melempar error yang jelas saat dipanggil.
    console.warn('[WA-QR] Package whatsapp-web.js/qrcode belum terinstall. Jalankan: npm install');
}

// Status global sesi: 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let status = 'disconnected';
let qrDataUrl = null;       // QR code sebagai data URL (base64 PNG) untuk ditampilkan di dashboard
let infoNomor = null;       // Nomor WA yang tersambung setelah berhasil login
let lastError = null;

function getStatus() {
    return { status, qrDataUrl, infoNomor, lastError };
}

async function start() {
    if (!Client) {
        lastError = 'Package whatsapp-web.js belum terinstall di server. Jalankan "npm install" di folder backend lalu restart server.';
        status = 'disconnected';
        throw new Error(lastError);
    }
    if (client && (status === 'connected' || status === 'connecting' || status === 'qr_ready')) {
        return getStatus(); // sudah ada sesi aktif/sedang proses, tidak perlu start ulang
    }

    status = 'connecting';
    qrDataUrl = null;
    lastError = null;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '../wa-session') }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', async (qr) => {
        try {
            qrDataUrl = await QRCode.toDataURL(qr);
            status = 'qr_ready';
            console.log('[WA-QR] QR code baru tersedia, silakan scan dari dashboard.');
        } catch (err) {
            console.error('[WA-QR] Gagal generate QR image:', err.message);
        }
    });

    client.on('authenticated', () => {
        console.log('[WA-QR] Berhasil autentikasi, menunggu koneksi penuh...');
        qrDataUrl = null;
    });

    client.on('ready', () => {
        status = 'connected';
        qrDataUrl = null;
        infoNomor = client.info?.wid?.user || null;
        lastError = null;
        console.log(`[WA-QR] Tersambung! Nomor: ${infoNomor}`);
    });

    client.on('disconnected', (reason) => {
        status = 'disconnected';
        infoNomor = null;
        lastError = `Terputus: ${reason}`;
        console.warn('[WA-QR] Sesi WhatsApp terputus:', reason);
    });

    client.on('auth_failure', (msg) => {
        status = 'disconnected';
        lastError = `Gagal autentikasi: ${msg}`;
        console.error('[WA-QR] Auth failure:', msg);
    });

    client.initialize().catch(err => {
        status = 'disconnected';
        lastError = err.message;
        console.error('[WA-QR] Gagal initialize:', err.message);
    });

    return getStatus();
}

async function stop() {
    if (client) {
        try { await client.destroy(); } catch (e) { /* ignore */ }
        client = null;
    }
    status = 'disconnected';
    qrDataUrl = null;
    infoNomor = null;
    return getStatus();
}

// Logout total: hapus sesi tersimpan di disk supaya scan QR dari awal lagi
async function logout() {
    if (client) {
        try { await client.logout(); } catch (e) { /* ignore */ }
        try { await client.destroy(); } catch (e) { /* ignore */ }
        client = null;
    }
    status = 'disconnected';
    qrDataUrl = null;
    infoNomor = null;
    return getStatus();
}

function formatNomorWA(no_hp) {
    // whatsapp-web.js butuh format {nomor}@c.us, mis. 6281234567890@c.us
    let nomor = String(no_hp).replace(/[^0-9]/g, '');
    if (nomor.startsWith('0')) nomor = '62' + nomor.slice(1);
    return `${nomor}@c.us`;
}

async function kirimPesanQR(no_hp, pesan, pelanggan_id = null, tipe = 'manual', invoice_id = null) {
    const logResult = await query(`
        INSERT INTO wa_log (pelanggan_id, no_tujuan, pesan, tipe, invoice_id, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
    `, [pelanggan_id, no_hp, pesan, tipe, invoice_id]);
    const logId = logResult.insertId;

    if (status !== 'connected' || !client) {
        const errMsg = 'WhatsApp QR belum tersambung. Buka menu WhatsApp Gateway dan scan QR terlebih dahulu.';
        await query(`UPDATE wa_log SET status='failed', response=? WHERE id=?`, [errMsg, logId]);
        return { sukses: false, error: errMsg };
    }

    try {
        await client.sendMessage(formatNomorWA(no_hp), pesan);
        await query(`UPDATE wa_log SET status='sent', response='ok', sent_at=NOW() WHERE id=?`, [logId]);
        return { sukses: true };
    } catch (err) {
        await query(`UPDATE wa_log SET status='failed', response=? WHERE id=?`, [err.message, logId]);
        console.error(`[WA-QR] Gagal kirim ke ${no_hp}:`, err.message);
        return { sukses: false, error: err.message };
    }
}

// Kirim dokumen/file lokal (mis. PDF invoice) via WhatsApp Web (mode QR).
async function kirimDokumenQR(no_hp, { filePath, caption = '', filename = null, pelanggan_id = null, invoice_id = null, tipe = 'dokumen' } = {}) {
    const logResult = await query(`
        INSERT INTO wa_log (pelanggan_id, no_tujuan, pesan, tipe, invoice_id, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
    `, [pelanggan_id, no_hp, caption || `[Dokumen] ${filename || filePath}`, tipe, invoice_id]);
    const logId = logResult.insertId;

    if (status !== 'connected' || !client) {
        const errMsg = 'WhatsApp QR belum tersambung. Buka menu WhatsApp Gateway dan scan QR terlebih dahulu.';
        await query(`UPDATE wa_log SET status='failed', response=? WHERE id=?`, [errMsg, logId]);
        return { sukses: false, error: errMsg };
    }

    try {
        // MessageMedia dimuat dari whatsapp-web.js (sama paket dengan Client)
        const { MessageMedia } = require('whatsapp-web.js');
        const media = MessageMedia.fromFilePath(filePath);
        if (filename) media.filename = filename;
        await client.sendMessage(formatNomorWA(no_hp), media, { caption });
        await query(`UPDATE wa_log SET status='sent', response='ok', sent_at=NOW() WHERE id=?`, [logId]);
        return { sukses: true };
    } catch (err) {
        await query(`UPDATE wa_log SET status='failed', response=? WHERE id=?`, [err.message, logId]);
        console.error(`[WA-QR] Gagal kirim dokumen ke ${no_hp}:`, err.message);
        return { sukses: false, error: err.message };
    }
}

module.exports = { start, stop, logout, getStatus, kirimPesanQR, kirimDokumenQR };
