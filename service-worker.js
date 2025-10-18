// service-worker.js

const SOUNDFONT_GM = "./soundfonts/GeneralUserGS.sf3"; // General Midi soundfont
const SOUNTFONT_SPECIAL = "./soundfonts/Choir_practice.sf2"; //special soundfont
const CACHE_NAME = "v8.17"; 

const putInCache = async (request, response) => {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  };
  
  const cacheFirst = async ({ request, fallbackUrl }) => {
    // First try to get the resource from the cache.
    const cache = await caches.open(CACHE_NAME);
    const responseFromCache = await cache.match(request);
    if (responseFromCache) {
      return responseFromCache;
    }

    // when fetching settings, only search the cache
    if (request.url.includes('/settings/')) {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
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
    event.waitUntil( Promise.allSettled([
      caches.keys().then(cacheNames => {
        // Filter out the new cache name
        const oldCacheNames = cacheNames.filter(name => name !== CACHE_NAME);
        // Get the latest cache name
        const latestCacheName = oldCacheNames[oldCacheNames.length - 1];
                
        if (latestCacheName) {
          if (Number(latestCacheName.slice(1))>7.0) {//settings of caches of versions <=7.0 are not compatible
            caches.open(latestCacheName).then(oldCache => {
              oldCache.keys().then(requests => {
                const settingsRequests = requests.filter(request => request.url.includes('/settings/'));
                settingsRequests.map(request => {
                  oldCache.match(request).then(response => {
                    if (response) {
                      putInCache(request, response);
                    }
                  });
                })
              });
            });
          }
        }
        return Promise.resolve(undefined);
      }),
      caches.open(CACHE_NAME)
        .then((cache) => {
          fetch(SOUNDFONT_GM, {cache: "reload"}).then((response) => {
            if (!response.ok) {
              throw new TypeError("bad response status");
            }
            return cache.put(SOUNDFONT_GM, response);
          });
        })
        .catch(() => {return Promise.resolve(undefined);}),
      caches.open(CACHE_NAME)
        .then((cache) => {
          fetch(SOUNTFONT_SPECIAL, {cache: "reload"}).then((response) => {
            if (!response.ok) {
              throw new TypeError("bad response status");
            }
            return cache.put(SOUNTFONT_SPECIAL, response);
          });
        })
        .catch(() => {return Promise.resolve(undefined);}),
      caches.open(CACHE_NAME)
        .then((cache) => {
          fetch('./midi_player.js', {cache: "reload"}).then((response) => {
            if (!response.ok) {
              throw new TypeError("bad response status");
            }
            return cache.put('./midi_player.js', response);
          });
        })
        .catch(() => {return Promise.resolve(undefined);}),
      caches.open(CACHE_NAME)
        .then((cache) => {
          fetch('./midi_player.html', {cache: "reload"}).then((response) => {
            if (!response.ok) {
              throw new TypeError("bad response status");
            }
            return cache.put('./midi_player.html', response);
          });
        })
        .catch(() => {return Promise.resolve(undefined);}),
      caches.open(CACHE_NAME)
        .then((cache) => {
          fetch('./midi_player.css', {cache: "reload"}).then((response) => {
            if (!response.ok) {
              throw new TypeError("bad response status");
            }
            return cache.put('./midi_player.css', response);
          });
        })
        .catch(() => {return Promise.resolve(undefined);}),
    ]));  
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
          const cacheWhitelist = [CACHE_NAME];
          const cacheNames = await caches.keys();
          await Promise.all(
              cacheNames.map(cacheName => {
                  if (!cacheWhitelist.includes(cacheName)) {
                      console.log(`old cache ${cacheName} deleted.`);
                      return caches.delete(cacheName);
                  }
                  console.log(`active cache is ${CACHE_NAME}`);
              })
          );
          await clients.claim();
      })()
    );
  });

self.addEventListener('message', async (event) => {
  const { type, key, settings } = event.data;
  if (type === 'storeSettings') {
      const cache = await caches.open(CACHE_NAME);
      let response;
      if (key === "./settings/current_midi_file") {
        response = await fetch(settings);
      } 
      else if (key.includes("blob_")) {
        response = await fetch(settings);
      } 
      else {
        response = new Response(JSON.stringify(settings), {
          headers: { 'Content-Type': 'application/json' }     
        });
      }
      await cache.put(key, response);
      console.log(`settings (key: ${key}) saved to cache ${CACHE_NAME}`);   
  } 
  if (type === 'skipWaiting') {
    self.skipWaiting();
  }
  if (type === 'deleteFromCache') {
    const cache = await caches.open(CACHE_NAME);
    cache.delete(key);
  }
  if (type === 'all') {
    const port = event.ports[0]; // MessagePort for response
    try { 
      const cache = await caches.open(CACHE_NAME);
      const requests = await cache.keys();
    
      // Filter requests: include '/settings', exclude 'blob_'
      const matchingRequests = requests.filter(req =>
        req.url.includes('/settings') && !req.url.includes('blob_') && !req.url.includes('current_midi')
      );

      // Get cached responses for matching requests
      const responses = await Promise.all(
        matchingRequests.map(req => cache.match(req))
      );

      // Parse each response as JSON
      const contents = await Promise.all(
        responses.map(async res => res ? await res.json() : null)
      );

      if (contents.length() === 0) { contents = null; }

      // Send the responses back to the calling script
      port.postMessage(contents);
    } catch (error) {
      port.postMessage(null);
    }


  }
});
  