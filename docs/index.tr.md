---
hide:
  - navigation
---

<div class="lw-hero" markdown>

# Laneward

<p class="lw-hero__tagline">
Laneward, tek bir depo üzerinde aynı anda birden çok kodlama ajanı çalıştırır,
her birini kendi git worktree'sine koyar ve birbirlerine çarpmalarını engeller.
Onaylanmış iş, editörünü kapattıktan sonra da sürer.
</p>

[Kur](guide/install.md){ .md-button .md-button--primary }
[Neye karşı korumadığını oku](guide/safety-and-limits.md){ .md-button }

</div>

İş planlamaz, kod yazmaz. Neyin yapılacağına sen karar verirsin; Laneward her
görevi kaydeder, ne zaman başlamanın güvenli olduğuna karar verir, ajanı
başlatır, neye dokunduğunu denetler ve sonucu tek ekranda gösterir.

!!! important "Bunu kurulumdan sonra değil, önce oku"

    Laneward `127.0.0.1` üzerinde, **kimlik doğrulaması olmadan** dinler. Tek
    kullanıcılı, güvenilen bir makine için tasarlandı. Dışarı açma.

    Her lane'in worktree'si, sürülen deponun **`.env` dosyasının bir kopyasını**
    alır; yani ajan senin gerçek gizli değerlerini okuyabilir. Yalnızca
    `DATABASE_URL` yeniden yazılır, o lane için açılan veritabanına. Maskeleme
    yok. Bkz. [Güvenlik ve sınırlar](guide/safety-and-limits.md).

## Üç hareketli parça

**Hub**, sürekli çalışan bir web servisidir. Bütün kayıtlar onundur (planlar,
lane'ler, mesajlar, onaylar, bildirimler), `127.0.0.1:8787` üzerinden HTTP
yanıtlar ve panoyu sunar. Kendi başına hiçbir şeye karar vermez: soru yanıtlar ve
yanıtları saklar.

**Conductor**, hub'ın yalnızca kaydettiği işi yapan döngüdür. Her beş saniyede
bir hub'a neyi başlatabileceğini sorar, izin verilen her lane için bir ajan
başlatır, ajanın neye dokunduğunu puanlar ve sonucu geri bildirir. Açık bir
editör oturumu yokken de işin sürmesi için vardır.

**Ajan**, tanımladığın kodlama ajanıdır: Codex, Claude Code veya kendi ham
komutun. Brief'i stdin'den okur, kendisine verilen worktree içinde çalışır ve
çıkış koduyla sinyal verir. Laneward varsayılan bir ajanla gelmez ve sen birini
tanımlayana kadar ilk lane'i reddeder.

## Lane

Lane, tek bir ajana verilen, sınırları belli tek bir iştir. Şunlara sahiptir:

- bitmediği sürece başkasının dokunamayacağı bir **dosya yolu kümesi**,
- `<repo>-worktrees/<lane_id>` altında bir **worktree**,
- `lane/<lane_id>` adında bir **dal**,
- ve genellikle **kendi veritabanı**: sürülen deponun bağlantısı kopyalanıp
  veritabanı adı değiştirilerek oluşturulur.

Yolları kesişen iki lane aynı anda çalışamaz; dahası hub, ilki bitmemişken
ikincisini kaydetmeyi baştan reddeder. Sistemin bütün mesele ettiği şey bu
reddir.

## Bir lane nasıl biter

<div class="lw-diagram lw-diagram--wide" markdown="0">
<svg viewBox="0 0 940 330" role="img" aria-labelledby="lane-life-tr-t lane-life-tr-d">
  <title id="lane-life-tr-t">Bir lane nasıl biter</title>
  <desc id="lane-life-tr-d">Bir lane pending olarak kaydedilir, bütün kapılar geçilince running olur ve running durumundan üç sondan birine varır: completed, failed ya da waiting_approval. Yeniden denenebilir bir hata onu 1. ve 2. deneme için pending durumuna geri gönderir; çözülen bir onay da aynısını yapar.</desc>
  <defs>
    <marker id="lw-arrow-lane-life-tr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path class="lw-arrowhead" d="M0,0 L7,3 L0,6 Z"/>
    </marker>
  </defs>

  <circle class="lw-dot" cx="145" cy="42" r="7"/>
  <path class="lw-edge" d="M 145 49 V 118" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <text class="lw-edge-label" x="157" y="83">kaydedildi</text>

  <g class="lw-node">
    <rect class="lw-node-box" x="80" y="118" width="130" height="44" rx="8"/>
    <text class="lw-node-label" x="145" y="145" text-anchor="middle">pending</text>
  </g>
  <g class="lw-node">
    <rect class="lw-node-box" x="350" y="118" width="130" height="44" rx="8"/>
    <text class="lw-node-label" x="415" y="145" text-anchor="middle">running</text>
  </g>
  <g class="lw-node lw-node--ok">
    <rect class="lw-node-box" x="700" y="38" width="170" height="44" rx="8"/>
    <text class="lw-node-label" x="785" y="65" text-anchor="middle">completed</text>
  </g>
  <g class="lw-node lw-node--bad">
    <rect class="lw-node-box" x="700" y="118" width="170" height="44" rx="8"/>
    <text class="lw-node-label" x="785" y="145" text-anchor="middle">failed</text>
  </g>
  <g class="lw-node lw-node--wait">
    <rect class="lw-node-box" x="700" y="224" width="170" height="44" rx="8"/>
    <text class="lw-node-label" x="785" y="251" text-anchor="middle">waiting_approval</text>
  </g>

  <path class="lw-edge" d="M 210 140 H 350" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <text class="lw-edge-label" x="280" y="130" text-anchor="middle">bütün kapılar geçildi</text>

  <path class="lw-edge" d="M 480 140 H 540 V 60 H 700" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <text class="lw-edge-label" x="622" y="40" text-anchor="middle">çıkış 0, kanıt temiz,</text>
  <text class="lw-edge-label" x="622" y="53" text-anchor="middle">kontroller geçti</text>

  <path class="lw-edge" d="M 480 140 H 700" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <text class="lw-edge-label" x="622" y="118" text-anchor="middle">Git sınırı ihlali,</text>
  <text class="lw-edge-label" x="622" y="131" text-anchor="middle">ya da 3. deneme</text>

  <path class="lw-edge" d="M 480 140 H 540 V 246 H 700" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <text class="lw-edge-label" x="622" y="224" text-anchor="middle">çıkış 10, ya da bir</text>
  <text class="lw-edge-label" x="622" y="237" text-anchor="middle">eskalasyon işareti</text>

  <path class="lw-edge" d="M 415 162 V 190 H 145 V 162" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <text class="lw-edge-label" x="280" y="206" text-anchor="middle">yeniden denenebilir hata, 1. ve 2. deneme</text>

  <path class="lw-edge" d="M 785 268 V 300 H 50 V 140 H 80" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <text class="lw-edge-label" x="420" y="292" text-anchor="middle">onay çözüldü</text>

  <path class="lw-edge" d="M 870 60 H 893" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <circle class="lw-dot-ring" cx="908" cy="60" r="8"/>
  <circle class="lw-dot" cx="908" cy="60" r="4"/>
  <path class="lw-edge" d="M 870 140 H 893" marker-end="url(#lw-arrow-lane-life-tr)"/>
  <circle class="lw-dot-ring" cx="908" cy="140" r="8"/>
  <circle class="lw-dot" cx="908" cy="140" r="4"/>
</svg>
</div>

`completed`, ajanın 0 ile çıktığı, yalnızca sahip olduğu yollara dokunduğu ve
sürülen deponun tanımladığı kontrollerin geçtiği anlamına gelir. İşin **doğru,
gözden geçirilmiş, commit edilmiş veya merge edilmiş** olduğu anlamına gelmez.
Commit ve merge, tasarım gereği elle yapılır.

## Senin yerine yapmayacakları

- İş planlamak, lane'lere bölmek, brief yazmak.
- Commit, merge, push, pull request açmak. Dördü de bilerek elle bırakıldı.
- Lane worktree'sine kopyaladığı `.env` içindeki sırları maskelemek.
- Aynı veritabanına karşı ikinci bir conductor çalışmasını engellemek.
- Herhangi bir kimlik doğrulaması yapmak veya `127.0.0.1` dışında sunmak.

## Projenin durumu

Geliştirme durdu; sebep ilgi değil, para. Çalışan şeyler varsayılmadı, ölçüldü;
koşular [kanıt notlarında](notes/2026-08-19-what-is-left.md) yazılı ve her biri
neyi **kanıtlayamadığını** da söylüyor. Issue ve pull request'ler yanıtsız
kalabilir. Lisans MIT: fork et, başka bir yere taşı, izin gerekmiyor.

Üretimde çalıştıracak bir şey arıyorsan bu o değil. Okunacak, sökülecek veya
devam ettirilecek çalışan bir tasarım arıyorsan, burada olan tam olarak bu; bu
kılavuz da onu çalıştırmanın yolu.

## Nereye gitmeli

<div class="grid cards" markdown>

-   :material-download: __Kurulum ve ilk çalıştırma__

    ---

    Bir hub, bir conductor ve bir veritabanı, bir klondan, bu makinede.

    [:octicons-arrow-right-24: Kur](guide/install.md)

-   :material-tune: __Yapılandırma__

    ---

    Bir ajan tanımla, model katmanlarını doldur, her değişkeni oku.

    [:octicons-arrow-right-24: Yapılandır](guide/configure.md)

-   :material-road-variant: __İlk lane__

    ---

    Gerçek bir iş baştan sona: brief, lane, ajan, karar, sonuç elinde.

    [:octicons-arrow-right-24: Lane sür](guide/first-lane.md)

-   :material-file-document-edit: __Brief yazmak__

    ---

    Ajanın gerçekten okuduğu sözleşme ve onu doğru puanlatmanın yolu.

    [:octicons-arrow-right-24: Brief yaz](guide/writing-briefs.md)

-   :material-lifebuoy: __Sorun giderme__

    ---

    Bir lane neden başlamaz, sistemdeki her ret ne anlama gelir.

    [:octicons-arrow-right-24: Teşhis et](guide/troubleshooting.md)

-   :material-shield-alert: __Güvenlik ve sınırlar__

    ---

    Kimlik doğrulaması yok, kopyalanmış bir `.env` ve gerçekte doğrulanmış olan.

    [:octicons-arrow-right-24: Sınırları oku](guide/safety-and-limits.md)

</div>

[Sözlük](GLOSSARY.md) bu projenin belirli bir anlamda kullandığı terimlerdir ve
[mimari serisi](architecture/workflow-v1/README.md) her `D-0NN` referansının
işaret ettiği karar kaydı dahil, altındaki tasarımdır.
