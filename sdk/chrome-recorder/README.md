# TestPilot Web Recorder (Chrome Extension)

Ekstensi Chrome (Manifest V3) untuk merekam interaksi website secara langsung di browser (termasuk `localhost`, VPN internal, dan `iframe`) menjadi script **Playwright TypeScript** (`playwright-ts`) dan mengirimkannya langsung ke `ScriptRunnerService` TestPilot.

## Cara Pasang (Load Unpacked)

1. Buka Chrome dan kunjungi `chrome://extensions/`.
2. Aktifkan **Developer mode** di pojok kanan atas.
3. Klik **Load unpacked**, lalu pilih folder `sdk/chrome-recorder/` ini.

## Cara Menggunakan

1. Buka Test Case mana saja di TestPilot → masuk ke tab **Automation / Script**.
2. Isi **Target URL** (mis. `http://localhost:3000/login`), lalu klik **Record with Extension**.
3. Tab baru akan terbuka ke Target URL dengan **Floating Recorder Modal** (Shadow DOM).
4. Lakukan interaksi (klik, ketik, pilih dropdown, toggle **Assert Mode** untuk menambah `expect(...)`), lalu klik **Save & Run**.
