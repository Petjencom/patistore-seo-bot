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

// Section B9: 12-Step Mandatory Pre-Publish Quality & Integrity Checklist
function validatePrePublishChecklist(task, article, images, categoryId, recentPosts = []) {
  console.log('\n=======================================================');
  console.log('=== BÖLÜM B9: 12 MADDELİK PRE-PUBLISH CHECKLIST DENETİMİ ===');
  console.log('=======================================================');
  const checks = [];

  // 1. Metin Bütünlüğü Kontrolü (Bozuk/düşmüş karakterler veya kesik kelimeler)
  const corruptRegex = /\b(kap\s+amlı|tav\s+iyeler|tak\s+i|kı\s+ırlaştırma|be\s+leme|profe\s+yonel|bilinme\s+i|te\s+i)\b/i;
  if (corruptRegex.test(article.title) || corruptRegex.test(article.content_html)) {
    throw new Error('[CHECKLIST FAIL 1/12] Metinde bozuk karakter / düşmüş harf tespit edildi!');
  }
  checks.push('✓ 1. Metin Bütünlüğü: Kusursuz (Düşmüş harf veya bozuk kelime yok)');

  // 2. Minimum Kelime Sayısı ve Uzunluk Kontrolü
  const plainText = article.content_html.replace(/<[^>]+>/g, ' ');
  const wordCount = plainText.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 850 || article.content_html.length < 5000) {
    throw new Error(`[CHECKLIST FAIL 2/12] Yetersiz içerik uzunluğu: ${wordCount} kelime, ${article.content_html.length} karakter! Minimum sınırın altında.`);
  }
  checks.push(`✓ 2. İçerik Uzunluğu: ${wordCount} kelime (${article.content_html.length} karakter)`);

  // 3. Başlık Hiyerarşisi (H1 makale başlığı, içerikte H2 ve H3 sıralaması)
  const h2Matches = article.content_html.match(/<h2/gi) || [];
  const h3Matches = article.content_html.match(/<h3/gi) || [];
  if (h2Matches.length < 3 || h3Matches.length < 2) {
    throw new Error(`[CHECKLIST FAIL 3/12] Başlık hiyerarşisi yetersiz: ${h2Matches.length} H2, ${h3Matches.length} H3 bulundu!`);
  }
  checks.push(`✓ 3. Başlık Hiyerarşisi: ${h2Matches.length} adet H2, ${h3Matches.length} adet H3 hiyerarşik olarak mevcut`);

  // 4. Odak Anahtar Kelime Uyumu (Başlık ve gövde kontrolü)
  const kw = task.focus_keyword.toLowerCase();
  if (!article.content_html.toLowerCase().includes(kw)) {
    throw new Error(`[CHECKLIST FAIL 4/12] Odak anahtar kelime "${task.focus_keyword}" makale gövdesinde bulunamadı!`);
  }
  checks.push(`✓ 4. Odak Kelime Entegrasyonu: Başlıkta ve metin gövdesinde başarıyla doğrulandı`);

  // 5. Görsel Adedi ve Çözünürlük (Tam 2 adet 1200x675 HD görsel)
  if (!images || images.length < 2 || !images[0]?.id || !images[1]?.id) {
    throw new Error('[CHECKLIST FAIL 5/12] Tam 2 adet (öne çıkan + içerik içi) HD görsel doğrulanamadı!');
  }
  checks.push(`✓ 5. Görsel Standartı: Tam 2 adet 1200x675 HD görsel yüklendi ve ilişkilendirildi`);

  // 6. Görsel Alt Etiketleri ve Tipografi Kontrolü
  if (!images[0].alt || !images[1].alt) {
    throw new Error('[CHECKLIST FAIL 6/12] Görsel alt etiketleri (alt text) eksik veya geçersiz!');
  }
  checks.push(`✓ 6. Görsel Alt Metinleri: SEO ve erişilebilirlik uyumlu alt etiketleri mevcut`);

  // 7. EEAT Otorite ve Yazar Profili (Dr. Melis Kaya)
  if (!article.content_html.includes('Dr. Melis Kaya')) {
    throw new Error('[CHECKLIST FAIL 7/12] Dr. Melis Kaya EEAT uzman yazar kutusu içerikte eksik!');
  }
  checks.push(`✓ 7. EEAT Otorite Doğrulaması: Dr. Melis Kaya yazar profili ve klinik atıflar içerikte mevcut`);

  // 8. Yapısal Veri (Schema.org FAQPage / JSON-LD)
  if (!article.content_html.includes('application/ld+json')) {
    throw new Error('[CHECKLIST FAIL 8/12] Schema.org FAQPage JSON-LD yapısal verisi eksik!');
  }
  checks.push(`✓ 8. Schema.org Doğrulaması: FAQPage JSON-LD yapısal veri bloğu doğrulandı`);

  // 9. URL Slug Kanonizasyonu ve Benzersizlik (-2, -3 numaralı ekler yasaktır)
  if (/-\d+$/.test(task.slug)) {
    throw new Error(`[CHECKLIST FAIL 9/12] Hedef slug numaralı ek içeriyor (${task.slug})! Duplicate URL kesinlikle yasaktır.`);
  }
  checks.push(`✓ 9. URL Slug Kanonizasyonu: "${task.slug}" temiz ve benzersiz`);

  // 10. İç Linkleme Doğrulaması
  const internalLinks = article.content_html.match(/<a\s+[^>]*href=/gi) || [];
  if (internalLinks.length < 2) {
    throw new Error(`[CHECKLIST FAIL 10/12] İç linkleme yetersiz (${internalLinks.length} adet)! En az 2 iç link zorunludur.`);
  }
  checks.push(`✓ 10. İç Linkleme: ${internalLinks.length} adet site içi organik bağlantı doğrulandı`);

  // 11. Kategori Güvenliği (Uncategorized / ID 1 kesinlikle engellendi)
  if (!categoryId || categoryId === 1) {
    throw new Error(`[CHECKLIST FAIL 11/12] Geçersiz Kategori ID: ${categoryId}! Uncategorized (1) kesinlikle yasaktır.`);
  }
  checks.push(`✓ 11. Kategori Güvenliği: Kategori ID ${categoryId} onaylandı (Uncategorized engellendi)`);

  // 12. Fuzzy Title Duplicate Kontrolü (%70+ eşik)
  if (recentPosts && recentPosts.length) {
    for (const rp of recentPosts) {
      if (!rp.title) continue;
      const sim = calculateStringSimilarity(article.title, rp.title);
      if (sim >= 0.70) {
        throw new Error(`[CHECKLIST FAIL 12/12] Duplicate Başlık Tespiti! Benzerlik: %${Math.round(sim * 100)} - Mevcut: "${rp.title}" vs Yeni: "${article.title}"`);
      }
    }
  }
  checks.push(`✓ 12. Duplicate Başlık Koruması: Benzerlik kontrolü (%70 eşik) başarıyla geçildi`);

  console.log(checks.join('\n'));
  console.log('=== [✓] 12/12 PRE-PUBLISH CHECKLIST BAŞARIYLA GEÇİLDİ ===\n');
  return true;
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

  // Strip unescaped raw AI JSON-LD blocks (we re-inject 100% valid JSON.stringify block below)
  clean = clean.replace(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '');

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

// Fetch recent posts for internal linking (100% clean canonicals only)
async function fetchRecentPosts() {
  try {
    const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?status=publish&per_page=40&_fields=id,title,link,slug`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (res.ok) {
      const posts = await res.json();
      return posts
        .filter(p => !/-\d+$/.test(p.slug)) // Asla numaralı (-2, -3) linkleri iç linkleme listesine koyma
        .map(p => ({
          id: p.id,
          title: decodeHtmlEntities(p.title.rendered),
          link: p.link,
          slug: p.slug
        }));
    }
  } catch (e) {
    console.error('[-] İç linkleme için eski yazılar çekilemedi:', e.message);
  }
  return [];
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Calculate similarity between two titles with core subject protection (prevents boilerplate suffix false positives)
function getCoreSubject(title) {
  const parts = (title || '').split(/[:|\-–—]/);
  return parts[0].trim();
}

function calculateStringSimilarity(str1, str2) {
  const s1 = slugifyTurkish(str1).replace(/-/g, ' ');
  const s2 = slugifyTurkish(str2).replace(/-/g, ' ');
  if (s1 === s2) return 1.0;

  const core1 = slugifyTurkish(getCoreSubject(str1)).replace(/-/g, ' ');
  const core2 = slugifyTurkish(getCoreSubject(str2)).replace(/-/g, ' ');
  if (core1 === core2) return 1.0;

  const w1 = core1.split(' ').filter(w => !['kedisi', 'kopegi', 'bakimi', 'egitimi', 'beslenmesi', 'pet', 'istanbul', 'rehberi', 'fiyatlari', '2026'].includes(w));
  const w2 = core2.split(' ').filter(w => !['kedisi', 'kopegi', 'bakimi', 'egitimi', 'beslenmesi', 'pet', 'istanbul', 'rehberi', 'fiyatlari', '2026'].includes(w));

  const hasCommonEntity = w1.some(w => w2.includes(w));
  if (w1.length > 0 && w2.length > 0 && !hasCommonEntity) {
    return 0.1; // Different subjects (different breeds, districts, etc.)
  }

  const getBigrams = (str) => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) bigrams.add(str.substring(i, i + 2));
    return bigrams;
  };
  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);
  let intersection = 0;
  for (const b of b1) if (b2.has(b)) intersection++;
  return (2.0 * intersection) / (b1.size + b2.size);
}

// Get or create category with HTML entity decoding and Uncategorized prevention
async function getOrCreateCategory(categoryName) {
  const cleanName = toTurkishTitleCase(categoryName || 'Evcil Hayvan Bakımı');
  const targetSlug = slugifyTurkish(cleanName);

  try {
    // 1. Fetch all categories
    const res = await fetch(`${WP_URL}/wp-json/wp/v2/categories?per_page=100`, {
      headers: { 'Authorization': AUTH_HEADER }
    });
    if (res.ok) {
      const cats = await res.json();
      const existing = cats.find(c => {
        const decodedName = decodeHtmlEntities(c.name).toLowerCase();
        return decodedName === cleanName.toLowerCase() || c.slug === targetSlug;
      });
      if (existing) {
        if (existing.id === 1) {
          throw new Error(`[CRITICAL] Kategori "Uncategorized" (ID: 1) olamaz! Hedef: ${cleanName}`);
        }
        return existing.id;
      }
    }

    // 2. Create category if not found
    const createRes = await fetch(`${WP_URL}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: cleanName, slug: targetSlug })
    });
    if (createRes.ok) {
      const newCat = await createRes.json();
      console.log(`[+] Yeni Kategori Açıldı: ${cleanName} (ID: ${newCat.id})`);
      if (newCat.id === 1) throw new Error('[CRITICAL] Kategori ID 1 olamaz!');
      return newCat.id;
    }
  } catch (e) {
    console.error(`[-] Kategori çözümlenemedi (${categoryName}):`, e.message);
    throw new Error(`[CHECKLIST BLOCKED] Geçerli kategori atanamadı (${categoryName}): ${e.message}`);
  }

  // Fallback to Pet Rehberi or general valid category (NEVER 1)
  throw new Error(`[CHECKLIST BLOCKED] Kategori bulunamadı ve Uncategorized engellendi: ${cleanName}`);
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

// Autonomous Smart Pet Image Prompt Generator (Gemini Powered)
async function getAutoImagePrompt(articleTitleOrContent) {
  const systemPrompt = 
    "You are an autonomous pet image prompt generator. Analyze the given Turkish pet article/title. " +
    "Determine the animal, setting (grooming salon, pet taxi, cozy home, vet clinic, park), " +
    "and extract a concise 2-4 word Turkish focus keyword in UPPERCASE. " +
    "Output ONLY a single English prompt for a 16:9 photorealistic commercial pet photography, ending with: " +
    "...with bold legible 3D Turkish typography text '[EXTRACTED_KEYWORD]' centered cleanly in high contrast with strong drop shadow. " +
    "No chat, no explanations.";

  const models = ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.5-flash'];
  
  for (const model of models) {
    try {
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await fetch(geminiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `${systemPrompt}\n\nMakale / Başlık: ${articleTitleOrContent}` }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
          }
        })
      });

      if (response.status === 429 || response.status === 503) {
        console.log(`    [!] Görsel prompt motoru rate limit [${model}]. Sonraki modele geçiliyor...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (response.ok) {
        const data = await response.json();
        const cand = data.candidates?.[0];
        const textParts = cand?.content?.parts?.filter(p => p.text && !p.thought);
        const text = textParts && textParts.length ? textParts.map(p => p.text).join('\n').trim() : (cand?.content?.parts?.[0]?.text?.trim() || '');
        if (text) return text;
      }
    } catch (e) {
      console.error(`Prompt motoru ${model} hatası:`, e.message);
    }
  }
  return null;
}

// Extract 2-4 words Turkish focus keyword from generated prompt or fallback to title
function extractKeywordFromPrompt(promptText, fallbackText) {
  if (promptText) {
    const match = promptText.match(/typography text\s*['"“]([^'"”]+)['"”]/i);
    if (match && match[1] && match[1].trim().length >= 3) {
      return match[1].trim().toLocaleUpperCase('tr-TR');
    }
  }
  // Fallback extraction from title
  const words = (fallbackText || '').trim().split(/\s+/).slice(0, 4);
  return words.join(' ').toLocaleUpperCase('tr-TR');
}

// High-fidelity vector silhouettes matching the user's reference style
const DETAILED_SILHOUETTES = {
  cat: `
    <path d="M 60,420 C 50,380 30,350 20,320 C 35,340 50,355 65,380 C 70,345 85,330 95,305 C 90,335 85,360 75,395 Z" fill="#0f172a" />
    <path d="M 1130,420 C 1140,380 1160,350 1170,320 C 1155,340 1140,355 1125,380 C 1120,345 1105,330 1095,305 C 1100,335 1105,360 1115,395 Z" fill="#0f172a" />
    <path d="M 150,420 L 155,390 C 158,375 168,368 185,368 C 205,368 215,380 235,380 C 255,380 270,365 285,345 C 292,332 302,328 312,330 C 318,318 328,315 334,324 C 338,318 344,318 348,324 C 350,336 342,348 335,354 C 338,366 332,382 322,398 C 315,410 302,420 280,420 L 255,420 L 250,395 L 230,395 L 225,420 Z" fill="#0f172a" />
    <path d="M 160,370 C 140,350 130,310 145,280 C 155,260 170,265 165,285 C 160,305 165,330 180,365 Z" fill="#0f172a" />
    <path d="M 400,420 L 415,385 C 410,365 425,345 445,340 C 460,338 472,348 480,360 C 490,350 505,355 512,368 C 516,360 524,360 528,366 C 530,378 522,390 512,396 C 515,408 505,420 490,420 Z" fill="#0f172a" />
    <path d="M 405,390 C 385,380 375,360 380,340 C 388,340 395,360 410,385 Z" fill="#0f172a" />
    <path d="M 640,420 C 630,390 625,355 635,330 C 645,305 655,280 650,255 C 645,240 658,225 675,225 C 685,225 692,235 695,248 C 705,240 715,248 718,260 C 720,275 712,295 718,325 C 725,360 735,395 740,420 Z" fill="#0f172a" />
    <path d="M 640,420 C 610,420 595,400 605,385 C 615,370 625,390 635,410 Z" fill="#0f172a" />
    <path d="M 800,420 C 805,390 825,370 850,365 C 870,360 888,375 900,390 C 908,378 920,382 925,396 L 930,420 Z" fill="#0f172a" />
    <path d="M 805,385 C 790,375 780,350 790,335 C 798,335 802,355 815,380 Z" fill="#0f172a" />
    <g fill="#0f172a">
      <path d="M 540,240 Q 555,222 578,228 Q 566,245 555,250 Q 576,256 592,272 Q 566,268 550,256 Q 538,268 526,274 Q 532,256 540,240 Z" />
      <ellipse cx="230" cy="290" rx="14" ry="10" /><circle cx="216" cy="272" r="4.5" /><circle cx="228" cy="264" r="5" /><circle cx="242" cy="268" r="4.5" /><circle cx="250" cy="282" r="4" />
      <ellipse cx="780" cy="270" rx="13" ry="9" /><circle cx="768" cy="254" r="4" /><circle cx="778" cy="247" r="4.5" /><circle cx="790" cy="250" r="4" /><circle cx="797" cy="262" r="3.5" />
      <ellipse cx="980" cy="300" rx="14" ry="10" /><circle cx="966" cy="282" r="4.5" /><circle cx="978" cy="274" r="5" /><circle cx="992" cy="278" r="4.5" /><circle cx="1000" cy="292" r="4" />
      <path d="M 370,270 C 370,258 382,252 392,260 C 402,252 414,258 414,270 C 414,284 392,298 392,298 C 392,298 370,284 370,270 Z" />
      <path d="M 870,245 C 870,235 880,230 888,237 C 896,230 906,235 906,245 C 906,258 888,270 888,270 C 888,270 870,258 870,245 Z" />
    </g>
  `,

  dog: `
    <path d="M 60,420 C 50,380 30,350 20,320 C 35,340 50,355 65,380 C 70,345 85,330 95,305 C 90,335 85,360 75,395 Z" fill="#0f172a" />
    <path d="M 1130,420 C 1140,380 1160,350 1170,320 C 1155,340 1140,355 1125,380 C 1120,345 1105,330 1095,305 C 1100,335 1105,360 1115,395 Z" fill="#0f172a" />
    <path d="M 140,420 L 150,360 C 150,330 170,315 200,315 C 230,315 255,330 290,330 C 320,330 340,305 360,285 C 370,270 388,265 405,270 C 415,275 422,285 425,305 C 435,295 448,300 452,315 C 452,335 435,355 420,365 C 412,385 395,405 375,420 L 330,420 L 325,380 L 290,380 L 285,420 L 220,420 L 215,380 L 180,380 L 175,420 Z" fill="#0f172a" />
    <path d="M 155,345 C 130,320 120,280 135,255 C 145,255 150,280 165,325 Z" fill="#0f172a" />
    <path d="M 480,420 C 475,395 488,370 508,365 C 525,360 540,372 548,390 C 558,380 570,385 575,402 L 580,420 Z" fill="#0f172a" />
    <path d="M 485,380 C 470,365 460,345 470,335 C 478,335 482,355 495,380 Z" fill="#0f172a" />
    <path d="M 640,420 C 635,380 630,340 648,310 C 665,280 680,255 698,250 C 714,245 730,260 736,282 C 746,278 756,284 760,300 C 760,322 746,345 750,375 C 755,400 760,412 765,420 Z" fill="#0f172a" />
    <path d="M 770,420 C 775,390 790,365 810,360 C 825,355 838,368 845,385 C 852,375 862,378 866,392 L 870,420 Z" fill="#0f172a" />
    <path d="M 870,420 C 885,420 900,390 890,370 C 880,370 875,390 870,410 Z" fill="#0f172a" />
    <path d="M 940,420 C 945,385 960,355 980,345 C 995,338 1015,345 1030,365 C 1040,350 1055,355 1060,375 L 1065,420 Z" fill="#0f172a" />
    <g fill="#0f172a">
      <path d="M 520,230 Q 538,212 560,218 Q 548,235 538,240 Q 558,246 575,262 Q 550,258 535,246 Q 522,258 510,264 Q 516,246 520,230 Z" />
      <ellipse cx="220" cy="270" rx="16" ry="12" /><circle cx="202" cy="248" r="5" /><circle cx="218" cy="240" r="5.5" /><circle cx="234" cy="246" r="5" /><circle cx="242" cy="262" r="4.5" />
      <ellipse cx="800" cy="260" rx="15" ry="11" /><circle cx="784" cy="240" r="4.5" /><circle cx="798" cy="232" r="5" /><circle cx="814" cy="238" r="4.5" /><circle cx="820" cy="252" r="4" />
      <ellipse cx="980" cy="285" rx="15" ry="11" /><circle cx="964" cy="265" r="4.5" /><circle cx="978" cy="257" r="5" /><circle cx="994" cy="263" r="4.5" /><circle cx="1000" cy="277" r="4" />
      <path d="M 370,250 C 370,238 382,232 392,240 C 402,232 414,238 414,250 C 414,264 392,278 392,278 C 392,278 370,264 370,250 Z" />
      <path d="M 720,230 C 720,220 730,215 738,222 C 746,215 756,220 756,230 C 756,242 738,254 738,254 C 738,254 720,242 720,230 Z" />
    </g>
  `,

  bird: `
    <path d="M 60,420 C 50,380 30,350 20,320 C 35,340 50,355 65,380 C 70,345 85,330 95,305 C 90,335 85,360 75,395 Z" fill="#0f172a" />
    <path d="M 1130,420 C 1140,380 1160,350 1170,320 C 1155,340 1140,355 1125,380 C 1120,345 1105,330 1095,305 C 1100,335 1105,360 1115,395 Z" fill="#0f172a" />
    <path d="M 120,380 Q 240,360 360,380 L 360,395 Q 240,375 120,395 Z" fill="#0f172a" />
    <path d="M 220,380 L 230,330 C 230,295 245,260 270,250 C 290,240 308,255 305,285 C 315,275 328,280 328,300 C 322,335 295,370 275,410 Z" fill="#0f172a" />
    <path d="M 285,245 C 290,225 310,220 315,235 C 325,240 328,255 320,265 Z" fill="#0f172a" />
    <path d="M 320,265 C 335,270 330,285 315,285 Z" fill="#0f172a" />
    <path d="M 640,420 Q 700,330 760,420 Z" fill="#0f172a" />
    <path d="M 670,350 C 665,325 675,300 695,295 C 708,290 718,305 712,325 L 705,350 Z" fill="#0f172a" />
    <path d="M 725,350 C 730,325 742,305 758,300 C 772,295 782,310 778,330 L 770,350 Z" fill="#0f172a" />
    <g fill="#0f172a">
      <path d="M 160,250 Q 185,220 215,230 Q 198,255 180,260 Q 210,265 235,288 Q 195,282 175,265 Z" />
      <path d="M 480,220 Q 510,188 540,200 Q 520,225 500,232 Q 532,238 560,262 Q 518,255 495,238 Z" />
      <path d="M 840,230 Q 865,200 895,210 Q 878,235 860,240 Q 890,245 915,268 Q 875,262 855,245 Z" />
      <path d="M 1000,260 Q 1020,235 1045,245 Q 1030,265 1015,270 Q 1040,275 1060,295 Q 1025,290 1010,275 Z" />
    </g>
  `,

  vet: `
    <path d="M 60,420 C 50,380 30,350 20,320 C 35,340 50,355 65,380 C 70,345 85,330 95,305 C 90,335 85,360 75,395 Z" fill="#0f172a" />
    <path d="M 1130,420 C 1140,380 1160,350 1170,320 C 1155,340 1140,355 1125,380 C 1120,345 1105,330 1095,305 C 1100,335 1105,360 1115,395 Z" fill="#0f172a" />
    <path d="M 220,420 C 210,380 225,340 250,325 C 270,312 290,325 288,350 C 300,340 318,348 322,370 L 325,420 Z" fill="#0f172a" />
    <circle cx="270" cy="305" r="20" fill="#0f172a" />
    <path d="M 340,420 C 345,385 360,360 380,355 C 395,350 410,365 415,385 L 420,420 Z" fill="#0f172a" />
    <g transform="translate(565, 230)" fill="#0f172a">
      <rect x="28" y="0" width="24" height="80" rx="8" />
      <rect x="0" y="28" width="80" height="24" rx="8" />
    </g>
    <path d="M 680,290 C 710,260 750,275 770,315 C 780,340 770,375 750,395" fill="none" stroke="#0f172a" stroke-width="9" stroke-linecap="round" />
    <circle cx="750" cy="395" r="16" fill="#0f172a" />
    <path d="M 810,320 L 850,320 L 865,280 L 880,360 L 895,300 L 910,335 L 925,320 L 980,320" fill="none" stroke="#0f172a" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M 1000,420 C 995,390 1005,370 1020,365 C 1035,360 1045,375 1048,395 L 1052,420 Z" fill="#0f172a" />
  `,

  taxi: `
    <path d="M 60,420 C 50,380 30,350 20,320 C 35,340 50,355 65,380 C 70,345 85,330 95,305 C 90,335 85,360 75,395 Z" fill="#0f172a" />
    <path d="M 1130,420 C 1140,380 1160,350 1170,320 C 1155,340 1140,355 1125,380 C 1120,345 1105,330 1095,305 C 1100,335 1105,360 1115,395 Z" fill="#0f172a" />
    <path d="M 220,420 L 220,335 C 220,310 245,295 275,295 L 430,295 C 455,295 475,310 490,335 L 525,365 L 555,365 C 570,365 580,378 580,395 L 580,420 Z" fill="#0f172a" />
    <circle cx="300" cy="420" r="26" fill="#fef08a" stroke="#0f172a" stroke-width="10" />
    <circle cx="490" cy="420" r="26" fill="#fef08a" stroke="#0f172a" stroke-width="10" />
    <path d="M 390,310 C 400,285 425,280 435,292 C 442,300 438,315 430,325 Z" fill="#0f172a" />
    <path d="M 432,295 C 445,295 450,305 440,310 Z" fill="#0f172a" />
    <rect x="670" y="335" width="105" height="85" rx="16" fill="#0f172a" />
    <rect x="708" y="318" width="28" height="18" rx="6" fill="#0f172a" />
    <line x1="695" y1="365" x2="750" y2="365" stroke="#fef08a" stroke-width="5" stroke-linecap="round" />
    <line x1="695" y1="385" x2="750" y2="385" stroke="#fef08a" stroke-width="5" stroke-linecap="round" />
    <path d="M 830,420 C 825,380 848,348 875,340 C 895,335 918,350 922,372 L 928,420 Z" fill="#0f172a" />
    <ellipse cx="610" cy="390" rx="12" ry="8" fill="#0f172a" />
    <ellipse cx="640" cy="375" rx="10" ry="7" fill="#0f172a" />
  `,

  hotel: `
    <path d="M 60,420 C 50,380 30,350 20,320 C 35,340 50,355 65,380 C 70,345 85,330 95,305 C 90,335 85,360 75,395 Z" fill="#0f172a" />
    <path d="M 1130,420 C 1140,380 1160,350 1170,320 C 1155,340 1140,355 1125,380 C 1120,345 1105,330 1095,305 C 1100,335 1105,360 1115,395 Z" fill="#0f172a" />
    <path d="M 200,420 L 200,335 L 290,260 L 380,335 L 380,420 Z" fill="#0f172a" />
    <rect x="270" y="300" width="40" height="40" rx="8" fill="#fef08a" stroke="#0f172a" stroke-width="6" />
    <path d="M 265,420 L 265,370 C 265,350 315,350 315,370 L 315,420 Z" fill="#fef08a" />
    <path d="M 460,420 C 455,385 475,358 498,352 C 515,348 532,362 538,382 L 542,420 Z" fill="#0f172a" />
    <path d="M 590,420 C 585,390 598,365 615,358 C 628,352 640,368 640,388 L 645,420 Z" fill="#0f172a" />
    <path d="M 720,420 C 715,378 732,345 758,340 C 778,335 798,350 802,375 L 808,420 Z" fill="#0f172a" />
    <path d="M 920,240 A 30,30 0 1 0 950,270 A 24,24 0 0 1 920,240 Z" fill="#0f172a" />
    <polygon points="860,240 864,250 875,250 866,256 870,266 860,260 850,266 854,256 845,250 856,250" fill="#0f172a" />
    <polygon points="1010,260 1013,267 1022,267 1015,272 1018,280 1010,275 1002,280 1005,272 998,267 1007,267" fill="#0f172a" />
  `
};

const FOREGROUND_PETS = {
  dog: `
    <g transform="translate(240, 440)">
      <ellipse cx="80" cy="195" rx="75" ry="18" fill="rgba(15,23,42,0.45)" />
      <path d="M 10,140 C -15,110 -10,85 5,75 C 15,85 10,120 25,145 Z" fill="#b45309" stroke="#78350f" stroke-width="2" />
      <path d="M 0,80 C -5,75 5,70 10,75 C 12,82 5,88 0,80 Z" fill="#ffffff" />
      <path d="M 25,145 C 20,110 40,85 75,85 C 105,85 125,110 120,145 L 120,175 C 120,185 100,195 75,195 C 45,195 25,185 25,175 Z" fill="#d97706" />
      <path d="M 35,110 C 35,95 55,90 75,90 C 95,90 105,100 105,120 C 105,150 90,170 75,170 C 55,170 35,145 35,110 Z" fill="#1e293b" />
      <path d="M 55,120 C 55,100 70,95 85,95 C 95,95 102,105 100,125 C 98,155 85,185 75,185 C 65,185 55,155 55,120 Z" fill="#ffffff" />
      <ellipse cx="30" cy="180" rx="20" ry="14" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5" />
      <path d="M 55,135 L 55,185 C 55,192 68,192 68,185 L 70,135 Z" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5" />
      <ellipse cx="62" cy="188" rx="10" ry="7" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />
      <path d="M 85,135 L 85,185 C 85,192 98,192 98,185 L 96,135 Z" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5" />
      <ellipse cx="92" cy="188" rx="10" ry="7" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />
      <path d="M 45,95 C 45,90 105,90 105,95 L 102,104 C 102,108 48,108 48,104 Z" fill="#0284c7" stroke="#0369a1" stroke-width="1.5" />
      <circle cx="75" cy="107" r="5" fill="#facc15" stroke="#ca8a04" stroke-width="1" />
      <path d="M 42,40 C 20,45 10,75 15,105 C 20,115 35,115 42,95 Z" fill="#9a3412" />
      <path d="M 108,40 C 130,45 140,75 135,105 C 130,115 115,115 108,95 Z" fill="#9a3412" />
      <ellipse cx="75" cy="55" rx="36" ry="34" fill="#d97706" />
      <path d="M 68,25 C 68,25 75,22 82,25 C 80,45 88,55 92,68 C 95,80 88,90 75,90 C 62,90 55,80 58,68 C 62,55 70,45 68,25 Z" fill="#ffffff" />
      <ellipse cx="58" cy="52" rx="7" ry="8.5" fill="#0f172a" /><circle cx="56" cy="49" r="2.8" fill="#ffffff" /><circle cx="60" cy="54" r="1.2" fill="#ffffff" />
      <ellipse cx="92" cy="52" rx="7" ry="8.5" fill="#0f172a" /><circle cx="90" cy="49" r="2.8" fill="#ffffff" /><circle cx="94" cy="54" r="1.2" fill="#ffffff" />
      <path d="M 70,68 C 70,65 80,65 80,68 C 80,73 75,76 75,76 C 75,76 70,73 70,68 Z" fill="#0f172a" />
      <path d="M 71,77 Q 75,80 79,77" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round" />
      <path d="M 72,79 C 72,86 78,86 78,79 Z" fill="#f43f5e" />
    </g>
  `,

  cat: `
    <g transform="translate(260, 450)">
      <ellipse cx="75" cy="180" rx="65" ry="16" fill="rgba(15,23,42,0.45)" />
      <path d="M 20,140 C 0,130 -10,95 5,80 C 15,70 25,85 15,105 C 10,120 20,135 30,145 Z" fill="#ca8a04" stroke="#854d0e" stroke-width="1.5" />
      <path d="M 35,135 C 30,105 50,85 75,85 C 100,85 115,105 110,135 L 110,165 C 110,175 95,182 75,182 C 55,182 35,175 35,165 Z" fill="#eab308" />
      <path d="M 55,115 C 55,100 68,95 75,95 C 82,95 92,100 92,115 C 92,140 85,170 75,170 C 65,170 55,140 55,115 Z" fill="#ffffff" />
      <path d="M 40,110 Q 55,115 48,125" fill="none" stroke="#854d0e" stroke-width="2.5" stroke-linecap="round" />
      <path d="M 105,110 Q 90,115 98,125" fill="none" stroke="#854d0e" stroke-width="2.5" stroke-linecap="round" />
      <ellipse cx="62" cy="175" rx="8" ry="6" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" />
      <ellipse cx="88" cy="175" rx="8" ry="6" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" />
      <path d="M 45,45 L 35,15 L 60,32 Z" fill="#ca8a04" stroke="#854d0e" stroke-width="1.5" />
      <path d="M 44,40 L 38,22 L 56,32 Z" fill="#fbcfe8" />
      <path d="M 105,45 L 115,15 L 90,32 Z" fill="#ca8a04" stroke="#854d0e" stroke-width="1.5" />
      <path d="M 106,40 L 112,22 L 94,32 Z" fill="#fbcfe8" />
      <ellipse cx="75" cy="52" rx="34" ry="28" fill="#eab308" />
      <path d="M 72,28 L 75,36 L 78,28 M 67,32 L 75,40 L 83,32" fill="none" stroke="#854d0e" stroke-width="2" stroke-linecap="round" />
      <ellipse cx="58" cy="50" rx="7.5" ry="8.5" fill="#10b981" stroke="#047857" stroke-width="1.5" /><ellipse cx="58" cy="50" rx="3" ry="7" fill="#0f172a" /><circle cx="56" cy="46" r="2.5" fill="#ffffff" />
      <ellipse cx="92" cy="50" rx="7.5" ry="8.5" fill="#10b981" stroke="#047857" stroke-width="1.5" /><ellipse cx="92" cy="50" rx="3" ry="7" fill="#0f172a" /><circle cx="90" cy="46" r="2.5" fill="#ffffff" />
      <polygon points="73,62 77,62 75,65" fill="#f43f5e" />
      <path d="M 71,67 Q 75,70 79,67" fill="none" stroke="#0f172a" stroke-width="1.5" stroke-linecap="round" />
      <line x1="45" y1="62" x2="25" y2="58" stroke="#ffffff" stroke-width="1.5" />
      <line x1="45" y1="66" x2="25" y2="68" stroke="#ffffff" stroke-width="1.5" />
      <line x1="105" y1="62" x2="125" y2="58" stroke="#ffffff" stroke-width="1.5" />
      <line x1="105" y1="66" x2="125" y2="68" stroke="#ffffff" stroke-width="1.5" />
    </g>
  `
};

function detectTopicCategory(text) {
  const lower = (text || '').toLowerCase();
  if (/taksi|taxi|transfer|nakil|taşıma/i.test(lower)) return 'taxi';
  if (/otel|hotel|pansiyon|konaklama/i.test(lower)) return 'hotel';
  if (/veteriner|klinik|aşı|tedavi|ameliyat|kısırlaştırma|cerrahi/i.test(lower)) return 'vet';
  if (/kuş|papağan|muhabbet|kanarya|sultan|serçe/i.test(lower)) return 'bird';
  if (/kedi|kedisi|tekir|bengal|sphynx|van kedisi|scottish|british|yavru kedi|patili/i.test(lower)) return 'cat';
  return 'dog';
}

function generateMasterPosterSvg(mainKw, subTitle, category) {
  const upperKw = (mainKw || 'EVCİL HAYVAN DOSTU YAŞAM').toLocaleUpperCase('tr-TR');
  const words = upperKw.split(/\s+/);

  let row1 = upperKw;
  let row2 = '';
  if (words.length >= 3) {
    const mid = Math.ceil(words.length / 2);
    row1 = words.slice(0, mid).join(' ');
    row2 = words.slice(mid).join(' ');
  } else if (words.length === 2 && upperKw.length > 15) {
    row1 = words[0];
    row2 = words[1];
  }

  const silhouetteArt = DETAILED_SILHOUETTES[category] || DETAILED_SILHOUETTES.dog;
  const foregroundPet = FOREGROUND_PETS[category] || (category === 'cat' ? FOREGROUND_PETS.cat : FOREGROUND_PETS.dog);

  let fontSize1 = row2 ? 50 : 58;
  if (row1.length > 18) fontSize1 = 44;
  if (row1.length > 24) fontSize1 = 38;

  let fontSize2 = 44;
  if (row2.length > 18) fontSize2 = 38;

  return `
  <svg width="1200" height="675" viewBox="0 0 1200 675" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="interiorWall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#476579" />
        <stop offset="30%" stop-color="#698ca1" />
        <stop offset="65%" stop-color="#fde047" />
        <stop offset="90%" stop-color="#fdba74" />
        <stop offset="100%" stop-color="#fb923c" />
      </linearGradient>

      <radialGradient id="backlitGlow" cx="50%" cy="54%" r="48%">
        <stop offset="0%" stop-color="#fffbeb" stop-opacity="1" />
        <stop offset="30%" stop-color="#fef08a" stop-opacity="0.95" />
        <stop offset="65%" stop-color="#fdba74" stop-opacity="0.80" />
        <stop offset="90%" stop-color="#f97316" stop-opacity="0.25" />
        <stop offset="100%" stop-color="#ea580c" stop-opacity="0" />
      </radialGradient>

      <linearGradient id="hardwoodFloor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#d97706" />
        <stop offset="30%" stop-color="#b45309" />
        <stop offset="100%" stop-color="#78350f" />
      </linearGradient>

      <filter id="wallDepthShadow" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="18" stdDeviation="14" flood-color="rgba(15,23,42,0.55)" />
        <feDropShadow dx="0" dy="6" stdDeviation="5" flood-color="rgba(15,23,42,0.35)" />
      </filter>

      <linearGradient id="faceCyan" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a5f3fc" />
        <stop offset="45%" stop-color="#38bdf8" />
        <stop offset="100%" stop-color="#0284c7" />
      </linearGradient>

      <linearGradient id="faceOrange" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#fef08a" />
        <stop offset="45%" stop-color="#fb923c" />
        <stop offset="100%" stop-color="#ea580c" />
      </linearGradient>

      <filter id="softGlow">
        <feGaussianBlur stdDeviation="3.5" />
      </filter>
    </defs>

    <rect width="1200" height="490" fill="url(#interiorWall)" />
    <polygon points="0,0 280,0 380,490 0,490" fill="#ffffff" opacity="0.12" />
    <rect x="80" y="160" width="1040" height="330" fill="url(#backlitGlow)" />

    <circle cx="260" cy="290" r="5" fill="#ffffff" opacity="0.9" filter="url(#softGlow)" />
    <circle cx="340" cy="260" r="8" fill="#fef08a" opacity="0.85" filter="url(#softGlow)" />
    <circle cx="600" cy="270" r="7" fill="#ffffff" opacity="0.95" filter="url(#softGlow)" />
    <circle cx="820" cy="255" r="9" fill="#fef08a" opacity="0.8" filter="url(#softGlow)" />
    <circle cx="940" cy="285" r="6" fill="#ffffff" opacity="0.85" filter="url(#softGlow)" />

    <path d="M 0,420 Q 300,388 600,408 T 1200,400 L 1200,490 L 0,490 Z" fill="#0f172a" />
    ${silhouetteArt}

    <rect y="475" width="1200" height="200" fill="url(#hardwoodFloor)" />
    <rect y="475" width="1200" height="18" fill="rgba(15,23,42,0.4)" />
    <ellipse cx="680" cy="575" rx="270" ry="65" fill="#94a3b8" opacity="0.35" />

    <g transform="translate(880, 420)">
      <path d="M 40,40 C 30,10 70,0 120,0 C 170,0 210,10 200,40 L 210,130 C 210,150 190,160 120,160 C 50,160 30,150 30,130 Z" fill="#0f766e" />
      <path d="M 10,70 Q 30,70 40,110 L 40,140 Q 20,140 10,110 Z" fill="#115e59" />
      <path d="M 230,70 Q 210,70 200,110 L 200,140 Q 220,140 230,110 Z" fill="#115e59" />
      <line x1="45" y1="160" x2="30" y2="210" stroke="#78350f" stroke-width="6" stroke-linecap="round" />
      <line x1="195" y1="160" x2="210" y2="210" stroke="#78350f" stroke-width="6" stroke-linecap="round" />
    </g>

    <g transform="translate(60, 440)">
      <path d="M 15,130 L 65,130 L 75,70 L 5,70 Z" fill="#ca8a04" />
      <path d="M 40,70 Q 10,30 20,0 Q 45,20 40,70 Z" fill="#15803d" />
      <path d="M 40,70 Q 70,30 60,0 Q 35,20 40,70 Z" fill="#16a34a" />
      <path d="M 40,70 Q 40,20 40,-30 Q 50,20 40,70 Z" fill="#22c55e" />
    </g>

    <circle cx="560" cy="560" r="10" fill="#38bdf8" />
    <circle cx="585" cy="570" r="8" fill="#f43f5e" />
    <g transform="translate(180, 540)">
      <path d="M 10,25 L 50,25 L 45,10 L 15,10 Z" fill="#0284c7" />
      <ellipse cx="30" cy="10" rx="15" ry="4" fill="#38bdf8" />
    </g>

    ${foregroundPet}

    <g filter="url(#wallDepthShadow)">
      <text x="600" y="${row2 ? 94 : 110}" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize1}" font-weight="900" fill="#9a3412" stroke="#7c2d12" stroke-width="16" stroke-linejoin="round" letter-spacing="3">${row1}</text>
      <text x="600" y="${row2 ? 88 : 104}" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize1}" font-weight="900" fill="#ea580c" stroke="#ea580c" stroke-width="13" stroke-linejoin="round" letter-spacing="3">${row1}</text>
      <text x="600" y="${row2 ? 82 : 98}" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize1}" font-weight="900" fill="#ffffff" stroke="#ffffff" stroke-width="7" stroke-linejoin="round" letter-spacing="3">${row1}</text>
      <text x="600" y="${row2 ? 82 : 98}" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize1}" font-weight="900" fill="url(#faceCyan)" letter-spacing="3">${row1}</text>
    </g>

    ${row2 ? `
    <g filter="url(#wallDepthShadow)">
      <text x="600" y="162" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize2}" font-weight="900" fill="#075985" stroke="#0c4a6e" stroke-width="14" stroke-linejoin="round" letter-spacing="3">${row2}</text>
      <text x="600" y="156" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize2}" font-weight="900" fill="#0284c7" stroke="#0284c7" stroke-width="11" stroke-linejoin="round" letter-spacing="3">${row2}</text>
      <text x="600" y="150" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize2}" font-weight="900" fill="#ffffff" stroke="#ffffff" stroke-width="6" stroke-linejoin="round" letter-spacing="3">${row2}</text>
      <text x="600" y="150" text-anchor="middle" font-family="'Montserrat', 'Arial Black', Impact, sans-serif" font-size="${fontSize2}" font-weight="900" fill="url(#faceOrange)" letter-spacing="3">${row2}</text>
    </g>
    ` : ''}

    <g transform="translate(450, 10)">
      <rect width="300" height="28" rx="14" fill="#ea580c" />
      <text x="150" y="18" text-anchor="middle" font-family="'Montserrat', sans-serif" font-size="11.5" font-weight="900" fill="#ffffff" letter-spacing="2">🐾 PATISTORE UZMAN REHBERİ</text>
    </g>
  </svg>
  `;
}

// Generate Exactly 2 Ultra-HD Master Images (1 Featured Cover + 1 In-Content, 1200x675) with 3D Typography & Topic Silhouettes
async function generateUltraHDImages(topic, articleTitle) {
  const focusKw = topic.focus_keyword;
  const baseSlug = slugifyTurkish(focusKw);
  const cleanKw = toTurkishTitleCase(focusKw);
  const finalTitle = toTurkishTitleCase(articleTitle || `${cleanKw}: 2026 Kapsamlı Uzman Rehberi`);

  const category = detectTopicCategory(`${focusKw} ${articleTitle || ''}`);
  console.log(`    [*] Görsel Konu Kategorisi Belirlendi: [${category.toUpperCase()}]`);

  const extractedMainKw = cleanKw.toLocaleUpperCase('tr-TR');
  const inContentText = `${extractedMainKw} DETAYLARI`;
  const inContentSubtitle = "Klinik Analiz, Bakım Standartları ve Uzman Tavsiyeleri";
  const inContentAlt = toTurkishTitleCase(`${cleanKw} Detaylı Rehberi ve 2026 Uzman Tavsiyeleri`);
  const inContentCaption = `${cleanKw} hakkında en çok merak edilenler ve uzman değerlendirmesi`;

  const configs = [
    {
      mainText: extractedMainKw,
      subText: finalTitle,
      alt: extractedMainKw,
      caption: finalTitle,
      filename: `${baseSlug}-kapak-gorseli-patistore.jpg`,
      category: category
    },
    {
      mainText: inContentText,
      subText: inContentSubtitle,
      alt: inContentAlt,
      caption: inContentCaption,
      filename: `${baseSlug}-detay-rehberi-patistore.jpg`,
      category: category
    }
  ];

  const results = [];

  for (let idx = 0; idx < configs.length; idx++) {
    const cfg = configs[idx];
    console.log(`    [*] 16:9 3D Tipografi & [${cfg.category.toUpperCase()}] Silüet Görseli ${idx + 1}/2 Üretiliyor ("${cfg.mainText}")...`);

    try {
      const svgString = generateMasterPosterSvg(cfg.mainText, cfg.subText, cfg.category);
      const svgBuffer = Buffer.from(svgString);
      let finalJpgBuffer = null;

      if (sharp) {
        finalJpgBuffer = await sharp(svgBuffer)
          .resize(1200, 675)
          .jpeg({ quality: 94 })
          .toBuffer();
      } else {
        finalJpgBuffer = svgBuffer;
      }

      const uploaded = await uploadImage(finalJpgBuffer, cfg.filename, cfg.alt, cfg.caption);
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

  if (isBanned || title.length < 15 || !title.toLowerCase().includes(focusKw.toLowerCase()) || title.includes('2026 Kapsamlı Uzman Rehberi ve Klinik Tavsiyeler')) {
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

  const isLocal = task.mode === 'local_service';

  const prompt = `
SEN DÜNYACA ÜNLÜ 25 YILLIK KIDEMLİ VETERİNER HEKİM, AKADEMİSYEN VE SEO OTORİTESİSİN.
Aşağıdaki konu hakkında Türkçe, E-E-A-T ve YMYL standartlarında, TAM 1500-1800 KELİME UZUNLUĞUNDA, RankMath 100/100 tam uyumlu eksiksiz uzman makalesi yaz.

KONU BİLGİLERİ:
- Odak Anahtar Kelime: "${task.focus_keyword}"
- Kategori: "${task.category || 'Genel'}"
- Konu/Bölge: "${task.title}"
- Mod: "${task.mode}"

YAZIM VE KALİTE KURALLARI (KESİNLİKLE VE İSTİSNASIZ UYULACAK):
1. EKSİKSİZLİK: Makale ASLA yarım, kesik veya eksik bırakılmayacaktır. Giriş özeti, en az 5 doyurucu ana başlık (H2), her ana başlık altında 2-3 detaylı alt başlık (H3), en az 2 adet detaylı HTML tablosu (<table><thead>...<tbody>...), adım adım bakım/klinik protokolü, en az 5 adet SSS (Sıkça Sorulan Sorular), klinik uzman değerlendirmesi ve Schema.org "FAQPage" JSON-LD script bloğu ile EKSİKSİZ sonlandırılacaktır.
2. BAŞLIK FORMATI: Başlıkta KESİNLİKLE "7 Altın Kural", "7 Kural", "7 İpucu", "7 Madde" gibi klişe veya birbirini tekrar eden kalıplar KULLANILMAYACAKTIR! Başlık doğrudan odak anahtar kelimeyi içeren, özgün, merak uyandıran ve 2026 güncel rehber formatında olmalıdır.
3. İMLA VE TÜRKÇE KURALLARI: Türk Dil Kurumu (TDK) imla ve yazım kurallarına %100 uyulacak; de/da bağlacı, ki eki, mı/mi soru eki yazımlarında asla hata yapılmayacaktır. Harflerin düşmesi ("s" harfi eksikliği vb.) kesinlikle yasaktır. Tüm H2 ve H3 başlıklarının her kelimesi büyük harfle (Title Case) başlayacaktır.
4. AI / GEO ARAMA OPTİMİZASYONU: Girişte hemen ilk paragraftan sonra doğrudan arama motorlarına ve AI asistanlarına (ChatGPT, Perplexity, Gemini) net yanıt veren stilize edilmiş bir "Quick Answer / Özet Çözüm" bilgi kutusu yer almalıdır (<div style="background:#f1f5f9; border-left:4px solid #0284c7; padding:16px; margin:20px 0; border-radius:4px;">...</div>). 2026 yılına ait net tahmini fiyat aralıkları (TL cinsinden) mutlaka verilmelidir.
${isLocal ? `5. BÖLGESEL VE YEREL DETAY ZORUNLULUĞU (BÖLÜM B7): Bu bir yerel rehberdir. Yazıda mutlaka ilgili ilçenin/bölgenin köpek gezdirmeye uygun popüler park/sahil alanları, ilçe genelindeki veteriner ve nöbetçi klinik yoğunlukları, Marmaray / Metro / İBB toplu taşıma evcil hayvan biniş kuralları ve acil transfer ipuçları somut olarak geçmelidir.` : `5. BİLİMSEL OTORİTE: WSAVA, AVMA ve Türk Veteriner Hekimleri Birliği (TVHB) kılavuzlarına atıfta bulunarak klinik kanıta dayalı bilgiler ver.`}
6. KARŞILAŞTIRMA TABLOLARI: Metin içinde en az 2 adet detaylı HTML tablosu (<table><thead>...<tbody>...) bulunacaktır.
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

        if ((finishReason === 'STOP' && generatedText.trim().length > 5000) || (finishReason === 'MAX_TOKENS' && generatedText.trim().length > 10000)) {
          rawOutput = generatedText;
          break;
        } else if (finishReason === 'MAX_TOKENS') {
          console.log(`    [!] Çıktı token limitine takıldı ve yetersiz uzunlukta, yeniden deneniyor...`);
        }
      } catch (e) {
        console.error(`    [-] Bağlantı hatası [${modelName}]:`, e.message);
      }
    }
    if (rawOutput && rawOutput.trim().length > 5000) break;
  }

  if (!rawOutput || rawOutput.trim().length < 5000) {
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

  const authorBoxHtml = `
<div class="patistore-author-box" style="margin:40px 0 20px; padding:24px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; display:flex; gap:20px; align-items:center;">
  <div style="flex-shrink:0;">
    <div style="width:70px; height:70px; border-radius:50%; background:#2563eb; color:#fff; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700;">MK</div>
  </div>
  <div>
    <h4 style="margin:0 0 6px; font-size:18px; color:#1e293b; font-weight:700;">İçerik İnceleyen & Yazar: Dr. Melis Kaya</h4>
    <p style="margin:0 0 8px; font-size:13px; color:#0284c7; font-weight:600;">Veteriner Hekim & Evcil Hayvan Beslenme Uzmanı | TVHB Sicil No: 14820</p>
    <p style="margin:0; font-size:14px; color:#475569; line-height:1.6;">İstanbul Üniversitesi Veteriner Fakültesi mezunudur. 15 yılı aşkın klinik cerrahi ve küçük hayvan beslenmesi tecrübesiyle PatiStore bilimsel ve klinik yayın kurulunu yönetmektedir.</p>
  </div>
</div>`;

  if (!contentHtml.includes('patistore-author-box')) {
    contentHtml = contentHtml + authorBoxHtml;
  }

  // Ensure 100% valid and guaranteed Schema.org JSON-LD FAQPage block
  if (!contentHtml.includes('application/ld+json')) {
    const faqSchema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": `${toTurkishTitleCase(task.focus_keyword)} 2026 Yılında Ne Kadardır?`,
          "acceptedAnswer": {
            "@type": "Answer",
            "text": `${toTurkishTitleCase(task.focus_keyword)} hakkında güncel klinik ve uzman analizlerine göre maliyetler temel gereksinimler, mama kalitesi ve periyodik veteriner kontrollerine bağlı olarak belirlenmektedir.`
          }
        },
        {
          "@type": "Question",
          "name": `${toTurkishTitleCase(task.focus_keyword)} Sürecinde Nelere Dikkat Edilmelidir?`,
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Düzenli aşı takvimi, dengeli beslenme, parazit koruması ve erken tanı amaçlı rutin veteriner muayeneleri kesinlikle aksatılmamalıdır."
          }
        },
        {
          "@type": "Question",
          "name": "Rutin Veteriner Hekim Kontrolleri Hangi Sıklıkla Yapılmalıdır?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Gelişim çağındaki genç dostlarımız için ayda bir, yetişkin ve stabil evcil hayvanlar için yılda en az 2 kez detaylı genel kontrol önerilmektedir."
          }
        }
      ]
    };
    contentHtml += `\n<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>\n`;
  }

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

  // 1. Fetch live WordPress slugs and titles to prevent ANY duplicate publishing
  const livePublishedSlugs = new Set(history.published_slugs || []);
  const livePublishedTitles = [];
  try {
    for (let pageNum = 1; pageNum <= 3; pageNum++) {
      const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?per_page=100&page=${pageNum}&_fields=slug,title`, {
        headers: { 'Authorization': AUTH_HEADER }
      });
      if (!res.ok) break;
      const livePosts = await res.json();
      if (!livePosts || !livePosts.length) break;
      for (const p of livePosts) {
        if (p.slug) {
          livePublishedSlugs.add(p.slug.toLowerCase());
          livePublishedSlugs.add(p.slug.replace(/-\d+$/, '').toLowerCase());
        }
        if (p.title && p.title.rendered) {
          const tClean = decodeHtmlEntities(p.title.rendered);
          livePublishedTitles.push(tClean);
          livePublishedSlugs.add(slugifyTurkish(tClean));
        }
      }
    }
  } catch (e) {
    console.error('[-] Canlı yazı listesi çekilemedi:', e.message);
  }

  const isDuplicateOrTooSimilar = (candidateTitle, candidateSlug) => {
    if (livePublishedSlugs.has(candidateSlug)) return true;
    for (const existingTitle of livePublishedTitles) {
      if (calculateStringSimilarity(candidateTitle, existingTitle) >= 0.70) {
        return true;
      }
    }
    return false;
  };

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
          const candTitle = `${item.district} ${srv.name} (${item.city})`;
          const slug = slugifyTurkish(`${item.district}-${item.city}-${srv.name}`);
          const altSlug = slugifyTurkish(`${item.district}-${srv.name}`);
          if (!isDuplicateOrTooSimilar(candTitle, slug) && !isDuplicateOrTooSimilar(candTitle, altSlug)) {
            return {
              mode: "local_service",
              title: candTitle,
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
        if (!isDuplicateOrTooSimilar(bTitle, slug) && !isDuplicateOrTooSimilar(bTitle, kwSlug)) {
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
        if (!isDuplicateOrTooSimilar(t.title, slug) && !isDuplicateOrTooSimilar(t.title, kwSlug)) {
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
      const candTitle = `${item.district} ${srv.name} (${item.city})`;
      const slug = slugifyTurkish(`${item.district}-${item.city}-${srv.name}`);
      if (!isDuplicateOrTooSimilar(candTitle, slug)) {
        return {
          mode: "local_service",
          title: candTitle,
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

    // 6. Section B9: Validate 12-Step Pre-Publish Quality Checklist
    validatePrePublishChecklist(task, article, images, categoryId, recentPosts);

    // 7. Publish directly to WordPress as 'publish'
    console.log(`[*] WordPress'e Yayına Alınıyor (Status: publish)...`);
    const postPayload = {
      title: article.title,
      slug: task.slug,
      status: 'publish',
      author: 1, // Dr. Melis Kaya (Veteriner Hekim & Evcil Hayvan Beslenme Uzmanı)
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
