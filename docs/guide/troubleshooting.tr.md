# Sorun giderme

Önce belirti. Bunların çoğu sistemin kasıtlı olarak reddetmesidir ve ret metni
nedeni belirtir.

## Bir lane başlamıyor {#lane-will-not-start}

`pending` durumunda kalır ve hiçbir şey olmaz. Nedenini sorun:

```bash
curl -s http://127.0.0.1:8787/lanes/fix-login/gate
```

Yanıt bunlardan biridir, şu sırayla kontrol edilir:

| Neden | Ne anlama gelir | Ne yapılmalı |
|---|---|---|
| `lane not found` | Böyle bir lane id'si yok. | `GET /lanes` uç noktasını kontrol et. |
| `lane's plan revision is not approved` | Kimsenin onaylamadığı bir revizyona bağlı. | `POST /plans/:id/revisions/:n/approve` çağrısını yap. |
| `lane's plan revision 1 is superseded by revision 2` | Daha yeni bir revizyon var. | Lane'i en yeni revizyona karşı yeniden kaydet. |
| `lane has a pending approval request` | Seni bekliyor. | Şununla çöz: `POST /approvals/:id`. |
| `dependency not found: build-schema` | Bir `depends_on` girdisi var olmayan bir lane'i işaret ediyor, genellikle yazım hatasıdır. | Id'yi düzelt veya eksik lane'i kaydet. |
| `dependency not completed: build-schema` | Beklediği lane henüz tamamlanmadı. | Bekle veya o lane'in önünü aç. |
| `active lane limit reached (3)` | `MAX_ACTIVE_LANES` dolu. | Bekle veya değeri yükselt. |
| `owned_paths conflict with a running lane` | Çalışan başka bir lane çakışan bir alanı sahipleniyor. | Onu bekle veya yolları daralt. |

Reddeden bir gate bir hata değildir. Lane `pending` durumunda kalır ve bir
sonraki drain turunda yeniden denenir.

## Lane bir ownership ihlaliyle başarısız oldu

```
FAIL: ownership violation: src/auth/deep/util.ts
```

`owned_paths` dosya yolları üzerinde bir glob'dur ve `*` bir `/` karakterini
aşmaz, bu yüzden `src/auth` deseni `src/auth/login.ts` yolunu kapsamaz. Bu,
doğru bir lane'in başarısız olmasının en yaygın yoludur; ölçülmüş tablo
[Brief yazmak](writing-briefs.md#owned-paths) sayfasındadır.

Her dizin seviyesi için bir desen kullanarak yeniden kaydet ve aynı listeyi
brief'e de koy, böylece ajan sınırın nerede olduğunu bilir.

## Lane başarısız oldu ve yeniden denenmedi

```
FAIL: Git boundary violation: HEAD changed, index has staged entries
```

Bir Git boundary ihlali yeniden denenemez: olduğu yerde başarısız olur.
Laneward git'in sahibidir, bu yüzden ajan commit, stage, checkout yapmamalı
veya açıkça bir okuma olmayan hiçbir şeye el atmamalıdır.

Neyin reddedildiğini görmek için `<log dir>/<lane_id>.git-guard.jsonl`
dosyasına bak. Reddedilen bir **okuma** raporlanır ve lane'i başarısız
yapmaz; reddedilen bir **mutation** yapar. `claude` preset'i tam olarak bu
nedenle ajanda `Bash(git *)` komutunu reddeder; ham bir ajan
kullanıyorsan aynı şeyi brief'te belirt.

## Lane kendini waiting_approval durumuna park etti

Bunu dört şey yapar, ve soru metni hangisi olduğunu söyler:

| Soru | Anlamı |
|---|---|
| `lane <id> reported: "APPROVAL REQUIRED: ..."` | Ajan sordu. Yanıtla. |
| `lane <id> reported: "HOST VERIFICATION REQUIRED: ..."` | İş yapıldı ama bir iddia doğrulanmamış. Kendin doğrula, sonra yanıtla. |
| `lane <id> failed its lane checks: test` | Bildirilen check'ler kırmızıya döndü. `<lane_id>.check-*.log` dosyasını oku. |
| `lane <id> exited 0 without producing changes and needs a decision` | Hiçbir şey değiştirmeyen bir yazma lane'i. Genellikle ajanın zaten karşılandığına karar verdiği bir brief'tir. |

`POST /approvals/:id` ile çöz, ve `decision` alanını bir talimat olarak
yaz: lane yeniden çalıştığında brief'e eklenir.

## Ajan asılı kalıyor ve hiç çıkmıyor

Neredeyse her zaman prompt'unu positional bir argüman olarak alan bir
ajandır. Laneward brief'i **stdin**'e yazar, bu yüzden böyle bir ajan
kendisine zaten kapatılmış bir stdin üzerinde, sonsuza kadar bekler. Ajan
süreci için bir timeout yoktur.

Ajanın stdin'i okuması için komut şablonunu düzelt. Conductor'ı
sonlandır, sonra lane'i `pending` durumuna döndürmek için
`bun run reset-stranded` çalıştır.

## İlk lane, bildirilen bir ajan olmadan başarısız oluyor

```
no agent declared: set LANEWARD_AGENT to one of (codex, claude), or set
LANEWARD_AGENT_WRITE to a JSON argument array
```

Tasarım gereği varsayılan bir ajan yoktur. Bkz.
[Yapılandırma](configure.md#declaring-an-agent). Yanlış bir preset adı da
tıpkı öyle net bir şekilde reddedilir:
`LANEWARD_AGENT must be one of: codex, claude (got "gemini")`.

## Reader hiç çalışmıyor

Durumu `skipped`'dır ve neden bunu söyler. Ya sürülen depo hiçbir
`reader.test_paths` bildirmiyordur, ya da `LANEWARD_AGENT_READ` olmadan
`LANEWARD_AGENT_WRITE` ayarlamışsındır; bu durumda salt okunur bir komut
yoktur ve Laneward reader'ı incelediği kod üzerinde sınırsız çalıştırmaz.

## Hub başlamıyor

```
invalid LANEWARD_NOTIFY class: aproval_required
```

Bir bildirim sınıfındaki yazım hatası göz ardı edilmek yerine ölümcüldür, bu
yüzden yanlış yazılmış bir sınıf, açık olduğunu düşündüğün bir uyarıyı
sessizce devre dışı bırakamaz. Dört isim şunlardır: `approval_required`,
`lane_failed`, `plan_ready_for_review`, `findings_to_adjudicate`.

```
DATABASE_URL is not set: copy .env.example to .env
```

Tam olarak söylediği şey. `.env.example` dosyasının **5433** portuyla
geldiğine dikkat et; bu, gönderilen container'ın yayınladığı porttur;
zaten çalıştırdığın bir PostgreSQL muhtemelen 5432'dedir.

## Test suite çalışmayı reddediyor

```
refusing to run tests against laneward: the suite truncates lanes, messages and
approvals. Point DATABASE_URL at laneward_test, a name ending in _test, or a
laneward_lane_* database.
```

Suite, bağlandığı her şeyi truncate eder. Onu `laneward_test`'e yönlendir,
asla lane'lerinin yaşadığı veritabanına değil.

## Lane'ler çalışıyor ama hiçbir şey olmuyor

Conductor'ları gitmiş: bir çökme, bir yeniden başlatma veya durmuş bir
Windows zamanlanmış görevi.

```bash
bun run reset-stranded --dry-run
bun run reset-stranded
```

Önce çalışan herhangi bir conductor'ı durdur: `reset-stranded` mahsur
kalmış bir lane'i sağlıklı bir lane'den ayırt edemez ve bulduğu her `running`
lane'i sıfırlar.

## Ajan yanlış veritabanına bakıyor

Conductor'ı `bun run conductor` yerine `bun run conductor.ts` olarak
başlattın. Paket script'i `--no-env-file` bayrağını geçirir; bu olmadan
Bun geçerli dizindeki `.env` dosyasını otomatik yükler ve oluşturduğu her
ajana Laneward'ın kendi `PORT` ve `DATABASE_URL` değerlerini iter, böylece
ajan kendi lane'inin değil hub'ın veritabanıyla konuşur.

## Kayıt reddediliyor

```json
{"error":"owned_paths conflict","conflicting_lane_id":"refactor-auth"}
```

İki lane, ikisi de bitmemişken çakışan bir alanı sahiplenemez. Diğerini
tamamla, başarısız kıl veya sil, ya da yolları daralt. Çakışma
kontrolünün yolları önek olarak karşılaştırdığına dikkat et, bu yüzden
`src`, `src/auth` ile çakışır, oysa kanıt kontrolü birinin diğerini
kapsadığını kabul etmez.

```
Repository .env is missing: /home/you/your-repo/.env
```

Sürülen depo bir `.env.example` ile gelir ve bir `.env` dosyası
yoktur. Geliştirme değerleriyle bir tane yaz. Örneği kopyalamak varsayılan
olarak güvenli değildir: kurulu deployment'ın veritabanı hedefini taşır, ve
buna yönlendirilmiş bir lane gerçek veriyi yok edebilir.

## Teardown reddediyor

```
Refusing to tear down fix-login. Nothing was removed.

Uncommitted changes in /home/you/your-repo-worktrees/fix-login:
  src/auth/login.ts
```

Bu, güvenlik ağının çalışmasıdır. Önce işi commit et ve depona
merge et; teardown yalnızca worktree'si temiz olan ve branch'i
deponda zaten olmayan hiçbir şey taşımayan bir lane'i kaldırır.

## Bir şey yalnızca Windows'ta, başıboş bir carriage return ile bozuldu

POSIX git shim'i, `install.sh`, systemd unit'leri ve `.env.example`,
`.gitattributes` içinde LF'ye sabitlenmiştir, çünkü bu depo
`core.autocrlf=true` ile Windows'ta geliştirilir. Shim içindeki bir CRLF,
shebang'ını çözülemez hale getirir; `install.sh` içinde
`env: 'bash\r': No such file or directory` şeklinde başarısız olur; bir
systemd unit'inde ise hiç gürültülü şekilde başarısız olmaz, her değerin
içine bir carriage return koyar. Bu dosyalardan herhangi birini başka bir
yere kopyalarsan, satır sonlarını koru.

## Dashboard "disconnected, retrying" diyor

Sayfa bir server-sent event stream'i tutar ve kendiliğinden yeniden
bağlanır. Bu mesaj hub'ın yanıt vermediği anlamına gelir: `bun run start`
komutunun hâlâ çalıştığını ve doğru portta olduğunu kontrol et.
