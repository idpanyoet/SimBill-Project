# 📡 Billing RADIUS PPPoE/Hotspot
## Dokumentasi Lengkap: Instalasi, API, & Konfigurasi

---

## 🗂️ Struktur Proyek

```
billing-radius/
├── database/
│   └── schema.sql              ← Skema database + seed data
├── backend/
│   ├── server.js               ← Entry point utama
│   ├── package.json
│   ├── .env.example            ← Template konfigurasi
│   ├── config/
│   │   └── db.js               ← Koneksi database
│   ├── middleware/
│   │   └── auth.js             ← JWT authentication
│   ├── routes/
│   │   ├── auth.js             ← Login admin
│   │   ├── pelanggan.js        ← CRUD pelanggan + RADIUS sync
│   │   ├── paket.js            ← Manajemen paket internet
│   │   ├── invoice.js          ← Tagihan & pembayaran
│   │   ├── whatsapp.js         ← WA gateway & broadcast
│   │   ├── payment.js          ← Riwayat transaksi
│   │   ├── radius.js           ← NAS & sesi aktif
│   │   ├── laporan.js          ← Laporan & statistik
│   │   ├── setting.js          ← Konfigurasi sistem
│   │   └── webhook.js          ← Callback payment gateway
│   └── services/
│       ├── radius.js           ← Manajemen FreeRADIUS
│       ├── whatsapp.js         ← Multi-provider WA gateway
│       ├── payment.js          ← Multi-provider payment gateway
│       └── cron.js             ← Otomasi (reminder, suspend, invoice)
```

---

## 🚀 Instalasi

### 1. Prasyarat

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y nodejs npm mariadb-server freeradius freeradius-mysql

# CentOS/RHEL
sudo yum install -y nodejs npm mariadb-server freeradius freeradius-utils
```

Node.js minimum versi 18:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

### 2. Setup Database

```bash
# Login MariaDB
sudo mysql -u root

# Di dalam MySQL:
CREATE USER 'billing'@'localhost' IDENTIFIED BY 'password_kuat_anda';
GRANT ALL PRIVILEGES ON billing_radius.* TO 'billing'@'localhost';
FLUSH PRIVILEGES;
EXIT;

# Import schema
mysql -u billing -p billing_radius < database/schema.sql
```

### 3. Konfigurasi FreeRADIUS

```bash
# Edit file sql.conf
sudo nano /etc/freeradius/3.0/mods-available/sql

# Ubah bagian ini:
driver = "rlm_sql_mysql"
dialect = "mysql"
server = "localhost"
port = 3306
login = "billing"
password = "password_kuat_anda"
radius_db = "billing_radius"
```

```bash
# Aktifkan modul SQL
sudo ln -s /etc/freeradius/3.0/mods-available/sql \
           /etc/freeradius/3.0/mods-enabled/sql

# Test konfigurasi
sudo freeradius -X

# Start service
sudo systemctl enable freeradius
sudo systemctl start freeradius
```

### 4. Konfigurasi MikroTik PPPoE

Di Winbox/Terminal MikroTik:
```
# PPPoE Server
/interface pppoe-server server add \
  service-name=pppoe-billing \
  interface=ether1 \
  authentication=mschap2

# RADIUS client
/radius add \
  address=IP_SERVER_BILLING \
  secret=testing123 \
  service=ppp,hotspot \
  timeout=5000ms

# Aktifkan RADIUS untuk PPPoE
/ppp aaa set use-radius=yes accounting=yes
```

### 5. Install Backend

```bash
cd backend
npm install

# Copy dan isi konfigurasi
cp .env.example .env
nano .env

# Buat password admin pertama
node -e "
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
async function main() {
  const hash = await bcrypt.hash('Admin@123', 12);
  const db = await mysql.createConnection({
    host: 'localhost', database: 'billing_radius',
    user: 'billing', password: 'password_kuat_anda'
  });
  await db.execute('UPDATE admin SET password=? WHERE email=?',
    [hash, 'admin@billing.id']);
  console.log('Password admin diset: Admin@123');
  db.end();
}
main();
"

# Jalankan server
npm start

# Atau development dengan auto-reload:
npm run dev
```

### 6. Setup PM2 (Production)

```bash
npm install -g pm2

# Start aplikasi
pm2 start server.js --name billing-radius

# Auto start saat reboot
pm2 startup
pm2 save

# Monitor
pm2 status
pm2 logs billing-radius
```

### 7. Nginx Reverse Proxy (opsional)

```nginx
server {
    listen 80;
    server_name billing.anda.id;

    location /api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /webhook/ {
        proxy_pass http://localhost:3000/webhook/;
        proxy_set_header Host $host;
    }

    # Frontend (jika ada)
    location / {
        root /var/www/billing-frontend/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

---

## 🔑 Konfigurasi WhatsApp Gateway

Sejak versi terbaru, konfigurasi WhatsApp Gateway **disimpan di database** dan diatur langsung dari dashboard admin (menu **WhatsApp**), bukan lagi lewat file `.env`. File `.env` masih dipakai untuk hal lain (DB, JWT, dll) tapi tidak lagi untuk WA.

Ada dua mode yang bisa dipilih admin di dashboard:

### Mode 1: Scan Barcode (gratis, pakai nomor WA sendiri)
Cocok untuk skala kecil-menengah. Tidak perlu daftar provider apapun.

1. Buka menu **WhatsApp** di dashboard, pilih radio button "Scan Barcode (WhatsApp Web)".
2. Klik **Mulai / Sambungkan** — QR code akan muncul di layar.
3. Buka WhatsApp di HP yang ingin dipakai sebagai pengirim → Setelan → Perangkat Tertaut → Tautkan Perangkat → scan QR tersebut.
4. Setelah terhubung, status akan berubah jadi "Tersambung" dan nomor WA akan tampil.

Sesi disimpan di folder `backend/wa-session/` di server, jadi tidak perlu scan ulang setiap restart server (selama folder ini tidak dihapus). Mode ini butuh Chromium terinstall di VPS karena berjalan dengan mengotomasi WhatsApp Web asli via Puppeteer — lihat bagian **Instalasi Dependency Mode QR** di bawah.

Klik **Logout & Putuskan** untuk memutus sesi secara permanen (perlu scan ulang).

### Mode 2: Provider API (berbayar, lebih stabil untuk skala besar)
Pilih radio button "Provider API", isi form, klik **Simpan Konfigurasi**.

**Fonnte** (rekomendasi — murah & mudah):
1. Daftar di https://fonnte.com, hubungkan nomor WA Anda di sana (scan QR di sisi Fonnte, bukan di dashboard ini).
2. Pilih Provider = Fonnte, isi API Token dari Fonnte, isi Nomor Pengirim.

**Wablas**: Daftar di https://wablas.com, hubungkan nomor WA, pilih Provider = Wablas, isi token.

**WhatsApp Business API (Meta — Enterprise)**: Buat akun di https://developers.facebook.com, setup WhatsApp Business App, pilih Provider = WA Business API, isi Access Token dan Phone Number ID.

### Instalasi Dependency Mode QR (hanya jika memakai Mode 1)
Mode QR menambah dependency `whatsapp-web.js` dan `qrcode` yang butuh Chromium. Setelah upload kode terbaru:

```bash
cd backend
npm install
```

Jika VPS memakai Ubuntu/Debian dan Puppeteer gagal menemukan Chromium saat klik "Mulai/Sambungkan", install dependency sistem yang dibutuhkan Chromium headless:

```bash
sudo apt-get update
sudo apt-get install -y chromium-browser \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2
```

Kalau setelah ini masih muncul error terkait Puppeteer/Chromium, kirim pesan error lengkapnya supaya bisa disesuaikan lebih lanjut (path Chromium kadang berbeda antar distro).

Server tetap bisa berjalan normal dengan Mode Provider API meskipun dependency ini belum terinstall — server tidak akan crash, hanya Mode QR yang tidak akan berfungsi sampai dependency-nya lengkap.

---

## 💳 Konfigurasi Payment Gateway

### Midtrans (Rekomendasi)
1. Daftar di https://midtrans.com
2. Dashboard → Settings → Access Keys
3. Set di `.env`:
   ```
   PG_PROVIDER=midtrans
   MIDTRANS_SERVER_KEY=SB-Mid-server-xxxx
   MIDTRANS_CLIENT_KEY=SB-Mid-client-xxxx
   PG_SANDBOX=true   # false untuk production
   ```
4. Set Webhook URL di Midtrans Dashboard:
   `https://billing.anda.id/webhook/midtrans`

### Xendit
1. Daftar di https://xendit.co
2. Settings → API Keys
3. Set di `.env`:
   ```
   PG_PROVIDER=xendit
   XENDIT_SECRET_KEY=xnd_production_xxxx
   XENDIT_WEBHOOK_TOKEN=token_webhook
   ```
4. Webhook: `https://billing.anda.id/webhook/xendit`

---

## 📋 Referensi API

Base URL: `http://localhost:3000/api`

Semua endpoint (kecuali `/auth/login` dan `/webhook`) membutuhkan header:
```
Authorization: Bearer <JWT_TOKEN>
```

---

### 🔐 Authentication

#### POST `/auth/login`
```json
// Request
{ "email": "admin@billing.id", "password": "Admin@123" }

// Response
{
  "token": "eyJhbGci...",
  "admin": { "id": 1, "nama": "Super Admin", "role": "superadmin" }
}
```

---

### 👥 Pelanggan

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET    | `/pelanggan` | Daftar pelanggan (filter: status, tipe, cari) |
| GET    | `/pelanggan/:id` | Detail pelanggan |
| POST   | `/pelanggan` | Tambah pelanggan + sync RADIUS otomatis |
| PUT    | `/pelanggan/:id` | Edit data pelanggan |
| POST   | `/pelanggan/:id/suspend` | Suspend + putus koneksi + kirim WA |
| POST   | `/pelanggan/:id/aktifkan` | Aktifkan kembali |
| GET    | `/pelanggan/:id/sesi` | Sesi RADIUS aktif |
| DELETE | `/pelanggan/:id` | Hapus pelanggan |

**POST /pelanggan — Tambah pelanggan:**
```json
{
  "nama": "Budi Santoso",
  "username": "budi.santoso",
  "password": "password123",
  "no_hp": "6281234567890",
  "email": "budi@email.com",
  "alamat": "Jl. Merdeka No. 1",
  "paket_id": 2,
  "tipe_koneksi": "pppoe",
  "ip_tetap": null
}
```

---

### 📦 Paket Internet

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET    | `/paket` | Semua paket + jumlah pelanggan |
| POST   | `/paket` | Tambah paket + sync RADIUS group |
| PUT    | `/paket/:id` | Edit paket |
| DELETE | `/paket/:id` | Hapus paket (gagal jika masih ada pelanggan) |

**POST /paket:**
```json
{
  "nama": "Paket Fiber 100Mbps",
  "kecepatan_up": 100,
  "kecepatan_dn": 100,
  "harga": 500000,
  "masa_aktif": 30,
  "pool_name": "pool-100mbps",
  "tipe": "pppoe"
}
```

---

### 🧾 Invoice

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET    | `/invoice` | Daftar invoice (filter: status, tanggal) |
| POST   | `/invoice` | Buat invoice manual |
| POST   | `/invoice/generate-bulanan` | Generate tagihan semua pelanggan aktif |
| POST   | `/invoice/:id/bayar-tunai` | Konfirmasi bayar manual |
| POST   | `/invoice/:id/kirim-reminder` | Kirim ulang reminder WA |

---

### 📱 WhatsApp

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET    | `/whatsapp/log` | Log pengiriman WA |
| GET    | `/whatsapp/statistik` | Statistik per tipe/status |
| POST   | `/whatsapp/kirim` | Kirim pesan manual |
| POST   | `/whatsapp/broadcast` | Broadcast ke target pelanggan |

**POST /whatsapp/broadcast:**
```json
{
  "target": "unpaid",
  "pesan_template": "Halo {nama}, tagihan Anda {jumlah} jatuh tempo {tgl_jatuh_tempo}. Bayar: {link_pembayaran}"
}
```
Target: `unpaid` | `overdue` | `semua`

---

### 📡 RADIUS

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET    | `/radius/sesi-aktif` | Semua sesi online |
| POST   | `/radius/putus/:username` | Putus koneksi user |
| GET    | `/radius/nas` | Daftar NAS |
| POST   | `/radius/nas` | Tambah NAS |
| DELETE | `/radius/nas/:id` | Hapus NAS |

---

### 📊 Laporan

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET    | `/laporan/dashboard` | Ringkasan utama |
| GET    | `/laporan/pendapatan?tahun=2026` | Pendapatan per bulan |
| GET    | `/laporan/per-paket` | Statistik per paket |
| GET    | `/laporan/jatuh-tempo?hari=7` | Invoice mendekati jatuh tempo |

---

### 🌐 Webhook (Tanpa Auth)

| Method | Endpoint | Keterangan |
|--------|----------|------------|
| POST   | `/webhook/midtrans` | Callback Midtrans |
| POST   | `/webhook/xendit`   | Callback Xendit |
| POST   | `/webhook/duitku`   | Callback Duitku |
| POST   | `/webhook/tripay`   | Callback Tripay |

---

## 🏪 Fitur Reseller PPPoE/Hotspot

Sistem mendukung reseller yang bisa topup saldo lewat payment gateway, lalu membeli voucher hotspot atau membuat user PPPoE/Hotspot langsung dengan saldo tersebut (harga sudah didiskon sesuai level/komisi reseller).

### Alur kerja reseller

```
Reseller daftar di /reseller (status: nonaktif)
    ↓
Admin approve via panel admin → WA notifikasi terkirim
    ↓
Reseller login → Topup Saldo
    ↓
POST /api/reseller/topup → buat transaksi Midtrans/Xendit
    ↓
Reseller bayar via QRIS/VA
    ↓
[WEBHOOK] payment gateway → saldo otomatis bertambah
    ↓
Reseller beli voucher ATAU buat user PPPoE/Hotspot
    ↓
Saldo terpotong sesuai harga reseller (harga normal − komisi%)
    ↓
Voucher/user langsung aktif di RADIUS
```

### Endpoint reseller (publik token reseller)

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | `/api/reseller/auth/register` | Daftar reseller baru (status nonaktif, menunggu approve) |
| POST | `/api/reseller/auth/login` | Login reseller, dapat JWT token reseller |
| GET  | `/api/reseller/profil` | Profil reseller yang login |
| GET  | `/api/reseller/saldo` | Saldo + 20 mutasi terakhir |
| POST | `/api/reseller/topup` | Buat request topup, dapat `payment_url` |
| GET  | `/api/reseller/topup` | Riwayat topup |
| GET  | `/api/reseller/paket` | Daftar paket dengan harga reseller (sudah diskon) |
| POST | `/api/reseller/beli/voucher` | Beli voucher hotspot pakai saldo |
| POST | `/api/reseller/beli/user` | Buat user PPPoE/Hotspot baru pakai saldo |
| GET  | `/api/reseller/transaksi` | Riwayat transaksi reseller |

### Endpoint admin (JWT admin)

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET  | `/api/reseller/admin/list` | Semua reseller + statistik |
| GET  | `/api/reseller/admin/topup-pending` | Topup yang belum dikonfirmasi (semua reseller) |
| POST | `/api/reseller/admin/approve/:id` | Approve reseller baru daftar |
| PUT  | `/api/reseller/admin/:id` | Update komisi/level/status + koreksi saldo manual |
| POST | `/api/reseller/admin/topup-konfirmasi/:order_id` | Konfirmasi topup manual (jika webhook gagal) |
| GET  | `/api/reseller/admin/mutasi/:id` | Riwayat mutasi saldo reseller tertentu |

### Skema harga reseller

Harga yang dibayar reseller dihitung dari salah satu sumber berikut (urutan prioritas):
1. Tabel `reseller_harga` — harga khusus per reseller per paket (override manual)
2. Kolom `reseller.komisi_persen` — diskon persentase dari harga normal paket

```
harga_reseller = harga_normal × (1 − komisi_persen / 100)
```

Tiga level reseller (`silver`, `gold`, `platinum`) hanya label tampilan — komisi diatur bebas per reseller lewat panel admin, tidak terikat ke level tertentu.

### Keamanan saldo

Setiap pengurangan/penambahan saldo tercatat di `reseller_mutasi` dengan `saldo_sebelum` dan `saldo_sesudah`, sehingga riwayat saldo bisa diaudit. Fungsi `catatMutasi()` mengunci baris reseller (`FOR UPDATE`) saat baca saldo untuk mencegah race condition saat dua transaksi bersamaan.

### Akses

- Portal reseller: `http://server-anda.id/reseller`
- Kelola reseller dari admin: `http://server-anda.id/admin` → menu **Reseller**



| Waktu | Aksi |
|-------|------|
| Setiap hari 07:00 (tgl 1) | Generate invoice bulanan untuk semua pelanggan aktif |
| Setiap hari 08:00 | Kirim reminder WA ke pelanggan yang jatuh tempo H-3 |
| Setiap hari 10:00 | Kirim reminder WA terakhir H-1 |
| Setiap hari 09:00 | Auto-suspend pelanggan H+3 setelah jatuh tempo |
| Setiap Minggu 02:00 | Hapus log WA lebih dari 90 hari |

---

## 🔄 Alur Kerja Sistem

```
Tanggal 1 bulan
    ↓
[CRON] Generate invoice → buat payment link (Midtrans/Xendit)
    ↓
[WA] Kirim tagihan + link bayar ke pelanggan
    ↓
H-3 jatuh tempo → [WA] Kirim reminder
H-1 jatuh tempo → [WA] Kirim reminder terakhir
    ↓
Pelanggan bayar online
    ↓
[WEBHOOK] Callback payment gateway → verify signature
    ↓
Invoice → status: paid
Pelanggan → status: aktif, perpanjang expired
RADIUS → aktifkan user (hapus reject attribute)
WA → kirim konfirmasi pembayaran
    ↓
H+3 belum bayar
    ↓
[CRON] Auto-suspend
RADIUS → tambah Auth-Type := Reject
WA → kirim notifikasi suspend
```

---

## 🛡️ Keamanan

- JWT token dengan expiry 8 jam
- Rate limiting pada semua endpoint
- Verifikasi signature webhook dari payment gateway
- Password di-hash dengan bcrypt (cost 12)
- Helmet.js untuk HTTP security headers
- Input sanitization via parameterized query (no SQL injection)
- RADIUS password tersimpan terpisah dari hash bcrypt

---

## 📞 Troubleshooting

**RADIUS user tidak bisa konek:**
```bash
# Test autentikasi RADIUS manual
radtest username password localhost 1812 testing123

# Cek log FreeRADIUS
sudo tail -f /var/log/freeradius/radius.log
```

**WA tidak terkirim:**
- Cek token di `.env`
- Lihat `wa_log` tabel: `SELECT * FROM wa_log WHERE status='failed' ORDER BY id DESC LIMIT 10`
- Pastikan nomor format `628xxx` (tanpa +, tanpa 0 di depan)

**Payment webhook tidak masuk:**
- Pastikan URL webhook sudah di-set di dashboard payment gateway
- Cek apakah server bisa diakses publik (bukan localhost)
- Test dengan ngrok saat development: `ngrok http 3000`

**Kolom voucher tampil "undefined" (username/password) di dashboard:**
Ini terjadi jika database Anda dibuat sebelum tabel `voucher` diubah dari kolom tunggal `kode` menjadi `username`+`password` terpisah. Jalankan migrasi berikut sekali saja lewat phpMyAdmin (tab SQL) atau command line:
```bash
mysql -u root -p nama_database < database/migration_voucher_username_password.sql
```
Migrasi ini aman — voucher lama tidak akan hilang, otomatis diisi `username = password = kode lama`. Re-import `schema.sql` versi terbaru juga otomatis menjalankan migrasi yang sama, jadi tidak perlu jalankan keduanya.

---

## 📝 Lisensi

MIT — Bebas digunakan dan dimodifikasi untuk keperluan komersial.
