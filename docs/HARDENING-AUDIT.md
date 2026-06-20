# 🔒 Catatan Audit Keamanan & Hardening — SimBill

Tanggal: 2026-06-20
Lingkup: audit statik backend (Node.js/Express + MySQL) + perbaikan langsung.

## ✅ Yang sudah aman (tidak diubah)
- **Webhook payment** — semua provider verifikasi signature sebelum memproses:
  Midtrans (signature), Xendit (`x-callback-token`), Duitku (MD5), Tripay
  (HMAC-SHA256 atas **raw body**). Callback palsu "PAID" ditolak 401.
- **Auth** — login admin & reseller pakai `bcrypt.compare`; ganti password
  `bcrypt.hash(.., 12)`. JWT secret **terpisah per role**
  (admin = `JWT_SECRET`, reseller = `+'_reseller'`, client = `+'_client'`)
  → token satu role tak bisa dipakai di role lain.
- **JWT secret boot-check** — `server.js` menolak start jika `JWT_SECRET`
  kosong / < 32 char / masih placeholder.
- **Route admin** — terproteksi `authMiddleware` (radius.js & backup.js pakai
  `router.use(authMiddleware)` global). Endpoint publik yang memang harus
  terbuka (webhook, voucher-publik, client OTP) punya proteksi sendiri.
- **OTP client** — ada batas percobaan (`MAKS_PERCOBAAN`) + rate-limit di
  `server.js` (`/api/client/otp/`).
- **Error handler** — stack/SQL disembunyikan di production (`NODE_ENV=production`).

## 🛠️ Yang diperbaiki di rilis ini

### HIGH — Injeksi baris ke file config VPN
File config (`wg0.conf`, `chap-secrets`) bersifat *line-based*. Input ber-newline
bisa menyelipkan direktif/akun palsu (mis. peer/akun VPN backdoor).
- `POST /api/radius/vpn/wg/peer` — validasi: `pubkey` base64 44-char,
  `ip_tunnel`/`allowed_ips` IPv4/CIDR, `nama`/`catatan` di-sanitasi (buang
  newline, batas panjang).
- `POST /api/radius/vpn/l2tp/user` — `username` `[A-Za-z0-9._@-]` (≤64),
  `password` tolak whitespace/newline (≤128), `ip` harus IPv4 / `*`.

### MEDIUM — Injeksi nama tabel pada backup
- `POST /api/backup/export` — nama tabel dari body sekarang di-**whitelist**
  terhadap `SHOW TABLES`; nama tak dikenal ditolak.

### MEDIUM — Token client bisa diforge (fallback rahasia)
- `routes/client.js` — hapus fallback `process.env.JWT_SECRET || 'secret'`
  yang bisa membuat token client mudah dipalsukan bila env tak ter-set.

### LOW–MEDIUM — RNG bisa diprediksi untuk nilai sensitif
Ganti `Math.random()` → `crypto.randomInt()` (CSPRNG, format output sama):
- OTP login client (`routes/client.js`).
- Kode voucher reseller (`routes/reseller.js`).
- Kode voucher admin (`routes/voucher-admin.js`).
- Username voucher publik (`routes/voucher-publik.js`).

## 📌 Rekomendasi operasional (bukan perubahan kode)
1. Pastikan `NODE_ENV=production` di environment pm2 — agar error handler
   tidak membocorkan detail SQL/stack:
   `pm2 restart billing-radius --update-env` setelah set di ecosystem/.env.
2. `POST /api/backup/restore` menjalankan SQL dari file backup (sifat dasar
   fitur restore). Sudah admin-only — **jaga tetap admin-only** dan jangan
   pernah ekspos tanpa auth.
3. Sebaiknya batasi `sudo` NOPASSWD user Node.js hanya ke perintah yang
   memang dipakai (`systemctl restart freeradius`, `wg`, `xl2tpd`), bukan
   sudo penuh.
4. Pertimbangkan set `CORS origin` ke domain panel (`FRONTEND_URL`) alih-alih
   `*` — aman karena auth pakai header token (bukan cookie), tapi lebih rapat.

## 🔎 Cara verifikasi cepat setelah deploy
```bash
# semua file lolos parse
cd backend && for f in routes/*.js services/*.js server.js; do node --check "$f" || echo "FAIL $f"; done

# uji validasi VPN (harus 400, bukan 200)
curl -s -X POST http://localhost:3000/api/radius/vpn/l2tp/user \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"username":"a\nbackdoor * pass *","password":"x"}'   # → 400 username tidak valid
```

---

# 🧨 Audit XSS Frontend (admin.html) — Pass ke-2

Tanggal: 2026-06-20

## Konteks risiko
- `admin.html` menyimpan token admin di `localStorage['nb_token']`.
  Artinya **satu** stored-XSS yang tereksekusi di sesi admin = pencurian token
  = ambil-alih akun penuh.
- ~182 titik `innerHTML`, **tanpa** helper escape umum (sebelumnya hanya escape
  parsial `<`-saja di beberapa render).

## Vektor stored-XSS yang ditemukan & ditutup
Prinsip: data yang bisa disetel **non-admin** lalu dirender **mentah** di panel.

| # | Sumber input (non-admin)              | Field        | Dilihat admin di            | Severity |
|---|---------------------------------------|--------------|-----------------------------|----------|
| 1 | `POST /reseller/auth/register` (publik, tanpa auth) | `nama`, `username`, `email` | Daftar/approve reseller | **HIGH** |
| 2 | `PUT /api/client/profil` (pelanggan login) | `nama`, `alamat` | Daftar/detail pelanggan (≈30 sink `${p.nama}`) | **HIGH** |
| 3 | `POST /voucher` (publik) | `nama` pembeli | Daftar voucher/invoice | MEDIUM |

### Perbaikan di sumber (server) — netralkan `< >` sebelum tersimpan
- `routes/reseller.js` `/auth/register`: strip `<>` di `nama`/`email`,
  validasi `username` `^[A-Za-z0-9._-]{3,32}$`, `no_hp` `^[0-9+]{8,16}$`, email.
- `routes/client.js` `PUT /profil`: strip `<>` di `nama`/`alamat`.
- `routes/voucher-publik.js` `POST /`: strip `<>` di `nama` pembeli.

> Tidak ada nama/alamat sah yang butuh karakter `<`/`>`, jadi pendekatan ini
> aman & tidak merusak data, sekaligus menutup ~30 sink `${p.nama}` sekaligus
> tanpa harus menyentuh tiap baris render.

### Perbaikan di output (frontend) — escape penuh
- Ditambahkan helper global **`escapeHtml()`** (escape `& < > " '`) di `admin.html`.
- Diterapkan pada render tiket (data campuran pelanggan/admin):
  daftar tiket (`judul`, `nama_pelanggan`, `username`), thread pesan
  (`m.pesan`), dan dropdown notifikasi tiket. Sebelumnya hanya escape `<` saja.

## ⚠️ Rekomendasi lanjutan (perlu uji di browser oleh Rizal)
Masih ada ±180 titik `innerHTML` yang merender data DB. Yang merender data
**admin-input** tidak rawan (admin tak menyerang dirinya sendiri), tapi praktik
terbaik tetap: **rutekan semua interpolasi data DB lewat `escapeHtml()`**.
Lakukan bertahap + uji tampilan, karena sebagian field memang sengaja berisi
markup (badge/ikon) yang TIDAK boleh di-escape.

Cara cari kandidat sink (jalankan di folder frontend):
```bash
grep -noE '\$\{[a-zA-Z_][a-zA-Z0-9_]*\.(nama|alamat|email|catatan|keterangan|deskripsi|judul|pesan|no_hp|username)[a-zA-Z0-9_]*\}' admin.html
```
Untuk tiap hasil yang merender **teks** (bukan markup), bungkus:
`${x.nama}` → `${escapeHtml(x.nama)}`.

Catatan: data lama yang sudah terlanjur tersimpan dengan `<...>` tidak otomatis
bersih oleh perbaikan di sumber — escape-on-output adalah pelindung lengkapnya.
