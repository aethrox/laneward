# Brief yazmak

Brief sözleşmenin tamamıdır. Ajanın stdin'ine gelir ve başka hiçbir şey gelmez:
ajan onu üreten konuşmayı, ait olduğu planı ve yanında koşan diğer lane'leri
göremez. [Şablondan](../brief-template.md) başla; bu sayfa işin operatör
tarafı.

!!! note "Brief İngilizce yazılır"

    Deponun kuralı: kod, yorumlar, testler ve dokümanlar İngilizce. Aşağıdaki
    örnekler bu yüzden İngilizce; açıklamaları Türkçe.

## Belirsiz bir brief neden yanlış puanlanır

Conductor, bir lane'in sonucuna logun söylediğine ve diff'in gösterdiğine
bakarak karar verir. Neden durduğunu söylemeden duran bir lane yalnızca
diff'inden puanlanır; doğru bir lane böyle `failed`, doğrulanmamış bir lane
böyle `completed` olur. Aşağıdaki her şey bunu engellemek için var.

## Owned path'ler dosyalar üzerinde glob'dur {#owned-paths}

Doğru bir lane'in başarısız olmasının en yaygın yolu budur.

`owned_paths`, `git status --porcelain -uall`'ın worktree'de bildirdiği her yola
karşı, `*`'ın `/` dışında her şeyle eşleştiği, başı ve sonu sabitlenmiş bir glob
olarak karşılaştırılır. Bir dizin adı dizinle eşleşir, içindekilerle değil.

İki dosyanın değiştiği bir deneme deposunda ölçüldü
(`src/auth/login.ts` ve `src/auth/deep/util.ts`):

| `owned_paths` | Sonuç |
|---|---|
| `src/auth` | `FAIL: ownership violation: src/auth/deep/util.ts src/auth/login.ts` |
| `src/auth/*` | `FAIL: ownership violation: src/auth/deep/util.ts` |
| `src/auth/*` `src/auth/*/*` | `PASS: 2 changed path(s), all within owned_paths` |

Yani dokunulmasını beklediğin her dizin seviyesi için bir desen yaz ve
yapabildiğin yerde dosyaları tek tek adlandır:

```bash
bun scripts/new-lane.ts fix-login brief.md \
  'src/auth/*' 'src/auth/*/*' 'tests/auth/*'
```

!!! note "Kayıt ve puanlama bilerek farklı kural kullanır"

    İki lane'in aynı zemini talep etmesini engelleyen çakışma kontrolü yolları
    önek olarak karşılaştırır; yani `src/auth` kaydetmek, diğer lane'lere karşı
    altındaki her şeyi gerçekten rezerve eder. Yalnızca sonradan çalışan kanıt
    kontrolü glob'dur. Doğru rezerve eden bir yol listesi yine de yanlış
    puanlanabilir; yukarıdaki tabloyu kendi ağacında denemeye değmesinin sebebi
    bu.

## Değişikliğin dokunmaya zorladığı her dosyayı yaz

Yan etkiler dâhil: kodla birlikte taşınması gereken test, testin ihtiyaç duyduğu
fixture, iddiası artık doğru olmayan doküman. Bunu komut satırında olduğu kadar
brief'te de söyle, çünkü ajan yalnızca brief'i görür:

```markdown
## Scope

You own exactly these files:

- `src/auth/login.ts`
- `tests/auth/login.test.ts`

Do NOT touch anything else, and never anything under `.git`.
```

`owned_paths` dışındaki bir dosyayı düzenleyen lane, işi doğru olsa bile kanıt
kontrolünde başarısız sayılır. Burada cömert olmak sana engellenmiş bir komşu
lane'e mal olur; cimri olmak boşa giden bir koşuya.

## Eskalasyon bloğu süs değildir

Ajanın üç sinyali var ve hiçbiri mesaj değil: çıkış `0` (bitti), çıkış `10`
(onay), başka her şey (başarısız). Yani konuşmayı ona brief öğretir. Logdan iki
işaret okunur ve ikisi de satır başında olmalıdır:

```
APPROVAL REQUIRED: [your question]
HOST VERIFICATION REQUIRED: [what is unverified, and the command that would verify it]
```

- **`APPROVAL REQUIRED`**, brief yanlış, belirsiz ya da yapılmaması gereken bir
  şeyi istiyorsa. Ajan hiçbir şeyi değiştirmez ve durur.
- **`HOST VERIFICATION REQUIRED`**, iş bitti ama ajanın doğrulayamadığı bir
  iddia kaldıysa: sandbox reddi, erişilemeyen bir servis, dokunamadığı donanım.

Her iki işaret de lane'i `waiting_approval`'a park eder. Sen yanıtlarsın ve lane,
kararın orijinal brief'in altına `--- APPROVAL DECISION ---` başlığıyla eklenmiş
hâliyle yeniden gönderilir; böylece hiçbir şey kaybolmaz ve hiçbir şey tahmine
göre puanlanmaz.

!!! tip "Yankılanan bir brief lane'i kazayla eskale edemez"

    Birebir brief'in bir satırı olan işaret satırı yok sayılır; cümle ortasında
    geçen bir işaret de yok sayılır. Şablonun kendi örnek işaretlerini
    devrettiğin metinde bırakmanın güvenli olmasının sebebi bu.

## Bitmiş sayılma ölçütünü komut olarak yaz {#definition-of-done}

```markdown
## Definition of done

- `bun test tests/auth` is green. Baseline before your change is 41 pass.
- Every new branch is covered by a test that fails if the branch is removed.
- No file outside the owned list is modified.
```

Baseline sayısı önemlidir: o olmadan, ilgisiz iki testi bozup üç test ekleyen bir
ajan yeşil rapor edebilir. Komutun kendisi de önemlidir, çünkü sürülen deponun
[tanımlı lane kontrolleri](driven-repo.md) sonrasında aynı zemini koşar ve
kontrollerin ölçmediği bir şeyi isteyen brief, güvenemeyeceğin bir brief'tir.

## Neye asla dokunulmayacağını söyle

```markdown
## Environment notes

- The lane has its own database. Never point anything at `laneward` or at the
  production connection in the repository root `.env`.
- Port 8787 belongs to the hub. Do not bind it.
- Code, comments, tests and docs are English.
```

Yalnızca doğru seçimleri değil, yıkıcı hataları adlandır. Lane'ler eskalasyon
mesajını yanlış dilde yazdı ve test koşusunu yanlış veritabanına yöneltti;
ikisi de brief'e eklenen tek bir cümleyle çözüldü.

## Bir süre sınırı

`Time limit: [N] minutes.` ile bitir. Bunu zorlayan bir şey yok (ajan sürecinin
kendisinde timeout yoktur) ama zor bir problemde ajanın bütçesini değiştirir ve
bir saattir `running` duran bir lane'e bakarken karşılaştıracağın bir sayı verir.
