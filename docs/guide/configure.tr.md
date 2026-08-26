# Yapılandırma

Her şey, hub ile conductor'ın yüklediği `.env` dosyasından okunur. Yapılandırma
dosyası yoktur ve `--loop` dışında bayrak yoktur.

## Bütün değişkenler

| Değişken | Varsayılan | Amaç |
|---|---|---|
| `DATABASE_URL` | yok, zorunlu | Hub durumunu nerede tuttuğu. |
| `PORT` | `8787` | Hub'ın dinlediği port. Conductor hub adresini bundan türetir. |
| `HUB_URL` | `PORT`'tan türetilir | Conductor başka bir hub ile konuşacaksa. |
| `MAX_ACTIVE_LANES` | `3` | Eşzamanlılık tavanı. Tavanı aşan lane `pending` kalır. |
| `LANEWARD_AGENT` | yok | Preset seçer: `codex` veya `claude`. |
| `LANEWARD_AGENT_WRITE` | presetin şablonu | Çalışan ajan için JSON argüman dizisi. |
| `LANEWARD_AGENT_READ` | presetin şablonu | Salt okunur reader için JSON argüman dizisi. |
| `LANEWARD_AGENT_BIN` | presetin `bin`'i | Presetin argv[0]'ını değiştirir. Kendi argv[0]'ına sahip ham şablon bunu yok sayar. |
| `LANEWARD_MODEL_FAST` | presetin tablosu | `fast` katmanını herhangi bir model dizgesine bağlar. |
| `LANEWARD_MODEL_BALANCED` | presetin tablosu | `balanced` katmanı. |
| `LANEWARD_MODEL_DEEP` | presetin tablosu | `deep` katmanı. |
| `LANEWARD_READER_MODEL` | `balanced` | Reader'ın çalıştığı katman. |
| `LANEWARD_READER_TIMEOUT_MS` | `600000` | Tek bir reader koşusunun tavanı. |
| `LANEWARD_CHECK_TIMEOUT_MS` | `600000` | Tanımlı tek bir lane kontrolünün tavanı. |
| `LANEWARD_DRAIN_INTERVAL_MS` | `5000` | `--loop` altında drain'ler arası bekleme. |
| `LANEWARD_NOTIFY` | `approval_required,lane_failed` | Virgülle ayrılmış bildirim sınıfları. Boş değer masaüstü bildirimini kapatır. |
| `LANEWARD_LOG_DIR` | platform durum dizini | Lane loglarının yazıldığı yer. |
| `LANEWARD_CLEAN_RUN_SHELL` | platforma göre çözülür | Clean-run katmanının kullandığı yorumlayıcının mutlak yolu. |

Log dizinini sen vermezsen `$XDG_STATE_HOME/laneward/logs` olur; Linux'ta
`$HOME/.local/state/laneward/logs`, Windows'ta `%LOCALAPPDATA%\laneward\logs`
şeklinde düşer. Pano da aynı dizini okur, yani bir süreci farklı bir dizine
yönlendirmek logları diğerinden gizler.

!!! warning "`LANEWARD_NOTIFY` içindeki bir yazım hatası hub'ı hiç başlatmaz"

    Tanınmayan bir sınıf adı yok sayılmaz, başlangıçta
    `invalid LANEWARD_NOTIFY class: <name>` fırlatır. Geçerli dört ad:
    `approval_required`, `lane_failed`, `plan_ready_for_review` ve
    `findings_to_adjudicate`. Boş değer geçerlidir ve "masaüstü bildirimi yok"
    demektir.

## Ajan tanımlamak {#declaring-an-agent}

Varsayılan ajan yoktur. Ne `LANEWARD_AGENT` ne `LANEWARD_AGENT_WRITE` tanımlıysa
ilk lane şununla başarısız olur:

```
no agent declared: set LANEWARD_AGENT to one of (codex, claude), or set
LANEWARD_AGENT_WRITE to a JSON argument array
```

Bilinmeyen bir preset adı da aynı netlikte reddedilir:
`LANEWARD_AGENT must be one of: codex, claude (got "gemini")`.

### İki preset

Yalnızca bu ikisi geliyor, çünkü bu projeye karşı yalnızca bu ikisi çalıştırıldı.

=== "codex"

    ```bash
    LANEWARD_AGENT=codex
    ```

    | Mod | Komut |
    |---|---|
    | yazma | `codex exec -C {worktree} -s workspace-write -m {model}` |
    | salt okunur | `codex exec -C {worktree} -s read-only -m {model}` |

    Model katmanları: `fast` = `gpt-5.6-luna`, `balanced` = `gpt-5.6-terra`,
    `deep` = `gpt-5.6-sol`.

=== "claude"

    ```bash
    LANEWARD_AGENT=claude
    ```

    | Mod | Komut |
    |---|---|
    | yazma | `claude -p --permission-mode acceptEdits --disallowedTools "Bash(git *)" --model {model}` |
    | salt okunur | `claude -p --permission-mode plan --disallowedTools Edit Write NotebookEdit Bash --model {model}` |

    Model katmanları: `fast` = `haiku`, `balanced` = `sonnet`, `deep` = `opus`.

    Yazma şablonu `Bash(git *)`'i shim'e bırakmadan ajanın kendisinde yasaklar.
    Ajan git'e sorulmadan uzanır ve okuma olduğu anlaşılmayan her shim reddi,
    aslında doğru olan bir lane'i başarısız yapardı.

Üçüncü bir preset eklemek, bayrakları yazmak değil, onu eklemek **ve** onunla
gerçek bir lane sürmek demektir.

### Onun yerine ham komut

Başka her şey için argüman dizilerini kendin tanımlarsın. `{bin}`, `{worktree}`
ve `{model}` yerine konur; dizi işletim sistemine olduğu gibi geçirilir, çünkü
Windows'ta yollar boşluk içerir.

```bash
LANEWARD_AGENT_WRITE='["my-agent","run","--dir","{worktree}","--model","{model}"]'
LANEWARD_AGENT_READ='["my-agent","run","--readonly","--dir","{worktree}","--model","{model}"]'
```

Bozuk bir değer yarım ayrıştırılmaz, `LANEWARD_AGENT_WRITE must be a JSON array
of arguments` fırlatır.

!!! danger "Read şablonu olmadan ham write şablonu reader'ı devre dışı bırakır"

    `LANEWARD_AGENT_WRITE` tanımlayıp `LANEWARD_AGENT_READ`'i boş bırakmak, her
    reader koşusunu gerekçesiyle birlikte `skipped` olarak kaydeder. Bu
    bilerekdir: reader'ın salt okunur kısıtını sağlamak ajanın işidir ve
    Laneward, incelediği adayın üzerinde reader'ı kısıtsız çalıştırmaz.

### Bir ajanın vermesi gereken dört söz

1. Talimatını konumsal argümandan değil **stdin**'den okumak. Konumsal prompt
   alan bir ajan, arka plana alındığında stdin'de sonsuza kadar bekler.
2. **Verilen dizinde** çalışmak ve yalnızca brief'in izin verdiğini düzenlemek.
3. Bitince **0**, onay istemek için **10**, aksi hâlde sıfırdan farklı çıkmak.
4. **Hiçbir git mutasyonu yapmamak.** Bu sonuncusu güvenilmez, shim tarafından
   zorlanır; yani bilinmeyen bir ajan da aynı sınırı miras alır.

### Ajanı sarmalamak

`argv[0]` `.ts` ile bitiyorsa Bun ile çalıştırılır. `scripts/codex-round.ts`'in
arkasındaki dikiş budur: her argümanı gerçek ikiliye iletir ve tur başına
ayarları ekler:

```bash
LANEWARD_AGENT=codex LANEWARD_AGENT_BIN=scripts/codex-round.ts bun run conductor
```

`LANEWARD_AGENT_BIN` yalnızca `{bin}` yer tutucusu üzerinden konur; yani preset'i
etkiler, kendi ikilisini adıyla yazan ham şablonu etkilemez.

## Model katmanları

Katman (`fast`, `balanced`, `deep`) bir model adı değil, senin doldurduğun bir
yuvadır. Adlar bir maliyet ve yetenek merdivenidir; her birinin neye karşılık
geldiğini sen belirlersin:

```bash
LANEWARD_MODEL_DEEP=my-favourite-large-model
```

Lane katmanını kayıt sırasında `LANE_MODEL` ile seçer (varsayılan `balanced`);
bkz. [İlk lane](first-lane.md). Aktif preset ve override yokken bir katman
istemek tahmin etmez, fırlatır:

```
no default model for tier "deep": no agent preset is active, set LANEWARD_MODEL_DEEP
```
