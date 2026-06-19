Taruh library JS pihak ketiga di folder ini agar di-host dari server sendiri
(berguna kalau jaringan browser memblokir CDN).

Unduh sekali di server (server punya internet):

  cd /root/billing-radius/frontend/vendor
  curl -L -o html2pdf.bundle.min.js https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js
  curl -L -o qrcode.min.js          https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js

File akan ter-serve di /vendor/html2pdf.bundle.min.js dan /vendor/qrcode.min.js
