// services/invoice-pdf.js — Generator PDF invoice (server-side, tanpa Chromium)
// Memakai pdfkit (layout PDF murni JS) + qrcode (QR untuk link pembayaran).
// Dipakai oleh: GET /api/invoice/:id/pdf (download) dan kirim PDF ke WhatsApp.
const fs   = require('fs');
const path = require('path');
const { query, queryOne } = require('../config/db');

let PDFDocument, QRCode;
try {
    PDFDocument = require('pdfkit');
    QRCode     = require('qrcode');
} catch (e) {
    console.warn('[INVOICE-PDF] Package pdfkit/qrcode belum terinstall. Jalankan: npm install pdfkit qrcode');
}

const OUT_DIR = path.join(__dirname, '../../frontend/uploads/invoice');

function fmtRp(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }

function fmtTgl(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }); }
    catch (e) { return String(d); }
}

// Angka → kata (Bahasa Indonesia)
function terbilang(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    const s = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
    if (n < 12)        return s[n];
    if (n < 20)        return s[n - 10] + ' belas';
    if (n < 100)       return s[Math.floor(n / 10)] + ' puluh' + (n % 10 ? ' ' + s[n % 10] : '');
    if (n < 200)       return 'seratus' + (n % 100 ? ' ' + terbilang(n % 100) : '');
    if (n < 1000)      return s[Math.floor(n / 100)] + ' ratus' + (n % 100 ? ' ' + terbilang(n % 100) : '');
    if (n < 2000)      return 'seribu' + (n % 1000 ? ' ' + terbilang(n % 1000) : '');
    if (n < 1000000)   return terbilang(Math.floor(n / 1000)) + ' ribu' + (n % 1000 ? ' ' + terbilang(n % 1000) : '');
    if (n < 1000000000) return terbilang(Math.floor(n / 1000000)) + ' juta' + (n % 1000000 ? ' ' + terbilang(n % 1000000) : '');
    return terbilang(Math.floor(n / 1000000000)) + ' miliar' + (n % 1000000000 ? ' ' + terbilang(n % 1000000000) : '');
}

async function ambilData(invoiceId) {
    const inv = await queryOne(`
        SELECT i.*,
            COALESCE(p.nama, 'Pembeli Voucher') AS nama_pelanggan,
            p.no_hp, p.alamat, p.tipe_koneksi,
            pk.nama AS nama_paket, pk.kecepatan_dn, pk.masa_aktif, pk.satuan_masa
        FROM invoice i
        LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
        LEFT JOIN paket pk    ON i.paket_id     = pk.id
        WHERE i.id = ?
    `, [invoiceId]);
    if (!inv) throw new Error('Invoice tidak ditemukan');

    const rows = await query(
        `SELECT kunci, nilai FROM setting WHERE kunci IN
         ('app_name','alamat','wa_number','app_logo','app_url','pajak_persen')`
    );
    const cfg = {};
    rows.forEach(r => cfg[r.kunci] = r.nilai);
    return { inv, cfg };
}

// ============================================================
// GENERATE PDF — mengembalikan { filePath, publicUrl, no_invoice }
// ============================================================
async function buatInvoicePDF(invoiceId) {
    if (!PDFDocument) throw new Error('pdfkit belum terinstall di server. Jalankan: npm install pdfkit qrcode');

    const { inv, cfg } = await ambilData(invoiceId);

    const appName   = cfg.app_name  || 'SimBill ISP';
    const appAlamat = cfg.alamat    || '';
    const appWa     = cfg.wa_number || '';
    const appUrl    = (cfg.app_url  || '').replace(/\/+$/, '');
    const pajak     = parseFloat(cfg.pajak_persen || 0) || 0;

    const total    = Number(inv.jumlah || 0);
    const subtotal = pajak > 0 ? Math.round(total / (1 + pajak / 100)) : total;
    const ppn      = total - subtotal;

    const isLunas = inv.status === 'paid';
    const statusLabel = isLunas ? 'LUNAS' : (inv.status === 'overdue' ? 'TERLAMBAT' : 'BELUM BAYAR');
    const warna = {
        biru:  '#1a3a6e', teks: '#1a1a1a', abu: '#6b7280', garis: '#e5e7eb',
        hijau: '#16a34a', merah: '#dc2626', kuning: '#d97706'
    };
    const statusColor = isLunas ? warna.hijau : (inv.status === 'overdue' ? warna.merah : warna.kuning);

    // QR: untuk invoice belum lunas arahkan ke link bayar; jika lunas/no link → nomor invoice
    const qrData = (!isLunas && inv.payment_url) ? inv.payment_url : inv.no_invoice;
    let qrBuf = null;
    try { if (QRCode) qrBuf = await QRCode.toBuffer(String(qrData), { margin: 1, width: 240 }); }
    catch (e) { console.warn('[INVOICE-PDF] QR gagal dibuat:', e.message); }

    // Logo dari disk (app_logo = '/uploads/xxx.png')
    let logoPath = null;
    if (cfg.app_logo) {
        const p = path.join(__dirname, '../../frontend', cfg.app_logo.replace(/^\//, ''));
        if (fs.existsSync(p)) logoPath = p;
    }

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const safeNo   = String(inv.no_invoice).replace(/[^a-zA-Z0-9_-]/g, '_');
    const rand     = require('crypto').randomBytes(4).toString('hex');
    const filename = `${safeNo}_${rand}.pdf`;
    const filePath = path.join(OUT_DIR, filename);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const L = 40, R = 555; // margin kiri/kanan (A4 = 595pt lebar)

    // ── HEADER ──────────────────────────────────────────────
    if (logoPath) {
        try { doc.image(logoPath, L, 40, { fit: [90, 50] }); } catch (e) {}
    }
    doc.fillColor(warna.teks).font('Helvetica-Bold').fontSize(16)
       .text(appName, logoPath ? 140 : L, 42);
    doc.font('Helvetica').fontSize(8).fillColor(warna.abu);
    if (appAlamat) doc.text(appAlamat, logoPath ? 140 : L, 64, { width: 300 });
    if (appWa)     doc.text('WA: ' + appWa + (appUrl ? '  |  ' + appUrl : ''), logoPath ? 140 : L);

    doc.font('Helvetica-Bold').fontSize(26).fillColor(warna.biru)
       .text('INVOICE', R - 200, 42, { width: 200, align: 'right' });

    doc.moveTo(L, 95).lineTo(R, 95).lineWidth(2).strokeColor(warna.teks).stroke();

    // ── KEPADA & META ───────────────────────────────────────
    let y = 110;
    doc.font('Helvetica').fontSize(8).fillColor(warna.abu).text('Kepada:', L, y);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(warna.teks).text(inv.nama_pelanggan || '—', L, y + 11);
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    if (inv.no_hp)  doc.text(inv.no_hp, L, y + 30);
    if (inv.alamat) doc.text(inv.alamat, L, y + 43, { width: 250 });

    const metaX = 330, valX = 430;
    const meta = [
        ['No Invoice', inv.no_invoice],
        ['Tanggal', fmtTgl(inv.tgl_invoice)],
        ['Jatuh Tempo', fmtTgl(inv.tgl_jatuh_tempo)],
        ['Status', statusLabel],
    ];
    meta.forEach((m, i) => {
        const yy = y + i * 14;
        doc.font('Helvetica').fontSize(9).fillColor(warna.abu).text(m[0], metaX, yy, { width: 95 });
        doc.font('Helvetica-Bold').fontSize(9)
           .fillColor(m[0] === 'Status' ? statusColor : warna.teks)
           .text(': ' + m[1], valX, yy, { width: 125 });
    });

    // ── TABEL ITEM ──────────────────────────────────────────
    y = 185;
    doc.rect(L, y, R - L, 20).fill(warna.biru);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
    doc.text('No', L + 6, y + 6, { width: 24 });
    doc.text('Deskripsi', L + 34, y + 6, { width: 230 });
    doc.text('Qty', L + 270, y + 6, { width: 40, align: 'center' });
    doc.text('Harga', L + 320, y + 6, { width: 90, align: 'right' });
    doc.text('Total', L + 415, y + 6, { width: 95, align: 'right' });

    y += 20;
    doc.fillColor(warna.teks).font('Helvetica').fontSize(9);
    doc.text('1', L + 6, y + 6, { width: 24 });
    const deskripsi = (inv.nama_paket || 'Paket Internet') +
        (inv.kecepatan_dn ? ` (${inv.kecepatan_dn} Mbps)` : '');
    doc.text(deskripsi, L + 34, y + 6, { width: 230 });
    doc.text('1', L + 270, y + 6, { width: 40, align: 'center' });
    doc.text(fmtRp(subtotal), L + 320, y + 6, { width: 90, align: 'right' });
    doc.text(fmtRp(subtotal), L + 415, y + 6, { width: 95, align: 'right' });
    doc.moveTo(L, y + 24).lineTo(R, y + 24).lineWidth(0.5).strokeColor(warna.garis).stroke();

    // ── TOTAL ───────────────────────────────────────────────
    y += 36;
    const boxX = 330, boxW = R - boxX;
    function totalRow(label, val, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
           .fillColor(warna.teks);
        doc.text(label, boxX, y, { width: 120 });
        doc.text(fmtRp(val), boxX + 120, y, { width: boxW - 120, align: 'right' });
        y += bold ? 18 : 14;
    }
    totalRow('Sub Total', subtotal);
    if (pajak > 0) totalRow(`PPN ${pajak}%`, ppn);
    doc.moveTo(boxX, y).lineTo(R, y).lineWidth(0.5).strokeColor('#ccc').stroke();
    y += 4;
    totalRow('Total Tagihan', total, true);

    // Terbilang
    y += 6;
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#555')
       .text('Terbilang: ' + terbilang(total) + ' rupiah', L, y, { width: R - L });

    // ── QR + STATUS ─────────────────────────────────────────
    y += 30;
    if (qrBuf) {
        try { doc.image(qrBuf, L, y, { fit: [90, 90] }); } catch (e) {}
        doc.font('Helvetica').fontSize(7).fillColor(warna.abu)
           .text((!isLunas && inv.payment_url) ? 'Scan untuk bayar' : inv.no_invoice,
                 L, y + 92, { width: 90, align: 'center' });
    }

    // Stempel LUNAS / area tanda terima
    const stX = 360, stY = y;
    doc.roundedRect(stX, stY, R - stX, 90, 6).lineWidth(1).dash(3, { space: 2 }).strokeColor('#ccc').stroke().undash();
    doc.font('Helvetica').fontSize(8).fillColor(warna.abu).text('Tanda Terima', stX + 10, stY + 8);
    if (isLunas) {
        doc.save();
        doc.rotate(-15, { origin: [stX + (R - stX) / 2, stY + 45] });
        doc.font('Helvetica-Bold').fontSize(26).fillColor(warna.hijau)
           .text('LUNAS', stX, stY + 30, { width: R - stX, align: 'center' });
        doc.restore();
        if (inv.tgl_bayar)
            doc.font('Helvetica').fontSize(7.5).fillColor('#555')
               .text('Dibayar: ' + fmtTgl(inv.tgl_bayar) + (inv.metode_bayar ? ' (' + inv.metode_bayar + ')' : ''),
                     stX + 10, stY + 72);
    } else {
        doc.font('Helvetica').fontSize(7.5).fillColor('#888')
           .text('Diterima oleh: _______________', stX + 10, stY + 55);
    }

    // ── FOOTER ──────────────────────────────────────────────
    doc.font('Helvetica').fontSize(8).fillColor('#aaa')
       .text(`${appName}${appUrl ? ' — ' + appUrl : ''}`, L, 770, { width: R - L, align: 'center' });

    doc.end();
    await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });

    const publicUrl = appUrl ? `${appUrl}/uploads/invoice/${filename}` : `/uploads/invoice/${filename}`;
    return { filePath, publicUrl, filename, no_invoice: inv.no_invoice };
}

// Hapus file PDF invoice yang lebih tua dari N hari (privasi + hemat disk).
function bersihkanPdfLama(maxHari = 7) {
    try {
        if (!fs.existsSync(OUT_DIR)) return 0;
        const batas = Date.now() - maxHari * 24 * 60 * 60 * 1000;
        let n = 0;
        for (const f of fs.readdirSync(OUT_DIR)) {
            if (!f.endsWith('.pdf')) continue;
            const fp = path.join(OUT_DIR, f);
            if (fs.statSync(fp).mtimeMs < batas) { fs.unlinkSync(fp); n++; }
        }
        return n;
    } catch (e) { return 0; }
}

module.exports = { buatInvoicePDF, bersihkanPdfLama, terbilang };
