// Slide-in menu (opened by the three-line button in the top bar).
// Holds every section of the app plus account, theme and legal links. Closes with the X,
// a tap outside, the Escape key, a swipe to the left, or after you choose something.
(function () {
    var drawer, overlay, menuBtn, lastFocus = null;
    function $(id) { return document.getElementById(id); }

    function isOpen() { return drawer && drawer.classList.contains('is-open'); }

    function openDrawer() {
        if (!drawer || isOpen()) return;
        lastFocus = document.activeElement;
        var chip = $('displayUsername'), who = $('drawerUsername');
        if (who) who.textContent = chip ? chip.textContent.trim() : '';
        drawer.classList.add('is-open');
        overlay.classList.add('is-open');
        drawer.setAttribute('aria-hidden', 'false');
        overlay.setAttribute('aria-hidden', 'false');
        if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
        var first = drawer.querySelector('.nx-item');
        if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 50);
    }

    function closeDrawer(restoreFocus) {
        if (!drawer || !isOpen()) return;
        drawer.classList.remove('is-open');
        overlay.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('aria-hidden', 'true');
        if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
        if (restoreFocus !== false && lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
    }

    function call(name) {
        var fn = window[name];
        if (typeof fn === 'function') fn.apply(null, Array.prototype.slice.call(arguments, 1));
    }

    function go(action) {
        // Run after the menu has started closing so modals open on top cleanly.
        closeDrawer(false);
        setTimeout(function () {
            if (action === 'profile') { try { openProfile(currentUser); } catch (e) {} }
            else if (action === 'notifications') call('openNotificationsModal');
            else if (action === 'switch') call('openAccountSwitcher');
            else if (action === 'customize') call('openPageCustomizeForCurrentPage');
            else if (action === 'logout') call('logout');
        }, 120);
    }

    window.openNavDrawer = openDrawer;
    window.closeNavDrawer = closeDrawer;
    window.nxSyncDrawer = function (tab) {
        if (!drawer) return;
        drawer.querySelectorAll('[data-go-tab]').forEach(function (b) {
            var on = b.getAttribute('data-go-tab') === tab;
            b.classList.toggle('is-active', on);
            if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
    };

    function init() {
        drawer = $('navDrawer'); overlay = $('navDrawerOverlay'); menuBtn = $('menuBtn');
        if (!drawer || !overlay) return;

        drawer.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('[data-go-tab],[data-go],[data-close-drawer],a[href]') : null;
            if (!t) return;
            if (t.hasAttribute('data-go-tab')) { closeDrawer(false); call('switchTab', t.getAttribute('data-go-tab')); }
            else if (t.hasAttribute('data-go')) go(t.getAttribute('data-go'));
            else closeDrawer(false); // links and cookie settings
        });

        document.addEventListener('keydown', function (e) {
            if (!isOpen()) return;
            if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
            if (e.key === 'Tab') { // keep keyboard focus inside the open menu
                var f = drawer.querySelectorAll('a[href],button:not([disabled])');
                if (!f.length) return;
                var first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        });

        var x0 = null;
        drawer.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
        drawer.addEventListener('touchend', function (e) {
            if (x0 !== null && e.changedTouches[0].clientX - x0 < -60) closeDrawer();
            x0 = null;
        }, { passive: true });

        try { window.nxSyncDrawer(localStorage.getItem('nexus_tab') || 'feed'); } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
