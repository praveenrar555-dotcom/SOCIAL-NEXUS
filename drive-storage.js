// ============================================================
// SocialNexus — Google Drive media storage
//
// Heavy files (photos, videos, voice notes, story media) are uploaded to the
// LOGGED-IN USER'S OWN Google Drive (folder "SocialNexus"), made "anyone with
// the link can view", and only the resulting URL is saved in Supabase. That
// moves almost all storage + bandwidth off Supabase.
//
// Scope used: drive.file  (the app can only see files IT created — never the
// rest of the user's Drive). It is a non-sensitive scope, so no Google
// verification review is needed.
//
// If GOOGLE_CLIENT_ID is empty, or the user has not connected Drive, or Drive
// fails for any reason, app.js silently falls back to Supabase Storage, so
// nothing breaks.
// ============================================================
(function () {
    const SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const FOLDER_NAME = 'SocialNexus';
    const LS_CONNECTED = 'nexus_drive_connected';
    const LS_FOLDER = 'nexus_drive_folder_id';

    let tokenClient = null;
    let accessToken = null;
    let tokenExpiresAt = 0;
    let folderId = null;
    let pendingTokenResolve = null;
    let pendingTokenReject = null;

    function clientId() {
        return (typeof GOOGLE_CLIENT_ID !== 'undefined' && GOOGLE_CLIENT_ID) ? GOOGLE_CLIENT_ID : '';
    }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

    function isEnabled() { return !!clientId(); }
    function hasValidToken() { return !!accessToken && Date.now() < tokenExpiresAt - 30000; }
    function wasConnected() { return lsGet(LS_CONNECTED) === '1'; }

    async function loadGis(allowAsk) {
        // The Google sign-in script is optional: it only loads if the user agreed in the consent banner.
        if (window.NexusConsent && !NexusConsent.has('google')) {
            if (!allowAsk) throw new Error('Google sign-in was not allowed in your cookie settings');
            const ok = await NexusConsent.ask('google');
            if (!ok) throw new Error('Google sign-in was not allowed in your cookie settings');
        }
        return new Promise((resolve, reject) => {
            if (window.google && google.accounts && google.accounts.oauth2) return resolve();
            const existing = document.getElementById('gisScript');
            if (existing) { existing.addEventListener('load', () => resolve()); existing.addEventListener('error', reject); return; }
            const s = document.createElement('script');
            s.id = 'gisScript';
            s.src = 'https://accounts.google.com/gsi/client';
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Could not load Google sign-in'));
            document.head.appendChild(s);
        });
    }

    async function initTokenClient(allowAsk) {
        if (tokenClient) return tokenClient;
        await loadGis(allowAsk);
        const hint = lsGet('nexus_google_email'); // known after "Continue with Google": skips the account chooser
        tokenClient = google.accounts.oauth2.initTokenClient(Object.assign({
            client_id: clientId(),
            scope: SCOPE,
            callback: (resp) => {
                if (resp && resp.access_token) {
                    accessToken = resp.access_token;
                    tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3600) * 1000);
                    lsSet(LS_CONNECTED, '1');
                    scheduleRefresh();
                    if (pendingTokenResolve) pendingTokenResolve(accessToken);
                } else if (pendingTokenReject) {
                    pendingTokenReject(new Error((resp && resp.error) || 'Google authorization failed'));
                }
                pendingTokenResolve = pendingTokenReject = null;
            },
            error_callback: (err) => {
                if (pendingTokenReject) pendingTokenReject(new Error((err && err.type) || 'Google popup closed'));
                pendingTokenResolve = pendingTokenReject = null;
            }
        }, hint ? { hint } : {}));
        return tokenClient;
    }

    function requestToken(prompt, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (pendingTokenReject === wrappedReject) { pendingTokenReject(new Error('Google authorization timed out')); pendingTokenResolve = pendingTokenReject = null; }
            }, timeoutMs);
            const wrappedResolve = (v) => { clearTimeout(timer); resolve(v); };
            const wrappedReject = (e) => { clearTimeout(timer); reject(e); };
            pendingTokenResolve = wrappedResolve;
            pendingTokenReject = wrappedReject;
            tokenClient.requestAccessToken({ prompt });
        });
    }

    // Google asks for permission only ONCE (the first "Connect"). After that this gets a fresh
    // access token silently (prompt:'none' = no popup, no consent screen) whenever the old one
    // is about to expire. Only if Google really needs the person (e.g. signed out of Google)
    // does a click on the button bring up a popup again.
    // interactive=true must be called from a click handler (it may open Google's popup).
    async function ensureToken(interactive) {
        if (!isEnabled()) throw new Error('Google Drive is not configured');
        if (hasValidToken()) return accessToken;
        await initTokenClient(!!interactive);
        // Button tap: go straight to Google (no 'none' try first — waiting for it would use up the
        // tap and the browser would then block the real popup). Google only shows a screen if it must.
        if (interactive) return requestToken(wasConnected() ? '' : 'consent', 60000);
        // Not a tap (e.g. uploading): only a quiet refresh, and only for people who connected before.
        if (wasConnected()) return requestToken('none', 8000);
        throw new Error('Google Drive is not connected');
    }

    // No background timers: browsers block Google's popup when it is opened without a tap and show a
    // "popup blocked" notice. A fresh token is taken quietly at the moment you post something
    // (that is a tap), or when you press the Drive button.
    function scheduleRefresh() {}
    async function silentRefresh() {
        if (!isEnabled() || !wasConnected()) return false;
        try { await initTokenClient(false); await requestToken('none', 8000); return true; }
        catch (e) { return false; }
    }

    async function driveFetch(url, options) {
        const token = await ensureToken(false);
        const res = await fetch(url, Object.assign({}, options, {
            headers: Object.assign({}, (options && options.headers) || {}, { Authorization: 'Bearer ' + token })
        }));
        return res;
    }

    async function getFolderId() {
        if (folderId) return folderId;
        const cached = lsGet(LS_FOLDER);
        if (cached) { folderId = cached; return folderId; }
        const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const find = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`);
        if (find.ok) {
            const j = await find.json();
            if (j.files && j.files[0]) { folderId = j.files[0].id; lsSet(LS_FOLDER, folderId); return folderId; }
        }
        const create = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
        });
        if (!create.ok) throw new Error('Could not create Drive folder (' + create.status + ')');
        folderId = (await create.json()).id;
        lsSet(LS_FOLDER, folderId);
        return folderId;
    }

    // Public URL that works directly inside <img>, <video> and <audio>.
    // Videos/audio URLs deliberately END in the file extension, because app.js
    // detects video by `/\.(mp4|mov|webm)$/` on the URL.
    function urlFor(id, mime, fileName) {
        if (mime && mime.startsWith('image/')) return `https://lh3.googleusercontent.com/d/${id}`;
        const extMatch = /\.([a-zA-Z0-9]{2,5})$/.exec(fileName || '');
        const ext = extMatch ? extMatch[1].toLowerCase() : (mime && mime.startsWith('video/') ? 'mp4' : mime && mime.startsWith('audio/') ? 'webm' : 'bin');
        return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t&nexus=f.${ext}`;
    }

    function putWithProgress(location, blob, mime, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', location, true);
            xhr.setRequestHeader('Content-Type', mime);
            xhr.upload.onprogress = (evt) => {
                if (evt.lengthComputable && onProgress) onProgress(Math.round((evt.loaded / evt.total) * 100));
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error('Bad Drive response')); }
                } else reject(new Error('Drive upload failed: ' + xhr.status));
            };
            xhr.onerror = () => reject(new Error('Network error during Drive upload'));
            xhr.send(blob);
        });
    }

    // Uploads a File/Blob, makes it link-viewable, returns the public URL.
    async function upload(fileName, blob, opts) {
        opts = opts || {};
        const mime = opts.contentType || blob.type || 'application/octet-stream';
        const token = await ensureToken(false);
        let parent = await getFolderId();

        const start = async () => fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,mimeType', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': mime,
                'X-Upload-Content-Length': String(blob.size)
            },
            body: JSON.stringify({ name: fileName, parents: [parent] })
        });

        let init = await start();
        if (init.status === 404) { // cached folder was deleted by the user — recreate it
            lsDel(LS_FOLDER); folderId = null; parent = await getFolderId(); init = await start();
        }
        if (!init.ok) throw new Error('Drive upload could not start (' + init.status + ')');
        const location = init.headers.get('Location');
        if (!location) throw new Error('Drive did not return an upload location');

        const file = await putWithProgress(location, blob, mime, opts.onProgress);

        const perm = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'reader', type: 'anyone' })
        });
        if (!perm.ok) throw new Error('Could not make Drive file viewable (' + perm.status + ')');

        return urlFor(file.id, mime, fileName);
    }

    // ---- Small floating button (shown only after login, only when configured) ----
    function loggedIn() { try { return typeof currentUser !== 'undefined' && !!currentUser; } catch (e) { return false; } }

    function paintButton(btn) {
        if (!isEnabled() || !loggedIn()) { btn.style.display = 'none'; return; }
        btn.style.display = 'flex';
        const on = hasValidToken();
        btn.innerHTML = (on || wasConnected())
            ? '<span style="color:#34d399">●</span>&nbsp;Drive on'
            : '<span style="color:#fbbf24">☁</span>&nbsp;Connect Google Drive';
        btn.title = on ? 'Your photos/videos are saved to your own Google Drive (SocialNexus folder)'
                       : 'Save your photos/videos to your own Google Drive to keep the app fast';
    }

    function mountButton() {
        if (!isEnabled() || document.getElementById('driveConnectBtn')) return;
        const btn = document.createElement('button');
        btn.id = 'driveConnectBtn';
        btn.type = 'button';
        btn.style.cssText = 'position:fixed;left:12px;bottom:76px;z-index:60;display:none;align-items:center;' +
            'padding:6px 12px;border-radius:999px;font-size:11px;font-weight:600;color:#e2e8f0;' +
            'background:rgba(15,23,42,.92);border:1px solid rgba(148,163,184,.35);cursor:pointer;' +
            'box-shadow:0 4px 14px rgba(0,0,0,.35);backdrop-filter:blur(6px)';
        btn.onclick = async () => {
            try { await ensureToken(true); await getFolderId(); }
            catch (e) { alert('Google Drive connect nahi ho paya: ' + (e && e.message ? e.message : e)); }
            paintButton(btn);
        };
        document.body.appendChild(btn);
        paintButton(btn);
        setInterval(() => paintButton(btn), 3000); // cheap, local only
    }

    window.DriveStore = {
        isEnabled,
        isReady: () => isEnabled() && hasValidToken(),
        silentRefresh,
        isConnectedBefore: wasConnected,
        connect: () => ensureToken(true),
        // Silent token refresh for people who already connected before (no UI unless Google needs it).
        tryReady: async () => {
            try {
                await Promise.race([ensureToken(false), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))]);
                return hasValidToken();
            } catch (e) { return false; }
        },
        upload,
        mountButton,
        disconnect: () => {
            try { if (accessToken && window.google) google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
            accessToken = null; tokenExpiresAt = 0; folderId = null;
            lsDel(LS_CONNECTED); lsDel(LS_FOLDER);
        }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountButton);
    else mountButton();

})();
