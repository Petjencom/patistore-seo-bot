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

// Strict Turkish Title Case Capitalizer (TDK Uyumlu Büyük Harf Motoru)
function toTurkishTitleCase(str) {
  if (!str) return '';
  const lowercaseWords = new Set(['ve', 'veya', 'ile', 'de', 'da', 'mi', 'mı', 'mu', 'mü', 'için']);

  return str
    .split(' ')
    .map((word, idx, arr) => {
      if (!word) return '';
      const cleanWord = word.trim();
      const lower = cleanWord.toLocaleLowerCase('tr-TR');
      const prevWord = idx > 0 ? arr[idx - 1] : '';
      const isAfterColon = prevWord.endsWith(':');

      if (idx > 0 && lowercaseWords.has(lower) && !isAfterColon) {
        return lower;
      }

      const match = cleanWord.match(/^([^a-zA-ZçÇğĞıIİöÖşŞüÜ]*)(.*)$/);
      if (match && match[2]) {
        return match[1] + match[2].charAt(0).toLocaleUpperCase('tr-TR') + match[2].slice(1);
      }

      return cleanWord.charAt(0).toLocaleUpperCase('tr-TR') + cleanWord.slice(1);
    })
    .join(' ');
}

// Bulletproof HTML Balancer and Sanitizer (Prevents Broken Layouts)
function sanitizeAndBalanceHtml(html) {
  if (!html) return '';

  let clean = html.trim();

  // 1. Remove dangling unclosed tag at the very end
  clean = clean.replace(/<[a-z0-9_-]+[^>]*$/i, '');

  // 2. Self-closing tags
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

  // 4. Close any tags that were left open
  while (openTags.length > 0) {
    const unclosed = openTags.pop();
    clean += `</${unclosed}>`;
  }

  return clean;
}

// Capitalize all H2, H3, H4 headings in HTML with proper Turkish Title Case
function capitalizeHtmlHeadings(html) {
  return html.replace(/<(h[234])([^>]*)>(.*?)<\/\1>/gi, (match, tag, attrs, content) => {
    if (content.includes('<span') || content.includes('<a')) {
      return match;
    }
    return `<${tag}${attrs}>${toTurkishTitleCase(content)}</${tag}>`;
  });
}

// Aggressive prompt leak & meta-chatter cleaner
function cleanArticleHtml(raw) {
  if (!raw) return '';
  let clean = raw.trim();

  // Strip markdown code fences
  clean = clean.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');

  // Strip title and meta desc comments
  clean = clean.replace(/<!--\s*TITLE:.*?-->/gi, '');
  clean = clean.replace(/<!--\s*META_DESC:.*?-->/gi, '');

  // Strip AI conversational preambles
  clean = clean.replace(/^(İşte|Tabii ki|Harika|Aşağıda|Merhaba|Veteriner hekim olarak|Hazırladığım|Bu makalede|Uzman rehberi)[^<]*/gi, '');

  // Strip trailing meta notes
  clean = clean.replace(/<p[^>]*>\s*(Not|Önemli Not|Yazar Notu|Kaynaklar|Hazırlayan|Umarım):.*?(<\/p>|$)/gi, '');

  return clean.trim();
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
    const cleanName = toTurkishTitleCase(categoryName);
    const searchRes = await fetch(`${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(cleanName)}`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (searchRes.ok) {
      const cats = await searchRes.json();
      const existing = cats.find(c => c.name.toLowerCase() === cleanName.toLowerCase());
      if (existing) return existing.id;
    }

    const createRes = await fetch(`${WP_URL}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: cleanName })
    });
    if (createRes.ok) {
      const newCat = await createRes.json();
      console.log(`[+] Yeni Kategori Açıldı: ${cleanName} (ID: ${newCat.id})`);
      return newCat.id;
    }
  } catch (e) {
    console.error(`[-] Kategori oluşturulamadı (${categoryName}):`, e.message);
  }
  return 1;
}

// Get or create tag with Turkish Title Case
async function getOrCreateTag(tagName) {
  const cleanName = toTurkishTitleCase(tagName.trim());
  const slug = slugifyTurkish(cleanName);
  try {
    const searchRes = await fetch(`${WP_URL}/wp-json/wp/v2/tags?search=${encodeURIComponent(cleanName)}`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (searchRes.ok) {
      const existing = await searchRes.json();
      const match = existing.find(t => t.slug === slug || t.name.toLowerCase() === cleanName.toLowerCase());
      if (match) return match.id;
    }

    const createRes = await fetch(`${WP_URL}/wp-json/wp/v2/tags`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: cleanName, slug })
    });
    if (createRes.ok) {
      const created = await createRes.json();
      return created.id;
    }
  } catch (e) {
    console.error(`[-] Tag [${cleanName}] hatası:`, e.message);
  }
  return null;
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
      console.log(`[+] 16:9 HD Görsel Yüklendi: ${filename} (ID: ${media.id}) - Alt: '${altText}'`);
      return { id: media.id, source_url: media.source_url || media.guid?.rendered };
    } else {
      console.error('[-] Media Upload Error:', await uploadRes.text());
    }
  } catch (e) {
    console.error(`[-] Görsel yükleme hatası (${filename}):`, e.message);
  }
  return null;
}

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

// Generate Pet Pattern Icons SVG with High-Contrast Centered Frosted Card
function generatePetPatternSvg(text, subtitle = '') {
  const upperText = (text || '').toLocaleUpperCase('tr-TR');
  const lines = wrapBannerText(upperText, 20);

  let fontSize = 56;
  if (lines.length > 2) fontSize = 46;
  if (lines.length > 3) fontSize = 38;

  const lineHeight = fontSize * 1.25;
  const totalHeight = lines.length * lineHeight;
  const startY = (675 - totalHeight) / 2 + (fontSize * 0.85);

  const textSvgLines = lines.map((line, idx) => {
    const yPos = startY + (idx * lineHeight);
    return `<text x="600" y="${yPos}" text-anchor="middle" font-family="'Montserrat', 'Arial Black', sans-serif" font-size="${fontSize}" font-weight="900" fill="#0f172a" letter-spacing="1.5">${escapeXml(line)}</text>`;
  }).join('\n');

  const subtitleSvg = subtitle
    ? `<text x="600" y="${startY + (lines.length * lineHeight) + 25}" text-anchor="middle" font-family="'Inter', sans-serif" font-size="20" font-weight="600" fill="#64748b" letter-spacing="1">${escapeXml(subtitle)}</text>`
    : '';

  const cardWidth = 960;
  const cardHeight = Math.max(280, totalHeight + 140);
  const cardX = (1200 - cardWidth) / 2;
  const cardY = (675 - cardHeight) / 2;

  return `
  <svg width="1200" height="675" viewBox="0 0 1200 675" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="petDoodle" width="200" height="200" patternUnits="userSpaceOnUse">
        <circle cx="40" cy="40" r="10" fill="none" stroke="#f43f5e" stroke-width="3.5" />
        <circle cx="28" cy="24" r="4.5" fill="none" stroke="#f43f5e" stroke-width="3" />
        <circle cx="40" cy="18" r="4.5" fill="none" stroke="#f43f5e" stroke-width="3" />
        <circle cx="52" cy="24" r="4.5" fill="none" stroke="#f43f5e" stroke-width="3" />

        <path d="M 125,40 L 155,40 M 125,35 A 5,5 0 0,0 120,40 A 5,5 0 0,0 125,45 M 155,35 A 5,5 0 0,1 160,40 A 5,5 0 0,1 155,45" fill="none" stroke="#3b82f6" stroke-width="3.5" stroke-linecap="round" />

        <path d="M 40,130 L 60,110 L 80,130 L 80,165 L 40,165 Z M 52,165 L 52,145 A 8,8 0 0,1 68,145 L 68,165" fill="none" stroke="#10b981" stroke-width="3.5" stroke-linejoin="round" />

        <circle cx="150" cy="140" r="22" fill="none" stroke="#f59e0b" stroke-width="3.5" />
        <path d="M 140,140 Q 150,130 160,140 Q 150,150 140,140 Z M 135,135 L 140,140 L 135,145 Z" fill="none" stroke="#f59e0b" stroke-width="3" />

        <path d="M 95,85 L 125,85 L 120,105 L 100,105 Z" fill="none" stroke="#8b5cf6" stroke-width="3.5" stroke-linejoin="round" />

        <path d="M 180,85 A 6,6 0 0,0 170,85 Q 170,95 180,102 Q 190,95 190,85 A 6,6 0 0,0 180,85 Z" fill="none" stroke="#ec4899" stroke-width="3" />
      </pattern>

      <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="rgba(15,23,42,0.18)" />
        <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="rgba(15,23,42,0.08)" />
      </filter>

      <linearGradient id="cardGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.96" />
        <stop offset="100%" stop-color="#f8fafc" stop-opacity="0.94" />
      </linearGradient>

      <linearGradient id="badgeGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#ff6b00" />
        <stop offset="100%" stop-color="#ff8800" />
      </linearGradient>
    </defs>

    <rect width="1200" height="675" fill="#fcfdfe" />
    <rect width="1200" height="675" fill="url(#petDoodle)" opacity="0.85" />
    <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="24" fill="url(#cardGrad)" stroke="#e2e8f0" stroke-width="2.5" filter="url(#cardShadow)" />

    <g transform="translate(${cardX + (cardWidth - 280) / 2}, ${cardY - 20})">
      <rect width="280" height="40" rx="20" fill="url(#badgeGrad)" />
      <text x="140" y="25" text-anchor="middle" font-family="'Montserrat', sans-serif" font-size="13" font-weight="800" fill="#ffffff" letter-spacing="2">🐾 PATISTORE REHBERİ</text>
    </g>

    ${textSvgLines}
    ${subtitleSvg}
  </svg>
  `;
}

// Generate Exactly 2 Ultra-HD Images (1 Featured Cover + 1 In-Content, 1200x675) with Pet Pattern
async function generateUltraHDImages(topic, articleTitle) {
  const focusKw = topic.focus_keyword;
  const baseSlug = slugifyTurkish(focusKw);
  const cleanKw = toTurkishTitleCase(focusKw);
  const finalTitle = toTurkishTitleCase(articleTitle || `${cleanKw}: 2026 Kapsamlı Uzman Rehberi`);

  const inContentText = toTurkishTitleCase(`${cleanKw} Rehberi ve Detaylar`);
  const inContentSubtitle = "Klinik Analiz ve Uzman Tavsiyeleri";
  const inContentAlt = toTurkishTitleCase(`${cleanKw} Detaylı Rehberi ve 2026 Uzman Tavsiyeleri`);
  const inContentCaption = `${cleanKw} hakkında en çok merak edilenler ve uzman değerlendirmesi`;

  const configs = [
    {
      mainText: cleanKw,
      subText: finalTitle,
      alt: cleanKw,
      caption: finalTitle,
      filename: `${baseSlug}-kapak-gorseli-patistore.jpg`
    },
    {
      mainText: inContentText,
      subText: inContentSubtitle,
      alt: inContentAlt,
      caption: inContentCaption,
      filename: `${baseSlug}-detay-rehberi-patistore.jpg`
    }
  ];

  const results = [];

  for (let idx = 0; idx < configs.length; idx++) {
    const cfg = configs[idx];
    console.log(`    [*] 16:9 Sevimli Pati Desenli Görsel ${idx + 1}/2 Üretiliyor (Yazı: "${cfg.mainText}")`);

    try {
      const svgString = generatePetPatternSvg(cfg.mainText, cfg.subText);
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

  const cleanKw = toTurkishTitleCase(focusKw);

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

  return toTurkishTitleCase(title);
}

// Generate 1500-1800 Words Bulletproof Content (Never Cut Off, Full Structure)
async function generateBulletproofArticle(task, recentPosts) {
  const linksContext = recentPosts && recentPosts.length > 0
    ? recentPosts.slice(0, 8).map(p => `- <a href="${p.link}">${p.title}</a>`).join('\n')
    : '- <a href="https://www.patistore.net/">Patistore Anasayfa</a>';

  const prompt = `
SEN DÜNYACA ÜNLÜ 25 YILLIK KIDEMLİ VETERİNER HEKİM, AKADEMİSYEN VE SEO OTORİTESİSİN.
Aşağıdaki konu hakkında Türkçe, E-E-A-T ve YMYL standartlarında, TAM 1500-1800 KELİME UZUNLUĞUNDA, RankMath 100/100 tam uyumlu eksiksiz uzman makalesi yaz.

KONU BİLGİLERİ:
- Odak Anahtar Kelime: "${task.focus_keyword}"
- Kategori: "${task.category || 'Genel'}"
- Konu/Bölge: "${task.title}"

YAZIM VE KALİTE KURALLARI (KESİNLİKLE VE İSTİSNASIZ UYULACAK):
1. EKSİKSİZLİK: Makale ASLA yarım, kesik veya eksik bırakılmayacaktır. Giriş özeti, en az 5 doyurucu ana başlık (H2), her ana başlık altında 2-3 detaylı alt başlık (H3), en az 2 adet detaylı HTML tablosu (<table><thead>...<tbody>...), adım adım bakım/klinik protokolü, en az 5 adet SSS (Sıkça Sorulan Sorular), klinik uzman değerlendirmesi ve Schema.org "FAQPage" JSON-LD script bloğu ile EKSİKSİZ sonlandırılacaktır.
2. BAŞLIK FORMATI: Başlıkta KESİNLİKLE "7 Altın Kural", "7 Kural", "7 İpucu", "7 Madde" gibi klişe veya birbirini tekrar eden kalıplar KULLANILMAYACAKTIR! Başlık doğrudan odak anahtar kelimeyi içeren, özgün, merak uyandıran ve 2026 güncel rehber formatında olmalıdır.
3. İMLA VE TÜRKÇE KURALLARI: Türk Dil Kurumu (TDK) imla ve yazım kurallarına %100 uyulacak; de/da bağlacı, ki eki, mı/mi soru eki yazımlarında asla hata yapılmayacaktır. Tüm H2 ve H3 başlıklarının her kelimesi büyük harfle (Title Case) başlayacaktır.
4. PROMPT VE META TEMİZLİĞİ: Metin öncesinde veya sonrasında asla "İşte hazırladığım makale", "Veteriner hekim olarak...", "Umarım faydalı olur" gibi yapay zeka meta konuşmaları veya markdown kod blokları yer almayacaktır. Doğrudan HTML etiketleri ile başlanacaktır.
5. KARŞILAŞTIRMA TABLOLARI: Metin içinde en az 2 adet detaylı HTML tablosu (<table><thead>...<tbody>...) bulunacaktır.
6. BİLİMSEL ATIFLAR: Metin içinde saygın otoritelere doğrudan atıf yapılacaktır (WSAVA, AVMA, TVHB).
7. İÇ LİNKLEME: Aşağıdaki linklerden en az 2 tanesini metin içinde doğal bağlamda <a href="..."></a> olarak geçir:
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
      console.log(`    [*] Model [${modelName}] ile içerik üretiliyor (Deneme ${attempts}/3)...`);

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
        const cand = data.candidates?.[0];
        const finishReason = cand?.finishReason;
        const generatedText = cand?.content?.parts?.[0]?.text || '';

        console.log(`    [+] Model yanıtı alındı (${generatedText.length} karakter, Bitiş Kodu: ${finishReason})`);

        if (finishReason === 'STOP' && generatedText.trim().length > 6000) {
          rawOutput = generatedText;
          break;
        } else if (finishReason === 'MAX_TOKENS') {
          console.log(`    [!] Çıktı token limitine takıldı, yeniden deneniyor...`);
        }
      } catch (e) {
        console.error(`    [-] Bağlantı hatası [${modelName}]:`, e.message);
      }
    }
    if (rawOutput && rawOutput.trim().length > 6000) break;
  }

  if (!rawOutput || rawOutput.trim().length < 6000) {
    throw new Error('Gemini boş veya eksik içerik döndürdü. Güvenlik kilidi devreye girdi.');
  }

  let extractedTitle = '';
  let extractedMeta = '';

  const titleMatch = rawOutput.match(/<!--\s*TITLE:\s*(.*?)\s*-->/i);
  if (titleMatch) extractedTitle = titleMatch[1].trim();

  const metaMatch = rawOutput.match(/<!--\s*META_DESC:\s*(.*?)\s*-->/i);
  if (metaMatch) extractedMeta = metaMatch[1].trim();

  let contentHtml = cleanArticleHtml(rawOutput);
  contentHtml = capitalizeHtmlHeadings(contentHtml);

  const finalTitle = generateDiverseTitle(extractedTitle || task.title, task.focus_keyword, task.mode);
  const finalMeta = extractedMeta || `${task.focus_keyword} hakkında 2026 güncel veteriner hekim tavsiyeleri, klinik rehber ve bakım ipuçları.`;

  return {
    title: finalTitle,
    meta_description: finalMeta,
    content_html: contentHtml
  };
}

// Master Task Selector with Live Duplicate Prevention and Tag Generation
async function selectNextTask(history) {
  const lastMode = history.last_mode || "cost_care";
  let modesToTry = ["local_service", "breed", "cost_care"];
  if (lastMode === "local_service") modesToTry = ["breed", "cost_care", "local_service"];
  else if (lastMode === "breed") modesToTry = ["cost_care", "local_service", "breed"];

  // 1. Fetch live WordPress slugs to prevent ANY duplicate publishing
  const livePublishedSlugs = new Set(history.published_slugs || []);
  try {
    const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?per_page=100&_fields=slug,title`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (res.ok) {
      const livePosts = await res.json();
      for (const p of livePosts) {
        if (p.slug) {
          livePublishedSlugs.add(p.slug.toLowerCase());
          livePublishedSlugs.add(p.slug.replace(/-\d+$/, '').toLowerCase());
        }
        if (p.title && p.title.rendered) {
          livePublishedSlugs.add(slugifyTurkish(p.title.rendered));
        }
      }
    }
  } catch (e) {
    console.error('[-] Canlı yazı listesi çekilemedi:', e.message);
  }

  const rawCities = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cities_districts.json'), 'utf8'));
  const rawServices = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'services.json'), 'utf8'));
  const rawBreeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'popular_breeds.json'), 'utf8'));
  const rawTopics = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'hit_topics.json'), 'utf8'));

  const citiesDistricts = [];
  if (rawCities.cities && Array.isArray(rawCities.cities)) {
    for (const c of rawCities.cities) {
      const cityName = c.name || c.city || '';
      if (c.districts && Array.isArray(c.districts)) {
        for (const d of c.districts) {
          citiesDistricts.push({ city: cityName, district: d });
        }
      }
    }
  } else if (Array.isArray(rawCities)) {
    citiesDistricts.push(...rawCities);
  }
  const services = Array.isArray(rawServices) ? rawServices : (rawServices.services || []);
  const breeds = Array.isArray(rawBreeds) ? rawBreeds : (rawBreeds.topics || rawBreeds.breeds || []);
  const hitTopics = Array.isArray(rawTopics) ? rawTopics : (rawTopics.topics || []);

  for (const nextMode of modesToTry) {
    if (nextMode === "local_service") {
      for (const item of citiesDistricts) {
        for (const srv of services) {
          const slug = slugifyTurkish(`${item.district}-${item.city}-${srv.name}`);
          const altSlug = slugifyTurkish(`${item.district}-${srv.name}`);
          if (!livePublishedSlugs.has(slug) && !livePublishedSlugs.has(altSlug)) {
            return {
              mode: "local_service",
              title: `${item.district} ${srv.name} (${item.city})`,
              focus_keyword: `${item.district} ${srv.name.toLowerCase()}`,
              category: srv.category,
              slug: slug,
              tags: [
                `${item.district} Veteriner`,
                srv.name,
                `${item.city} Pet`,
                'Evcil Hayvan Bakımı',
                'Veteriner Tavsiyesi'
              ]
            };
          }
        }
      }
    } else if (nextMode === "breed") {
      for (const b of breeds) {
        const bTitle = b.title || b.name;
        const bKw = b.focus_keyword || `${b.name} bakımı`;
        const slug = slugifyTurkish(bTitle);
        const kwSlug = slugifyTurkish(bKw);
        if (!livePublishedSlugs.has(slug) && !livePublishedSlugs.has(kwSlug)) {
          return {
            mode: "breed",
            title: bTitle,
            focus_keyword: bKw.toLowerCase(),
            category: b.category,
            slug: slug,
            tags: [
              bTitle,
              `${bTitle} Bakımı`,
              b.category || 'Evcil Hayvan Irkları',
              'Evcil Hayvan Sağlığı',
              'Veteriner Tavsiyesi'
            ]
          };
        }
      }
    } else if (nextMode === "cost_care") {
      for (const t of hitTopics) {
        const slug = slugifyTurkish(t.title);
        const kwSlug = slugifyTurkish(t.focus_keyword);
        if (!livePublishedSlugs.has(slug) && !livePublishedSlugs.has(kwSlug)) {
          return {
            mode: "cost_care",
            title: t.title,
            focus_keyword: t.focus_keyword.toLowerCase(),
            category: t.category,
            slug: slug,
            tags: [
              t.title,
              t.focus_keyword,
              t.category || 'Pet Sağlığı',
              'Veteriner Rehberi',
              'Evcil Hayvan Bakımı'
            ]
          };
        }
      }
    }
  }

  // Fallback exhaustive
  for (const item of citiesDistricts) {
    for (const srv of services) {
      const slug = slugifyTurkish(`${item.district}-${item.city}-${srv.name}`);
      if (!livePublishedSlugs.has(slug)) {
        return {
          mode: "local_service",
          title: `${item.district} ${srv.name} (${item.city})`,
          focus_keyword: `${item.district} ${srv.name.toLowerCase()}`,
          category: srv.category,
          slug: slug,
          tags: [
            `${item.district} Veteriner`,
            srv.name,
            `${item.city} Pet`,
            'Evcil Hayvan Bakımı',
            'Veteriner Tavsiyesi'
          ]
        };
      }
    }
  }

  throw new Error("Tüm konular yayınlanmış. Yeni konu ekleyiniz.");
}

// Master Execution Flow
async function main() {
  console.log('=== Patistore.net 24/7 Otonom SEO & Sharp Görsel Yayın Motoru Başlatıldı ===');
  const history = loadHistory();
  const task = await selectNextTask(history);
  console.log(`[+] Seçilen Görev Modu: [${task.mode.toUpperCase()}]`);
  console.log(`[+] Başlık: ${task.title}`);
  console.log(`[+] Odak Anahtar Kelime: ${task.focus_keyword}`);
  console.log(`[+] Hedef Slug: ${task.slug}`);

  try {
    const recentPosts = await fetchRecentPosts();
    const categoryId = await getOrCreateCategory(task.category || 'Genel');

    // 1. Generate Content (Ensuring STOP finishReason and full sections)
    const article = await generateBulletproofArticle(task, recentPosts);
    if (!article.content_html || article.content_html.trim().length < 6000) {
      throw new Error(`[CRITICAL] İçerik üretilemedi veya yetersiz (${article.content_html ? article.content_html.length : 0} karakter)! Boş/kısa yayın kesinlikle engellendi.`);
    }
    console.log(`[+] Eksiksiz Uzman İçeriği Üretildi (${article.content_html.length} karakter)! Başlık: "${article.title}"`);

    // 2. Generate Exactly 2 1200x675 HD Images with Sharp Typography
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

    // 5. Generate and assign WordPress Tag IDs
    const tagIds = [];
    if (task.tags && Array.isArray(task.tags)) {
      for (const tName of task.tags) {
        const tId = await getOrCreateTag(tName);
        if (tId) tagIds.push(tId);
      }
    }
    console.log(`[+] Atanan Etiketler (${tagIds.length} adet):`, tagIds);

    // 6. Publish directly to WordPress as 'publish'
    console.log(`[*] WordPress'e Yayına Alınıyor (Status: publish)...`);
    const postPayload = {
      title: article.title,
      slug: task.slug,
      status: 'publish',
      categories: [categoryId],
      tags: tagIds,
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
    console.log(`[+] Etiket Sayısı: ${tagIds.length}`);
    console.log(`[+] Öne Çıkan Görsel ID: ${featuredImage ? featuredImage.id : 'Yok'}`);
    console.log(`[+] İçerik İçi Görsel ID: ${inContentImage ? inContentImage.id : 'Yok'}`);
    console.log(`=======================================================`);

    // 7. Update history
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
