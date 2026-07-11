## v1.11.0 — 11 Juli 2026

### ✨ Fitur
- **Backup Otomatis Terjadwal** (halaman Backup & Restore). Jadwalkan backup **harian / mingguan / bulanan** pada jam pilihan — diatur dari panel, tanpa SSH, tanpa restart.
  - Arsip `.tar.gz` berisi: dump database + **konfigurasi FreeRADIUS** (`/etc/freeradius/3.0`) + INFO/cara restore.
  - **Rotasi otomatis**: simpan N backup terakhir, sisanya dihapus (disk aman).
  - **Unduh / hapus** backup langsung dari panel.
  - **Unggah ke cloud** opsional via rclone (mis. Google Drive).
  - Tombol **Backup Sekarang** untuk backup manual.
## v1.10.2 — 11 Juli 2026

### 🐞 Perbaikan
- **Cek update tak lagi butuh `github_token`.** Panel & `update.sh` kini membaca file `VERSION` mentah dari repo publik (tanpa GitHub API, tanpa rate-limit). Menghilangkan pesan "GitHub menolak (token salah/kadaluarsa atau rate limit)" dan "Versi Terbaru: —".
## v1.10.0 — 10 Juli 2026

Rilis besar: halaman WhatsApp Gateway didesain ulang + provider WAHA (self-hosted, anti-ban via WEBJS).

### ✨ Fitur
- **Redesign halaman WhatsApp Gateway** — layout grid berpasangan; Provider full-width; kartu Bot Perintah, Template, Kirim Pesan (Test+Broadcast digabung via toggle), Statistik (data asli: reminder/suspend/konfirmasi/broadcast/otp + tile terkirim/gagal/rate), dan Riwayat.
- **Provider WAHA** (WhatsApp HTTP API, Docker) — kirim via `POST /api/sendText`; endpoint proxy `/waha/status`, `/waha/qr`, `/waha/start`, `/waha/restart`; modal Scan QR + tombol Reset sesi (pulih dari FAILED/setelah reboot); default port 127.0.0.1:3100.
- **API Key WAHA otomatis** — setting terpisah `wa_waha_token` (tak menabrak token Fonnte); `setup-waha.sh` generate key sekali, suntik ke container, tulis ke DB → panel terisi otomatis (pelanggan tak perlu SSH).
- **Webhook Masuk WAHA** — URL webhook (`/webhook/wa/waha?token=…`) ditampilkan di panel + tombol Copy; dibentuk dinamis dari `app_url`+`wa_cmd_secret` (nol hardcode domain).
- **Broadcast** — kotak pesan kustom aktif.

### 🔧 Perbaikan
- **Default ACS URL** diganti dari domain spesifik → `http://127.0.0.1:7547` (tak bocorkan domain ke instalasi pelanggan lain).

### 🛠️ Deploy
- `update.sh` +`setup_waha()` (OPT-IN, non-fatal; tak install Docker / tak tarik image otomatis).
- `setup-waha.sh` baru — provisioning WAHA sekali jalan (Docker + container 127.0.0.1:3100 + webhook auto + API key auto ke DB).

## v1.9.0 — 10 Juli 2026

Rilis fitur: jam otomasi bisa diatur, peta ODP satelit, dan role reseller di bot WA.

### ✨ Fitur
- **Jam reminder & auto-suspend bisa diatur dari Setting** (tanpa restart).
  Field baru "Waktu kirim reminder invoice" (reminder_jam, default 08:00) &
  "Waktu suspend harian" (suspend_jam, default 09:00) di Setting > Konfigurasi
  Billing. cron.js kini men-tick per menit + gerbang jam; nilai kosong/invalid
  pakai default (perilaku lama).
- **Peta ODP/ODC: opsi Satelit.** Switcher "Jalan / Satelit" (Esri World Imagery
  + label jalan) di modal Tambah/Edit ODP & ODC. Default tetap Jalan.
- **Role RESELLER di Bot Perintah WhatsApp.** Nomor WA reseller (aktif) bisa
  cek redaman/pelanggan/pengguna wifi, ganti SSID/sandi WiFi, reboot, buat tiket
  — TAPI hanya untuk pelanggan miliknya (pelanggan.reseller_id). Target pelanggan
  reseller lain ditolak. Gerbang: setting wa_cmd_reseller (default mati), diatur
  via centang "Izinkan reseller pakai bot" di panel. Prioritas admin > reseller
  > pelanggan.

### 🏷️ Lain-lain
- package.json diselaraskan ke 1.9.0 (pm2 menampilkan versi benar).

File: backend/services/cron.js, backend/routes/wa-command.js,
backend/routes/whatsapp.js, frontend/admin.html, backend/package.json, package.json.
## v1.8.0 — 9 Juli 2026

Rilis keamanan & integritas: menutup celah pemalsuan callback payment gateway,
membuat pelunasan invoice benar-benar exactly-once, memperbaiki masa aktif
prorata yang dibayar via gateway, dan hardening skema database.

### 🔒 Keamanan (KRITIS)
- **Webhook payment gateway tak bisa lagi dipalsukan.** Endpoint `/webhook/duitku`
  dan `/webhook/midtrans` kini *fail-closed*: menolak callback bila kredensial
  provider kosong (mis. provider aktif bukan Duitku/Midtrans), plus perbandingan
  signature konstan-waktu (timing-safe) dan pencocokan merchantCode untuk Duitku.
  Sebelumnya, saat secret kosong, signature bisa dihitung dari data yang seluruhnya
  ada di body request — memungkinkan pelunasan invoice / penambahan saldo reseller
  secara gratis. Kini setara dengan Xendit/Tripay yang sudah aman.

### 🧾 Billing (TINGGI)
- **Pelunasan invoice exactly-once.** Transisi status → `paid` (di webhook dan
  di "bayar tunai") kini memakai UPDATE ber-kondisi `WHERE status<>'paid'` + cek
  `affectedRows`. Mencegah dobel-proses saat gateway retry callback atau saat
  admin klik "Sudah Bayar" bersamaan (dulu bisa: WA & log dobel, masa aktif
  ter-extend 2×).
- **Prorata via gateway.** Invoice prorata pertama (prepaid + Fixed Date) yang
  dibayar lewat payment link kini dipatok ke tanggal jatuh tempo (Fixed Date),
  bukan di-extend sesiklus penuh. Menyamakan perilaku dengan pembayaran tunai.

### 🗄️ Database (hardening — divalidasi di MariaDB 10.11)
- **`radacct.nasportid` VARCHAR(15) → VARCHAR(64).** Memperbaiki kegagalan INSERT
  accounting saat NAS-Port-Id dari OLT/MikroTik > 15 karakter (sesi tak tercatat).
- **Integritas referensial** untuk `tiket`, `tiket_reply`, `acs_device`, `acs_task`:
  tipe id diselaraskan ke `INT UNSIGNED` + FOREIGN KEY (CASCADE / SET NULL) →
  tak ada lagi baris yatim saat pelanggan/tiket/device dihapus.
- **Index komposit** `pelanggan(status, tgl_expired)` & `invoice(pelanggan_id, status)`
  untuk mempercepat cron isolir dan query portal.
- Migrasi DB idempoten disertakan: `database/migration_db_hardening.sql`.

## v1.6.0 — 7 Juli 2026

Rilis besar: bot WhatsApp interaktif, manajemen tiket & hak akses, peta jaringan
live, portal pelanggan dua metode, dan modul keuangan.

### ✨ Fitur Baru

**Bot Perintah WhatsApp**
- Layani perintah lewat WhatsApp (mirip bot Telegram), semua perintah berawalan `/`.
- Admin/Teknisi: `/cekredaman`, `/cekpelanggan`, `/cekpenggunawifi`, `/gantissid`, `/gantisandi`, `/reboot`, `/tiket`.
- Pelanggan (layanan mandiri): `/cekredaman`, `/cekpenggunawifi`, `/status`, `/reboot`, `/tiket`, serta ubah nama & sandi WiFi sendiri (opsional, bisa dimatikan).
- Panel konfigurasi di halaman WhatsApp Gateway: aktifkan bot, daftar nomor admin, **Generate Token** & **URL webhook siap-salin**.
- Arsitektur multi-provider (Fonnte aktif; provider lain menyusul tanpa ubah logika).
- Pesan non-perintah (mis. bukti transfer) diabaikan agar tidak membalas menu.

**Manajemen Tiket**
- Tombol **Buat Tiket Gangguan** untuk admin/operator: pilih pelanggan, jenis gangguan, prioritas, keterangan.
- Panel **Info Koneksi** otomatis: PPPoE, IP, MAC, status ONU (Online/Offline) — sinkron dari GenieACS, ACS Lite, dan sesi RADIUS.

**Peta Jaringan Live (sinkron ACS)**
- Marker pelanggan berwarna sesuai status ONU: hijau Online, oranye Loss (redaman tinggi), merah Offline.
- Popup menampilkan RX Power, IP, waktu inform terakhir, serta status billing (Aktif/Suspend/Nonaktif).
- Sinkron otomatis dari GenieACS + ACS Lite, dengan pembaruan berkala.

**Hak Akses (RBAC)**
- Tab **Hak Akses** pada pengelolaan pengguna: preset (Admin, Manager, Finance, Support, Teknisi, Monitor) + izin granular per kategori fitur.
- Izin tersimpan per pengguna. Super Admin & Admin memiliki akses penuh.

**Portal Pelanggan — Dua Metode Login**
- Pilihan metode di Pengaturan: **OTP WhatsApp** atau **ID Pelanggan + Sandi**.

**Keuangan**
- Laporan Pelanggan & Voucher, Kalkulator BHP/USO, dan grup menu Keuangan.
- Pencatatan Pengeluaran (kategori, metode bayar, **upload bukti transaksi**), lengkap dengan ekspor.

**Lainnya**
- Reset Database terkontrol dengan mode uji-coba (dry-run) & pratinjau.
- Tambah foto depan rumah saat pendaftaran pelanggan.

### 🐛 Perbaikan
- Perbaikan penting gateway WhatsApp: token yang tersimpan bisa tertimpa nilai bertopeng sehingga pengiriman gagal diam-diam. Kini kegagalan Fonnte terdeteksi jujur dan field token tidak lagi tertimpa saat menyimpan.
- Balasan bot dikirim seketika (tidak lewat antrean).

### 🔒 Keamanan
- Webhook bot dilindungi token rahasia. Perubahan WiFi via WhatsApp hanya untuk perangkat pelanggan sendiri, dengan validasi & pencatatan aktivitas.
- Middleware hak akses (`requirePermission`) disiapkan untuk penegakan izin per endpoint.
## v1.5.13 — 6 Juli 2026

### 🐛 Perbaikan
- Fix peta jaringan gagal muat (error server) di instalasi yang belum pernah tambah/edit pelanggan setelah update: endpoint /api/pelanggan/peta kini auto-migrasi kolom jarak_kabel sebelum query.

### ✨ Fitur
- Menu OLT diberi label "OLT C300/C320".
- Halaman ACS Lite: tambah panel Tutorial / Cara Pakai (collapsible) berisi contoh URL ACS untuk skenario VPN, IP publik VPS, dan VPS/server lokal.
## v1.5.12 — 6 Juli 2026

### 🐛 Perbaikan
- Fix voucher dobel saat callback pembayaran gateway masuk ganda / di-"Resend Callback": pembuatan voucher kini pakai klaim atomik (row-level lock) sehingga 1 pembayaran = 1 voucher, tahan race condition. Bila pembuatan gagal, klaim dilepas agar bisa dicoba ulang.
## v1.5.12 — 6 Juli 2026

### 🐛 Perbaikan
- Fix voucher dobel saat callback pembayaran gateway masuk ganda / di-"Resend Callback": pembuatan voucher kini pakai klaim atomik (row-level lock) sehingga 1 pembayaran = 1 voucher, tahan race condition. Bila pembuatan gagal, klaim dilepas agar bisa dicoba ulang.
## v1.5.11 — 6 Juli 2026

### ✨ Fitur
- Cetak voucher: modal pilih template + atur jumlah voucher per lembar (1–100), pisah halaman otomatis (grid template dipertahankan).
- Generate voucher: batas maksimal dinaikkan 500 → 2000.
- Jarak kabel pelanggan: field baru (m) di form tambah/edit, bisa diukur otomatis (garis lurus) dari koordinat pelanggan ke ODP/ODC di peta jaringan; tampil di notif Telegram pendaftaran.
- Panduan isolir MikroTik: IP server terdeteksi otomatis (endpoint /api/server-ip) — tidak lagi hardcode IP lama saat pindah VPS.
- Daftar pelanggan di HP tampil sebagai kartu (mobile-friendly).
- Bot Telegram /cekpelanggan & /redaman: cari ONU di GenieACS + ACS Lite (gabungan), pilih yang paling baru inform.
- Notif Telegram "Tiket Ditugaskan": tambah nama & alamat pelanggan yang membuka tiket.

### 🐛 Perbaikan
- Notifikasi Telegram pelanggan baru tidak lagi dobel (hanya "Pendaftaran Pelanggan Baru" yang lengkap).
- Device probe/dummy GoACS (serial nol / 'probe') disembunyikan dari daftar ONU ACS Lite.
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
