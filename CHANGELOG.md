## v1.12.1 — 12 Juli 2026

> ⚠️ **Rilis ini mengandung perbaikan KEAMANAN dan beberapa perubahan perilaku.**
> Baca bagian "Yang berubah setelah update" sebelum bertanya ke support.

### 🔒 Keamanan (penting — disarankan segera update)

- **Kredensial tidak lagi bocor lewat `GET /api/setting`.** Sebelumnya token & kunci
  rahasia dikirim **plaintext** ke siapa pun yang login — termasuk role `operator`
  dan `teknisi`. Yang terdampak: `wa_waha_token`, `wa_cmd_secret`, `tg_bot_token`,
  `tg_webhook_secret`, `acslite_api_key`, `genieacs_password`, `license_key`, dan
  seluruh kunci payment gateway per-provider (`pg_server_key_midtrans`,
  `pg_secret_key_xendit`, `pg_api_key_duitku`, `pg_private_key_tripay`, dll).
  Kini semuanya ditampilkan sebagai `••••••`. Deteksi berbasis pola, jadi kunci
  rahasia baru otomatis ikut terlindungi.
- **`wa_cmd_secret` tidak lagi terekspos lewat `/api/whatsapp/cmd-config`.** URL
  webhook bot WA memuat token itu di query string, dan endpointnya dulu hanya
  butuh login biasa. Sekarang URL lengkap hanya untuk admin/superadmin.
- **`github_token`, `license_key`, `license_server_url` hanya bisa diubah
  superadmin.**
- **Login admin kini dikunci setelah 8x gagal** (15 menit), dihitung per-akun DAN
  per-IP. Sebelumnya hanya ada rate-limit per-IP, sehingga brute-force dari banyak
  IP tak terbendung. Percobaan gagal kini tercatat di Log Aktivitas
  (`LOGIN_GAGAL`).
- **Portal pelanggan: `login-sandi` dikunci setelah 6x gagal** (15 menit) + limiter
  per-IP. Endpoint ini sebelumnya **tidak punya rate-limit sama sekali**, padahal
  ID pelanggan berurutan dan sandi default = nomor HP → rawan diambil alih.
- **Anti-clickjacking**: `Content-Security-Policy: frame-ancestors 'self'`.
- **CORS**: isi `FRONTEND_URL` di `backend/.env` untuk membatasi origin. Bila
  dikosongkan, perilaku lama (terbuka) dipertahankan agar instalasi lama tidak
  rusak — tapi muncul peringatan di log.

### ✨ Fitur baru

- **Perpanjang lisensi berbayar langsung dari panel.** Halaman Lisensi kini
  menampilkan pilihan durasi (1 Bulan / 3 Bulan / 6 Bulan / 1 Tahun) beserta
  harganya, dengan tombol **"Bayar & Perpanjang"** → halaman pembayaran terbuka
  → panel memantau statusnya sendiri → begitu lunas, tanggal expired langsung
  diperbarui.
  - Harga **tidak di-hardcode**: selalu ditarik dari license server, sumber yang
    sama dengan portal. Jadi harga di panel mustahil berbeda dari portal, dan
    perubahan harga tidak memerlukan update SimBill.
  - Mendukung provider yang aktif di license server (Duitku / DOKU / Midtrans).
  - Hanya admin/superadmin yang bisa membeli.
  - Tombol lama "Perpanjang Sekarang" (perpanjangan gratis pada window H-7)
    tetap ada dan tidak berubah.

  ⚠️ **Butuh license server versi terbaru.** Kalau license server belum
  diperbarui, panel hanya menyembunyikan kartu paket — tidak error, tapi fitur
  belum muncul.

- **Ubah Tanggal Expired Massal.** Pilih pelanggan lewat checkbox → tombol
  **"Ubah Expired"**. Tiga mode: Perpanjang (+hari), Kurangi (−hari), Tetapkan
  tanggal pasti.
  - Wajib **Pratinjau** dulu — server menghitung dampaknya tanpa menulis apa pun,
    lalu memperingatkan bila ada pelanggan yang akan jadi kadaluwarsa (cron
    auto-suspend berjalan tiap jam, jadi salah tanggal = pelanggan terisolir).
  - **Pelanggan VIP** (`tgl_expired` NULL) dilewati di mode Perpanjang/Kurangi
    agar status VIP-nya tidak tercabut diam-diam.
  - Maksimal 500 pelanggan sekali jalan. Admin+ saja. Tercatat di Log Aktivitas.
- **Kolom "Bergabung"** di tabel pelanggan (dari `created_at`).
- **Tanggal Bergabung bisa diedit** di modal Edit Pelanggan — berguna untuk
  pelanggan hasil migrasi/import yang `created_at`-nya = tanggal import. Admin+
  saja, tidak boleh masa depan, jam asli dipertahankan, dan tercatat di Log
  Aktivitas (`PELANGGAN_UBAH_TGL_BERGABUNG`).

### 🐛 Perbaikan

- Modal "Ubah Expired" sempat muncul di bawah tabel, bukan melayang di atasnya
  (salah posisi di DOM).

### ⚠️ Yang berubah setelah update — TIDAK RUSAK, ini disengaja

1. **Field API key WAHA (dan semua field rahasia) akan tampak KOSONG** dengan
   placeholder `•••••• tersimpan`. **Token Anda TIDAK hilang** — hanya tidak lagi
   dikirim ke browser. Menyimpan pengaturan tanpa mengisi ulang field itu **tidak
   akan menghapus** token yang tersimpan. Untuk menyalin API key WAHA, tombol
   "Salin API Key" tetap berfungsi (khusus admin).
2. **Role `operator`/`teknisi` tidak lagi bisa melihat token/secret** di halaman
   Pengaturan, dan tidak bisa memakai Ubah Expired Massal maupun mengubah Tanggal
   Bergabung.
3. Muncul peringatan di log bila `FRONTEND_URL` belum diisi. Ini **peringatan**,
   bukan error — sistem tetap berjalan normal.

### 📦 Catatan teknis

- Tidak ada migrasi database. Tidak ada dependensi baru (`npm install` tidak wajib).
- Aktivasi lisensi tetap berjalan normal (lewat `/api/license/activate`), tidak
  terpengaruh pembatasan superadmin.


## v1.12.0 — 11 Juli 2026

### ✨ Fitur baru
- **Integrasi API MikroTik.** SimBill kini bisa membaca sesi PPP **langsung dari router** (`/ppp active`) lewat RouterOS API. Tambahkan router di **Pengaturan Sistem → Router MikroTik**: nama, IP, port 8728, user & password API (password disimpan terenkripsi). Ada tombol tes koneksi.
- **Deteksi "Pelanggan Nyangkut".** Profile PPPoE hanya berubah saat *reconnect*, sehingga sesi lama bisa tak sesuai status billing. SimBill kini mendeteksi dan memutusnya sekali klik:
  - **Sudah bayar tapi sesinya masih IP isolir** → pelanggan tak bisa internet padahal sudah lunas.
  - **Sudah suspended tapi sesinya masih profile normal** → pelanggan masih bisa internet.
  Karena datanya dibaca dari router (bukan dari tabel akunting), sesi yang tak tercatat pun tetap ketahuan.

### 🐞 Perbaikan penting
- **Pelanggan yang sudah bayar tak lagi tersangkut di profile isolir.** Bila sesi PPPoE tidak tercatat di `radacct` (mis. akunting sempat terputus atau server berpindah), SimBill dulu melewati perintah putus sesi — akibatnya pelanggan yang sudah melunasi tagihan tetap memakai IP isolir. Kini SimBill mengirim Disconnect-Request ke seluruh NAS terdaftar sebagai cadangan, sehingga sesi lama tetap diputus dan pelanggan langsung reconnect ke profile normal.

### 🔧 Catatan teknis
- Dependensi baru: `node-routeros` (dipasang otomatis saat update).
- Tabel `router` dibuat otomatis saat aplikasi start (migrasi bawaan).
- **Keamanan:** jangan ekspos port API MikroTik (8728) ke internet — batasi ke jaringan internal/VPN, dan gunakan user MikroTik khusus berhak terbatas.
