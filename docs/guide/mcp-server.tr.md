# MCP sunucusu

`mcp.ts`, Laneward'ı kendi kodlama ajanına bir araç kümesi olarak verir. Ajan
lane kaydeder, onları izler, loglarını ve kanıtlarını okur ve park etmiş bir
lane'in sorusunu sana geri getirir. Bu, dashboard'un konuştuğu hub'ın ta
kendisidir, aynı HTTP rotaları üzerinden; burada ikinci bir doğruluk kaynağı
yok.

stdin ve stdout üzerinden satır sonuyla ayrılmış JSON-RPC konuşur; her MCP
istemcisinin yerel bir sunucudan beklediği şey budur. Köprü gibi isteğe
bağlıdır ve dashboard'u okumanın yerine geçmez.

```bash
bun run mcp
```

Bu, `bun run --no-env-file mcp.ts` demektir. Elle yalnızca başladığını görmek
için çalıştır; onu senin yerine istemci başlatır.

## Kaydetmek

### Claude Code

Bu depo bir `.mcp.json` ile gelir; dolayısıyla Laneward checkout'u içinde
başlatılan bir oturumda araçlar zaten hazırdır:

```json
{
  "mcpServers": {
    "laneward": {
      "command": "bun",
      "args": ["run", "--no-env-file", "mcp.ts"]
    }
  }
}
```

Yol görecelidir, çünkü proje kapsamlı bir sunucu çalışma dizini proje dizini
olacak şekilde başlatılır. Başka bir projeden kaydetmek için mutlak yolu ver:

```bash
claude mcp add laneward -- bun run --no-env-file /path/to/laneward/mcp.ts
```

### Codex

`~/.codex/config.toml` içinde:

```toml
[mcp_servers.laneward]
command = "bun"
args = ["run", "--no-env-file", "/path/to/laneward/mcp.ts"]
env = { LANE_REPO = "/path/to/your/repo" }
```

### Cursor

`.cursor/mcp.json` içinde:

```json
{
  "mcpServers": {
    "laneward": {
      "command": "bun",
      "args": ["run", "--no-env-file", "/path/to/laneward/mcp.ts"],
      "env": { "LANE_REPO": "/path/to/your/repo" }
    }
  }
}
```

!!! warning "`--no-env-file` taşıyıcı bir bayraktır"

    Bun, `.env` dosyasını geçerli çalışma dizininden yükler ve bir MCP
    sunucusunun çalışma dizini Laneward'ınki değil, *istemcinin* projesidir. Bu
    bayrak olmadan sürülen deponun `DATABASE_URL` değeri sunucuya ve onun
    başlattığı her betiğe yüklenir, `new-lane.ts` de lane veritabanını yanlış
    sunucuda oluşturur. Yukarıdaki her parçacık bu bayrağı taşır. Öyle kalsın.

!!! warning "Lane'lerin hangi depoda açılacağına `LANE_REPO` karar verir"

    `LANE_REPO` ayarlı değilse `lane_create` reddeder, çünkü
    `scripts/new-lane.ts` içindeki `repositoryLocation()` aksi hâlde
    Laneward'ın kendi checkout'una düşer ve lane'i orada açar. Bunu komutun
    yanında, istemci yapılandırmasında ayarla ve değiştirdikten sonra istemciyi
    yeniden başlat: sunucu ortamını yalnızca bir kez, başlarken okur.

`HUB_URL`, köprünün okuduğu gibi okunur; varsayılanı
`http://127.0.0.1:8787`'dir ve her hub isteği iki saniye sonra zaman aşımına
uğrar. `reset_stranded` ayrıca `DATABASE_URL` ister; nedeni aşağıda.

## Araçlar

| Araç | Tür | Ne yapar |
|---|---|---|
| `laneward_status` | okuma | Sayı cümlesi ve `/pending` çıktısının tamamı, bekleyen her lane'in sorusu dahil |
| `lane_list` | okuma | Durumu ve plan revizyonuyla birlikte her lane |
| `lane_gate` | okuma | Bir lane'in neden çalışabildiği ya da çalışamadığı. Kapalı gate bir hata değil, başarıdır |
| `lane_log` | okuma | Bir lane'in worker log'unun sonu |
| `lane_evidence` | okuma | Bir lane'in kanıt olarak kaydettikleri |
| `plan_show` | okuma | Bir plan ve onay durumuyla her revizyonu |
| `findings_list` | okuma | Tek bir plan revizyonundaki doğrulama bulguları |
| `candidates_due` | okuma | Lane'lerinin tamamı bitmiş ve henüz adayı olmayan plan revizyonları |
| `lane_create` | yazma | Bir lane kaydeder: worktree, dal, veritabanı, satır. Hiçbir şey çalıştırmaz |
| `plan_submit` | yazma | Bir planı ve onun 1. revizyonunu kaydeder |
| `plan_revise` | yazma | Revizyon ekler; eski revizyondaki lane'lerin yetkisini geri çeker |
| `lane_answer` | yazma | Bir onayı insanın kararıyla sonuçlandırır |
| `finding_adjudicate` | yazma | Tek bir bulguyu kabul eder, reddeder veya erteler |
| `plan_approve` | **yıkıcı** | Yürütme yetkisi verir. Geri alınamaz |
| `build_candidate` | **yıkıcı** | Bir entegrasyon adayı kurar; `rebuild` mevcut adayı yok eder |
| `reset_stranded` | **yıkıcı** | `dry_run` olmadıkça lane durumunu yeniden yazar |
| `lane_teardown` | **yıkıcı** | Lane'in veritabanını, worktree'sini ve dalını siler |

Yıkıcı dördü iki kez işaretlenir, çünkü istemciler bu iki kanalı farklı
gösterir: her biri `annotations.destructiveHint` taşır ve her açıklama harfi
harfine `DESTRUCTIVE` kelimesiyle açılıp ajana önce sana sormasını söyler.
`build_candidate` ve `reset_stranded` yalnızca bir bayrağa bağlı olarak
yıkıcıdır ve bu koşul hem araç açıklamasında hem de parametrenin kendi
açıklamasında belirtilir.

Her araç, tek cümlelik bir özet ve ardından veriyle yanıt verir; böylece başka
hiçbir şey okumayan bir ajan bile ne olduğunu okur. Hub'ın veya bir betiğin
bildirdiği bir başarısızlık, protokol hatası olarak değil araç hatası olarak
döner: ajan metni görür ve ona göre davranabilir.

## Akış promptu

Sunucu tek bir prompt sunar, `laneward_workflow`, ve aynı metni `initialize`
yanıtında `instructions` olarak verir. İkisinin birbirinden ayrışmaması için
`src/mcp-brief.ts` içinde tek bir string'tir. Tamamı şudur:

---

Laneward runs coding agents on one repository at once, each in its own git
worktree, and keeps them from colliding. You drive it on the human's behalf.
You are not a lane; you register lanes, watch them, and bring what they ask
back to the human.

**Lanes are asynchronous.** `lane_create` returns as soon as the worktree
exists - nothing has run yet. A separate process, the conductor, dispatches
lanes when their gate opens. Poll `lane_list` between other work; do not spin.
Nothing you do makes a lane run sooner.

**owned_paths is the whole collision story.** Every lane declares the paths it
owns. Two lanes that are not finished may not own overlapping paths, and
registration overlap is a prefix match: `src/auth` reserves everything under
it. Scoring is different and stricter - the evidence check is an anchored glob
where `*` does not cross `/`, so a lane touching `src/auth/deep/util.ts` needs
`src/auth/*` and `src/auth/*/*`. Registration fails with HTTP 409 naming the
conflicting lane. Split work along file boundaries before you split it into
lanes. If two pieces of work must touch the same file, they are one lane.

**The brief is everything the worker gets.** It cannot see this conversation,
its plan, or the other lanes. Write: the goal in one sentence, the exact
command whose output proves the work is done, every path it owns including the
test and the doc the change forces, and what it must not touch. Give it the
escalation block: a line starting `APPROVAL REQUIRED:` when the brief is wrong
or ambiguous, a line starting `HOST VERIFICATION REQUIRED:` when the work is
done but a claim could not be checked. Both park the lane instead of guessing.

**The gate closing is not an error.** `lane_gate` returning `allowed: false`
with a reason - unapproved plan revision, unmet dependency, active-lane limit,
owned_paths conflict - is Laneward working. Read the reason and act on it; do
not retry.

**A lane that stops to ask is waiting on a human, not on you.** It appears in
`laneward_status` under `waiting_approval` with its question. Bring the
question to the human in their own words, get an answer, then `lane_answer`
with the approval id and the decision text. The conductor appends your decision
to the original brief and dispatches the lane again.

**Commit and merge stay manual.** Laneward never commits, merges or pushes.
`build_candidate` assembles an integration candidate for review; it is not a
merge. The human integrates.

**Before any tool marked DESTRUCTIVE, ask.** `lane_teardown` destroys a
database, a worktree and a branch. `plan_approve` grants execution authority
and cannot be undone. `reset_stranded` without `dry_run` rewrites lane state.
`build_candidate` with `rebuild` destroys the existing candidate. Say what will
be destroyed, in one sentence, and wait for a yes.

**If the hub is unreachable**, say so and stop. Laneward is a local service on
`HUB_URL`; when it is down, nothing you can call will help. The human starts it
with `bun start`.

---

## Bilinçli olarak sunulmayanlar

Araçlar, [API](api-reference.md) etrafında bir sarmalayıcı değil, onun seçilmiş
bir alt kümesidir. Üç grup kasıtlı olarak dışarıda bırakıldı.

`POST /lanes/:id/start`, `POST /lanes/:id/messages`, `POST /lanes/:id/result` ve
`GET /lanes/dispatchable`, protokolün conductor ve worker tarafıdır. Bir
`lane_start` aracı `MAX_ACTIVE_LANES` bütçesi için conductor ile yarışırdı ve
bir lane'in sonucunu gönderen sürücü ajan, kendi yapmadığı bir iş hakkında
rapor veriyor olurdu.

`DELETE /lanes/:id` dışarıda bırakıldı, çünkü teardown onu bilerek çağırmaz.
Sökülmüş bir lane satırını korur ve terminal bir satır etkisizdir: `POST /lanes`
yalnızca `completed` veya `failed` olmayan lane'lerle çakışır. Canlı bir lane'i
silmek ise worktree'sini ve veritabanını sahipsiz bırakır ve hub'da onların var
olduğunu bilen hiçbir şey kalmaz.

MCP resource'ları yoktur. Birkaç istemci onları yok sayar ve bir resource'un
taşıyacağı her şey zaten onu döndüren bir araçtır.

## Sorun giderme

**Her araç Laneward'ın erişilemez olduğunu söylüyor.** Hub çalışmıyor. Laneward
checkout'unda `bun start` ile başlat ya da hub `http://127.0.0.1:8787` dışında
bir yerde dinliyorsa istemci yapılandırmasındaki `HUB_URL` değerini kontrol et.

**`lane_create` reddediyor ve `LANE_REPO` adını veriyor.** Sunucunun ortamında
ayarlı değil. İstemci yapılandırmasında ayarla ve istemciyi yeniden başlat;
sunucu ortamını başlarken okuduğu için kabuğundaki bir değişiklik zaten çalışan
bir sunucuya ulaşmaz.

**`reset_stranded` reddediyor ve `DATABASE_URL` adını veriyor.** Hub üzerinden
gitmeyen tek araç odur: `scripts/reset-stranded.ts` doğrudan Postgres ile
konuşur, çünkü hub'ın çalışıyor sandığı bir lane'i geri almak tam da hub'a
sormanın işe yaramadığı durumdur. Sunucuya hub'ın kullandığı `DATABASE_URL`
değerini ver.

**Bir lane oluştu ama hiçbir şey olmuyor.** Normal olan budur. `lane_create`
yalnızca kaydeder; dağıtımı conductor yapar. Conductor'ın çalıştığından emin ol
ve lane'in geri tutulup tutulmadığını görmek için `lane_gate` kullan.
