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
