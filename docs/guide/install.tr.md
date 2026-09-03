# Kurulum ve ilk çalıştırma

Bir hub ve bir conductor, bir klondan başlayarak tek makinede çalışıyor. Burada
hiçbir şey servis olarak kurulmuyor; o
[Servis olarak çalıştırmak](running-as-a-service.md) sayfasında.

## Önce gerekenler

| Gereksinim | Not |
|---|---|
| [Bun](https://bun.sh) 1.3.14 | İki kurulum betiği de bunun altında uyarır ve her şey bu sürüme karşı doğrulandı. Daha yenisi güvenli değil: Windows'ta Bun 1.4.0 ile `scripts/teardown.ts` hiçbir şey kaldırmadan ve hiçbir şey yazmadan 0 dönüyor. CI bu yüzden 1.3.14'e sabitli. |
| git | 2.54.0 üzerinde doğrulandı. |
| PostgreSQL 16 | Erişebildiğin herhangi bir örnek. Linux'ta rootless Podman ile `install.sh` kendi veritabanını getirebilir. |
| Bir ajan CLI'ı | `codex` preseti için Codex 0.147.0 veya üstü — son olarak 2026-08-19'daki gerçek koşuya karşı doğrulandı ve o abonelik sona erdiğinden beri artık bir koşuyla değil testlerle kaplı — `claude` preseti için Claude Code, ya da kendi komutun. Bkz. [Yapılandırma](configure.md). |

Masaüstü bildirimleri Linux'ta (`notify-send`) ve Windows'ta (PowerShell toast)
çalışır. macOS'ta bildirim yoktur; geri kalan her şey yine çalışır.

## Klonla ve yapılandır

```bash
git clone https://github.com/aethrox/laneward.git && cd laneward
bun install
cp .env.example .env
```

Şimdi `.env`'i düzenle. Herhangi bir şeyin çalışması için iki değer önemli:

```bash
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward
LANEWARD_AGENT=claude     # ya da codex, ya da bunun yerine LANEWARD_AGENT_WRITE tanımla
```

!!! warning "`.env.example`'daki port 5432 değil, 5433"

    5433, paketle gelen Podman konteynerinin yayımladığı porttur. Zaten
    çalıştırdığın bir PostgreSQL neredeyse kesinlikle 5432'dedir ve bunu yanlış
    bırakmanın belirtisi, sonradan gelen açıklayıcı bir hata değil, ilk komutta
    reddedilen bir bağlantıdır.

`LANEWARD_AGENT` de `LANEWARD_AGENT_WRITE` de boşken hub ve migration yine
çalışır; asıl başarısız olan ilk lane'dir ve reddi, ajanı tanımlamanın iki yolunu
da adıyla söyler.

## Şemayı oluştur

```bash
bun run db:migrate
```

`Applied N statements.` yazar ve tekrar çalıştırmak güvenlidir: şema dosyası
eklemeli `CREATE ... IF NOT EXISTS` ve `ALTER ... IF EXISTS` ifadelerinden oluşur.

`DATABASE_URL` tanımlı değilse tam olarak şunu alırsın ve hiçbir şeye
dokunulmaz:

```
DATABASE_URL is not set: copy .env.example to .env
```

## Hub'ı başlat

```bash
bun run start
```

Pano [http://127.0.0.1:8787](http://127.0.0.1:8787) adresinde. Bir lane
kaydedene kadar boştur. `bun run dev` aynı şeyi hot reload ile yapar; kodu
okurken işe yarar, lane sürerken gereksizdir.

Hub yalnızca `127.0.0.1` dinler ve bu adres yapılandırılabilir değil, koda
gömülüdür. `PORT` portu değiştirir; conductor, `HUB_URL` vermediğin sürece hub
adresini `PORT`'tan türetir.

## Conductor'ı başlat

İkinci bir terminalde:

```bash
bun run conductor          # tek drain pass, sonra özet
bun run conductor --loop   # 5 saniyede bir sürekli drain
```

Tek pass, herhangi bir lane başarısız olduysa sıfırdan farklı çıkar; bu da onu
bir betikten kullanılabilir kılar. `--loop` hiç dönmez ve özet yazmaz; servis
biriminin çalıştırdığı şey odur.

!!! warning "Conductor'ı paket betiği üzerinden çalıştır"

    `bun run conductor`, `bun --env-file=.env run --no-env-file conductor.ts`
    demektir. İki bayrak da taşıyıcıdır, bu sırayla: birincisi checkout'un
    yanındaki `.env`'i yükler — `LANEWARD_AGENT` orada durur; ikincisi Bun'un
    içinde bulunduğun dizinden ikinci bir `.env`'i otomatik yüklemesini
    engeller. `bun run conductor.ts` demek ikisini de atlar ve ilk lane
    `no agent preset is active` ile başarısız olur.

    Laneward'ın kendi `PORT` ve `DATABASE_URL` değerlerini başlatılan ajandan
    uzak tutan şey bayrak değil, worker sınırıdır: conductor ikisini de,
    host'un Git, GitHub ve SSH kimlik bilgileriyle birlikte, her ajana verdiği
    ortamdan siler. `PORT` siliniyor çünkü onu devralan bir lane kendi
    reposunu hub'ın portunda servis eder.

İkisini de bir araç oturumunun arka plan işi olarak değil, detached başlat. Lane
ortasında öldürülen bir conductor, kimsenin puanlamadığı bir worktree'ye yazan
öksüz bir ajan bırakır.

## Gerçekten ayakta mı

```bash
curl -s http://127.0.0.1:8787/pending
curl -s http://127.0.0.1:8787/lanes
```

Taze bir kurulum şunu yanıtlar:

```json
{"waiting_approval":[],"failed":[],"findings":[]}
```

`GET /pending`, senin tek "bana ne düşüyor" sorgun. Masaüstü bildiricisi ve
Claude Code köprüsü de aynı şeyi okur.

## Test paketini çalıştırmak

`bun test` çalıştırmadan önce `DATABASE_URL`'i adı `_test` ile biten **ayrı** bir
veritabanına yönlendir. Paket, bulduğu tabloları truncate eder:

```bash
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward_test bun run db:migrate
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward_test bun test
DATABASE_URL=postgres://laneward:laneward@localhost:5433/laneward_test bun run typecheck
```

Başka her şey, ilk ifade çalışmadan reddedilir:

```
refusing to run tests against laneward: the suite truncates lanes, messages and
approvals. Point DATABASE_URL at laneward_test, a name ending in _test, or a
laneward_lane_* database.
```

## Sonraki adım

Sıradaki adım [Yapılandırma](configure.md): hangi ajanın çalışacağını ve her
model katmanının ne anlama geldiğini tanımlamak.
