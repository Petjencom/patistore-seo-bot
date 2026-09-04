const { generateEditorialSvgBanner } = require('./banner_generator');
const fs = require('fs');
const path = require('path');

// 1. Load Environment Variables
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const key = trimmed.substring(0, idx).trim();
          const val = trimmed.substring(idx + 1).trim();
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

const WP_URL = (process.env.WP_URL || 'https://www.patistore.net').replace(/\/+$/, '');
const WP_USER = process.env.WP_USER || 'PatiAdmin';
const WP_APP_PASS = (process.env.WP_APP_PASSWORD || '').replace(/\s+/g, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const AUTH_HEADER = 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');

// Turkish slug converter
function slugifyTurkish(text) {
  const trMap = {
    'ç': 'c', 'Ç': 'c', 'ğ': 'g', 'Ğ': 'g', 'ı': 'i', 'I': 'i', 'İ': 'i',
    'ö': 'o', 'Ö': 'o', 'ş': 's', 'Ş': 's', 'ü': 'u', 'Ü': 'u'
  };
  return text
    .split('')
    .map(char => trMap[char] || char)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Load publication history
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {}
  return { published_slugs: [], last_mode: "cost_care" };
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    console.error('[-] Geçmiş dosyası kaydedilemedi:', e.message);
  }
}

// Fetch recent posts for internal linking
async function fetchRecentPosts() {
  try {
    const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?per_page=25&_fields=id,title,link,slug`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (res.ok) {
      const posts = await res.json();
      return posts.map(p => ({
        id: p.id,
        title: p.title.rendered,
        link: p.link,
        slug: p.slug
      }));
    }
  } catch (e) {
    console.error('[-] İç linkleme için eski yazılar çekilemedi:', e.message);
  }
  return [];
}

// Get or create category
async function getOrCreateCategory(categoryName) {
  try {
    const searchRes = await fetch(`${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(categoryName)}`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (searchRes.ok) {
      const cats = await searchRes.json();
      const existing = cats.find(c => c.name.toLowerCase() === categoryName.toLowerCase());
      if (existing) return existing.id;
    }

    const createRes = await fetch(`${WP_URL}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: categoryName })
    });
    if (createRes.ok) {
      const newCat = await createRes.json();
      console.log(`[+] Yeni Kategori Açıldı: ${categoryName} (ID: ${newCat.id})`);
      return newCat.id;
    }
  } catch (e) {
    console.error(`[-] Kategori oluşturulamadı (${categoryName}):`, e.message);
  }
  return 1;
}


// Upload Media to WordPress (Supports SVG, JPEG, PNG)
async function uploadImage(imageBuffer, filename, altText, caption, contentType = 'image/jpeg') {
  try {
    const uploadRes = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': contentType
      },
      body: imageBuffer
    });

    if (uploadRes.ok) {
      const media = await uploadRes.json();
      await fetch(`${WP_URL}/wp-json/wp/v2/media/${media.id}`, {
        method: 'POST',
        headers: {
          'Authorization': AUTH_HEADER,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          alt_text: altText,
          caption: caption || altText,
          description: altText
        })
      });
      console.log(`[+] Başlık Yazılı 16:9 HD Görsel Yüklendi: ${filename} (ID: ${media.id}) - Alt: '${altText}'`);
      return { id: media.id, source_url: media.source_url || media.guid?.rendered };
    } else {
      console.error('[-] Media Upload Error:', await uploadRes.text());
    }
  } catch (e) {
    console.error(`[-] Görsel yükleme hatası (${filename}):`, e.message);
  }
  return null;
}



// Generate Exactly 2 Ultra-HD Images (1 Featured Cover + 1 In-Content, 1200x675) with Custom Title Typography
async function generateUltraHDImages(topic, articleTitle) {
  const focusKw = topic.focus_keyword;
  const baseSlug = slugifyTurkish(focusKw);
  const cleanKw = focusKw.charAt(0).toUpperCase() + focusKw.slice(1);
  const finalTitle = articleTitle || `${cleanKw}: 2026 Kapsamlı Uzman Rehberi`;

  const results = [];

  // 1. ÖNE ÇIKAN KAPAK GÖRSELİ (Üzerinde Odak Anahtar Kelime ve Konu Başlığı Yazan 1200x675 HD Grafik)
  console.log(`    [*] 1. Öne Çıkan Kapak Görseli Hazırlanıyor (Başlık Baskılı): "${focusKw}"`);
  try {
    const coverBuffer = generateEditorialSvgBanner({
      title: cleanKw,
      badge: '🐾 PATISTORE UZMAN REHBERİ',
      subtitle: finalTitle,
      isCover: true
    });
    const coverFilename = `${baseSlug}-kapak-gorseli-patistore.svg`;
    const uploadedCover = await uploadImage(coverBuffer, coverFilename, focusKw, finalTitle, 'image/svg+xml');
    if (uploadedCover) {
      results.push({
        id: uploadedCover.id,
        url: uploadedCover.source_url,
        alt: focusKw,
        caption: finalTitle
      });
    }
  } catch (e) {
    console.error('Kapak görseli oluşturulamadı:', e.message);
  }

  // 2. İÇERİK İÇİ GÖRSEL (Üzerinde Alternatif Odak / Detay Başlığı Yazan 1200x675 HD Grafik)
  const inContentSubtitle = `${cleanKw} İçin 2026 Veteriner Hekim Tavsiyeleri ve Bakım İpuçları`;
  console.log(`    [*] 2. İçerik İçi Görsel Hazırlanıyor (Detay Başlıklı): "${focusKw} detaylı rehber"`);
  try {
    const contentBuffer = generateEditorialSvgBanner({
      title: `${cleanKw} Rehberi`,
      badge: '⭐ KLİNİK ANALİZ &amp; TAVSİYELER',
      subtitle: inContentSubtitle,
      isCover: false
    });
    const contentFilename = `${baseSlug}-detay-rehberi-patistore.svg`;
    const uploadedContent = await uploadImage(contentBuffer, contentFilename, `${focusKw} detaylı rehber`, inContentSubtitle, 'image/svg+xml');
    if (uploadedContent) {
      results.push({
        id: uploadedContent.id,
        url: uploadedContent.source_url,
        alt: `${focusKw} detaylı rehber`,
        caption: inContentSubtitle
      });
    }
  } catch (e) {
    console.error('İçerik görseli oluşturulamadı:', e.message);
  }

  return results;
}


// Strict Title Sanitizer & Dynamic Variety Generator
function generateDiverseTitle(rawTitle, focusKw, mode) {
  let title = (rawTitle || '').trim();

  // Banned repetitive phrases check
  const isBanned = /7\s*alt[ıi]n\s*kural|alt[ıi]n\s*kurallar?|7\s*kural|bilmeniz\s*gereken\s*7|7\s*ipucu|7\s*madde/i.test(title);

  const cleanKw = focusKw.charAt(0).toUpperCase() + focusKw.slice(1);

  if (isBanned || title.length < 15 || !title.toLowerCase().includes(focusKw.toLowerCase())) {
    const localTemplates = [
      `${cleanKw}: 2026 Güncel Fiyatları, Hizmet Detayları ve Doğru Seçim Rehberi`,
      `${cleanKw}: En Güvenilir Tavsiyeler, Kullanıcı Yorumları ve İpuçları (2026)`,
      `${cleanKw}: Profesyonel Hizmet Seçerken Dikkat Edilmesi Gerekenler`,
      `${cleanKw}: 2026 Yılında Güvenilir Hizmet Arayanlar İçin Kapsamlı Rehber`,
      `${cleanKw}: Bölgesel Fiyat Listesi, Uzman Önerileri ve Klinik/Tesis İncelemesi`
    ];

    const breedTemplates = [
      `${cleanKw}: Karakter Özellikleri, Beslenme Programı ve Bakım Kılavuzu`,
      `${cleanKw}: 2026 Yılına Özel Kapsamlı Irk ve Günlük Bakım Rehberi`,
      `${cleanKw}: Sağlık İpuçları, Egzersiz İhtiyacı ve Evde Yaşam Tavsiyeleri`,
      `${cleanKw}: Veteriner Hekim Onaylı Tüy ve Beslenme Rehberi (2026)`,
      `${cleanKw}: Kökeni, Eğitimi ve Sahiplenmeden Önce Bilinmesi Gerekenler`
    ];

    const careTemplates = [
      `${cleanKw}: 2026 Güncel Maliyetleri, Klinik İpuçları ve Uzman Tavsiyeleri`,
      `${cleanKw}: Evde Doğru Uygulama Adımları ve Veteriner Değerlendirmesi`,
      `${cleanKw}: 2026 Yılında Evcil Hayvan Sahiplerinin Bilmesi Gereken Detaylar`,
      `${cleanKw}: Bütçe Planlaması, Sağlık Önlemleri ve Adım Adım Bakım`,
      `${cleanKw}: En Çok Merak Edilen Sorular, Çözümler ve 2026 Analizi`
    ];

    let chosenPool = localTemplates;
    if (mode === 'breed') chosenPool = breedTemplates;
    else if (mode === 'cost_care') chosenPool = careTemplates;

    const randIdx = Math.floor(Math.random() * chosenPool.length);
    title = chosenPool[randIdx];
  }

  // Ensure title starts with focus keyword cleanly
  if (!title.toLowerCase().startsWith(focusKw.toLowerCase())) {
    title = `${cleanKw}: ${title.replace(/^[^:]+:\s*/, '')}`;
  }

  // Clean double colons and normalize spaces
  title = title.replace(/:\s*:/g, ':').replace(/\s+/g, ' ').trim();
  return title;
}

// Generate Genuine 2500+ Word EEAT Article via Gemini (Direct HTML Generation - Zero JSON Truncation)
async function generateMasterArticle(topic, recentPosts = []) {
  const focusKw = topic.focus_keyword;
  const isLocal = topic.type === 'local';

  const internalLinksPrompt = recentPosts.length > 0
    ? `\nSİTEDEKİ MEVCUT YAZILAR (İÇ LİNKLEME İÇİN):\n${recentPosts.slice(0, 10).map(p => `- Başlık: "${p.title}" | URL: "${p.link}"`).join('\n')}\nKURAL: Metin içinde doğal olarak en az 3-4 farklı yere yukarıdaki linklerden <a href="URL">Uygun Başlık</a> şeklinde dofollow iç link ver.`
    : '';

  const prompt = `
Sen; 20 yılı aşkın deneyime sahip Kıdemli bir SEO Stratejisti, Veri Odaklı İçerik Mimarı ve aynı zamanda tam 25 yıldır evinde kedi, köpek ve egzotik dostlar büyütmüş, veteriner literatürünü yakından takip eden tutkulu bir Evcil Hayvan Uzmanısın.

GÖREVİN:
Kullanıcının vereceği anahtar kelimeler doğrultusunda Google EEAT ve Helpful Content standartlarına %100 uyumlu, derinlemesine saha tecrübesi içeren, internetteki yüzeysel bilgilerin ötesine geçen, MİNİMUM 2500 KELİMELİK DEVASA VE EKSİKSİZ bir Türkçe rehber yazmaktır.

HEDEF KONU: "${topic.title}"
ODAK ANAHTAR KELİME: "${focusKw}"

KATI YAZIM VE DİL KURALLARI:
1. Cümle Uzunluğu: İstisnasız her cümlenin kelime sayısı 15'ten KESİNLİKLE AZ olmalıdır (Maksimum 14 kelime).
2. Edilgen Çatı: Pasif cümle oranı %7'yi ASLA geçmemelidir. Canlı, dinamik, etken Türkçe kullan.
3. Geçiş Cümleleri: İçeriğin en az %65'inde mantıksal geçiş ifadeleri (çünkü, bu nedenle, örneğin, aksine, nitekim vb.) bulunmalıdır.
4. Paragraf Yapısı: Paragraflar 2 ila 4 kısa cümleden oluşmalı, asla bloklaşmamalıdır.
5. Bilimsel Referans: WSAVA, AVMA, TVHB, Dr. Karen Becker gibi otoritelere atıf yap.
6. Gerçek Vakalar: Yaşanmış klinik vaka öyküleri, hasta hikayeleri ve pratik tüyolar aktar.
7. Zengin Unsurlar: Karşılaştırmalı HTML <table> tabloları, maddeli ve numaralı listeler (<ul>, <ol>).
8. SSS (FAQ): 7 Soruluk detaylı Soru-Cevap bölümü ve Schema.org uyumlu FAQPage JSON-LD bloğu ekle.
9. 20 Kalın Terimli Özet: En sonda 20 farklı semantik terimin <strong>kalın</strong> yazıldığı 200 kelimelik özet.
10. BAŞLIK KURALI: "7 Altın Kural", "7 Kural", "7 İpucu" gibi kalıplar KULLANILMAYACAK.
${internalLinksPrompt}

ÇIKTI: Sadece ve sadece makalenin zengin HTML kodunu (<p>, <h2>, <h3>, <table>, <ul>, <script>) döndür. Markdown backtick (```html) koyma.
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192
        }
      })
    });

    if (res.ok) {
      const d = await res.json();
      let html = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
      html = html.replace(/```html|```/g, '').trim();

      if (html.length > 500) {
        const cleanKw = focusKw.charAt(0).toUpperCase() + focusKw.slice(1);
        const dynamicTitle = `${cleanKw}: 2026 Kapsamlı Bakım, Sağlık ve Karakter Rehberi`;
        const metaDesc = `${focusKw} hakkında 2026 yılına özel 25 yıllık uzman rehberi. Beslenme, bakım, maliyet ve sağlık tüyolarını hemen keşfedin.`;

        return {
          title: dynamicTitle,
          meta_title: `${dynamicTitle.substring(0, 50)} | Patistore`,
          meta_description: metaDesc,
          content_html: html
        };
      }
    }
  } catch(e) {
    console.error('[-] Gemini 3.6-flash Hatası:', e.message);
  }

  return null;
}

// Master Execution Runner (20-Minute Cyclical Architecture)
async function runBot(options = {}) {
  const status = options.status || 'publish';
  console.log('================================================================');
  console.log(`🐾 Patistore.net 20 Dakikalık 3 Kulvarlı SEO Yayın Motoru`);
  console.log(`Hedef: 1 Adet Kapsamlı İçerik (Döngüsel) | Durum: ${status}`);
  console.log('================================================================\n');

  const history = loadHistory();
  const publishedSlugs = new Set(history.published_slugs || []);
  let lastMode = history.last_mode || "cost_care";

  const recentPosts = await fetchRecentPosts();
  console.log(`[*] Sitedeki mevcut ${recentPosts.length} yazı iç linkleme ağı için yüklendi.\n`);

  // Load Data Pools
  const citiesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cities_districts.json'), 'utf8'));
  const servicesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'services.json'), 'utf8'));
  const popularBreeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'popular_breeds.json'), 'utf8'));
  const hitTopics = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'hit_topics.json'), 'utf8'));

  // Determine Next Mode in 3-Tier Cycle: local -> breed -> cost_care -> local
  let nextMode = "local";
  if (lastMode === "local") nextMode = "breed";
  else if (lastMode === "breed") nextMode = "cost_care";
  else nextMode = "local";

  let task = null;

  if (nextMode === "local") {
    // Pick next local service in Population Priority order
    for (const city of citiesData.cities) {
      for (const district of city.districts) {
        for (const srv of servicesData.services) {
          const focusKw = `${district} ${srv.name}`.toLowerCase();
          const slugKey = slugifyTurkish(focusKw);
          if (!publishedSlugs.has(slugKey)) {
            task = {
              title: `${city.name} ${district} ${srv.name} Rehberi: Fiyatlar ve Güvenilir Tavsiyeler`,
              category: srv.category,
              focus_keyword: focusKw,
              city: city.name,
              district: district,
              service: srv.name,
              slug_key: slugKey,
              type: 'local',
              mode: 'local'
            };
            break;
          }
        }
        if (task) break;
      }
      if (task) break;
    }
  } else if (nextMode === "breed") {
    // Pick next popular breed
    for (const b of popularBreeds.topics) {
      const slugKey = slugifyTurkish(b.focus_keyword);
      if (!publishedSlugs.has(slugKey)) {
        task = {
          ...b,
          slug_key: slugKey,
          mode: 'breed'
        };
        break;
      }
    }
  } else if (nextMode === "cost_care") {
    // Pick next high-traffic care/cost topic
    for (const h of hitTopics.topics) {
      const slugKey = slugifyTurkish(h.focus_keyword);
      if (!publishedSlugs.has(slugKey)) {
        task = {
          ...h,
          slug_key: slugKey,
          mode: 'cost_care'
        };
        break;
      }
    }
  }

  // Fallback if current pool exhausted
  if (!task) {
    console.log(`[!] ${nextMode} havuzu geçici olarak tamamlandı, alternatif seçiliyor...`);
    task = {
      title: "2026 Yılı Evcil Hayvan Sağlığı ve Veteriner Bakım Rehberi",
      category: "Evcil Hayvan Sağlığı",
      focus_keyword: "evcil hayvan sağlığı rehberi",
      slug_key: "evcil-hayvan-sagligi-rehberi",
      mode: 'fallback'
    };
  }

  const exactSlug = task.slug_key;

  console.log(`----------------------------------------------------------------`);
  console.log(`[Döngü Modu: ${task.mode.toUpperCase()}] Üretiliyor: "${task.title}"`);
  console.log(`    -> Odak Kelime: "${task.focus_keyword}"`);
  console.log(`    -> Kalıcı Bağlantı: "${exactSlug}"`);

  // 1. Generate 2500+ Word EEAT Article
  console.log(`    [*] 25 Yıllık Deneyim & RankMath 100/100 Kriterleriyle İçerik Üretiliyor...`);
  const article = await generateMasterArticle(task, recentPosts);

  if (!article) {
    console.log(`    [x] İçerik üretilemedi.`);
    return;
  }

  // 2. Generate 2 Crystal-Clear Editorial HD Images (1 Cover + 1 In-Content)
  console.log(`    [*] Konuyla %100 Örtüşen 2 Crystal-Clear HD Görsel Yükleniyor (1 Kapak + 1 İçerik İçi)...`);
  const uploadedImages = await generateUltraHDImages(task, article.title);
  const featuredMediaId = uploadedImages[0]?.id;
  const inContentImage = uploadedImages[1];

  // 3. Inject In-Content Image into HTML (after 2nd H2 Heading)
  if (inContentImage && article.content_html) {
    const imgHtml = `<figure class="wp-block-image size-large" style="margin:30px 0; text-align:center;"><img src="${inContentImage.url}" alt="${inContentImage.alt}" style="width:100%; max-width:1200px; height:auto; aspect-ratio:16/9; object-fit:cover; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.08);" /><figcaption style="text-align:center; font-size:13px; color:#64748b; margin-top:8px;">${inContentImage.caption}</figcaption></figure>`;

    let h2Count = 0;
    article.content_html = article.content_html.replace(/<\/h2>/g, (match) => {
      h2Count++;
      if (h2Count === 2) return match + '\n' + imgHtml;
      return match;
    });
  }

  // 4. Category Management
  const categoryId = await getOrCreateCategory(task.category);

  // 5. Post with Full RankMath 100/100 Meta Fields
  const cleanFinalTitle = generateDiverseTitle(article.title, task.focus_keyword, task.mode);
  const cleanMetaTitle = `${cleanFinalTitle.substring(0, 50)} | Patistore`;

  const postPayload = {
    title: cleanFinalTitle,
    content: article.content_html,
    status: status,
    categories: [categoryId],
    slug: exactSlug,
    featured_media: featuredMediaId || undefined,
    meta: {
      rank_math_focus_keyword: task.focus_keyword,
      rank_math_title: cleanMetaTitle,
      rank_math_description: article.meta_description || '',
      rank_math_robots: 'index,follow'
    }
  };

  try {
    const postRes = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postPayload)
    });

    if (postRes.ok) {
      const postData = await postRes.json();
      publishedSlugs.add(exactSlug);
      history.published_slugs = Array.from(publishedSlugs);
      history.last_mode = task.mode;
      saveHistory(history);

      console.log(`    ✅ BAŞARIYLA YAYINLANDI!`);
      console.log(`       🔗 Link: ${postData.link}`);
      console.log(`       ⭐ Odak Kelime: "${task.focus_keyword}"`);
      console.log(`       📝 Başlık: "${postData.title.rendered}"`);
      console.log(`       🖼️ Yüklenen HD Görsel Sayısı: ${uploadedImages.length} Adet (1200x675 Crystal-Clear)`);
    } else {
      console.error(`    [-] WordPress Yayın Hatası:`, await postRes.text());
    }
  } catch (e) {
    console.error(`    [-] Yayınlama hatası:`, e.message);
  }

  console.log('\n================================================================');
  console.log(`🎉 20 DAKİKALIK YAYIN GÖREVİ TAMAMLANDI!`);
  console.log('================================================================\n');
}

// CLI args
const args = process.argv.slice(2);
const statusArg = args.find(a => a.startsWith('--status='))?.split('=')[1] || 'publish';

runBot({ status: statusArg });
