// ============================================================
// SocialNexus — "Continue with Google" on the login/signup screen
//
// Flow: Google gives a signed ID token -> Supabase checks it (signInWithIdToken) -> we look for
// the profile linked to that Supabase user. Found = log in. Not found = ask for a username once
// and create the profile with rpc_google_signup (see supabase-google-login.sql).
// Needs: GOOGLE_CLIENT_ID set, and Google provider ON in Supabase (see SETUP-GOOGLE-LOGIN.md).
// ============================================================
(function () {
    const $ = (id) => document.getElementById(id);
    const wrap = $('googleAuthWrap');
    if (!wrap) return;
    const clientId = (typeof GOOGLE_CLIENT_ID !== 'undefined' && GOOGLE_CLIENT_ID) ? GOOGLE_CLIENT_ID : '';
    if (!clientId) return; // not configured: the button stays hidden

    const host = $('googleBtnHost'), fallback = $('googleFallbackBtn'), errEl = $('googleAuthError');
    const form = $('googleUsernameForm'), unameInput = $('googleUsernameInput'), unameErr = $('googleUsernameError');
    let pending = null; // { email } while waiting for a username
    let rendered = false;

    wrap.classList.remove('hidden');

    // Only show the Google button while the normal login/signup form is on screen.
    function syncVisibility() {
        const formsShown = ['loginForm', 'signupForm'].some(id => $(id) && !$(id).classList.contains('hidden'));
        wrap.classList.toggle('hidden', !formsShown || !!pending);
    }
    ['loginForm', 'signupForm', 'login2faForm'].forEach(id => {
        if ($(id)) new MutationObserver(syncVisibility).observe($(id), { attributes: true, attributeFilter: ['class'] });
    });
    syncVisibility();

    function showErr(msg) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    function clearErr() { errEl.classList.add('hidden'); }

    function loadGis(allowAsk) {
        return (async () => {
            if (window.NexusConsent && !NexusConsent.has('google')) {
                if (!allowAsk) throw new Error('consent');
                if (!(await NexusConsent.ask('google'))) throw new Error('Google sign-in was not allowed in your cookie settings');
            }
            await new Promise((resolve, reject) => {
                if (window.google && google.accounts && google.accounts.id) return resolve();
                let s = $('gisScript');
                if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', reject); return; }
                s = document.createElement('script');
                s.id = 'gisScript'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
                s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load Google sign-in'));
                document.head.appendChild(s);
            });
        })();
    }

    async function renderOfficialButton(allowAsk) {
        if (rendered) return true;
        await loadGis(allowAsk);
        google.accounts.id.initialize({ client_id: clientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
        const width = Math.max(200, Math.min(360, Math.round(wrap.clientWidth || 300)));
        google.accounts.id.renderButton(host, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width });
        fallback.classList.add('hidden');
        rendered = true;
        return true;
    }

    // Consent already given before -> show Google's own button straight away.
    // Otherwise our button asks for the cookie consent first, then swaps itself for Google's.
    fallback.addEventListener('click', async () => {
        clearErr();
        try { await renderOfficialButton(true); showErr('Ab upar wale Google button par tap karo.'); }
        catch (e) { showErr(e && e.message ? e.message : 'Google sign-in start nahi ho paya'); }
    });
    if (!window.NexusConsent || NexusConsent.has('google')) renderOfficialButton(false).catch(() => {});

    async function finish(username, email) {
        try { localStorage.setItem('nexus_google_email', email || ''); } catch (e) {}
        activateAccount(username); // reloads the page into the app
    }

    async function onCredential(resp) {
        clearErr();
        if (!resp || !resp.credential) return showErr('Google se login nahi ho paya, dobara try karo.');
        const { data, error } = await supabaseClient.auth.signInWithIdToken({ provider: 'google', token: resp.credential });
        if (error || !data || !data.user) {
            console.warn('Google sign-in:', error);
            return showErr('Google login abhi ON nahi hai — Supabase me Google provider enable karo (SETUP-GOOGLE-LOGIN.md). ' + (error && error.message ? '(' + error.message + ')' : ''));
        }
        const user = data.user;
        const { data: rows, error: selErr } = await supabaseClient.from('profiles').select('username').eq('auth_user_id', user.id).limit(1);
        if (selErr) { console.warn(selErr); return showErr('Profile check fail hua: ' + selErr.message); }
        if (rows && rows[0] && rows[0].username) return finish(rows[0].username, user.email);

        // First time with this Google account: choose a username.
        pending = { email: user.email || '' };
        $('googleUsernameEmail').textContent = pending.email;
        ['loginForm', 'signupForm', 'login2faForm', 'authTabsWrap'].forEach(id => $(id) && $(id).classList.add('hidden'));
        wrap.classList.add('hidden');
        form.classList.remove('hidden');
        unameInput.focus();
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        unameErr.classList.add('hidden');
        const username = unameInput.value.trim();
        if (!/^[A-Za-z0-9_.]{3,24}$/.test(username)) {
            unameErr.textContent = 'Username 3-24 characters ka ho: letters, numbers, _ ya .';
            return unameErr.classList.remove('hidden');
        }
        const btn = $('googleUsernameBtn'); btn.disabled = true;
        try {
            const { data: res, error } = await supabaseClient.rpc('rpc_google_signup', { p_username: username });
            if (error) { console.warn(error); unameErr.textContent = 'Setup baaki hai — supabase-google-login.sql ko Supabase me run karo.'; return unameErr.classList.remove('hidden'); }
            if (!res || !res.ok) {
                unameErr.textContent = res && res.error === 'username_taken' ? 'Ye username pehle se liya ja chuka hai.' : 'Account create nahi ho paaya.';
                return unameErr.classList.remove('hidden');
            }
            await finish(res.username || username, pending && pending.email);
        } finally { btn.disabled = false; }
    });

    $('googleUsernameCancel').addEventListener('click', async () => {
        try { await supabaseClient.auth.signOut(); } catch (e) {}
        pending = null;
        form.classList.add('hidden');
        $('authTabsWrap') && $('authTabsWrap').classList.remove('hidden');
        if (typeof switchAuthTab === 'function') switchAuthTab('login');
        syncVisibility();
    });
})();
