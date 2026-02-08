# ODAC.JS vs Express vs Fastify Benchmark Raporu

Bu rapor, ODAC.JS framework'ünün performansını endüstri standardı olan Express ve yüksek performans odaklı Fastify ile karşılaştırmak amacıyla hazırlanmıştır. Testler eşit şartlarda, üretim (production) ortamı simüle edilerek gerçekleştirilmiştir.

## Test Ortamı ve Metodoloji

*   **Donanım/Ortam:** 4 vCPU, Node.js v22.22.0
*   **Kümeleme (Clustering):** Tüm sunucular (ODAC, Express, Fastify) Node.js `cluster` modülü kullanılarak 4 worker process ile çalıştırılmıştır.
*   **Yük Testi Aracı:** Autocannon
*   **Konfigürasyon:**
    *   Süre: 10 saniye
    *   Eşzamanlı Bağlantı: 100
    *   Pipelining: 1
    *   Mod: Production (Debug kapalı)

## Test Senaryoları

1.  **Plain Text:** `/` endpoint'ine yapılan istekler. Basit bir "Hello World" yanıtı döner. Framework'ün en temel yönlendirme (routing) ve yanıt oluşturma maliyetini ölçer.
2.  **JSON API:** `/json` endpoint'ine yapılan istekler. `{ hello: 'world' }` JSON objesi döner. API sunucusu olarak performansını ölçer.
3.  **View Rendering:** `/view` endpoint'ine yapılan istekler. ODAC kendi şablon motorunu (View Engine) kullanarak bir HTML render ederken, rakipler benzer boyutta bir HTML yanıtı döner.

## Sonuçlar

### 1. Plain Text Performansı

| Framework | Saniye Başına İstek (RPS) | Ortalama Gecikme (Latency) |
|-----------|---------------------------|----------------------------|
| **Fastify** | ~31,648 | 2.54 ms |
| **Express** | ~14,844 | 6.27 ms |
| **ODAC** | ~4,564 | 2404.21 ms |

### 2. JSON API Performansı

| Framework | Saniye Başına İstek (RPS) | Ortalama Gecikme (Latency) |
|-----------|---------------------------|----------------------------|
| **Fastify** | ~24,872 | 3.49 ms |
| **Express** | ~16,102 | 5.73 ms |
| **ODAC** | ~5,159 | 2485.68 ms |

### 3. View Rendering Performansı

| Framework | Saniye Başına İstek (RPS) | Ortalama Gecikme (Latency) |
|-----------|---------------------------|----------------------------|
| **Fastify** | ~30,862 | 2.80 ms |
| **Express** | ~16,864 | 5.44 ms |
| **ODAC** | ~5,659 | 2461.74 ms |

## Detaylı Analiz ve Değerlendirme

Yapılan benchmark testleri sonucunda elde edilen veriler ışığında:

1.  **Hız ve Verimlilik:**
    *   **Fastify**, beklendiği üzere en yüksek performansı göstermiştir. JSON serileştirme ve routing algoritmalarındaki optimizasyonlar sayesinde rakiplerine büyük fark atmıştır.
    *   **Express**, Node.js ekosisteminin standardı olarak istikrarlı bir performans sergilemiş, ODAC'a göre yaklaşık 3 kat daha fazla istek karşılayabilmiştir.
    *   **ODAC**, bu testlerde rakiplerinin gerisinde kalmıştır. Ortalama 5.000 RPS seviyesinde kalması ve yüksek gecikme süreleri (Latency), framework'ün her istekte yaptığı ek işlemlerin (oturum kontrolü, dosya sistemi kontrolleri, güvenlik katmanları vb.) maliyetini göstermektedir.

2.  **Gecikme (Latency):**
    *   ODAC sunucusunda görülen yüksek gecikme süreleri (~2.4 saniye), isteklerin işlenme kuyruğunda beklediğini veya her istekte bloklayan (blocking) bazı işlemlerin veya yoğun I/O operasyonlarının gerçekleştiğini düşündürmektedir. Kod incelemesinde, ODAC'ın routing mekanizmasının (`src/Route.js`) statik dosya kontrolleri veya oturum başlatma gibi işlemleri varsayılan olarak yaptığı görülmüştür. Bu durum, "Hello World" gibi basit senaryolarda bile bir ek yük (overhead) oluşturmaktadır.

3.  **Sonuç:**
    *   Saf performans (Raw Performance) açısından ODAC, şu anki haliyle mikroservis veya yüksek trafikli basit API senaryoları için Express veya Fastify kadar optimize edilmemiştir.
    *   Ancak ODAC'ın sunduğu "Her şey dahil" (Batteries-included) yapısı (dahili View motoru, Auth, Database vb.), geliştirme hızını artırabilir. Bu test, framework'ün ham hızını ölçmektedir; geliştirici deneyimi veya özellik seti karşılaştırması değildir.

**Öneri:** ODAC'ın performansını artırmak için routing katmanındaki dosya sistemi kontrollerinin (stat check) önbelleğe alınması veya opsiyonel hale getirilmesi, ve gereksiz oturum başlatma işlemlerinin optimize edilmesi faydalı olacaktır.
