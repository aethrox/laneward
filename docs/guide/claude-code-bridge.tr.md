# Claude Code köprüsü

`scripts/bridge.ts`, etkileşimli bir Claude Code oturumunu çalışan bir hub'a
bağlar. İsteğe bağlıdır: lane'ler onsuz da çalışır. Onunla birlikte oturum,
sen sormadan önce neyin bloke olduğunu bilir ve istersen hub'ın onaylamadığı
bir lane worktree'si içinde düzenleme yapmayı reddeder.

`HUB_URL`, okuduğu tek değişkendir (varsayılan `http://127.0.0.1:8787`) ve
yaptığı her istek iki saniye sonra zaman aşımına uğrar.

## Bu depoda neyin bağlı olduğu

`.claude/settings.json` içinde tek bir hook:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run ${CLAUDE_PROJECT_DIR}/scripts/bridge.ts state",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Her oturumun başında `bridge state`, `/pending` ve `/lanes` uç noktalarını
okur ve oturuma tek satırlık bir bağlam verir:

```
Laneward: 1 lane(s) blocked on an unapproved plan revision; 2 lane(s) waiting on
a human; 0 failed lane(s).
```

Hub kapalıysa yine de geçerli bir çıktı döner ve oturum başlangıcını
başarısız kılmak yerine bunu belirtir:

```
Laneward is unreachable; gate status is unavailable.
```

## Gate ve neden bağlı olmadığı

`bridge gate`, `PreToolUse` sözleşmesini eksiksiz uygular: hook payload'unu
stdin üzerinden okur ve araç çağrısının devam edip edemeyeceğine karar verir.

1. Çalışma dizini bağlı bir worktree içinde **değilse**, izin ver. Bu bir
   dosya sistemi kontrolüdür ve herhangi bir HTTP isteğinden önce gerçekleşir;
   böylece bir hub kesintisi kendi checkout'undaki çalışmayı asla
   engelleyemez.
2. `Bash` için, komut hiçbir shell meta karakteri içermediği sürece salt
   okunur bir izin listesindeki (`git status`, `git log`, `git diff`, `ls`,
   `cat`, `grep`, `rg`, `find` ve benzerleri) her şeye izin ver.
3. Aksi halde bu dizinin hangi lane'e ait olduğunu hub'a sor ve
   `GET /lanes/:id/gate` ile o lane'in işlem yapıp yapamayacağını sor.
4. Bozuk bir payload, erişilemeyen bir hub veya zaman aşımı dahil, başka her
   şey reddir.

Bir ret, 2 kodu ile çıkar ve deny kararını gate'in kendi gerekçesiyle birlikte
verir; oturumda sana gösterilen de budur.

!!! warning "Bilinçli olarak bağlanmadı ve bunu anlamaya değer"

    4. adım fail-closed'dır (kapalı-güvenli). `Edit`, `Write` ve `Bash` önüne
    fail-closed bir HTTP çağrısı koymak, bir hub kesintisinin kendi
    checkout'unu, hook'u çözmek için ihtiyaç duyacağın araçlar dahil,
    kilitlemesi anlamına gelir. Bu takas değerlendirildi ve reddedildi; bkz.
    [Hedef mimari](../architecture/workflow-v1/02-target-architecture.md).

    Yine de bağlarsan, kaçış yolunun `.claude/settings.json` dosyasını
    oturumun dışından düzenlemek olduğunu bil.

## İki kolaylık alt komutu

HTTP çağrısını elle yazmadan bir plan göndermek:

```bash
bun scripts/bridge.ts plan submit --title "Login hardening" --content plan.json
bun scripts/bridge.ts plan submit --title "Login hardening" --content plan.json --id login-hardening
```

Plan id'sini ve revizyon id'sini yazdırır. `--id` geçir: üretilen bir UUID
daha sonra adreslenemez ve revizyon eklemek için plan id'sine ihtiyacın
vardır.

Bir lane kaydetmek, ki bu basitçe ortamın ve onun çıkış koduyla
`scripts/new-lane.ts`'e yönlendirir:

```bash
bun scripts/bridge.ts lane create fix-login brief.md 'src/auth/*'
```

Başka her şey kullanım satırını yazdırır:

```
Usage: bridge <state|gate|plan submit|lane create>
```
