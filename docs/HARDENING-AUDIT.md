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

---

# 🧱 Refactor escape-on-output — Tahap 1: Modul Pelanggan

Tanggal: 2026-06-20

## Helper baru di `admin.html`
- `escapeHtml(s)` — escape `& < > " '` untuk **konteks teks** (isi elemen).
- `jsAttr(s)` — escape untuk **string JS di dalam atribut**, mis.
  `onclick="fn('${jsAttr(x)}')"`. Di konteks ini `escapeHtml` saja TIDAK aman.
  Bonus: ini juga memperbaiki **bug nyata** — nama berapostrof (mis. `O'Brien`)
  sebelumnya memecah handler `onclick`.

## Yang diamankan
- `renderTblPelanggan` — sel teks (`nama`, `email`, `username`, `no_hp`,
  `nama_paket`) via `escapeHtml`; tombol aksi (WA/Suspend/Aktifkan/Hapus)
  via `jsAttr` pada argumen nama.
- `rpRender` (daftar pelanggan reseller) — judul kartu, `@username`,
  `nama_paket` via `escapeHtml`; tombol Perpanjang via `jsAttr`.
- `loadResellerOptions` — opsi dropdown `nama (username)` via `escapeHtml`.

## Server — `routes/pelanggan.js`
- Export CSV: cegah **formula injection** Excel/Sheets — nilai diawali
  `= + - @ \t \r` diberi prefix `'`. (Sebelumnya hanya quoting RFC-4180.)

## ⚠️ Tahap berikutnya (belum dikerjakan)
- Modul **voucher**, **laporan**, **reseller (manajemen)**, **paket**, **tiket
  detail (dropdown teknisi)** — terapkan `escapeHtml`/`jsAttr` pada render teks
  & argumen onclick dengan pola yang sama.
- Cek export CSV/Excel lain (voucher, laporan) untuk formula injection yang
  sama seperti perbaikan di `pelanggan.js`.
- Pola pencarian onclick rawan apostrof/quote:
  `grep -noE "onclick=\"[a-zA-Z]+\([^)]*'\\\$\{[^}]+\}'" admin.html`

---

# 🖥️ Audit Frontend — Stored XSS (admin.html)

Tanggal: 2026-06-20

## Threat model
Data yang diisi pihak **non-admin** (nama/alamat/no_hp pelanggan dari signup
voucher publik, nama reseller, dll) ditampilkan di panel admin. Bila di-render
ke `innerHTML` tanpa escape, payload seperti `<img src=x onerror=...>` atau
breakout `onclick="fn('...')"` akan **mengeksekusi JS di sesi admin** =
ambil-alih penuh (curi token admin → kendali penuh sistem).

## Temuan & perbaikan
Helper `escapeHtml()` (konteks HTML) dan `jsAttr()` (konteks string-JS di dalam
atribut `onclick`) **sudah ada** dan benar, tapi dipakai **tidak konsisten** —
banyak render masih menyisipkan field mentah. Diperbaiki **25 titik**:

- **onclick dengan data tak-tepercaya (paling berbahaya — bisa breakout `'`/`"`/`<`):**
  invoice suspend (`nama_pelanggan`), reseller approve/saldo/edit/mutasi (`nama`),
  topup konfirmasi/hapus (`nama_reseller`), pengguna edit/toggle/hapus (`nama`,
  `username`, `email`, `no_hp`) → semua dibungkus `jsAttr()`.
  Catatan: beberapa sebelumnya hanya `.replace(/'/g,...)` — itu **tidak cukup**
  (tidak menutup `"`, `<`, `\`, newline). Diganti ke `jsAttr()`.
- **teks bebas pelanggan/reseller ke innerHTML:** nama/deskripsi pelanggan,
  nama+kontak reseller, nama_pelanggan di list invoice & transaksi voucher,
  alamat di kartu pelanggan, no_hp pengguna → dibungkus `escapeHtml()`.
- **config admin (self-XSS, dirapikan utk konsistensi):** nama paket, NAS
  shortname/nasname/community/secret → `jsAttr()`.

## Sudah aman / tidak diubah
- Render tiket (`escapeHtml(t.judul)`) + detail tiket pakai `.textContent`.
- Tabel pelanggan utama (kolom nama/email/no_hp) sudah pakai `escapeHtml`.
- `toast()` pakai `.textContent` (pesan API aman).
- Escape password di NAS/WG (`pwd.replace(...)`) **sengaja dibiarkan** — `jsAttr`
  bisa mengubah nilai password yang memuat `"`; ini nilai admin-only, bukan vektor.

## Catatan scope
- `client.html` (portal pelanggan) menampilkan data milik pelanggan itu sendiri
  → paling parah self-XSS (risiko rendah). Tidak diubah di pass ini.
- Validasi tetap **defense-in-depth**: idealnya juga batasi karakter pada input
  nama/alamat di sisi server, tapi escape di output adalah pertahanan utama XSS.

## Verifikasi
JS inline `admin.html` lolos `node --check` setelah semua edit (tidak ada
template literal / kurung yang rusak).

---

# 🧱 Validasi Input Sisi Server (lapis kedua)

Tanggal: 2026-06-20

Pertahanan utama XSS = escape di output (sudah). Ini lapis kedua di sumber input.
Util baru: `backend/utils/sanitasi.js` — `teksSatuBaris`, `teksMultiBaris`,
`noHp`, `email`. Sengaja **lossless** untuk karakter terlihat (`< > & ' "`
tidak dibuang) agar nama/alamat sah tak rusak; yang dibuang hanya null byte,
karakter kontrol, dan newline pada field satu-baris (diubah jadi spasi).

## Sudah ada sebelumnya (tidak diubah signifikan)
- `voucher-publik /beli` — strip `<>` nama (+ kini cap 80 char & strip kontrol).
- `client PUT /profil` — strip `<>` nama/alamat, validasi email & no_hp
  (+ kini cap 100/200 char & strip kontrol).
- `reseller /auth/register` — strip `<>`, regex username/no_hp/email
  (+ kini cap panjang nama/email).

## Gap yang diisi
- `client POST /tiket` (buat tiket oleh pelanggan) — `judul`/`pesan`/`kategori`
  sebelumnya **tanpa batas panjang & tanpa strip kontrol**. Kini:
  judul `teksSatuBaris(150)`, pesan `teksMultiBaris(4000)`, kategori dibatasi.
- `client POST /tiket/:id/reply` — `pesan` kini `teksMultiBaris(4000)`.

Manfaat: cegah write berukuran ekstrem (DoS/penuh disk), log/CSV/header
injection via newline & karakter kontrol, sekaligus mempersempit permukaan
payload — tanpa merusak input sah.

## Catatan
- Route pelanggan sisi **admin** (`/api/pelanggan`) tidak disanitasi karena
  input dari admin (tepercaya) dan output tetap di-escape. Bisa ditambah cap
  panjang bila diinginkan.
- Pertimbangan lanjutan (belum dikerjakan): proteksi **CSV/formula injection**
  saat export Excel (exceljs) — prefiks `'` pada sel yang diawali `= + - @`,
  agar nama pelanggan seperti `=cmd|...` tak tereksekusi saat admin buka file.
