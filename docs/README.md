<h1 align="center">SimBill</h1>

<p align="center">
  <b>Sistem Billing ISP & Hotspot Lengkap</b><br>
  PPPoE + Hotspot · FreeRADIUS · MikroTik · WhatsApp & Telegram Bot · Payment Gateway · TR-069 ACS
</p>

<p align="center">
  <img src="https://img.shields.io/badge/versi-v1.1.0-BA7517"> 
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933"> 
  <img src="https://img.shields.io/badge/MariaDB-10%2B-003545"> 
  <img src="https://img.shields.io/badge/platform-Ubuntu%20%7C%20Debian-blue">
</p>

---

## 📖 Tentang

**SimBill** adalah aplikasi manajemen billing untuk ISP, RT/RW Net, dan operator Hotspot. Dibangun dengan **Node.js + Express + MariaDB**, terintegrasi langsung dengan **FreeRADIUS** dan **MikroTik** untuk autentikasi PPPoE & Hotspot, dilengkapi gateway **WhatsApp** dan **Telegram**, pembayaran online otomatis, serta manajemen perangkat ONU lewat **TR-069 (ACS)** — semuanya dalam satu dashboard berbahasa Indonesia yang responsif (bisa dibuka di HP).

---

## ⚡ Instalasi Cepat

> Jalankan di **VPS baru** (Ubuntu 22/24 atau Debian 11/12) sebagai root.

**Install di VPS BARU:**
```bash
wget -qO- https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/install.sh | sudo bash
```

**Update di VPS yang sudah terpasang:**
```bash
wget -qO- https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/update.sh | sudo bash
```

Installer otomatis memasang **Node.js 20, pm2, MariaDB**, membuat database, meng-clone aplikasi ke `/opt/simbill`, membuat file `.env` (JWT digenerate otomatis), mengimpor schema, lalu menjalankan aplikasi via **pm2** dengan nama `billing-radius`. Setelah selesai, akses dashboard di `http://IP-VPS:3000`.

### 🔑 Login Default

Setelah install, masuk dengan akun default:

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

> ⚠️ **Segera ganti password** dari menu profil setelah login pertama.
>
> Ingin set password sendiri saat install? Tambahkan `ADMIN_PASS`:
> ```bash
> curl -fsSL https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/install.sh | sudo ADMIN_PASS=PasswordKuatku bash
> ```

> ⚠️ `install.sh` hanya untuk server **baru/kosong**. Untuk server yang sudah berjalan, gunakan `update.sh` (otomatis mem-backup `.env` lebih dulu).

---

## ✨ Fitur

### 🧾 Billing & Pelanggan
- **Manajemen Pelanggan** — PPPoE & Hotspot, data lengkap + upload foto **KTP**, titik lokasi di peta, info **ODC/ODP**.
- **Paket Internet** — paket PPPoE, Hotspot, atau keduanya, dengan harga & profil bandwidth.
- **Invoice Otomatis** — generate tagihan bulanan, cetak invoice ber-**QR Code** (mendukung **A4** & **thermal 58mm**), status lunas/belum bayar.
- **Reminder & Auto-Suspend** — pengingat tagihan via WhatsApp sebelum jatuh tempo, dan suspend otomatis pelanggan menunggak (terjadwal cron).

### 📶 Integrasi Jaringan
- **FreeRADIUS** — autentikasi PPPoE & Hotspot (radcheck/radacct).
- **MikroTik** — sinkronisasi user, profil, dan kontrol koneksi.
- **Sesi Aktif** — pantau sesi PPPoE/Hotspot yang sedang online secara real-time.
- **RADIUS / NAS** — kelola perangkat NAS & status koneksi.
- **Peta Jaringan** — visualisasi pelanggan, ODC, dan ODP di peta.
- **TR-069 ACS** — manajemen perangkat ONU/router, termasuk **cek sinyal optik (redaman)** dari jarak jauh.

### 🎟️ Voucher & Reseller
- **Voucher Hotspot** — generate massal, **Template Voucher** yang bisa dikustom (siap cetak).
- **Sistem Reseller** — dashboard reseller terpisah, kelola pelanggan & voucher sendiri, **topup saldo**, dan laporan reseller.

### 💬 Gateway & Pembayaran
- **WhatsApp Gateway** — notifikasi otomatis + **bot dua arah** (cek tagihan, dll).
- **Telegram Bot** — perintah dua arah, termasuk **cek sinyal optik ONU** via ACS.
- **Payment Gateway** — pembayaran online otomatis: **Midtrans, Xendit, Duitku, Tripay**.

### 🎧 Operasional & Tim
- **Tiket Gangguan** — pelaporan gangguan dengan **penugasan teknisi** & **prioritas**.
- **Peran Pengguna** — `superadmin`, `admin`, `operator`, dan **`teknisi`** (akses terbatas: dashboard teknisi, tiket, peta, perangkat).
- **Log Admin** — catatan aktivitas pengguna admin.

### 📊 Laporan & Sistem
- **Dashboard** — ringkasan pendapatan, jumlah user online/offline/suspend, kesehatan NAS, monitor trafik — **real-time**.
- **Laporan Keuangan** — Ringkasan, **Periode Pemasukan**, dan **Net Profit**.
- **Export/Import User** — pindahkan data pelanggan dengan mudah.
- **Backup & Restore** — cadangkan & pulihkan database dari dashboard.
- **Self-Update** — perbarui aplikasi langsung dari GitHub Release lewat dashboard.
- **Lisensi** — sistem aktivasi lisensi.

### 🎨 Antarmuka
- **Responsif** — nyaman dibuka di desktop maupun **HP**.
- **Multi-bahasa** — Indonesia & Inggris.
- **Dark Mode** — mode siang/malam.
- **Aplikasi Android** — tersedia versi APK untuk **Pelanggan (RF-CLIENT)** dan **Admin (RF-ADMIN)**.

---

## 🛠️ Stack Teknologi

| Komponen        | Teknologi                          |
|-----------------|------------------------------------|
| Backend         | Node.js + Express                  |
| Database        | MariaDB / MySQL                    |
| Autentikasi     | FreeRADIUS (PPPoE & Hotspot)       |
| Router          | MikroTik (RouterOS API)            |
| Perangkat ONU   | TR-069 / CWMP (ACS)                |
| Proses          | pm2                                |
| Frontend        | HTML/CSS/JS (SPA, tanpa build)     |

---

## ⚙️ Konfigurasi

Konfigurasi utama ada di `/opt/simbill/backend/.env` (dibuat otomatis oleh installer). Yang penting:

```env
PORT=3000
DB_NAME=billing_radius
DB_USER=billing
DB_PASS=********           # ditampilkan saat install — simpan baik-baik
JWT_SECRET=********         # digenerate otomatis (jangan dibagikan)
```

> Konfigurasi WhatsApp & Payment Gateway diatur langsung dari **dashboard admin** (menu WhatsApp / Payment), bukan di `.env`.

Setelah login pertama, **segera ganti password admin default**.

---

## 🔄 Update

```bash
wget -qO- https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/update.sh | sudo bash
```
Atau langsung dari menu **Lainnya → (Self-Update)** di dashboard.

---

## 🤝 Kontribusi

Kontribusi selalu diterima! Silakan request fitur atau laporkan issue jika menemukan bug.

✈️ **Telegram:** [t.me/rfhotspot](https://t.me/@rfhotspot)
👥 **Group Diskusi (WhatsApp):** [Gabung di sini](https://chat.whatsapp.com/FWabl0tqwDyCbvDiNuVOTq?s=sh&p=a&mlu=4&amv=3)

---

## ☕ Traktir Kopi

Kalau aplikasi ini bermanfaat dan ingin berbagi uang kopi:

💛 **PayPal:** [paypal.me/panyoet](https://paypal.me/panyoet?locale.x=en_US&country.x=ID)

Terima kasih atas dukungannya! 🙏

---

<p align="center"><sub>SimBill © 2026 — dibuat untuk komunitas ISP & RT/RW Net Indonesia.</sub></p>
