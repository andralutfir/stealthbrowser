'use strict';
/**
 * Pools of *coherent* identity ingredients.
 * Coherence matters more than randomness: a Jakarta timezone with a sv-SE locale
 * and an Asia/Tokyo geolocation is a stronger signal than no spoofing at all.
 */

/** Each locale bundle keeps timezone + languages + geo + currency consistent. */
const LOCALES = [
  { locale: 'en-US', languages: ['en-US', 'en'], tz: 'America/New_York',    geo: [40.7128, -74.0060], acceptLanguage: 'en-US,en;q=0.9' },
  { locale: 'en-US', languages: ['en-US', 'en'], tz: 'America/Chicago',     geo: [41.8781, -87.6298], acceptLanguage: 'en-US,en;q=0.9' },
  { locale: 'en-US', languages: ['en-US', 'en'], tz: 'America/Los_Angeles', geo: [34.0522, -118.2437], acceptLanguage: 'en-US,en;q=0.9' },
  { locale: 'en-GB', languages: ['en-GB', 'en'], tz: 'Europe/London',       geo: [51.5074, -0.1278],  acceptLanguage: 'en-GB,en;q=0.9' },
  { locale: 'en-CA', languages: ['en-CA', 'en', 'fr-CA'], tz: 'America/Toronto', geo: [43.6532, -79.3832], acceptLanguage: 'en-CA,en;q=0.9,fr-CA;q=0.8' },
  { locale: 'en-AU', languages: ['en-AU', 'en'], tz: 'Australia/Sydney',    geo: [-33.8688, 151.2093], acceptLanguage: 'en-AU,en;q=0.9' },
  { locale: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'], tz: 'Europe/Berlin', geo: [52.52, 13.405], acceptLanguage: 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'], tz: 'Europe/Paris',  geo: [48.8566, 2.3522], acceptLanguage: 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'nl-NL', languages: ['nl-NL', 'nl', 'en-US', 'en'], tz: 'Europe/Amsterdam', geo: [52.3676, 4.9041], acceptLanguage: 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'es-ES', languages: ['es-ES', 'es', 'en'], tz: 'Europe/Madrid', geo: [40.4168, -3.7038], acceptLanguage: 'es-ES,es;q=0.9,en;q=0.8' },
  { locale: 'it-IT', languages: ['it-IT', 'it', 'en'], tz: 'Europe/Rome',   geo: [41.9028, 12.4964], acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8' },
  { locale: 'pl-PL', languages: ['pl-PL', 'pl', 'en-US', 'en'], tz: 'Europe/Warsaw', geo: [52.2297, 21.0122], acceptLanguage: 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'sv-SE', languages: ['sv-SE', 'sv', 'en-US', 'en'], tz: 'Europe/Stockholm', geo: [59.3293, 18.0686], acceptLanguage: 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'], tz: 'America/Sao_Paulo', geo: [-23.5505, -46.6333], acceptLanguage: 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'id-ID', languages: ['id-ID', 'id', 'en-US', 'en'], tz: 'Asia/Jakarta', geo: [-6.2088, 106.8456], acceptLanguage: 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'], tz: 'Asia/Tokyo', geo: [35.6762, 139.6503], acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'ko-KR', languages: ['ko-KR', 'ko', 'en-US', 'en'], tz: 'Asia/Seoul', geo: [37.5665, 126.9780], acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'en-SG', languages: ['en-SG', 'en'], tz: 'Asia/Singapore', geo: [1.3521, 103.8198], acceptLanguage: 'en-SG,en;q=0.9' },
];

/** Realistic ANGLE strings. Vendor/renderer pairs must belong together. */
const GPUS = {
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A8) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) HD Graphics 630 (0x00005912) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  ],
  macos: [
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)' },
  ],
  linux: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)' },
    { vendor: 'Google Inc. (AMD)',   renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6), OpenGL 4.6)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)' },
  ],
};

/** Common real-world desktop resolutions with their usual device pixel ratio. */
const SCREENS = [
  { w: 1920, h: 1080, dpr: 1,    taskbar: 40 },
  { w: 1920, h: 1080, dpr: 1.25, taskbar: 48 },
  { w: 1536, h: 864,  dpr: 1.25, taskbar: 40 },
  { w: 1600, h: 900,  dpr: 1,    taskbar: 40 },
  { w: 1440, h: 900,  dpr: 1,    taskbar: 40 },
  { w: 1366, h: 768,  dpr: 1,    taskbar: 40 },
  { w: 2560, h: 1440, dpr: 1,    taskbar: 48 },
  { w: 2560, h: 1440, dpr: 1.5,  taskbar: 48 },
  { w: 1680, h: 1050, dpr: 1,    taskbar: 40 },
  { w: 3840, h: 2160, dpr: 2,    taskbar: 56 },
];

const CORES = [4, 4, 6, 8, 8, 8, 12, 16];
const MEMORY = [4, 8, 8, 8, 16, 16, 32];

/** Windows platformVersion in UA-CH: >=13 means Windows 11 to the client-hints API. */
const WIN_PLATFORM_VERSIONS = ['10.0.0', '13.0.0', '14.0.0', '15.0.0', '19.0.0'];
const MAC_PLATFORM_VERSIONS = ['13.6.0', '14.4.1', '14.6.1', '15.1.0', '15.3.1'];
const LINUX_PLATFORM_VERSIONS = ['6.5.0', '6.8.0', '6.11.0'];

module.exports = { LOCALES, GPUS, SCREENS, CORES, MEMORY, WIN_PLATFORM_VERSIONS, MAC_PLATFORM_VERSIONS, LINUX_PLATFORM_VERSIONS };
