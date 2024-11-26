// service-worker.js

const CACHE_NAME = "v3.2"; 

const putInCache = async (request, response) => {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  };
  
  const cacheFirst = async ({ request, fallbackUrl }) => {
    // First try to get the resource from the cache.
    const responseFromCache = await caches.match(request);
    if (responseFromCache) {
      return responseFromCache;
    }
  
    // If the response was not found in the cache,
    // try to get the resource from the network.
    try {
      const responseFromNetwork = await fetch(request);
      // If the network request succeeded, clone the response:
      // - put one copy in the cache, for the next time
      // - return the original to the app
      // Cloning is needed because a response can only be consumed once.
      putInCache(request, responseFromNetwork.clone());
      return responseFromNetwork;
    } catch (error) {
      // If the network request failed,
      // get the fallback response from the cache.
      const fallbackResponse = await caches.match(fallbackUrl);
      if (fallbackResponse) {
        return fallbackResponse;
      }
      // When even the fallback response is not available,
      // there is nothing we can do, but we must always
      // return a Response object.
      return new Response("Network error happened", {
        status: 408,
        headers: { "Content-Type": "text/plain" },
      });
    }
  };

  self.addEventListener("install", (event) => {
    self.skipWaiting();
  });
  
  self.addEventListener("fetch", (event) => {
    event.respondWith(
      cacheFirst({
        request: event.request,
        fallbackUrl: "./midi_player.html",
      }),
    );
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
          await clients.claim();
          const cacheWhitelist = [CACHE_NAME];
          const cacheNames = await caches.keys();
          await Promise.all(
              cacheNames.map(cacheName => {
                  if (!cacheWhitelist.includes(cacheName)) {
                      return caches.delete(cacheName);
                  }
              })
          );
      })()
    );
  });
  