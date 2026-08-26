# Günlük kullanım

Lane'ler koşmaya başladıktan sonra sana üç şey düşer: onaylar, başarısızlıklar
ve biten işi dışarı almak. Bu sayfa aralarında ne yaptığın.

## Komutlar

```bash
bun run start                                     # hub ve pano
bun run conductor --loop                          # sürekli drain
bun run conductor                                 # tek pass, sonra çık

bun scripts/new-lane.ts <id> <brief> <paths...>   # lane kaydet
bun run build-candidate <plan-id>                 # biten plan revizyonunu entegre et
bun run reset-stranded --dry-run                  # çöküşün geride bıraktığı
bun run teardown <lane-id>                        # lane'in worktree, dal ve veritabanını kaldır
```

## Pano

[http://127.0.0.1:8787](http://127.0.0.1:8787). Yoklama yapmaz: sayfa tek bir
olay akışı açar ve bir şey değiştiğinde hub gönderir; bu yüzden başlığın
yanındaki gösterge `live` yazar, hub gittiyse `disconnected, retrying`.

**Plan kartları** revizyonları, hangisinin en yeni olduğunu, kimin onayladığını
ve o revizyonun doğrulama merdivenini taşır: construction, clean run, reader;
her biri durumu ve deneme numarasıyla, ayrıca karşılanmayan clean-run
beklentileri adlarıyla. Açık reader bulguları revizyonun altında, konumları
`path:start-end (side)` biçiminde listelenir.

**Lane kartları** bir durum rozeti taşır (`pending`, `running`,
`waiting_approval`, `completed`, `failed`), ardından lane tipi, deneme sayısı,
lane'in en son ne zaman hareket ettiği ve sahip olduğu yollardan oluşan bir özet
satırı. Altında: en yeni on kanıt, her onay kararıyla ve kimin çözdüğüyle, ajan
logunun canlı kuyruğu ve dosyanın tamamına giden `whole log` bağlantısı.

Seni bekleyen bir lane, soruyu alıntı olarak ve altında `approval_id` ile
gösterir. Geri göndereceğin şey o id'dir.

## Şu anda bana ne düşüyor {#pending}

```bash
curl -s http://127.0.0.1:8787/pending
```

Tek yanıtta üç liste:

- **`waiting_approval`**: soru soran lane'ler ve aday inşası başarısız olan plan
  revizyonları. Her biri soru metnini ve id'yi taşır.
- **`failed`**: denemeleri tükenen lane'ler.
- **`findings`**: açık reader bulguları, en yeniden eskiye, ait oldukları plan ve
  revizyonla birlikte.

Masaüstü bildiricisi ve Claude Code köprüsü de aynı sorguyu okur; boşsa hiçbir
şey engellenmiş değildir.

## Onay çözmek

```bash
curl -s -X POST http://127.0.0.1:8787/approvals/<approval_id> \
  -H 'content-type: application/json' \
  -d '{"resolved_by":"human","decision":"Yes. Rejecting an empty password is in scope; do not touch the session code."}'
```

`resolved_by` zorunludur, `human` veya `claude`. `decision` serbest metindir ve
lane'in gördüğü şeydir: yeniden gönderildiğinde orijinal brief'in altına
`--- APPROVAL DECISION ---` başlığıyla eklenir. Kendine not gibi değil, talimat
gibi yaz. `verified_by` isteğe bağlıdır ve iddiayı kimin doğruladığını kaydeder.

Bir onay yalnızca bir kez çözülebilir; ikinci deneme `409 approval already
resolved` yanıtını alır.

## Bildirimler

Dört sınıf, ikisi varsayılan olarak açık:

| Sınıf | Ne zaman | Varsayılan |
|---|---|---|
| `approval_required` | Bir lane veya plan revizyonu insan bekliyor | açık |
| `lane_failed` | Bir lane `failed` oldu | açık |
| `plan_ready_for_review` | Bir revizyonun bütün lane'leri `completed` | kapalı |
| `findings_to_adjudicate` | Reader bulguları var ve kimse karar vermedi | kapalı |

`LANEWARD_NOTIFY` ile ayarlanır; boş değer masaüstü bildirimini tamamen kapatır.
Teslim Linux'ta `notify-send`, Windows'ta bir toast'tur. **macOS hiçbir şey
almaz**, `desktop notification unavailable on darwin` diye loglanır; pano ve
`GET /pending` yine her şeyi taşır.

Bildirim, koşul başına bir kez gönderilir ve koşul ortadan kalkınca temizlenir;
yani `failed` kalan bir lane sana saniyede bir toast atmaz.

## Loglar

Tek dizin, `LANEWARD_LOG_DIR` ya da platformun durum dizini:

| Dosya | İçeriği |
|---|---|
| `<lane_id>.log` | Ajanın yazdığı her şey. Her denemeden önce boşaltılır, yani hep güncel koşu. |
| `<lane_id>.git-guard.jsonl` | Shim'in reddettiği her git çağrısı için bir satır: argümanlar ve okuma gibi görünüp görünmediği. |
| `<lane_id>.check-<n>-<ad>.log` | Tanımlı bir lane kontrolünün çıktısı. |
| `<plan_revision_id>.log` | Bir aday inşası. |
| `<worktree>.reader.log` | Bir reader koşusu. |

Pano da aynı dosyaları okur; `whole log` ile `cat` aynı şeyi gösterir.

## Çöküşten sonra

Uyarısız öldürülen bir conductor, yeniden başlatma veya durdurulan bir Windows
görevi, lane'leri arkalarında hiçbir şey olmadan `running` bırakır.

```bash
bun run reset-stranded --dry-run         # listele, hiçbir şeyi değiştirme
bun run reset-stranded                   # pending'e döndür
bun run reset-stranded --lane fix-login  # yalnızca bunu
bun run reset-stranded --failed          # gerçekten başarısız lane'leri yeniden dene, deneme sayacı sıfırlanır
```

Sahipsiz kalan lane deneme sayısını korur, çünkü o denemeyi ajan değil makine
aldı. Sade bir koşu, aynı çöküşün `running` bıraktığı bir construction denemesini
de geri kazanır.

!!! warning "`reset-stranded` çalışan her lane'i sıfırlar"

    Sahipsiz lane ile sağlıklı olanı ayırt edemez. Önce conductor'ı durdur,
    yoksa çalışan bir lane'in altından zemini çekersin.

Linux'ta `SIGTERM` ile durdurulan bir conductor hiçbir şeyi sahipsiz bırakmaz:
ajanlarını öldürür, her lane'i hub'a geri teslim eder ve 0 ile çıkar. Windows'ta
yakalanabilir `SIGTERM` yoktur, bu yüzden zamanlanmış görevi durdurmak her zaman
sahipsiz lane bırakır ve kurtarma `reset-stranded`'dır.

## İşi almak ve temizlik

Laneward asla commit, merge veya push etmez. Biten iş, lane'in worktree'sinde
`lane/<lane_id>` dalında commit edilmemiş durur. İncele, commit et, kendi
deponda merge et, sonra:

```bash
bun run teardown fix-login
```

Teardown lane veritabanını düşürür, worktree'yi kaldırır ve dalı siler; worktree
kirliyken veya dal senin deponun taşımadığı commit'ler taşırken hiçbir şeyi
kaldırmayı reddeder. Ne bulduğunu adıyla söyler ve entegre etmediğin hiçbir şey
senin yerine silinmez.

Hiç çalışmamış bir lane'i kayıttan düşürmek için `DELETE /lanes/:id` yeterlidir;
çalışan bir lane `409 cannot delete a running lane` ile reddedilir.
