# AetherSL — اتر اس‌ال

اپ دسکتاپ **ویندوز + لینوکس** که **Aether** و **Serverless-for-Iran** را **همزمان** اجرا می‌کند،
با رول‌های سفارشی خودت و TUN با **Zeptun**.

> **دو mode یعنی چه؟** (اصلاحیه آرش، 2026-11-05)
>
> - 🧩 **Frag (Serverless)** — رفع **DNS hijacking** + fragment برای SNI، با **IP واقعی ایرانی**.
>   برای سایت‌هایی که داخل شبکه ایران با DNS hijacking بسته شده‌اند (مثل Discord).
> - ☁️ **Tunnel (Aether)** — عبور از **فیلتر ISP**؛ ولی خروجی Aether هم فعلاً **IP ایران** است،
>   پس برای سرویس‌هایی که IP ایران را تحریم/بلاک کرده‌اند (مثل OpenAI و...) راه‌حل نیست.
> - تازگی‌ها WARP/MASQUE با همین نت ایران **IP ایران** می‌دهند (قبلاً IP آلمان می‌داد) و IP همان
>   IP نت عادی است — فقط فیلترینگ رفع می‌شود. کارت Aether در اپ هم IP قبل/بعد و هم `warp=on/off`
>   را نشان می‌دهد: IP یکسان + `warp=on` یعنی egress کلادفلر در ایران است؛ `warp=off` یعنی تانل
>   وصل نشده و ترافیک نشت می‌کند.
> - سایت‌هایی که از خارجِ ایران را تحریم کرده‌اند با این IP کار نمی‌کنند — برای آرش مهم نیست؛
>   هشدار در UI فقط اطلاع‌رسانی است، نه بلاک‌کننده.

## معماری

```
            ┌─────────────────────┐
            │  Aether (WARP)      │  SOCKS5 روی 127.0.0.1:1819
            │  MASQUE / WG / GOOL │
            └──────────┬──────────┘
                       │ aether-out (SOCKS5)
            ┌──────────▼──────────┐
  TUN ─────►│  Xray (mixed)       │◄──── پراکسی سیستمی (اختیاری)
  Zeptun    │  127.0.0.1:10808    │
  (TUN →    │  routing rules:     │
   SOCKS5   │  بلاک تبلیغات ← رول‌های کاربر ← direct داخلی ← DNS ← پیش‌فرض
  به 10808) └──────┬───┬──────────┘
                   │   │
        tcp-fragment-tls / tcp-fragment / udp-noises (Serverless)
        tcp-direct / udp-direct / dns-out / block
```

- **نقطه ورود واحد: Xray** با inbound mixed روی `127.0.0.1:10808`. همه ترافیک (پراکسی سیستمی یا TUN)
  اول می‌رسد به Xray.
- **Aether جداگانه** روی `127.0.0.1:1819` (SOCKS5) اجرا می‌شود؛ Xray یک outbound اضافه دارد:
  `aether-out` → `127.0.0.1:1819`.
- **Zeptun جداگانه:** TUN ← SOCKS5 به `127.0.0.1:10808` (یعنی به Xray) — پس TUN هم از همان رول‌ها عبور می‌کند.
- **حالت‌ها:** Hybrid (رول‌ها تصمیم می‌گیرند)، Serverless-only، Aether-only. این حالت‌ها فقط
  `defaultTarget` و catch-all را عوض می‌کنند؛ هر دو هسته همیشه بالا می‌مانند تا سوییچ فوری باشد.
- **Serverless نیازی به UUID ندارد.**

## رول‌های کاربر — مرجع: فایل خودت

فایل مرجع `configs/rules.user.json` است (کپی فایل خود کاربر؛ `configs/rules.example.json` هم همان است).
فرمت: `{ formatVersion: 1, rules: [...] }` — هر گروه:

| فیلد | معنی |
|---|---|
| `name` | نام گروه (Discord / Telegram / Youtube / Downloads) |
| `mode` | `frag` = Serverless ، `tunnel` = Aether |
| `transport` | `both` = tcp+udp هر دو به همان مقصد |
| `enabled` | فعال / غیرفعال |
| `domains` | لیست دامنه‌ها |
| `note` | یادداشت گروه |

| گروه | mode | چرا؟ |
|---|---|---|
| Discord (10 دامنه) | Frag | **DNS hijacking** — دیسکورد داخل ایران با هایجک DNS بسته شده و با Frag/DoH درست می‌شود؛ آدرس واقعی ایرانی حفظ می‌شود. |
| Telegram (14 دامنه) | Tunnel | **فیلتر ISP** — تلگرام از سمت ISP فیلتر شده و فقط با تانل باز می‌شود؛ IP ایران مشکلی ندارد. (note قدیمی فایل که می‌گفت «تلگرام IP ایرانی را قبول نمی‌کند» اشتباه بود و در کپی اپ اصلاح شد؛ فایل اصلی کاربر دست نخورده.) |
| Youtube (9 دامنه) | Tunnel | پیش‌فرض تانل (Aether). |
| Downloads (2 دامنه) | Frag | دانلود از طریق Frag. |

- در UI هر گروه توضیح خودش را نشان می‌دهد؛ تغییر mode با **یک کلیک** (frag ⇄ tunnel)،
  فعال/غیرفعال، افزودن دامنه به گروه، ایمپورت/اکسپورت JSON با همین فرمت.
- چهار گروه با **اولین اجرای اپ** به‌صورت پیش‌فرض لود می‌شوند و در `rules.json` داخل پوشه
  userData اپ ذخیره می‌شوند (نه در ریپو).
- ترتیب نهایی در کانفیگ Xray (first-match wins): ۱) بلاک تبلیغات ۲) همین گروه‌ها (به ترتیب فایل)
  ۳) دامنه‌های داخلی Serverless → مستقیم ۴) DNS ۵) پیش‌فرض (catch-all).

### منطق no-filter-dns

- اگر **حداقل یک رول frag فعال** باشد (`hasFrag=true`)، رول `inboundTag: no-filter-dns` به
  `tcp-fragment-tls` می‌رود تا DoH فرانت‌شده دوباره outbound محافظت‌شده بگیرد.
- اگر **هیچ frag فعالی نباشد**، آن رول کلاً حذف (غیرفعال) می‌شود.
- اگر resolver با frag هنوز EOF بدهد، frag روی آن شبکه غیرقابل‌استفاده است و گروه باید برگردد به تانل
  (همان‌طور که note دیسکورد می‌گوید).

### پروفایل Serverless: fragB پیش‌فرض

- فایل‌های پایه کپی verbatim از upstream v58 هستند:
  `configs/serverless-fragB.base.jsonc` (پیش‌فرض)، `serverless-fragA.base.jsonc`، `serverless-oob.base.jsonc`.
- **مقایسه انجام‌شده:** fragA و fragB فقط در **دو خط** فرق دارند — fragment lengths در
  `tcp-fragment-tls` و `tls-repack-dns` از `["6", "99", "1"]` (fragA) به `["0", "105", "1"]` (fragB)؛
  بقیه فایل عین هم است (تست یونیت این را چک می‌کند).
- پروفایل `oob` یک outbound اضافه `tcp-oob` با `dialMode` دارد؛ در این پروفایل ترافیک TCP گروه‌های
  frag به `tcp-oob` می‌رود. سوییچ fragA/fragB/oob از تب تنظیمات است.
- برای Serverless حتماً از فورک **patterniha/Xray-core (حداقل 26.11.1، با finalmask)** استفاده کنید،
  نه Xray اصلی.

## نصب و اجرا

```bash
npm install
npm run download-cores   # دانلود آخرین ریلیز Xray (فورک patterniha)، Aether، Zeptun به cores/<os>-<arch>/
npm run dev              # حالت توسعه (Vite + Electron)
npm test                 # تست‌های یونیت (node:test)
npm run build            # بیلد رندرر + Electron
npm run dist:win         # خروجی ویندوز (NSIS + portable)
npm run dist:linux       # خروجی لینوکس (AppImage + deb)
```

باینری‌ها هرگز کامیت نمی‌شوند (فقط اسکریپت دانلود + `cores/` در `.gitignore`).
روی ویندوز `wintun.dll` را کنار `zeptun.exe` بگذار (از https://www.wintun.net).

## اسکن IP — اسکنر اندپوینت (Endpoint Scanner)

تب **🔍 اسکنر اندپوینت** در UI، endpoint discovery خود Aether را از داخل اپ اجرا و کنترل می‌کند
(نه از ترمینال). Aether دستور scan جداگانه ندارد؛ اسکن موقع استارت اتفاق می‌افتد — پس اسکنر یک
پروسس جداگانه Aether را با همان فلگ‌ها اجرا می‌کند (روی پورت **1820** تا با هسته اصلی روی 1819
تداخل نکند)، stdout/stderr را زنده parse می‌کند و کاندیدها را در جدول نشان می‌دهد.

**کنترل‌ها:**

| کنترل | گزینه‌ها |
|---|---|
| Scan mode | `turbo` (اولین جواب‌دهنده) · `balanced` (پیش‌فرض؛ چندتا جمع می‌کند و سریع‌ترین را نگه می‌دارد) · `thorough` (کل رنج را می‌گردد) · `stealth` (پروب کم) · `ironclad` (تانل کامل + ریکوئست واقعی برای هر کاندید) |
| IP version | هر دو · فقط IPv4 (`-4`) · فقط IPv6 (`-6`) |
| پروتکل | `masque` (HTTP/3) · `masque --h2` (HTTP/2 روی TCP 443) · `wg` (WireGuard روی UDP 2408) · `gool` (WireGuard روی MASQUE) |

**جدول نتایج:** هر سطر `IP:port`، وضعیت (`ok` / `failed` / `cooldown`)، latency، منبع
(لاگ Aether یا fallback probe) و دکمه **«استفاده از این اندپوینت»**.

- با کلیک، آن `IP:port` به‌عنوان `--peer` در تنظیمات Aether ذخیره می‌شود و Aether با آن peer
  ری‌استارت می‌شود (اسکن رد می‌شود).
- **«پاک کردن peer»** برمی‌گرداند به اسکن خودکار.
- **آخرین اندپوینت خوب (last known-good)** ذخیره می‌شود و در UI نشان داده می‌شود، با دکمه
  **Quick Reconnect** (`--quick-reconnect` + peer) که بدون sweep دوباره وصل می‌شود.
- دکمه‌های **Stop Scan / Rescan** و نمایش پیشرفت (در حال اسکن…، چند کاندید تست شد، چند ثانیه گذشته).
- handshake به‌تنهایی کافی نیست: کاندید باید **data-plane** را هم پاس کند تا انتخاب شود؛
  اندپوینتی که تازه fail شده روی **cooldown** می‌ماند.

**peer دستی کی به درد می‌خورد؟** وقتی اسکن خودکار کند است یا یک IP خاص خوب جواب می‌دهد —
آن را قفل کن؛ اگر خراب شد، peer را پاک کن تا اسکن خودکار برگردد.

**Fallback probe:** اگر لاگ Aether کاندیدی نداد (یا دکمه «فقط fallback probe» را زدی)، اپ خودش
رنج‌های مستند Cloudflare WARP را پروب می‌کند
(`162.159.192.0/24`، `162.159.193.0/24`، `162.159.195.0/24`، `162.159.196.0/24`،
`162.159.204.0/24`، `188.114.96.0/24`–`188.114.99.0/24`؛ پورت‌های 443، 500، 1701، 4500،
4443، 8443، 8095 برای MASQUE و 2408 برای WG) با TCP connect (+ پروب UDP).
هشدار صادقانه: اندپوینت‌های WARP سرویس UDP هستند و به پروب بدون handshake جواب نمی‌دهند؛
پس «ok» در fallback فقط یعنی پورت در دسترس است، نه اینکه تانل حتماً کار می‌کند —
اعتبارسنجی واقعی همان data-plane خود Aether است.

## IP خروجی و warp

کارت Aether سه مسیر را کنار هم نشان می‌دهد (قبل/بعد):

1. **بدون تانل (مستقیم)** — IP عادی نت (مبنا).
2. **با Aether (SOCKS :1819)** — IP خروجی تانل + `warp=on/off` از
   `https://www.cloudflare.com/cdn-cgi/trace`.
3. **از مسیر پیش‌فرض Xray (:10808)** — IP مسیر فعلی رول‌ها.

تفسیر: IP یکسان + `warp=on` یعنی egress کلادفلر در ایران است (نه نشت)؛ `warp=off` یعنی تانل
وصل نشده. برای خواندن IP از مسیر تانل، درخواست trace از داخل همان تانل فرستاده می‌شود
(SOCKS5 به 1819 / HTTP CONNECT به 10808) — نه مستقیم.

## TUN و پراکسی سیستمی

- **TUN خاموش/روشن** جداگانه از پراکسی است. وقتی روشن است Zeptun اجرا می‌شود؛ وقتی خاموش است
  فقط پراکسی سیستمی (اختیاری، دکمه Set System Proxy) فعال است.
- **لینوکس:** TUN به `sudo` یا `CAP_NET_ADMIN` نیاز دارد.
- **ویندوز:** TUN به نصب Wintun + اجرا به‌عنوان **Administrator** نیاز دارد.
- Exclude پیش‌فرض Zeptun: `192.168.0.0/16`، `10.0.0.0/8`، `172.16.0.0/12`، `127.0.0.0/8` +
  IPهای Cloudflare WARP (`162.159.192.0/24`، `162.159.193.0/24`، `162.159.204.0/24`،
  `188.114.96.0/24`) تا لوپ نخورد.

## عیب‌یابی

| مشکل | چه کار کن |
|---|---|
| Aether بالا نمی‌آید | لاگ تب لاگ را ببین؛ باینری را با «دانلود هسته‌ها» بگیر؛ مطمئن شو پورت 1819 آزاد است. |
| TUN کار نمی‌کند | لینوکس: با `sudo` اجرا کن یا `setcap cap_net_admin=+ep`؛ ویندوز: Administrator + `wintun.dll` کنار `zeptun.exe`. |
| Discord با frag باز نمی‌شود | اگر resolver هنوز EOF می‌دهد، frag روی آن شبکه جواب نمی‌دهد — گروه Discord را برگردان به Tunnel. |
| اسکن کاندیدی نمی‌دهد | mode را `thorough` یا `ironclad` بگذار؛ پروتکل را عوض کن (`masque --h2` وقتی UDP بسته است)؛ یا fallback probe را امتحان کن. |
| IP خروجی همان IP عادی است | طبیعی است (تازگی‌ها egress کلادفلر در ایران است) — به `warp=on` نگاه کن، نه فقط به IP. |
| resolver / DoH خطا می‌دهد | `hasFrag` را چک کن: با حداقل یک گروه frag فعال، رول no-filter-dns به `tcp-fragment-tls` می‌رود. |

## لایسنس‌ها

- Aether (CluvexStudio/Aether) — **AGPL-3.0** — https://github.com/CluvexStudio/Aether
- Serverless-for-Iran (patterniha) — **GPL-3.0** — https://github.com/patterniha/Serverless-for-Iran
- Xray-core (XTLS) — **MPL-2.0** — https://github.com/xtls/xray-core
  (برای Serverless از فورک patterniha/Xray-core استفاده می‌شود)
- Zeptun (Noisemux/zeptun) — **MIT** — https://github.com/Noisemux/zeptun
- خود AetherSL — MIT (به `package.json` نگاه کن).

هیچ رمز/UUID/کانفیگ شخصی در کد hardcode نشده است.
