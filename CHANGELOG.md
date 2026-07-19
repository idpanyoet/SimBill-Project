# CHANGELOG v1.15.2 — Hardening Keamanan (kumulatif)

Rilis hardening lanjutan. **Kumulatif**: mencakup semua fix v1.15.1 (#1, #4) DITAMBAH
#3 dan #5. Kalau v1.15.1 belum diterapkan, cukup pasang v1.15.2 (superset).
Semua zero-risk & aditif — tak ada perubahan perilaku pada instalasi normal.

## 🔒 Keamanan

### #1 (dari v1.15.1) — Enkripsi kredensial router fail-closed (`services/mikrotik.js`)
Fallback ke kunci default publik dihapus. Tanpa `APP_SECRET`/`JWT_SECRET`, enkripsi
dibatalkan (throw) alih-alih pakai kunci lemah. Instalasi normal tak berubah
(`JWT_SECRET` selalu ada dari install.sh).

### #4 (dari v1.15.1) — Validasi ganti-password admin (`routes/auth.js`)
`/api/auth/ganti-password` kini wajib password lama+baru & baru minimal 8 karakter.

### #3 (baru) — Lockout login tak bisa dilewati spoof X-Forwarded-For
`_ipDari` (`routes/auth.js`) & `_lsIp` (`routes/client.js`) DULU ambil XFF elemen
paling depan (`split(',')[0]`) — nginx meng-APPEND (`$proxy_add_x_forwarded_for`),
jadi elemen depan bisa dipalsu klien → lockout per-IP bisa dilewati (rotate header)
atau meracuni IP orang lain. **Sekarang pakai `req.ip`** (dengan `trust proxy='loopback'`
express menghitung IP klien asli dari KANAN, melewati hop loopback tepercaya → tak
bisa dipalsu di topologi standar client→nginx→express). Lockout per-akun tetap ada
sebagai lapis kedua.
- Topologi terkonfirmasi: **nginx langsung** (bukan Cloudflare). `req.ip` tepat.
- CATATAN: 9 titik lain masih pakai XFF elemen-depan TAPI hanya untuk **audit log**
  (bukan kontrol keamanan) — sengaja tak diubah agar blast-radius rilis kecil.
  Cleanup opsional di masa depan (bikin helper `ipKlien(req)` terpusat).

### #5 (baru) — CORS: isi FRONTEND_URL saat DOMAIN diset (`install.sh`)
Panel disajikan same-origin & auth token-in-header, jadi fallback `origin:'*'`
risikonya rendah. install.sh dulu isi `APP_URL` tapi bukan `FRONTEND_URL` → jatuh ke
`*`. Sekarang bila `DOMAIN` diisi saat install → `.env` dapat `FRONTEND_URL=https://<domain>`
→ CORS terkunci ke domain panel (defense-in-depth). Install tanpa domain/IP-only
tetap `*` (tak dipecah).
- ⚠️ **Instalasi LAMA** (mis. dash.rfnet.id): `.env` sudah ada → install.sh tak
  menyentuhnya. Tambah manual bila mau: `FRONTEND_URL=https://dash.rfnet.id` lalu
  `pm2 restart billing-radius --update-env`.

## Yang TIDAK diubah (keputusan sadar)
- **#2 (auth restore/update)**: `/backup/restore`, `/backup/jalankan`, `/update/apply`
  TETAP `requireAdmin` — karena ada staf role `admin` yang memang perlu akses ini.
  Tidak dinaikkan ke superadmin (menghindari mengunci staf). Opsi jalan-tengah
  (konfirmasi password pada restore, seperti reset-database) bisa ditambah terpisah
  bila diinginkan.

## Tak menyentuh
File inti (`server.js`, `config/db.js`) & file WA (rawan drift) — tidak disentuh.

# CHANGELOG v1.15.1 — Hardening Keamanan

Rilis hardening (tanpa fitur baru). Dua perbaikan zero-risk & universal hasil audit
keamanan source. Aman untuk semua instalasi — **tidak ada perubahan perilaku pada
instalasi normal** (yang JWT_SECRET-nya sudah ter-generate oleh install.sh).

## 🔒 Keamanan

### 1. Enkripsi kredensial router MikroTik jadi *fail-closed* (`services/mikrotik.js`)
- **Sebelum:** `_kunci()` punya fallback ke kunci default publik bila `APP_SECRET`
  dan `JWT_SECRET` dua-duanya kosong. Karena source terbit (obfuscated), kunci
  default itu bisa ditebak siapa pun → password router bisa didekripsi bila DB bocor.
- **Sesudah:** fallback dihapus. Bila tak ada secret sama sekali, enkripsi/dekripsi
  dibatalkan (throw) alih-alih memakai kunci lemah.
- **Dampak instalasi normal:** NIHIL. `install.sh` selalu men-generate `JWT_SECRET`,
  jadi `_kunci()` tetap memakai `JWT_SECRET` seperti sebelumnya. Router password lama
  tetap bisa didekripsi (kunci sama).
- **Opsional (disarankan, tidak wajib):** untuk pemisahan kunci dari JWT, tambahkan
  `APP_SECRET=<48-hex-acak>` ke `backend/.env`. Bila diisi, ia diutamakan.
  ⚠️ Jangan mengganti `APP_SECRET`/`JWT_SECRET` yang sudah dipakai — router password
  lama dienkripsi dengan kunci tersebut; menggantinya = password lama tak terbaca
  (harus di-input ulang di panel).

### 2. Validasi panjang password pada ganti-password admin (`routes/auth.js`)
- **Sebelum:** endpoint `/api/auth/ganti-password` (akun admin/superadmin) langsung
  mem-`bcrypt.hash` tanpa cek panjang. Portal pelanggan sudah cek min 6/8, tapi akun
  paling berhak justru tanpa validasi.
- **Sesudah:** wajib isi password lama & baru; password baru minimal 8 karakter.
- **Dampak:** aditif. Perubahan password valid tetap jalan; hanya menolak password
  kosong/terlalu pendek.

## Catatan
- Tidak menyentuh file inti (`server.js`, `config/db.js`) maupun file WA (rawan drift).
- Temuan audit lain (auth operasi restore/update, spoof X-Forwarded-For di lockout,
  CORS fallback `*`) SENGAJA belum dimasukkan — perlu keputusan spesifik deploy
  (topologi nginx & kebijakan role admin) agar tidak mengunci akun sendiri.

# SimBill v1.15.0

## ⭐ FITUR BARU: Durasi Hotspot (akumulasi uptime)
Voucher hotspot kini bisa dibatasi **total waktu online** (akumulasi lintas sesi),
terpisah dari Masa Aktif (jendela validitas).
- Contoh: Masa Aktif 3 hari + Durasi 24 jam → pelanggan online total 24 jam yang
  bisa disebar dalam 3 hari. Mati mana duluan.
- **Opsional & backward-compatible**: durasi kosong/0 = perilaku lama (masa aktif saja).
- Mekanisme: FreeRADIUS `noresetcounter` menjumlahkan acctsessiontime per voucher;
  voucher berdurasi dapat `Max-All-Session` (detik) di radcheck otomatis saat generate.
- Field "Durasi (Uptime)" muncul di form Paket saat tipe Hotspot/Keduanya.

⚠️ **WAJIB setup FreeRADIUS** (per-server, sekali): aktifkan `noresetcounter`.
   Lihat 02-freeradius-setup.txt. Tanpa ini, durasi TIDAK berfungsi.

## 🎨 Edit Paket → Aurora
- Modal Edit Paket didesain ulang tema aurora (panel kiri gradient + preview harga
  live), konsisten dengan Tambah Paket. Layout 2 kolom rapi.

## 🔧 Perbaikan Isolir (dari v1.14.9)
- radius.js: Framed-Pool group paket `:=` → `=` (fix isolir jebol).
- server.js: migrasi boot idempoten Framed-Pool.
- admin.html: redesign halaman Isolir (Aurora) + panduan MikroTik idempoten +
  panduan nginx (rewrite, fix "halaman tidak muncul").

## 👤 Portal Pelanggan (dari v1.14.9)
- Auto-logout saat token JWT habis (tak ada lagi "Token tidak valid").
- OTP satu input lebar (bisa paste kode dari WhatsApp).
- Tombol "Perpanjang/Bayar" hanya untuk pelanggan prepaid.
- Backend: /api/client/profil kirim field siklus.

# SimBill v1.14.9

## 🔧 Perbaikan Isolir (sumber masalah — FILE INTI)
- **radius.js**: Framed-Pool pada group paket diubah dari operator `:=` (menimpa)
  menjadi `=` (isi hanya bila belum ada). Ini memperbaiki isolir JEBOL — sejak
  fix IP-pool-per-paket, group paket punya Framed-Pool `:=` yang MENIMPA radreply
  isolir milik user suspend → user suspend dapat pool normal (tetap internetan).
  Dengan `=`, radreply user (isolir) diproses dulu & MENANG; user normal tetap
  dapat pool paket. Aman untuk paket ber-pool maupun tanpa-pool.
- **radius.js `aktifkanUser`**: pelanggan yang terlanjur nyangkut di group `isolir`
  otomatis dikembalikan ke group paket-nya saat diaktifkan.
- **server.js**: migrasi boot idempoten — mengubah semua `radgroupreply.Framed-Pool`
  dari `:=` ke `=` sekali jalan (aman diulang; Mikrotik-Rate-Limit tak tersentuh).

## 👤 Portal Pelanggan (client.html)
- **Auto-logout saat token JWT habis** (pola sama dengan admin.html): API balas 401
  → bersihkan token + reload → kembali ke login otomatis. Ada grace period 8 detik
  setelah login agar request basi tak menendang sesi baru. Tak ada lagi pesan
  "Token tidak valid" yang membingungkan pelanggan.
- **OTP satu input lebar** (ganti 6 kotak): lebih mudah, bisa PASTE kode sekaligus
  dari WhatsApp, auto-verifikasi saat 6 digit lengkap, autocomplete one-time-code.
- **Tombol "Perpanjang / Bayar Sekarang" hanya untuk PREPAID**: pelanggan postpaid
  (bayar tagihan berjalan) tak menampilkan tombol ini.

## 🔌 Backend (routes/client.js)
- Endpoint `/api/client/profil` kini mengirim field `siklus` (prepaid/postpaid),
  dipakai frontend untuk menampilkan tombol perpanjang sesuai siklus.

## 🎨 Halaman Isolir (admin.html)
- **Redesign tema Aurora**: hero + grid 2 kolom (mode | pool) + panduan bertab
  (MikroTik / Server nginx). Lebih ringkas, konsisten dengan identitas SimBill.
- **Panduan MikroTik idempoten**: script kini menghapus rule lama dulu (by comment)
  sebelum menambah → aman di-paste ulang tanpa menumpuk. Pool/profile pakai `:if
  find` (tak menimpa bila sudah ada).
- **Panduan Server (nginx)** baru: config `default_server` dengan `rewrite ^ /isolir
  break` yang menampilkan halaman /isolir untuk semua request pelanggan isolir
  (termasuk captive-portal check /generate_204) — memperbaiki "halaman tidak muncul".

# CHANGELOG v1.14.8

Menambahkan **fix akar invoice dobel (loop cron)** di atas v1.14.7
(aktivasi lisensi aman + IP pool per-paket) dan v1.14.5 (WireGuard, template
ONU, UI).

## Invoice dobel — akar loop cron DITUTUP

- **BUG SISTEMIK (muncul berulang walau sudah pernah "diperbaiki").** Dua cron
  saling memicu:
    - 06:00 auto-cancel-basi: invoice unpaid/overdue milik pelanggan aktif yg
      tgl_expired melewati tgl_jatuh_tempo -> ditandai 'cancelled'.
    - 07:00 generate: guard bolehBuatInvoice() hanya menghitung status
      paid/unpaid/overdue — MELEWATKAN 'cancelled' -> menganggap belum ada
      invoice -> membuat baru utk jatuh tempo yg SAMA. Besok di-cancel lagi ->
      dibuat lagi -> LOOP HARIAN (contoh nyata: 55% invoice jadi cancelled,
      ~8 duplikat per pelanggan dgn jatuh tempo sama).
- **FIX:** bolehBuatInvoice() kini menolak membuat invoice bila SUDAH ADA
  invoice utk tgl_jatuh_tempo yang SAMA PERSIS — status APA PUN, termasuk
  'cancelled'. Loop terputus: setelah 1 invoice utk jatuh tempo X (walau jadi
  cancelled), tak ada lagi invoice baru utk X. Aturan lama (cek bulan sama utk
  paid/unpaid/overdue + blokir bila ada tunggakan) tetap. Menutup semua jalur
  yg memakai guard terpusat (cron bulanan, generate manual, portal client).
- Pembersihan data lama (invoice cancelled yg sudah menumpuk) dilakukan
  TERPISAH per server dgn tool bersih-invoice-dobel.js (dry-run + backup;
  kasus "bayar 2x" di-skip utk tinjauan manual). TIDAK otomatis — menyangkut
  data keuangan.

## (Termasuk semua perubahan v1.14.7 & v1.14.5)
- Aktivasi lisensi aman (fix chicken-and-egg + resetGuard, keamanan
  license_server_url & grace 3-hari dipertahankan).
- IP pool per-paket (groupname basis id paket).
- WireGuard end-to-end, template ONU persist, tombol Restart RADIUS.

## Migrasi otomatis: pelanggan.periode & pelanggan.siklus (PENTING)

- **BUG SISTEMIK (banyak pelanggan VPS terdampak diam-diam).** Kode SimBill
  (webhook pembayaran Xendit/dll + cron cek masa aktif + cron kalender)
  memakai kolom `pelanggan.periode` & `pelanggan.siklus`, TAPI tidak ada
  migrasi otomatis yang menambah kolom itu. Pelanggan yang DB-nya belum punya
  kolom tersebut mengalami error `Unknown column 'p.periode'` -> webhook
  pembayaran GAGAL (status voucher/invoice tak ter-update otomatis; harus
  dilunasi manual) + cron cek masa aktif error.
- **FIX:** tambah 2 migrasi otomatis di server.js (pola sama dgn migrasi lain):
    pelanggan.siklus  -> ALTER ADD COLUMN siklus  VARCHAR(20) DEFAULT 'postpaid'
    pelanggan.periode -> ALTER ADD COLUMN periode VARCHAR(20) DEFAULT 'tetap'
  Idempoten (cek INFORMATION_SCHEMA dulu; kalau kolom sudah ada -> skip).
  Pelanggan cukup update (git reset + restart) -> kolom ditambah OTOMATIS saat
  boot -> webhook & cron jalan normal. TIDAK perlu ALTER manual per server.

# CHANGELOG v1.14.7

Rilis gabungan: FIX AKTIVASI LISENSI (aman) + FIX IP POOL per-paket, di atas
basis v1.14.5 (WireGuard, template ONU, UI — sudah dirilis sebelumnya).

## Aktivasi lisensi — install baru tak terkunci, TANPA regresi keamanan

- **BUG #1 (chicken-and-egg) "Token tidak ditemukan".** `routes/license.js`
  memasang `authMiddleware` global -> `/activate` menolak request tanpa token.
  Install baru terkunci (`license_enforce=1`) -> admin belum bisa login ->
  belum punya token -> aktivasi mustahil. FIX: `authMiddleware` global dihapus;
  `/activate`, `/status`, `/hwid` publik; endpoint sensitif (`/extend`,
  `/plans`, `/extend/pay`, `/payment/status`) tetap `authMiddleware +
  requireAdmin`.
- **BUG #2 — aktivasi sukses tapi balik ke gerbang.** `license-guard` cache
  status & refresh tiap 5 menit. Setelah `/activate` sukses, guard masih
  pegang status lama. FIX: guard mengekspos `resetGuard()`; `/activate`
  memanggilnya setelah sukses -> evaluasi ulang seketika.
- **Keamanan dipertahankan (PENTING).** `/activate` TIDAK menerima
  `license_server_url` dari body (cegah pengalihan ke server lisensi palsu)
  dan menghapus override lama. Grace 3 hari untuk "server tak terjangkau"
  tetap (bukan fail-open buta -> cegah bypass via block DNS). Versi ini
  MENGGANTIKAN patch aktivasi mentah yang sempat masuk source (yang membuka
  kembali lubang server-palsu & fail-open).

## IP Pool per-paket — tiap paket dapat pool sendiri

- **BUG: semua pelanggan dapat IP dari satu pool** (pool paket yg terakhir
  diedit). Akar: groupname RADIUS dibuat dari kecepatan
  (`${tipe}-${kecepatan_dn}mbps`). Karena banyak paket punya kecepatan_dn
  sama (mis. semua =1), SEMUA pelanggan menumpuk di 1 group -> Framed-Pool
  saling menimpa. FIX: groupname berbasis ID paket (`${tipe}-paket-${id}`),
  unik per paket -> tiap paket punya group & Framed-Pool sendiri.
  - backend/services/radius.js : _namaGroup() basis id paket.
  - backend/routes/paket.js    : groupname saat edit paket basis id.
  - Migrasi data pelanggan lama: pakai script migrasi-group-per-paket.js
    (TIDAK termasuk rilis; jalankan sekali di server yg sudah terlanjur
    menumpuk di 1 group).

## (Termasuk semua perubahan v1.14.5)
- WireGuard end-to-end (IPv6 allowed_ips, server pubkey auto, script anti-
  error, /ip /24, ip_tunnel, reload fix, private key terbaca), template ONU
  persist, tombol Restart RADIUS.

## Migrasi group RADIUS OTOMATIS (tambahan)
- Migrasi data group-per-paket kini BERJALAN OTOMATIS saat boot (server.js:
  entry migrasi `radusergroup.group_per_paket`). Idempoten via cek
  `groupname REGEXP '-[0-9]+mbps$'` -> setelah termigrasi tak jalan lagi.
  Pelanggan lama yang menumpuk di 1 group otomatis dipindah ke group paket-nya.
  Skrip migrasi-group-per-paket.js tetap disertakan sebagai cadangan/rollback
  (DRY-RUN default), tapi TIDAK wajib dijalankan manual lagi.

# CHANGELOG v1.14.5

Rilis fokus **WireGuard** (banyak perbaikan alur peer end-to-end),
**persistensi template ONU**, dan perbaikan UI.

## WireGuard — perbaikan menyeluruh alur peer

- **allowed_ips terima IPv6.** Validator `allowedIpsValid` dulu hanya IPv4,
  menolak `::/0` padahal default panel menawarkannya. Kini menerima
  IPv4-CIDR maupun IPv6-CIDR (mis. `0.0.0.0/0,::/0`), tetap menolak input
  ber-newline/karakter direktif (anti-injeksi wg0.conf).
- **Server public key otomatis terisi di script MikroTik.** Sebelumnya
  placeholder `(SERVER-PUBLIC-KEY)` muncul bila WireGuard dipasang lewat
  installer (bukan tombol panel). Kini fallback berjenjang: setting DB ->
  file `/etc/wireguard/server_public.key` -> derive dari `wg0.conf`, lalu
  disinkronkan ke setting.
- **Script MikroTik anti-error paste.** `allowed-address` dirapatkan tanpa
  spasi setelah koma; blok `add peer` ditulis SATU BARIS (tanpa `\`
  line-continuation yang rapuh di RouterOS). Menghilangkan "expected
  allowed-address value" & "syntax error / expected end of command".
- **`/ip address` MikroTik pakai prefix subnet /24** (bukan /32). Dengan /32
  peer tak punya route ke server -> handshake OK tapi ping timeout. /24
  membuat routing tunnel benar.
- **Kolom `vpn_account.ip_tunnel` baru.** IP tunnel peer disimpan terpisah
  dari `allowed_ips` (route), sehingga `/ip address` menulis IP tunnel yang
  benar. Migrasi kolom otomatis saat boot (idempoten).
- **Reload WireGuard otomatis diperbaiki.** Reload lama memakai process
  substitution `<(...)` yang gagal di `/bin/sh` (dash) & ditelan diam-diam,
  sehingga peer baru tak masuk runtime (handshake gagal, perlu reload
  manual). Kini pakai file sementara + `wg syncconf`; deteksi interface via
  `wg show` (bukan status systemd yang tak selalu akurat). Kegagalan reload
  kini dilaporkan, tak lagi senyap.
- **Private key peer terbaca.** Di modal Tambah Peer, private key kini
  tampil dengan warna kontras (tak lagi putih-di-putih yang hanya terlihat
  saat diblok).

## Template registrasi ONU (OLT) — tidak hilang lagi saat update

- Template ONU (`olt-templates.json`) dipindah ke luar folder repo
  (`/opt/simbill-data/`), sehingga `git reset --hard` saat update TIDAK lagi
  menghapus template buatan admin. Template bawaan pindah ke
  `olt-templates.default.json`. Saat boot: file data yg sudah ada tak
  disentuh; bila belum ada, migrasi dari lokasi lama atau seed dari default.

## Perbaikan UI

- Tombol **Restart RADIUS** di halaman Setting kini berfungsi (sebelumnya
  onclick rusak oleh escape tak valid).

## Catatan upgrade

- Migrasi DB (`vpn_account.ip_tunnel`) berjalan otomatis saat start.
- Template ONU: setelah upgrade, `olt-templates.json` di-untrack dari git &
  dimigrasi ke `/opt/simbill-data/` otomatis. Peer WireGuard lama yang sudah
  ada perlu di-set `ip_tunnel`-nya (atau dibuat ulang) agar `/ip address`
  di script benar; peer baru otomatis benar.

## v1.14.4 — 16 Juli 2026

AUDIT MENYELURUH semua jalur pembuatan invoice + anti-duplikat TERPUSAT.

### Latar

Bug invoice dobel muncul berulang karena tiap patch hanya menambal SATU jalur
(cron), padahal ada BANYAK jalur yang membuat invoice, masing-masing dengan
proteksi berbeda/lemah. Audit menemukan 9 jalur INSERT invoice.

### 🔍 Hasil audit 9 jalur

- Jalur 2 (simpan payment_url), 4 (prorata create), 8-9 (voucher): AMAN.
- Jalur 7 (cron kalender/Fixed Date): sudah aman (1/bulan pembuatan).
- Jalur 1 (portal mandiri), 3 (generate manual), 5 (WA suspend), 6 (cron
  Renewal): RENTAN — proteksi lemah/tak seragam. DIPERBAIKI.

### ✅ Perbaikan: helper anti-duplikat TERPUSAT

Dibuat services/invoice-helper.js dengan fungsi bolehBuatInvoice() yang dipakai
SEMUA jalur, aturan seragam:
  - Paket bulanan-setara (siklus >=28 hari): MAKS 1 invoice per BULAN jatuh
    tempo, cek termasuk 'paid' (cancelled diabaikan) + jaring tunggakan periode
    lain. Menutup pola Vida (tgl_expired bergeser) DAN Cutmarissa (periode sudah
    dibayar).
  - Paket pendek (harian/jam): cek tanggal jatuh tempo persis (boleh >1/bulan).

Diterapkan ke jalur 1, 3, 5, 6. Jalur 7 sudah aman. Sekarang SEMUA jalur pakai
aturan yang sama — tak ada lagi celah per-jalur.

TIDAK ada dependensi npm baru.

## v1.14.3 — 16 Juli 2026

Lanjutan v1.14.2. Menutup pola invoice dobel KEDUA yang belum tertutup v1.14.2.

### 🐛 Invoice dobel untuk periode yang SUDAH DIBAYAR

v1.14.2 mencegah dobel saat invoice sebelumnya belum bayar. Tapi ditemukan pola
lain (mis. Cutmarissa, ellizar, heri): invoice periode Juli SUDAH dibayar (0559,
lunas 23 Jun), lalu 13 Jul cron membuat invoice BARU (0983) untuk bulan jatuh
tempo yang sama. Proteksi v1.14.2 hanya cek invoice unpaid/overdue, sehingga
invoice yang sudah 'paid' tak terlihat -> dobel lolos.

Pemicu: tgl_expired ter-reset ke periode lama (mis. edit/migrasi massal), membuat
cron memproses ulang pelanggan yang sebenarnya sudah ditagih & dibayar.

### ✅ Perbaikan

Untuk paket bulanan-setara: cron kini menolak membuat invoice bila SUDAH ADA
invoice (paid/unpaid/overdue -- cancelled diabaikan) yang jatuh temponya di BULAN
yang sama. Aturan: paket bulanan = maksimal 1 invoice per bulan jatuh tempo.
Jaring unpaid/overdue lintas-periode dipertahankan (tunggakan periode lain).

Menutup kedua pola: tgl_expired bergeser (Vida) DAN periode sudah dibayar
(Cutmarissa). Tagihan bulan BERIKUTNYA tetap jalan (bulan jatuh tempo beda).

TIDAK ada dependensi npm baru.

## v1.14.2 — 16 Juli 2026

Lanjutan v1.14.1. Memuat SEMUA perbaikan sebelumnya (deadlock RADIUS, aktivasi
lisensi, reminder tagihan) + perbaikan invoice dobel.

### 🐛 Invoice menumpuk (>1 invoice belum-bayar per pelanggan)

Pelanggan paket bulanan menerima banyak invoice untuk periode berbeda padahal
tagihan sebelumnya belum lunas (mis. Vida: 3 invoice, jatuh tempo 15/16/17 Juli).

Penyebab: proteksi anti-duplikat KUAT ("1 invoice belum-lunas = skip") hanya
aktif kalau `satuan_masa = 'bulan'` PERSIS. Tapi banyak paket bulanan disimpan
sebagai `satuan_masa='hari', masa_aktif=30` (30 hari). Untuk paket itu, kode
jatuh ke proteksi LEMAH (cek tanggal jatuh tempo persis) — dan karena tgl_expired
bergeser tiap generate (15→16→17), cek selalu lolos → invoice baru terus dibuat
tiap kali cron jalan.

### ✅ Perbaikan

- Proteksi anti-duplikat kuat kini berlaku untuk semua paket "bulanan-setara"
  (siklus >= 28 hari), dihitung dari satuan_masa + masa_aktif — bukan hanya
  `satuan_masa='bulan'`. Jadi paket hari/30, hari/28, bulan/1 semua terlindungi.
- Paket benar-benar pendek (harian, mingguan, jam) tetap boleh >1 invoice.
- Tahan data kotor: 'Bulan' (kapital), satuan_masa kosong dengan masa 30, dll.

Disertakan SQL untuk membersihkan invoice dobel yang SUDAH terlanjur dibuat
(sisakan 1 jatuh-tempo terawal per pelanggan, invoice LUNAS tak disentuh).


### 🐛 Edit pelanggan tak sengaja menggeser tgl_expired

Form edit pelanggan SELALU mengirim ulang tgl_expired dari field, walau admin
cuma mengubah data lain (mis. tanggal bergabung saat migrasi). Kalau nilai field
stale (tertinggal saat DB sudah berubah), simpan menggeser tgl_expired -> cron
membuat invoice baru. Ini memperparah invoice dobel.

Perbaikan (frontend): tgl_expired dikirim HANYA bila admin benar-benar mengubah
field-nya (dibandingkan dengan nilai saat form dibuka). Edit data lain tak lagi
menyentuh tgl_expired.

TIDAK ada dependensi npm baru.

## v1.14.1 — 16 Juli 2026

Rilis lanjutan v1.14.0. Memuat SEMUA perbaikan v1.14.0 (Ed25519 lisensi, RBAC,
dua deadlock RADIUS, fix aktivasi lisensi) + perbaikan reminder tagihan.

### 🐛 Reminder tagihan terkirim 2× dalam sehari (paket kosong, "Rp Rp")

Pelanggan menerima 2 pesan reminder untuk invoice yang sama di hari sama (mis.
00:27 & 10:11). Penyebab: ADA DUA cron reminder yang sama-sama kirim H-1 —
cron reminder utama + cron "REMINDER TERAKHIR" hardcoded jam 10:00. Cron kedua
query-nya tak ambil i.id → invoice_id NULL → "Paket: -", dan template menambah
"Rp" di depan jumlah yang sudah "Rp ..." → "Rp Rp 200.000".

### ✅ Perbaikan + fitur baru

- Cron kedua (jam 10 hardcoded) DIHAPUS, digabung ke cron utama.
- Setting baru `reminder_hari`: daftar titik reminder (mis. "3,0" = H-3 & H-0).
  Dropdown "Periode Notifikasi Invoice" di panel: H-1 (default) / H-3 / H-5 /
  H-2&H-0 / H-3&H-0 / H-5&H-0 / H-7&H-0 / H-5&H-2&H-0 / H-7&H-3&H-0.
- Query reminder selalu ambil i.id (invoice_id) + pk.nama (paket) → "Paket: -"
  & "Rp Rp" hilang.
- DEDUP: satu invoice hanya 1 reminder per hari, walau titik reminder bertumpuk.
- Auto-migrasi: setting reminder_hari ditambahkan otomatis saat boot (server.js).
  Default '1' (H-1) = perilaku sama seperti sebelumnya.

TIDAK ada dependensi npm baru. TIDAK perlu ubah update.sh.

## v1.14.0 — 14 Juli 2026

Rilis keamanan besar. Menutup jalur pembajakan lisensi, kebocoran data
pelanggan di endpoint publik, dan mengaktifkan penegakan hak akses (RBAC).

### 🔐 Anti-pembajakan lisensi (tanda tangan Ed25519)

Sebelumnya instance bisa dibajak dengan mengarahkan validasi ke **license
server palsu** yang selalu menjawab "valid". Sekarang setiap jawaban license
server **ditandatangani secara kriptografis** (Ed25519) dan diverifikasi di
sisi aplikasi dengan public key yang tertanam. Server palsu tak punya kunci
privat → tanda tangannya ditolak. Nonce acak tiap permintaan menutup
pemutaran ulang (replay) jawaban lama.

Selain itu:
- URL license server **dikunci** (tidak lagi bisa diubah dari panel/DB) —
  menutup trik mengarahkan ke server palsu.
- Masa toleransi **offline dibatasi 3 hari** sejak kontak sukses terakhir.
  Dulu, memblokir koneksi ke license server membuat aplikasi jalan terus
  tanpa validasi ulang; sekarang tidak lagi.

### 🔒 Kunci layar saat lisensi tidak sah

Bila penegakan lisensi aktif dan lisensi **ilegal atau kedaluwarsa**, panel
kini **mengunci diri untuk semua peran** dan menampilkan layar aktivasi
lisensi. Gangguan jaringan sementara (dalam masa toleransi 3 hari) tidak
memicu penguncian, sehingga pengguna sah tidak terganggu.

### 🛡️ Endpoint publik tidak lagi membocorkan data

`/voucher/isolir-info` (dipakai halaman tagihan pelanggan terisolir) dulu
mengembalikan **nomor HP** pelanggan dan bisa disalahgunakan untuk memanen
data seluruh pelanggan satu per satu. Sekarang nomor HP tidak lagi dikirim,
dan endpoint diberi **pembatas laju** (rate limit) untuk mencegah penyedotan
data massal.

### 👥 Penegakan Hak Akses (RBAC) siap dipakai

Layar "Hak Akses" kini benar-benar **ditegakkan** di backend (sebelumnya
pilihan izin tersimpan tapi tidak pernah dibaca). Endpoint yang dibutuhkan
semua peran saat panel dimuat (branding, status lisensi) dikecualikan agar
teknisi/operator tidak salah terblokir. Disertai utilitas **pre-flight
(`cek-enforce.js`)** untuk memeriksa kesiapan sebelum mengaktifkan penegakan.

Mode: `off` / `audit` (catat saja) / `enforce` (tolak). Diatur lewat setting
`rbac_mode`. Superadmin & admin selalu berakses penuh.

### 🔑 Penegakan lisensi kini aktif otomatis

Mulai versi ini, penegakan lisensi (`license_enforce`) **aktif secara otomatis**.
Instans dengan lisensi sah tetap berjalan normal; hanya lisensi yang tidak sah
(palsu, dicabut, atau kedaluwarsa) yang dikunci. Gangguan koneksi sementara ke
server lisensi tidak mengunci aplikasi (masa toleransi 3 hari).

### 🐛 Log MikroTik: berhenti spam "disconnect with no ip provided"

Saat voucher kedaluwarsa diproses, aplikasi dulu menembakkan permintaan putus
sesi ke **semua** router meski voucher sudah offline — memenuhi log MikroTik
dengan baris merah "Radius disconnect with no ip provided" yang menyesatkan
(router membalas ACK padahal tak ada sesi yang diputus). Kini alur kedaluwarsa
voucher tidak lagi melakukan tembakan sia-sia itu; voucher offline cukup
diputus lewat Session-Timeout. Alur pelanggan (nyangkut/PPPoE) tidak berubah.

### 🐛 KRITIS — deadlock voucher membuat RADIUS timeout

Gejala: MikroTik "RADIUS server timeout" + "accounting request not sent: no
response", sebagian pelanggan gagal login — padahal FreeRADIUS sehat.

`refreshSisaSessionTimeout()` (cron tiap 5 menit) men-UPDATE **seluruh** radreply
Session-Timeout untuk semua voucher `used` dalam **satu transaksi**. Dengan
puluhan ribu voucher (produksi: 16.057 baris Session-Timeout), itu mengunci
ribuan baris cukup lama sehingga query accounting FreeRADIUS kalah **deadlock**
→ timeout di MikroTik, berulang tiap 5 menit.

**Perbaikan:** refresh hanya voucher yang **sedang online** (sesi terbuka di
radacct), per-username dalam transaksi kecil. Beban lock turun ~99%. Aman karena
Session-Timeout hanya dibaca saat login, dan `syncVoucher()` sudah menghitungnya
ulang saat itu.


---

## v1.13.5 — 14 Juli 2026

Halaman cek voucher publik ditulis ulang. **Tiga bug, satu di antaranya membuat
pelanggan mengira vouchernya hangus padahal masih aktif.**

### 🐛 KRITIS — voucher yang MASIH AKTIF dibilang "Sudah Digunakan"

Voucher SimBill **tidak punya tanggal kadaluarsa saat dibuat**. `tgl_expired`
NULL; masa aktif baru dihitung dari **login pertama** (`tgl_digunakan` +
`masa_aktif` paket).

Artinya status `used` **tidak berarti voucher habis** — voucher yang sedang
dipakai pelanggan juga berstatus `used`. Tapi halaman menampilkan **"⚠️ Voucher
Sudah Digunakan"**, sehingga pelanggan yang vouchernya **masih berlaku 7 hari
lagi** mengira sudah hangus dan membeli voucher baru.

**Perbaikan:** sisa waktu dihitung sungguhan, dan keadaannya dibedakan:

- **Voucher Masih Baru** — belum pernah login; masa aktif belum berjalan
- **Voucher Masih Aktif** — sudah login, **sisa waktu ditampilkan besar**
- **Masa Aktif Sudah Habis** — baru di sini pelanggan disuruh beli lagi

### 🐛 Tanggal kadaluarsa SALAH di halaman publik

Halaman publik membaca kolom `tgl_expired` mentah — kolom yang **tidak bermakna**
untuk voucher. Akibatnya halaman publik dan panel admin **tidak sepakat**:

```
voucher VESFWDYZ5, login pertama 21 Juni 17.00, paket 1 bulan
  halaman publik : 01 Juli 2026, 22.55   ← SALAH
  panel admin    : 21 Juli 2026, 17.00   ← benar
```

**Perbaikan:** kadaluarsa dihitung dari `tgl_digunakan + masa_aktif` — **rumus
yang sama persis** dengan `refreshSisaSessionTimeout()` di `services/radius.js`,
supaya angka yang dilihat pelanggan sama dengan yang dipakai RADIUS.

### 🐛 "Masa aktif: 1" — satu apa?

Angka mentah dari database tanpa satuan. Sekarang: **"1 bulan"**, **"3 hari"**,
**"12 jam"**.

### 🔒 Endpoint tidak lagi membocorkan password voucher

`/voucher/cek` dulu `SELECT v.*` — mengirim **password voucher** dan kolom
internal ke publik. Sekarang hanya field yang ditampilkan.

---

