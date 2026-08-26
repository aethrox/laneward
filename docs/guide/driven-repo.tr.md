# Sürülen depoyu hazırlamak

Laneward, kendisinden habersiz bir depoyu da sürebilir: aşağıdakilerin hiçbiri
lane çalıştırmak için zorunlu değil. Manifesto sana güvenilecek bir karar
kazandırır. Manifesto olmadan `completed` yalnızca "ajan 0 ile çıktı ve
yollarının içinde kaldı" demektir.

Manifesto, sürülen deponun kökünde `.laneward/project.json` dosyasıdır ve
lane'in worktree'sinden okunur.

## Dosyanın tamamı

Laneward'ın kendi manifestosu her bölümün işlenmiş bir örneğidir:

```json
{
  "version": 1,
  "checks": {
    "lane": [
      { "name": "test", "command": ["bun", "test"] }
    ]
  },
  "reader": {
    "test_paths": ["tests"]
  },
  "clean_run": {
    "shell": { "win32": ["bash", "-lc"], "linux": ["bash", "-lc"] },
    "environment": { "PORT": "8799" },
    "seed": "bun run scripts/seed-clean-run.ts",
    "seed_timeout_ms": 30000,
    "start": "exec bun run start",
    "observation_window_ms": 8000,
    "expectations": [
      {
        "name": "approval_required notification is delivered",
        "must_appear": "desktop notification sent: approval_required"
      },
      {
        "name": "notification delivery does not fail",
        "must_not_appear": "desktop notification failed:"
      }
    ]
  }
}
```

`version` tam olarak `1` olmalıdır. Başka bir değer veya ayrıştırılamayan JSON,
manifestoyu bütünüyle `unrunnable` yapar; kontrolleri koşamayan bir lane
puanlanmak yerine bir insan için durur.

## `checks.lane`: her lane'den sonra ne koşar

Her girdinin boş olmayan bir `name`'i ve boş olmayan dizgelerden oluşan bir
`command` dizisi olmalıdır. Adlar benzersizdir; tekrar eden bir ad sessiz bir
üzerine yazma değil, manifesto hatasıdır.

```json
"checks": {
  "lane": [
    { "name": "typecheck", "command": ["bun", "run", "typecheck"] },
    { "name": "test", "command": ["bun", "test"] }
  ]
}
```

Her komut çalışma dizini worktree olacak şekilde koşar ve devralınan ortamdan
`DATABASE_URL` çıkarılır; böylece komut lane'in kendi `.env`'ini ve kendi
veritabanını okur. Çıktı `<log dizini>/<lane_id>.check-<n>-<ad>.log` dosyasına
gider ve sonuçlar lane'e karşı kanıt olarak kaydedilir: panoda ve
`GET /lanes/:id/evidence` üzerinden görünür.

Genel karar en kötü olandır: `unrunnable` bir kontrol varsa koşu unrunnable,
yoksa başarısız bir kontrol varsa failed, yoksa passed. Tanımlı kontrolü olmayan
bir lane `not_configured` kaydeder ki bu bir başarısızlık değildir.

| Sonuç | Lane ne yapar |
|---|---|
| passed | `completed`'a devam eder. |
| failed | `waiting_approval`'a park eder: `lane <id> failed its lane checks: test`. |
| unrunnable | Gerekçesiyle park eder, örneğin bir timeout. |

Bir kontrol `LANEWARD_CHECK_TIMEOUT_MS` sonunda, varsayılan on dakikada
öldürülür ve `timed out after 600000 ms` ile `unrunnable` kaydedilir.

!!! tip "Brief'lerinin zaten söz verdiği komutu tanımla"

    Bir brief'teki [bitmiş sayılma ölçütü](writing-briefs.md#definition-of-done)
    ile tanımlı lane kontrolleri aynı zemin olmalı. Brief `bun test tests/auth`
    yeşil diye söz veriyorsa ve hiçbir kontrol bir şey koşmuyorsa, o sözü kimse
    ölçmemiştir.

## `reader.test_paths`: reader'ın neyi incelediği

Boş olmayan bir yol dizisi. Adayın diff'ini ikiye ayıran pathspec olarak
kullanılır: testler reader'ın konusudur, geri kalan her şey okuyabildiği ama
incelemediği bağlamdır.

```json
"reader": { "test_paths": ["tests", "spec"] }
```

Eksik veya bozuksa reader katmanı tahminle koşmak yerine gerekçesiyle `skipped`
kaydedilir. Reader tavsiye niteliğindedir ve asla engellemez; bkz.
[Planlar ve yetki](plans-and-authority.md#the-reader).

## `clean_run`: adayı yeni bir makinenin kuracağı gibi kurmak {#clean-run}

Clean-run katmanı kendi başına bir şey inşa etmez. Entegrasyon adayını sıfırdan
başlatır, çıktısını sabit bir pencere boyunca izler ve görülenleri senin
tanımladığın beklentilere göre puanlar.

| Anahtar | Zorunlu | Anlamı |
|---|---|---|
| `shell` | evet | Platform başına yorumlayıcı, `process.platform` ile anahtarlanır (`linux`, `win32`). Kendi platformun bulunmalı. |
| `environment` | hayır | Koşu için ek değişkenler. `DATABASE_URL` reddedilir: aday kendi veritabanını alır. |
| `seed` | hayır | Başlatmadan önce koşan komut, fixture için. |
| `seed_timeout_ms` | hayır | Seed'in tavanı. Varsayılan `30000`. |
| `start` | evet | Şeyi başlatan komut. |
| `observation_window_ms` | evet | Çıktısının ne kadar izleneceği. |
| `expectations` | evet | Adlandırılmış desenler; her birinde `must_appear` veya `must_not_appear`'dan tam olarak biri. |

Her beklentinin benzersiz bir adı ve tam olarak bir deseni olmalıdır; desen çok
satırlı bir düzenli ifade olarak derlenir. Bir beklentide iki desen de, hiç desen
olmaması da yanlıştır ve yarım uygulanmak yerine manifesto hatası sayılır.

`LANEWARD_CLEAN_RUN_SHELL` yorumlayıcıyı değiştirir ve mutlak yol olmalıdır.
Windows'ta `System32` altındaki bir yorumlayıcı reddedilir, çünkü oradaki `bash`
WSL'dir ve adayın inşa edildiğinden bambaşka bir işletim sistemi başlatır.

## Bunun kazandırdığı

Üç bölüm de tanımlıysa, lane'lerinin tamamı `completed` olan bir plan revizyonu
bir adaya inşa edilir, temiz kurulur, başlatılır, izlenir ve okunur; her katmanın
sonucu revizyona karşı kaydedilir ve panoda gösterilir. Tanımlı değilse aynı
revizyon sana bir avuç yeşil lane ve birlikte çalıştıklarına dair hiçbir kanıt
olmadan ulaşır.
