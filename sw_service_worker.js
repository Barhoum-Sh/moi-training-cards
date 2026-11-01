/**
 * وزارة الداخلية — منظومة إصدار البطاقات التدريبية ووحدة الرقابة الميدانية
 * High-Efficiency Offline-First Service Worker (PWA v4.1)
 */

const CACHE_VERSION = 'v4.1';
const STATIC_CACHE = `moi-static-${CACHE_VERSION}`;
const CDN_CACHE = `moi-cdn-${CACHE_VERSION}`;
const EXPECTED_CACHES = new Set([STATIC_CACHE, CDN_CACHE]);

// الملفات الأساسية للتطبيق (يتم تخزينها ذرياً لضمان العمل بدون إنترنت 100%)
const CORE_ASSETS = [
  './',
  './index.html',
  './inspector.html',
  './manifest.json'
];

// المكاتب الخارجية والخطوط (يتم جلبها بوضع CORS القياسي لتجنب تضخم الكاش بـ Opaque Responses)
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com/3.4.17',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap'
];

/**
 * 1. مرحلة التثبيت (Install):
 * - انتظار انتهاء تخزين الملفات فعلياً داخل event.waitUntil بدلاً من Promise.resolve() المبكر.
 * - استخدام cache.addAll للملفات المحلية لضمان اكتمال حزمة الميدان.
 * - استخدام Promise.allSettled مع CORS للمكاتب الخارجية لمنع فشل التثبيت إذا تعطل أحد روابط CDN.
 */
self.addEventListener('install', (event) => {
  self.skipWaiting();

  event.waitUntil(
    (async () => {
      const [staticCache, cdnCache] = await Promise.all([
        caches.open(STATIC_CACHE),
        caches.open(CDN_CACHE)
      ]);

      // تخزين الملفات المحلية بالتوازي مع ضمان التحقق من حالة الاستجابة 200 OK
      await Promise.allSettled(
        CORE_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) {
              await staticCache.put(url, response);
            }
          } catch (err) {
            console.warn(`[SW] Failed to precache local asset: ${url}`, err);
          }
        })
      );

      // تخزين مكاتب CDN بوضع CORS أولاً (ولتفادي 7MB padding لكل ملف في no-cors إلا عند الضرورة)
      await Promise.allSettled(
        CDN_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (response.ok) {
              await cdnCache.put(url, response);
            }
          } catch {
            // خط دفاع احتياطي في حال رفض الخادم ترويسة CORS
            try {
              const fallbackRes = await fetch(new Request(url, { mode: 'no-cors' }));
              if (fallbackRes) {
                await cdnCache.put(url, fallbackRes);
              }
            } catch (err) {
              console.warn(`[SW] Failed to precache CDN asset: ${url}`, err);
            }
          }
        })
      );
    })()
  );
});

/**
 * 2. مرحلة التفعيل (Activate):
 * - حذف إصدارات الكاش القديمة فقط مع الحفاظ على كاش CDN لتجنب إعادة التحميل غير الضرورية.
 * - تفعيل Navigation Preload لتسريع فتح الصفحات بالتوازي مع إقلاع Service Worker.
 * - السيطرة الفورية على جميع النوافذ المفتوحة عبر clients.claim().
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (!EXPECTED_CACHES.has(key)) {
            return caches.delete(key);
          }
          return null;
        })
      );

      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }

      await self.clients.claim();
    })()
  );
});

/**
 * 3. محرك التوجيه الذكي للطلبات (Fetch Routing Engine):
 * - استراتيجية Stale-While-Revalidate لملفات HTML المحلية: تفتح فوراً من الكاش في الميدان وتحدّث نفسها في الخلفية عند توفر الإنترنت.
 * - استراتيجية Cache-First لمكاتب CDN والخطوط (بما فيها ملفات خطوط .woff2 الفرعية من gstatic): قراءة فورية من الذاكرة بدون استهلاك بيانات أو تأخير.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // تجاهل الطلبات غير القابلة للتخزين (مثل POST أو إضافات المتصفح)
  if (request.method !== 'GET' || !request.url.startsWith('http')) {
    return;
  }

  const url = new URL(request.url);
  const isCdnAsset =
    CDN_ASSETS.includes(request.url) ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com');

  // أولاً: استراتيجية Cache-First للمكاتب الخارجية وملفات الخطوط (.woff2)
  if (isCdnAsset) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            const cache = await caches.open(CDN_CACHE);
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          return new Response('', { status: 504, statusText: 'Offline CDN Miss' });
        }
      })()
    );
    return;
  }

  // ثانياً: استراتيجية Stale-While-Revalidate للملفات المحلية والتنقل بين index.html و inspector.html
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: true });

      const networkFetch = (async () => {
        try {
          const preloadResponse = await event.preloadResponse;
          if (preloadResponse) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, preloadResponse.clone());
            return preloadResponse;
          }

          const response = await fetch(request);
          if (response && response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        } catch (err) {
          return null;
        }
      })();

      // إرجاع النسخة المخزنة فوراً (إن وجدت) مع تحديث الكاش في الخلفية، أو انتظار الشبكة
      if (cached) {
        event.waitUntil(networkFetch);
        return cached;
      }

      const networkResponse = await networkFetch;
      if (networkResponse) {
        return networkResponse;
      }

      // خط دفاع أخير عند انقطاع الشبكة وطلب صفحة تنقل غير مخزنة بالاسم الكامل
      if (request.mode === 'navigate') {
        const fallbackPage = request.url.includes('inspector')
          ? await caches.match('./inspector.html')
          : await caches.match('./index.html');
        if (fallbackPage) return fallbackPage;
      }

      return new Response('النظام يعمل في وضع عدم الاتصال — تعذر العثور على المورد المطلوب.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    })()
  );
});