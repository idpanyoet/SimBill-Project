# Changelog SimBill
Semua perubahan penting pada SimBill dicatat di sini.
Format mengikuti versi semantik (vMAJOR.MINOR.PATCH).
---

## v1.5.3 — 2026-07-03

### 🐛 Perbaikan
- **Login pertama sering gagal ("Sesi berakhir")**: request login tidak lagi membawa token lama yang kadaluarsa, sehingga login pertama langsung berhasil. Bonus: error kredensial salah kini tampil apa adanya.
- **Kebocoran tampilan saat logout**: dashboard tidak lagi terlihat di bawah form login setelah logout / saat halaman pertama dibuka (data sensitif tidak lagi keintip).
- **Halaman OLT tanpa OLT**: bila belum ada / semua OLT dihapus, tampil pesan "Belum ada OLT" yang kalem, bukan error merah.




## v1.4.0 — 2026-07-02

### ⚡ OLT (performa & UI)
- **Daftar ONU tampil cepat**: serial (SN) di-load terpisah (lazy), dashboard
  pakai *stale-while-revalidate*, dan pool SSH ditahan hangat lebih lama.
- **Signal-first**: kolom Signal/RX diisi lebih dulu, Traffic menyusul; metrik
  1 halaman diambil dalam satu batch (bukan 10 panggilan terpisah).
- **Detail ONU instan**: modal tampil seketika dari data yang sudah ada,
  detail berat (RX OLT, jarak, uptime, riwayat) di-*patch* menyusul.
- **Tab Network Config** pada modal ONU (kartu WAN PPPoE/STATIC/DHCP, dry-run
  sebelum commit) + **dropdown VLAN Profile** dari OLT.

### 🛡️ Keamanan
- Guard **`requireAdmin`** pada endpoint berbahaya (backup/restore, RADIUS,
  VPN, broadcast WA, paket, voucher-template, telegram, provisioning OLT).
  Role operator/teknisi tak lagi bisa memanggilnya via API.

### 💬 WhatsApp
- **Fitur Resend** (tombol ↻) di Riwayat Pesan WA + endpoint `/whatsapp/resend/:id`.
- **Fix kirim internasional (+60 dll)**: normalisasi nomor ke E.164 digit
  (tanpa `+`) dan mengirim `countryCode: '0'` ke Fonnte agar filter auto-62
  dimatikan (sebelumnya `60xxx` jadi `6260xxx` yang invalid).

### 📅 Penagihan
- **Auto-cancel invoice basi** (cron harian 06:00, sebelum reminder): invoice
  `unpaid`/`overdue` milik pelanggan aktif yang `tgl_expired`-nya sudah melewati
  jatuh tempo invoice ditandai `cancelled` — mencegah tagihan basi menumpuk /
  memblok generate periode baru. Dikawal setting `auto_cancel_basi` (default aktif).

---

## v1.2.5 — 2026-06-29

### ✨ Fitur
- **Session Time Left akurat** untuk SEMUA voucher bermasa-aktif (jam/hari/bulan).
  Sisa waktu kini dihitung nyata `(tgl_digunakan + masa) − sekarang` dan
  di-refresh otomatis tiap 5 menit, sehingga countdown di MikroTik tidak
  "kembali penuh" saat pelanggan reconnect.
- **Badge "EXPIRED"** pada tool Cek User/Voucher — voucher/pelanggan yang sudah
  lewat masa aktif ditandai jelas (badge merah + teks Expired merah).
- **Filter invoice "Dibatalkan"** ditambahkan pada dropdown status.

### 🛡️ Anti-Invoice Dobel (lengkap semua jalur)
- Pembuatan invoice **manual ("+ Buat Invoice")** kini menolak bila pelanggan
  masih punya invoice belum lunas — menutup celah terakhir invoice dobel.
  (Sebelumnya hanya jalur generate/cron yang dijaga.)
- Daftar invoice **menyembunyikan status `cancelled`** secara default
  (hanya tampil bila filter di-set ke "Dibatalkan").

### 📅 Penagihan
- **Perpanjangan menjaga hari jatuh tempo (anchor tanggal).** Saat pelanggan
  dibayar/diperpanjang, tanggal expired berikutnya dihitung dari tanggal expired
  lama (mis. tgl 1 → tgl 1 bulan depan), bukan dari tanggal bayar. Berlaku pada
  pembayaran manual ("Lunasi") dan via gateway.

### 🐞 Perbaikan
- **"Invalid Email Address" pada payment gateway** diperbaiki. Username PPPoE yang
  memuat `@` (mis. `nafi@rfnet`) tidak lagi menghasilkan email ganda-@ pada
  fallback; email otomatis dibersihkan/divalidasi (Midtrans/Xendit/Duitku/Tripay).
- **CoA Disconnect-NAK** tidak lagi dicatat sebagai error menakutkan. NAK
  (umumnya karena sesi sudah putus) diperlakukan non-fatal; sesi tetap ditandai
  berhenti. Log jauh lebih bersih.

---

## v1.2.4 — 2026-06-26

### 🛡️ Perbaikan Invoice Basi/Dobel
- Generate invoice (cron harian & manual) diperketat: **skip** bila pelanggan
  masih punya invoice `unpaid`/`overdue` mana pun — mencegah invoice dobel.
- Reminder & auto-suspend kini **melewati invoice basi** (tidak menagih/menyuspend
  berdasarkan invoice yang sudah tidak relevan).
- Auto-suspend **melindungi** pelanggan yang `tgl_expired`-nya masih di masa depan.

### 🧹 UI
- Tombol **"Reminder Massal"** dan **"Generate Tagihan Otomatis"** dihapus dari
  panel (cron otomatis tetap berjalan — hanya pemicu manual yang dihapus).
- Perbaikan **mode gelap** (modal, input, select, dropdown).
- **Peringatan password ≠ username** pada form Tambah/Edit Pelanggan, dengan
  tombol "Samakan".

---

## v1.2.3 — 2026-06-26

### ✨ Reseller
- Portal reseller: profil, edit data, ganti password, freeze, self-edit, logout.
- Admin: edit reseller dengan konfirmasi 2 langkah.
- Kartu **Topup Sukses** pada panel admin.
- Auto-migrasi kolom `reseller.alamat`.

### 🐞 Perbaikan
- ACS refresh timeout.
- Anti-duplikat transaksi webhook.
- Konfirmasi pembayaran WhatsApp dengan self-heal.
