// Smooth word-by-word reveal for any element marked data-reveal (used on the login heading).
// Plain text only, keeps the full text for screen readers, skipped when reduced motion is on.
(function () {
    function run() {
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce) return;
        document.querySelectorAll('[data-reveal]').forEach(function (el) {
            if (el.getAttribute('data-revealed')) return;
            var text = el.textContent.trim();
            if (!text) return;
            el.setAttribute('aria-label', text);
            el.setAttribute('data-revealed', '1');
            el.textContent = '';
            text.split(/\s+/).forEach(function (w, i, all) {
                var s = document.createElement('span');
                s.className = 'nx-word';
                s.setAttribute('aria-hidden', 'true');
                s.style.setProperty('--i', i);
                s.textContent = w + (i < all.length - 1 ? ' ' : '');
                el.appendChild(s);
            });
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
