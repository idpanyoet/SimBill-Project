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
