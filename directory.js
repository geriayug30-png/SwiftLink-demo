'use strict';
(() => {
  const {node, rpc, labels, date} = SwiftLive;
  const results = document.querySelector('#connected-results');
  const status = document.querySelector('#directory-status');
  const refreshButton = document.querySelector('#refresh-directory');
  let fetching = false;
  async function refresh() {
    if (fetching) return;
    fetching = true;
    refreshButton.disabled = true;
    try {
      const [hospitals, doctors] = await Promise.all([rpc('sl_directory'),rpc('sl_doctor_directory')]);
      const cards = hospitals.map(h => {
        const card = node('article', 'hospital');
        card.append(node('span', 'demo-tag', 'STAFF CONNECTED'), node('h3', '', h.name), node('p', 'hospital-address', h.city));
        const counts = node('dl', 'demo-beds');
        ['general', 'icu', 'emergency', 'ambulance'].forEach(kind => {
          const c = h.capacity.find(c => c.kind === kind);
          const fresh = c?.verified_at && Date.now() - Date.parse(c.verified_at) < 1800000;
          const metric = node('div', 'bed-metric');
          metric.append(node('dt', '', labels[kind]), node('dd', '', fresh ? String(c.available) : 'Unconfirmed'));
          counts.append(metric);
        });
        card.append(counts, node('p', 'demo-card-note', 'Counts require staff confirmation within the last 30 minutes.'));
        const latest = h.capacity.map(c => c.verified_at).filter(Boolean).sort().pop();
        if (latest) card.append(node('p', 'verified-note', 'Last staff update: ' + date(latest)));
        const request = node('a', 'button primary', 'Request bed or ambulance');
        request.href = 'request.html?hospital=' + encodeURIComponent(h.id);
        card.append(SwiftDoctors.render(doctors,h.id),request);
        return card;
      });
      results.replaceChildren(...cards);
      status.textContent = hospitals.length ? 'Synced ' + new Date().toLocaleTimeString() + ' · Shared with hospital staff' : 'No participating hospitals yet. Use the nearby hospital finder below.';
    } catch (error) {
      results.replaceChildren();
      status.textContent = 'Availability could not be refreshed. Try again or contact the hospital directly.';
    } finally {
      fetching = false;
      refreshButton.disabled = false;
    }
  }
  refreshButton.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  refresh();
})();
