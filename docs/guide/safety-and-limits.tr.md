# Güvenlik ve sınırlar

Laneward'ın seni neyden koruduğu, neyden korumadığı ve gerçekte neyin
doğrulandığı. Bunu, önemli bir depoya yönlendirmeden önce oku.

## Seni şaşırtacak iki şey

**Hiçbir zaman kimlik doğrulama yok.** Hub `127.0.0.1` üzerinde dinler ve bu
adres yapılandırılmış değil, koda gömülüdür (hardcoded). Porta erişebilen
her şey lane kaydedebilir, onayları çözebilir ve her brief'i okuyabilir.
Tek, güvenilir, tek kullanıcılı bir makine için tasarlanmıştır. Onu bir
tünelin arkasına koyup işi bitmiş sayma.

**Her lane worktree'si, sürülen deponun `.env` dosyasının bir
kopyasını alır.** Ajan gerçek gizli değerlerini okuyabilir: API
anahtarları, token'lar, içinde ne varsa. Yalnızca `DATABASE_URL`, o lane
için oluşturulmuş bir veritabanına yeniden yazılır. Maskeleme
uygulanmamıştır, ve bu sistemdeki bilinen en büyük açıktır.

Bu, belirli bir depo için kabul edilemezse, bugünkü dürüst cevap o
depoyu Laneward ile sürmemektir.

## Ajanın elde etmediği şeyler

Conductor, kendi ortamını devretmek yerine ajanın ortamını inşa eder.
Şunları kaldırır:

- `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_API_TOKEN`
- `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GIT_SSH`,
  `GIT_SSH_COMMAND`
- `DATABASE_URL`, böylece lane kendi `.env` dosyasından kendi değerini okur
- adı `TOKEN`, `PASSWORD`, `PASSWD`, `SECRET`, `API_KEY`, `ACCESS_KEY`,
  `PRIVATE_KEY`, `ASKPASS` veya `AUTH_SOCK` ile biten her şey
- git'i başka bir depoya yönlendirebilecek her `GIT_DIR` ailesi
  değişken

ve global ile system git config'ini `/dev/null`'a ayarlar (Windows'ta
`NUL`), `GIT_TERMINAL_PROMPT=0` yapar, ve bir kullan-at `GH_CONFIG_DIR`
verir.

Okunabilir kalan şey, deponun kendi yerel git config'idir, remote URL
dahil. Bu bilinen bir açıktır, bir gözden kaçırma değil.

## Git sınırı

Laneward git'in sahibidir. Ajanın `PATH`'inin başına bir shim
yerleştirilir, bu yüzden ajanın yaptığı her `git` çağrısı ondan geçer.

İzin verilenler: `status`, `diff`, `log`, `show`, `rev-parse`, `rev-list`,
`ls-files`, `ls-tree`, `cat-file`, `blame`, `describe`, `grep`, `show-ref`,
`for-each-ref`, `merge-base`, `diff-tree`, `diff-index`, `shortlog`,
`name-rev`, artı salt listeleme olarak `branch`, `worktree` ve `stash`, artı
`git --version`.

Subcommand daha değerlendirilmeden doğrudan reddedilenler: `-c`,
`--config-env`, `--exec-path`, `--upload-pack`, `--receive-pack`,
`--namespace`. Bunların her biri bir okumayı keyfi bir çalıştırmaya
dönüştürebilir.

Bir ret tek bir satır yazdırır ve 86 koduyla çıkar:

```
REFUSED: git commit is not permitted. Laneward owns Git.
```

ve argümanları ve çağrının bir okumaya benzeyip benzemediğini kaydeden bir
satırı `<lane_id>.git-guard.jsonl` dosyasına ekler. Çalıştırma sonrasında,
reddedilen bir **mutation** lane'i başarısız kılar; reddedilen bir **okuma**
raporlanır ve lane yine de geçer.

!!! note "Shim, katmanlı savunmanın bir parçasıdır, tek kontrol değil"

    Sandbox'a alınmış bir ajan genellikle bu çağrıları kendisi reddeder.
    Shim'in var olma nedeni, bu sandbox'ın bir keresinde bu makinede
    saatlerce yok olduğunun gözlemlenmiş olmasıdır. Onu ilk hat değil,
    ikinci hat olarak gör.

## Bilinen açıklar, açıkça belirtilmiş

- **Gizli değerler.** Yukarıdaki `.env` kopyası.
- **Kimlik doğrulama yok**, yalnızca `127.0.0.1`, tasarım gereği tek kullanıcı.
- **Çoklu conductor çalıştırmak güvensizdir** ve hiçbir şey tek bir
  conductor'ı zorunlu kılmaz. Bir veritabanına karşı çalışan iki conductor
  aynı lane'ler için çatışır.
- **Git açığı.** Depoya özel yerel git config'i, remote URL dahil,
  bir lane worktree'sinin içinden okunabilir.
- **Güvenlik açığı bildirim kanalı yok.** Bir `SECURITY.md` yoktur ve GitHub
  seviyesinde sertleştirme (hardening) yapılandırılmamıştır.
- **`reset-stranded` çalışan her lane'i sıfırlar.** Mahsur kalmış bir
  lane'i sağlıklı olandan ayırt edemez.
- **Test suite, `DATABASE_URL`'in işaret ettiği her şeyi truncate eder.**
  Adı `_test` ile bitmeyen veya `laneward_lane_` ile başlamayan her
  veritabanını reddeder; dikkatsiz bir export ile lane geçmişin arasında
  duran tek şey budur.

## Neyin doğrulandığı, ve neyin doğrulanmadığı

**Linux.** Kurulur, iki systemd user servisi olarak çalışır, kimse
izlemezken bir lane'i baştan sona tamamlar, kimse izlemiyorken path
ownership'i zorunlu kılar, ve lane'lerini geri teslim ederek temiz bir
şekilde durur. Gönderilen veritabanı container'ı kendi Quadlet'inden başlar,
migration'ı alır, ve volume'u unit'in yeniden başlatılmasından sağ çıkar. Bu
kanıt, host kernel'ini paylaşan ayrıcalıklı (privileged) bir container'dan
gelir, bare metal'dan veya bir sanal makineden değil.

**Windows.** Kurulur, zamanlanmış bir görev olarak çalışır, ve kimse bağlı
değilken gerçek bir ajan tarafından sürülen bir lane'i tamamladı. Görevi
durdurmak lane'i mahsur bırakır, ve `reset-stranded` onu kurtarır; bu bir
round trip olarak doğrulanmıştır.

**Hiçbir platform** bir reboot'tan veya bir logout'tan sağ çıkmadı. Windows
logon trigger'ı gerçek bir döngüden hiç tetiklenmedi. Gerçek bir ajan
Windows görevi altında çalıştı ama systemd altında hiç çalışmadı. Docker,
macOS ve diğer servis kurulumları denenmedi.

[Kanıt notları](../notes/2026-08-19-what-is-left.md), neyin
çalıştırıldığını, ne bulduğunu, ve her durumda neyi kanıtlamadığını
kaydeder.

## Yeşil bir lane'in ne anlama gelip gelmediği

`completed`, ajanın 0 koduyla çıktığı, worktree'sindeki her kirli (dirty)
yolun `owned_paths` içinde olduğu, ve sürülen deponun bildirdiği
check'lerin geçtiği anlamına gelir. İşin doğru, review edilmiş, commit
edilmiş veya merge edilmiş olduğu anlamına **gelmez**. Diff'i okumak hâlâ
senin işindir, ve commit ile merge tasarım gereği manuel kalır.
