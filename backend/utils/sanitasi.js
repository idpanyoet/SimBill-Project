// utils/sanitasi.js — Sanitasi input sisi server (lapis kedua, defense-in-depth).
//
// Catatan: pertahanan UTAMA terhadap XSS tetap escape di OUTPUT (escapeHtml/
// jsAttr di frontend). Modul ini sengaja TIDAK menghapus karakter terlihat
// seperti < > & ' " agar nama/alamat sah tidak rusak ("Toko A&B", "PT. X <Pusat>",
// keluhan "speed < 1mbps"). Yang dibuang hanya: null byte, karakter kontrol,
// dan (untuk field satu-baris) newline — yang tak pernah sah pada nama/no_hp/
// alamat dan kerap dipakai untuk log/CSV/header injection.

// Buang null byte + karakter kontrol non-printable.
// multiline=true mempertahankan \n \r \t.
function stripKontrol(s, multiline = false) {
    s = String(s == null ? '' : s);
    // eslint-disable-next-line no-control-regex
    const re = multiline ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g
                         : /[\x00-\x1F\x7F]/g;
    return s.replace(re, '');
}

// Field satu baris (nama, alamat, judul, dll): rapikan whitespace, batasi panjang.
function teksSatuBaris(s, maks = 120) {
    s = String(s == null ? '' : s).replace(/[\r\n\t\f\v]+/g, ' '); // baris/tab → spasi (jangan dempetkan kata)
    return stripKontrol(s, false).replace(/\s+/g, ' ').trim().slice(0, maks);
}

// Field multi baris (isi tiket/pesan): pertahankan baris, batasi panjang.
function teksMultiBaris(s, maks = 2000) {
    return stripKontrol(s, true)
        .replace(/[ \t]+\n/g, '\n')   // rapikan trailing space per baris
        .replace(/\n{4,}/g, '\n\n\n')  // batasi baris kosong beruntun
        .trim()
        .slice(0, maks);
}

// Nomor HP: hanya digit & '+' depan; normalisasi 0 → 62 (format Indonesia).
function noHp(s, { wajib = false } = {}) {
    let t = String(s == null ? '' : s).replace(/[^\d+]/g, '');
    t = t.replace(/(?!^)\+/g, '');           // '+' hanya boleh di depan
    if (t.startsWith('+')) t = t.slice(1);
    if (t.startsWith('0')) t = '62' + t.slice(1);
    if (t.length < 8 || t.length > 16) return wajib ? null : '';
    return t;
}

// Email: trim + lowercase + cek format dasar. Kembalikan '' bila kosong & tak wajib.
const RX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function email(s, { wajib = false } = {}) {
    const t = String(s == null ? '' : s).trim().toLowerCase().slice(0, 254);
    if (!t) return wajib ? null : '';
    return RX_EMAIL.test(t) ? t : null;   // null = tidak valid (route memutuskan 400)
}

module.exports = { stripKontrol, teksSatuBaris, teksMultiBaris, noHp, email };
