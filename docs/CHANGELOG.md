# SimBill v1.7.0 — Changelog

**Rilis:** 9 Juli 2026
**Sebelumnya:** v1.6.1 (multi-OLT VSOL + HIOSO)

Rilis besar: sistem billing prorata & prepaid-unpaid, perbaikan bug reseller, dan redesign UI "Aurora".

---

## ✨ Fitur Baru

### Billing — Prorata Invoice Pertama (Prepaid + Fixed Date)
- Pelanggan **prepaid** dengan periode **Fixed Date** kini otomatis dapat **invoice prorata** untuk bulan pertama (periode parsial dari tgl pasang s/d tanggal periode tetap).
- `tgl_expired` di-align ke Fixed Date; invoice ke-2 dst penuh.
- Perhitungan **flat-30** (harga/30 × hari terpakai). Pasang mepet (<7 hari) → digeser ke periode bulan depan (anti-tagihan-receh).
- Berlaku untuk paket bulanan: **1 bulan** atau **28–31 hari** (paket bulanan dalam satuan hari).
- **Auto payment link** (gateway) ikut dibuat untuk invoice prorata.
- Reseller & CSV import dikecualikan.

### Billing — Status Bayar Awal (Prepaid "bayar dulu")
- Dropdown **"Status Bayar Awal"** di form Tambah Pelanggan (muncul saat Prepaid + Fixed Date):
  - **Sudah Bayar (Aktif)** → langsung aktif.
  - **Belum Bayar** → akun dibuat **nonaktif** (RADIUS suspended, password tersimpan). **Aktif otomatis** saat invoice prorata dibayar.

### Billing — Label Periode
- Periode `tetap` ditampilkan **"Renewal - [Perpanjangan]"**, `kalender` ditampilkan **"Fixed Date - [tanggal tetap]"** (nilai DB tetap sama).

### WhatsApp — Placeholder
- Template dukung `{key}` **dan** `[key]`.
- Placeholder baru di notif pelanggan baru: `{tagihan_pertama}` (auto "Rp X (prorata N hari)"), `{total_bersih}` (tanpa "Rp"), plus `{member_id}`/`{uid}`, `{payment_url}`, `{no_invoice}` di 5 fungsi kirim.

### UI — Tema Aurora
- **Skin "Aurora" global** (indigo→cyan, surface glass, background gradient) — 1 klik dari picker tema, restyle SELURUH halaman. Reversible.
- **5 modal "Aurora Split"** (panel kiri gradient + hero live + form kanan glass, ikon SVG modern): Tambah Pelanggan (+ progress step), Generate Voucher (contoh kode live), Buat Invoice (total live), Tambah Paket (harga/speed live), Tambah Reseller (level live).

---

## 🐛 Perbaikan

- **Reseller masa aktif**: paket bulanan/jam tak lagi salah dihitung sebagai HARI (dulu selalu `.add(masa,'day')`). Kini ikut `satuan_masa` (jam/bulan/hari) di penjualan voucher, aktivasi, & perpanjangan.
- **WA "Rp" ganda**: `{total_bersih}` disediakan tanpa prefix "Rp" agar template bebas menambah sendiri.

---

## 🚀 Deploy

Lihat `BACA-DULU.txt` di paket rilis. **Tanpa migrasi database** (pakai kolom existing).

File berubah: `frontend/admin.html`, `backend/routes/{pelanggan,invoice,reseller}.js`, `backend/config/db.js`, `backend/services/whatsapp.js`.

---

## ⚠️ Catatan

- Aktivasi otomatis pelanggan **unpaid** terpasang di jalur **bayar-tunai** (panel). Untuk pembayaran via **gateway online**, pastikan webhook callback memanggil alur yang sama (cek `routes/webhook.js`).
- Modal Aurora Split selalu bergaya aurora (independen skin). Skin Aurora global khusus menata halaman.
