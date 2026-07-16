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
