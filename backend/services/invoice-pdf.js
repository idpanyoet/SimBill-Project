// services/invoice-pdf.js — Generator PDF invoice via Puppeteer (Chromium headless).
// Me-render HTML A4 yang SAMA PERSIS dengan tampilan cetak di dashboard, jadi
// PDF yang dihasilkan identik dengan hasil print. QR & logo di-embed sebagai
// data URL (tidak perlu akses jaringan saat render → tanpa CORS/CDN).
const fs   = require('fs');
const path = require('path');
const { query, queryOne } = require('../config/db');

let QRCode, puppeteer;
try { QRCode    = require('qrcode'); }   catch (e) {}
try { puppeteer = require('puppeteer'); } catch (e) {}

const OUT_DIR = path.join(__dirname, '../../frontend/uploads/invoice');

// Escape data (nama/alamat pelanggan, setting) sebelum disisipkan ke HTML yang
// dirender Puppeteer. Tanpa ini, pelanggan bernama mis. <img src=x onerror=...>
// bisa mengeksekusi HTML/JS di dalam headless Chrome saat PDF dibuat (SSRF/
// exfil/baca file lokal). Nominal & tanggal tidak terpengaruh.
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTgl(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }); }
    catch (e) { return String(d); }
}

function terbilang(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    const s = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
    if (n < 12)         return s[n];
    if (n < 20)         return s[n - 10] + ' belas';
    if (n < 100)        return s[Math.floor(n / 10)] + ' puluh' + (n % 10 ? ' ' + s[n % 10] : '');
    if (n < 200)        return 'seratus' + (n % 100 ? ' ' + terbilang(n % 100) : '');
    if (n < 1000)       return s[Math.floor(n / 100)] + ' ratus' + (n % 100 ? ' ' + terbilang(n % 100) : '');
    if (n < 2000)       return 'seribu' + (n % 1000 ? ' ' + terbilang(n % 1000) : '');
    if (n < 1000000)    return terbilang(Math.floor(n / 1000)) + ' ribu' + (n % 1000 ? ' ' + terbilang(n % 1000) : '');
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
         ('app_name','alamat','wa_number','app_logo','app_url')`
    );
    const cfg = {};
    rows.forEach(r => cfg[r.kunci] = r.nilai);
    return { inv, cfg };
}

// HTML A4 — disalin persis dari tampilan cetak dashboard agar identik.
function buildHtmlA4(inv, cfg, qrDataUrl, logoDataUrl) {
    const appName   = cfg.app_name  || 'SimBill ISP';
    const appAlamat = cfg.alamat    || '';
    const appWa     = cfg.wa_number || '';
    const appUrl    = cfg.app_url   || '';

    const isLunas     = inv.status === 'paid';
    const statusLabel = isLunas ? 'LUNAS' : (inv.status === 'overdue' ? 'TERLAMBAT' : 'BELUM BAYAR');
    const statusColor = isLunas ? '#16a34a' : (inv.status === 'overdue' ? '#dc2626' : '#d97706');

    const tglInvoice = fmtTgl(inv.tgl_invoice);
    const tglTempo   = fmtTgl(inv.tgl_jatuh_tempo);
    const tglBayar   = inv.tgl_bayar ? fmtTgl(inv.tgl_bayar) : null;
    const jumlah     = Number(inv.jumlah || 0);
    const terbilangStr = terbilang(jumlah);

    // Invoice pembelian voucher online: kode voucher disimpan di keterangan
    // dengan format "— VoucherDibuat: XXXX". Tampilkan agar pembeli tahu kodenya.
    let kodeVoucher = null;
    const mKode = String(inv.keterangan || '').match(/VoucherDibuat:\s*([A-Za-z0-9_-]+)/i);
    if (mKode) kodeVoucher = mKode[1];

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${inv.no_invoice}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:11pt;color:#1a1a1a;background:#fff}
.page{width:210mm;min-height:297mm;padding:14mm 16mm;margin:0 auto;background:#fff;position:relative}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1a1a1a;padding-bottom:10px;margin-bottom:12px}
.company-name{font-size:16pt;font-weight:700;margin-bottom:2px}
.company-sub{font-size:9pt;color:#555;margin-bottom:3px}
.company-info{font-size:8pt;color:#666}
.invoice-title{font-size:28pt;font-weight:700;color:#1a3a6e;text-align:right;letter-spacing:2px}
.logo{height:50px;object-fit:contain;display:block;margin-bottom:4px;margin-left:auto}
.row2{display:flex;justify-content:space-between;margin-bottom:14px}
.to-box{font-size:9pt}
.to-box .label{color:#777;font-size:8pt;margin-bottom:2px}
.to-box .nama{font-size:13pt;font-weight:700;margin-bottom:2px}
.info-table{font-size:9pt;border-collapse:collapse}
.info-table td{padding:1px 4px}
.info-table td:first-child{color:#777;white-space:nowrap}
.info-table td:last-child{font-weight:600}
.period{font-size:9pt;color:#444;margin-bottom:10px}
.status-badge{display:inline-block;font-size:9pt;font-weight:700;padding:2px 10px;border-radius:4px;border:1.5px solid;margin-top:2px}
table.items{width:100%;border-collapse:collapse;margin-bottom:10px}
table.items th{background:#1a3a6e;color:#fff;padding:6px 8px;font-size:9pt;text-align:left}
table.items th:nth-child(3),table.items th:nth-child(4),table.items th:nth-child(5),table.items th:nth-child(6){text-align:right}
table.items td{padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:9pt}
table.items td:nth-child(3),table.items td:nth-child(4),table.items td:nth-child(5),table.items td:nth-child(6){text-align:right}
.total-row{display:flex;justify-content:flex-end;margin-bottom:4px}
.total-box{background:#f1f5f9;border:1px solid #ddd;border-radius:6px;padding:8px 16px;min-width:220px}
.total-box .row{display:flex;justify-content:space-between;font-size:10pt;padding:2px 0}
.total-box .row.grand{font-weight:700;font-size:11pt;border-top:1px solid #ccc;margin-top:4px;padding-top:4px}
.terbilang{font-size:8.5pt;font-style:italic;color:#555;margin-bottom:14px}
.bottom{display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px}
.qr-box{text-align:center}
.qr-box img{width:100px;height:100px;display:block;margin:0 auto 4px}
.qr-box .qr-label{font-size:7pt;color:#888}
.stamp-area{position:relative;min-width:180px;min-height:80px;border:1px dashed #ccc;border-radius:6px;padding:8px;text-align:center}
.stamp-area .label{font-size:8pt;color:#888;margin-bottom:4px}
.stamp-lunas{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:28pt;font-weight:700;color:#16a34a;opacity:.7;border:3px solid #16a34a;padding:2px 12px;border-radius:6px;white-space:nowrap;letter-spacing:3px}
.syarat{border-left:3px solid #dc2626;padding-left:10px;font-size:8pt;color:#dc2626;max-width:200px}
.syarat b{display:block;margin-bottom:3px}
.thanks{font-size:14pt;font-weight:700;color:#1a3a6e}
.footer-bottom{text-align:center;font-size:8pt;color:#aaa;margin-top:20px;border-top:1px solid #eee;padding-top:8px}
@page{size:A4;margin:0}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
</style></head><body>
<div class="page">
  <div class="header">
    <div>
      <div class="company-name">${esc(appName)}</div>
      <div class="company-sub">High Speed Internet</div>
      <div class="company-info">${appAlamat ? 'Alamat : ' + esc(appAlamat) : ''}</div>
      <div class="company-info">${appWa ? 'No HP : ' + esc(appWa) + (appUrl ? ' &nbsp;|&nbsp; ' + esc(appUrl) : '') : esc(appUrl)}</div>
    </div>
    <div style="text-align:right">
      ${logoDataUrl ? `<img src="${logoDataUrl}" class="logo" alt="Logo">` : ''}
      <div class="invoice-title">INVOICE</div>
    </div>
  </div>

  <div class="row2">
    <div class="to-box">
      <div class="label">Kepada :</div>
      <div class="nama">${esc(inv.nama_pelanggan || '—')}</div>
      <div style="font-size:9pt;color:#444">${esc(inv.no_hp || '')}</div>
      <div style="font-size:9pt;color:#444">${esc(inv.alamat || '')}</div>
    </div>
    <table class="info-table">
      <tr><td>ID Pelanggan</td><td>:</td><td>${inv.pelanggan_id || '—'}</td></tr>
      <tr><td>No Invoice</td><td>:</td><td>${inv.no_invoice}</td></tr>
      <tr><td>Tanggal Invoice</td><td>:</td><td>${tglInvoice}</td></tr>
      <tr><td>Jatuh Tempo</td><td>:</td><td>${tglTempo}</td></tr>
    </table>
  </div>

  <div class="period" style="display:flex;align-items:center;gap:10px">
    <span>Periode ${tglInvoice}</span>
    <span class="status-badge" style="color:${statusColor};border-color:${statusColor}">${statusLabel}</span>
  </div>

  <table class="items">
    <thead><tr><th style="width:30px">No</th><th>Item</th><th style="width:40px">Qty</th><th>Harga</th><th>Disc</th><th>Total</th></tr></thead>
    <tbody>
      <tr>
        <td>1.</td>
        <td>${esc(inv.nama_paket || 'Paket Internet')}</td>
        <td style="text-align:center">1</td>
        <td>${jumlah.toLocaleString('id-ID')}</td>
        <td>-</td>
        <td>${jumlah.toLocaleString('id-ID')}</td>
      </tr>
    </tbody>
  </table>

  ${kodeVoucher ? `
  <div style="margin:10px 0;padding:12px 16px;border:2px dashed #16a34a;border-radius:8px;background:#f0fdf4;text-align:center">
    <div style="font-size:9pt;color:#15803d;font-weight:600;letter-spacing:1px;text-transform:uppercase">Kode Voucher (Username &amp; Password)</div>
    <div style="font-size:18pt;font-weight:800;font-family:'Courier New',monospace;color:#166534;letter-spacing:2px;margin:4px 0">${esc(kodeVoucher)}</div>
    <div style="font-size:8pt;color:#666">Gunakan kode ini untuk login di halaman voucher / hotspot</div>
  </div>` : ''}

  <div class="total-row">
    <div class="total-box">
      <div class="row"><span>Sub Total</span><span>${jumlah.toLocaleString('id-ID')}</span></div>
      <div class="row"><span>Diskon</span><span>-</span></div>
      <div class="row grand"><span>Total Tagihan</span><span>${jumlah.toLocaleString('id-ID')}</span></div>
    </div>
  </div>

  <div class="terbilang">* Terbilang : <i>${terbilangStr} rupiah</i></div>

  <div class="bottom">
    <div class="qr-box">
      ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR">` : ''}
      <div class="qr-label">${inv.no_invoice}</div>
    </div>

    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:10px">
      <div class="stamp-area">
        <div class="label">Tanda Terima</div>
        ${isLunas ? `<div class="stamp-lunas">LUNAS</div>` : ''}
        <div style="font-size:7.5pt;color:#888;margin-top:30px">Diterima Oleh : _______________</div>
        ${tglBayar ? `<div style="font-size:7.5pt;color:#555;margin-top:4px">Pada Tanggal ${tglBayar}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="thanks">Terimakasih</div>
        <div class="syarat">
          <b>Syarat dan Ketentuan</b>
          ${isLunas ? 'Terimakasih sudah melakukan pembayaran tepat waktu' : 'Mohon lakukan pembayaran tepat waktu'}
        </div>
      </div>
    </div>
  </div>

  <div class="footer-bottom">${esc(appName)} &mdash; ${esc(appUrl || '')}</div>
</div>
</body></html>`;
}

// Browser dipakai ulang antar permintaan (launch sekali) agar cepat.
let _browser = null;
async function getBrowser() {
    if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
    _browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    return _browser;
}

async function buatInvoicePDF(invoiceId) {
    if (!puppeteer) throw new Error('puppeteer belum terinstall. Jalankan: npm install puppeteer');

    const { inv, cfg } = await ambilData(invoiceId);

    // QR (data URL) — sama dengan print: encode nomor invoice
    let qrDataUrl = '';
    try { if (QRCode) qrDataUrl = await QRCode.toDataURL(String(inv.no_invoice), { margin: 1, width: 240 }); }
    catch (e) { console.warn('[INVOICE-PDF] QR gagal:', e.message); }

    // Logo (data URL) dari disk
    let logoDataUrl = '';
    if (cfg.app_logo) {
        const p = path.join(__dirname, '../../frontend', cfg.app_logo.replace(/^\//, ''));
        if (fs.existsSync(p)) {
            const ext  = (path.extname(p).slice(1) || 'png').toLowerCase();
            const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' ? 'image/jpeg' : 'image/' + ext);
            logoDataUrl = `data:${mime};base64,` + fs.readFileSync(p).toString('base64');
        }
    }

    const html = buildHtmlA4(inv, cfg, qrDataUrl, logoDataUrl);

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const safeNo   = String(inv.no_invoice).replace(/[^a-zA-Z0-9_-]/g, '_');
    const rand     = require('crypto').randomBytes(4).toString('hex');
    const filename = `${safeNo}_${rand}.pdf`;
    const filePath = path.join(OUT_DIR, filename);

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.pdf({
            path: filePath, format: 'A4', printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });
    } finally {
        await page.close().catch(() => {});
    }

    const appUrl = (cfg.app_url || '').replace(/\/+$/, '');
    const publicUrl = appUrl ? `${appUrl}/uploads/invoice/${filename}` : `/uploads/invoice/${filename}`;
    return { filePath, publicUrl, filename, no_invoice: inv.no_invoice };
}

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

// Render HTML apa pun → Buffer PDF (pakai ulang browser yang sama). Dipakai juga
// untuk export kartu voucher per batch.
// opsi tambahan: { emulateScreen } untuk template yang mewarnai via JS onload.
async function renderHtmlToPdf(html, pdfOptions = {}, opts = {}) {
    if (!puppeteer) throw new Error('puppeteer belum terinstall. Jalankan: npm install puppeteer');
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        // Beberapa template mewarnai kartu lewat script window.onload + memuat script
        // eksternal. 'load' menunggu resource utama; bila script eksternal lambat/timeout,
        // jangan gagal total — tetap lanjut setelah batas waktu.
        try {
            await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
        } catch (e) {
            await page.setContent(html, { waitUntil: 'domcontentloaded' });
        }
        // Beri waktu script onload selesai mewarnai elemen sebelum "memotret".
        await new Promise(r => setTimeout(r, 600));
        return await page.pdf(Object.assign(
            { format: 'A4', printBackground: true, margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' } },
            pdfOptions
        ));
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { buatInvoicePDF, bersihkanPdfLama, terbilang, renderHtmlToPdf };
