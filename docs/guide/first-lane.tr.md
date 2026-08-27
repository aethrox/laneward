# İlk lane

Gerçek bir iş burada baştan sona Laneward'dan geçiyor: bir brief, bir lane, bir
ajan, bir karar ve iş senin elinde. Çalışan bir hub ve tanımlı bir ajan
gerekiyor ([Kurulum](install.md), [Yapılandırma](configure.md)).

## 1. Brief yaz

Ajan, bu işi üreten konuşmayı göremez; o yüzden konuşmanın tamamını brief
taşımak zorunda. [Şablonu](../brief-template.md) kopyalayıp doldur; hangi
brief'in doğru puanlandığını [Brief yazmak](writing-briefs.md) anlatıyor.

Şimdilik işe yarayan en kısa hâli:

```markdown
## Task: make the login form reject an empty password

Working directory: `/home/you/your-repo-worktrees/fix-login`

## Context
`src/auth/login.ts` submits with an empty password field and the server
returns 500.

## Scope
You own exactly these files:
- `src/auth/login.ts`
- `tests/auth/login.test.ts`

Do NOT touch anything else, and never anything under `.git`.

## Definition of done
- `bun test tests/auth` is green.
- No file outside the owned list is modified.

## Escalation: read this before you stop
If the brief is wrong or ambiguous, change nothing and print, on a line of its
own: `APPROVAL REQUIRED: [your question]`
```

`brief.md` olarak kaydet.

!!! note "Brief neden İngilizce"

    Bu deponun kuralı: kod, yorumlar, testler ve dokümanlar İngilizce. Lane'in
    ürettiği her şey, eskalasyon mesajları dâhil, aynı kurala tabi. Bir lane
    eskalasyonunu Türkçe yanıtladığı için bu cümle brief şablonuna girdi.

## 2. Lane'i kaydet

```bash
LANE_REPO=/home/you/your-repo \
  bun scripts/new-lane.ts fix-login brief.md 'src/auth/*' 'tests/auth/*'
```

!!! danger "Owned path bir dizin değil, dosya yolları üzerinde bir glob'dur"

    `src/auth`, `src/auth` adlı dosyayla eşleşir, başka hiçbir şeyle değil.
    `src/auth/login.ts`'i **kapsamaz** ve o dosyayı düzenleyen lane, işi doğru
    olsa bile sahiplik ihlalinden başarısız olur. `*` bir `/` geçmez; iç içe
    dosya kendi desenini ister: `'src/auth/*'` bir seviyeyi,
    `'src/auth/*/*'` bir sonrakini kapsar. Ölçülmüş gösterim
    [Brief yazmak](writing-briefs.md#owned-paths) sayfasında.

Betiğin bayrağı yoktur. Opsiyonel olan her şey bir ortam değişkenidir:

| Değişken | Varsayılan | Etkisi |
|---|---|---|
| `LANE_REPO` | Laneward'ın kendi klonu | Lane'in üzerinde çalışacağı depo. |
| `LANE_WORKTREE_ROOT` | deponun yanında `<repo>-worktrees` | Worktree'nin oluşturulduğu yer. |
| `LANE_TYPE` | `write` | `write` veya `read_review`. |
| `LANE_MODEL` | `balanced` | `fast`, `balanced` veya `deep`. |
| `LANE_DEPENDS_ON` | yok | Önce `completed` olması gereken, boşlukla ayrılmış lane id'leri. |
| `LANE_PLAN_REVISION_ID` | yok | Lane'i bir plan revizyonuna bağlar. Bkz. [Planlar ve yetki](plans-and-authority.md). |
| `HUB_URL` | `http://127.0.0.1:8787` | Kaydın gideceği yer. |

Lane id bir slug'dır: harf, rakam, nokta, alt çizgi ve tire; harf veya rakamla
başlar, en çok 64 karakter. Bir dizini ve bir dalı adlandırdığı için başka her
şey, kuralın kendisi yazılarak reddedilir.

### Sırayla ne yaratır

1. `git worktree add -b lane/fix-login <root>/fix-login`
2. sürülen deponun `.env`'inin worktree'ye kopyası; `DATABASE_URL` bu lane için
   açılan veritabanına (`<veritabanın>_lane_fix_login`) yeniden yazılır
3. worktree içinde `bun install`
4. sürülen depo bu betiği tanımlıyorsa worktree içinde `bun run db:migrate`
5. hub'a kayıt

Başarıda ihtiyacın olan üç şeyi yazar:

```
Worktree: /home/you/your-repo-worktrees/fix-login
Lane: fix-login
Database: your_repo_lane_fix_login
```

Worktree oluştuktan sonra bir şey başarısız olursa geri alınır: lane veritabanı
düşürülür, worktree kaldırılır, dal silinir. Elinde elle temizlenecek enkaz
kalmaz.

!!! note "`bun install` çıktısı senin yerine owned path'lere eklenir"

    `bun install`'un ilk kez yazdığı bir lockfile, aksi hâlde ajanın sahip
    olmadan dokunduğu bir dosya olarak puanlanırdı. Betik worktree'yi kurulum
    öncesi ve sonrası karşılaştırır ve ortaya çıkan ne varsa `owned_paths`'e
    ekler.

### Karşılaşabileceğin iki ret

**Sürülen depoda `.env` yok**, ama `.env.example` var:

```
Repository .env is missing: /home/you/your-repo/.env
Write one with development values before opening a lane. Copying .env.example
is not safe by default: it carries the installed deployment's database target,
and a lane pointed at that can destroy real data.
```

**Çakışan bir lane.** Hub `409` ile ve suçlunun adıyla yanıtlar:

```json
{"error":"owned_paths conflict","conflicting_lane_id":"refactor-auth"}
```

Aynı yolu talep eden iki lane bitmemiş hâlde birlikte var olamaz. Diğerini
bitir, başarısız say veya sil; ya da yolları daralt.

## 3. Conductor çalıştırsın

```bash
bun run conductor          # tek pass
bun run conductor --loop   # sürekli
```

Tek pass bir özet yazar ve bir şey başarısız olduysa sıfırdan farklı çıkar:

```
--- summary ---
completed:        fix-login
waiting approval: -
failed:           -
logs: /home/you/.local/state/laneward/logs
```

Bu sırada [panoyu](http://127.0.0.1:8787) izle. Lane kartı durumu, deneme
sayısını, sahip olduğu yolları ve ajanın logunun canlı kuyruğunu gösterir.
`whole log` bağlantısı dosyanın tamamına gider.

## 4. Kararı oku

| Sonuç | Ne oldu |
|---|---|
| `completed` | Ajan 0 ile çıktı, kirli her yol `owned_paths` içindeydi ve sürülen deponun tanımladığı kontroller geçti. |
| `waiting_approval` | Ajan 10 ile çıktı ya da bir eskalasyon işareti yazdı. Yanıtla; lane, kararın brief'e eklenmiş hâliyle yeniden çalışır. |
| `failed` | Üç deneme tükendi, bir kontrol düştü, `owned_paths` dışında bir yol değişti veya git mutasyonu denendi. |

`completed` doğru demek değildir. Ajanın kutusunun içinde kaldığı ve senin
tanımladığın kontrollerin yeşile döndüğü demektir.

Lane `waiting_approval` ise çöz, conductor tekrar alsın:

```bash
curl -s http://127.0.0.1:8787/pending          # approval_id'yi bul
curl -s -X POST http://127.0.0.1:8787/approvals/<approval_id> \
  -H 'content-type: application/json' \
  -d '{"resolved_by":"human","decision":"Yes, rejecting an empty password is in scope."}'
```

## 5. İşi al

Laneward asla commit etmez. Ajanın işi, `lane/fix-login` dalında, worktree
içinde commit edilmemiş durur:

```bash
cd /home/you/your-repo-worktrees/fix-login
git diff                       # ajanın yaptığı şey bu
git add -A && git commit -m "reject an empty password"
```

Sonra kendi deponda her zamanki gibi merge et ve **ancak ondan sonra** lane'i
kaldır:

```bash
bun run teardown fix-login
```

Teardown lane veritabanını düşürür, worktree'yi kaldırır ve dalı siler.
Worktree kirliyken veya dal senin deponun taşımadığı commit'ler taşırken hiçbir
şeyi kaldırmayı reddeder:

```
Refusing to tear down fix-login. Nothing was removed.

Commits on lane/fix-login that /home/you/your-repo does not carry:
  a1b2c3d reject an empty password
```

Bu ret, tam olarak bu adımın emniyet ağıdır: entegre etmediğin hiçbir şey senin
yerine silinmez.
