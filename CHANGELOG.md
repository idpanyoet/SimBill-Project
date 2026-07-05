## v1.5.10 — 6 Juli 2026

### 🐛 Perbaikan
- Auto-setup ACS Lite kini jalan di server yang MariaDB root-nya berpassword / DB user SimBill terbatas: memakai kredensial SimBill, dan bila tak berhak buat database baru, GoACS memakai database SimBill yang ada (tabel devices & tasks) setelah cek anti-bentrok. Tetap tidak mengubah password root.
- Halaman ACS Lite: tampilkan pesan ramah "belum aktif" (bukan error mentah) saat service belum jalan.
## v1.5.9 — 6 Juli 2026

### ✨ Fitur
- Integrasi ACS Lite (GoACS) — server TR-069 mandiri, TERPISAH dari GenieACS (tetap jalan). Menu Jaringan > ACS Lite: daftar ONU + auto-match pelanggan (PPPoE), RX power, status online (inform ≤30 mnt), ganti nama/sandi WiFi, refresh, reboot, restart service. API Key otomatis dari /opt/acs/.env.
- Portal pelanggan: deteksi router lintas ACS (GenieACS + ACS Lite otomatis, pilih yang teraktif); ganti password WiFi lewat ACS yang tepat.
- Auto-setup ACS Lite saat update (opsional, best-effort): DB khusus (tidak mengubah root MariaDB), systemd, API key acak. Aktivasi manual di panel.
- Kirim ulang pesan WhatsApp dari riwayat (tombol ↺).

### 🐛 Perbaikan
- Status online/offline router (admin & portal) dihitung dari last_inform, bukan field status yang bisa basi.
- Menu ACS TR-069 dipindah berdampingan dengan ACS Lite (grup Jaringan).
## v1.5.7 — 5 Juli 2026

### ✨ Fitur
- WA Gateway Mandiri: token diambil OTOMATIS dari gateway — pelanggan cukup pilih Mandiri → Simpan → Scan QR, tanpa perlu isi/lihat token. Field API Token disembunyikan untuk Mandiri.
- Scan QR WA Mandiri langsung dari panel (tanpa SSH tunnel) via endpoint proxy aman.

### 🐛 Perbaikan
- Gateway embed di update.sh kini menyertakan endpoint /qr.json (agar scan QR dari panel jalan untuk pelanggan).
## v1.5.6 — 5 Juli 2026

### ✨ Fitur
- WA Gateway Mandiri (self-hosted/Baileys) — kirim WA tanpa provider berbayar. Provider "Mandiri" di Setting > WhatsApp + tombol Scan QR langsung dari panel. Gateway ke-setup otomatis saat update (opt-in; provider aktif pelanggan tidak diubah).
- Search topbar bisa melunasi invoice Terlambat (overdue), bukan cuma Belum Bayar — dengan label status + tombol Lunasi.

### 🐛 Perbaikan
- Perbaiki gagal Tambah Pelanggan (server error): jumlah placeholder INSERT tidak cocok dengan kolom.
- Modal Checkout Voucher di HP: tombol Bayar Sekarang tidak lagi kepotong (dvh + safe-area, overlay scroll penuh).

### 💅 Tampilan
- Menu Sistem dikelompokkan jadi grup Jaringan (RADIUS/NAS, OLT, Peta Jaringan, Kelola ODC/ODP, Isolir); Sesi Aktif jadi menu biasa.
- Header publik di HP: menu hamburger, nama brand tidak wrap.
- Logo metode pembayaran jadi kotak kecil + grid 2 kolom di HP.
- Label "Ports" → "ID SNMP" di form Edit NAS.
## v1.5.6 — 5 Juli 2026

### ✨ Fitur
- WA Gateway Mandiri (self-hosted/Baileys) — kirim WA tanpa provider berbayar. Provider "Mandiri" di Setting > WhatsApp + tombol Scan QR langsung dari panel. Gateway ke-setup otomatis saat update (opt-in; provider aktif pelanggan tidak diubah).
- Search topbar bisa melunasi invoice Terlambat (overdue), bukan cuma Belum Bayar — dengan label status + tombol Lunasi.

### 🐛 Perbaikan
- Perbaiki gagal Tambah Pelanggan (server error): jumlah placeholder INSERT tidak cocok dengan kolom.
- Modal Checkout Voucher di HP: tombol Bayar Sekarang tidak lagi kepotong (dvh + safe-area, overlay scroll penuh).

### 💅 Tampilan
- Menu Sistem dikelompokkan jadi grup Jaringan (RADIUS/NAS, OLT, Peta Jaringan, Kelola ODC/ODP, Isolir); Sesi Aktif jadi menu biasa.
- Header publik di HP: menu hamburger, nama brand tidak wrap.
- Logo metode pembayaran jadi kotak kecil + grid 2 kolom di HP.
- Label "Ports" → "ID SNMP" di form Edit NAS.
## v1.5.6 — 5 Juli 2026

### ✨ Fitur
- Search topbar kini bisa **melunasi invoice Terlambat**, bukan cuma "Belum Bayar". Ketik nama pelanggan → invoice belum lunas (Terlambat + Belum Bayar) muncul dengan label status + tombol ✓ Lunasi.

### 🐛 Perbaikan
- Modal Checkout Voucher di HP: tombol "Bayar Sekarang" tidak lagi kepotong (pakai `dvh` + safe-area, overlay bisa di-scroll penuh).

### 💅 Tampilan
- Menu **Sistem** dikelompokkan jadi grup collapsible **Jaringan** (RADIUS/NAS, OLT, Peta Jaringan, Kelola ODC/ODP, Isolir); Sesi Aktif jadi menu biasa di atasnya.
- Header halaman publik di HP: link dilipat ke menu hamburger, nama brand tidak wrap (auto-ellipsis).
- Logo metode pembayaran jadi kotak kecil seragam + grid 2 kolom di HP.
- Label "Ports" → "ID SNMP" di form Edit NAS.
## v1.5.6 — 5 Juli 2026

### ✨ Fitur
- Search topbar kini bisa **melunasi invoice Terlambat**, bukan cuma "Belum Bayar". Ketik nama pelanggan → invoice belum lunas (Terlambat + Belum Bayar) muncul dengan label status + tombol ✓ Lunasi.

### 🐛 Perbaikan
- Modal Checkout Voucher di HP: tombol "Bayar Sekarang" tidak lagi kepotong (pakai `dvh` + safe-area, overlay bisa di-scroll penuh).

### 💅 Tampilan
- Menu **Sistem** dikelompokkan jadi grup collapsible **Jaringan** (RADIUS/NAS, OLT, Peta Jaringan, Kelola ODC/ODP, Isolir); Sesi Aktif jadi menu biasa di atasnya.
- Header halaman publik di HP: link dilipat ke menu hamburger, nama brand tidak wrap (auto-ellipsis).
- Logo metode pembayaran jadi kotak kecil seragam + grid 2 kolom di HP.
- Label "Ports" → "ID SNMP" di form Edit NAS.
## v1.5.6 — 5 Juli 2026

### ✨ Fitur
- Search topbar kini bisa **melunasi invoice Terlambat**, bukan cuma "Belum Bayar". Ketik nama pelanggan → invoice belum lunas (Terlambat + Belum Bayar) muncul dengan label status + tombol ✓ Lunasi.

### 🐛 Perbaikan
- Modal Checkout Voucher di HP: tombol "Bayar Sekarang" tidak lagi kepotong (pakai dvh + safe-area, overlay bisa di-scroll penuh).

### 💅 Tampilan
- Menu Sistem dikelompokkan jadi grup collapsible Jaringan (RADIUS/NAS, OLT, Peta Jaringan, Kelola ODC/ODP, Isolir); Sesi Aktif jadi menu biasa di atasnya.
- Header halaman publik di HP: link dilipat ke menu hamburger, nama brand tidak wrap (auto-ellipsis).
- Logo metode pembayaran jadi kotak kecil seragam + grid 2 kolom di HP.
- Label "Ports" → "ID SNMP" di form Edit NAS.
## v1.5.5 — 2026-07-04

### ✨ Fitur
- **Tema Warna (Skin)**: tombol palet di topbar untuk ganti warna aksen — Oranye (default), Ocean, Forest, Violet, Rose, Teal, Slate. Pilihan tersimpan otomatis, berlaku di seluruh halaman & mode malam.

### 💅 Tampilan
- **Mode malam** dipoles ke palet biru-gelap yang lebih dalam & nyaman di mata.
- **Perbaikan mobile**: halaman Voucher (kolom penting muat tanpa scroll, tombol batch rapi), Sesi Aktif & Manajemen OLT (toolbar tidak lagi terpotong/menumpuk), plus perapian umum tombol header di layar kecil.
## v1.5.4 — 2026-07-04

### ✨ Fitur
- **Periode Tagihan per pelanggan**: pilih **Tetap** (sesuai tgl pemasangan) atau **Kalender** (siklus per bulan). Mode kalender: tanggal invoice & tanggal isolir diatur di Setting.
- **Peta Jaringan — garis otomatis**: garis pelanggan→ODP dan ODP→ODC ditarik otomatis dari data, **bergerak** (animasi arah aliran). Muncul langsung saat data ODP diisi.
- **Sesuaikan garis ikut jalan**: garis drop (ke pelanggan) & garis ODP→ODC bisa diedit menambah titik belok mengikuti jalan, tersimpan permanen.
- **Alamat auto-isi dari koordinat**: pindah ke tab Lokasi & Jaringan, terisi otomatis dari titik peta/GPS (reverse-geocode).

### 🐛 Perbaikan
- **Login/logout lebih stabil**: request "basi" tak lagi menendang sesi baru, poller SNMP berhenti saat logout, ganti akun admin↔reseller bersih tanpa perlu refresh.

### 💅 Tampilan
- Form Tambah/Edit pelanggan diringkas: Siklus & Periode jadi dropdown, Reseller & Tanggal Expired dipindah ke tab Lokasi.
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
