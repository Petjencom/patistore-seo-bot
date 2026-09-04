# 🐾 Patistore.net - Otonom SEO & İçerik Üretim Botu

Bu bot, **Patistore.net** için her gün 5 adet (2 Adet Kedi/Köpek Irk & Beslenme Rehberi + 3 Adet Şehir & İlçe Bazlı Veteriner/Pet Otel/Pet Taksi/Pet Shop/Pet Kuaför Rehberi) %100 kusursuz RankMath SEO uyumlu içerik üretip WordPress'e otomatik olarak yayınlayan profesyonel bir otomasyon sistemidir.

---

## 🌟 Öne Çıkan Özellikler

1. **RankMath 100/100 SEO Entegrasyonu:**
   - Meta Başlık (50-60 karakter, CTR odaklı)
   - Meta Açıklama (130-155 karakter, CTA içeren)
   - Odak Anahtar Kelime (Focus Keyword)
   - Otomatik `robots: index` tanımı.
2. **Kusursuz Sayfa Hiyerarşisi & AEO (Yapay Zeka Arama Motorları Uyumu):**
   - H2 ve H3 konu derinliği.
   - Doğrudan Cevap Kutusu (Google SGE / AI Overviews için hızlı özet snippet'i).
   - Karşılaştırma ve Fiyat/Özellik Tabloları (`<table>`).
   - Maddeli ve sıralı listeler.
   - SSS (FAQPage JSON-LD Şeması).
3. **Semantik İç Linkleme Ağı (Topic Silo / İçerik Piramidi):**
   - Sitede daha önce yayınlanan yazıları ve kategorileri REST API ile hafızasında tutar.
   - Yeni yazılarda eski ilgili yazılara doğal çapa metinlerle (anchor text) iç backlink verir.
4. **Görsel Otomasyonu & `alt` Etiketleri:**
   - Konuyla birebir ilgili yüksek çözünürlüklü görselleri bulur ve WordPress Ortam Kütüphanesi'ne yükler.
   - Öne çıkan görsel (Featured Image) ve `alt_text`, `caption` alanlarını anahtar kelimelerle doldurur.
5. **Sayfa Düzeni ve Tasarım Korunumu:**
   - Temanızın veya sayfa oluşturucunuzun (Elementor, Gutenberg vb.) hiçbir CSS koduna müdahale etmez; standart WordPress blokları olarak içerik ekler.

---

## 🚀 Kurulum ve Kullanım

### 1. WordPress'ten Uygulama Şifresi Alın
1. WordPress Yönetici Panelinize giriş yapın (`patistore.net/wp-admin`).
2. **Kullanıcılar > Profiliniz** sayfasına gidin.
3. Sayfanın en altına inin ve **Uygulama Şifreleri (Application Passwords)** bölümünü bulun.
4. Yeni şifre adı olarak `Patistore Bot` yazıp **Yeni Uygulama Şifresi Ekle** butonuna tıklayın.
5. Size verilen `xxxx xxxx xxxx xxxx` formatındaki şifreyi kopyalayın.

### 2. .env Dosyasını Yapılandırın
Klasör içindeki `.env.example` dosyasının adını `.env` yapın ve bilgilerinizi girin:

```env
WP_URL=https://patistore.net
WP_USER=admin_kullanici_adiniz
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
GEMINI_API_KEY=AI_API_ANAHTARINIZ
```

### 3. Bağımlılıkları Yükleyin
```bash
pip install -r requirements.txt
```

### 4. Çalıştırma Seçenekleri

#### A) Test / Simülasyon Modu (WordPress'e göndermeden test et)
```bash
python main.py --dry-run
```

#### B) Taslak Olarak Yükleme (Kontrol edip yayınlamak isterseniz)
```bash
python main.py --status draft --count 5
```

#### C) Doğrudan Canlı Yayına Alma (Tam Otomatik)
```bash
python main.py --status publish --count 5
```

---

## ⏰ Otomatik Günlük Çalıştırma (Zamanlayıcı)

### Windows Görev Zamanlayıcı (Task Scheduler) ile:
1. Windows Başlat menüsünden **Görev Zamanlayıcı**'yı açın.
2. **Temel Görev Oluştur** seçeneğine tıklayın (Ad: `Patistore SEO Bot`).
3. Tetikleyiciyi **Günlük** olarak ayarlayın (Örn: Her sabah 09:00).
4. Eylem olarak **Program Başlat**'ı seçin:
   - Program/Komut dosyası: `python.exe` yolunuz.
   - Bağımsız değişkenler: `main.py --status publish --count 5`
   - Başlangıç yeri: Proje klasörünüz (`C:\Users\KOC\.gemini\antigravity\scratch\patistore_seo_bot`)
