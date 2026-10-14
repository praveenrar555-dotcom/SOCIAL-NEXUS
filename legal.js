// Fills operator details from legal-config.js into the legal pages and adds the smooth heading animation.
(function () {
    var C = window.NEXUS_LEGAL || {};
    var labels = {
        operatorName: 'operator name', operatorType: 'operator type', address: 'postal address',
        contactEmail: 'contact email', grievanceOfficerName: 'grievance officer name',
        grievanceOfficerEmail: 'grievance officer email', jurisdictionCity: 'jurisdiction city', websiteUrl: 'website address'
    };
    var missing = [];

    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    document.querySelectorAll('[data-legal]').forEach(function (el) {
        var key = el.getAttribute('data-legal');
        var val = (C[key] || '').toString().trim();
        if (val) {
            if (el.hasAttribute('data-mailto') && /@/.test(val)) {
                el.innerHTML = '<a href="mailto:' + esc(val) + '">' + esc(val) + '</a>';
            } else { el.textContent = val; }
        } else if (el.hasAttribute('data-optional')) {
            var row = el.closest('[data-row]');
            if (row) row.style.display = 'none'; else el.textContent = '';
        } else {
            el.innerHTML = '<span class="missing">[' + esc(labels[key] || key) + ' not filled in yet]</span>';
            if (missing.indexOf(key) < 0) missing.push(key);
        }
    });

    document.querySelectorAll('[data-legal-date]').forEach(function (el) { el.textContent = C.lastUpdated || ''; });

    if (missing.length) {
        var main = document.querySelector('main');
        if (main) {
            var w = document.createElement('div');
            w.className = 'config-warning';
            w.setAttribute('role', 'note');
            w.textContent = 'Site owner: some business details are still empty. Open legal-config.js and fill them in before publishing (' + missing.map(function (k) { return labels[k] || k; }).join(', ') + ').';
            main.insertBefore(w, main.firstChild);
        }
        if (window.console) console.warn('[legal] legal-config.js is incomplete:', missing.join(', '));
    }

    // Smooth word-by-word reveal for the page heading + lede (skipped for reduced motion).
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
        document.querySelectorAll('h1, .lede').forEach(function (el) {
            var text = el.textContent;
            el.setAttribute('aria-label', text);
            el.innerHTML = '';
            text.split(/\s+/).forEach(function (w, i, arr) {
                var s = document.createElement('span');
                s.className = 'rv-word'; s.setAttribute('aria-hidden', 'true');
                s.style.setProperty('--i', i);
                s.textContent = w + (i < arr.length - 1 ? ' ' : '');
                el.appendChild(s);
            });
        });
    }
})();
