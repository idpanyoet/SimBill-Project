// middleware/license-guard.js — Penegakan lisensi (anti-copy), OPSIONAL.
// Default NONAKTIF: tidak melakukan apa pun sampai setting 'license_enforce' = '1'.
// Selalu fail-open (error apa pun → lewat) agar tidak pernah mengunci app
// karena bug guard. Saat aktif & lisensi invalid (di luar masa toleransi),
// route bisnis diblokir 403, tapi login/lisensi/setting/webhook tetap jalan
// supaya admin bisa memperbaiki lisensi.
const lic = require('../services/license');

const EXEMPT = [
    /^\/api\/auth\//,      // login admin/reseller/client
    /^\/api\/license\//,   // halaman & aksi lisensi
    /^\/api\/setting/,     // ubah konfigurasi lisensi
    /^\/api\/client\//,    // portal pelanggan
    /^\/webhook\//,        // callback payment gateway
    /^\/$/,                // halaman utama
];

let _next = 0, _enforce = false, _valid = true;

module.exports = async function licenseGuard(req, res, next) {
    try {
        if (Date.now() > _next) {
            _next = Date.now() + 5 * 60 * 1000;        // refresh status tiap 5 menit
            const cfg = await lic.getConfig();
            _enforce = cfg.enforce;
            if (_enforce) {
                const s = await lic.validasi();
                _valid = s.ok || !!s.offline;          // offline dalam grace = tetap boleh
            }
        }
        if (!_enforce || _valid) return next();
        if (EXEMPT.some(re => re.test(req.path))) return next();
        return res.status(403).json({ error: 'Lisensi tidak valid atau kedaluwarsa.', license: 'invalid' });
    } catch (e) {
        return next(); // fail-open: jangan pernah mengunci karena error guard
    }
};
