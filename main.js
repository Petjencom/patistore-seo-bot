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
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function slugifyTurkish(text) {
  return text
    .toLowerCase()
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf-8').replace(/^\uFEFF/, ''));
}

function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch (e) {}
  }
  return { published_slugs: [], last_run: null };
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

function cleanAndParseJSON(rawStr) {
  let str = rawStr.trim();
  if (str.startsWith('```')) {
    str = str.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  try {
    return JSON.parse(str);
  } catch (err1) {
    try {
      const fixed = str.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\\'/g, "'");
      return JSON.parse(fixed);
    } catch (err2) {
      const titleM = str.match(/"title"\s*:\s*"([^"]+)"/);
      const metaTitleM = str.match(/"meta_title"\s*:\s*"([^"]+)"/);
      const metaDescM = str.match(/"meta_description"\s*:\s*"([^"]+)"/);
      const contentM = str.match(/"content_html"\s*:\s*"([\s\S]+)"\s*}/);

      if (titleM && contentM) {
        return {
          title: titleM[1],
          meta_title: metaTitleM ? metaTitleM[1] : titleM[1],
          meta_description: metaDescM ? metaDescM[1] : '',
          content_html: contentM[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
        };
      }
    }
  }
  return null;
}

// 2. WordPress API Helpers
async function getPublishedPosts(limit = 25) {
  try {
    const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?status=publish&per_page=${limit}&_fields=id,title,link,slug,categories`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (res.ok) {
      const data = await res.json();
      return data.map(p => ({
        id: p.id,
        title: p.title?.rendered || '',
        link: p.link || '',
        slug: p.slug || '',
        categories: p.categories || []
      }));
    }
  } catch (e) {
    console.error('Eski yazılar çekilemedi:', e.message);
  }
  return [];
}

async function getOrCreateCategory(categoryName) {
  try {
    const searchRes = await fetch(`${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(categoryName)}`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (searchRes.ok) {
      const cats = await searchRes.json();
      const matched = cats.find(c => c.name.toLowerCase().trim() === categoryName.toLowerCase().trim());
      if (matched) return matched.id;
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
    console.error(`Kategori hatası (${categoryName}):`, e.message);
  }
  return 2;
}

async function uploadImage(imageBuffer, filename, altText, caption) {
  try {
    const uploadRes = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': 'image/jpeg'
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
          caption: caption,
          description: altText
        })
      });
      console.log(`[+] 16:9 AI Görseli Yüklendi: ${filename} (ID: ${media.id}) - Alt: '${altText}'`);
      return { id: media.id, source_url: media.source_url || media.guid?.rendered };
    }
  } catch (e) {
    console.error('Görsel yükleme hatası:', e.message);
  }
  return null;
}

// 3. 100% Pure AI Image Generator (16:9 Landscape - 1200x675)
async function generateThreeImages(topic) {
  const focusKw = topic.focus_keyword || 'evcil hayvan';
  const title = topic.title || '';
  const baseSlug = slugifyTurkish(focusKw);

  const imageConfigs = [
    {
      suffix: 'ana-rehber',
      alt: `${focusKw}`, // Exact Focus Keyword for RankMath
      caption: `${title} uzman rehberi`,
      aiPrompt: `Award-winning hyperrealistic 8k studio photo of ${focusKw}, horizontal landscape 16:9, volumetric soft studio lighting, ultra sharp focus, detailed fur texture, Hasselblad photography, clean modern background`
    },
    {
      suffix: 'beslenme-bakim',
      alt: `${focusKw} beslenme ve günlük bakım tüyoları`,
      caption: `${focusKw} için doğru beslenme ve bakım rutini`,
      aiPrompt: `Hyperrealistic 8k photography of ${focusKw} with healthy nutrition food bowl, horizontal landscape 16:9, bright modern interior living room, natural warm sunlight, cinematic shot`
    },
    {
      suffix: 'saglik-klinik',
      alt: `${focusKw} klinik kontrolleri ve sağlık rehberi`,
      caption: `${focusKw} sağlığı için veteriner hekim önerileri`,
      aiPrompt: `Professional 8k photo of ${focusKw} in a modern clean veterinary clinic examination table, gentle veterinarian hands, horizontal landscape 16:9, soft medical lighting, peaceful atmosphere`
    }
  ];

  const results = [];

  for (let idx = 0; idx < imageConfigs.length; idx++) {
    const cfg = imageConfigs[idx];
    const filename = `${baseSlug}-${cfg.suffix}-ai-patistore.jpg`;
    console.log(`    [*] AI Görsel ${idx + 1}/3 Üretiliyor (16:9 Yatay - 1200x675): "${cfg.alt}"`);

    let buffer = null;

    // Generate via AI Image Generator (Flux.1 / 1200x675 Landscape)
    try {
      const encoded = encodeURIComponent(cfg.aiPrompt);
      const aiUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1200&height=675&nologo=true&model=flux`;
      const res = await fetch(aiUrl);
      if (res.ok) {
        buffer = Buffer.from(await res.arrayBuffer());
      }
    } catch (e) {
      console.error(`AI Görsel ${idx + 1} oluşturulamadı:`, e.message);
    }

    if (buffer) {
      const uploaded = await uploadImage(buffer, filename, cfg.alt, cfg.caption);
      if (uploaded) {
        results.push({
          id: uploaded.id,
          url: uploaded.source_url,
          alt: cfg.alt,
          caption: cfg.caption
        });
      }
    }
  }

  return results;
}

// 4. Master 2500+ Word EEAT & RankMath 100/100 Content Generator
async function generateMasterArticle(topic, recentPosts, inlineImages = []) {
  const focusKw = topic.focus_keyword;
  const isLocal = Boolean(topic.city && topic.district && topic.service);
  const internalLinks = recentPosts.slice(0, 8).map(p => `- Başlık: "${p.title}", Link: "${p.link}"`).join('\n');

  const masterPrompt = `
Sen; 20 yılı aşkın deneyime sahip Kıdemli bir SEO Stratejisti, Veri Odaklı İçerik Mimarı ve aynı zamanda tam 25 yıldır evinde kedi, köpek ve egzotik dostlar büyütmüş, veteriner literatürünü yakından takip eden tutkulu bir Evcil Hayvan Uzmanısın.

GÖREVİN:
Aşağıda verilen anahtar kelime ve konu doğrultusunda; Google'ın en güncel çekirdek güncellemeleriyle (Helpful Content System, Spam Updates, EEAT) ve RankMath SEO algoritmasıyla %100 uyumlu (100/100 Skor), MİNİMUM 2500 KELİMELİK dev bir blog rehberi üretmektir.

KRİTİK RANKMATH 100/100 KURALLARI:
1. SEO Başlığı (H1) & Meta Başlığı: "${focusKw}" tam kelime öbeğini YALIN HALDE İÇERMELİ, AYNI ZAMANDA MUTLAKA BİR RAKAM (Örn: "2026", "7 Altın Kural", "5 Kritik İpucu") ve Güçlü Kelime (Uzman Rehberi, Eksiksiz) içermelidir.
2. SEO Meta Açıklaması: "${focusKw}" tam kelime öbeğini İLK 10 KELİME içinde YALIN HALDE içermelidir (150-160 karakter).
3. Giriş Paragrafı: Metnin İLK CÜMLESİNDE "${focusKw}" tam öbeği YALIN HALDE ve **kalın (bold)** olarak yer almalıdır.
4. Alt Başlıklar: H2 ve H3 başlıklarının en az %50'sinde "${focusKw}" tam öbeği geçmelidir.

KONU BİLGİLERİ:
- Odak Anahtar Kelime (Exact Match): ${focusKw}
- Kategori: ${topic.category}
- Yerel Hizmet mi?: ${isLocal ? `Evet (${topic.city} / ${topic.district} - ${topic.service})` : "Hayır (Rehber/Beslenme/Irk)"}

SİTE İÇİ LİNK VEREBİLECEĞİN MEVCUT YAZILAR:
${internalLinks || "https://www.patistore.net/pet-kuafor/"}

---

### 🧠 PERSONA & DENEYİM DERİNLİĞİ (EEAT)
1. **25 Yıllık Gerçek Deneyim:** Bizzat mama seçmiş, gece acil kliniğe koşmuş, davranış problemlerini sahada çözmüş 25 yıllık bir hayvan ebeveyni samimiyetiyle yaz.
2. **Nadir ve Pratik Bilgiler:** Pratik püf noktaları, nadir bilinen semptomları, tüy/deri ve beslenmedeki gizli hataları aktar.
3. **5 Gerçek Uzman Görüşü:** WSAVA, AVMA, TVHB, Dr. Karen Becker vb. uzman görüşlerine ve güvenilir dış otorite atıflarına (https://wsava.org/) yer ver.
4. **Gerçek Kullanıcı & Hasta Öyküleri:** Yaşanmış somut vakaları doğal bir dille metne dahil et.

---

### 📏 KATI METİN VE DİL KURALLARI
- **Cümle Uzunluğu:** İstisnasız her cümlenin kelime sayısı 15'ten KESİNLİKLE AZ olmalıdır (Maksimum 14 kelime).
- **Edilgen Çatı Limiti:** Toplam metindeki edilgen cümle oranı %7'yi ASLA geçmemelidir. Aktif, net ve canlı bir Türkçe kullanılmalıdır.
- **Geçiş Cümleleri / Bağlaçlar:** İçeriğin en az %65'inde mantıksal geçiş ifadeleri (çünkü, bu nedenle, örneğin, aksine, nitekim vb.) bulunmalıdır.
- **Paragraf Yapısı:** Paragraflar 2 ila 4 kısa cümleden oluşmalıdır.
- **Toplam Hacim:** İçerik minimum 2500 kelime olmalıdır.
- **Bölüm Hacmi:** Her ana başlığın altı doyurucu, derinlemesine bilgi içermelidir.
- **Odak Anahtar Kelime Yoğunluğu:** %1.5 - %2 aralığında olmalıdır.

---

### 🏗️ İÇERİK MİMARİSİ
1. **Giriş:** İlk cümlesinde **${focusKw}** tam öbeği geçmeli. Hemen altında <div class="patistore-quick-summary" style="background:#f8fafc; border-left:4px solid #3b82f6; padding:15px; margin:20px 0; border-radius:6px;"> içinde 45 kelimelik doğrudan AI Overview özet kutusu yer almalı.
2. **İçindekiler Tablosu:** H2 ve H3 başlıklarını listeleyen içindekiler kutusu.
3. **Hiyerarşik Gövde:** Karşılaştırma tabloları (<table>), adım adım listeler (<ol><li>), madde işaretleri (<ul><li>).
4. **Site İçi & Dış Linkler:** Mevcut yazılardan en az 2 tanesine doğal iç backlink (<a href="LINK" title="BAŞLIK">) ve dış otorite kaynak atfı (https://wsava.org/).
5. **Son Kısım: 20 Semantik Arama Terimi:** En sonda 20 adet Google trend terimini içeren 200 kelimelik akıcı özet paragrafı ve **bold** kelimeler.
6. **SSS (FAQ - Schema Uyumlu):** 7 adet derin soru-cevap ve altında <script type="application/ld+json"> FAQPage Schema kodu.
7. **CTA:** Sıcak topluluk eylem çağrısı.

---

### 🚫 YASAKLAR
- "Keyword stuffing" yapmak yasaktır.
- "Günümüz dünyasında...", "Evcil hayvanlar hayatımızın neşesidir..." gibi yapay zeka klişeleriyle başlamak YASAKTIR.
- 15 kelime ve üzeri tek bir cümle dahi kurmak KESİNLİKLE YASAKTIR.

ÇIKTI FORMATI (DÜZ GEÇERLİ JSON):
{
  "title": "${focusKw.charAt(0).toUpperCase() + focusKw.slice(1)}: 2026 Yılında Bilmeniz Gereken 7 Altın Kural",
  "meta_title": "${focusKw.charAt(0).toUpperCase() + focusKw.slice(1)}: 2026 İçin 7 Altın Kural | Patistore",
  "meta_description": "${focusKw} hakkında 2026 yılına özel 25 yıllık uzman rehberi. Beslenme, bakım ve sağlık tüyolarını hemen keşfedin.",
  "content_html": "<p>...</p><h2>...</h2>"
}
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: masterPrompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          responseMimeType: "application/json"
        }
      })
    });

    if (res.ok) {
      const data = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        const parsed = cleanAndParseJSON(rawText);

        if (parsed && inlineImages.length >= 2 && parsed.content_html) {
          const imgHtml1 = `<figure class="wp-block-image size-large" style="margin:30px 0; text-align:center;"><img src="${inlineImages[0].url}" alt="${inlineImages[0].alt}" style="width:100%; max-width:1200px; height:auto; aspect-ratio:16/9; object-fit:cover; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.08);" /><figcaption style="text-align:center; font-size:13px; color:#64748b; margin-top:8px;">${inlineImages[0].caption}</figcaption></figure>`;
          const imgHtml2 = `<figure class="wp-block-image size-large" style="margin:30px 0; text-align:center;"><img src="${inlineImages[1].url}" alt="${inlineImages[1].alt}" style="width:100%; max-width:1200px; height:auto; aspect-ratio:16/9; object-fit:cover; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.08);" /><figcaption style="text-align:center; font-size:13px; color:#64748b; margin-top:8px;">${inlineImages[1].caption}</figcaption></figure>`;

          let h2Count = 0;
          parsed.content_html = parsed.content_html.replace(/<\/h2>/g, (match) => {
            h2Count++;
            if (h2Count === 2) return match + '\n' + imgHtml1;
            if (h2Count === 4) return match + '\n' + imgHtml2;
            return match;
          });
        }

        return parsed;
      }
    } else {
      console.error('Gemini API Hatası:', await res.text());
    }
  } catch (e) {
    console.error('Yapay zeka üretim hatası:', e.message);
  }
  return null;
}

// 5. Main Execution Engine
async function runDailyBatch(count = 5, status = 'publish') {
  console.log('================================================================');
  console.log(`🐾 Patistore.net 3-Yatay AI Görselli 2500+ Kelime & RankMath 100/100 Botu`);
  console.log(`Hedef: ${count} Adet Kapsamlı İçerik | Durum: ${status}`);
  console.log('================================================================\n');

  const history = loadHistory();
  const publishedSlugs = new Set(history.published_slugs || []);

  const cities = loadJson('cities_districts.json').cities;
  const services = loadJson('services.json').services;
  const catTopics = loadJson('cat_topics.json').topics;
  const dogTopics = loadJson('dog_topics.json').topics;

  const recentPosts = await getPublishedPosts(25);
  console.log(`[*] Sitedeki mevcut ${recentPosts.length} yazı iç linkleme ağı için yüklendi.\n`);

  const evergreenPool = [...catTopics, ...dogTopics].filter(t => !publishedSlugs.has(t.title));
  evergreenPool.sort(() => Math.random() - 0.5);

  const localTasks = [];
  for (const city of cities) {
    for (const district of city.districts) {
      for (const srv of services) {
        const key = `${district.toLowerCase()}-${srv.id}`;
        if (!publishedSlugs.has(key)) {
          localTasks.push({
            title: `${district} ${srv.name.toLowerCase()}`,
            focus_keyword: `${district} ${srv.name.toLowerCase()}`,
            category: srv.category,
            city: city.name,
            district: district,
            service: srv.name,
            slug_key: key
          });
        }
      }
    }
  }

  const selectedTasks = [
    ...evergreenPool.slice(0, 2),
    ...localTasks.slice(0, 3)
  ].slice(0, count);

  let successCount = 0;

  for (let i = 0; i < selectedTasks.length; i++) {
    const task = selectedTasks[i];
    const exactSlug = slugifyTurkish(task.focus_keyword);

    console.log(`\n----------------------------------------------------------------`);
    console.log(`[${i + 1}/${selectedTasks.length}] Üretiliyor: "${task.title}"`);
    console.log(`    -> Odak Kelime: "${task.focus_keyword}"`);
    console.log(`    -> Kalıcı Bağlantı: "${exactSlug}"`);

    // 1. Generate 3 Pure AI Images (16:9 Landscape - 1200x675)
    console.log(`    [*] 3 Adet 16:9 Yatay Yapay Zeka Görseli Üretiliyor...`);
    const uploadedImages = await generateThreeImages(task);
    const featuredMediaId = uploadedImages[0]?.id;
    const inContentImages = uploadedImages.slice(1);

    // 2. Generate 2500+ Word EEAT Article
    console.log(`    [*] 25 Yıllık Deneyim & RankMath 100/100 Kriterleriyle İçerik Üretiliyor...`);
    const article = await generateMasterArticle(task, recentPosts, inContentImages);
    if (!article) {
      console.log(`    [x] İçerik üretilemedi, atlanıyor.`);
      continue;
    }

    // 3. Category Management
    const categoryId = await getOrCreateCategory(task.category);

    // 4. Post with Full RankMath 100/100 Meta Fields
    const postPayload = {
      title: article.title,
      content: article.content_html,
      status: status,
      categories: [categoryId],
      slug: exactSlug,
      featured_media: featuredMediaId || undefined,
      meta: {
        rank_math_focus_keyword: task.focus_keyword,
        rank_math_title: article.meta_title,
        rank_math_description: article.meta_description,
        rank_math_robots: 'index'
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
        const created = await postRes.json();
        console.log(`    ✅ BAŞARIYLA YAYINLANDI!`);
        console.log(`       🔗 Link: ${created.link}`);
        console.log(`       ⭐ Odak Kelime: "${task.focus_keyword}"`);
        console.log(`       📝 Başlık: "${article.title}"`);
        console.log(`       🖼️ Yüklenen AI Görsel Sayısı: ${uploadedImages.length} Adet (16:9 Yatay)`);
        successCount++;
        const slugKey = task.slug_key || task.title;
        publishedSlugs.add(slugKey);
        recentPosts.unshift({
          id: created.id,
          title: article.title,
          link: created.link,
          slug: exactSlug,
          categories: [categoryId]
        });
      } else {
        console.error(`    [!] WP Gönderim Hatası:`, await postRes.text());
      }
    } catch (e) {
      console.error(`    [!] Hata:`, e.message);
    }

    await new Promise(r => setTimeout(r, 2500));
  }

  history.published_slugs = Array.from(publishedSlugs);
  history.last_run = new Date().toISOString();
  saveHistory(history);

  console.log('\n================================================================');
  console.log(`🎉 TÜM İÇERİKLER TAMAMLANDI! Başarılı: ${successCount}/${selectedTasks.length}`);
  console.log('================================================================');
}

const args = process.argv.slice(2);
const countArg = parseInt(args.find(a => a.startsWith('--count='))?.split('=')[1] || '5');
const statusArg = args.find(a => a.startsWith('--status='))?.split('=')[1] || 'publish';

runDailyBatch(countArg, statusArg);
