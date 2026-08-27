# API referansı

Dört alan üzerinde yirmi dört JSON route'u, artı dashboard'ın sunduğu dört
tane. Planlar ve revizyonlar yürütme yetkisini taşır, lane'ler işi taşır,
onaylar bir insanın vermesi gereken kararları taşır.

Her şey `127.0.0.1` üzerinde **kimlik doğrulama olmadan** sunulur. Hatalar tek
biçimde `{"error": "..."}` şeklindedir ve alan düzeyinde bir doğrulama hatası
`{"field": "..."}` ekler. Bir `/health` route'u yoktur: `GET /pending` en
ucuz ayakta-mı kontrolüdür.

## Planlar

### `POST /plans`

Body `{plan_id, title, content}`. `plan_id` bir slug olmalı, `content` bir
JSON nesnesi olmalı. Planı ve revizyon 1'ini oluşturur.

- `201` `{plan_id, revision, revision_id}`
- `400` geçersiz `plan_id`, `title` veya `content`
- `409` `plan already exists`

### `POST /plans/:id/revisions`

Body `{content}`. Mevcut maksimumun bir üstünde numaralandırılmış bir
revizyon ekler. Bunu oluşturmak, daha eski bir revizyona bağlı her lane'den
yürütme yetkisini geri alır.

- `201` `{plan_id, revision, revision_id}`
- `400` geçersiz `content`, `404` `plan not found`

### `POST /plans/:id/revisions/:revision/approve`

Body `{approved_by}`, ya `human` ya da `claude`.

- `200` `{plan_id, revision, revision_id}`
- `400` geçersiz `approved_by`
- `404` `plan not found` veya `plan revision not found`
- `409` `plan revision already approved`

### `GET /plans/:id`

- `200` `{plan_id, title, created_at, revisions[]}`, en yeni revizyon önce.
  Her revizyon `{id, revision, content, created_at, approved_at, approved_by}`
  alanlarını taşır.
- `404` `plan not found`

### `GET /candidates/due`

- `200` `[{plan_id, revision, revision_id}]`: lane'lerinin tümü `completed`
  olan ve henüz bir construction run'ı bulunmayan her plan'ın en yeni
  revizyonu.

## Doğrulama

### `POST /verification-runs`

Body `{plan_revision_id, layer}`, layer `construction`, `clean_run`, `reader`
değerlerinden biri. Durumu `running` olan ve o revizyon ile layer için bir
sonraki attempt numarasına sahip bir run açar.

- `201` `{id, attempt}`, `400` geçersiz alan, `404` `plan revision not found`

### `GET /verification-runs/latest`

Query `plan_revision_id` ve `layer`. En yüksek attempt'i döner.

- `200` `{id, plan_revision_id, layer, attempt, status, detail, started_at, finished_at}`,
  veya bir run yoksa `null`. Eksik bir run `404` değil, `200 null`'dır.

### `POST /verification-runs/:id/result`

Body `{status, detail?}`. `status`, `succeeded`, `failed`, `skipped` veya
`no_findings` değerlerinden biridir; `detail` bir nesne veya null'dur.

- `200` `{id, status, detail, finished_at}`
- `409` `only a reader run can report no findings`
- `409` `verification run already closed`

### `POST /verification-runs/:id/findings`

Body `{finding, subject, out_of_change?, locations?}`. `subject`, `test_diff`
veya `source_context`'tir; her location, `side` değeri `base` veya `head`
olan `{path, side, start_line, end_line}` şeklindedir.

- `201` saklanan bulgu, `state` başlangıçta `open`
- `409` `verification run is not a reader run`, veya `verification run already closed`

### `POST /verification-findings/:id/adjudication`

Body `{state, note?}`, state `accepted`, `rejected`, `deferred`
değerlerinden biri.

- `200` `{id, state, adjudicated_at, adjudication_note}`
- `409` `verification finding already adjudicated`

### `GET /plan-revisions/:id/findings`

- `200` revizyondaki her bulgu, herhangi bir state'te, en eskisi önce.

### `GET /plans/:id/rejected-findings`

- `200` yalnızca reddedilenler. Bir sonraki reader run'a tekrar bildirmemesi
  söylenen şey budur.

## Lane'ler

### `POST /lanes`

Body `{lane_id, lane_type, worktree_path, owned_paths, original_brief, model?,
depends_on?, plan_revision_id?}`.

Sırayla doğrulanır: `lane_id` bir slug; `lane_type` `write` veya
`read_review`; `worktree_path` boş olmamalı **ve diskte var olmalı**;
`owned_paths` boş olmayan bir dizi; `original_brief` boş olmamalı; `model`,
`fast`, `balanced`, `deep` değerlerinden biri; `depends_on` bir dizi.
Varsayılanlar: model `balanced`, bağımlılık yok, attempt sayısı 0.

- `201` `{lane_id, status}`, status `pending`
- `400` `{error: "invalid <field>", field: "<field>"}`
- `409` `{error: "owned_paths conflict", conflicting_lane_id: "<id>"}`,
  `completed` veya `failed` olmayan herhangi bir lane'e karşı

### `GET /lanes`

- `200` `[{lane_id, status, worktree_path, plan_revision_id, plan_id, revision, approved_at}]`,
  lane id'sine göre sıralı.

### `DELETE /lanes/:id`

- `200` `{lane_id, deleted: true}`, `404` `lane not found`,
  `409` `cannot delete a running lane`

### `GET /lanes/:id/gate`

- `200` `{allowed, reason}`, her zaman. Var olmayan bir lane, 404 yerine
  `{allowed: false, reason: "lane not found"}` yanıtı verir. Ret
  gerekçeleri [Sorun giderme](troubleshooting.md#lane-will-not-start)
  sayfasında listelenir.

### `GET /lanes/dispatchable`

- `200` conductor'ın değerlendirebileceği lane'ler: `pending` olanlar ve
  onayı çözülmüş `waiting_approval` olanlar; sonuncular
  `resume_decision` taşır.

### `POST /lanes/:id/start`

Boş body. Gate'i yeniden kontrol eder, ardından lane'i `running`'e taşır.

- `200` `{lane_id, status}`
- `409` `cannot start lane with status '<status>'`, yalnızca `pending` ve
  `waiting_approval` başlayabilir
- `409` `{error: "gate closed", reason: "<gate reason>"}`

### `POST /lanes/:id/messages`

Body `{message_type, question?, answer?, evidence_refs?}`. `message_type`,
`QUESTION`, `CLAIM`, `EVIDENCE`, `APPROVAL_REQUEST`, `FAILURE`, `COMPLETED`
değerlerinden biridir. Bir `APPROVAL_REQUEST`, zaten açık bir tane
olmadıkça, ayrıca bir onay açar ve lane'i `waiting_approval`'da bekletir.

- `201` `{id}`

### `POST /lanes/:id/result`

Body `{exit_code, evidence_passed?}`. Bir lane'in kaderinin karara bağlandığı
yer burasıdır:

| `exit_code` | Etki |
|---|---|
| `0` | `evidence_passed` bir boolean olmalı. True, lane'i tamamlar; false, başarısız kılar. |
| `20` | Yeniden denenebilir hata. Attempt sayısını artırır, `pending`'e döner, üçüncüde `failed` olur. |
| `30` | Policy veya Git sınırı ihlali. Hemen `failed`, yeniden deneme yok. |
| başka her şey | `400`. Exit code 10, burada değil `/messages`'a gider. |

Çözülmemiş bir onayı olan bir lane, sonucu tamamen görmezden gelir ve
mevcut durumunu döner: bir soru sormak için duran bir lane hiçbir karar
üretmemiştir, dolayısıyla çıkış kodu bir karar olarak okunmamalıdır.

### `GET /lanes/:id/evidence`

- `200` `{lane_id, evidence: [{id, created_at, evidence_refs}]}`, en yenisi
  önce.

## Onaylar

### `POST /plan-revisions/:id/approvals`

Bir plan revizyonuna karşı idempotent şekilde bir onay açar: çözülmemiş
bir tane çoğaltılmak yerine döndürülür (`201` yerine `200`).

### `POST /approvals/:id`

Body `{resolved_by, verified_by?, decision?}`. `resolved_by` ve
`verified_by`, `human` veya `claude`'dur; `decision` serbest metindir ve
lane tekrar çalıştığında brief'ine eklenir.

- `200` `{id, resolved_at}`, `409` `approval already resolved`

## Operatörün sorgusu

### `GET /pending`

- `200` `{waiting_approval, failed, findings}`. Bkz.
  [Günlük kullanım](daily-operation.md#pending).

## Dashboard

| Route | Sunduğu |
|---|---|
| `GET /` | Dashboard sayfası |
| `GET /events` | Server-sent events: `lanes`, `plans`, `log` |
| `GET /lanes/:id/log` | Bir lane'in tüm log'u düz metin olarak. Geçersiz bir id'de `400`, henüz log yoksa `404` |
| `GET /pico.css` | Depoya gömülü stil dosyası |

Dashboard router'ı en son mount edilir, böylece yukarıdaki JSON API,
paylaştığı herhangi bir path üzerinde önceliğini korur.
