// ============================================================
// SocialNexus — cookie / storage consent banner
//
// Categories:
//   essential  : always on (login session, theme, language, offline cache) — no consent needed
//   google     : optional — Google sign-in script for Google Drive storage
//
// Rules this follows: nothing optional runs before the user says yes; "Accept" and
// "Reject" are equally prominent; the choice can be changed any time (window.NexusConsent.open());
// the choice expires after 12 months and then we ask again.
// ============================================================
(function () {
    var KEY = 'nexus_consent_v1';
    var MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
    var listeners = [];
    var root = null;

    function read() {
        try {
            var v = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (v && v.v === 1 && typeof v.ts === 'number' && Date.now() - v.ts < MAX_AGE_MS) return v;
        } catch (e) { /* storage blocked: treat as "no choice yet" */ }
        return null;
    }
    function write(google) {
        var v = { v: 1, essential: true, google: !!google, ts: Date.now() };
        try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
        listeners.forEach(function (fn) { try { fn(v); } catch (e) { /* ignore */ } });
        return v;
    }

    var CSS = '' +
        '#nxConsent{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;padding:12px;pointer-events:none}' +
        '#nxConsent .nx-card{pointer-events:auto;width:100%;max-width:640px;background:#12161b;color:#e8edf2;border:1px solid #2a313a;border-radius:16px;padding:18px 18px 16px;box-shadow:0 10px 40px rgba(0,0,0,.55);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;animation:nxUp .4s cubic-bezier(.2,.7,.2,1)}' +
        '#nxConsent h2{margin:0 0 6px;font-size:17px;line-height:1.3}' +
        '#nxConsent p{margin:0 0 10px;color:#c3cdd8}' +
        '#nxConsent a{color:#7db4fb}' +
        '#nxConsent .nx-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}' +
        '#nxConsent button{font:inherit;font-weight:600;border-radius:10px;padding:10px 16px;min-height:44px;cursor:pointer;flex:1 1 140px;border:2px solid #2563eb;background:#2563eb;color:#fff}' +
        '#nxConsent button.nx-alt{background:transparent;color:#e8edf2;border-color:#56606c}' +
        '#nxConsent button:hover{filter:brightness(1.12)}' +
        '#nxConsent button:focus-visible,#nxConsent input:focus-visible,#nxConsent summary:focus-visible{outline:3px solid #7db4fb;outline-offset:2px}' +
        '#nxConsent details{margin:8px 0 0;border:1px solid #2a313a;border-radius:10px;padding:10px 12px}' +
        '#nxConsent summary{cursor:pointer;font-weight:600}' +
        '#nxConsent label{display:flex;gap:10px;align-items:flex-start;margin-top:10px}' +
        '#nxConsent input[type=checkbox]{width:22px;height:22px;margin-top:2px;flex:none}' +
        '#nxConsent .nx-sub{display:block;color:#a9b4c0;font-size:13.5px}' +
        '@keyframes nxUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}' +
        '@media (prefers-reduced-motion:reduce){#nxConsent .nx-card{animation:none}}';

    function close(restoreTo) {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = null;
        if (restoreTo && restoreTo.focus) { try { restoreTo.focus(); } catch (e) { /* ignore */ } }
    }

    function open(opts) {
        if (root) { var first = root.querySelector('button'); if (first) first.focus(); return; }
        var current = read();
        var prev = document.activeElement;
        var style = document.createElement('style');
        style.textContent = CSS;
        root = document.createElement('div');
        root.id = 'nxConsent';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-labelledby', 'nxConsentTitle');
        root.setAttribute('aria-describedby', 'nxConsentDesc');
        root.innerHTML =
            '<div class="nx-card">' +
            '<h2 id="nxConsentTitle">Your privacy choices</h2>' +
            '<p id="nxConsentDesc">SocialNexus uses a small amount of storage on your device to keep you logged in and remember your settings. That is essential and always on. One optional feature, saving photos and videos to your own Google Drive, loads a script from Google. It stays off unless you allow it. No advertising or analytics trackers. See our <a href="cookies.html">Cookie Policy</a> and <a href="privacy.html">Privacy Policy</a>.</p>' +
            '<details' + (opts && opts.details ? ' open' : '') + '><summary>Choose categories</summary>' +
            '<label><input type="checkbox" checked disabled aria-describedby="nxEss"><span><strong>Essential</strong><span class="nx-sub" id="nxEss">Login session, theme, language, offline cache. Always on.</span></span></label>' +
            '<label><input type="checkbox" id="nxGoogle"' + (current && current.google ? ' checked' : '') + '><span><strong>Google services (optional)</strong><span class="nx-sub">Loads Google sign-in so you can store media in your own Google Drive. Google may set its own cookies.</span></span></label>' +
            '<div class="nx-row"><button type="button" id="nxSave">Save my choices</button></div>' +
            '</details>' +
            '<div class="nx-row">' +
            '<button type="button" class="nx-alt" id="nxReject">Reject optional</button>' +
            '<button type="button" class="nx-alt" id="nxAccept">Accept optional</button>' +
            '</div></div>';
        root.appendChild(style);
        document.body.appendChild(root);

        function done(google) { write(google); close(prev); }
        root.querySelector('#nxReject').addEventListener('click', function () { done(false); });
        root.querySelector('#nxAccept').addEventListener('click', function () { done(true); });
        root.querySelector('#nxSave').addEventListener('click', function () { done(root.querySelector('#nxGoogle').checked); });
        root.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && current) { close(prev); }   // only dismissable without a choice if one already exists
        });
        var target = (opts && opts.details) ? root.querySelector('#nxGoogle') : root.querySelector('#nxReject');
        setTimeout(function () { if (target) target.focus(); }, 60);
    }

    window.NexusConsent = {
        get: read,
        has: function (cat) { var v = read(); return cat === 'essential' ? true : !!(v && v[cat]); },
        open: open,
        onChange: function (fn) { listeners.push(fn); },
        // Ask for one optional category; resolves true/false once the user decides.
        ask: function (cat) {
            if (read()) return Promise.resolve(window.NexusConsent.has(cat));
            return new Promise(function (resolve) {
                window.NexusConsent.onChange(function (v) { resolve(!!v[cat]); });
                open({ details: true });
            });
        }
    };

    function init() {
        if (!read()) open();
        // footer-style links anywhere in the app: <a data-cookie-settings>
        document.addEventListener('click', function (e) {
            var a = e.target.closest && e.target.closest('[data-cookie-settings]');
            if (a) { e.preventDefault(); open({ details: true }); }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
