/* Service worker: deixa o app funcionando offline depois do primeiro acesso.
   Os projetos ficam no IndexedDB do aparelho (não passam pelo cache). */
const VERSAO = 'arcad-v1.0.0';
const ARQUIVOS = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/main.js', './js/db.js', './js/importer.js', './js/importer-worker.js', './js/cad-core.js',
  './js/modelo.js', './js/visualizador3d.js', './js/ar.js',
  './vendor/three/three.module.min.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './vendor/three/addons/loaders/GLTFLoader.js', './vendor/three/addons/loaders/STLLoader.js', './vendor/three/addons/loaders/OBJLoader.js',
  './vendor/three/addons/exporters/GLTFExporter.js',
  './vendor/three/addons/utils/BufferGeometryUtils.js', './vendor/three/addons/utils/TextureUtils.js',
  './vendor/occt/occt-import-js.js', './vendor/occt/occt-import-js.wasm',
  './icons/icone-192.png', './icons/icone-512.png'
];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
