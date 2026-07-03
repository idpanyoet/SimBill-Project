# Changelog — SimBill

Semua perubahan penting pada SimBill dicatat di sini.
Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/),
penomoran versi mengikuti [SemVer](https://semver.org/lang/id/).

---

## [v1.2.3] — 2026-06-26

### Ditambahkan
- **Profil Reseller** — reseller dapat mengubah datanya sendiri (nama, no HP,
  alamat, email) dan mengganti password melalui menu **"Profil Saya"**.
- **Edit Akun Reseller (Admin)** — admin dapat mengubah nama, username, no HP,
  dan mereset password reseller dari panel. Modal Edit Reseller kini **2 langkah**
  (Data Akun → Paket & Saldo) agar lebih ringkas.
- **Topup Sukses** — kartu riwayat topup reseller yang sudah lunas di halaman
  Reseller (Order ID, Reseller, Jumlah, Metode, Waktu).
- **Label metode pembayaran** pada notifikasi WA: kode gateway (mis. Duitku
  `SP`, `OV`, `DA`, `QR`, `BC`, `M2`) ditampilkan sebagai nama ramah
  (ShopeePay, OVO, DANA, QRIS, BCA Virtual Account, Mandiri Virtual Account, dll).

### Diperbaiki
- **ACS "Ambil Status"** tidak lagi memunculkan error `timeout` untuk ONU yang
  lambat merespons — perintah tetap masuk antrian GenieACS dan data menyusul.
- **Transaksi Terbaru** tidak lagi tampil dobel (webhook payment_log kini
  idempoten terhadap callback berulang gateway).
- **Notifikasi WA konfirmasi bayar** tidak lagi memiliki field kosong
  (No. Invoice / Paket / Metode / Tanggal) — terutama pembayaran via
  ShopeePay/gateway. Field dilengkapi otomatis dari database bila perlu.
- **Tambah Reseller** lebih responsif: tombol menampilkan indikator
  "Menyimpan…" + anti double-klik, dan proses dipangkas dari 5 menjadi 4
  pemanggilan API.
- Reseller tidak lagi **ter-logout** saat menekan menu Setting (yang merupakan
  menu khusus admin).

### Teknis
- **Auto-migrasi** kolom `reseller.alamat` saat server start (idempoten) —
  tidak perlu menjalankan `ALTER TABLE` manual saat update.

---

## [v1.2.2] — 2026-06-25

### Diubah
- **Halaman landing voucher** (`index.html`) didesain ulang: gradient
  ungu→biru→cyan→oranye, tampilan lebih bersih (soft UI), hero satu kolom di
  tengah, branding dinamis (mengikuti `app_logo` / `app_name`).
- Bar statistik di landing disembunyikan pada layar mobile.

---

## [v1.2.1] — 2026-06-24

### Teknis
- Pipeline rilis dua-repo distabilkan: **SimBill-Source** (privat, plain) untuk
  pengembangan, **SimBill-Project** (publik, terobfuscate) untuk distribusi
  install/update pelanggan.
- Notifikasi "update tersedia" pada panel produksi internal dimatikan
  (sumber update diarahkan ke repo privat).

---

## [v1.2.0] — 2026-06-23

### Teknis
- **Obfuscation** untuk berkas kritis lisensi (`backend/services/license.js`
  dan `backend/middleware/license-guard.js`) menggunakan javascript-obfuscator.
- Alur rilis otomatis: build terobfuscate dari source → force-push orphan
  (history bersih) ke repo customer → tag versi.

---

[v1.2.3]: https://github.com/idpanyoet/SimBill-Project/releases/tag/v1.2.3
[v1.2.2]: https://github.com/idpanyoet/SimBill-Project/releases/tag/v1.2.2
[v1.2.1]: https://github.com/idpanyoet/SimBill-Project/releases/tag/v1.2.1
[v1.2.0]: https://github.com/idpanyoet/SimBill-Project/releases/tag/v1.2.0
