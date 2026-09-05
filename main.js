const fs = require('fs');
const path = require('path');
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.log('[!] sharp not loaded, using fallback');
}

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

// Bulletproof HTML Balancer and Sanitizer (Prevents Layout Broken by Unclosed Tags)
function sanitizeAndBalanceHtml(html) {
  if (!html) return '';

  let clean = html.trim();

  // 1. Remove dangling unclosed tag at the very end (e.g., "<p", "<tr", "<td", "<table")
  clean = clean.replace(/<[a-z0-9_-]+[^>]*$/i, '');

  // 2. Self-closing tags that don't need closing
  const selfClosing = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

  // 3. Stack-based tag balancing
  const tagRegex = /<\/?([a-z0-9_-]+)(?:\s+[^>]*)?>/gi;
  const openTags = [];
  let match;

  while ((match = tagRegex.exec(clean)) !== null) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();
    const isClosing = fullTag.startsWith('</');
    const isSelfClose = fullTag.endsWith('/>') || selfClosing.has(tagName);

    if (isSelfClose) continue;

    if (isClosing) {
      const lastIdx = openTags.lastIndexOf(tagName);
      if (lastIdx !== -1) {
        openTags.splice(lastIdx, openTags.length - lastIdx);
      }
    } else {
      openTags.push(tagName);
    }
  }

  // 4. Close any tags that were left open in reverse order
  while (openTags.length > 0) {
    const unclosed = openTags.pop();
    clean += `</${unclosed}>`;
  }

  return clean;
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

// Upload Media to WordPress
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

// Helper to escape XML special characters
// Helper to escape XML
function escapeXml(unsafe) {
  return (unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// Text word-wrapper for banners
function wrapBannerText(text, maxCharsPerLine = 22) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// Predefined vibrant aesthetic mesh gradient color palettes
const COLOR_PALETTES = [
  {
    bg: '#ec4899',
    c1: '#f43f5e', c2: '#8b5cf6', c3: '#3b82f6', c4: '#06b6d4', c5: '#fbbf24', c6: '#d946ef'
  },
  {
    bg: '#6366f1',
    c1: '#3b82f6', c2: '#ec4899', c3: '#f97316', c4: '#10b981', c5: '#a855f7', c6: '#e11d48'
  },
  {
    bg: '#0ea5e9',
    c1: '#06b6d4', c2: '#3b82f6', c3: '#a855f7', c4: '#f43f5e', c5: '#fbbf24', c6: '#10b981'
  },
  {
    bg: '#f97316',
    c1: '#ef4444', c2: '#f59e0b', c3: '#ec4899', c4: '#8b5cf6', c5: '#06b6d4', c6: '#10b981'
  },
  {
    bg: '#8b5cf6',
    c1: '#d946ef', c2: '#ec4899', c3: '#3b82f6', c4: '#06b6d4', c5: '#facc15', c6: '#f43f5e'
  }
];

function generateVibrantMeshSvg(text, paletteIndex = 0) {
  const palette = COLOR_PALETTES[paletteIndex % COLOR_PALETTES.length];
  const upperText = (text || '').toLocaleUpperCase('tr-TR');
  const lines = wrapBannerText(upperText, 20);

  let fontSize = 64;
  if (lines.length > 2) fontSize = 52;
  if (lines.length > 3) fontSize = 42;

  const lineHeight = fontSize * 1.25;
  const totalHeight = lines.length * lineHeight;
  const startY = (675 - totalHeight) / 2 + (fontSize * 0.9);

  const textSvgLines = lines.map((line, idx) => {
    const yPos = startY + (idx * lineHeight);
    return `<text x="600" y="${yPos}" text-anchor="middle" font-family="'Cinzel', 'Playfair Display', 'Times New Roman', 'Georgia', serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" filter="url(#shadow)" letter-spacing="2">${escapeXml(line)}</text>`;
  }).join('\n');

  return `
  <svg width="1200" height="675" viewBox="0 0 1200 675" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="95" result="blur" />
      </filter>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="rgba(0,0,0,0.3)" />
      </filter>
    </defs>

    <!-- Background Base -->
    <rect width="1200" height="675" fill="${palette.bg}" />

    <!-- Vibrant Blurred Color Blobs for Authentic Mesh Gradient -->
    <g filter="url(#blur)">
      <circle cx="200" cy="180" r="280" fill="${palette.c1}" opacity="0.9" />
      <circle cx="950" cy="160" r="320" fill="${palette.c2}" opacity="0.85" />
      <circle cx="600" cy="120" r="260" fill="${palette.c3}" opacity="0.85" />
      <circle cx="150" cy="520" r="300" fill="${palette.c4}" opacity="0.85" />
      <circle cx="980" cy="520" r="320" fill="${palette.c5}" opacity="0.9" />
      <circle cx="550" cy="550" r="290" fill="${palette.c6}" opacity="0.85" />
    </g>

    <!-- Centered High-End Typography -->
    ${textSvgLines}
  </svg>
  `;
}

// Generate Exactly 2 Ultra-HD Images (1 Featured Cover + 1 In-Content, 1200x675) with Vibrant Mesh Gradient
async function generateUltraHDImages(topic, articleTitle) {
  const focusKw = topic.focus_keyword;
  const baseSlug = slugifyTurkish(focusKw);
  const cleanKw = focusKw.charAt(0).toUpperCase() + focusKw.slice(1);
  const finalTitle = articleTitle || `${cleanKw}: 2026 Kapsamlı Uzman Rehberi`;

  const inContentText = `${cleanKw} Rehberi ve Detaylar`;
  const inContentAlt = `${cleanKw} detaylı rehberi ve 2026 uzman tavsiyeleri`;
  const inContentCaption = `${cleanKw} hakkında en çok merak edilenler ve uzman değerlendirmesi`;

  const configs = [
    {
      bannerText: focusKw,
      paletteIdx: 0,
      alt: focusKw,
      caption: finalTitle,
      filename: `${baseSlug}-kapak-gorseli-patistore.jpg`
    },
    {
      bannerText: inContentText,
      paletteIdx: 1,
      alt: inContentAlt,
      caption: inContentCaption,
      filename: `${baseSlug}-detay-rehberi-patistore.jpg`
    }
  ];

  const results = [];

  for (let idx = 0; idx < configs.length; idx++) {
    const cfg = configs[idx];
    console.log(`    [*] 16:9 Canlı Mesh Gradient Görsel ${idx + 1}/2 Üretiliyor (Yazı: "${cfg.bannerText}")`);

    try {
      const svgString = generateVibrantMeshSvg(cfg.bannerText, cfg.paletteIdx);
      const svgBuffer = Buffer.from(svgString);

      let jpgBuffer;
      if (sharp) {
        jpgBuffer = await sharp(svgBuffer)
          .resize(1200, 675)
          .jpeg({ quality: 92 })
          .toBuffer();
      } else {
        jpgBuffer = svgBuffer;
      }

      const uploaded = await uploadImage(jpgBuffer, cfg.filename, cfg.alt, cfg.caption);
      if (uploaded) {
        results.push({
          id: uploaded.id,
          url: uploaded.source_url,
          alt: cfg.alt,
          caption: cfg.caption
        });
      }
    } catch (e) {
      console.error(`Görsel ${idx + 1} oluşturulamadı:`, e.message);
    }
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

  return title;
}

// Generate 2500+ Words Content via gemini-3.6-flash
async function generateBulletproofArticle(task, recentPosts) {
  const linksContext = recentPosts && recentPosts.length > 0
    ? recentPosts.slice(0, 8).map(p => `- <a href="${p.link}">${p.title}</a>`).join('\n')
    : '- <a href="https://www.patistore.net/">Patistore Anasayfa</a>';

  const prompt = `
SEN DÜNYACA ÜNLÜ 25 YILLIK KIDEMLİ VETERİNER HEKİM, AKADEMİSYEN VE SEO OTORİTESİSİN.
Aşağıdaki konu hakkında Türkçe, E-E-A-T ve YMYL standartlarında, TAM 2500+ KELİME UZUNLUĞUNDA, RankMath 100/100 tam uyumlu derinlemesine uzman makalesi yaz.

KONU BİLGİLERİ:
- Odak Anahtar Kelime: "${task.focus_keyword}"
- Kategori: "${task.category || 'Genel'}"
- Tür/Bölge: "${task.title}"

YAZIM VE KALİTE KURALLARI (KESİNLİKLE UYULACAK):
1. UZUNLUK: Makale minimum 2500 kelime olacaktır. Her ana başlık altında en az 4-5 doyurucu alt başlık ve her paragrafta detaylı klinik/akademik açıklamalar yer alacaktır.
2. BAŞLIK FORMATI (ÇOK ÖNEMLİ): Başlıkta KESİNLİKLE "7 Altın Kural", "7 Kural", "7 İpucu", "7 Madde" gibi klişe veya kendini tekrar eden kalıplar KULLANILMAYACAKTIR! Başlık doğrudan odak anahtar kelimeyi içeren, özgün, merak uyandıran ve 2026 güncel rehber formatında olmalıdır.
3. DİL VE AKICILIK: Cümleler ortalama 15 kelimeden kısa, edilgen çatı (passive voice) %7'nin altında, geçiş kelimeleri (transition words: "özellikle", "bu nedenle", "buna ek olarak", "örneğin", "sonuç olarak") %65'in üzerinde olmalıdır. Mikro paragraflar (2-4 cümle) kullanılmalıdır.
4. BİLİMSEL REFERANSLAR: Metin içinde en az 5 saygın otoriteye doğrudan atıf yapılacaktır (Örn: WSAVA Global Nutrition Guidelines, AVMA, Cornell Feline Health Center, TVHB - Türk Veteriner Hekimleri Birliği, Dr. Karen Becker).
5. KARŞILAŞTIRMA TABLOLARI: Metin içinde en az 2 adet detaylı HTML tablosu (<table><thead>...<tbody>...) bulunacaktır (Örn: Yaş gruplarına göre besin/ihtiyaç tablosu, Maliyet ve bütçe planlama tablosu, Belirtiler ve müdahale tablosu).
6. SSS (FAQ) VE SCHEMA.ORG: Makale sonunda en az 7 adet detaylı SSS (Sıkça Sorulan Sorular) ve hemen ardından eksiksiz Schema.org "FAQPage" JSON-LD script bloğu yer alacaktır.
7. SEMANTİK VE 200 KELİMELİK ÖZET: Makalenin en başında 200 kelimelik, odak anahtar kelimeyi ve 20 semantik LSI kelimeyi bold (<strong>) olarak içeren güçlü bir klinik özet bölümü olacaktır.
8. İÇ LİNKLEME: Aşağıdaki linklerden en az 3 tanesini metin içinde doğal bağlamda <a href="..."></a> olarak geçir:
${linksContext}

ÇIKTI FORMATI:
Çıktıyı YALNIZCA doğrudan HTML formatında ver (Markdown veya JSON wrap yapma).
HTML'in ilk satırına şu formatta başlık koy:
<!-- TITLE: ${task.focus_keyword}: 2026 Kapsamlı Uzman Rehberi ve Klinik Tavsiyeler -->
<!-- META_DESC: ${task.focus_keyword} hakkında 2026 güncel veteriner hekim tavsiyeleri, klinik rehber ve bakım ipuçları. Detaylı uzman analizi. -->
Hemen ardından makale HTML içeriğini (özet, <h2>, <h3>, <p>, <table>, <ul>, SSS ve <script type="application/ld+json">) başlat.
`;

  let rawOutput = '';
  const candidateModels = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];

  for (const modelName of candidateModels) {
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      console.log(`    [*] Model [${modelName}] ile 2500+ kelimelik HTML içerik üretiliyor (Deneme ${attempts}/3)...`);

      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 8192,
              temperature: 0.7
            }
          })
        });

        if (response.status === 429) {
          console.log(`    [!] Quota / 429 Rate Limit [${modelName}]. 8 saniye bekleniyor...`);
          await new Promise(r => setTimeout(r, 8000));
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          console.error(`    [-] Model ${modelName} hatası (${response.status}):`, errText.substring(0, 100));
          break;
        }

        const data = await response.json();
        rawOutput = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (rawOutput && rawOutput.trim().length > 500) {
          console.log(`    [+] İçerik başarıyla üretildi (${rawOutput.length} karakter)!`);
          break;
        }
      } catch (e) {
        console.error(`    [-] Bağlantı hatası [${modelName}]:`, e.message);
      }
    }
    if (rawOutput && rawOutput.trim().length > 500) break;
  }

  if (!rawOutput || rawOutput.trim().length < 500) {
    throw new Error('Gemini boş veya çok kısa içerik döndürdü.');
  }

  let extractedTitle = '';
  let extractedMeta = '';
  let contentHtml = rawOutput;

  const titleMatch = rawOutput.match(/<!--\s*TITLE:\s*(.*?)\s*-->/i);
  if (titleMatch) extractedTitle = titleMatch[1].trim();

  const metaMatch = rawOutput.match(/<!--\s*META_DESC:\s*(.*?)\s*-->/i);
  if (metaMatch) extractedMeta = metaMatch[1].trim();

  contentHtml = contentHtml
    .replace(/<!--\s*TITLE:.*?-->/gi, '')
    .replace(/<!--\s*META_DESC:.*?-->/gi, '')
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const finalTitle = generateDiverseTitle(extractedTitle || task.title, task.focus_keyword, task.mode);
  const finalMeta = extractedMeta || `${task.focus_keyword} hakkında 2026 güncel veteriner hekim tavsiyeleri, klinik rehber ve bakım ipuçları.`;

  return {
    title: finalTitle,
    meta_description: finalMeta,
    content_html: contentHtml
  };
}

// Master Task Selector (1 Local Service -> 1 Popular Breed -> 1 Pet Care/Cost)
function selectNextTask(history) {
  const lastMode = history.last_mode || "cost_care";
  let nextMode = "local_service";
  if (lastMode === "local_service") nextMode = "breed";
  else if (lastMode === "breed") nextMode = "cost_care";
  else nextMode = "local_service";

  const publishedSet = new Set(history.published_slugs || []);

  if (nextMode === "local_service") {
    const rawCities = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cities_districts.json'), 'utf8'));
    const rawServices = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'services.json'), 'utf8'));
    const citiesDistricts = Array.isArray(rawCities) ? rawCities : (rawCities.cities_districts || rawCities.districts || []);
    const services = Array.isArray(rawServices) ? rawServices : (rawServices.services || []);

    for (const item of citiesDistricts) {
      for (const srv of services) {
        const slug = slugifyTurkish(`${item.district}-${item.city}-${srv.name}`);
        if (!publishedSet.has(slug)) {
          return {
            mode: "local_service",
            title: `${item.district} ${srv.name} (${item.city})`,
            focus_keyword: `${item.district} ${srv.name.toLowerCase()}`,
            category: srv.category,
            slug: slug
          };
        }
      }
    }
  } else if (nextMode === "breed") {
    const rawBreeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'popular_breeds.json'), 'utf8'));
    const breeds = Array.isArray(rawBreeds) ? rawBreeds : (rawBreeds.topics || rawBreeds.breeds || []);
    for (const b of breeds) {
      const bTitle = b.title || b.name;
      const bKw = b.focus_keyword || `${b.name} bakımı`;
      const slug = slugifyTurkish(bTitle);
      if (!publishedSet.has(slug)) {
        return {
          mode: "breed",
          title: bTitle,
          focus_keyword: bKw.toLowerCase(),
          category: b.category,
          slug: slug
        };
      }
    }
  } else {
    const rawTopics = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'hit_topics.json'), 'utf8'));
    const hitTopics = Array.isArray(rawTopics) ? rawTopics : (rawTopics.topics || []);
    for (const t of hitTopics) {
      const slug = slugifyTurkish(t.title);
      if (!publishedSet.has(slug)) {
        return {
          mode: "cost_care",
          title: t.title,
          focus_keyword: t.focus_keyword.toLowerCase(),
          category: t.category,
          slug: slug
        };
      }
    }
  }

  // Fallback if all covered
  return {
    mode: "cost_care",
    title: `2026 Kedi ve Köpek Sağlık Bakım Rehberi`,
    focus_keyword: `evcil hayvan bakımı`,
    category: `Pet Bakım`,
    slug: `evcil-hayvan-bakimi-${Date.now()}`
  };
}

// Master Execution Flow
async function main() {
  console.log('=== Patistore.net 24/7 Otonom SEO & Sharp Görsel Yayın Motoru Başlatıldı ===');
  const history = loadHistory();
  const task = selectNextTask(history);
  console.log(`[+] Seçilen Görev Modu: [${task.mode.toUpperCase()}]`);
  console.log(`[+] Başlık: ${task.title}`);
  console.log(`[+] Odak Anahtar Kelime: ${task.focus_keyword}`);
  console.log(`[+] Hedef Slug: ${task.slug}`);

  try {
    const recentPosts = await fetchRecentPosts();
    const categoryId = await getOrCreateCategory(task.category || 'Genel');

    // 1. Generate 2500+ Words Content
    const article = await generateBulletproofArticle(task, recentPosts);
    console.log(`[+] 2500+ Kelimelik İçerik Başarıyla Üretildi! Başlık: "${article.title}"`);

    // 2. Generate Exactly 2 1200x675 HD Images with Sharp Typography Burnt-in
    const images = await generateUltraHDImages(task, article.title);
    const featuredImage = images[0] || null;
    const inContentImage = images[1] || null;

    // 3. Inject In-Content Image into HTML (after 2nd H2 Heading)
    if (inContentImage && article.content_html) {
      const imgHtml = `
<figure class="wp-block-image size-large" style="margin:35px 0; text-align:center;">
  <img src="${inContentImage.url}" alt="${inContentImage.alt}" style="width:100%; max-width:1200px; height:auto; aspect-ratio:16/9; object-fit:cover; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.08);" />
  <figcaption style="text-align:center; font-size:13px; color:#64748b; margin-top:8px;">${inContentImage.caption}</figcaption>
</figure>`;

      const h2Matches = [...article.content_html.matchAll(/<\/h2>/gi)];
      if (h2Matches.length >= 2) {
        const insertPos = h2Matches[1].index + h2Matches[1][0].length;
        article.content_html = article.content_html.slice(0, insertPos) + imgHtml + article.content_html.slice(insertPos);
      } else {
        article.content_html = imgHtml + article.content_html;
      }
    }

    // 4. Sanitize and balance all HTML tags to prevent broken layouts
    article.content_html = sanitizeAndBalanceHtml(article.content_html);

    // 5. Publish directly to WordPress as 'publish'
    console.log(`[*] WordPress'e Yayına Alınıyor (Status: publish)...`);
    const postPayload = {
      title: article.title,
      slug: task.slug,
      status: 'publish',
      categories: [categoryId],
      content: article.content_html,
      featured_media: featuredImage ? featuredImage.id : undefined,
      meta: {
        rank_math_title: article.title,
        rank_math_description: article.meta_description,
        rank_math_focus_keyword: task.focus_keyword
      }
    };

    const postRes = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postPayload)
    });

    if (!postRes.ok) {
      const err = await postRes.text();
      throw new Error(`WordPress Post Hatası (${postRes.status}): ${err}`);
    }

    const postData = await postRes.json();
    console.log(`=======================================================`);
    console.log(`[🎉 BAŞARILI] Makale Yayında!`);
    console.log(`[+] ID: ${postData.id}`);
    console.log(`[+] URL: ${postData.link}`);
    console.log(`[+] Başlık: ${article.title}`);
    console.log(`[+] Odak Kelime: ${task.focus_keyword}`);
    console.log(`[+] Öne Çıkan Görsel ID: ${featuredImage ? featuredImage.id : 'Yok'}`);
    console.log(`[+] İçerik İçi Görsel ID: ${inContentImage ? inContentImage.id : 'Yok'}`);
    console.log(`=======================================================`);

    // 5. Update history
    history.published_slugs.push(task.slug);
    history.last_mode = task.mode;
    saveHistory(history);

  } catch (err) {
    console.error('[-] HATA OLUŞTU:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
