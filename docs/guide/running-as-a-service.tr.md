# Servis olarak çalıştırma

Her iki yükleyici de uygulamayı atomik olarak yerine koyar, gerçekten
yükleyecekleri `.env`'i doğrular, bir önkoşul eksikse anlaşılır bir şekilde
reddeder ve tam olarak neyi yapmadıklarını yazdırır. İkisi de `--uninstall`
alır.

!!! warning "Hiçbir platform reboot ya da logout'u atlatmadı"

    Linux'ta, lingering etkinleştirilmedikçe unit'ler logout'ta durur; bu,
    yükleyicinin senin için kasıtlı olarak yapmadığı kalıcı bir host
    değişikliğidir. Windows'ta logon trigger'ı kayıtlıdır ama gerçek bir
    logoff ve logon'dan hiç tetiklenmemiştir. Bu, işin dürüst hâlidir; bkz.
    [kanıt notları](../notes/2026-08-21-logout-and-linger.md).

## Linux

```bash
./install.sh
```

`laneward.service` ve `laneward-conductor.service`'i systemd user unit'leri
olarak kurar ve `DATABASE_URL` bu host'u gösteriyorsa, kendi `pgdata`
volume'üne sahip bir `laneward-db.container` Quadlet'i kurar. `DATABASE_URL`'i
zaten çalıştırdığın bir PostgreSQL'e yönlendirirsen, ikisini de kurmaz ve
bunu belirtir.

Yapılandırma `$XDG_CONFIG_HOME/laneward/.env`'e (mode 600), uygulama
`$XDG_DATA_HOME/laneward/app`'a, veritabanı volume'ü
`$XDG_DATA_HOME/laneward/pgdata`'ya gider. İlk çalıştırmada yükleyici
`.env.example`'ı kopyalar ve herhangi bir şeyi başlatmadan önce onu
düzenlemeni söyler. Ardından bu dosyayı okur ve boş bir `DATABASE_URL`,
sayısal olmayan bir `PORT` ya da `MAX_ACTIVE_LANES`, ne preset ne de ham
template olarak tanımlanmış bir ajan, ya da bildirimler açıkken eksik bir
`notify-send` durumunda devam etmeyi reddeder.

Senin için hiçbir şey başlatılmaz:

```bash
systemctl --user start laneward-db.service laneward.service
cd ~/.local/share/laneward/app
bun --env-file=~/.config/laneward/.env run db/migrate.ts
systemctl --user start laneward-conductor.service
journalctl --user -u laneward.service -u laneward-conductor.service -n 30
```

Dağıtılan uygulama dizininin kendine ait bir `.env`'i yoktur: yalnızca unit,
config dizinindeki `.env`'i okur, bu yüzden oradan elle çalıştırdığın her
komutun `--env-file`'a ihtiyacı vardır.

Logout'u atlatmak için:

```bash
loginctl enable-linger $USER
```

Bu, host'a yapılan kalıcı bir değişikliktir; bu yüzden yükleyici bunu
adlandırır ve sana bırakır.

`./install.sh --uninstall`, unit'leri durdurur, devre dışı bırakır ve
kaldırır; purge etmesini söylemediğin sürece `.env`'ini ve `pgdata`
volume'ünü korur, purge dersen de tam olarak neyi yok ettiğini söyler.

## Windows

Veritabanı için çalışan bir Podman machine'i gerektirir.

```powershell
.\install.ps1
```

Logon'da iki scheduled task kaydeder: `laneward-conductor-hub` API'yi ve
dashboard'ı sunar, `laneward-conductor` conductor loop'unu çalıştırır.
Yapılandırma `%APPDATA%\laneward\.env`'e, uygulama ve veritabanı volume'ü ise
`%LOCALAPPDATA%\laneward`'a gider.

Yine, hiçbir şey başlatılmaz ve hiçbir şey doğrulanmaz:

```powershell
podman machine start
cd $env:LOCALAPPDATA\laneward\app
bun --env-file=$env:APPDATA\laneward\.env run db:migrate
bun --env-file=$env:APPDATA\laneward\.env run start
Start-ScheduledTask -TaskName laneward-conductor
Get-ScheduledTaskInfo -TaskName laneward-conductor
```

Burada tek başına bir exit code hiçbir şey kanıtlamaz: bir lane'in gerçekten
çalıştığını izle.

!!! danger "Task'ı durdurmak çalışan her lane'i ortada bırakır"

    Windows'ta yakalanabilir bir `SIGTERM` yoktur, bu yüzden Linux unit'inin
    aksine conductor lane'lerini geri veremez. Lane'ler, arkalarında hiçbir
    worker olmadan `running` durumunda bırakılır; bu, bir crash'in bıraktığı
    durumla aynıdır. Şununla kurtar:

    ```powershell
    cd $env:LOCALAPPDATA\laneward\app
    bun --env-file=$env:APPDATA\laneward\.env run reset-stranded --dry-run
    bun --env-file=$env:APPDATA\laneward\.env run reset-stranded
    ```

## Fiilen doğrulanan şey

**Linux**: kurulur, iki user service olarak çalışır, kimse izlemeden bir
lane'i tamamlar, kimse bakmıyorken path ownership'ini uygular ve lane'lerini
geri vererek temiz biçimde durur. Birlikte gelen veritabanı container'ı kendi
Quadlet'inden başlar, migration'ı alır ve volume'ü unit'in yeniden
başlatılmasında hayatta kalır. Bu kanıt, host kernel'ini paylaşan ayrıcalıklı
(privileged) bir container'dan gelir, bare metal ya da bir sanal makineden
değil.

**Windows**: kurulur, bir scheduled task olarak çalışır ve kimse bağlı
değilken gerçek bir ajan tarafından yürütülen bir lane'i tamamladı. Task'ı
lane ortasında durdurmak lane'i ortada bırakır ve `reset-stranded` bunu
kurtarır; bu, bir round trip olarak doğrulandı.

**Hiçbiri** bir reboot ya da logout'u atlatmadı. Docker, macOS ve diğer servis
kurulumları denenmedi.
