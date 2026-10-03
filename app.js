'use strict';

// No dependencies or keys. Location is kept in memory only.
const CITIES = {
  mumbai: [19.0760, 72.8777], thane: [19.2183, 72.9781], navimumbai: [19.0330, 73.0297],
  pune: [18.5204, 73.8567], delhi: [28.6139, 77.2090], bengaluru: [12.9716, 77.5946],
  chennai: [13.0827, 80.2707], hyderabad: [17.3850, 78.4867], kolkata: [22.5726, 88.3639], ahmedabad: [23.0225, 72.5714]
};
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Fictional examples only: never used for calls, directions, or real search results.
const DEMO_HOSPITALS = [
  { name: 'Willow Care Hospital', specialty: 'Multispeciality care', emergency: true, beds: { General: 18, ICU: 4, Emergency: 6 } },
  { name: 'Sunrise Medical Centre', specialty: 'Family & emergency care', emergency: true, beds: { General: 12, ICU: 2, Emergency: 3 } },
  { name: 'Oakridge Community Hospital', specialty: 'General & recovery care', emergency: false, beds: { General: 9, ICU: 0, Emergency: 0 } }
];
const $ = (selector) => document.querySelector(selector);
let origin = null;
let locationLabel = '';
let hospitals = [];
let activeFilter = 'all';
let requestController;
let requestId = 0;
let searchState = 'idle';
const cache = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(label, href, className = 'button secondary') {
  const node = element('a', className, label);
  node.href = href;
  if (href.startsWith('https:')) { node.target = '_blank'; node.rel = 'noopener noreferrer'; }
  return node;
}
function distanceKm(a, b) {
  const radians = n => n * Math.PI / 180;
  const dLat = radians(b[0] - a[0]), dLon = radians(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
function phoneNumber(raw) {
  const first = String(raw || '').split(/[;,]/)[0].trim();
  const cleaned = first.replace(/[\s().-]/g, '');
  return /^\+?\d{7,15}$/.test(cleaned) ? cleaned : null;
}
function mapsSearch(query) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query); }
function status(text, error = false) { $('#status').textContent = text; $('#status').classList.toggle('error', error); }
function empty(title, description, loading = false) {
  const box = element('div', 'empty-state');
  box.append(element('span', 'location-emblem' + (loading ? ' loading' : ''), '⌖'), element('h3', '', title), element('p', '', description));
  $('#results').replaceChildren(box);
}
function setBusy(busy) {
  $('#results').setAttribute('aria-busy', String(busy));
  $('#locate').disabled = busy;
}
function normalize(items, coordinates) {
  const seen = new Set();
  return items.flatMap(item => {
    const tags = item.tags || {};
    const lat = item.lat ?? item.center?.lat, lon = item.lon ?? item.center?.lon;
    const name = tags['name:en'] || tags.name;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const key = name.toLowerCase() + ':' + lat.toFixed(3) + ':' + lon.toFixed(3);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, lat, lon, id: item.type + '/' + item.id,
      phone: phoneNumber(tags['contact:phone'] || tags.phone), emergency: tags.emergency === 'yes',
      address: [tags['addr:street'], tags['addr:suburb'], tags['addr:city']].filter(Boolean).join(', '),
      distance: distanceKm(coordinates, [lat, lon]) }];
  }).sort((a, b) => a.distance - b.distance);
}
async function findHospitals() {
  if (!origin) return;
  const thisRequest = ++requestId;
  requestController?.abort();
  requestController = new AbortController();
  const controller = requestController;
  const coordinates = [...origin];
  const radius = Number($('#radius').value);
  const key = coordinates.join(',') + ':' + radius;
  searchState = 'loading'; hospitals = [];
  $('#demo-banner').hidden = true;
  setBusy(true);
  status('Searching around ' + locationLabel + '…');
  empty('Finding nearby hospitals…', 'Emergency? You can call 112 without waiting.', true);
  $('#maps-fallback').href = mapsSearch('hospitals near ' + coordinates.join(','));
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const cached = cache.get(key);
    let data;
    if (cached && Date.now() - cached.time < 300000) {
      data = cached.data;
    } else {
      const query = `[out:json][timeout:20];(nwr["amenity"="hospital"](around:${radius},${coordinates[0]},${coordinates[1]});nwr["healthcare"="hospital"](around:${radius},${coordinates[0]},${coordinates[1]}););out center tags;`;
      const response = await fetch(OVERPASS_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }), signal: controller.signal
      });
      if (!response.ok) throw new Error('Directory unavailable');
      data = await response.json();
      if (!Array.isArray(data.elements) || data.remark) throw new Error('Incomplete directory response');
      cache.set(key, {time: Date.now(), data});
    }
    if (thisRequest !== requestId) return;
    hospitals = normalize(data.elements, coordinates).filter(h => h.distance <= radius / 1000 + .05);
    searchState = 'ready'; renderResults();
  } catch (error) {
    if (thisRequest !== requestId) return;
    searchState = 'error';
    status('We couldn’t load the hospital directory. Your connection or the directory may be busy.', true);
    empty('There’s another way to find care.', 'Try again, or use the Google Maps link below. In an emergency, call 112.');
    const retry = element('button', 'button secondary', 'Try again');
    retry.style.marginTop = '18px'; retry.addEventListener('click', findHospitals);
    $('#results').firstElementChild.append(retry);
  } finally {
    clearTimeout(timeout);
    if (thisRequest === requestId) setBusy(false);
  }
}
function renderResults() {
  if (searchState === 'demo') { renderDemo(); return; }
  if (searchState !== 'ready') return;
  const term = $('#hospital-filter').value.trim().toLowerCase();
  const visible = hospitals.filter(h => h.name.toLowerCase().includes(term) && (activeFilter !== 'emergency' || h.emergency) && (activeFilter !== 'phone' || h.phone));
  const shown = visible.slice(0, 30);
  status(`${visible.length} hospital${visible.length === 1 ? '' : 's'} found around ${locationLabel}${visible.length > 30 ? ' · Showing the nearest 30' : ''}. Distances are straight-line estimates.`);
  if (!shown.length) {
    empty('No hospitals match this search.', hospitals.length ? 'Try another filter or hospital name.' : 'Try a wider search radius or open Google Maps below.');
    return;
  }
  const cards = shown.map(hospital => {
    const card = element('article', 'hospital');
    const top = element('div', 'hospital-header');
    top.append(element('span', 'hospital-mark', '+'), element('span', 'distance', hospital.distance.toFixed(1) + ' km away'));
    card.append(top, element('h3', '', hospital.name));
    card.append(element('p', 'hospital-address', hospital.address || 'Address details not listed · See map'));
    card.append(element('p', 'emergency-label', hospital.emergency ? 'Emergency service listed in directory' : 'Emergency services: call to confirm'));
    card.append(element('div', 'bed-state', 'Beds: availability not verified'));
    const actions = element('div', 'hospital-actions');
    actions.append(link(hospital.phone ? 'Call hospital' : 'Find contact', hospital.phone ? 'tel:' + hospital.phone : mapsSearch(hospital.name + ' ' + hospital.lat + ',' + hospital.lon), 'button primary'));
    actions.append(link('Directions', `https://www.google.com/maps/dir/?api=1&destination=${hospital.lat},${hospital.lon}`));
    card.append(actions);
    const bedCheck = element('button', 'bed-check', 'Ask about beds');
    bedCheck.addEventListener('click', () => showDialog('beds', hospital));
    card.append(bedCheck);
    return card;
  });
  $('#results').replaceChildren(...cards);
}
function renderDemo() {
  searchState = 'demo';
  $('#demo-banner').hidden = false;
  const term = $('#hospital-filter').value.trim().toLowerCase();
  const visible = DEMO_HOSPITALS.filter(h => h.name.toLowerCase().includes(term)
    && (activeFilter !== 'emergency' || h.emergency) && activeFilter !== 'phone');
  status(`${visible.length} demo hospital${visible.length === 1 ? '' : 's'} · Sample bed counts only. Choose a city or use your location for real hospitals.`);
  if (!visible.length) {
    empty('No demo hospitals match.', activeFilter === 'phone' ? 'Demo hospitals have no real phone numbers. Choose a city or use your location to find hospital contacts.' : 'Try another hospital name or select All hospitals.');
    return;
  }
  const cards = visible.map((hospital) => {
    const card = element('article', 'hospital demo-hospital');
    const top = element('div', 'hospital-header');
    const mark = element('span', 'hospital-mark', '+');
    mark.setAttribute('aria-hidden', 'true');
    top.append(mark, element('span', 'demo-tag', 'FICTIONAL HOSPITAL'));
    card.append(top, element('h3', '', hospital.name), element('p', 'hospital-address', hospital.specialty));
    card.append(element('p', 'emergency-label', hospital.emergency ? 'Sample service · Emergency care' : 'Sample service · General care'));
    const beds = element('dl', 'demo-beds');
    Object.entries(hospital.beds).forEach(([type, count]) => {
      const metric = element('div', count === 0 ? 'bed-metric zero' : 'bed-metric');
      metric.append(element('dt', '', type), element('dd', '', String(count)));
      beds.append(metric);
    });
    card.append(element('p', 'bed-caption', 'Sample available beds'), beds,
      element('p', 'demo-card-note', 'For preview only · Not live availability'));
    return card;
  });
  $('#results').replaceChildren(...cards);
}
function showDialog(type, hospital) {
  const body = $('#dialog-content'); body.replaceChildren();
  $('#dialog-eyebrow').textContent = type === 'ambulance' ? 'EMERGENCY ASSISTANCE · INDIA' : 'CHECK BEFORE YOU TRAVEL';
  if (type === 'ambulance') {
    $('#dialog-title').textContent = 'Need an ambulance? Call 112.';
    body.append(element('p', '', 'Speak to the emergency operator and ask for medical or ambulance assistance.'));
    const list = element('ul');
    ['Share your exact location and a nearby landmark.', 'Explain what happened and give a callback number.', 'Follow the operator’s instructions.'].forEach(text => list.append(element('li', '', text)));
    body.append(list, element('p', 'dialog-note', 'SwiftLink does not dispatch ambulances or track response times. Calling opens your device’s dialler.'));
    const actions = element('div', 'dialog-actions'); actions.append(link('Call 112 now', 'tel:112', 'button emergency')); body.append(actions);
  } else {
    $('#dialog-title').textContent = hospital ? 'Ask ' + hospital.name + ' about beds' : 'A quick call brings more clarity.';
    body.append(element('p', '', 'Live bed counts are not available on SwiftLink. Contact the hospital’s admissions or emergency desk to confirm:'));
    const list = element('ul');
    ['Is the type of bed needed available — general, ICU, or emergency?', 'Can the hospital provide the care the patient needs?', 'Where should the patient arrive, and what is needed for admission?'].forEach(text => list.append(element('li', '', text)));
    body.append(list, element('p', 'dialog-note', 'Availability can change quickly. A directory listing is not a bed reservation or a guarantee of care.'));
    const actions = element('div', 'dialog-actions');
    if (hospital) actions.append(link(hospital.phone ? 'Call hospital' : 'Find hospital contact', hospital.phone ? 'tel:' + hospital.phone : mapsSearch(hospital.name + ' ' + hospital.lat + ',' + hospital.lon), 'button primary'));
    else { const choose = element('button', 'button primary', 'Find a hospital'); choose.addEventListener('click', () => { $('#care-dialog').close(); $('#find-care').scrollIntoView(); $('#city').focus({preventScroll:true}); }); actions.append(choose); }
    actions.append(link('Emergency 112', 'tel:112', 'button secondary')); body.append(actions);
  }
  $('#care-dialog').showModal();
}
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => showDialog(button.dataset.open)));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected)); });
  renderResults();
}));
$('#hospital-filter').addEventListener('input', renderResults);
$('#city').addEventListener('change', () => {
  const value = $('#city').value;
  if (!CITIES[value]) { ++requestId; requestController?.abort(); origin = null; hospitals = []; setBusy(false); $('#maps-fallback').href = 'https://www.google.com/maps/search/hospitals+near+me/'; renderDemo(); return; }
  origin = CITIES[value]; locationLabel = $('#city').selectedOptions[0].textContent;
  findHospitals();
});
$('#radius').addEventListener('change', findHospitals);
$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) { status('Location is unavailable in this browser. Choose a city instead.', true); return; }
  status('Waiting for location permission…'); $('#locate').disabled = true;
  const geoRequest = ++requestId;
  navigator.geolocation.getCurrentPosition(position => {
    if (geoRequest !== requestId) return;
    origin = [position.coords.latitude, position.coords.longitude]; locationLabel = 'your location'; $('#city').value = '';
    findHospitals();
  }, error => {
    if (geoRequest !== requestId) return;
    $('#locate').disabled = false;
    status(error.code === 1 ? 'Location permission was not granted. You can choose a city instead.' : 'Your location couldn’t be found. Choose a city or try again.', true);
  }, {enableHighAccuracy:false, timeout:12000, maximumAge:60000});
});
$('#care-dialog').addEventListener('click', event => { if (event.target === $('#care-dialog')) { const r = $('#care-dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#care-dialog').close(); } });
renderDemo();
