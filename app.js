        
        /*
          ============================================================================
          REQUIRED SUPABASE SQL — run security_migration.sql ONCE in the Supabase SQL
          editor. It moves password/PIN/security-answer hashing entirely server-side
          (bcrypt via pgcrypto, in a locked-down profile_secrets table) so no hash is
          ever sent to a browser, and it gates the admin "verify" action behind a real
          admin PIN check. See that file for full details of what it does.
          ============================================================================
        */

        // NOTE: sha256Hex is kept only for any leftover non-auth uses elsewhere in the
        // app (it is no longer used for passwords/PINs/security answers — those are
        // now hashed with bcrypt inside Postgres via the rpc_* functions below).
        async function sha256Hex(text) {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        let currentUser = localStorage.getItem('nexus_user') || null;
        let pendingLoginUsername = null; // set once password is verified but 2FA PIN is still pending
        let pendingLoginPassword = null; // kept alongside pendingLoginUsername only to finish the real Auth link after 2FA
        let pendingSwitchPassword = null; // same, for the account-switch verify flow

        // ===== REAL SUPABASE AUTH SESSION LINK =====
        // rpc_login/rpc_signup already verify the password (bcrypt, server-side) but that alone
        // never gives Postgres a real auth.uid() — so RLS can't tell who's actually asking, and
        // private-account/block/message-request checks were only ever enforced in this browser's
        // JS, which anyone can skip by calling the Supabase REST API directly with the anon key.
        // This links every login/signup to a real Supabase Auth session (via a synthetic
        // per-username email) so `security_migration_auth.sql`'s RLS policies can check
        // auth.uid() for real. See that file for the DB side of this.
        async function ensureAuthSession(username, password) {
            const email = `${username.toLowerCase()}@nexus.internal`;
            let haveSession = false;
            try {
                const { error: signInErr } = await supabaseClient.auth.signInWithPassword({ email, password });
                haveSession = !signInErr;
            } catch (e) { /* fall through and try to create the Auth account below */ }

            if (!haveSession) {
                try {
                    const { error: signUpErr } = await supabaseClient.auth.signUp({ email, password });
                    if (signUpErr) {
                        console.warn('Nexus: could not create Auth session (run security_migration_auth.sql):', signUpErr);
                        return false;
                    }
                    haveSession = true;
                } catch (e) {
                    console.warn('Nexus: ensureAuthSession failed:', e);
                    return false;
                }
            }

            // IMPORTANT: always confirm the profile is actually linked, even when
            // signInWithPassword just succeeded on its own — if a PREVIOUS login's
            // link step ever failed silently (network blip, etc.), the Auth account
            // still exists and signs in fine forever after, but profiles.auth_user_id
            // stays null, which quietly breaks every write for that user. Checking
            // every time (rpc_link_auth_user is a safe no-op once already linked)
            // means that can't happen again.
            try {
                const { data: linkResult, error: linkErr } = await supabaseClient.rpc('rpc_link_auth_user', { p_username: username, p_password: password });
                if (linkErr || !linkResult || !linkResult.ok) {
                    // 'already_linked_or_missing' just means it was linked already — fine.
                    if (linkResult && linkResult.error !== 'already_linked_or_missing') {
                        console.warn('Nexus: rpc_link_auth_user did not confirm a link:', linkErr || linkResult);
                    }
                }
            } catch (e) {
                console.warn('Nexus: rpc_link_auth_user call failed:', e);
            }
            return true;
        }
        // ===== FEATURE: MULTI-ACCOUNT SWITCH =====
        // Saved accounts list persists independently of which one is "active" (nexus_user),
        // so switching between accounts on the same device doesn't require re-typing anything.
        function getSavedAccounts() {
            try { return JSON.parse(localStorage.getItem('nexus_saved_accounts') || '[]'); }
            catch (e) { return []; }
        }
        function persistSavedAccounts(list) {
            localStorage.setItem('nexus_saved_accounts', JSON.stringify([...new Set(list)]));
        }
        function addSavedAccount(username) {
            if (!username) return;
            const list = getSavedAccounts();
            if (!list.includes(username)) {
                list.push(username);
                persistSavedAccounts(list);
            }
        }
        function removeSavedAccount(username) {
            persistSavedAccounts(getSavedAccounts().filter(u => u !== username));
            if (localStorage.getItem('nexus_previous_user') === username) localStorage.removeItem('nexus_previous_user');
            renderAccountSwitcherList();
        }
        let activeChatUser = localStorage.getItem('nexus_active_chat') || null;
        let currentTab = localStorage.getItem('nexus_tab') || 'feed';
        if (currentTab === 'ai') currentTab = 'feed'; // the AI tab no longer exists
        let messagePollingInterval = null;
        let selectedFileObject = null;
        let selectedFileObjects = []; // FEATURE: MULTI-IMAGE CAROUSEL POSTS — holds all files chosen for the current post
        let selectedChatMediaObject = null;
        let cachedAllUsers = [];
        let globalPostsCache = [];
        let globalProfilesCache = {};
        let globalProfilesFullCache = {}; // username -> full profile row (adds is_private support)
        let closeFriendsCache = new Set(); // FEATURE: CLOSE FRIENDS — usernames *this* user has marked as close friends
        let closeFriendsFeatureAvailable = true;

        // FEATURE: PROFILE FLIP — flips the profile card to reveal the extra features panel.
        let profileFlipped = false;

        // FEATURE: MULTI-PERSONA IDENTITY — one account, 3 independently-followable "faces"
        // (Post-persona, Twit-persona, Channel-persona), each with its own tone + bio.
        // Reuses the existing post "platform" field (Instagram/Twitter/Telegram) as the persona map.
        const PERSONAS = [
            { key: 'post', label: 'Post-Persona', emoji: '📸', platform: 'Instagram', color: '#3b82f6' },
            { key: 'twit', label: 'Twit-Persona', emoji: '🐦', platform: 'Twitter', color: '#38bdf8' },
            { key: 'channel', label: 'Channel-Persona', emoji: '📢', platform: 'Telegram', color: '#14b8a6' }
        ];
        const PERSONA_TONE_PRESETS = ['Chill 😎', 'Funny 😂', 'Professional 💼', 'Aesthetic ✨', 'Motivational 🔥', 'Savage 😈', 'Wholesome 🌸'];
        function personaForKey(key) { return PERSONAS.find(p => p.key === key) || PERSONAS[0]; }
        function personaKeyForPlatform(platform) {
            const p = PERSONAS.find(p => p.platform === platform);
            return p ? p.key : 'post'; // Reels/anything else default to the Post-persona face
        }
        let personaFollowAvailable = true; // flips to false if follows/follow_requests.persona column isn't set up yet
        let ghostModeEnabled = localStorage.getItem('nexus_ghost_mode') === '1'; // FEATURE: GHOST MODE — purely local, no read receipts/view tracking while on
        let reelSoundMuted = localStorage.getItem('nexus_reel_muted') !== '0';
        let globalFollowsCache = [];
        let globalLikesCache = [];
        let globalCommentsCache = [];
        // PERF: the 'public:all_changes' realtime channel used to fire on every insert/update/
        // delete across the WHOLE app (any user, any table) and each one triggered an immediate
        // ~20-query fetchAllData() + full feed/reels/stories rebuild — that's what made scrolling
        // feel janky and made your own like/follow taps feel delayed (someone else's activity
        // would repaint the feed under your finger mid-scroll/mid-tap). It's now scoped to only
        // the tables that affect the shared feed/badges (see where it's subscribed, below), and
        // on top of that these still collapse bursts of that activity into one refresh and defer
        // it while you're actively scrolling.
        let allChangesRefreshTimer = null;
        let isFeedScrolling = false;
        let feedScrollEndTimer = null;
        let viewingProfileUsername = null;
        let profileActiveTab = 'posts';
        let activeModalPostId = null;
        let cropper = null;
        // FEATURE: GROUP DP — the same cropper modal is reused for both profile pictures and
        // group photos. cropperTarget tells cropAndUploadImage() which record to update, and
        // cropperTargetGroupId remembers which group when target === 'group'.
        let cropperTarget = 'profile';
        let cropperTargetGroupId = null;

        // Online/Offline Presence, Typing Indicator & Reply-to-Message states
        let onlineUsersSet = new Set();
        let presenceChannel = null;
        let typingSendChannel = null;
        let typingReceiveChannel = null;
        let typingHideTimeout = null;
        let lastTypingSentAt = 0;
        let replyingToMessage = null; // { id, sender, text }
        let currentChatMessagesMap = {};

        // ---- NEW FEATURE STATE: Stories, Groups, Explore, Reactions, Disappearing Messages ----
        let globalStoriesCache = [];
        let globalStoryViewsCache = [];
        let storyQueue = []; // ordered list of stories for the user currently being viewed
        let storyQueueIndex = 0;
        let storyProgressTimer = null;
        let storyProgressStart = 0;
        const STORY_DURATION_MS = 5000;
        let selectedStoryFileObject = null;

        let globalGroupsCache = [];
        let globalGroupMembersCache = [];
        let globalGroupMessagesCache = [];
        let activeGroupId = null;
        let selectedGroupMediaObject = null;
        let groupMessagesChannel = null;

        let globalReactionsCache = [];
        let activeReactionMsgId = null;
        let activeReactionSource = 'dm'; // 'dm' or 'group'

        let disappearingChatsSet = new Set(JSON.parse(localStorage.getItem('nexus_disappearing_chats') || '[]'));

        // ---- NEW FEATURE STATE: Nested Comments, Msg Edit, Voice Notes, Search, Suggested Users, Block/Report, Private Accounts, Theme, Analytics ----
        let globalCommentLikesCache = [];
        let globalBlockedCache = [];
        let globalFollowRequestsCache = [];
        // FEATURE: PRIVATE GROUPS/CHANNELS — join requests for private groups awaiting admin approval
        let globalGroupJoinRequestsCache = [];
        let newGroupIsPrivate = false; // selected privacy for the group currently being created
        let newGroupSelectedMembers = new Set(); // survives the member-search filter re-render
        let addGroupMembersSelected = new Set(); // selection for "Add Members" inside an existing group
        let globalPostViewsCache = [];
        let globalMessageRequestsCache = []; // FEATURE: MESSAGE REQUESTS — private account DM gate
        let replyingToCommentId = null;

        // FEATURE: SAVE POST/REEL (bookmark) — optional table; no-ops quietly until the SQL setup is run
        let globalSavedPostsCache = [];
        let savedPostsFeatureAvailable = true;

        // FEATURE: MY ACTIVITY (Likes / Comments / Save / Search History) + BLOCKED USERS PAGE
        let activityListMode = null; // 'likes' | 'comments' | 'saved' | 'search' | 'blocked'
        let searchHistoryCache = []; // fetched on-demand when the Search History page opens
        let searchHistoryFeatureAvailable = true;
        let searchHistoryLogTimer = null;
        let editingMessageId = null;
        let voiceMediaRecorder = null;
        let voiceRecordedChunks = [];
        let isRecordingVoice = false;
        let activeBlockReportUsername = null;
        let trackedPostViewIds = new Set();

        // Mesh group audio call state
        let groupCallPeers = {}; // username -> RTCPeerConnection
        let groupCallLocalStream = null;
        let groupCallId = null;
        let groupCallMembers = [];
        let isGroupCallMuted = false;
        let groupCallSignalChannel = null;

        // Snapshots used to detect "new" items since last fetch, purely for background notifications
        let prevLikesCount = {};
        let prevCommentsCount = {};
        let prevFollowersCount = {};
        let notificationsBaselineSet = false;

        let swRegistration = null;

        // True WebRTC Signaling Calling States
        let activeCallStream = null;
        let peerConnection = null;
        let incomingCallData = null;
        let targetCallingUser = null;
        let isCallMuted = false;
        let isCameraOff = false;
        let currentFacingMode = 'user';
        let isEarpieceAudio = false;
        let callNoAnswerTimeout = null;

        // NOTE: Added TURN servers below. A STUN-only config fails to connect calls
        // whenever both devices are behind NAT/mobile-data networks (very common) —
        // this was the main reason calls rang but never actually connected.
        const rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
                { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
                { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
            ]
        };
        // Queue for ICE candidates that arrive before the peerConnection (or its
        // remote description) is ready, so they no longer get silently dropped.
        let pendingIceCandidates = [];
        let callAnswerChannel = null;

        window.addEventListener('DOMContentLoaded', () => {
            applyAllSavedPageCustomizations(); // FEATURE: PAGE CUSTOMIZATION — restore saved accents (incl. Feed, which shows before any tab switch)

            // PERF: mark the feed as "actively scrolling" so a background realtime refresh
            // (see scheduleGlobalDataRefresh) waits until scrolling settles instead of rebuilding
            // the feed DOM out from under a finger/mouse mid-scroll.
            const feedScrollEl = document.getElementById('section-feed');
            if (feedScrollEl) {
                feedScrollEl.addEventListener('scroll', () => {
                    isFeedScrolling = true;
                    clearTimeout(feedScrollEndTimer);
                    feedScrollEndTimer = setTimeout(() => { isFeedScrolling = false; }, 200);
                }, { passive: true });
            }

            // Register Service Worker, then ask for Notification permission, then subscribe
            // this device to real Web Push. This is what makes notifications keep arriving
            // even when the app/browser is completely closed (like Instagram/WhatsApp) —
            // not just while this tab is open in the background.
            if ("serviceWorker" in navigator) {
                navigator.serviceWorker.register('sw.js').then(reg => {
                    swRegistration = reg;
                    if (!("Notification" in window)) return;
                    if (Notification.permission === "granted") {
                        if (currentUser) setupPushNotifications(currentUser);
                    } else if (Notification.permission !== "denied") {
                        Notification.requestPermission().then(permission => {
                            if (permission === "granted" && currentUser) setupPushNotifications(currentUser);
                        });
                    }
                }).catch(err => console.warn("Service worker registration failed:", err));
            }

            if (currentUser) {
                initApp(currentUser);
            }

            // ===== FEATURE: LOGIN / SIGNUP TABS =====
            function switchAuthTab(tab) {
                const loginBtn = document.getElementById('authTabLoginBtn');
                const signupBtn = document.getElementById('authTabSignupBtn');
                const loginForm = document.getElementById('loginForm');
                const signupForm = document.getElementById('signupForm');
                const twoFaForm = document.getElementById('login2faForm');
                twoFaForm.classList.add('hidden');
                pendingLoginUsername = null;
                if (tab === 'signup') {
                    signupForm.classList.remove('hidden');
                    loginForm.classList.add('hidden');
                    signupBtn.className = 'flex-1 py-1.5 rounded-lg transition bg-[#2563eb] text-white';
                    loginBtn.className = 'flex-1 py-1.5 rounded-lg transition text-slate-400';
                } else {
                    loginForm.classList.remove('hidden');
                    signupForm.classList.add('hidden');
                    loginBtn.className = 'flex-1 py-1.5 rounded-lg transition bg-[#2563eb] text-white';
                    signupBtn.className = 'flex-1 py-1.5 rounded-lg transition text-slate-400';
                }
            }
            window.switchAuthTab = switchAuthTab;

            // ===== FEATURE: REAL LOGIN (username + user-set password, + 2FA if enabled) =====
            document.getElementById('loginForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const username = document.getElementById('loginUsername').value.trim();
                const password = document.getElementById('loginPassword').value;
                const errorEl = document.getElementById('loginError');
                const submitBtn = document.getElementById('loginSubmitBtn');
                errorEl.classList.add('hidden');

                if (!username || !password) return;
                submitBtn.disabled = true;

                try {
                    // SECURITY: password check now happens inside Postgres (rpc_login) — the
                    // hash never leaves the database, and it never travels to this browser.
                    const { data: result, error } = await supabaseClient.rpc('rpc_login', { p_username: username, p_password: password });

                    if (error) {
                        console.error('Login error:', error);
                        showAlertBanner('Login SQL setup abhi baaki hai — security_migration.sql ko Supabase me run karo.', 'warning');
                        return;
                    }

                    if (!result.ok) {
                        if (result.error === 'locked') {
                            errorEl.innerText = 'Bahut saare galat attempts — 5 minute ke liye account lock hai.';
                        } else if (result.error === 'no_user') {
                            errorEl.innerText = 'Ye username exist nahi karta — pehle Sign Up karo.';
                        } else if (result.error === 'no_password') {
                            errorEl.innerText = 'Is account ke liye password set nahi hai — Sign Up flow se dobara account banao ya admin se contact karo.';
                        } else {
                            errorEl.innerText = 'Incorrect username ya password!';
                        }
                        errorEl.classList.remove('hidden');
                        return;
                    }

                    if (result.needs_2fa) {
                        // Password sahi hai — ab 2FA PIN maango, tabhi login complete hoga.
                        pendingLoginUsername = username;
                        pendingLoginPassword = password;
                        document.getElementById('loginForm').classList.add('hidden');
                        document.getElementById('login2faForm').classList.remove('hidden');
                        document.getElementById('login2faError').classList.add('hidden');
                        document.getElementById('login2faPin').value = '';
                        document.getElementById('login2faPin').focus();
                        return;
                    }

                    await completeLogin(username, password);
                } finally {
                    submitBtn.disabled = false;
                }
            });

            document.getElementById('login2faForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const pin = document.getElementById('login2faPin').value.trim();
                const errEl = document.getElementById('login2faError');
                if (!pendingLoginUsername || !pin) return;

                const { data: result } = await supabaseClient.rpc('rpc_verify_2fa', { p_username: pendingLoginUsername, p_pin: pin });
                if (!result || !result.ok) {
                    errEl.innerText = 'Galat PIN!';
                    errEl.classList.remove('hidden');
                    return;
                }

                const u = pendingLoginUsername;
                const p = pendingLoginPassword;
                pendingLoginUsername = null;
                pendingLoginPassword = null;
                await completeLogin(u, p);
            });

            function cancelLogin2fa() {
                pendingLoginUsername = null;
                pendingLoginPassword = null;
                document.getElementById('login2faForm').classList.add('hidden');
                document.getElementById('loginForm').classList.remove('hidden');
            }
            window.cancelLogin2fa = cancelLogin2fa;

            async function completeLogin(username, password) {
                await ensureAuthSession(username, password);
                activateAccount(username);
            }

            // ===== FEATURE: SIGN UP — real per-user password + mandatory 2FA + security question =====
            document.getElementById('signupForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const username = document.getElementById('signupUsername').value.trim();
                const password = document.getElementById('signupPassword').value;
                const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
                const pin = document.getElementById('signupTwoFaPin').value.trim();
                const question = document.getElementById('signupSecurityQuestion').value;
                const answer = document.getElementById('signupSecurityAnswer').value.trim();
                const errEl = document.getElementById('signupError');
                const submitBtn = document.getElementById('signupSubmitBtn');
                errEl.classList.add('hidden');

                if (!username || !password || !pin || !question || !answer) {
                    errEl.innerText = 'Sab fields fill karna zaroori hai (2FA PIN aur security question bhi).';
                    errEl.classList.remove('hidden');
                    return;
                }
                if (password !== passwordConfirm) {
                    errEl.innerText = 'Passwords match nahi kar rahe.';
                    errEl.classList.remove('hidden');
                    return;
                }
                if (password.length < 4) {
                    errEl.innerText = 'Password kam se kam 4 characters ka ho.';
                    errEl.classList.remove('hidden');
                    return;
                }
                if (!/^\d{4,6}$/.test(pin)) {
                    errEl.innerText = '2FA PIN sirf 4-6 digits ka hona chahiye.';
                    errEl.classList.remove('hidden');
                    return;
                }

                submitBtn.disabled = true;
                try {
                    // SECURITY: password/PIN/answer are hashed with bcrypt INSIDE Postgres by
                    // rpc_signup — the raw values are sent once over HTTPS to create the
                    // account, but the resulting hashes are never read back to any browser.
                    const { data: result, error } = await supabaseClient.rpc('rpc_signup', {
                        p_username: username, p_password: password, p_pin: pin,
                        p_question: question, p_answer: answer
                    });

                    if (error) {
                        console.error('Signup error:', error);
                        errEl.innerText = 'Account create nahi ho paaya — security_migration.sql ko Supabase me run karo (upar comment dekho).';
                        errEl.classList.remove('hidden');
                        return;
                    }
                    if (!result.ok) {
                        errEl.innerText = result.error === 'username_taken' ? 'Ye username pehle se liya ja chuka hai.' : 'Account create nahi ho paaya.';
                        errEl.classList.remove('hidden');
                        return;
                    }

                    showAlertBanner('Account ban gaya! 2FA already on hai.', 'success');
                    await completeLogin(username, password);
                } finally {
                    submitBtn.disabled = false;
                }
            });

            document.getElementById('postForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const platform = 'Instagram'; // Channel option removed — this composer is Post-only now
                const content = document.getElementById('postContentInput').value.trim();
                if (!content) return;

                let finalImageUrl = null;
                let finalMediaUrls = null; // FEATURE: MULTI-IMAGE CAROUSEL POSTS
                const publishBtn = document.getElementById('publishBtn');
                const statusText = document.getElementById('uploadStatusText');

                if (selectedFileObjects.length > 0) {
                    publishBtn.disabled = true;
                    statusText.classList.remove('hidden');

                    try {
                        // Upload every selected image, in order, and collect their public URLs.
                        const uploadedUrls = [];
                        for (const fileObj of selectedFileObjects) {
                            const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${fileObj.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                            const up = await uploadMediaFile(fileName, fileObj);
                            if (!up.error) uploadedUrls.push(up.url);
                        }

                        if (uploadedUrls.length > 0) {
                            finalImageUrl = uploadedUrls[0]; // kept for backward-compat with existing single-image code paths (e.g. Reels detection)
                            finalMediaUrls = uploadedUrls;   // full ordered set — carousel renders from this when there's more than one
                        }
                    } catch (err) {
                        console.error(err);
                    }

                    publishBtn.disabled = false;
                    statusText.classList.add('hidden');
                }

                const { error: postInsertError } = await supabaseClient.from('posts').insert({
                    username: currentUser,
                    platform,
                    content,
                    image_url: finalImageUrl,
                    media_urls: finalMediaUrls,
                    likes_count: 0
                });

                if (postInsertError) {
                    console.error('Post insert failed:', postInsertError);
                    showAlertBanner('Post save nahi hua: ' + postInsertError.message, 'error');
                    return;
                }

                document.getElementById('postContentInput').value = '';
                const fileInput = document.getElementById('postImageFile');
                if(fileInput) fileInput.value = '';
                document.getElementById('fileChosenLabel').innerText = 'Select Photo(s)';
                selectedFileObject = null;
                selectedFileObjects = [];
                fetchAllData();
            });

            // FEATURE: TWIT COMPOSER — fully separate submit flow from the Post composer.
            // Always platform 'Twitter', text-only, no image upload.
            document.getElementById('twitForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const twitInput = document.getElementById('twitContentInput');
                const content = twitInput.value.trim();
                if (!content) return;

                const { error: twitInsertError } = await supabaseClient.from('posts').insert({
                    username: currentUser,
                    platform: 'Twitter',
                    content,
                    image_url: null,
                    media_urls: null,
                    likes_count: 0
                });

                if (twitInsertError) {
                    console.error('Twit insert failed:', twitInsertError);
                    showAlertBanner('Twit save nahi hua: ' + twitInsertError.message, 'error');
                    return;
                }

                twitInput.value = '';
                updateTwitCharCount();
                fetchAllData();
            });

            document.getElementById('chatForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                if (!activeChatUser) return;
                const text = document.getElementById('chatInputText').value.trim();
                if (!text && !selectedChatMediaObject) return;

                // FEATURE: MESSAGE REQUESTS — private account gate; may create a pending request
                const okToSend = await ensureMessageRequestForSend(activeChatUser);
                if (!okToSend) return;

                // FEATURE FIX: OPTIMISTIC SEND — clear the input and show the message as
                // "Sending..." immediately instead of waiting on the network round trip.
                // If the network is slow/offline, the bubble stays marked pending/failed
                // and is auto-retried once connectivity returns (see retryAllPendingMessages).
                const tempId = 'pending_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                const pendingObj = {
                    tempId,
                    receiver: activeChatUser,
                    text: text || (selectedChatMediaObject ? '[Media Attachment]' : ''),
                    mediaFile: selectedChatMediaObject,
                    mediaPreviewUrl: selectedChatMediaObject ? URL.createObjectURL(selectedChatMediaObject) : null,
                    replyingToMessage: replyingToMessage,
                    disappearing: disappearingChatsSet.has(activeChatUser),
                    status: 'sending',
                    createdAt: new Date().toISOString()
                };
                if (!pendingMessages[activeChatUser]) pendingMessages[activeChatUser] = [];
                pendingMessages[activeChatUser].push(pendingObj);

                document.getElementById('chatInputText').value = '';
                selectedChatMediaObject = null;
                document.getElementById('chatMediaFileInput').value = '';
                cancelReply();
                loadDirectMessages(activeChatUser, true);

                await attemptSendPendingMessage(activeChatUser, tempId);

                updateChatRequestUI(activeChatUser); // FEATURE: MESSAGE REQUESTS

                // FEATURE: AI AUTO-REPLY WHEN AWAY — if this chat partner has Away Mode on
                maybeTriggerAwayAutoReply(activeChatUser, text);
            });

            // Sends a real-time typing broadcast to the active chat partner as the user types
            document.getElementById('chatInputText').addEventListener('input', () => {
                if (activeChatUser) sendTypingBroadcast();
            });
        });

        // STORAGE: single entry point for every media upload. If the user connected Google
        // Drive (see drive-storage.js) the file goes to THEIR Drive and only the link is saved
        // in Supabase; otherwise (or if Drive fails) it falls back to Supabase Storage.
        async function driveAvailable() {
            if (!window.DriveStore || !DriveStore.isEnabled()) return false;
            if (DriveStore.isReady()) return true;
            // Google access tokens last ~1 hour; returning users get a fresh one silently.
            return DriveStore.isConnectedBefore() ? await DriveStore.tryReady() : false;
        }

        async function uploadMediaFile(fileName, file, opts = {}) {
            if (await driveAvailable()) {
                try {
                    const url = await DriveStore.upload(fileName, file, opts);
                    return { url, error: null, via: 'drive' };
                } catch (driveErr) {
                    console.warn('[Drive] upload failed, falling back to Supabase:', driveErr);
                }
            }
            const { error } = await supabaseClient.storage.from('media')
                .upload(fileName, file, opts.contentType ? { contentType: opts.contentType } : undefined);
            if (error) return { url: null, error, via: 'supabase' };
            const { data } = supabaseClient.storage.from('media').getPublicUrl(fileName);
            return { url: data.publicUrl, error: null, via: 'supabase' };
        }

        // PERF: chat/group photo attachments used to upload at whatever size the camera/gallery
        // gave them (often 3-5MB straight off a phone) — that's slow to send AND slow for
        // whoever opens that chat later to load. This downsizes any image attachment client-side
        // before it's sent, so both directions are lighter. Videos and GIFs are left completely
        // untouched (canvas can't safely re-encode either without breaking them), and if
        // anything about the compression step fails for any reason, it just falls back to the
        // original file — this never blocks or breaks sending.
        async function compressImageFile(file, maxDimension = 1600, quality = 0.75) {
            if (!file || !file.type || !file.type.startsWith('image/') || file.type === 'image/gif') {
                return file;
            }
            try {
                const bitmap = await createImageBitmap(file);
                const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
                if (scale >= 1) { if (bitmap.close) bitmap.close(); return file; } // already small enough
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(bitmap.width * scale);
                canvas.height = Math.round(bitmap.height * scale);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                if (bitmap.close) bitmap.close();
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
                if (!blob) return file;
                return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
            } catch (e) {
                console.warn('compressImageFile failed, sending original file instead:', e);
                return file;
            }
        }

        async function handleChatMediaSelect(input) {
            if (input.files && input.files[0]) {
                selectedChatMediaObject = await compressImageFile(input.files[0]);
                showAlertBanner(`Media attached: ${selectedChatMediaObject.name}. Now click send.`, 'info');
            }
        }

        // FEATURE: TWIT CHAR COUNTER — 280-char countdown for the separate Twit composer
        function updateTwitCharCount() {
            const input = document.getElementById('twitContentInput');
            const label = document.getElementById('twitCharCount');
            if (!input || !label) return;
            const remaining = 280 - input.value.length;
            label.innerText = remaining;
            label.className = remaining <= 20 ? 'text-[11px] text-red-400 font-bold' : 'text-[11px] text-slate-400';
        }
        window.updateTwitCharCount = updateTwitCharCount;

        function handleFileSelect(input) {
            if (input.files && input.files.length) {
                selectedFileObjects = Array.from(input.files);
                selectedFileObject = selectedFileObjects[0]; // kept in sync for any other code path
                document.getElementById('fileChosenLabel').innerText = selectedFileObjects.length > 1
                    ? `${selectedFileObjects.length} photos selected`
                    : selectedFileObjects[0].name;
            }
        }

        async function initApp(username) {
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('main-app').classList.remove('hidden');
            document.getElementById('displayUsername').innerText = username;
            addSavedAccount(username); // make sure this account shows up in the switcher
            renderGhostModeToggle();
            initOfflineMode(); // FEATURE: OFFLINE MODE
            initScreenshotAlert(); // FEATURE: SCREENSHOT ALERT
            applyLanguage(getSavedLanguage()); // FEATURE: MULTI-LANGUAGE UI
            renderReelMusicLibrary(); // FEATURE: MUSIC/SOUND LIBRARY

            // PERF: show something instantly instead of a blank feed while the real fetch runs
            paintCachedFeedInstantly();
            switchTab(currentTab);
            renderFeed();
            renderReels();

            await fetchAllData();
            cacheFeedForOffline(); // FEATURE: OFFLINE MODE — snapshot right after a good fetch
            switchTab(currentTab);
            checkDailyTwoFaReminder(); // FEATURE: DAILY 2FA REMINDER — once/day until 2FA is set up

            if (activeChatUser) {
                selectChatUser(activeChatUser, false);
            } else {
                loadLoggedUsers();
            }

            // Online/Offline Presence Tracking - marks this user online and listens for others
            presenceChannel = supabaseClient.channel('online-users', {
                config: { presence: { key: username } }
            });
            presenceChannel.on('presence', { event: 'sync' }, () => {
                const state = presenceChannel.presenceState();
                onlineUsersSet = new Set(Object.keys(state));
                updateOnlineStatusUI();
                if (cachedAllUsers.length) renderUsersList(cachedAllUsers);
            }).subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await presenceChannel.track({ online_at: new Date().toISOString() });
                }
            });

            // Real-Time Typing Indicator Listener - shows "typing..." when the active chat partner is typing
            typingReceiveChannel = supabaseClient.channel('typing_' + username);
            typingReceiveChannel.on('broadcast', { event: 'typing' }, (payload) => {
                const fromUser = payload.payload && payload.payload.from;
                if (fromUser && fromUser === activeChatUser) {
                    showTypingIndicator();
                }
            }).subscribe();

            // Real-time listener for incoming WebRTC call signals & candidates
            supabaseClient.channel('public:calls_' + username).on('postgres_changes', { 
                event: 'INSERT', 
                schema: 'public', 
                table: 'calls',
                filter: `callee_id=eq.${username}`
            }, async payload => {
                const callRecord = payload.new;
                if (callRecord && callRecord.status === 'offer') {
                    incomingCallData = callRecord;
                    document.getElementById('incomingCallerName').innerText = `${callRecord.caller_id} is calling...`;
                    document.getElementById('incomingCallTypeLabel').innerText = callRecord.call_type === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';
                    const av = globalProfilesCache[callRecord.caller_id];
                    document.getElementById('incomingCallerAvatar').innerHTML = av ? `<img src="${av}" class="w-full h-full object-cover">` : callRecord.caller_id.charAt(0).toUpperCase();
                    document.getElementById('incomingCallModal').classList.remove('hidden');
                } else if (callRecord && callRecord.status === 'ice') {
                    // BUGFIX: this channel is filtered on callee_id=eq.<me>, but BOTH sides of a
                    // call insert their own ICE rows with callee_id set to the callee's username —
                    // so when I'm the callee, my own outgoing ICE candidates used to loop straight
                    // back into this same handler and get added to my OWN peer connection as if
                    // they were the caller's. That silently corrupted my ICE agent's candidate
                    // pairing, which is why the callee's screen looked "connected" while the
                    // caller on the other end never actually received audio/video back. Every ICE
                    // insert now tags who sent it (see onicecandidate below) so we can skip our
                    // own echoes here.
                    if (callRecord.ice_candidates && callRecord.ice_candidates._from === currentUser) {
                        // it's our own candidate echoing back through our own filter — ignore it
                    } else if (peerConnection && peerConnection.remoteDescription) {
                        try {
                            await peerConnection.addIceCandidate(new RTCIceCandidate(callRecord.ice_candidates));
                        } catch(e) { console.error(e); }
                    } else {
                        // peerConnection not ready yet (call not accepted / offer not set) — queue it
                        pendingIceCandidates.push(callRecord.ice_candidates);
                    }
                } else if (callRecord && callRecord.status === 'group-invite') {
                    handleIncomingGroupInvite(callRecord);
                } else if (callRecord && callRecord.status === 'group-offer') {
                    handleIncomingGroupOffer(callRecord);
                } else if (callRecord && callRecord.status === 'group-answer') {
                    handleIncomingGroupAnswer(callRecord);
                } else if (callRecord && callRecord.status === 'group-ice') {
                    handleIncomingGroupIce(callRecord);
                } else if (callRecord && callRecord.status === 'end') {
                    // FIX: the other person hung up (or cancelled before we answered) — close
                    // our screen instead of leaving it stuck forever.
                    if (!document.getElementById('activeCallScreen').classList.contains('hidden')) {
                        document.getElementById('callStatusTimerText').innerText = 'Call Ended';
                        setTimeout(endCallUiOnly, 900);
                    } else {
                        endCallUiOnly();
                    }
                }
            }).subscribe((status, err) => {
                console.log('[incoming calls channel]', status, err || '');
            });

            // Realtime listener for new group text messages addressed to any group I'm in
            groupMessagesChannel = supabaseClient.channel('public:group_messages_all').on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'group_messages'
            }, payload => {
                const gm = payload.new;
                if (!gm) return;
                const myGroupIds = new Set(globalGroupMembersCache.filter(m => m.username === currentUser).map(m => m.group_id));
                if (!myGroupIds.has(gm.group_id)) return;

                if (activeGroupId === gm.group_id) {
                    loadGroupMessages(gm.group_id, true);
                } else if (gm.sender !== currentUser) {
                    const grp = globalGroupsCache.find(g => g.id === gm.group_id);
                    showAppNotification(`${grp ? grp.name : 'Group'}: ${gm.sender}`, gm.text || 'Sent an attachment', null, () => {
                        switchTab('groups');
                        openGroupChat(gm.group_id);
                    });
                }
                renderGroupsList();
            }).subscribe();

            // Real-Time Message Listener with Instant In-App Banner Pop-up, Chrome/System Background Notification & Chat List Reordering
            // PERF: widened from INSERT-only to '*' (INSERT/UPDATE/DELETE) so read receipts,
            // edits, and deletes on an open chat show up instantly via this same channel —
            // this is what lets us drop the old 2.5s poll down to a rare safety-net interval
            // instead of hitting the network every 2.5s the whole time a chat is open.
            supabaseClient.channel('public:messages_' + username).on('postgres_changes', { 
                event: '*', 
                schema: 'public', 
                table: 'messages',
                filter: `receiver=eq.${username}`
            }, payload => {
                const msg = payload.new || payload.old;
                if (!msg) return;

                // 1. If currently inside this chat room, refresh it (covers new messages,
                // the other person reading yours → blue ticks, and edits/deletes on theirs).
                if (activeChatUser && msg.sender === activeChatUser) {
                    loadDirectMessages(activeChatUser, payload.eventType === 'INSERT');
                }

                if (payload.eventType === 'INSERT') {
                    // 2. Trigger Real-Time Notification (In-App Banner Popup + System/Chrome Notification)
                    triggerNewMessageNotification(msg);
                }

                // 3. Reorder Chat Section list instantly so the sender's ID appears at the very top
                loadLoggedUsers();
            }).subscribe();

            supabaseClient.channel('public:messages_sent_' + username).on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'messages',
                filter: `sender=eq.${username}`
            }, payload => {
                const msg = payload.new || payload.old;
                // PERF: same widening as above — lets the currently-open chat pick up read
                // receipts (the OTHER person read a message I sent) and my own edits/deletes
                // without waiting for the poll.
                if (msg && activeChatUser && msg.receiver === activeChatUser) {
                    loadDirectMessages(activeChatUser, false);
                }
                loadLoggedUsers();
            }).subscribe();

            // PERF: this channel used to be `{ event: '*', schema: 'public' }` with no table
            // filter — meaning Postgres pushed EVERY insert/update/delete on EVERY table, from
            // EVERY user, to EVERY connected client, just so this one client could notice when
            // ITS OWN feed/badges might be stale. On a chat-heavy app that's mostly wasted
            // traffic: your own messages already have their own dedicated channel above, and
            // niche tables (reactions, saved posts, time capsules, typing, etc.) don't need an
            // instant cross-user refresh — they'll pick up on your next own action anyway. Now
            // scoped to just the tables that genuinely affect the shared feed/explore/badges,
            // so the server stops sending this client events it was always going to ignore.
            const globalRefreshHandler = (payload) => {
                scheduleGlobalDataRefresh();
            };
            let globalChangesChannel = supabaseClient.channel('public:all_changes');
            ['posts', 'post_likes', 'comments', 'follows', 'follow_requests', 'stories']
                .forEach(t => {
                    globalChangesChannel = globalChangesChannel.on('postgres_changes', { event: '*', schema: 'public', table: t }, globalRefreshHandler);
                });
            globalChangesChannel.subscribe();
        }

        // Notification System Handler (In-App Banner + Background Chrome/System Notification)
        function triggerNewMessageNotification(msg) {
            const senderId = msg.sender;
            const messageText = msg.text || 'Sent an attachment';

            // A. Display In-App Notification Banner Pop-Up
            const container = document.getElementById('inAppNotificationContainer');
            if (container) {
                const banner = document.createElement('div');
                banner.className = "pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border border-[#3b82f6]/40 rounded-2xl p-3 shadow-2xl flex items-center space-x-3 animate-slide-down cursor-pointer";
                const av = globalProfilesCache[senderId];
                banner.innerHTML = `
                    <div class="w-9 h-9 rounded-full bg-[#334155] flex items-center justify-center font-bold text-xs text-white shrink-0 overflow-hidden shadow">
                        ${av ? `<img src="${av}" class="w-full h-full object-cover">` : senderId.charAt(0).toUpperCase()}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between items-center">
                            <h4 class="text-xs font-bold text-white truncate">${senderId}</h4>
                            <span class="text-[11px] text-[#60a5fa] font-semibold">Just now</span>
                        </div>
                        <p class="text-[11px] text-slate-300 truncate">${messageText}</p>
                    </div>
                `;
                banner.onclick = () => {
                    banner.remove();
                    switchTab('chat');
                    selectChatUser(senderId, true);
                };
                container.appendChild(banner);

                // Automatically dismiss banner after 4 seconds
                setTimeout(() => {
                    if (banner.parentNode) banner.remove();
                }, 4000);
            }

            // B. Display Background Chrome/System Notification (works even if Chrome is minimized or in background)
            showAppNotification(`New message from ${senderId}`, messageText, globalProfilesCache[senderId], () => {
                switchTab('chat');
                selectChatUser(senderId, true);
            });

            // C. FEATURE: CUSTOM NOTIFICATION SOUNDS
            playNotificationSound();
        }

        // Generic notification dispatcher: prefers the Service Worker (more reliable in background
        // tabs / installed PWAs), falls back to the plain Notification API.
        // Generic in-app banner (visible immediately, no OS permission needed) — used for
        // instant feedback like AI results, unlike showAppNotification() which is an OS push
        // notification that silently no-ops without permission.
        function showInAppBanner(title, body) {
            const container = document.getElementById('inAppNotificationContainer');
            if (!container) return;
            const banner = document.createElement('div');
            banner.className = "pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border border-[#14b8a6]/40 rounded-2xl p-2.5 shadow-2xl animate-slide-down text-xs text-slate-200";
            banner.innerHTML = `<p class="font-bold text-[#60a5fa]">${title}</p><p class="text-slate-300 mt-0.5">${body}</p>`;
            container.appendChild(banner);
            setTimeout(() => { if (banner.parentNode) banner.remove(); }, 4000);
        }

        // Sundar in-app alert banner — replaces ugly native alert() popups everywhere in the app.
        // type: 'error' (red) | 'success' (green) | 'info' (blue, default) | 'warning' (amber)
        function showAlertBanner(message, type = 'error') {
            const container = document.getElementById('inAppNotificationContainer');
            if (!container) { console.warn('showAlertBanner: container missing, message was:', message); return; }

            const styles = {
                error: { border: 'border-red-500/40', icon: 'fa-circle-exclamation', iconColor: 'text-red-400' },
                success: { border: 'border-emerald-500/40', icon: 'fa-circle-check', iconColor: 'text-emerald-400' },
                info: { border: 'border-[#14b8a6]/40', icon: 'fa-circle-info', iconColor: 'text-[#2dd4bf]' },
                warning: { border: 'border-amber-500/40', icon: 'fa-triangle-exclamation', iconColor: 'text-amber-400' },
            };
            const s = styles[type] || styles.error;

            const banner = document.createElement('div');
            banner.className = `pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border ${s.border} rounded-2xl p-3 shadow-2xl animate-slide-down text-xs text-slate-200 flex items-start gap-2.5`;
            banner.innerHTML = `
                <i class="fa-solid ${s.icon} ${s.iconColor} text-sm mt-0.5 shrink-0"></i>
                <p class="flex-1 leading-snug">${message}</p>
                <button class="text-slate-400 hover:text-white shrink-0 -mt-0.5" aria-label="Dismiss"><i class="fa-solid fa-xmark text-xs"></i></button>
            `;
            banner.querySelector('button').onclick = () => banner.remove();
            container.appendChild(banner);
            setTimeout(() => { if (banner.parentNode) banner.remove(); }, 5000);
        }

        function showAppNotification(title, body, icon, onClickCallback) {
            if (!("Notification" in window) || Notification.permission !== "granted") return;

            try {
                if (swRegistration && swRegistration.showNotification) {
                    swRegistration.showNotification(title, {
                        body,
                        icon: icon || undefined,
                        badge: icon || undefined,
                        tag: title + '_' + Date.now()
                    });
                    // Service worker notifications can't directly bind a JS click handler here,
                    // so we also keep a lightweight in-memory handler queue the SW message-back
                    // listener can trigger. As a practical fallback we just also wire a normal
                    // Notification when the page IS in the foreground, so clicking always works.
                    if (document.visibilityState === 'visible' && onClickCallback) {
                        // no extra popup needed while visible - the in-app banner already covers this
                    }
                } else {
                    const notification = new Notification(title, { body, icon: icon || undefined });
                    notification.onclick = () => {
                        window.focus();
                        if (onClickCallback) onClickCallback();
                        notification.close();
                    };
                }
            } catch (err) {
                console.error("Notification error:", err);
            }
        }

        // ===== FEATURE: REAL PUSH NOTIFICATIONS (works even when the app/browser is fully closed) =====
        // Public VAPID key for Web Push (safe to expose client-side — pairs with the private
        // key that only the send-push Edge Function holds). Generated once; do not change
        // this without also updating the VAPID_PRIVATE_KEY secret on the Edge Function, or
        // every existing subscription breaks.
        const VAPID_PUBLIC_KEY = 'BHBdOkZuBBKDf7xte8XCazBA4q0YWhhK_USMjTuyHJmgk9MzzwzIYOTBU4CRGPYMYvErq2iQP6tJUexxeKCj6LU';

        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
            return outputArray;
        }

        // Subscribes this browser/device to Web Push and saves the subscription in Supabase
        // (table: push_subscriptions) so the send-push Edge Function can reach it later — even
        // if the app is fully closed or the phone is asleep. Safe to call repeatedly; re-uses
        // the existing subscription if one is already active for this device.
        // NOTE (iOS/Safari): push only works once the app is added to the Home Screen
        // ("Add to Home Screen" → opened from that icon). A normal Safari tab cannot receive
        // push notifications on iOS — that's an Apple platform limit, not a bug here.
        async function setupPushNotifications(username) {
            try {
                if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
                if (!swRegistration) swRegistration = await navigator.serviceWorker.ready;
                if (!("Notification" in window) || Notification.permission !== 'granted') return;

                let sub = await swRegistration.pushManager.getSubscription();
                if (!sub) {
                    sub = await swRegistration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                    });
                }

                const p256dhKey = sub.getKey('p256dh');
                const authKey = sub.getKey('auth');
                const p256dh = btoa(String.fromCharCode(...new Uint8Array(p256dhKey)));
                const authStr = btoa(String.fromCharCode(...new Uint8Array(authKey)));

                const { error } = await supabaseClient.from('push_subscriptions').upsert({
                    username: username,
                    endpoint: sub.endpoint,
                    p256dh: p256dh,
                    auth: authStr
                }, { onConflict: 'endpoint' });

                if (error) console.warn('push_subscriptions upsert failed (run push_migration.sql?):', error);
            } catch (err) {
                console.warn('setupPushNotifications failed:', err);
            }
        }
        window.setupPushNotifications = setupPushNotifications;

        // PERF: debounced entry point for the catch-all realtime channel. Collapses a burst
        // of unrelated activity (anyone's likes/messages/comments/etc.) into a single refresh,
        // and postpones it while the feed is actively being scrolled.
        function scheduleGlobalDataRefresh() {
            clearTimeout(allChangesRefreshTimer);
            allChangesRefreshTimer = setTimeout(async () => {
                // PERF: nobody is looking at a hidden tab — refresh once when it becomes visible
                if (document.hidden) { refreshPendingWhileHidden = true; return; }
                if (isFeedScrolling) { scheduleGlobalDataRefresh(); return; }
                await fetchAllData({ light: true });
                if (viewingProfileUsername) openProfile(viewingProfileUsername, false);
                if (activeModalPostId) renderCommentModal(activeModalPostId);
            }, 2500);
        }

        let refreshPendingWhileHidden = false;
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && refreshPendingWhileHidden) {
                refreshPendingWhileHidden = false;
                scheduleGlobalDataRefresh();
            }
        });

        // PERF: dozens of places across the app call `await fetchAllData()` right after a
        // single action (like, comment, follow, etc). If several of those happen close
        // together — e.g. quickly liking a few posts in a row — this used to fire a whole
        // separate 20-query fetch for each one, all overlapping. Now a second call that
        // arrives while one is already running just waits for it and piggybacks on that
        // same result (then queues exactly one more run afterwards if something asked for
        // a refresh mid-flight), instead of stacking up redundant network round-trips.
        let fetchAllDataInFlight = null;
        let fetchAllDataQueuedAgain = false;
        let fetchAllDataQueuedFull = false;

        // PERF (Supabase load): fetchAllData used to download EVERY row of ~20 tables on every call
        // (and it is called after almost every action + on every realtime event from any user).
        // Now:
        //   * posts = newest FEED_POST_WINDOW + my own posts (+ posts of profiles I opened);
        //     likes / comments / story views are fetched only for those posts
        //   * "light" refresh (used by realtime events) only re-reads posts, likes, comments,
        //     follows, follow requests and stories
        //   * big rarely-changing tables (profiles, groups, group members, reactions) are cached
        //     for STATIC_CACHE_TTL_MS and re-read earlier only if I wrote to them (see wrapper below)
        let FEED_POST_WINDOW = 60;
        const MY_POST_WINDOW = 150;
        const STATIC_CACHE_TTL_MS = 45000;
        let lastStaticFetchAt = 0;
        let staticCacheDirty = true;
        const extraPostsByUser = new Map();   // username -> posts fetched on demand (profile view)
        const extraPostsRequested = new Set();

        (function installStaticWriteTracker() {
            const STATIC_TABLES = new Set(['profiles', 'groups', 'group_members', 'message_reactions']);
            const origFrom = supabaseClient.from.bind(supabaseClient);
            supabaseClient.from = function (table) {
                const q = origFrom(table);
                if (STATIC_TABLES.has(table)) {
                    ['insert', 'update', 'delete', 'upsert'].forEach(m => {
                        const orig = q[m];
                        if (typeof orig === 'function') q[m] = function (...a) { staticCacheDirty = true; return orig.apply(q, a); };
                    });
                }
                return q;
            };
        })();

        function extraPostsFlat() {
            const out = [];
            extraPostsByUser.forEach(arr => out.push(...arr));
            return out;
        }

        async function fetchPostsWindow() {
            const [recent, mine] = await Promise.all([
                supabaseClient.from('posts').select('*').order('created_at', { ascending: false }).limit(FEED_POST_WINDOW),
                supabaseClient.from('posts').select('*').eq('username', currentUser).order('created_at', { ascending: false }).limit(MY_POST_WINDOW)
            ]);
            if (recent.error && !recent.data) return recent;
            const map = new Map();
            [...(recent.data || []), ...(mine.data || []), ...extraPostsFlat()].forEach(p => map.set(String(p.id), p));
            const arr = Array.from(map.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            return { data: arr };
        }

        // Runs `select *` for rows whose `col` is in `ids`, in small chunks (keeps URLs short).
        async function fetchByIds(table, col, ids, build) {
            if (!ids || !ids.length) return { data: [] };
            const chunks = [];
            for (let i = 0; i < ids.length; i += 80) chunks.push(ids.slice(i, i + 80));
            const results = await Promise.all(chunks.map(c => {
                let q = supabaseClient.from(table).select('*').in(col, c);
                if (build) q = build(q);
                return q;
            }));
            const data = [];
            let error = null;
            results.forEach(r => { if (r.error) error = r.error; else if (r.data) data.push(...r.data); });
            return { data, error };
        }

        // Loads (once) the latest posts of a profile that is not already in the cache, so that
        // older posts still show on that profile without downloading every post for everyone.
        async function ensureUserPostsLoaded(username) {
            if (!username || username === currentUser || extraPostsRequested.has(username)) return;
            extraPostsRequested.add(username);
            try {
                const { data, error } = await supabaseClient.from('posts').select('*')
                    .eq('username', username).order('created_at', { ascending: false }).limit(60);
                if (error || !data) { extraPostsRequested.delete(username); return; }
                const known = new Set(globalPostsCache.map(p => String(p.id)));
                if (!data.some(p => !known.has(String(p.id)))) return;
                if (extraPostsByUser.size >= 8) extraPostsByUser.delete(extraPostsByUser.keys().next().value);
                extraPostsByUser.set(username, data);
                await fetchAllData({ light: true });
                if (viewingProfileUsername === username) openProfile(username, false);
            } catch (e) { extraPostsRequested.delete(username); }
        }

        function loadMoreFeedPosts() {
            FEED_POST_WINDOW += 60;
            return fetchAllData({ light: true });
        }

        function fetchAllData(opts) {
            const light = !!(opts && opts.light);
            if (fetchAllDataInFlight) {
                fetchAllDataQueuedAgain = true;
                if (!light) fetchAllDataQueuedFull = true;
                return fetchAllDataInFlight;
            }
            fetchAllDataInFlight = _fetchAllDataImpl({ light }).finally(() => {
                fetchAllDataInFlight = null;
                if (fetchAllDataQueuedAgain) {
                    const nextLight = !fetchAllDataQueuedFull;
                    fetchAllDataQueuedAgain = false;
                    fetchAllDataQueuedFull = false;
                    fetchAllData({ light: nextLight });
                }
            });
            return fetchAllDataInFlight;
        }

        async function _fetchAllDataImpl(opts) {
            const light = !!(opts && opts.light);
            // FEATURE: OFFLINE MODE — no point hitting the network when we know it's down;
            // fall back straight to whatever feed we last cached.
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
                loadCachedFeedIfOffline();
                updateOfflineBannerUI();
                return;
            }
            try {
                // PERF: these ~20 queries are all independent (each just fills its own cache
                // variable) but used to run one-at-a-time with `await` in a row — so every
                // single fetchAllData() call paid for 20 sequential network round-trips back
                // to back. Running them together with Promise.all cuts that to roughly the
                // time of the single slowest query, which is the biggest lever available for
                // making every like/comment/follow/etc. action (which all end by calling
                // fetchAllData) feel lighter — without changing what data gets fetched or any
                // of the existing optional-table fallback behavior below.
                const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const fetchStatic = !light && (staticCacheDirty || (Date.now() - lastStaticFetchAt) > STATIC_CACHE_TTL_MS);
                const skipped = Promise.resolve({ data: null, skipped: true });
                if (fetchStatic) staticCacheDirty = false;

                const [profilesRes, followsRes, postsRes, storiesRes, groupsRes, groupMembersRes] = await Promise.all([
                    fetchStatic ? supabaseClient.from('profiles').select('*') : skipped,
                    supabaseClient.from('follows').select('*'),
                    fetchPostsWindow(),
                    supabaseClient.from('stories').select('*').gte('created_at', cutoff).order('created_at', { ascending: true }),
                    fetchStatic ? supabaseClient.from('groups').select('*') : skipped,
                    fetchStatic ? supabaseClient.from('group_members').select('*') : skipped
                ]);

                const windowPostIds = (postsRes.data || []).map(p => p.id);
                const windowStoryIds = (storiesRes.data || []).map(s => s.id);
                const [likesRes, commentsRes, storyViewsRes, reactionsRes] = await Promise.all([
                    fetchByIds('post_likes', 'post_id', windowPostIds),
                    fetchByIds('comments', 'post_id', windowPostIds, q => q.order('created_at', { ascending: true })),
                    light ? skipped : fetchByIds('story_views', 'story_id', windowStoryIds),
                    fetchStatic ? supabaseClient.from('message_reactions').select('*') : skipped
                ]);
                if (fetchStatic) lastStaticFetchAt = Date.now();
                if (commentsRes.data) commentsRes.data.sort((x, y) => new Date(x.created_at) - new Date(y.created_at));

                const profiles = profilesRes.data;
                if (profiles) {
                    globalProfilesCache = {};
                    globalProfilesFullCache = {};
                    profiles.forEach(p => { if(p.username) { globalProfilesCache[p.username] = p.avatar_url; globalProfilesFullCache[p.username] = p; } });
                }
                globalFollowsCache = followsRes.data || [];
                globalPostsCache = postsRes.data || [];
                globalLikesCache = likesRes.data || [];
                globalCommentsCache = commentsRes.data || [];
                globalStoriesCache = storiesRes.data || [];
                if (!storyViewsRes.skipped) globalStoryViewsCache = storyViewsRes.data || [];
                if (!groupsRes.skipped) globalGroupsCache = groupsRes.data || [];
                if (!groupMembersRes.skipped) globalGroupMembersCache = groupMembersRes.data || [];
                if (!reactionsRes.skipped) globalReactionsCache = reactionsRes.data || [];

                // The rest are optional tables (each no-ops quietly until its SQL setup has
                // been run) — same per-query try/catch as before, just fired in parallel too.
                try { const { data: fr } = await supabaseClient.from('follow_requests').select('*'); globalFollowRequestsCache = fr || []; } catch(e) { globalFollowRequestsCache = []; }

                if (!light) await Promise.all([
                    (async () => { try { const { data: gjr } = await supabaseClient.from('group_join_requests').select('*'); globalGroupJoinRequestsCache = gjr || []; } catch(e) { globalGroupJoinRequestsCache = []; } })(),
                    (async () => {
                        // PERF: only likes on the most recent 400 comments (was: every comment like ever)
                        try {
                            const ids = (globalCommentsCache || []).slice(-400).map(c => c.id);
                            const { data: cl } = await fetchByIds('comment_likes', 'comment_id', ids);
                            globalCommentLikesCache = cl || [];
                        } catch(e) { globalCommentLikesCache = []; }
                    })(),
                    (async () => {
                        // PERF: only block rows that involve ME (that is all isBlockedWith() ever looks at)
                        try {
                            const me = String(currentUser).replace(/"/g, '');
                            const { data: bl, error: blErr } = await supabaseClient.from('blocked_users').select('*')
                                .or(`blocker.eq."${me}",blocked.eq."${me}"`);
                            if (blErr) throw blErr;
                            globalBlockedCache = bl || [];
                        } catch(e) {
                            try { const { data: bl2 } = await supabaseClient.from('blocked_users').select('*'); globalBlockedCache = bl2 || []; } catch(e2) { globalBlockedCache = []; }
                        }
                    })(),
                    (async () => {
                        // PERF: was the ENTIRE post_views table. Now: my own views (to avoid double
                        // counting) + the views on MY posts (for the analytics counters).
                        try {
                            const myPostIds = (globalPostsCache || []).filter(p => p.username === currentUser).map(p => p.id);
                            const [mineRes, onMyPostsRes] = await Promise.all([
                                supabaseClient.from('post_views').select('*').eq('viewer', currentUser).limit(1000),
                                fetchByIds('post_views', 'post_id', myPostIds)
                            ]);
                            const seen = new Set();
                            const merged = [];
                            [...(mineRes.data || []), ...(onMyPostsRes.data || [])].forEach(v => {
                                const k = String(v.post_id) + '|' + v.viewer;
                                if (v.id !== undefined && v.id !== null) { const kk = 'id' + v.id; if (seen.has(kk)) return; seen.add(kk); merged.push(v); return; }
                                if (seen.has(k)) return; seen.add(k); merged.push(v);
                            });
                            globalPostViewsCache = merged;
                        } catch(e) { globalPostViewsCache = []; }
                    })(),
                    (async () => {
                        // FEATURE: SAVE POST/REEL — optional table; only ever need our OWN saved list
                        try {
                            const { data: sp, error: spErr } = await supabaseClient.from('saved_posts').select('*').eq('username', currentUser);
                            if (spErr) throw spErr;
                            globalSavedPostsCache = sp || [];
                            savedPostsFeatureAvailable = true;
                        } catch (e) {
                            globalSavedPostsCache = [];
                            savedPostsFeatureAvailable = false;
                        }
                    })(),
                    (async () => { try { const { data: mr } = await supabaseClient.from('message_requests').select('*'); globalMessageRequestsCache = mr || []; } catch(e) { globalMessageRequestsCache = []; } })(),
                    (async () => {
                        // FEATURE: CLOSE FRIENDS — optional table; no-ops quietly until the SQL setup is run
                        try {
                            const { data: cf, error: cfErr } = await supabaseClient.from('close_friends').select('*').eq('owner', currentUser);
                            if (cfErr) throw cfErr;
                            closeFriendsCache = new Set((cf || []).map(r => r.friend_username));
                            closeFriendsFeatureAvailable = true;
                        } catch (e) {
                            closeFriendsCache = new Set();
                            closeFriendsFeatureAvailable = false;
                        }
                    })(),
                ]);

                detectAndNotifyNewActivity();

                renderFeed();
                renderReels();
                renderStoriesBar();
                renderGroupsList();
                renderExplore();
                renderSuggestedUsers();
                updateFollowRequestsBadge();
                updateGroupJoinRequestsBadge(); // FEATURE: PRIVATE GROUPS/CHANNELS
                updateMessageRequestsBadge(); // FEATURE: MESSAGE REQUESTS
                if (activeChatUser) updateChatRequestUI(activeChatUser); // FEATURE: MESSAGE REQUESTS
                updateNotificationsBadge(); // FEATURE: NOTIFICATIONS
                if (currentTab === 'groups' && !activeGroupId) renderGroupsList();
                loadCallUsers("");
            } catch(e) {
                console.error(e);
            }
        }

        // Returns true if either user has blocked the other (used to filter feed/search/chat/comments)
        function isBlockedWith(otherUsername) {
            if (!otherUsername || otherUsername === currentUser) return false;
            return globalBlockedCache.some(b =>
                (b.blocker === currentUser && b.blocked === otherUsername) ||
                (b.blocker === otherUsername && b.blocked === currentUser)
            );
        }

        // Returns true if the given profile is private AND I don't already follow them (and it's not me)
        function isPrivateAndNotFollowing(username) {
            if (!username || username === currentUser) return false;
            const prof = globalProfilesFullCache ? globalProfilesFullCache[username] : null;
            if (!prof || !prof.is_private) return false;
            const following = globalFollowsCache.some(f => f.follower === currentUser && f.following === username);
            return !following;
        }

        // =====================================================================================
        // FEATURE: DISCOVERY vs MESSAGING SEPARATION
        // Discovery (search/suggest, feed, explore) is intentionally NOT gated here — every user
        // must stay findable everywhere regardless of follow state. Only actually messaging
        // someone is gated: you can DM a user only if you follow them OR they follow you (a
        // one-directional relationship in either direction is enough — it doesn't need to be
        // mutual). If neither is true, messaging that person is blocked outright.
        // =====================================================================================
        function canMessageUser(username) {
            if (!username || username === currentUser) return false;
            const iFollowThem = globalFollowsCache.some(f => f.follower === currentUser && f.following === username);
            const theyFollowMe = globalFollowsCache.some(f => f.follower === username && f.following === currentUser);
            return iFollowThem || theyFollowMe;
        }

        // =====================================================================================
        // FEATURE: NEXUS ADMIN VERIFICATION (blue tick) — the account named "NEXUS" is the
        // app's own admin/owner account. Only when NEXUS is logged in does the app show the
        // controls to grant/remove any user's blue tick. Needs a `profiles.is_verified` boolean
        // column (default false) — see console warning below if it isn't set up yet.
        // =====================================================================================
        const NEXUS_ADMIN_USERNAME = 'NEXUS';

        // SECURITY: this only decides what the UI *shows* (the admin panel/buttons).
        // It reads a real is_admin column from the DB rather than just string-matching
        // the username, but by itself it's still just a client-side check — someone
        // could flip it to true in devtools. That's fine, because the actual admin
        // ACTION (rpc_admin_set_verified) independently requires the correct admin PIN,
        // checked inside Postgres, so faking this boolean alone gains nothing.
        function isNexusAdmin() {
            const prof = globalProfilesFullCache ? globalProfilesFullCache[currentUser] : null;
            return !!(prof && prof.is_admin) || currentUser === NEXUS_ADMIN_USERNAME;
        }

        function isUserVerified(username) {
            if (!username) return false;
            const prof = globalProfilesFullCache ? globalProfilesFullCache[username] : null;
            return !!(prof && prof.is_verified);
        }

        // Small blue-tick <i> icon, or '' if the user isn't verified. Drop this right after any
        // username label in the app so verified users are recognizable everywhere.
        function verifiedBadgeHtml(username) {
            return isUserVerified(username)
                ? `<i class="fa-solid fa-circle-check text-[#38bdf8]" title="Verified"></i>`
                : '';
        }

        // Small "Admin" pill shown next to NEXUS's username everywhere (profile, feed, search,
        // chat list, chat header) so the app's owner account is always clearly labeled.
        function adminBadgeHtml(username) {
            return username === NEXUS_ADMIN_USERNAME
                ? `<span class="text-[11px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[#2563eb] text-white shrink-0">Admin</span>`
                : '';
        }

        // Called only from NEXUS's own profile-view UI. Flips is_verified for the target user
        // (NEXUS can verify anyone, including its own account).
        async function toggleUserVerification(username) {
            if (!isNexusAdmin() || !username) return;
            // UI FIX: window.prompt() replaced with a proper in-app PIN modal (see
            // openAdminPinModal / submitAdminPinModal below) — ugly native browser popup is gone.
            openAdminPinModal(username);
        }

        // Target username the PIN modal is currently acting on, and whether it's a
        // grant or a revoke — set by openAdminPinModal, read by submitAdminPinModal.
        let adminPinTargetUsername = null;

        function openAdminPinModal(username) {
            adminPinTargetUsername = username;
            const currentlyVerified = isUserVerified(username);
            const modal = document.getElementById('adminPinModal');
            const titleEl = document.getElementById('adminPinModalTitle');
            const subEl = document.getElementById('adminPinModalSubtext');
            const actionBtn = document.getElementById('adminPinModalActionBtn');
            const input = document.getElementById('adminPinModalInput');
            const errEl = document.getElementById('adminPinModalError');

            titleEl.innerText = currentlyVerified ? 'Remove Blue Tick' : 'Grant Blue Tick';
            subEl.innerText = currentlyVerified
                ? `${username} ka verified badge hatane ke liye admin PIN daalo.`
                : `${username} ko verified badge dene ke liye admin PIN daalo.`;
            actionBtn.innerText = currentlyVerified ? 'Remove Badge' : 'Grant Badge';
            actionBtn.className = currentlyVerified
                ? "w-full bg-gradient-to-r from-red-500 to-orange-500 font-bold py-2.5 rounded-xl text-xs text-white transition"
                : "w-full bg-[#2563eb] font-bold py-2.5 rounded-xl text-xs text-white transition";
            input.value = '';
            errEl.classList.add('hidden');
            errEl.innerText = '';
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => input.focus(), 50);
        }

        function closeAdminPinModal() {
            document.getElementById('adminPinModal').classList.add('hidden');
            document.getElementById('adminPinModal').classList.remove('flex');
            adminPinTargetUsername = null;
        }

        async function submitAdminPinModal() {
            const username = adminPinTargetUsername;
            if (!username) return;
            const input = document.getElementById('adminPinModalInput');
            const errEl = document.getElementById('adminPinModalError');
            const actionBtn = document.getElementById('adminPinModalActionBtn');
            const pin = input.value.trim();

            if (!pin) {
                errEl.innerText = 'PIN daalna zaroori hai.';
                errEl.classList.remove('hidden');
                return;
            }

            const currentlyVerified = isUserVerified(username);
            const originalBtnText = actionBtn.innerText;
            actionBtn.disabled = true;
            actionBtn.innerText = 'Checking...';
            errEl.classList.add('hidden');

            // SECURITY: is_verified can no longer be UPDATEd directly from the client at all
            // (revoked in security_migration.sql). The only path is this RPC, which re-checks
            // is_admin AND the admin PIN server-side before touching the row.
            try {
                const { data: result, error } = await supabaseClient.rpc('rpc_admin_set_verified', {
                    p_admin_username: currentUser, p_admin_pin: pin,
                    p_target_username: username, p_value: !currentlyVerified
                });
                if (error || !result.ok) {
                    const reason = result && result.error === 'bad_pin' ? 'Galat PIN. Dobara try karo.'
                        : result && result.error === 'not_admin' ? 'Ye account admin nahi hai.'
                        : 'Verification badge abhi set up nahi hai — security_migration.sql run karo.';
                    errEl.innerText = reason;
                    errEl.classList.remove('hidden');
                    actionBtn.disabled = false;
                    actionBtn.innerText = originalBtnText;
                    input.value = '';
                    input.focus();
                    return;
                }
                if (globalProfilesFullCache[username]) globalProfilesFullCache[username].is_verified = !currentlyVerified;
                closeAdminPinModal();
                showAlertBanner(!currentlyVerified ? `${username} ko blue tick de diya.` : `${username} ka blue tick hata diya.`, 'success');
                if (viewingProfileUsername === username) openProfile(username, false);
            } catch (err) {
                console.error('toggleUserVerification failed:', err);
                errEl.innerText = 'Kuch galat ho gaya, dobara try karo.';
                errEl.classList.remove('hidden');
                actionBtn.disabled = false;
                actionBtn.innerText = originalBtnText;
            }
        }

        // =====================================================================================
        // FEATURE: MESSAGE REQUESTS — Instagram-style DM gate for private accounts. If someone
        // is private and I don't follow them, my first DM to them becomes a pending "message
        // request" that sits in their Message Requests tray until they Accept (opens the chat
        // normally) or Decline (deletes the pending messages). Needs a `message_requests` table
        // (requester text, target text, status text default 'pending', created_at) — see console
        // warning below if it isn't set up yet.
        // =====================================================================================

        // Finds any existing message-request row between two usernames, in either direction
        function getMessageRequestBetween(u1, u2) {
            return globalMessageRequestsCache.find(r =>
                (r.requester === u1 && r.target === u2) || (r.requester === u2 && r.target === u1)
            ) || null;
        }

        // True when I (currentUser) still need a request accepted before messaging targetUser freely.
        // Applies to EVERY non-connected user now (public or private) — not just private accounts:
        // if neither of us follows the other, the first message becomes a pending request that sits
        // in their chat section until they Accept (normal chat opens) or Decline.
        function messageNeedsRequest(targetUser) {
            if (canMessageUser(targetUser)) return false; // already connected either way — free chat
            const req = getMessageRequestBetween(currentUser, targetUser);
            return !(req && req.status === 'accepted');
        }

        // True when targetUser sent ME a request that I haven't accepted/declined yet
        function isPendingIncomingRequest(targetUser) {
            const req = getMessageRequestBetween(currentUser, targetUser);
            return !!(req && req.status === 'pending' && req.target === currentUser);
        }

        // True when I'm the one who sent a request and I'm still waiting on them
        function isPendingOutgoingRequest(targetUser) {
            const req = getMessageRequestBetween(currentUser, targetUser);
            return !!(req && req.status === 'pending' && req.requester === currentUser);
        }

        // Called right before sending any DM (text, media, voice note, story reply, shared post).
        // Creates a pending message_requests row the first time it's needed. Returns false if the
        // send should be blocked (I have an unaccepted request FROM the other person sitting in my
        // tray — they need to accept my reply implicitly is not allowed, I must Accept it first).
        async function ensureMessageRequestForSend(targetUser) {
            if (isPendingIncomingRequest(targetUser)) {
                showAlertBanner('Pehle is message request ko Accept ya Decline karo.', 'warning');
                return false;
            }
            if (messageNeedsRequest(targetUser) && !getMessageRequestBetween(currentUser, targetUser)) {
                try {
                    const { data: newReq, error } = await supabaseClient.from('message_requests')
                        .insert({ requester: currentUser, target: targetUser, status: 'pending' })
                        .select().single();
                    if (!error && newReq) {
                        globalMessageRequestsCache.push(newReq);
                    } else if (error) {
                        console.warn('Nexus: message_requests table not set up yet (see Message Requests SQL setup).', error);
                    }
                } catch (e) {
                    console.warn('Nexus: message_requests table not set up yet (see Message Requests SQL setup).', e);
                }
                updateMessageRequestsBadge();
                if (activeChatUser === targetUser) updateChatRequestUI(targetUser);
            }
            return true;
        }

        // Shows/hides the chat input vs the Accept/Decline bar vs the "request sent" notice,
        // based on the message_requests state between me and the open chat partner.
        function updateChatRequestUI(username) {
            const incomingBar = document.getElementById('chatIncomingRequestBar');
            const outgoingBar = document.getElementById('chatOutgoingRequestBar');
            const form = document.getElementById('chatForm');
            if (!incomingBar || !outgoingBar || !form || !username) return;

            if (isPendingIncomingRequest(username)) {
                incomingBar.classList.remove('hidden');
                incomingBar.classList.add('flex');
                outgoingBar.classList.add('hidden');
                outgoingBar.classList.remove('flex');
                form.classList.add('hidden');
            } else if (isPendingOutgoingRequest(username)) {
                incomingBar.classList.add('hidden');
                incomingBar.classList.remove('flex');
                outgoingBar.classList.remove('hidden');
                outgoingBar.classList.add('flex');
                const textEl = document.getElementById('chatOutgoingRequestText');
                if (textEl) textEl.innerText = `Message request bhej diya — ${username} accept karega tab reply aayega.`;
                form.classList.remove('hidden');
            } else {
                incomingBar.classList.add('hidden');
                incomingBar.classList.remove('flex');
                outgoingBar.classList.add('hidden');
                outgoingBar.classList.remove('flex');
                form.classList.remove('hidden');
            }
        }

        // Accept/Decline buttons inside the open chat room (chatIncomingRequestBar)
        async function acceptMessageRequestFromChat() {
            if (!activeChatUser) return;
            const req = getMessageRequestBetween(currentUser, activeChatUser);
            if (!req) { updateChatRequestUI(activeChatUser); return; }
            try {
                await supabaseClient.from('message_requests').update({ status: 'accepted' }).eq('id', req.id);
                await fetchAllData();
                updateChatRequestUI(activeChatUser);
                updateMessageRequestsBadge();
            } catch (err) {
                console.error('Accept message request failed (did you run the message_requests migration?):', err);
            }
        }

        async function declineMessageRequestFromChat() {
            if (!activeChatUser) return;
            const req = getMessageRequestBetween(currentUser, activeChatUser);
            if (!req) return;
            try {
                await supabaseClient.from('message_requests').delete().eq('id', req.id);
                await supabaseClient.from('messages').delete().eq('sender', req.requester).eq('receiver', req.target);
                await fetchAllData();
                closeChatRoom();
                updateMessageRequestsBadge();
            } catch (err) {
                console.error('Decline message request failed:', err);
            }
        }

        // "Message Requests" tray (bell button + modal) — mirrors the Follow Requests pattern
        function updateMessageRequestsBadge() {
            const bell = document.getElementById('messageRequestsBellBtn');
            const badge = document.getElementById('messageRequestsBadge');
            if (!bell || !badge) return;
            const pending = globalMessageRequestsCache.filter(r => r.target === currentUser && r.status === 'pending');
            if (pending.length === 0) {
                bell.classList.add('hidden');
                badge.classList.add('hidden');
                return;
            }
            bell.classList.remove('hidden');
            badge.classList.remove('hidden');
            badge.innerText = pending.length;
        }

        function openMessageRequestsModal() {
            renderMessageRequests();
            document.getElementById('messageRequestsModal').classList.remove('hidden');
        }

        function closeMessageRequestsModal() {
            document.getElementById('messageRequestsModal').classList.add('hidden');
        }

        function renderMessageRequests() {
            const container = document.getElementById('messageRequestsContainer');
            const pending = globalMessageRequestsCache.filter(r => r.target === currentUser && r.status === 'pending');

            if (pending.length === 0) {
                container.innerHTML = `<p class="text-center text-xs text-slate-400 py-6">Koi pending message request nahi hai.</p>`;
                return;
            }

            container.innerHTML = pending.map(r => {
                const av = globalProfilesCache[r.requester];
                return `
                    <div class="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl p-2.5">
                        <div class="flex items-center space-x-2 min-w-0 cursor-pointer" onclick="closeMessageRequestsModal(); selectChatUser('${r.requester}', true)">
                            <div class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : r.requester.charAt(0).toUpperCase()}</div>
                            <span class="text-xs font-bold text-slate-200 truncate">${r.requester}</span>
                        </div>
                        <div class="flex gap-1.5 shrink-0">
                            <button onclick="approveMessageRequest('${r.id}')" class="bg-[#2563eb] hover:bg-[#2563eb] text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition">Accept</button>
                            <button onclick="declineMessageRequest('${r.id}', '${r.requester}')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition">Decline</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function approveMessageRequest(requestId) {
            try {
                await supabaseClient.from('message_requests').update({ status: 'accepted' }).eq('id', requestId);
                await fetchAllData();
                renderMessageRequests();
                updateMessageRequestsBadge();
            } catch (err) {
                console.error('Approve message request failed:', err);
            }
        }

        async function declineMessageRequest(requestId, requesterUsername) {
            try {
                await supabaseClient.from('message_requests').delete().eq('id', requestId);
                if (requesterUsername) {
                    await supabaseClient.from('messages').delete().eq('sender', requesterUsername).eq('receiver', currentUser);
                }
                await fetchAllData();
                renderMessageRequests();
                updateMessageRequestsBadge();
            } catch (err) {
                console.error('Decline message request failed:', err);
            }
        }

        // Compares like/comment/follow counts against the previous fetch to fire background
        // notifications for activity on the current user's own posts, without needing a
        // dedicated realtime channel per event type.
        function detectAndNotifyNewActivity() {
            const myPostIds = new Set(globalPostsCache.filter(p => p.username === currentUser).map(p => p.id));

            const likeCounts = {};
            globalLikesCache.forEach(l => { if (myPostIds.has(l.post_id)) likeCounts[l.post_id] = (likeCounts[l.post_id] || 0) + 1; });

            const commentCounts = {};
            globalCommentsCache.forEach(c => { if (myPostIds.has(c.post_id)) commentCounts[c.post_id] = (commentCounts[c.post_id] || 0) + 1; });

            const followerCount = globalFollowsCache.filter(f => f.following === currentUser).length;

            if (notificationsBaselineSet) {
                Object.keys(likeCounts).forEach(pid => {
                    const before = prevLikesCount[pid] || 0;
                    if (likeCounts[pid] > before) {
                        showAppNotification('New Like ❤️', 'Someone liked your post', null, () => switchTab('feed'));
                        playNotificationSound(); // FEATURE: CUSTOM NOTIFICATION SOUNDS
                    }
                });
                Object.keys(commentCounts).forEach(pid => {
                    const before = prevCommentsCount[pid] || 0;
                    if (commentCounts[pid] > before) {
                        showAppNotification('New Comment 💬', 'Someone commented on your post', null, () => switchTab('feed'));
                        playNotificationSound(); // FEATURE: CUSTOM NOTIFICATION SOUNDS
                    }
                });
                if (followerCount > (prevFollowersCount.count || 0)) {
                    showAppNotification('New Follower 👤', 'You have a new follower', null, () => openProfile(currentUser));
                }
            }

            prevLikesCount = likeCounts;
            prevCommentsCount = commentCounts;
            prevFollowersCount = { count: followerCount };
            notificationsBaselineSet = true;
        }

        async function logout() {
            const loggingOutOf = currentUser;
            // FEATURE: if this account was switched INTO from another one, logging out
            // should drop you back on that previous account instead of the login screen —
            // same as switching apps on your phone doesn't forget who you were before.
            const prev = localStorage.getItem('nexus_previous_user');
            localStorage.removeItem('nexus_user');
            localStorage.removeItem('nexus_tab');
            localStorage.removeItem('nexus_active_chat');
            localStorage.removeItem('nexus_previous_user');
            try { await supabaseClient.auth.signOut(); } catch (e) { /* ignore */ }
            if (prev && prev !== loggingOutOf && getSavedAccounts().includes(prev)) {
                localStorage.setItem('nexus_user', prev);
            }
            location.reload();
        }

        function openAccountSwitcher() {
            renderAccountSwitcherList();
            document.getElementById('accountSwitcherModal').classList.remove('hidden');
            document.getElementById('accountSwitcherModal').classList.add('flex');
        }

        function closeAccountSwitcher() {
            document.getElementById('accountSwitcherModal').classList.add('hidden');
            document.getElementById('accountSwitcherModal').classList.remove('flex');
        }

        function renderAccountSwitcherList() {
            const container = document.getElementById('accountSwitcherList');
            const accounts = getSavedAccounts();
            if (accounts.length === 0) {
                container.innerHTML = `<div class="text-center text-[11px] text-slate-400 py-4">No saved accounts yet.</div>`;
                return;
            }
            container.innerHTML = accounts.map(u => {
                const isActive = u === currentUser;
                const avatar = globalProfilesCache ? globalProfilesCache[u] : null;
                return `
                    <div class="flex items-center justify-between gap-2 p-2.5 rounded-xl ${isActive ? 'bg-[#2563eb]/15 border border-[#3b82f6]/40' : 'bg-slate-900 border border-slate-800 hover:border-[#14b8a6]/50'} transition">
                        <div onclick="switchToAccount('${u}')" class="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer">
                            <div class="w-9 h-9 shrink-0 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden">
                                ${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}
                            </div>
                            <div class="min-w-0">
                                <p class="text-xs font-bold text-slate-200 truncate">${u}</p>
                                ${isActive ? '<p class="text-[11px] font-bold text-[#60a5fa]">Active now</p>' : '<p class="text-[11px] text-slate-400"><i class="fa-solid fa-lock mr-1"></i>Tap to switch</p>'}
                            </div>
                        </div>
                        ${!isActive ? `<button onclick="removeSavedAccount('${u}')" class="text-slate-400 hover:text-red-400 text-xs shrink-0 p-1.5" title="Remove from list"><i class="fa-solid fa-xmark"></i></button>` : ''}
                    </div>
                `;
            }).join('');
        }

        // FEATURE: switching to a saved account now asks for that account's password
        // (and its 2FA PIN, if it has one set) before actually switching — previously
        // tapping a username in the list switched instantly with zero verification.
        let switchVerifyTargetUsername = null;

        function switchToAccount(username) {
            if (!username || username === currentUser) { closeAccountSwitcher(); return; }
            beginAccountSwitchVerify(username);
        }

        function beginAccountSwitchVerify(username) {
            switchVerifyTargetUsername = username;
            document.getElementById('accountSwitcherListView').classList.add('hidden');
            document.getElementById('accountSwitcherVerifyView').classList.remove('hidden');

            const avatar = globalProfilesCache ? globalProfilesCache[username] : null;
            document.getElementById('switchVerifyAvatar').innerHTML = avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : username.charAt(0).toUpperCase();
            document.getElementById('switchVerifyUsername').innerText = username;

            document.getElementById('switchVerifyPasswordForm').classList.remove('hidden');
            document.getElementById('switchVerifyPinForm').classList.add('hidden');
            document.getElementById('switchVerifyPassword').value = '';
            document.getElementById('switchVerifyPin').value = '';
            document.getElementById('switchVerifyPasswordError').classList.add('hidden');
            document.getElementById('switchVerifyPinError').classList.add('hidden');
            setTimeout(() => document.getElementById('switchVerifyPassword').focus(), 50);
        }

        function cancelAccountSwitchVerify() {
            switchVerifyTargetUsername = null;
            document.getElementById('accountSwitcherVerifyView').classList.add('hidden');
            document.getElementById('accountSwitcherListView').classList.remove('hidden');
        }
        window.cancelAccountSwitchVerify = cancelAccountSwitchVerify;

        document.getElementById('switchVerifyPasswordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = switchVerifyTargetUsername;
            const password = document.getElementById('switchVerifyPassword').value;
            const errEl = document.getElementById('switchVerifyPasswordError');
            errEl.classList.add('hidden');
            if (!username || !password) return;

            const { data: result, error } = await supabaseClient.rpc('rpc_login', { p_username: username, p_password: password });
            if (error || !result.ok) {
                errEl.innerText = result && result.error === 'locked' ? 'Bahut saare galat attempts — thodi der baad try karo.' : 'Galat password!';
                errEl.classList.remove('hidden');
                return;
            }

            if (result.needs_2fa) {
                // Password sahi hai — ab 2FA PIN maango, tabhi switch complete hoga.
                pendingSwitchPassword = password;
                document.getElementById('switchVerifyPasswordForm').classList.add('hidden');
                document.getElementById('switchVerifyPinForm').classList.remove('hidden');
                document.getElementById('switchVerifyPin').value = '';
                document.getElementById('switchVerifyPinError').classList.add('hidden');
                setTimeout(() => document.getElementById('switchVerifyPin').focus(), 50);
                return;
            }

            await finalizeAccountSwitch(username, password);
        });

        document.getElementById('switchVerifyPinForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = switchVerifyTargetUsername;
            const pin = document.getElementById('switchVerifyPin').value.trim();
            const errEl = document.getElementById('switchVerifyPinError');
            if (!username || !pin) return;

            const { data: result } = await supabaseClient.rpc('rpc_verify_2fa', { p_username: username, p_pin: pin });
            if (!result || !result.ok) {
                errEl.innerText = 'Galat PIN!';
                errEl.classList.remove('hidden');
                return;
            }

            const p = pendingSwitchPassword;
            pendingSwitchPassword = null;
            await finalizeAccountSwitch(username, p);
        });

        async function finalizeAccountSwitch(username, password) {
            switchVerifyTargetUsername = null;
            closeAccountSwitcher();
            await ensureAuthSession(username, password);
            activateAccount(username);
        }

        // Single place that actually "becomes" an account — used by login, signup, add-
        // another-account, and verified switching alike. Remembers what was active before
        // (so logout() can return to it) then does a clean reload into the new account.
        function activateAccount(username) {
            if (currentUser && currentUser !== username) {
                localStorage.setItem('nexus_previous_user', currentUser);
            }
            localStorage.setItem('nexus_user', username);
            localStorage.removeItem('nexus_active_chat');
            addSavedAccount(username);
            location.reload();
        }

        // Replaces the old prompt()-based "add account" (which just silently created a
        // blank profile with no password!). Reopens the real login/signup screen on top of
        // the current session so you can log into or sign up for another real account.
        function openAddAccountAuthScreen() {
            closeAccountSwitcher();
            document.getElementById('loginForm').reset();
            document.getElementById('signupForm').reset();
            document.getElementById('loginError').classList.add('hidden');
            document.getElementById('signupError').classList.add('hidden');
            switchAuthTab('login');
            document.getElementById('authScreenBackBtn').classList.remove('hidden');
            document.getElementById('auth-screen').classList.remove('hidden');
        }
        window.openAddAccountAuthScreen = openAddAccountAuthScreen;

        function cancelAddAccount() {
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('authScreenBackBtn').classList.add('hidden');
        }
        window.cancelAddAccount = cancelAddAccount;

        function switchTab(tab) {
            const previousTab = currentTab;
            currentTab = tab;
            localStorage.setItem('nexus_tab', tab);

            // FEATURE: leaving the Reels section should fully stop reel sound/playback,
            // not leave whichever reel was in view quietly running in the background.
            if (previousTab === 'reels' && tab !== 'reels') {
                pauseAllReels();
            }

            ['feed', 'chat', 'reels', 'calls', 'groups', 'explore'].forEach(t => {
                document.getElementById('section-' + t).classList.add('hidden');
                const btn = document.getElementById('tab-' + t);
                btn.className = "px-2 py-1 rounded-md text-[11px] font-bold fast-transition text-slate-400 hover:text-slate-200 shrink-0";
            });

            document.getElementById('section-' + tab).classList.remove('hidden');
            document.getElementById('tab-' + tab).className = "px-2 py-1 rounded-md text-[11px] font-bold fast-transition bg-[#2563eb] text-white shadow shrink-0";
            
            if(tab === 'chat') {
                if(!activeChatUser) {
                    loadLoggedUsers();
                    if(messagePollingInterval) clearInterval(messagePollingInterval);
                } else {
                    document.getElementById('chatUsersView').classList.add('hidden');
                    document.getElementById('chatRoomView').classList.remove('hidden');
                    document.getElementById('mainNavbar').classList.add('hidden');
                }
            } else if (tab === 'groups') {
                if(messagePollingInterval) clearInterval(messagePollingInterval);
                if (!activeGroupId) {
                    renderGroupsList();
                } else {
                    document.getElementById('groupsListView').classList.add('hidden');
                    document.getElementById('groupRoomView').classList.remove('hidden');
                }
            } else if (tab === 'explore') {
                renderExplore();
                if(messagePollingInterval) clearInterval(messagePollingInterval);
            } else {
                if(messagePollingInterval) clearInterval(messagePollingInterval);
            }
        }

        let usersWithMessageHistory = new Set(); // FEATURE FIX: chat list should show anyone you've exchanged a message with, follow or not

        // FEATURE: UNREAD MESSAGE COUNT — how many unread messages each person has sent
        // ME, keyed by their username. Shown as a badge next to their name in the chat list.
        let unreadCountsBySender = {};

        async function loadLoggedUsers() {
            let userLastActivityMap = new Map(); // Stores username -> latest message timestamp for sorting
            usersWithMessageHistory = new Set();

            try {
                // Initialize all profiles & posts with a default base timestamp
                // PERF: reuse the already-cached profile list instead of re-downloading it on every
                // incoming message / chat-list refresh.
                const cachedNames = Object.keys(globalProfilesFullCache || {});
                let profiles = cachedNames.length ? cachedNames.map(u => ({ username: u })) : null;
                let profilesErr = null;
                if (!profiles) { const pr = await supabaseClient.from('profiles').select('username'); profiles = pr.data; profilesErr = pr.error; }
                if (profilesErr) {
                    // Surface this loudly: if this select fails (e.g. missing/blocking RLS
                    // SELECT policy on "profiles"), the chat/search user list silently
                    // shrinks down to only people you've posted with or messaged.
                    console.error("loadLoggedUsers: profiles select failed — check RLS SELECT policy on 'profiles' table:", profilesErr);
                }
                if (profiles) {
                    profiles.forEach(p => { 
                        if (p.username && p.username !== currentUser) {
                            userLastActivityMap.set(p.username, new Date(0));
                        } 
                    });
                }

                globalPostsCache.forEach(p => { 
                    if (p.username && p.username !== currentUser) {
                        const existingTime = userLastActivityMap.get(p.username) || new Date(0);
                        const postTime = new Date(p.created_at || 0);
                        if (postTime > existingTime) userLastActivityMap.set(p.username, postTime);
                    } 
                });

                // Fetch all messages involving the current user to sort chat section by most recent interaction (Instagram style)
                // PERF: only MY messages (sent + received), newest 800 each, and no message text —
                // plus one tiny query for the unread counts (was: every message in the table).
                const [sentRes, recvRes, unreadRes] = await Promise.all([
                    supabaseClient.from('messages').select('sender, receiver, created_at, read_at').eq('sender', currentUser).order('created_at', { ascending: false }).limit(800),
                    supabaseClient.from('messages').select('sender, receiver, created_at, read_at').eq('receiver', currentUser).order('created_at', { ascending: false }).limit(800),
                    supabaseClient.from('messages').select('sender').eq('receiver', currentUser).is('read_at', null).limit(2000)
                ]);
                const msgs = [...(sentRes.data || []), ...(recvRes.data || [])];
                unreadCountsBySender = {};
                (unreadRes.data || []).forEach(m => { if (m.sender && m.sender !== currentUser) unreadCountsBySender[m.sender] = (unreadCountsBySender[m.sender] || 0) + 1; });
                if (msgs) {
                    msgs.forEach(m => {
                        let partner = null;
                        if (m.sender === currentUser) partner = m.receiver;
                        else if (m.receiver === currentUser) partner = m.sender;

                        if (partner && partner !== currentUser) {
                            usersWithMessageHistory.add(partner);
                            const msgTime = new Date(m.created_at || Date.now());
                            const existingTime = userLastActivityMap.get(partner) || new Date(0);
                            if (msgTime > existingTime) {
                                userLastActivityMap.set(partner, msgTime);
                            }
                        }

                        // FEATURE: UNREAD MESSAGE COUNT — count messages THEY sent me that I
                        // haven't read yet, per sender, so the chat list can badge their name.
                        // (unread counts now come from the dedicated unread query above)
                    });
                }
            } catch (err) {
                console.error("Error loading users:", err);
            }

            // Sort users descending by latest activity timestamp (Instagram style: user who messaged last appears at the very top)
            cachedAllUsers = Array.from(userLastActivityMap.entries())
                .sort((a, b) => b[1] - a[1])
                .map(entry => entry[0]);

            // FEATURE FIX: DM tab's default (no search) list now shows people you're connected
            // to (follow either direction) OR anyone you already have a message thread with —
            // previously a chat you'd started could vanish from this list if you weren't
            // following each other. cachedAllUsers itself stays unfiltered since search and
            // other features need the full pool.
            renderUsersList(cachedAllUsers.filter(u => canMessageUser(u) || usersWithMessageHistory.has(u)));
        }

        function renderUsersList(usersArray) {
            usersArray = usersArray.filter(u => !isBlockedWith(u));
            const container = document.getElementById('usersListContainer');
            container.innerHTML = '';
            document.getElementById('userCountBadge').innerText = usersArray.length;

            if (usersArray.length === 0) {
                container.innerHTML = `<div class="p-6 text-center text-xs text-slate-400">No users found.</div>`;
                return;
            }

            usersArray.forEach(username => {
                const avatarUrl = globalProfilesCache[username];
                const isOnline = onlineUsersSet.has(username);
                // FEATURE: MESSAGE REQUESTS — surface pending request state right in the chat list
                let reqLabel = '';
                if (isPendingIncomingRequest(username)) {
                    reqLabel = `<p class="text-[11px] font-bold text-[#60a5fa]"><i class="fa-solid fa-envelope mr-1"></i>Message request</p>`;
                } else if (isPendingOutgoingRequest(username)) {
                    reqLabel = `<p class="text-[11px] text-slate-400 italic"><i class="fa-solid fa-clock mr-1"></i>Requested</p>`;
                }
                // FEATURE: UNREAD MESSAGE COUNT — small pill next to the sender's name showing
                // how many unread messages they've sent, e.g. "username [3]". Bold white text
                // for anyone with unread messages so the row stands out, like Instagram/WhatsApp.
                const unreadCount = unreadCountsBySender[username] || 0;
                const unreadBadgeHtml = unreadCount > 0
                    ? `<span class="ml-1 shrink-0 bg-[#2563eb] text-white text-[11px] font-bold rounded-full px-1.5 py-0.5 leading-none">${unreadCount > 99 ? '99+' : unreadCount}</span>`
                    : '';

                const item = document.createElement('div');
                item.className = `p-3 flex items-center space-x-3 cursor-pointer hover:bg-slate-800/60 fast-transition`;
                item.innerHTML = `
                    <div onclick="event.stopPropagation(); handleUserClick('${username}')" class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center font-bold text-xs text-white shadow overflow-hidden relative">
                        ${avatarUrl ? `<img src="${avatarUrl}" class="w-full h-full object-cover">` : username.charAt(0).toUpperCase()}
                        ${isOnline ? `<span class="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 border border-slate-950"></span>` : ''}
                    </div>
                    <div class="flex-1 min-w-0" onclick="selectChatUser('${username}', true)">
                        <p class="text-xs font-bold ${unreadCount > 0 ? 'text-white' : 'text-slate-200'} truncate flex items-center gap-1">${username} ${verifiedBadgeHtml(username)} ${adminBadgeHtml(username)} ${unreadBadgeHtml}</p>
                        ${reqLabel || `<p class="text-[11px] ${isOnline ? 'text-emerald-400' : 'text-slate-400'} flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-slate-600'} inline-block"></span> ${isOnline ? 'Online' : 'Offline'}</p>`}
                    </div>
                    <button onclick="event.stopPropagation(); openDeleteChatModal('${username}')" title="Delete Chat" class="text-slate-400 hover:text-red-400 p-1.5 shrink-0"><i class="fa-solid fa-trash text-xs"></i></button>
                    <i class="fa-solid fa-chevron-right text-xs text-slate-400"></i>
                `;
                item.onclick = () => selectChatUser(username, true);
                container.appendChild(item);
            });
        }

        async function filterChatUsers(query) {
            const q = query.trim();
            const token = (filterChatUsers._token = (filterChatUsers._token || 0) + 1);

            if (!q) {
                // FEATURE FIX: no search term = connected users OR anyone you've already messaged
                renderUsersList(cachedAllUsers.filter(u => canMessageUser(u) || usersWithMessageHistory.has(u)));
                return;
            }

            // Searching: show EVERY matching user regardless of follow state (discovery stays open).
            // Tapping one still only gets a free chat if canMessageUser is true — otherwise sending
            // to them routes through the message-request flow.
            let filtered = cachedAllUsers.filter(u => u.toLowerCase().includes(q.toLowerCase()));

            // Live fallback so a user whose chat was fully deleted still shows up here.
            const liveUsers = await liveSearchProfilesByUsername(q);
            if (token !== filterChatUsers._token) return; // superseded by a newer keystroke
            filtered = [...new Set([...filtered, ...liveUsers.filter(u => u !== currentUser)])];

            renderUsersList(filtered);
        }

        function filterCallUsers(query) {
            loadCallUsers(query);
        }

        async function loadCallUsers(filter = "") {
            const container = document.getElementById('callUsersContainer');
            if(!container) return;

            const token = (loadCallUsers._token = (loadCallUsers._token || 0) + 1);
            let liveUsers = [];
            if (filter.trim()) {
                liveUsers = await liveSearchProfilesByUsername(filter.trim());
                if (token !== loadCallUsers._token) return; // superseded by a newer keystroke
            }

            let allPossible = [currentUser, ...cachedAllUsers, ...liveUsers];
            const users = [...new Set(allPossible)].filter(u => u && u !== currentUser && u.toLowerCase().includes(filter.toLowerCase()));

            if(users.length === 0) {
                container.innerHTML = `<div class="p-6 text-center text-xs text-slate-400">No users found for calls.</div>`;
                return;
            }

            container.innerHTML = users.map(u => {
                const av = globalProfilesCache[u];
                return `
                    <div class="glass-panel rounded-2xl p-3 flex items-center justify-between text-xs">
                        <div class="flex items-center space-x-2.5 cursor-pointer" onclick="openProfile('${u}')">
                            <div class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden shadow">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                            <span class="font-bold text-slate-200">${u}</span>
                        </div>
                        <div class="flex gap-1.5">
                            <button onclick="startRealCall('${u}', 'audio')" class="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1 shadow"><i class="fa-solid fa-phone"></i> Audio</button>
                            <button onclick="startRealCall('${u}', 'video')" class="bg-[#0f766e] hover:bg-[#0f766e] text-white px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1 shadow"><i class="fa-solid fa-video"></i> Video</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Call History Section: sub-tab switching between "New Call" and "History"
        function switchCallSubTab(tab) {
            const newBtn = document.getElementById('callSubTabNewBtn');
            const historyBtn = document.getElementById('callSubTabHistoryBtn');
            const newView = document.getElementById('callNewSubView');
            const historyView = document.getElementById('callHistorySubView');

            const activeClass = "flex-1 py-1.5 rounded-xl text-[11px] font-bold transition bg-[#2563eb] text-white shadow";
            const inactiveClass = "flex-1 py-1.5 rounded-xl text-[11px] font-bold transition text-slate-400 hover:text-slate-200";

            if (tab === 'history') {
                newView.classList.add('hidden');
                historyView.classList.remove('hidden');
                newBtn.className = inactiveClass;
                historyBtn.className = activeClass;
                loadCallHistory();
            } else {
                historyView.classList.add('hidden');
                newView.classList.remove('hidden');
                newBtn.className = activeClass;
                historyBtn.className = inactiveClass;
            }
        }

        // Fetches call log (who called whom) from the 'calls' table using the 'offer' records
        async function loadCallHistory() {
            const container = document.getElementById('callHistoryContainer');
            if (!container) return;
            container.innerHTML = `<div class="p-6 text-center text-xs text-slate-400">Loading call history...</div>`;

            try {
                const { data: callLogs, error } = await supabaseClient
                    .from('calls')
                    .select('*')
                    .eq('status', 'offer')
                    .or(`caller_id.eq.${currentUser},callee_id.eq.${currentUser}`)
                    .order('created_at', { ascending: false })
                    .limit(50);

                if (error || !callLogs || callLogs.length === 0) {
                    container.innerHTML = `<div class="p-6 text-center text-xs text-slate-400">No call history yet.</div>`;
                    return;
                }

                container.innerHTML = callLogs.map(log => {
                    const isOutgoing = log.caller_id === currentUser;
                    const otherUser = isOutgoing ? log.callee_id : log.caller_id;
                    const av = globalProfilesCache[otherUser];
                    const callTime = log.created_at ? new Date(log.created_at) : null;
                    const timeLabel = callTime ? formatMessageTimestamp(callTime) : '';
                    const typeIcon = log.call_type === 'video' ? 'fa-video' : 'fa-phone';

                    return `
                        <div class="glass-panel rounded-2xl p-3 flex items-center justify-between text-xs">
                            <div class="flex items-center space-x-2.5 cursor-pointer" onclick="openProfile('${otherUser}')">
                                <div class="w-9 h-9 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden shadow">${av ? `<img src="${av}" class="w-full h-full object-cover">` : (otherUser ? otherUser.charAt(0).toUpperCase() : '?')}</div>
                                <div>
                                    <p class="font-bold text-slate-200">${otherUser}</p>
                                    <p class="text-[11px] ${isOutgoing ? 'text-[#38bdf8]' : 'text-emerald-400'} flex items-center gap-1">
                                        <i class="fa-solid ${isOutgoing ? 'fa-arrow-up-right' : 'fa-arrow-down-left'}"></i>
                                        ${isOutgoing ? 'Outgoing' : 'Incoming'} · <i class="fa-solid ${typeIcon}"></i> ${log.call_type === 'video' ? 'Video' : 'Audio'}
                                    </p>
                                </div>
                            </div>
                            <div class="flex flex-col items-end gap-1.5">
                                <span class="text-[11px] text-slate-400">${timeLabel}</span>
                                <button onclick="startRealCall('${otherUser}', '${log.call_type}')" class="bg-slate-800 hover:bg-slate-700 text-white w-7 h-7 rounded-full flex items-center justify-center transition"><i class="fa-solid ${typeIcon} text-[11px]"></i></button>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                console.error(e);
                container.innerHTML = `<div class="p-6 text-center text-xs text-slate-400">Could not load call history.</div>`;
            }
        }

        // True Cross-Device WebRTC Real-Time Calling Engine
        async function startRealCall(targetUser, type) {
            targetCallingUser = targetUser;
            const screen = document.getElementById('activeCallScreen');
            const nameTitle = document.getElementById('callingUserNameTitle');
            const statusText = document.getElementById('callStatusTimerText');
            const avatarBox = document.getElementById('callUserAvatarBox');
            const videoBtn = document.getElementById('callVideoBtn');
            const flipBtn = document.getElementById('callFlipBtn');
            const remoteVid = document.getElementById('remoteVideoElement');
            const localVid = document.getElementById('localVideoElement');
            const bgOverlay = document.getElementById('callBackgroundOverlay');

            nameTitle.innerText = `Calling ${targetUser}...`;
            statusText.innerText = 'Ringing other device...';
            const av = globalProfilesCache[targetUser];
            avatarBox.innerHTML = av ? `<img src="${av}" class="w-full h-full object-cover">` : targetUser.charAt(0).toUpperCase();
            bgOverlay.classList.remove('hidden');

            screen.classList.remove('hidden');
            isCallMuted = false;
            isCameraOff = false;
            document.getElementById('muteIconElement').className = "fa-solid fa-microphone";

            if (type === 'video') {
                videoBtn.classList.remove('hidden');
                flipBtn.classList.remove('hidden');
                remoteVid.classList.remove('hidden');
            } else {
                videoBtn.classList.add('hidden');
                flipBtn.classList.add('hidden');
                remoteVid.classList.add('hidden');
            }

            pendingIceCandidates = [];
            try {
                activeCallStream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: type === 'video' ? { facingMode: currentFacingMode } : false
                });

                localVid.srcObject = activeCallStream;

                peerConnection = new RTCPeerConnection(rtcConfig);
                activeCallStream.getTracks().forEach(track => peerConnection.addTrack(track, activeCallStream));

                peerConnection.ontrack = event => {
                    if (event.streams && event.streams[0]) {
                        remoteVid.srcObject = event.streams[0];
                        statusText.innerText = 'Connected in Real-Time';
                        bgOverlay.classList.add('hidden');
                        if (callNoAnswerTimeout) { clearTimeout(callNoAnswerTimeout); callNoAnswerTimeout = null; }
                    }
                };

                peerConnection.onicecandidate = async event => {
                    if (event.candidate) {
                        // _from tags who generated this candidate so the receiving side's own
                        // realtime filter (which can match rows it inserted itself) can tell the
                        // difference between "this is mine" and "this came from the other person".
                        await supabaseClient.from('calls').insert({
                            caller_id: currentUser,
                            callee_id: targetUser,
                            call_type: type,
                            status: 'ice',
                            ice_candidates: { ...event.candidate.toJSON(), _from: currentUser }
                        });
                    }
                };

                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);

                const { error: offerError } = await supabaseClient.from('calls').insert({
                    caller_id: currentUser,
                    callee_id: targetUser,
                    call_type: type,
                    status: 'offer',
                    sdp_offer: offer
                });
                if (offerError) {
                    console.error('[call offer insert failed]', offerError);
                    statusText.innerText = 'Call Failed: ' + offerError.message;
                    return;
                }

                // Listen for Answer from callee (reuse a single channel so repeat calls
                // don't stack duplicate subscriptions on top of each other)
                if (callAnswerChannel) {
                    supabaseClient.removeChannel(callAnswerChannel);
                    callAnswerChannel = null;
                }
                callAnswerChannel = supabaseClient.channel('public:call_answer_' + currentUser).on('postgres_changes', {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'calls',
                    filter: `caller_id=eq.${currentUser}`
                }, async payload => {
                    const record = payload.new;
                    if (record && record.status === 'answer' && record.sdp_answer && peerConnection) {
                        if (!peerConnection.currentRemoteDescription) {
                            await peerConnection.setRemoteDescription(new RTCSessionDescription(record.sdp_answer));
                            statusText.innerText = 'Connected in Real-Time';
                            bgOverlay.classList.add('hidden');
                            // Flush any ICE candidates that arrived before we had a remote description
                            while (pendingIceCandidates.length) {
                                const cand = pendingIceCandidates.shift();
                                try { await peerConnection.addIceCandidate(new RTCIceCandidate(cand)); } catch(e) { console.error(e); }
                            }
                        }
                    } else if (record && record.status === 'ice' && record.ice_candidates && peerConnection) {
                        // BUGFIX: this channel is filtered on caller_id=eq.<me>, but MY OWN outgoing
                        // ICE candidates above are also inserted with caller_id=<me> — so they used
                        // to loop straight back here and get fed into my own peer connection as if
                        // they'd come from the callee. That's what was corrupting the caller's side
                        // of the connection (call would ring/connect for the other person but never
                        // for me). Skip anything tagged as our own.
                        if (record.ice_candidates._from === currentUser) {
                            // our own candidate echoing back — ignore
                        } else if (peerConnection.remoteDescription) {
                            try {
                                await peerConnection.addIceCandidate(new RTCIceCandidate(record.ice_candidates));
                            } catch(e) { console.error(e); }
                        } else {
                            pendingIceCandidates.push(record.ice_candidates);
                        }
                    } else if (record && record.status === 'declined') {
                        // FIX: previously nothing told the caller the call was declined — the
                        // screen just sat on "Ringing other device..." forever.
                        statusText.innerText = 'Call Declined';
                        setTimeout(endCallUiOnly, 1200);
                    } else if (record && record.status === 'end') {
                        // FIX: the other person hung up — close our screen too instead of it
                        // being stuck on "Connected" with a dead connection.
                        statusText.innerText = 'Call Ended';
                        setTimeout(endCallUiOnly, 900);
                    }
                }).subscribe((status, err) => {
                    console.log('[call answer channel]', status, err || '');
                });

                // FIX: if nobody answers, the caller's screen used to sit on "Ringing..."
                // forever with no way out except force-closing the app. Auto-end after 45s.
                callNoAnswerTimeout = setTimeout(() => {
                    if (peerConnection && statusText.innerText !== 'Connected in Real-Time') {
                        statusText.innerText = 'No Answer';
                        setTimeout(endCallUiOnly, 1200);
                    }
                }, 45000);

            } catch (err) {
                statusText.innerText = "Call Failed: Camera/Mic Permission Denied";
            }
        }

        async function acceptIncomingCall() {
            if (!incomingCallData) return;
            document.getElementById('incomingCallModal').classList.add('hidden');

            const screen = document.getElementById('activeCallScreen');
            const nameTitle = document.getElementById('callingUserNameTitle');
            const statusText = document.getElementById('callStatusTimerText');
            const avatarBox = document.getElementById('callUserAvatarBox');
            const videoBtn = document.getElementById('callVideoBtn');
            const flipBtn = document.getElementById('callFlipBtn');
            const remoteVid = document.getElementById('remoteVideoElement');
            const localVid = document.getElementById('localVideoElement');
            const bgOverlay = document.getElementById('callBackgroundOverlay');

            targetCallingUser = incomingCallData.caller_id;
            nameTitle.innerText = `${targetCallingUser}`;
            statusText.innerText = 'Connecting live WebRTC call...';
            const av = globalProfilesCache[targetCallingUser];
            avatarBox.innerHTML = av ? `<img src="${av}" class="w-full h-full object-cover">` : targetCallingUser.charAt(0).toUpperCase();
            bgOverlay.classList.remove('hidden');

            screen.classList.remove('hidden');

            if (incomingCallData.call_type === 'video') {
                videoBtn.classList.remove('hidden');
                flipBtn.classList.remove('hidden');
                remoteVid.classList.remove('hidden');
            } else {
                videoBtn.classList.add('hidden');
                flipBtn.classList.add('hidden');
                remoteVid.classList.add('hidden');
            }

            pendingIceCandidates = [];
            try {
                activeCallStream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: incomingCallData.call_type === 'video' ? { facingMode: currentFacingMode } : false
                });

                localVid.srcObject = activeCallStream;

                peerConnection = new RTCPeerConnection(rtcConfig);
                activeCallStream.getTracks().forEach(track => peerConnection.addTrack(track, activeCallStream));

                peerConnection.ontrack = event => {
                    if (event.streams && event.streams[0]) {
                        remoteVid.srcObject = event.streams[0];
                        statusText.innerText = 'Connected in Real-Time';
                        bgOverlay.classList.add('hidden');
                    }
                };

                peerConnection.onicecandidate = async event => {
                    if (event.candidate) {
                        await supabaseClient.from('calls').insert({
                            caller_id: targetCallingUser,
                            callee_id: currentUser,
                            call_type: incomingCallData.call_type,
                            status: 'ice',
                            ice_candidates: { ...event.candidate.toJSON(), _from: currentUser }
                        });
                    }
                };

                await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingCallData.sdp_offer));

                // Flush ICE candidates that arrived from the caller before we accepted
                while (pendingIceCandidates.length) {
                    const cand = pendingIceCandidates.shift();
                    try { await peerConnection.addIceCandidate(new RTCIceCandidate(cand)); } catch(e) { console.error(e); }
                }

                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);

                await supabaseClient.from('calls').insert({
                    caller_id: targetCallingUser,
                    callee_id: currentUser,
                    call_type: incomingCallData.call_type,
                    status: 'answer',
                    sdp_answer: answer
                });

            } catch (err) {
                statusText.innerText = "Call Connection Failed";
            }
        }

        function rejectIncomingCall() {
            document.getElementById('incomingCallModal').classList.add('hidden');
            // FIX: previously declining sent NOTHING back to the caller, so their screen just
            // stayed on "Ringing other device..." forever with no idea the call was declined —
            // this is a big part of "call theek se connect nahi ho raha". Now we tell them.
            if (incomingCallData) {
                supabaseClient.from('calls').insert({
                    caller_id: incomingCallData.caller_id,
                    callee_id: currentUser,
                    call_type: incomingCallData.call_type,
                    status: 'declined'
                }).then(({ error }) => { if (error) console.error('[decline signal failed]', error); });
            }
            incomingCallData = null;
        }

        function toggleCallMute() {
            if (!activeCallStream) return;
            isCallMuted = !isCallMuted;
            activeCallStream.getAudioTracks().forEach(track => { track.enabled = !isCallMuted; });
            document.getElementById('muteIconElement').className = isCallMuted ? "fa-solid fa-microphone-slash text-red-400" : "fa-solid fa-microphone";
        }

        function toggleCallVideo() {
            if (!activeCallStream) return;
            isCameraOff = !isCameraOff;
            activeCallStream.getVideoTracks().forEach(track => { track.enabled = !isCameraOff; });
            document.getElementById('videoIconElement').className = isCameraOff ? "fa-solid fa-video-slash text-red-400" : "fa-solid fa-video";
        }

        async function flipCameraView() {
            currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
            if (activeCallStream) {
                activeCallStream.getTracks().forEach(track => track.stop());
            }
            try {
                activeCallStream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: { facingMode: currentFacingMode }
                });
                document.getElementById('localVideoElement').srcObject = activeCallStream;
                if (peerConnection) {
                    const videoSender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (videoSender) {
                        videoSender.replaceTrack(activeCallStream.getVideoTracks()[0]);
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        function toggleAudioOutputRoute() {
            isEarpieceAudio = !isEarpieceAudio;
            const textEl = document.getElementById('audioRouteText');
            const iconEl = document.getElementById('audioRouteIcon');
            
            if (isEarpieceAudio) {
                textEl.innerText = "Earpiece/Headphone";
                iconEl.className = "fa-solid fa-headphones";
            } else {
                textEl.innerText = "Speaker";
                iconEl.className = "fa-solid fa-volume-high";
            }
        }

        function terminateActiveCall() {
            // FIX: hanging up never told the OTHER person the call ended — their screen would
            // stay stuck on "Connected"/"Ringing" indefinitely with a dead peer connection.
            // Send an explicit 'end' signal to whoever we were in a call with (both directions,
            // since we don't always know if we were the original caller or callee).
            if (targetCallingUser) {
                supabaseClient.from('calls').insert({
                    caller_id: currentUser,
                    callee_id: targetCallingUser,
                    status: 'end'
                }).then(({ error }) => { if (error) console.error('[end signal failed]', error); });
                supabaseClient.from('calls').insert({
                    caller_id: targetCallingUser,
                    callee_id: currentUser,
                    status: 'end'
                }).then(({ error }) => { if (error) console.error('[end signal failed]', error); });
            }
            endCallUiOnly();
        }

        // Local-only cleanup — stops media/peer connection and hides the call screen WITHOUT
        // sending any signal. Used both when WE hang up (after sending the 'end' signal above)
        // and when we RECEIVE an 'end'/'declined' signal from the other party (so we don't
        // bounce another signal back and forth forever).
        function endCallUiOnly() {
            targetCallingUser = null;
            if (callNoAnswerTimeout) { clearTimeout(callNoAnswerTimeout); callNoAnswerTimeout = null; }
            if (activeCallStream) {
                activeCallStream.getTracks().forEach(track => track.stop());
                activeCallStream = null;
            }
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            if (callAnswerChannel) {
                supabaseClient.removeChannel(callAnswerChannel);
                callAnswerChannel = null;
            }
            pendingIceCandidates = [];
            document.getElementById('activeCallScreen').classList.add('hidden');
            document.getElementById('incomingCallModal').classList.add('hidden');
            incomingCallData = null;
        }

        // Live fallback: query the "profiles" table directly by username instead of relying only
        // on the local cachedAllUsers list. cachedAllUsers is built from posts/messages activity
        // and can miss a user (e.g. right after all chats with them were deleted, or before any
        // interaction ever happened). This guarantees ANY registered user is always findable.
        async function liveSearchProfilesByUsername(q) {
            try {
                const { data, error } = await supabaseClient
                    .from('profiles')
                    .select('username')
                    .ilike('username', `%${q}%`)
                    .limit(20);
                if (error) { console.error("liveSearchProfilesByUsername error:", error); return []; }
                return (data || []).map(p => p.username).filter(Boolean);
            } catch (err) {
                console.error("liveSearchProfilesByUsername failed:", err);
                return [];
            }
        }

        // Unified search: users + hashtags + posts, all from one search bar, grouped in the dropdown
        async function handleGlobalSearch(query) {
            const dropdown = document.getElementById('searchResultsDropdown');
            const q = query.trim().toLowerCase();
            const searchToken = (handleGlobalSearch._token = (handleGlobalSearch._token || 0) + 1);
            if(!q) {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
                return;
            }

            logSearchHistory(query.trim()); // FEATURE: SEARCH HISTORY — debounced, logged once typing settles

            const closeDropdown = `document.getElementById('searchResultsDropdown').classList.add('hidden'); document.getElementById('globalUserSearch').value='';`;

            // --- Users: merge cached matches with a live DB lookup so a user is always
            // found even if they have no posts/messages in the local cache right now ---
            const liveUsers = await liveSearchProfilesByUsername(q);
            if (searchToken !== handleGlobalSearch._token) return; // a newer keystroke superseded this search

            const allPossible = [currentUser, ...cachedAllUsers, ...liveUsers];
            const userMatches = [...new Set(allPossible)].filter(u => u && u.toLowerCase().includes(q) && !isBlockedWith(u));

            // --- Hashtags (derived from post content) ---
            const hashtagSet = new Set();
            globalPostsCache.forEach(p => extractHashtags(p.content).forEach(t => hashtagSet.add(t)));
            const hashtagMatches = [...hashtagSet].filter(t => t.includes(q.startsWith('#') ? q : '#' + q) || t.includes(q));

            // --- Posts (by content text) ---
            const postMatches = globalPostsCache.filter(p => p.content && p.content.toLowerCase().includes(q) && !isBlockedWith(p.username) && !isPrivateAndNotFollowing(p.username)).slice(0, 8);

            if (userMatches.length === 0 && hashtagMatches.length === 0 && postMatches.length === 0) {
                dropdown.innerHTML = `<div class="p-3 text-xs text-slate-400 text-center">No results found</div>`;
                dropdown.classList.remove('hidden');
                return;
            }

            let html = '';

            if (userMatches.length > 0) {
                html += `<div class="px-2.5 pt-2 pb-1 text-[11px] font-bold tracking-wide text-slate-400">Users</div>`;
                userMatches.forEach(u => {
                    const av = globalProfilesCache[u];
                    html += `
                        <div onclick="handleUserClick('${u}'); ${closeDropdown}" class="p-2.5 flex items-center space-x-2.5 cursor-pointer hover:bg-slate-800/80 text-xs font-bold text-slate-200">
                            <div class="w-6 h-6 rounded-full bg-[#334155] flex items-center justify-center text-[11px] text-white overflow-hidden">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                            <span class="flex items-center gap-1">${u} ${verifiedBadgeHtml(u)} ${adminBadgeHtml(u)} ${u === currentUser ? '(You)' : ''}</span>
                        </div>
                    `;
                });
            }

            if (hashtagMatches.length > 0) {
                html += `<div class="px-2.5 pt-2 pb-1 text-[11px] font-bold tracking-wide text-slate-400 border-t border-slate-800">Hashtags</div>`;
                hashtagMatches.slice(0, 8).forEach(tag => {
                    const count = globalPostsCache.filter(p => extractHashtags(p.content).includes(tag)).length;
                    html += `
                        <div onclick="jumpToExploreHashtag('${tag}'); ${closeDropdown}" class="p-2.5 flex items-center space-x-2.5 cursor-pointer hover:bg-slate-800/80 text-xs font-bold text-[#38bdf8]">
                            <div class="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-[11px]"><i class="fa-solid fa-hashtag"></i></div>
                            <span>${tag} <span class="text-slate-400 font-normal">· ${count} post${count === 1 ? '' : 's'}</span></span>
                        </div>
                    `;
                });
            }

            if (postMatches.length > 0) {
                html += `<div class="px-2.5 pt-2 pb-1 text-[11px] font-bold tracking-wide text-slate-400 border-t border-slate-800">Posts</div>`;
                postMatches.forEach(p => {
                    html += `
                        <div onclick="openPostDetailModal('${p.id}'); ${closeDropdown}" class="p-2.5 flex items-center space-x-2.5 cursor-pointer hover:bg-slate-800/80 text-xs text-slate-300">
                            <div class="w-6 h-6 rounded-full bg-[#334155] flex items-center justify-center text-[11px] text-white overflow-hidden shrink-0">${globalProfilesCache[p.username] ? `<img src="${globalProfilesCache[p.username]}" class="w-full h-full object-cover">` : p.username.charAt(0).toUpperCase()}</div>
                            <span class="truncate"><span class="font-bold text-slate-200">${p.username}:</span> ${p.content}</span>
                        </div>
                    `;
                });
            }

            dropdown.innerHTML = html;
            dropdown.classList.remove('hidden');
        }

        // =====================================================================================
        // FEATURE: SEARCH HISTORY — logs what the user searched, for the "My Activity → Search
        // History" page. Debounced (900ms after typing settles) so we don't insert a row per
        // keystroke — only once the user has actually paused on a real query.
        // =====================================================================================
        function logSearchHistory(query) {
            const q = (query || '').trim();
            if (!q || q.length < 2) return;
            clearTimeout(searchHistoryLogTimer);
            searchHistoryLogTimer = setTimeout(async () => {
                try {
                    const { error } = await supabaseClient.from('search_history').insert({ username: currentUser, query: q });
                    if (error) throw error;
                    searchHistoryFeatureAvailable = true;
                } catch (err) {
                    console.error('logSearchHistory failed (search_history table setup baaki hai?):', err);
                    searchHistoryFeatureAvailable = false;
                }
            }, 900);
        }

        function handleUserClick(username) {
            if (username === currentUser) {
                openProfile(currentUser);
            } else {
                openUserActionModal(username);
            }
        }

        function openUserActionModal(username) {
            document.getElementById('actionModalUsername').innerText = username;
            const av = globalProfilesCache[username];
            document.getElementById('actionModalAvatar').innerHTML = av ? `<img src="${av}" class="w-full h-full object-cover">` : username.charAt(0).toUpperCase();
            
            document.getElementById('actionMsgBtn').onclick = () => {
                closeUserActionModal();
                switchTab('chat');
                selectChatUser(username, true);
            };

            document.getElementById('actionProfileBtn').onclick = () => {
                closeUserActionModal();
                openProfile(username);
            };

            const isBlocked = globalBlockedCache.some(b => b.blocker === currentUser && b.blocked === username);
            document.getElementById('actionBlockBtnLabel').innerText = isBlocked ? 'Unblock' : 'Block';
            document.getElementById('actionBlockBtn').onclick = () => toggleBlockUser(username);
            document.getElementById('actionReportBtn').onclick = () => openReportUserModal(username);

            document.getElementById('userActionModal').classList.remove('hidden');
        }

        function closeUserActionModal() {
            document.getElementById('userActionModal').classList.add('hidden');
        }

        function openProfile(username, resetTab = true) {
            ensureUserPostsLoaded(username); // PERF: older posts of this profile are fetched on demand
            const isNewProfileView = viewingProfileUsername !== username;
            viewingProfileUsername = username;
            if (resetTab) profileActiveTab = 'posts';
            if (isNewProfileView) resetProfileFlipToFront();
            // Collapse the persona panel again whenever a different profile is opened
            const personaPanel = document.getElementById('personaCardsContainer');
            const personaChevron = document.getElementById('personaPanelChevron');
            if (isNewProfileView && personaPanel) { personaPanel.classList.add('hidden'); if (personaChevron) personaChevron.style.transform = ''; }

            document.getElementById('modalUsernameHeader').innerText = username;
            document.getElementById('modalUsernameText').innerText = username;
            document.getElementById('modalVerifiedBadge').classList.toggle('hidden', !isUserVerified(username));
            document.getElementById('modalAdminBadge').classList.toggle('hidden', username !== NEXUS_ADMIN_USERNAME);
            const av = globalProfilesCache[username];
            document.getElementById('modalUserAvatar').innerHTML = av ? `<img src="${av}" class="w-full h-full object-cover">` : username.charAt(0).toUpperCase();
            
            const isMe = username === currentUser;
            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — a private account's stats/mood/streak/DNA/
            // persona bios/Q&A stay hidden from anyone who isn't following (or isn't the owner).
            const locked = !isMe && isPrivateAndNotFollowing(username);
            const editSection = document.getElementById('editProfileSection');
            const otherActions = document.getElementById('profileOtherActions');
            const editAvatarBtn = document.getElementById('profileAvatarEditBtn');
            const flipBtn = document.getElementById('profileFlipBtn');
            if (flipBtn) flipBtn.classList.toggle('hidden', locked);

            if (isMe) {
                editSection.classList.remove('hidden');
                document.getElementById('privacyTogglesCard').classList.remove('hidden');
                otherActions.classList.add('hidden');
                editAvatarBtn.classList.remove('hidden');
                editAvatarBtn.classList.add('flex');
                document.getElementById('editUsernameInput').value = currentUser;
                const myFull = globalProfilesFullCache[currentUser] || {};

                // Reflect current private-account state on the toggle switch
                renderPrivateAccountToggle();
                renderGhostModeToggle();
                renderAwayModeToggle();
                const hsBtn = document.getElementById('handshakeEntryBtn');
                if (hsBtn) { hsBtn.classList.remove('hidden'); hsBtn.classList.add('flex'); }
            } else {
                const hsBtn = document.getElementById('handshakeEntryBtn');
                if (hsBtn) { hsBtn.classList.add('hidden'); hsBtn.classList.remove('flex'); }
                editSection.classList.add('hidden');
                document.getElementById('privacyTogglesCard').classList.add('hidden');
                otherActions.classList.remove('hidden');
                editAvatarBtn.classList.add('hidden');
                editAvatarBtn.classList.remove('flex');

                document.getElementById('profileModalChatBtn').onclick = () => {
                    closeProfileModal();
                    switchTab('chat');
                    selectChatUser(username, true);
                };

            }

            // FEATURE: NEXUS ADMIN VERIFICATION — only NEXUS sees this; NEXUS can verify anyone,
            // including its own profile.
            const verifyBtn = document.getElementById('profileVerifyBtn');
            if (verifyBtn) {
                if (isNexusAdmin()) {
                    verifyBtn.classList.remove('hidden');
                    verifyBtn.classList.add('flex');
                    const verified = isUserVerified(username);
                    verifyBtn.className = `w-full py-2 rounded-xl text-xs font-bold transition border flex items-center justify-center gap-1.5 ${verified ? 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700' : 'bg-[#38bdf8]/10 border-[#38bdf8]/40 text-[#38bdf8] hover:bg-[#38bdf8]/20'}`;
                    verifyBtn.innerHTML = verified
                        ? `<i class="fa-solid fa-circle-xmark"></i> Remove Blue Tick`
                        : `<i class="fa-solid fa-circle-check"></i> Give Blue Tick`;
                } else {
                    verifyBtn.classList.add('hidden');
                    verifyBtn.classList.remove('flex');
                }
            }

            // Dedupe by account: one account can now hold up to 3 persona-follow rows for the
            // same follower/following pair (one per face), so count distinct accounts, not rows.
            const followersList = globalFollowsCache.filter(f => f.following === username);
            const followingList = globalFollowsCache.filter(f => f.follower === username);
            const userPostsAll = globalPostsCache.filter(p => p.username === username);

            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — no counts for non-followers of a private account
            if (locked) {
                document.getElementById('profileFollowersCount').innerText = '🔒';
                document.getElementById('profileFollowingCount').innerText = '🔒';
                document.getElementById('profilePostsCount').innerText = '🔒';
            } else {
                document.getElementById('profileFollowersCount').innerText = new Set(followersList.map(f => f.follower)).size;
                document.getElementById('profileFollowingCount').innerText = new Set(followingList.map(f => f.following)).size;
                document.getElementById('profilePostsCount').innerText = userPostsAll.length;
            }

            // FEATURE: CLOSE FRIENDS — only relevant on someone else's profile, and only once
            // I'm actually allowed to see this profile (not a locked private account)
            const closeFriendWrap = document.getElementById('closeFriendToggleWrap');
            if (!isMe && !locked) {
                closeFriendWrap.classList.remove('hidden');
                closeFriendWrap.classList.add('flex');
                renderCloseFriendToggle(username);
            } else {
                closeFriendWrap.classList.add('hidden');
            }

            renderPersonaHub(username, isMe);
            refreshProfileTabView(); // FEATURE: PROFILE GROUPS/CHANNELS TAB
            if (profileFlipped && !locked) renderNewFeaturesPanel(username, isMe);
            document.getElementById('profileModal').classList.remove('hidden');
        }

        // =====================================================================================
        // FEATURE: PROFILE FLIP — flips the profile card (with a quick 3D animation) to reveal
        // the panel of extra features (security, activity, settings).
        // =====================================================================================
        function resetProfileFlipToFront() {
            profileFlipped = false;
            const card = document.getElementById('profileFlipCard');
            const front = document.getElementById('profileFrontFace');
            const back = document.getElementById('profileBackFace');
            if (card) card.style.transform = 'rotateY(0deg)';
            if (front) front.classList.remove('hidden');
            if (back) back.classList.add('hidden');
        }

        function toggleProfileFlip() {
            const card = document.getElementById('profileFlipCard');
            const front = document.getElementById('profileFrontFace');
            const back = document.getElementById('profileBackFace');
            const icon = document.getElementById('profileFlipBtnIcon');
            const scrollWrap = card ? card.parentElement : null;
            if (!card || !front || !back) return;

            if (scrollWrap) scrollWrap.scrollTop = 0;
            card.style.transform = 'rotateY(90deg)';

            setTimeout(() => {
                profileFlipped = !profileFlipped;
                front.classList.toggle('hidden', profileFlipped);
                back.classList.toggle('hidden', !profileFlipped);
                if (icon) icon.className = profileFlipped ? 'fa-solid fa-rotate-left text-xs text-[#60a5fa]' : 'fa-solid fa-rotate text-xs';
                if (profileFlipped) renderNewFeaturesPanel(viewingProfileUsername, viewingProfileUsername === currentUser);

                card.style.transform = 'rotateY(-90deg)';
                requestAnimationFrame(() => { card.style.transform = 'rotateY(0deg)'; });
            }, 220);
        }

        function renderNewFeaturesPanel(username, isMe) {
            if (!username) return;
            renderAccountSecurityCard(isMe);
            renderMyActivityCard(isMe);
            renderBlockedUsersCard(isMe);
            renderDataExportCard(isMe);
            renderTrueDeleteCard(isMe);
            renderNexusUniverseCard(username, isMe);
            renderOfflineModeCard(isMe);
            renderScreenshotAlertCard(isMe);
            renderLanguageCard(isMe);
            renderNotifSoundCard(isMe);
        }

        // =====================================================================================
        // FEATURE: BLOCKED USERS MANAGEMENT — lives on your own profile flip page. Lists
        // everyone you've blocked with a one-tap Unblock button, so you don't have to hunt
        // down each person's profile again just to undo a block.
        // =====================================================================================
        async function renderBlockedUsersCard(isMe) {
            const wrap = document.getElementById('blockedUsersCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }

            let count = 0;
            try {
                const { count: c, error } = await supabaseClient.from('blocked_users').select('id', { count: 'exact', head: true }).eq('blocker', currentUser);
                if (error) throw error;
                count = c || 0;
            } catch (err) {
                console.error("renderBlockedUsersCard: blocked_users count failed:", err);
            }

            // FEATURE: BLOCKED USERS now opens as its own full page (see openActivityList('blocked'))
            // instead of showing the list inline here.
            wrap.innerHTML = `
                <button onclick="openActivityList('blocked')" class="w-full flex items-center gap-2.5 text-left">
                    <div class="w-8 h-8 rounded-xl bg-red-500/15 text-red-400 flex items-center justify-center shrink-0"><i class="fa-solid fa-user-slash"></i></div>
                    <div class="flex-1 min-w-0">
                        <p class="text-[11px] font-bold text-slate-300">Blocked Users${count ? ` (${count})` : ''}</p>
                        <p class="text-[11px] text-slate-400">Manage jinhe tumne block kiya hai</p>
                    </div>
                    <i class="fa-solid fa-chevron-right text-slate-400 text-xs"></i>
                </button>
            `;
        }

        // Unblock from the Blocked Users activity page — no confirm() popup needed since
        // unblocking is a harmless, reversible action (unlike blocking).
        async function unblockUserFromCard(username) {
            try {
                await supabaseClient.from('blocked_users').delete().eq('blocker', currentUser).eq('blocked', username);
                await fetchAllData();
                showAlertBanner(`${username} ko unblock kar diya.`, 'success');
                renderBlockedUsersCard(true);
                if (activityListMode === 'blocked') renderActivityList('blocked');
            } catch (err) {
                console.error("unblockUserFromCard failed:", err);
                showAlertBanner('Unblock nahi ho paaya, dobara try karo.', 'error');
            }
        }

        // =====================================================================================
        // FEATURE: MY ACTIVITY — button on the profile flip page that opens a hub with 4
        // options (Likes / Comments / Save / Search History), each opening a full-page list.
        // =====================================================================================
        function renderMyActivityCard(isMe) {
            const wrap = document.getElementById('myActivityCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            wrap.innerHTML = `
                <button onclick="openMyActivityModal()" class="w-full flex items-center gap-2.5 text-left">
                    <div class="w-8 h-8 rounded-xl bg-[#0f766e]/15 text-[#2dd4bf] flex items-center justify-center shrink-0"><i class="fa-solid fa-clock-rotate-left"></i></div>
                    <div class="flex-1 min-w-0">
                        <p class="text-[11px] font-bold text-slate-300">My Activity</p>
                        <p class="text-[11px] text-slate-400">Likes, comments, saves &amp; search history</p>
                    </div>
                    <i class="fa-solid fa-chevron-right text-slate-400 text-xs"></i>
                </button>
            `;
        }

        function openMyActivityModal() {
            document.getElementById('myActivityModal').classList.remove('hidden');
        }

        function closeMyActivityModal() {
            document.getElementById('myActivityModal').classList.add('hidden');
        }

        // =====================================================================================
        // FEATURE: ACTIVITY LIST PAGE — shared full-page list for Likes / Comments / Save /
        // Search History (opened from My Activity) and Blocked Users (opened from the profile
        // flip page directly). Renders a 3-col post/reel grid for the first three, a vertical
        // list for Search History, and a vertical user list for Blocked.
        // =====================================================================================
        const ACTIVITY_LIST_META = {
            likes:    { title: 'Likes',          empty: 'Tumne abhi tak kisi post/reel ko like nahi kiya.' },
            comments: { title: 'Comments',        empty: 'Tumne abhi tak kisi post/reel pe comment nahi kiya.' },
            saved:    { title: 'Saved',           empty: 'Tumne abhi tak koi post/reel save nahi kiya.' },
            search:   { title: 'Search History',  empty: 'Koi search history nahi mili.' },
            blocked:  { title: 'Blocked Users',   empty: 'Aapne abhi tak kisi ko block nahi kiya.' }
        };

        function openActivityList(mode) {
            activityListMode = mode;
            const meta = ACTIVITY_LIST_META[mode] || { title: 'Activity' };
            document.getElementById('activityListTitle').innerText = meta.title;
            const clearBtn = document.getElementById('activityListClearBtn');
            const spacer = document.getElementById('activityListSpacer');
            const showClear = mode === 'search';
            clearBtn.classList.toggle('hidden', !showClear);
            spacer.classList.toggle('hidden', showClear);
            document.getElementById('activityListBody').innerHTML = `<div class="text-center text-xs text-slate-400 py-14"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Loading...</div>`;
            document.getElementById('activityListModal').classList.remove('hidden');
            renderActivityList(mode);
        }

        function closeActivityListModal() {
            document.getElementById('activityListModal').classList.add('hidden');
            activityListMode = null;
        }

        // Shared 3-col thumbnail grid — same markup style as the profile grid (renderProfileGrid).
        function buildActivityPostsGridHtml(posts) {
            return `<div class="grid grid-cols-3 gap-1">${posts.map(post => {
                const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
                return `
                    <div onclick="openPostDetailModal('${post.id}')" class="aspect-square bg-slate-900 border border-slate-800/80 rounded-sm overflow-hidden relative cursor-pointer group">
                        ${isVideo ?
                            `<video src="${post.image_url}" class="w-full h-full object-cover"></video><div class="absolute top-1.5 right-1.5 bg-black/60 px-1.5 py-0.5 rounded text-[11px] text-white"><i class="fa-solid fa-clapperboard"></i></div>` :
                            post.image_url ?
                                `<img src="${post.image_url}" class="w-full h-full object-cover">` :
                                `<div class="w-full h-full p-2 flex items-center justify-center text-[11px] text-slate-300 text-center bg-slate-950">${(post.content || '').substring(0, 40)}...</div>`
                        }
                        <div class="absolute top-1.5 left-1.5 text-[11px] text-slate-300 bg-black/50 px-1.5 py-0.5 rounded-full truncate max-w-[90%]">@${post.username}</div>
                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center space-x-3 text-white text-xs font-bold">
                            <span><i class="fa-solid fa-heart mr-1"></i>${globalLikesCache.filter(l => l.post_id === post.id).length}</span>
                            <span><i class="fa-solid fa-comment mr-1"></i>${globalCommentsCache.filter(c => c.post_id === post.id).length}</span>
                        </div>
                    </div>
                `;
            }).join('')}</div>`;
        }

        async function renderActivityList(mode) {
            const body = document.getElementById('activityListBody');
            const meta = ACTIVITY_LIST_META[mode] || { empty: 'Kuch nahi mila.' };

            if (mode === 'likes' || mode === 'comments' || mode === 'saved') {
                let postIds;
                if (mode === 'likes') postIds = globalLikesCache.filter(l => l.username === currentUser).map(l => l.post_id);
                else if (mode === 'comments') postIds = globalCommentsCache.filter(c => c.username === currentUser).map(c => c.post_id);
                else postIds = globalSavedPostsCache.filter(s => s.username === currentUser).map(s => s.post_id);

                const uniqueIds = [...new Set(postIds.map(String))];
                const posts = uniqueIds.map(id => globalPostsCache.find(p => String(p.id) === id)).filter(Boolean);

                if (mode === 'saved' && !savedPostsFeatureAvailable) {
                    body.innerHTML = `<p class="text-[11px] text-amber-400 text-center py-10"><i class="fa-solid fa-triangle-exclamation mr-1"></i>saved_posts table setup baaki hai Supabase me.</p>`;
                    return;
                }

                body.innerHTML = posts.length === 0
                    ? `<p class="text-center text-xs text-slate-400 py-14">${meta.empty}</p>`
                    : buildActivityPostsGridHtml(posts);
                return;
            }

            if (mode === 'search') {
                try {
                    const { data, error } = await supabaseClient.from('search_history').select('*').eq('username', currentUser).order('created_at', { ascending: false }).limit(100);
                    if (error) throw error;
                    searchHistoryFeatureAvailable = true;
                    // Dedupe by query text, keeping only the most recent occurrence of each.
                    const seen = new Set();
                    searchHistoryCache = (data || []).filter(row => {
                        const key = row.query.toLowerCase();
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                } catch (err) {
                    console.error("renderActivityList(search) failed (search_history table setup baaki hai?):", err);
                    searchHistoryFeatureAvailable = false;
                    body.innerHTML = `<p class="text-[11px] text-amber-400 text-center py-10"><i class="fa-solid fa-triangle-exclamation mr-1"></i>search_history table setup baaki hai Supabase me.</p>`;
                    return;
                }

                if (searchHistoryCache.length === 0) {
                    body.innerHTML = `<p class="text-center text-xs text-slate-400 py-14">${meta.empty}</p>`;
                    return;
                }

                body.innerHTML = `<div class="space-y-1.5">${searchHistoryCache.map(row => `
                    <div class="flex items-center justify-between bg-slate-950/60 rounded-xl px-3 py-2.5 gap-2">
                        <div onclick="reRunSearchFromHistory('${row.query.replace(/'/g, "\\'")}')" class="flex items-center gap-2.5 min-w-0 cursor-pointer flex-1">
                            <i class="fa-solid fa-clock-rotate-left text-slate-400 text-xs shrink-0"></i>
                            <span class="text-xs text-slate-200 truncate">${row.query}</span>
                        </div>
                        <button onclick="deleteSearchHistoryItem('${row.id}')" class="shrink-0 text-slate-400 hover:text-red-400 text-xs transition px-1"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                `).join('')}</div>`;
                return;
            }

            if (mode === 'blocked') {
                let blocked = [];
                try {
                    const { data, error } = await supabaseClient.from('blocked_users').select('*').eq('blocker', currentUser);
                    if (error) throw error;
                    blocked = data || [];
                } catch (err) {
                    console.error("renderActivityList(blocked) failed:", err);
                    body.innerHTML = `<p class="text-[11px] text-amber-400 text-center py-10"><i class="fa-solid fa-triangle-exclamation mr-1"></i>blocked_users table/RLS check karo Supabase me.</p>`;
                    return;
                }

                if (blocked.length === 0) {
                    body.innerHTML = `<p class="text-center text-xs text-slate-400 py-14">${meta.empty}</p>`;
                    return;
                }

                body.innerHTML = `<div class="space-y-1.5">${blocked.map(b => {
                    const u = b.blocked;
                    const av = globalProfilesCache[u];
                    return `
                        <div class="flex items-center justify-between bg-slate-950/60 rounded-xl px-2.5 py-2 gap-2">
                            <div class="flex items-center gap-2 min-w-0 cursor-pointer" onclick="openProfile('${u}')">
                                <div class="w-7 h-7 rounded-full bg-[#334155] flex items-center justify-center text-[11px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                                <span class="text-[11px] font-bold text-slate-200 truncate">${u}</span>
                            </div>
                            <button onclick="unblockUserFromCard('${u}')" class="shrink-0 bg-slate-800 hover:bg-emerald-600 text-emerald-400 hover:text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition"><i class="fa-solid fa-lock-open mr-1"></i>Unblock</button>
                        </div>
                    `;
                }).join('')}</div>`;
                return;
            }
        }

        // Tapping a past query re-runs it in the main search bar (Chat/Feed section's global search).
        function reRunSearchFromHistory(query) {
            closeActivityListModal();
            closeMyActivityModal();
            closeProfileModal();
            const input = document.getElementById('globalUserSearch');
            if (input) {
                input.value = query;
                handleGlobalSearch(query);
                input.focus();
            }
        }

        async function deleteSearchHistoryItem(id) {
            try {
                const { error } = await supabaseClient.from('search_history').delete().eq('id', id);
                if (error) throw error;
                renderActivityList('search');
            } catch (err) {
                console.error("deleteSearchHistoryItem failed:", err);
                showAlertBanner('Delete nahi ho paaya, dobara try karo.', 'error');
            }
        }

        async function clearActivityList() {
            if (activityListMode !== 'search') return;
            try {
                const { error } = await supabaseClient.from('search_history').delete().eq('username', currentUser);
                if (error) throw error;
                renderActivityList('search');
                showAlertBanner('Search history clear kar di.', 'success');
            } catch (err) {
                console.error("clearActivityList failed:", err);
                showAlertBanner('Clear nahi ho paaya, dobara try karo.', 'error');
            }
        }

        // =====================================================================================
        // FEATURE: TWO-FACTOR AUTHENTICATION + CHANGE PASSWORD + SECURITY QUESTION
        // Lives on the profile flip page. New signups already have 2FA on; existing users get a
        // once-a-day reminder (see checkDailyTwoFaReminder) until they set it up here.
        // =====================================================================================
        let currentProfileSecurityInfo = null;

        async function renderAccountSecurityCard(isMe) {
            const wrap = document.getElementById('accountSecurityCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }

            wrap.innerHTML = `<p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-shield-halved text-[#2dd4bf]"></i> Account Security</p><p class="text-[11px] text-slate-400">Loading...</p>`;

            const { data: profile, error } = await supabaseClient.from('profiles').select('two_factor_enabled, security_question').eq('username', currentUser).maybeSingle();
            if (error) {
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-shield-halved text-[#2dd4bf]"></i> Account Security</p>
                    <p class="text-[11px] text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>2FA / Password reset ke liye ek chhoti si SQL setup baaki hai — upar comment me diye gaye ALTER TABLE statements Supabase me run karo.</p>
                `;
                return;
            }

            currentProfileSecurityInfo = profile || {};
            const twoFaOn = !!(profile && profile.two_factor_enabled);
            const hasSecurityQ = !!(profile && profile.security_question);

            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-shield-halved text-[#2dd4bf]"></i> Account Security</p>
                <div class="flex items-center justify-between bg-slate-950/60 rounded-xl px-2.5 py-2">
                    <span class="text-[11px] text-slate-300">Two-Factor Authentication</span>
                    <span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${twoFaOn ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/15 text-red-400 border border-red-500/30'}">${twoFaOn ? 'ON' : 'OFF'}</span>
                </div>
                <button onclick="openTwoFactorSetupModal()" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-2 rounded-xl text-xs text-[#2dd4bf] transition"><i class="fa-solid fa-shield-halved mr-1"></i> ${twoFaOn ? 'Change 2FA PIN' : 'Set Up 2FA'}</button>
                <button onclick="openChangePasswordModal()" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-2 rounded-xl text-xs text-[#38bdf8] transition"><i class="fa-solid fa-key mr-1"></i> Change Password</button>
                ${!hasSecurityQ ? `<button onclick="openSecurityQuestionSetupModal()" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-2 rounded-xl text-xs text-slate-300 transition"><i class="fa-solid fa-circle-question mr-1"></i> Set Security Question (for password reset)</button>` : `<p class="text-[11px] text-slate-400 px-1"><i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>Security question set — password reset ready.</p>`}
            `;
        }

        function openTwoFactorSetupModal() {
            document.getElementById('tfaNewPin').value = '';
            document.getElementById('tfaNewPinConfirm').value = '';
            document.getElementById('tfaSetupError').classList.add('hidden');
            document.getElementById('twoFactorSetupModal').classList.remove('hidden');
            document.getElementById('twoFactorSetupModal').classList.add('flex');
        }
        function closeTwoFactorSetupModal() {
            document.getElementById('twoFactorSetupModal').classList.add('hidden');
            document.getElementById('twoFactorSetupModal').classList.remove('flex');
        }
        async function saveTwoFactorPin() {
            const pin = document.getElementById('tfaNewPin').value.trim();
            const confirm = document.getElementById('tfaNewPinConfirm').value.trim();
            const errEl = document.getElementById('tfaSetupError');
            if (!/^\d{4,6}$/.test(pin)) { errEl.innerText = 'PIN sirf 4-6 digits ka hona chahiye.'; errEl.classList.remove('hidden'); return; }
            if (pin !== confirm) { errEl.innerText = 'PINs match nahi kar rahe.'; errEl.classList.remove('hidden'); return; }

            const { data: result, error } = await supabaseClient.rpc('rpc_set_2fa', { p_username: currentUser, p_pin: pin });
            if (error || !result.ok) {
                errEl.innerText = 'Save nahi ho paaya — security_migration.sql run karo.';
                errEl.classList.remove('hidden');
                return;
            }
            localStorage.removeItem(`nexus_2fa_reminder_${currentUser}`);
            closeTwoFactorSetupModal();
            showAlertBanner('2FA on ho gaya! Ab agli baar login karte waqt PIN maanga jayega.', 'success');
            renderAccountSecurityCard(true);
        }
        window.openTwoFactorSetupModal = openTwoFactorSetupModal;
        window.closeTwoFactorSetupModal = closeTwoFactorSetupModal;
        window.saveTwoFactorPin = saveTwoFactorPin;

        function openChangePasswordModal() {
            document.getElementById('cpCurrentPassword').value = '';
            document.getElementById('cpNewPassword').value = '';
            document.getElementById('cpNewPasswordConfirm').value = '';
            document.getElementById('cpError').classList.add('hidden');
            document.getElementById('changePasswordModal').classList.remove('hidden');
            document.getElementById('changePasswordModal').classList.add('flex');
        }
        function closeChangePasswordModal() {
            document.getElementById('changePasswordModal').classList.add('hidden');
            document.getElementById('changePasswordModal').classList.remove('flex');
        }
        async function submitChangePassword() {
            const current = document.getElementById('cpCurrentPassword').value;
            const next = document.getElementById('cpNewPassword').value;
            const nextConfirm = document.getElementById('cpNewPasswordConfirm').value;
            const errEl = document.getElementById('cpError');

            if (!current || !next) { errEl.innerText = 'Sab fields fill karo.'; errEl.classList.remove('hidden'); return; }
            if (next !== nextConfirm) { errEl.innerText = 'New passwords match nahi kar rahe.'; errEl.classList.remove('hidden'); return; }
            if (next.length < 4) { errEl.innerText = 'Password kam se kam 4 characters ka ho.'; errEl.classList.remove('hidden'); return; }

            // SECURITY: current-password check + new-password hashing both happen inside
            // Postgres now (rpc_change_password) — no password_hash is ever read to the browser.
            const { data: result, error } = await supabaseClient.rpc('rpc_change_password', {
                p_username: currentUser, p_current_password: current, p_new_password: next
            });
            if (error) { errEl.innerText = 'Update nahi ho paaya — security_migration.sql run karo.'; errEl.classList.remove('hidden'); return; }
            if (!result.ok) { errEl.innerText = 'Current password galat hai.'; errEl.classList.remove('hidden'); return; }

            closeChangePasswordModal();
            showAlertBanner('Password successfully update ho gaya.', 'success');
        }
        window.openChangePasswordModal = openChangePasswordModal;
        window.closeChangePasswordModal = closeChangePasswordModal;
        window.submitChangePassword = submitChangePassword;

        function openSecurityQuestionSetupModal() {
            document.getElementById('sqSetupQuestion').value = '';
            document.getElementById('sqSetupAnswer').value = '';
            document.getElementById('sqSetupError').classList.add('hidden');
            document.getElementById('securityQuestionSetupModal').classList.remove('hidden');
            document.getElementById('securityQuestionSetupModal').classList.add('flex');
        }
        function closeSecurityQuestionSetupModal() {
            document.getElementById('securityQuestionSetupModal').classList.add('hidden');
            document.getElementById('securityQuestionSetupModal').classList.remove('flex');
        }
        async function saveSecurityQuestion() {
            const question = document.getElementById('sqSetupQuestion').value;
            const answer = document.getElementById('sqSetupAnswer').value.trim();
            const errEl = document.getElementById('sqSetupError');
            if (!question || !answer) { errEl.innerText = 'Question choose karo aur answer bharo.'; errEl.classList.remove('hidden'); return; }

            const { data: result, error } = await supabaseClient.rpc('rpc_set_security_question', {
                p_username: currentUser, p_question: question, p_answer: answer
            });
            if (error || !result.ok) { errEl.innerText = 'Save nahi ho paaya — security_migration.sql run karo.'; errEl.classList.remove('hidden'); return; }

            closeSecurityQuestionSetupModal();
            showAlertBanner('Security question set ho gaya — ab password reset kaam karega.', 'success');
            renderAccountSecurityCard(true);
        }
        window.openSecurityQuestionSetupModal = openSecurityQuestionSetupModal;
        window.closeSecurityQuestionSetupModal = closeSecurityQuestionSetupModal;
        window.saveSecurityQuestion = saveSecurityQuestion;

        // ===== FEATURE: DAILY 2FA REMINDER — once a day, for users who haven't enabled 2FA =====
        async function checkDailyTwoFaReminder() {
            if (!currentUser) return;
            try {
                const { data: profile, error } = await supabaseClient.from('profiles').select('two_factor_enabled').eq('username', currentUser).maybeSingle();
                if (error || !profile) return; // SQL setup not done yet, or no row — stay quiet
                if (profile.two_factor_enabled) return; // already set up

                const key = `nexus_2fa_reminder_${currentUser}`;
                const last = localStorage.getItem(key);
                const today = new Date().toDateString();
                if (last === today) return;

                localStorage.setItem(key, today);
                const modal = document.getElementById('twoFaReminderModal');
                if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
            } catch (e) { console.warn('2FA reminder check skipped:', e); }
        }
        function dismissTwoFaReminder() {
            const modal = document.getElementById('twoFaReminderModal');
            if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
        }
        function goSetupTwoFaFromReminder() {
            dismissTwoFaReminder();
            openProfile(currentUser);
            setTimeout(() => { if (!profileFlipped) toggleProfileFlip(); }, 250);
        }
        window.dismissTwoFaReminder = dismissTwoFaReminder;
        window.goSetupTwoFaFromReminder = goSetupTwoFaFromReminder;

        // ===== FEATURE: FORGOT PASSWORD (uses the security question set at signup) =====
        let fpVerifiedUsername = null;
        let fpPendingAnswer = null; // security answer staged in step 2, checked server-side during step 3
        function openForgotPasswordModal() {
            fpVerifiedUsername = null;
            document.getElementById('fpUsername').value = '';
            document.getElementById('fpAnswer').value = '';
            document.getElementById('fpNewPassword').value = '';
            document.getElementById('fpNewPasswordConfirm').value = '';
            ['fpStep1Error','fpStep2Error','fpStep3Error'].forEach(id => document.getElementById(id).classList.add('hidden'));
            document.getElementById('fpStep1').classList.remove('hidden');
            document.getElementById('fpStep2').classList.add('hidden');
            document.getElementById('fpStep3').classList.add('hidden');
            document.getElementById('forgotPasswordModal').classList.remove('hidden');
            document.getElementById('forgotPasswordModal').classList.add('flex');
        }
        function closeForgotPasswordModal() {
            document.getElementById('forgotPasswordModal').classList.add('hidden');
            document.getElementById('forgotPasswordModal').classList.remove('flex');
        }
        let fpProfileCache = null;
        async function fpFindUser() {
            const username = document.getElementById('fpUsername').value.trim();
            const errEl = document.getElementById('fpStep1Error');
            if (!username) return;

            // SECURITY: the security-answer hash is never fetched to the browser anymore —
            // only the question text comes back; the answer is checked server-side later.
            const { data: result, error } = await supabaseClient.rpc('rpc_forgot_password_question', { p_username: username });
            if (error) { errEl.innerText = 'SQL setup baaki hai — security_migration.sql run karo.'; errEl.classList.remove('hidden'); return; }
            if (!result.ok) { errEl.innerText = result.error === 'not_found' ? 'Is account ka security question set nahi hai — reset possible nahi hai.' : 'Ye username exist nahi karta.'; errEl.classList.remove('hidden'); return; }

            fpProfileCache = { username };
            document.getElementById('fpQuestionText').innerText = result.question;
            document.getElementById('fpStep1').classList.add('hidden');
            document.getElementById('fpStep2').classList.remove('hidden');
        }
        async function fpVerifyAnswer() {
            const answer = document.getElementById('fpAnswer').value.trim();
            const errEl = document.getElementById('fpStep2Error');
            if (!answer || !fpProfileCache) return;

            // Actual verification happens together with the password reset call below
            // (rpc_forgot_password_reset), so we just stage the answer here for step 3.
            fpVerifiedUsername = fpProfileCache.username;
            fpPendingAnswer = answer;
            document.getElementById('fpStep2').classList.add('hidden');
            document.getElementById('fpStep3').classList.remove('hidden');
        }
        async function fpSubmitNewPassword() {
            const next = document.getElementById('fpNewPassword').value;
            const nextConfirm = document.getElementById('fpNewPasswordConfirm').value;
            const errEl = document.getElementById('fpStep3Error');
            if (!fpVerifiedUsername) return;
            if (next.length < 4) { errEl.innerText = 'Password kam se kam 4 characters ka ho.'; errEl.classList.remove('hidden'); return; }
            if (next !== nextConfirm) { errEl.innerText = 'Passwords match nahi kar rahe.'; errEl.classList.remove('hidden'); return; }

            const { data: result, error } = await supabaseClient.rpc('rpc_forgot_password_reset', {
                p_username: fpVerifiedUsername, p_answer: fpPendingAnswer, p_new_password: next
            });
            if (error) { errEl.innerText = 'Reset nahi ho paaya — security_migration.sql run karo.'; errEl.classList.remove('hidden'); return; }
            if (!result.ok) {
                // Wrong answer only discovered now (checked server-side) — send back to step 2.
                document.getElementById('fpStep3').classList.add('hidden');
                document.getElementById('fpStep2').classList.remove('hidden');
                document.getElementById('fpStep2Error').innerText = 'Answer galat hai.';
                document.getElementById('fpStep2Error').classList.remove('hidden');
                return;
            }

            closeForgotPasswordModal();
            showAlertBanner('Password reset ho gaya — ab naye password se login karo.', 'success');
        }
        window.openForgotPasswordModal = openForgotPasswordModal;
        window.closeForgotPasswordModal = closeForgotPasswordModal;
        window.fpFindUser = fpFindUser;
        window.fpVerifyAnswer = fpVerifyAnswer;
        window.fpSubmitNewPassword = fpSubmitNewPassword;

        // =====================================================================================
        // FEATURE: DATA EXPORT (GDPR-style) — download everything tied to your username as a
        // JSON file before doing a True Delete (or just to keep a personal backup).
        // =====================================================================================
        function renderDataExportCard(isMe) {
            const wrap = document.getElementById('dataExportCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-file-export text-[#38bdf8]"></i> Data Export</p>
                <p class="text-[11px] text-slate-400">Apna saara data (posts, messages, stories, follows, comments) ek JSON file me download karo — True Delete se pehle ek achhi habit.</p>
                <button id="dataExportBtn" onclick="exportMyData()" class="w-full bg-slate-800 hover:bg-slate-700 border border-[#38bdf8]/30 font-bold py-2 rounded-xl text-xs text-[#38bdf8] transition"><i class="fa-solid fa-download mr-1"></i> Download My Data</button>
            `;
        }

        async function exportMyData() {
            const btn = document.getElementById('dataExportBtn');
            const u = currentUser;
            if (btn) { btn.disabled = true; btn.innerText = 'Preparing export...'; }

            const safe = async (label, promise) => {
                try { const { data, error } = await promise; if (error) throw error; return data || []; }
                catch (e) { console.warn(`Data export: ${label} skipped`, e); return []; }
            };

            try {
                const [profile, posts, comments, commentLikes, postLikes, postViews, messagesSent, messagesReceived,
                    stories, storyViews, following, followers, blockedByMe, closeFriends] = await Promise.all([
                    safe('profile', supabaseClient.from('profiles').select('*').eq('username', u).maybeSingle().then(r => ({ data: r.data ? [r.data] : [], error: r.error }))),
                    safe('posts', supabaseClient.from('posts').select('*').eq('username', u)),
                    safe('comments', supabaseClient.from('comments').select('*').eq('username', u)),
                    safe('comment_likes', supabaseClient.from('comment_likes').select('*').eq('username', u)),
                    safe('post_likes', supabaseClient.from('post_likes').select('*').eq('username', u)),
                    safe('post_views', supabaseClient.from('post_views').select('*').eq('viewer', u)),
                    safe('messages_sent', supabaseClient.from('messages').select('*').eq('sender', u)),
                    safe('messages_received', supabaseClient.from('messages').select('*').eq('receiver', u)),
                    safe('stories', supabaseClient.from('stories').select('*').eq('username', u)),
                    safe('story_views', supabaseClient.from('story_views').select('*').eq('username', u)),
                    safe('following', supabaseClient.from('follows').select('*').eq('follower', u)),
                    safe('followers', supabaseClient.from('follows').select('*').eq('following', u)),
                    safe('blocked_by_me', supabaseClient.from('blocked_users').select('*').eq('blocker', u)),
                    safe('close_friends', supabaseClient.from('close_friends').select('*').eq('owner', u)),
                ]);

                const exportBundle = {
                    exported_at: new Date().toISOString(),
                    username: u,
                    note: 'Nexus data export — GDPR-style download of everything tied to this account. password_hash and two_factor_pin_hash are one-way hashes, not your real password/PIN.',
                    profile: (profile[0] ? { ...profile[0], password_hash: undefined, two_factor_pin_hash: undefined, security_answer_hash: undefined } : null),
                    posts, comments, comment_likes: commentLikes, post_likes: postLikes, post_views: postViews,
                    messages_sent: messagesSent, messages_received: messagesReceived,
                    stories, story_views: storyViews, following, followers,
                    blocked_by_me: blockedByMe, close_friends: closeFriends
                };

                const blob = new Blob([JSON.stringify(exportBundle, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `nexus_data_export_${u}_${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);

                showAlertBanner('Tumhara data JSON file me download ho gaya.', 'success');
            } catch (e) {
                console.error('Data export error:', e);
                showAlertBanner('Data export karte waqt error aaya — dobara try karo.', 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.innerText = ''; renderDataExportCard(true); }
            }
        }
        window.exportMyData = exportMyData;

        // =====================================================================================
        // FEATURE: SHARE POST TO STORY / DM — share any post to your own story, or send it
        // straight to someone's DM inbox.
        // =====================================================================================
        let sharePostActiveId = null;

        function openSharePostModal(postId) {
            sharePostActiveId = postId;
            document.getElementById('sharePostUserSearch').value = '';
            renderSharePostUserList();
            document.getElementById('sharePostModal').classList.remove('hidden');
            document.getElementById('sharePostModal').classList.add('flex');
        }
        function closeSharePostModal() {
            sharePostActiveId = null;
            document.getElementById('sharePostModal').classList.add('hidden');
            document.getElementById('sharePostModal').classList.remove('flex');
        }
        window.openSharePostModal = openSharePostModal;
        window.closeSharePostModal = closeSharePostModal;

        function renderSharePostUserList() {
            const wrap = document.getElementById('sharePostUserList');
            const q = (document.getElementById('sharePostUserSearch').value || '').trim().toLowerCase();
            if (!wrap) return;

            let users = Object.keys(globalProfilesCache || {}).filter(u => u && u !== currentUser);
            if (q) users = users.filter(u => u.toLowerCase().includes(q));
            users = users.slice(0, 30);

            if (users.length === 0) {
                wrap.innerHTML = `<p class="text-[11px] text-slate-400 text-center py-3">Koi user nahi mila.</p>`;
                return;
            }

            wrap.innerHTML = users.map(u => {
                const av = globalProfilesCache[u];
                return `
                    <div class="flex items-center gap-2 p-1.5 rounded-xl hover:bg-slate-900/60 transition">
                        <div class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center text-[11px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                        <span class="flex-1 text-xs font-bold text-slate-200 truncate">${u}</span>
                        <button onclick="shareToUserDM('${u}')" class="text-[11px] font-bold bg-[#38bdf8] hover:opacity-90 text-white px-3 py-1.5 rounded-lg transition">Send</button>
                    </div>
                `;
            }).join('');
        }
        window.renderSharePostUserList = renderSharePostUserList;

        // Builds a simple SVG "quote card" data-URI for text-only posts (no image) so they can
        // still be shared to a story, which otherwise expects a media_url.
        function buildTextCardDataUri(text, username) {
            const safeText = String(text || '').slice(0, 180).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const words = safeText.split(' ');
            let lines = [], line = '';
            words.forEach(w => {
                if ((line + ' ' + w).trim().length > 28) { lines.push(line.trim()); line = w; }
                else { line = (line + ' ' + w).trim(); }
            });
            if (line) lines.push(line);
            lines = lines.slice(0, 8);
            const tspans = lines.map((l, i) => `<tspan x="40" dy="${i === 0 ? 0 : 26}">${l}</tspan>`).join('');
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
                <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#14b8a6"/><stop offset="100%" stop-color="#3b82f6"/>
                </linearGradient></defs>
                <rect width="600" height="800" fill="#0f0f1a"/>
                <rect width="600" height="800" fill="url(#g)" opacity="0.12"/>
                <text x="40" y="360" fill="#f1f1f4" font-family="sans-serif" font-size="24" font-weight="bold">${tspans}</text>
                <text x="40" y="750" fill="#3b82f6" font-family="sans-serif" font-size="18" font-weight="bold">@${username}</text>
            </svg>`;
            return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
        }

        async function shareToOwnStory() {
            const post = globalPostsCache.find(p => String(p.id) === String(sharePostActiveId));
            if (!post) { showAlertBanner('Post nahi mila.', 'error'); return; }

            const btn = document.getElementById('shareToStoryBtn');
            if (btn) btn.disabled = true;

            try {
                const isVideo = post.image_url && /\.(mp4|webm|mov)$/i.test(post.image_url);
                const mediaUrl = post.image_url || buildTextCardDataUri(post.content, post.username);
                const mediaType = post.image_url ? (isVideo ? 'video' : 'image') : 'image';

                const { error } = await supabaseClient.from('stories').insert({
                    username: currentUser,
                    media_url: mediaUrl,
                    media_type: mediaType,
                    caption: `Shared @${post.username}'s post`
                });
                if (error) throw error;

                await fetchAllData();
                closeSharePostModal();
                showAlertBanner('Post tumhari story me add ho gaya!', 'success');
            } catch (e) {
                console.error('Share to story error:', e);
                showAlertBanner('Story me share nahi ho paaya — dobara try karo.', 'error');
            } finally {
                if (btn) btn.disabled = false;
            }
        }
        window.shareToOwnStory = shareToOwnStory;

        async function shareToUserDM(targetUsername) {
            const post = globalPostsCache.find(p => String(p.id) === String(sharePostActiveId));
            if (!post || !targetUsername) { showAlertBanner('Post nahi mila.', 'error'); return; }

            // FEATURE: MESSAGE REQUESTS — private account gate
            if (!(await ensureMessageRequestForSend(targetUsername))) return;

            const basePayload = {
                sender: currentUser,
                receiver: targetUsername,
                text: `Shared a post from @${post.username}: "${(post.content || '').slice(0, 120)}"`,
                media_url: post.image_url || null
            };

            // Try to also tag the message with shared_post_id (optional column) — falls back
            // gracefully to a plain message if that column doesn't exist yet.
            let { error } = await supabaseClient.from('messages').insert({ ...basePayload, shared_post_id: String(post.id) });
            if (error) {
                ({ error } = await supabaseClient.from('messages').insert(basePayload));
            }

            if (error) {
                console.error('Share to DM error:', error);
                showAlertBanner('DM me share nahi ho paaya — dobara try karo.', 'error');
                return;
            }

            showAlertBanner(`Post @${targetUsername} ko DM ho gaya!`, 'success');
            closeSharePostModal();
            if (activeChatUser === targetUsername) loadDirectMessages(targetUsername, true);
        }
        window.shareToUserDM = shareToUserDM;

        // Small seeded random-number generator (used by the Nexus Universe visual).
        function mulberry32(seed) {
            return function () {
                seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        // =====================================================================================
        // FEATURE: TRUE DELETE — a genuine, one-step, no-dark-pattern account deletion. No 30-day
        // reactivation window, no repeated guilt-trip confirmations, no hidden backup. Cascades
        // across every table tied to the username (same table list used for username-rename).
        // =====================================================================================
        function renderTrueDeleteCard(isMe) {
            const wrap = document.getElementById('trueDeleteCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-trash-can text-red-400"></i> True Delete</p>
                <p class="text-[11px] text-slate-400">Koi 30-din grace period nahi — confirm karte hi tumhara data turant delete ho jata hai. Detail: Privacy Policy.</p>
                <button onclick="openTrueDeleteModal()" class="w-full bg-slate-800 hover:bg-red-500/20 border border-red-500/30 font-bold py-2 rounded-xl text-xs text-red-400 transition"><i class="fa-solid fa-trash-can mr-1"></i> Delete My Account</button>
            `;
        }

        function openTrueDeleteModal() {
            document.getElementById('trueDeleteConfirmInput').value = '';
            document.getElementById('trueDeleteConfirmBtn').disabled = true;
            document.getElementById('trueDeleteModal').classList.remove('hidden');
            document.getElementById('trueDeleteModal').classList.add('flex');
        }

        function closeTrueDeleteModal() {
            document.getElementById('trueDeleteModal').classList.add('hidden');
            document.getElementById('trueDeleteModal').classList.remove('flex');
        }

        function checkTrueDeleteInput() {
            const val = document.getElementById('trueDeleteConfirmInput').value.trim().toUpperCase();
            document.getElementById('trueDeleteConfirmBtn').disabled = (val !== 'DELETE');
        }

        // BUGFIX (True Delete failing mid-way): the old version only ever deleted rows the
        // user directly owned (their own likes, their own comments, etc). It never touched
        // OTHER people's likes/comments/views/reactions on THIS user's posts/comments/
        // stories/messages. When the DB has a real foreign key from e.g. post_likes ->
        // posts, deleting a post that a stranger had liked was blocked by that leftover
        // like — Postgres raised a real error, which then blocked the final `profiles`
        // delete too. That's the "kuch data delete karte waqt error aaya" you saw: some
        // tables (follows, blocked_users, etc.) had already been wiped by the time it hit
        // the row that was still referenced elsewhere and stopped. Fix: first find the IDs
        // of everything this user owns, delete anyone else's interactions on those IDs,
        // THEN delete the owned rows themselves, and only after that touch `profiles`.
        async function executeTrueDelete() {
            const btn = document.getElementById('trueDeleteConfirmBtn');
            btn.disabled = true;
            btn.innerText = 'Deleting...';
            const u = currentUser;

            // Tracks anything that failed for a reason OTHER than "this table doesn't exist
            // on this install" (code 42P01), so we can tell the user something real instead
            // of a generic message every single time.
            const realIssues = [];
            async function safeDelete(label, queryPromise) {
                try {
                    const { error } = await queryPromise;
                    if (error && error.code !== '42P01') {
                        console.warn(`Nexus true-delete: ${label} ->`, error);
                        realIssues.push(label);
                    }
                } catch (e) {
                    if (e?.code !== '42P01') {
                        console.warn(`Nexus true-delete: ${label} threw ->`, e);
                        realIssues.push(label);
                    }
                }
            }
            async function idsWhere(table, col, val) {
                try {
                    const { data } = await supabaseClient.from(table).select('id').eq(col, val);
                    return (data || []).map(r => r.id);
                } catch (e) { return []; }
            }
            async function idsIn(table, col, vals) {
                if (!vals.length) return [];
                try {
                    const { data } = await supabaseClient.from(table).select('id').in(col, vals);
                    return (data || []).map(r => r.id);
                } catch (e) { return []; }
            }

            try {
                // ---- Step 1: what does this user own? (posts, comments, stories, messages,
                // groups they created). Everything else that references these by ID has to
                // be cleaned up before the owned rows themselves can go.
                const [postIds, ownCommentIds, storyIds, sentMsgIds, recvMsgIds, ownedGroupIds] = await Promise.all([
                    idsWhere('posts', 'username', u),
                    idsWhere('comments', 'username', u),
                    idsWhere('stories', 'username', u),
                    idsWhere('messages', 'sender', u),
                    idsWhere('messages', 'receiver', u),
                    idsWhere('groups', 'created_by', u),
                ]);
                const messageIds = [...sentMsgIds, ...recvMsgIds];

                // Comments made by OTHER people on this user's posts also need cleaning up
                // (and any replies-to-replies on top of those), not just this user's own
                // comments — a stranger's comment/reply on your post is still a row pointing
                // at your post_id / your comment_id.
                let allCommentIds = [...new Set([...ownCommentIds, ...(await idsIn('comments', 'post_id', postIds))])];
                for (let i = 0; i < 5; i++) {
                    const replyIds = await idsIn('comments', 'parent_comment_id', allCommentIds);
                    const before = allCommentIds.length;
                    allCommentIds = [...new Set([...allCommentIds, ...replyIds])];
                    if (allCommentIds.length === before) break; // no new replies found, done
                }

                // ---- Step 2: delete other people's interactions on this user's content, by ID.
                await Promise.all([
                    safeDelete('likes on your posts', supabaseClient.from('post_likes').delete().in('post_id', postIds)),
                    safeDelete('views on your posts', supabaseClient.from('post_views').delete().in('post_id', postIds)),
                    safeDelete('likes on comments under your posts/threads', supabaseClient.from('comment_likes').delete().in('comment_id', allCommentIds)),
                    safeDelete('views on your stories', supabaseClient.from('story_views').delete().in('story_id', storyIds)),
                    safeDelete('reactions on your messages', supabaseClient.from('message_reactions').delete().in('message_id', messageIds)),
                ]);
                // All comments in this set (yours + others' on your posts + every reply
                // chain on top) are removed together in one statement, so the self-referencing
                // parent_comment_id link never blocks the delete regardless of order.
                await safeDelete('comments (yours + on your posts + replies)', supabaseClient.from('comments').delete().in('id', allCommentIds));

                if (ownedGroupIds.length > 0) {
                    await safeDelete('messages in your groups', supabaseClient.from('group_messages').delete().in('group_id', ownedGroupIds));
                    await safeDelete('members of your groups', supabaseClient.from('group_members').delete().in('group_id', ownedGroupIds));
                    await safeDelete('your groups', supabaseClient.from('groups').delete().in('id', ownedGroupIds));
                }
                await safeDelete('group messages you sent', supabaseClient.from('group_messages').delete().eq('sender', u));

                // ---- Step 3: now safe to delete everything owned directly by username.
                await Promise.all([
                    safeDelete('posts', supabaseClient.from('posts').delete().eq('username', u)),
                    safeDelete('follows (as follower)', supabaseClient.from('follows').delete().eq('follower', u)),
                    safeDelete('follows (as followed)', supabaseClient.from('follows').delete().eq('following', u)),
                    safeDelete('follow requests sent', supabaseClient.from('follow_requests').delete().eq('requester', u)),
                    safeDelete('follow requests received', supabaseClient.from('follow_requests').delete().eq('target', u)),
                    safeDelete('your post likes', supabaseClient.from('post_likes').delete().eq('username', u)),
                    safeDelete('your post views', supabaseClient.from('post_views').delete().eq('viewer', u)),
                    safeDelete('your comment likes', supabaseClient.from('comment_likes').delete().eq('username', u)),
                    safeDelete('messages sent', supabaseClient.from('messages').delete().eq('sender', u)),
                    safeDelete('messages received', supabaseClient.from('messages').delete().eq('receiver', u)),
                    safeDelete('your message reactions', supabaseClient.from('message_reactions').delete().eq('username', u)),
                    safeDelete('stories', supabaseClient.from('stories').delete().eq('username', u)),
                    safeDelete('your story views', supabaseClient.from('story_views').delete().eq('username', u)),
                    safeDelete('blocked by you', supabaseClient.from('blocked_users').delete().eq('blocker', u)),
                    safeDelete('you, blocked by others', supabaseClient.from('blocked_users').delete().eq('blocked', u)),
                    safeDelete('your group memberships', supabaseClient.from('group_members').delete().eq('username', u)),
                    safeDelete('calls made', supabaseClient.from('calls').delete().eq('caller_id', u)),
                    safeDelete('calls received', supabaseClient.from('calls').delete().eq('callee_id', u)),
                    safeDelete('reports you filed', supabaseClient.from('reports').delete().eq('reporter', u)),
                    safeDelete('reports about you', supabaseClient.from('reports').delete().eq('reported_user', u)),
                ]);

                // ---- Step 4: best-effort extras — optional tables that may not exist on every install.
                await Promise.all([
                    safeDelete('close friends list', supabaseClient.from('close_friends').delete().eq('owner', u)),
                ]);

                // ---- Step 5: the profile row itself — throws for real if anything above
                // left something behind that still points at it.
                const { error: profileErr } = await supabaseClient.from('profiles').delete().eq('username', u);
                if (profileErr) throw profileErr;

                // Purge everything local too — no lingering trace on this device.
                Object.keys(localStorage).forEach(k => { if (k.includes(u)) localStorage.removeItem(k); });
                localStorage.removeItem('nexus_user');
                if (localStorage.getItem('nexus_previous_user') === u) localStorage.removeItem('nexus_previous_user');
                persistSavedAccounts(getSavedAccounts().filter(x => x !== u));

                if (realIssues.length) {
                    console.warn('Nexus true-delete: finished, but these had non-missing-table issues:', realIssues);
                }

                showAlertBanner('Tumhara account aur saara data permanently delete ho gaya. Koi wapasi nahi — jaisa vaada tha.', 'success');
                window.location.reload();
            } catch (e) {
                console.error('True delete error:', e);
                btn.disabled = false;
                btn.innerText = 'Retry Delete';
                // Surface the real reason (when we have one) instead of a generic message
                // every time, so it's actually debuggable.
                const detail = e?.message ? ` (${e.message})` : '';
                showAlertBanner(`Kuch data delete karte waqt error aaya${detail} — thodi der baad phir try karo.`, 'error');
            }
        }

        // =====================================================================================
        // FEATURE: OFFLINE MODE — shows a banner when the browser goes offline, keeps the last
        // successfully fetched feed cached in localStorage so it can still be browsed, and
        // gently blocks actions (like/comment/post) that need a live connection instead of
        // letting them silently fail. Real background sync/queueing is out of scope here.
        // =====================================================================================
        const OFFLINE_FEED_CACHE_KEY = 'nexus_offline_feed_cache';

        function cacheFeedForOffline() {
            try {
                if (Array.isArray(globalPostsCache) && globalPostsCache.length) {
                    localStorage.setItem(OFFLINE_FEED_CACHE_KEY, JSON.stringify({ posts: globalPostsCache.slice(0, 50), cached_at: Date.now() }));
                }
            } catch (e) { /* storage full or unavailable — non-fatal, offline mode just has less to show */ }
        }

        function loadCachedFeedIfOffline() {
            if (navigator.onLine) return false;
            try {
                const raw = localStorage.getItem(OFFLINE_FEED_CACHE_KEY);
                if (!raw) return false;
                const cached = JSON.parse(raw);
                if (cached && Array.isArray(cached.posts)) {
                    globalPostsCache = cached.posts;
                    return true;
                }
            } catch (e) { /* ignore corrupt cache */ }
            return false;
        }

        // PERF: paints the last cached feed instantly from localStorage while the real
        // fetchAllData() (a ~20-query round trip) is still in flight on app open — so the
        // feed tab isn't sitting blank for however long that takes on every single login/
        // reload. Purely cosmetic: fetchAllData() runs right after this regardless and
        // repaints everything with live data the moment it lands, this just fills the gap
        // before that with what was on screen last time.
        function paintCachedFeedInstantly() {
            try {
                const raw = localStorage.getItem(OFFLINE_FEED_CACHE_KEY);
                if (!raw) return;
                const cached = JSON.parse(raw);
                if (cached && Array.isArray(cached.posts) && cached.posts.length) {
                    globalPostsCache = cached.posts;
                }
            } catch (e) { /* corrupt/unavailable cache — just skip straight to the real fetch */ }
        }

        function updateOfflineBannerUI() {
            const banner = document.getElementById('offlineBanner');
            if (banner) banner.classList.toggle('hidden', navigator.onLine);
        }

        function guardOfflineAction(actionLabel = 'Ye action') {
            if (!navigator.onLine) {
                showAlertBanner(`${actionLabel} ke liye internet chahiye — offline hone par yeh paused hai.`, 'warning');
                return true;
            }
            return false;
        }
        window.guardOfflineAction = guardOfflineAction;

        function initOfflineMode() {
            updateOfflineBannerUI();
            window.addEventListener('online', () => {
                updateOfflineBannerUI();
                showAlertBanner('Wapas online ho gaye — latest data refresh ho raha hai.', 'success');
                fetchAllData();
            });
            window.addEventListener('offline', () => {
                updateOfflineBannerUI();
                cacheFeedForOffline();
                showAlertBanner('Internet chala gaya — cached feed dikha rahe hain.', 'warning');
            });
        }

        function renderOfflineModeCard(isMe) {
            const wrap = document.getElementById('offlineModeCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            let cachedAt = null;
            try {
                const raw = localStorage.getItem(OFFLINE_FEED_CACHE_KEY);
                if (raw) cachedAt = JSON.parse(raw).cached_at;
            } catch (e) {}
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-wifi text-[#38bdf8]"></i> Offline Mode</p>
                <p class="text-[11px] text-slate-400">Internet jaane par ek banner dikhega aur pichla fetch kiya hua feed cache se dikhta rahega. Likes/comments/posts jaise actions us waqt paused rehte hain.</p>
                <p class="text-[11px] text-slate-400">Status: <span class="${navigator.onLine ? 'text-emerald-400' : 'text-amber-400'} font-bold">${navigator.onLine ? 'Online' : 'Offline'}</span>${cachedAt ? ` · Last cached: ${new Date(cachedAt).toLocaleTimeString()}` : ''}</p>
            `;
        }
        window.renderOfflineModeCard = renderOfflineModeCard;

        // =====================================================================================
        // FEATURE: SCREENSHOT ALERT — browsers have NO real API to detect an OS-level screenshot
        // (it happens entirely outside the page's sandbox), so this is best-effort only:
        // (a) on desktop, catches the actual PrintScreen keypress, and (b) as a rough heuristic,
        // catches the tab losing visibility for a very short blink (common during a screenshot/
        // screen-recording gesture on some platforms) while a chat is open. When either fires
        // while inside an active DM, it drops a small system-style note in that chat so the
        // other person knows. Purely client-side and toggle-able — not tamper-proof.
        // =====================================================================================
        let screenshotAlertEnabled = localStorage.getItem('nexus_screenshot_alert') === 'true';

        function notifyScreenshotInActiveChat() {
            if (!screenshotAlertEnabled || !activeChatUser) return;
            showInAppBanner('📸 Screenshot Alert', `${activeChatUser} ko screenshot ka notice bhej diya gaya.`);
            supabaseClient.from('messages').insert({
                sender: currentUser, receiver: activeChatUser,
                text: `📸 ${currentUser} ne is chat ka screenshot liya.`
            }).then(({ error }) => { if (error) console.warn('Screenshot alert message not sent:', error); });
        }

        function initScreenshotAlert() {
            document.addEventListener('keyup', (e) => {
                if (e.key === 'PrintScreen') notifyScreenshotInActiveChat();
            });
            let lastHiddenAt = 0;
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) { lastHiddenAt = Date.now(); return; }
                const blinkMs = Date.now() - lastHiddenAt;
                if (lastHiddenAt && blinkMs > 0 && blinkMs < 600) notifyScreenshotInActiveChat();
            });
        }

        function renderScreenshotAlertCard(isMe) {
            const wrap = document.getElementById('screenshotAlertCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            wrap.innerHTML = `
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-[11px] font-bold text-slate-200"><i class="fa-solid fa-camera mr-1 text-slate-400"></i> Screenshot Alert</p>
                        <p class="text-[11px] text-slate-400">Best-effort: browsers screenshots ko reliably detect nahi kar sakte, ye sirf desktop PrintScreen key aur ek chhoti heuristic pakadta hai.</p>
                    </div>
                    <button onclick="toggleScreenshotAlert()" id="screenshotAlertToggleBtn" class="w-10 h-5 rounded-full ${screenshotAlertEnabled ? 'bg-[#2563eb]' : 'bg-slate-700'} relative transition shrink-0">
                        <span class="absolute top-0.5 ${screenshotAlertEnabled ? 'left-5' : 'left-0.5'} w-4 h-4 rounded-full bg-white transition-transform"></span>
                    </button>
                </div>
            `;
        }
        window.renderScreenshotAlertCard = renderScreenshotAlertCard;

        function toggleScreenshotAlert() {
            screenshotAlertEnabled = !screenshotAlertEnabled;
            localStorage.setItem('nexus_screenshot_alert', String(screenshotAlertEnabled));
            renderScreenshotAlertCard(true);
        }
        window.toggleScreenshotAlert = toggleScreenshotAlert;

        // =====================================================================================
        // FEATURE: MULTI-LANGUAGE UI — translates the core navigation/action labels (the app's
        // own body copy stays a Hindi/English mix by design, so this covers the bottom nav +
        // a handful of primary buttons rather than every string in the app). Elements opt in
        // via a `data-i18n` attribute holding the dictionary key.
        // =====================================================================================
        const NEXUS_LANG_DICT = {
            en: { nav_feed: 'Feed', nav_explore: 'Explore', nav_chat: 'Chat', nav_calls: 'Calls', nav_groups: 'Groups', nav_reels: 'Reels', btn_post: 'Post', btn_message: 'Message', btn_login: 'Login', btn_signup: 'Sign Up' },
            hi: { nav_feed: 'फ़ीड', nav_explore: 'एक्सप्लोर', nav_chat: 'चैट', nav_calls: 'कॉल्स', nav_groups: 'ग्रुप्स', nav_reels: 'रील्स', btn_post: 'पोस्ट करें', btn_message: 'मैसेज', btn_login: 'लॉगिन', btn_signup: 'साइन अप' },
            hinglish: { nav_feed: 'Feed', nav_explore: 'Explore', nav_chat: 'Chat', nav_calls: 'Calls', nav_groups: 'Groups', nav_reels: 'Reels', btn_post: 'Post karo', btn_message: 'Message', btn_login: 'Login', btn_signup: 'Sign Up' }
        };

        function applyLanguage(lang) {
            const dict = NEXUS_LANG_DICT[lang] || NEXUS_LANG_DICT.hinglish;
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (dict[key]) el.textContent = dict[key];
            });
            localStorage.setItem('nexus_lang', lang);
        }
        window.applyLanguage = applyLanguage;

        function getSavedLanguage() {
            return localStorage.getItem('nexus_lang') || 'hinglish';
        }

        function setLanguage(lang) {
            applyLanguage(lang);
            renderLanguageCard(true);
        }
        window.setLanguage = setLanguage;

        function renderLanguageCard(isMe) {
            const wrap = document.getElementById('languageCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            const current = getSavedLanguage();
            const opts = [['hinglish', 'Hinglish'], ['en', 'English'], ['hi', 'हिंदी']];
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-language text-[#38bdf8]"></i> App Language</p>
                <p class="text-[11px] text-slate-400">Nav bar aur core buttons ki language badlo (poora app abhi is dictionary ke scope me nahi hai).</p>
                <div class="flex gap-1.5">
                    ${opts.map(([code, label]) => `<button onclick="setLanguage('${code}')" class="flex-1 text-[11px] font-bold py-1.5 rounded-xl border transition ${current === code ? 'bg-[#2563eb] text-white border-transparent' : 'bg-slate-900 border-slate-800 text-slate-400'}">${label}</button>`).join('')}
                </div>
            `;
        }
        window.renderLanguageCard = renderLanguageCard;

        // =====================================================================================
        // FEATURE: CUSTOM NOTIFICATION SOUNDS — a handful of built-in tones generated on the
        // fly with the Web Audio API (no external sound files to host/break), so users can pick
        // which one plays for new messages/notifications, preview it, or mute it entirely.
        // =====================================================================================
        const NOTIF_SOUND_TONES = {
            classic: [660, 880],
            chime: [523, 659, 784],
            pop: [880],
            soft: [440, 440],
            none: []
        };

        function playToneSequence(freqs) {
            if (!freqs || !freqs.length) return;
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                freqs.forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = freq;
                    gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.14);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.14 + 0.12);
                    osc.connect(gain).connect(ctx.destination);
                    osc.start(ctx.currentTime + i * 0.14);
                    osc.stop(ctx.currentTime + i * 0.14 + 0.13);
                });
            } catch (e) { /* Web Audio unavailable — fail silently */ }
        }

        function getNotifSoundChoice() {
            return localStorage.getItem('nexus_notif_sound') || 'classic';
        }

        function playNotificationSound() {
            const choice = getNotifSoundChoice();
            playToneSequence(NOTIF_SOUND_TONES[choice] || NOTIF_SOUND_TONES.classic);
        }
        window.playNotificationSound = playNotificationSound;

        function setNotifSound(choice) {
            localStorage.setItem('nexus_notif_sound', choice);
            playToneSequence(NOTIF_SOUND_TONES[choice] || []);
            renderNotifSoundCard(true);
        }
        window.setNotifSound = setNotifSound;

        function renderNotifSoundCard(isMe) {
            const wrap = document.getElementById('notifSoundCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            const current = getNotifSoundChoice();
            const opts = [['classic', 'Classic'], ['chime', 'Chime'], ['pop', 'Pop'], ['soft', 'Soft'], ['none', 'Silent']];
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-bell text-amber-400"></i> Notification Sound</p>
                <div class="grid grid-cols-2 gap-1.5">
                    ${opts.map(([code, label]) => `<button onclick="setNotifSound('${code}')" class="text-[11px] font-bold py-1.5 rounded-xl border transition ${current === code ? 'bg-[#2563eb] text-white border-transparent' : 'bg-slate-900 border-slate-800 text-slate-400'}">${label}</button>`).join('')}
                </div>
            `;
        }
        window.renderNotifSoundCard = renderNotifSoundCard;

        // =====================================================================================
        // FEATURE: YOUR NEXUS UNIVERSE — a personal generative 3D-ish galaxy built from the
        // user's own data: each follower/following is a star (brightness = closeness via mutual
        // activity), their own posts trail as comets. Rendered on canvas with simple perspective
        // projection (drag to rotate, wheel/pinch to zoom) — no external 3D library needed.
        // =====================================================================================
        function renderNexusUniverseCard(username, isMe) {
            const wrap = document.getElementById('nexusUniverseCard');
            if (!wrap) return;
            if (!username) { wrap.innerHTML = ''; return; }
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-meteor text-[#2dd4bf]"></i> ${isMe ? 'Your' : username + "'s"} Nexus Universe</p>
                <p class="text-[11px] text-slate-400">Connections se banti ek generative 3D galaxy — har follower/following ek star, tumhare posts comets ki tarah.</p>
                <button onclick="openNexusUniverseModal('${username}')" class="w-full bg-[#2563eb] font-bold py-2 rounded-xl text-xs text-white shadow"><i class="fa-solid fa-meteor mr-1"></i> Open Universe</button>
            `;
        }

        let nexusUniverseState = null;
        let nexusUniverseAnimFrame = null;

        function buildNexusUniverseData(username) {
            const following = globalFollowsCache.filter(f => f.follower === username).map(f => f.following);
            const followers = globalFollowsCache.filter(f => f.following === username).map(f => f.follower);
            const connections = Array.from(new Set([...following, ...followers]));

            const stars = connections.map(name => {
                const isMutual = following.includes(name) && followers.includes(name);
                const closeness = isMutual ? 1 : 0.55;
                const seedStr = `${username}|${name}`;
                let hash = 0;
                for (let i = 0; i < seedStr.length; i++) hash = (Math.imul(hash, 31) + seedStr.charCodeAt(i)) | 0;
                const rand = mulberry32(hash >>> 0);
                const theta = rand() * Math.PI * 2;
                const phi = Math.acos(2 * rand() - 1);
                const radius = 90 + rand() * 140;
                return {
                    name, isMutual, closeness,
                    x: radius * Math.sin(phi) * Math.cos(theta),
                    y: radius * Math.sin(phi) * Math.sin(theta),
                    z: radius * Math.cos(phi),
                    size: 1.5 + closeness * 2.2 + rand() * 1.2
                };
            });

            const myPosts = globalPostsCache.filter(p => p.username === username)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(-30);
            const comets = myPosts.map((p, i) => {
                const seedStr = `${username}|comet|${p.id}`;
                let hash = 0;
                for (let j = 0; j < seedStr.length; j++) hash = (Math.imul(hash, 31) + seedStr.charCodeAt(j)) | 0;
                const rand = mulberry32(hash >>> 0);
                const theta = rand() * Math.PI * 2;
                const phi = Math.acos(2 * rand() - 1);
                const radius = 20 + (i / Math.max(1, myPosts.length)) * 60;
                return {
                    x: radius * Math.sin(phi) * Math.cos(theta),
                    y: radius * Math.sin(phi) * Math.sin(theta),
                    z: radius * Math.cos(phi)
                };
            });

            return { stars, comets, centerLabel: username };
        }

        function openNexusUniverseModal(username) {
            const modal = document.getElementById('nexusUniverseModal');
            const canvas = document.getElementById('nexusUniverseCanvas');
            document.getElementById('nexusUniverseTitle').innerText = `${username}'s Universe`;
            modal.classList.remove('hidden'); modal.classList.add('flex');

            const data = buildNexusUniverseData(username);
            nexusUniverseState = { data, rotX: 0.3, rotY: 0, zoom: 1, dragging: false, lastX: 0, lastY: 0 };

            setupNexusUniverseCanvas(canvas);
            if (nexusUniverseAnimFrame) cancelAnimationFrame(nexusUniverseAnimFrame);
            renderNexusUniverseFrame();
        }

        function closeNexusUniverseModal() {
            document.getElementById('nexusUniverseModal').classList.add('hidden');
            document.getElementById('nexusUniverseModal').classList.remove('flex');
            if (nexusUniverseAnimFrame) cancelAnimationFrame(nexusUniverseAnimFrame);
            nexusUniverseState = null;
        }

        function setupNexusUniverseCanvas(canvas) {
            if (canvas.dataset.wired) return;
            canvas.dataset.wired = '1';

            const resize = () => {
                const rect = canvas.parentElement.getBoundingClientRect();
                canvas.width = rect.width; canvas.height = rect.height;
            };
            resize();
            window.addEventListener('resize', resize);

            const onDown = (e) => {
                const p = e.touches ? e.touches[0] : e;
                nexusUniverseState.dragging = true;
                nexusUniverseState.lastX = p.clientX; nexusUniverseState.lastY = p.clientY;
            };
            const onMove = (e) => {
                if (!nexusUniverseState || !nexusUniverseState.dragging) return;
                const p = e.touches ? e.touches[0] : e;
                const dx = p.clientX - nexusUniverseState.lastX;
                const dy = p.clientY - nexusUniverseState.lastY;
                nexusUniverseState.rotY += dx * 0.008;
                nexusUniverseState.rotX = Math.max(-1.3, Math.min(1.3, nexusUniverseState.rotX + dy * 0.008));
                nexusUniverseState.lastX = p.clientX; nexusUniverseState.lastY = p.clientY;
            };
            const onUp = () => { if (nexusUniverseState) nexusUniverseState.dragging = false; };

            canvas.addEventListener('pointerdown', onDown);
            canvas.addEventListener('pointermove', onMove);
            canvas.addEventListener('pointerup', onUp);
            canvas.addEventListener('pointerleave', onUp);
            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                if (!nexusUniverseState) return;
                nexusUniverseState.zoom = Math.max(0.5, Math.min(2.5, nexusUniverseState.zoom - e.deltaY * 0.001));
            }, { passive: false });
        }

        function renderNexusUniverseFrame() {
            const canvas = document.getElementById('nexusUniverseCanvas');
            if (!canvas || !nexusUniverseState) return;
            const ctx = canvas.getContext('2d');
            const { data, rotX, rotY, zoom } = nexusUniverseState;
            const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2;

            ctx.fillStyle = '#020208';
            ctx.fillRect(0, 0, w, h);

            const project = (x, y, z) => {
                let y1 = y * Math.cos(rotX) - z * Math.sin(rotX);
                let z1 = y * Math.sin(rotX) + z * Math.cos(rotX);
                let x1 = x * Math.cos(rotY) + z1 * Math.sin(rotY);
                let z2 = -x * Math.sin(rotY) + z1 * Math.cos(rotY);
                const scale = (280 / (280 + z2)) * zoom;
                return { sx: cx + x1 * scale, sy: cy + y1 * scale, scale, z2 };
            };

            // Center star (self)
            const center = project(0, 0, 0);
            const grad = ctx.createRadialGradient(center.sx, center.sy, 0, center.sx, center.sy, 22 * center.scale);
            grad.addColorStop(0, 'rgba(255,255,255,0.95)');
            grad.addColorStop(0.4, 'rgba(20,184,166,0.5)');
            grad.addColorStop(1, 'rgba(20,184,166,0)');
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(center.sx, center.sy, 22 * center.scale, 0, Math.PI * 2); ctx.fill();

            // Comets (own posts) — small dim trail dots
            ctx.fillStyle = 'rgba(56,189,248,0.55)';
            data.comets.forEach(c => {
                const p = project(c.x, c.y, c.z);
                ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(0.6, 1.2 * p.scale), 0, Math.PI * 2); ctx.fill();
            });

            // Connection lines + stars, sorted back-to-front for correct overlap
            const projected = data.stars.map(s => ({ s, p: project(s.x, s.y, s.z) })).sort((a, b) => b.p.z2 - a.p.z2);

            projected.forEach(({ s, p }) => {
                ctx.strokeStyle = s.isMutual ? 'rgba(59,130,246,0.25)' : 'rgba(148,163,184,0.12)';
                ctx.lineWidth = 0.6;
                ctx.beginPath(); ctx.moveTo(center.sx, center.sy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
            });

            projected.forEach(({ s, p }) => {
                const r = Math.max(0.8, s.size * p.scale);
                const color = s.isMutual ? '59,130,246' : '56,189,248';
                const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r * 3);
                g.addColorStop(0, `rgba(${color},${0.55 + s.closeness * 0.35})`);
                g.addColorStop(1, `rgba(${color},0)`);
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 3, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = `rgba(${color},0.95)`;
                ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
            });

            nexusUniverseAnimFrame = requestAnimationFrame(renderNexusUniverseFrame);
        }

        function shareNexusUniverse() {
            const canvas = document.getElementById('nexusUniverseCanvas');
            if (!canvas) return;
            canvas.toBlob(async (blob) => {
                if (!blob) return;
                const file = new File([blob], `${currentUser}-nexus-universe.png`, { type: 'image/png' });
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({ files: [file], title: `${currentUser}'s Nexus Universe`, text: `Ye raha mera Nexus Universe 🪐` });
                        return;
                    } catch (e) { /* fall through to download */ }
                }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${currentUser}-nexus-universe.png`;
                a.click();
            }, 'image/png');
        }

        // =====================================================================================
        // FEATURE: PRESENCE CONSTELLATION — mutuals rendered as ambient stars in a night sky.
        // No unread counts, no push notification — just a quiet, glanceable sense of who you're
        // closest to right now. Star position is a deterministic hash (same trick as Nexus
        // Universe) so a given person's star always sits in the same patch of sky; brightness is
        // recomputed each time you open it, from real recent interaction (DM volume, recency-
        // weighted). We can only ever compute true interaction strength for YOUR OWN sky — the
        // messages table only exposes rows you're actually a sender/receiver on — so someone
        // else's sky is shown informationally (even brightness) rather than faked.
        // =====================================================================================
        let constellationInteractionCache = {}; // { username: { score, ts } } — this session only

        function getConstellationMutuals(username) {
            const following = new Set((globalFollowsCache || []).filter(f => f.follower === username).map(f => f.following));
            const followers = new Set((globalFollowsCache || []).filter(f => f.following === username).map(f => f.follower));
            return Array.from(followers).filter(u => following.has(u) && u !== username).sort();
        }

        async function getInteractionScore(otherUser) {
            const cached = constellationInteractionCache[otherUser];
            if (cached && (Date.now() - cached.ts) < 5 * 60 * 1000) return cached.score;
            try {
                const since = new Date(Date.now() - 21 * 86400000).toISOString();
                const { count, error } = await supabaseClient
                    .from('messages')
                    .select('*', { count: 'exact', head: true })
                    .or(`and(sender.eq.${currentUser},receiver.eq.${otherUser}),and(sender.eq.${otherUser},receiver.eq.${currentUser})`)
                    .gte('created_at', since);
                if (error) throw error;
                const score = Math.min(1, Math.log((count || 0) + 1) / Math.log(40)); // soft log curve, caps out around ~40 msgs/3wk
                constellationInteractionCache[otherUser] = { score, ts: Date.now() };
                return score;
            } catch (e) {
                return 0.25; // messages table not reachable for some reason — keep the star dim but visible
            }
        }

        function starHashPosition(seedStr) {
            let hash = 0;
            for (let i = 0; i < seedStr.length; i++) hash = (Math.imul(hash, 31) + seedStr.charCodeAt(i)) | 0;
            const rand = mulberry32(hash >>> 0);
            return { xPct: 6 + rand() * 88, yPct: 6 + rand() * 62, delay: rand() * 3.6, initial: rand() };
        }

        async function openConstellationModal(username) {
            if (!username) return;
            const modal = document.getElementById('constellationModal');
            const layer = document.getElementById('constellationStarsLayer');
            const loading = document.getElementById('constellationLoading');
            const emptyState = document.getElementById('constellationEmptyState');
            if (!modal || !layer) return;

            document.getElementById('constellationTitle').innerText = username === currentUser ? 'Your Presence Constellation' : `${username}'s Constellation`;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            layer.innerHTML = '';
            emptyState.classList.add('hidden');
            loading.classList.remove('hidden');

            const mutuals = getConstellationMutuals(username);
            if (mutuals.length === 0) {
                loading.classList.add('hidden');
                emptyState.classList.remove('hidden');
                return;
            }

            const isOwnSky = username === currentUser;
            const scores = isOwnSky
                ? await Promise.all(mutuals.map(u => getInteractionScore(u)))
                : mutuals.map(() => 0.55); // someone else's sky: even, informational brightness only

            loading.classList.add('hidden');

            const frag = document.createDocumentFragment();
            mutuals.forEach((name, i) => {
                const { xPct, yPct, delay, initial } = starHashPosition(`${username}|${name}`);
                const score = scores[i];
                const size = 5 + score * 15;
                const minOp = 0.3 + score * 0.25;
                const maxOp = 0.55 + score * 0.45;
                const star = document.createElement('div');
                star.className = 'constellation-star';
                star.style.left = xPct + '%';
                star.style.top = yPct + '%';
                star.style.width = size + 'px';
                star.style.height = size + 'px';
                star.style.setProperty('--star-min', minOp.toFixed(2));
                star.style.setProperty('--star-max', maxOp.toFixed(2));
                star.style.animationDelay = `-${(delay + initial).toFixed(2)}s`;
                star.title = name;
                star.onclick = () => { closeConstellationModal(); openProfile(name); };
                frag.appendChild(star);
            });

            // "You" anchor star, low and warm, so the sky visually orbits around the viewer
            const youStar = document.createElement('div');
            youStar.className = 'constellation-star-you';
            youStar.style.left = '50%';
            youStar.style.top = '82%';
            youStar.style.width = '18px';
            youStar.style.height = '18px';
            youStar.style.transform = 'translate(-50%, -50%)';
            youStar.title = isOwnSky ? 'You' : username;
            frag.appendChild(youStar);

            layer.appendChild(frag);
        }
        window.openConstellationModal = openConstellationModal;

        function closeConstellationModal() {
            const modal = document.getElementById('constellationModal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
        window.closeConstellationModal = closeConstellationModal;

        // =====================================================================================
        // FEATURE: HANDSHAKE CONNECT — two phones near each other, both tap "Start Handshake",
        // and get matched instantly with an AI-generated icebreaker.
        //
        // HONEST LIMITATION: the Web Bluetooth call below is used as a genuine "there really is
        // a device nearby" nearby-check (it opens the real OS device chooser) — but browsers
        // don't allow one arbitrary web page to open a private GATT data channel to another
        // random phone's browser, so real profile data can't actually travel over Bluetooth here.
        // The instant profile-swap itself travels over a Supabase Realtime presence "lobby" —
        // which is why this currently pairs whichever two people tap the button around the same
        // time, not strictly whichever two are physically closest. Wiring this to a purpose-built
        // native/BLE-mesh layer would be the way to make proximity itself the matching signal.
        // =====================================================================================
        let handshakeState = null; // { channel, matched, timeoutId, myTs }
        let handshakeMatchedUser = null;

        function showHandshakeView(view) {
            document.getElementById('handshakeIdleView').classList.toggle('hidden', view !== 'idle');
            const searching = document.getElementById('handshakeSearchingView');
            searching.classList.toggle('hidden', view !== 'searching');
            searching.classList.toggle('flex', view === 'searching');
            const matched = document.getElementById('handshakeMatchedView');
            matched.classList.toggle('hidden', view !== 'matched');
            matched.classList.toggle('flex', view === 'matched');
        }

        function openHandshakeModal() {
            const modal = document.getElementById('handshakeModal');
            modal.classList.remove('hidden'); modal.classList.add('flex');
            showHandshakeView('idle');
            const note = document.getElementById('handshakeBluetoothNote');
            note.innerText = navigator.bluetooth
                ? 'Nearby-check ke liye ek Bluetooth device chooser khulega'
                : 'Yeh browser Web Bluetooth support nahi karta — seedha nearby-lobby se match karenge';
        }
        window.openHandshakeModal = openHandshakeModal;

        async function startHandshakeSearch() {
            showHandshakeView('searching');
            document.getElementById('handshakeStatusText').innerText = 'Nearby Nexus users dhoond rahe hain...';
            const btStatus = document.getElementById('handshakeBluetoothStatus');

            if (navigator.bluetooth) {
                btStatus.innerText = 'Bluetooth se nearby device check ho raha hai...';
                try {
                    await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
                    btStatus.innerText = '📶 Nearby device confirm — ab match dhoond rahe hain';
                } catch (e) {
                    btStatus.innerText = 'Bluetooth skip ho gaya — seedha lobby se match kar rahe hain';
                }
            } else {
                btStatus.innerText = 'Bluetooth support nahi mila — seedha lobby se match kar rahe hain';
            }

            beginHandshakeLobby();
        }
        window.startHandshakeSearch = startHandshakeSearch;

        function beginHandshakeLobby() {
            handshakeState = { channel: null, matched: false, timeoutId: null, myTs: Date.now() + Math.random() };
            const channel = supabaseClient.channel('handshake_lobby', { config: { presence: { key: currentUser } } });
            handshakeState.channel = channel;

            channel.on('presence', { event: 'sync' }, () => handleHandshakePresenceSync(channel));
            channel.on('broadcast', { event: 'match' }, (msg) => {
                if (!handshakeState || handshakeState.matched) return;
                const payload = msg.payload;
                if (payload && payload.to === currentUser) finalizeHandshakeMatch(payload.from);
            });
            channel.subscribe(async (status) => {
                if (status === 'SUBSCRIBED' && handshakeState) {
                    await channel.track({ ts: handshakeState.myTs });
                }
            });

            handshakeState.timeoutId = setTimeout(() => {
                if (handshakeState && !handshakeState.matched) {
                    document.getElementById('handshakeStatusText').innerText = 'Koi nearby nahi mila — dubara try karo';
                    setTimeout(() => { if (handshakeState && !handshakeState.matched) cancelHandshakeSearch(); }, 1800);
                }
            }, 25000);
        }

        // Deterministic pairing: everyone present sorts by join-time, gets paired up
        // (0,1), (2,3)... — the earlier of each pair ("leader") sends the match broadcast so
        // both sides converge on the exact same partner without a central server picking.
        function handleHandshakePresenceSync(channel) {
            if (!handshakeState || handshakeState.matched) return;
            const state = channel.presenceState();
            const entries = Object.keys(state)
                .map(username => ({ username, ts: (state[username][0] && state[username][0].ts) || 0 }))
                .sort((a, b) => a.ts - b.ts || a.username.localeCompare(b.username));

            const myIndex = entries.findIndex(e => e.username === currentUser);
            if (myIndex === -1) return;
            const partnerIndex = myIndex % 2 === 0 ? myIndex + 1 : myIndex - 1;
            const partner = entries[partnerIndex];
            if (!partner) return; // still the only one waiting

            if (myIndex % 2 === 0) {
                handshakeState.matched = true; // set before sending so a second sync can't double-fire
                channel.send({ type: 'broadcast', event: 'match', payload: { from: currentUser, to: partner.username } });
                finalizeHandshakeMatch(partner.username);
            }
        }

        async function finalizeHandshakeMatch(partnerUsername) {
            if (!handshakeState) return;
            handshakeState.matched = true;
            clearTimeout(handshakeState.timeoutId);
            try { await handshakeState.channel.untrack(); handshakeState.channel.unsubscribe(); } catch (e) { /* already gone */ }

            handshakeMatchedUser = partnerUsername;
            showHandshakeView('matched');
            const av = globalProfilesCache[partnerUsername];
            document.getElementById('handshakeMatchedAvatar').innerHTML = av ? `<img src="${av}" class="w-full h-full object-cover">` : partnerUsername.charAt(0).toUpperCase();
            document.getElementById('handshakeMatchedName').innerText = partnerUsername;
            generateHandshakeIcebreaker(partnerUsername);
        }

        async function generateHandshakeIcebreaker(partnerUsername) {
            const el = document.getElementById('handshakeIcebreakerText');
            el.innerText = 'Generate ho raha hai...';
            try {
                const myProfile = globalProfilesFullCache[currentUser] || {};
                const theirProfile = globalProfilesFullCache[partnerUsername] || {};
                const prompt = `Do log abhi-abhi Handshake Connect feature se (phone paas laakar) connect hue hain.\nMain: ${currentUser}\nDoosra: ${partnerUsername}\n\nEk hi bahut chhota (max 18 shabd), casual, friendly Hinglish icebreaker line likho jo main abhi unhe bhej sakoon. Sirf woh ek line likho, kuch aur text ya quotes nahi.`;
                const text = await askNexusAIOnce(prompt, "Tum ek friendly icebreaker line generator ho naye connections ke liye. Sirf ek chhota casual Hinglish line do, koi extra text ya quotes nahi.");
                el.innerText = (text || '').replace(/^["'“]+|["'”]+$/g, '').trim() || `Hey ${partnerUsername}! Milke acha laga 👋`;
            } catch (e) {
                console.error('Handshake icebreaker generation failed:', e);
                el.innerText = `Hey ${partnerUsername}! Milke acha laga 👋`;
            }
        }
        window.regenerateHandshakeIcebreaker = function () { if (handshakeMatchedUser) generateHandshakeIcebreaker(handshakeMatchedUser); };

        function useHandshakeIcebreaker() {
            if (!handshakeMatchedUser) return;
            const text = document.getElementById('handshakeIcebreakerText').innerText;
            const partner = handshakeMatchedUser;
            closeHandshakeModal();
            switchTab('chat');
            selectChatUser(partner, true);
            setTimeout(() => {
                const input = document.getElementById('chatInputText');
                if (input) { input.value = text; input.focus(); }
            }, 300);
        }
        window.useHandshakeIcebreaker = useHandshakeIcebreaker;

        function teardownHandshakeChannel() {
            if (handshakeState) {
                clearTimeout(handshakeState.timeoutId);
                try { handshakeState.channel && handshakeState.channel.untrack(); handshakeState.channel && handshakeState.channel.unsubscribe(); } catch (e) { /* noop */ }
            }
            handshakeState = null;
        }

        function cancelHandshakeSearch() {
            teardownHandshakeChannel();
            showHandshakeView('idle');
        }
        window.cancelHandshakeSearch = cancelHandshakeSearch;

        function resetHandshakeModal() {
            handshakeMatchedUser = null;
            showHandshakeView('idle');
        }
        window.resetHandshakeModal = resetHandshakeModal;

        function closeHandshakeModal() {
            teardownHandshakeChannel();
            document.getElementById('handshakeModal').classList.add('hidden');
            document.getElementById('handshakeModal').classList.remove('flex');
            handshakeMatchedUser = null;
            showHandshakeView('idle');
        }
        window.closeHandshakeModal = closeHandshakeModal;

        // FEATURE: MULTI-PERSONA IDENTITY — renders the 3 face-cards (Post/Twit/Channel).

        // Own profile: editable tone + bio per face. Other profiles: bio + a follow button
        // scoped to just that one face, so people can follow a single persona, not the whole account.
        // FEATURE: COLLAPSIBLE PERSONA PANEL — Multi-Persona Faces stays collapsed until tapped
        function togglePersonaPanel() {
            const panel = document.getElementById('personaCardsContainer');
            const chevron = document.getElementById('personaPanelChevron');
            if (!panel) return;
            const collapsed = panel.classList.toggle('hidden');
            if (chevron) chevron.style.transform = collapsed ? '' : 'rotate(180deg)';
        }
        window.togglePersonaPanel = togglePersonaPanel;

        function renderPersonaHub(username, isMe) {
            const container = document.getElementById('personaCardsContainer');
            const fullProfile = globalProfilesFullCache[username] || {};
            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — bios and per-face follower counts stay
            // hidden until a private account's request is accepted; only Follow/Requested shows
            const locked = !isMe && isPrivateAndNotFollowing(username);

            container.innerHTML = PERSONAS.map(p => {
                const bio = fullProfile[`persona_${p.key}_bio`] || '';
                const tone = fullProfile[`persona_${p.key}_tone`] || '';
                const faceFollowerCount = globalFollowsCache.filter(f => f.following === username && f.persona === p.key).length;

                if (isMe) {
                    const toneOptions = PERSONA_TONE_PRESETS.map(t => `<option value="${t}" ${tone === t ? 'selected' : ''}>${t}</option>`).join('');
                    return `
                        <div class="bg-slate-900/60 rounded-xl p-2.5 space-y-1.5" style="border-left:3px solid ${p.color}">
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-xs font-bold text-slate-200">${p.emoji} ${p.label}</span>
                                <span class="text-[11px] text-slate-400 shrink-0">${faceFollowerCount} following this face</span>
                            </div>
                            <select id="personaToneInput-${p.key}" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-[#14b8a6]">
                                <option value="">Tone (select one)...</option>
                                ${toneOptions}
                            </select>
                            <textarea id="personaBioInput-${p.key}" rows="2" maxlength="150" placeholder="${p.label} bio..." class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-[#14b8a6] resize-none">${bio}</textarea>
                            <button onclick="savePersonaProfile('${p.key}')" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-1.5 rounded-lg text-[11px] text-slate-200 transition">Save ${p.label}</button>
                        </div>
                    `;
                }

                const isFollowingPersona = globalFollowsCache.some(f => f.follower === currentUser && f.following === username && f.persona === p.key);
                const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === username && r.persona === p.key);
                let btnLabel = 'Follow', btnClass = 'bg-[#2563eb] border-[#3b82f6] text-white';
                if (isFollowingPersona) { btnLabel = 'Following'; btnClass = 'bg-slate-800 border-slate-700 text-slate-300'; }
                else if (hasPendingRequest) { btnLabel = 'Requested'; btnClass = 'bg-slate-800 border-slate-700 text-slate-400'; }

                if (locked) {
                    return `
                        <div class="bg-slate-900/60 rounded-xl p-2.5 space-y-1.5" style="border-left:3px solid ${p.color}">
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-xs font-bold text-slate-200">${p.emoji} ${p.label}</span>
                                <button ${hasPendingRequest ? 'disabled' : `onclick="togglePersonaFollow('${username}','${p.key}')"`} class="shrink-0 text-[11px] px-2.5 py-1 rounded-lg border font-bold transition ${btnClass}">${btnLabel}</button>
                            </div>
                            <p class="text-[11px] text-slate-400 italic"><i class="fa-solid fa-lock mr-1"></i>Follow to see bio</p>
                        </div>
                    `;
                }

                return `
                    <div class="bg-slate-900/60 rounded-xl p-2.5 space-y-1.5" style="border-left:3px solid ${p.color}">
                        <div class="flex items-center justify-between gap-2">
                            <div class="min-w-0 truncate">
                                <span class="text-xs font-bold text-slate-200">${p.emoji} ${p.label}</span>
                                ${tone ? `<span class="ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-300">${tone}</span>` : ''}
                            </div>
                            <button ${hasPendingRequest ? 'disabled' : `onclick="togglePersonaFollow('${username}','${p.key}')"`} class="shrink-0 text-[11px] px-2.5 py-1 rounded-lg border font-bold transition ${btnClass}">${btnLabel}</button>
                        </div>
                        <p class="text-[11px] text-slate-400">${bio ? bio.replace(/</g, '&lt;') : `<span class="text-slate-400 italic">No bio for this face yet.</span>`}</p>
                        <p class="text-[11px] text-slate-400">${faceFollowerCount} following this face</p>
                    </div>
                `;
            }).join('');

            document.getElementById('personaFeatureNotice').classList.toggle('hidden', personaFollowAvailable);
        }

        async function savePersonaProfile(personaKey) {
            const toneInput = document.getElementById(`personaToneInput-${personaKey}`);
            const bioInput = document.getElementById(`personaBioInput-${personaKey}`);
            const tone = toneInput ? toneInput.value : '';
            const bio = bioInput ? bioInput.value.trim() : '';
            try {
                const { error } = await supabaseClient.from('profiles').update({
                    [`persona_${personaKey}_tone`]: tone || null,
                    [`persona_${personaKey}_bio`]: bio || null
                }).eq('username', currentUser);
                if (error) throw error;
                await fetchAllData();
                openProfile(currentUser, false);
            } catch (e) {
                console.warn('Nexus: persona bio/tone columns not set up on profiles yet (see Multi-Persona SQL setup).', e);
                showAlertBanner('Multi-Persona bio/tone save karne ke liye pehle SQL setup complete karo (profiles table me persona_* columns add karo).', 'warning');
            }
        }

        // Follows/unfollows just ONE face of an account (not the whole account) — this is the
        // core of Multi-Persona Identity: someone can follow your Twit-Persona without ever
        // seeing/following your Post-Persona or Channel-Persona.
        async function togglePersonaFollow(targetUser, personaKey) {
            // BUGFIX: this used to wait for a full network round trip (insert/delete, then a
            // full fetchAllData() re-fetch of ~20 tables) before the button changed at all —
            // felt slow/unresponsive next to the like button, and often needed a second tap
            // since nothing visibly happened after the first one. Now it flips the button
            // instantly using the local cache (same pattern as toggleLike), syncs to the DB in
            // the background, and rolls back only if that sync actually fails.
            if (!targetUser || targetUser === currentUser) return;
            const isFollowing = globalFollowsCache.some(f => f.follower === currentUser && f.following === targetUser && f.persona === personaKey);
            const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === targetUser && r.persona === personaKey);
            if (hasPendingRequest) return;
            const wantsPrivateRequest = !isFollowing && isPrivateAndNotFollowing(targetUser);

            // Optimistic local update
            if (isFollowing) {
                globalFollowsCache = globalFollowsCache.filter(f => !(f.follower === currentUser && f.following === targetUser && f.persona === personaKey));
            } else if (wantsPrivateRequest) {
                globalFollowRequestsCache.push({ requester: currentUser, target: targetUser, persona: personaKey });
            } else {
                globalFollowsCache.push({ follower: currentUser, following: targetUser, persona: personaKey });
            }
            renderFeed();
            if (viewingProfileUsername === targetUser) renderPersonaHub(targetUser, false);

            try {
                if (isFollowing) {
                    const { error } = await supabaseClient.from('follows').delete().eq('follower', currentUser).eq('following', targetUser).eq('persona', personaKey);
                    if (error) throw error;
                } else if (wantsPrivateRequest) {
                    const { error } = await supabaseClient.from('follow_requests').insert({ requester: currentUser, target: targetUser, persona: personaKey });
                    if (error) throw error;
                } else {
                    const { error } = await supabaseClient.from('follows').insert({ follower: currentUser, following: targetUser, persona: personaKey });
                    if (error) throw error;
                }
                personaFollowAvailable = true;
            } catch (e) {
                console.warn('Nexus: follows/follow_requests.persona column not set up yet (see Multi-Persona SQL setup), or the save failed — rolling back.', e);
                personaFollowAvailable = false;
                // Roll back the optimistic change
                if (isFollowing) {
                    globalFollowsCache.push({ follower: currentUser, following: targetUser, persona: personaKey });
                } else if (wantsPrivateRequest) {
                    globalFollowRequestsCache = globalFollowRequestsCache.filter(r => !(r.requester === currentUser && r.target === targetUser && r.persona === personaKey));
                } else {
                    globalFollowsCache = globalFollowsCache.filter(f => !(f.follower === currentUser && f.following === targetUser && f.persona === personaKey));
                }
                renderFeed();
                if (viewingProfileUsername === targetUser) renderPersonaHub(targetUser, false);
                return;
            }

            // Quiet background refresh to stay in sync — doesn't block the UI
            fetchAllData();
        }

        function renderCloseFriendToggle(username) {
            const btn = document.getElementById('closeFriendToggleBtn');
            if (!closeFriendsFeatureAvailable) {
                btn.innerHTML = `<i class="fa-solid fa-star"></i> Close Friends setup pending`;
                btn.className = "w-full flex items-center justify-center gap-1.5 text-[11px] font-bold py-1.5 rounded-xl border border-slate-800 text-slate-400 cursor-not-allowed";
                btn.onclick = null;
                return;
            }
            const isClose = closeFriendsCache.has(username);
            btn.innerHTML = isClose
                ? `<i class="fa-solid fa-star"></i> Close Friend`
                : `<i class="fa-regular fa-star"></i> Add to Close Friends`;
            btn.className = isClose
                ? "w-full flex items-center justify-center gap-1.5 text-[11px] font-bold py-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 transition"
                : "w-full flex items-center justify-center gap-1.5 text-[11px] font-bold py-1.5 rounded-xl border border-slate-800 text-slate-300 hover:border-emerald-500/40 transition";
        }

        async function toggleCloseFriend() {
            const username = viewingProfileUsername;
            if (!username || !closeFriendsFeatureAvailable) return;
            const isClose = closeFriendsCache.has(username);
            try {
                if (isClose) {
                    await supabaseClient.from('close_friends').delete().eq('owner', currentUser).eq('friend_username', username);
                    closeFriendsCache.delete(username);
                } else {
                    await supabaseClient.from('close_friends').insert({ owner: currentUser, friend_username: username });
                    closeFriendsCache.add(username);
                }
                renderCloseFriendToggle(username);
            } catch (e) {
                console.warn('Nexus: close_friends table not set up yet.', e);
                closeFriendsFeatureAvailable = false;
                renderCloseFriendToggle(username);
            }
        }

        function switchProfileTab(tab) {
            profileActiveTab = tab;
            const postsBtn = document.getElementById('profTabPostsBtn');
            const reelsBtn = document.getElementById('profTabReelsBtn');
            const twitsBtn = document.getElementById('profTabTwitsBtn');
            const groupsBtn = document.getElementById('profTabGroupsBtn'); // FEATURE: PROFILE GROUPS/CHANNELS TAB
            const inactive = "flex-1 py-2 text-center text-slate-400 border-b-2 border-transparent transition";
            const active = "flex-1 py-2 text-center text-[#60a5fa] border-b-2 border-[#3b82f6] transition";

            postsBtn.className = tab === 'posts' ? active : inactive;
            reelsBtn.className = tab === 'reels' ? active : inactive;
            if (twitsBtn) twitsBtn.className = tab === 'twits' ? "flex-1 py-2 text-center text-[#38bdf8] border-b-2 border-[#38bdf8] transition" : inactive;
            if (groupsBtn) groupsBtn.className = tab === 'groups' ? "flex-1 py-2 text-center text-[#2dd4bf] border-b-2 border-[#14b8a6] transition" : inactive;
            refreshProfileTabView();
        }

        // FEATURE: PROFILE GROUPS/CHANNELS TAB — swaps between the post/reel/twit grid and the
        // groups/channels list depending on profileActiveTab, and renders whichever is showing.
        function refreshProfileTabView() {
            const gridContainer = document.getElementById('profileGridContainer');
            const groupsContainer = document.getElementById('profileGroupsListContainer');
            const memoryFadeRow = document.getElementById('memoryFadeRow');
            if (profileActiveTab === 'groups') {
                if (gridContainer) gridContainer.classList.add('hidden');
                if (memoryFadeRow) memoryFadeRow.classList.add('hidden');
                if (groupsContainer) groupsContainer.classList.remove('hidden');
                renderProfileGroupsList();
            } else {
                if (gridContainer) gridContainer.classList.remove('hidden');
                if (memoryFadeRow) memoryFadeRow.classList.remove('hidden');
                if (groupsContainer) groupsContainer.classList.add('hidden');
                renderProfileGrid();
            }
        }

        // =====================================================================================
        // FEATURE: FADING MEMORIES WALL — purely a display-layer treatment. Posts are NEVER
        // deleted, hidden from queries, or altered in the database; this only decides which CSS
        // filter class an old post's tile gets, based on how long ago it was posted. Toggle is
        // per-device (localStorage) so it never affects what anyone else sees on their screen.
        // =====================================================================================
        function isMemoryFadeEnabled() {
            return localStorage.getItem('nexus_memory_fade_disabled') !== '1';
        }
        function toggleMemoryFadePreference() {
            const enabled = isMemoryFadeEnabled();
            localStorage.setItem('nexus_memory_fade_disabled', enabled ? '1' : '0');
            const btn = document.getElementById('memoryFadeToggleBtn');
            if (btn) btn.innerText = enabled ? 'Fading: Off' : 'Fading: On';
            renderProfileGrid();
        }
        window.toggleMemoryFadePreference = toggleMemoryFadePreference;

        function getMemoryFadeClass(post) {
            if (!isMemoryFadeEnabled() || !post.created_at) return { cls: 'memory-fade-0', tag: null };
            const ageDays = (Date.now() - new Date(post.created_at).getTime()) / 86400000;
            if (ageDays < 14) return { cls: 'memory-fade-0', tag: null };
            if (ageDays < 45) return { cls: 'memory-fade-1', tag: null };
            if (ageDays < 120) return { cls: 'memory-fade-2', tag: '🕰️ fading' };
            return { cls: 'memory-fade-3', tag: '🕰️ old memory' };
        }

        function renderProfileGrid() {
            const container = document.getElementById('profileGridContainer');
            const fadeToggleBtn = document.getElementById('memoryFadeToggleBtn');
            if (fadeToggleBtn) fadeToggleBtn.innerText = isMemoryFadeEnabled() ? 'Fading: On' : 'Fading: Off';

            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — non-followers see a lock, not the grid
            if (isPrivateAndNotFollowing(viewingProfileUsername)) {
                container.innerHTML = `
                    <div class="col-span-3 text-center py-14 text-slate-400">
                        <i class="fa-solid fa-lock text-2xl mb-2"></i>
                        <p class="text-xs font-bold text-slate-300">This Account is Private</p>
                        <p class="text-[11px] mt-1">Follow ${viewingProfileUsername} to see their posts and reels.</p>
                    </div>
                `;
                return;
            }

            const userPosts = globalPostsCache.filter(p => {
                if (p.username !== viewingProfileUsername) return false;
                const isReel = p.platform === 'Reel' || (p.image_url && p.image_url.match(/\.(mp4|mov|webm)$/i));
                const isTwit = p.platform === 'Twitter' && !isReel;
                if (profileActiveTab === 'reels') return isReel;
                if (profileActiveTab === 'twits') return isTwit;
                return !isReel && !isTwit; // 'posts' tab
            }).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            if (userPosts.length === 0) {
                container.innerHTML = `<div class="col-span-3 text-center py-10 text-xs text-slate-400">No ${profileActiveTab} found.</div>`;
                return;
            }

            container.innerHTML = userPosts.map(post => {
                const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
                const { cls: fadeCls, tag: fadeTag } = getMemoryFadeClass(post);
                return `
                    <div onclick="openPostDetailModal('${post.id}')" class="aspect-square bg-slate-900 border ${post.pinned ? 'border-amber-500/50' : 'border-slate-800/80'} rounded-sm overflow-hidden relative cursor-pointer group">
                        ${post.pinned ? `<div class="absolute top-1.5 left-1.5 z-10 text-amber-400 text-[11px] drop-shadow"><i class="fa-solid fa-thumbtack"></i></div>` : ''}
                        <div class="absolute inset-0 ${fadeCls}">
                        ${isVideo ? 
                            `<video src="${post.image_url}" class="w-full h-full object-cover"></video><div class="absolute top-1.5 right-1.5 bg-black/60 px-1.5 py-0.5 rounded text-[11px] text-white"><i class="fa-solid fa-clapperboard"></i></div>` :
                            post.image_url ? 
                                `<img src="${post.image_url}" class="w-full h-full object-cover">` : 
                                `<div class="w-full h-full p-2 flex items-center justify-center text-[11px] text-slate-300 text-center bg-slate-950">${post.content.substring(0, 40)}...</div>`
                        }
                        </div>
                        ${fadeTag ? `<span class="memory-grain-tag">${fadeTag}</span>` : ''}
                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center space-x-3 text-white text-xs font-bold">
                            <span><i class="fa-solid fa-heart mr-1"></i>${globalLikesCache.filter(l => l.post_id === post.id).length}</span>
                            <span><i class="fa-solid fa-comment mr-1"></i>${globalCommentsCache.filter(c => c.post_id === post.id).length}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function closeProfileModal() {
            document.getElementById('profileModal').classList.add('hidden');
            viewingProfileUsername = null;
            resetProfileFlipToFront();
        }

        // NOTE: whole-account follow from the profile modal was replaced by Multi-Persona
        // Identity's per-face follow (see togglePersonaFollow) — kept here only in case any
        // other code still calls it directly.
        async function toggleFollowProfileUser() {
            // Same instant-flip-then-sync pattern as toggleLike / togglePersonaFollow.
            if(!viewingProfileUsername || viewingProfileUsername === currentUser) return;
            const targetUser = viewingProfileUsername;
            const isFollowing = globalFollowsCache.some(f => f.follower === currentUser && f.following === targetUser);
            const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === targetUser);
            if (hasPendingRequest) return;
            const wantsPrivateRequest = !isFollowing && isPrivateAndNotFollowing(targetUser);

            if (isFollowing) {
                globalFollowsCache = globalFollowsCache.filter(f => !(f.follower === currentUser && f.following === targetUser));
            } else if (wantsPrivateRequest) {
                globalFollowRequestsCache.push({ requester: currentUser, target: targetUser });
            } else {
                globalFollowsCache.push({ follower: currentUser, following: targetUser });
            }
            renderFeed();
            openProfile(targetUser, false);

            try {
                if (isFollowing) {
                    const { error } = await supabaseClient.from('follows').delete().eq('follower', currentUser).eq('following', targetUser);
                    if (error) throw error;
                } else if (wantsPrivateRequest) {
                    const { error } = await supabaseClient.from('follow_requests').insert({ requester: currentUser, target: targetUser });
                    if (error) throw error;
                } else {
                    const { error } = await supabaseClient.from('follows').insert({ follower: currentUser, following: targetUser });
                    if (error) throw error;
                }
            } catch (err) {
                console.error("Follow save failed (did you run the follow_requests migration?):", err);
                if (isFollowing) {
                    globalFollowsCache.push({ follower: currentUser, following: targetUser });
                } else if (wantsPrivateRequest) {
                    globalFollowRequestsCache = globalFollowRequestsCache.filter(r => !(r.requester === currentUser && r.target === targetUser));
                } else {
                    globalFollowsCache = globalFollowsCache.filter(f => !(f.follower === currentUser && f.following === targetUser));
                }
                renderFeed();
                openProfile(targetUser, false);
                return;
            }
            fetchAllData();
        }

        async function toggleFollowFromFeed(targetUser) {
            // BUGFIX: same instant-flip-then-sync pattern as toggleLike — this used to wait on
            // a full fetchAllData() round trip before the suggestion card updated at all.
            if(targetUser === currentUser) return;
            const isFollowing = globalFollowsCache.some(f => f.follower === currentUser && f.following === targetUser);
            const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === targetUser);
            if (hasPendingRequest) return;
            const wantsPrivateRequest = !isFollowing && isPrivateAndNotFollowing(targetUser);

            if (isFollowing) {
                globalFollowsCache = globalFollowsCache.filter(f => !(f.follower === currentUser && f.following === targetUser));
            } else if (wantsPrivateRequest) {
                globalFollowRequestsCache.push({ requester: currentUser, target: targetUser });
            } else {
                globalFollowsCache.push({ follower: currentUser, following: targetUser });
            }
            renderFeed();
            renderSuggestedUsers();
            if (viewingProfileUsername === targetUser) openProfile(targetUser, false);

            try {
                if (isFollowing) {
                    const { error } = await supabaseClient.from('follows').delete().eq('follower', currentUser).eq('following', targetUser);
                    if (error) throw error;
                } else if (wantsPrivateRequest) {
                    const { error } = await supabaseClient.from('follow_requests').insert({ requester: currentUser, target: targetUser });
                    if (error) throw error;
                } else {
                    const { error } = await supabaseClient.from('follows').insert({ follower: currentUser, following: targetUser });
                    if (error) throw error;
                }
            } catch (err) {
                console.error("Follow request failed (did you run the follow_requests migration?):", err);
                if (isFollowing) {
                    globalFollowsCache.push({ follower: currentUser, following: targetUser });
                } else if (wantsPrivateRequest) {
                    globalFollowRequestsCache = globalFollowRequestsCache.filter(r => !(r.requester === currentUser && r.target === targetUser));
                } else {
                    globalFollowsCache = globalFollowsCache.filter(f => !(f.follower === currentUser && f.following === targetUser));
                }
                renderFeed();
                renderSuggestedUsers();
                if (viewingProfileUsername === targetUser) openProfile(targetUser, false);
                return;
            }
            fetchAllData();
        }

        function openFollowList(type) {
            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — follower/following identities are detail too
            if (viewingProfileUsername !== currentUser && isPrivateAndNotFollowing(viewingProfileUsername)) {
                showAlertBanner(`${viewingProfileUsername} is private — follow them to see this.`, 'warning');
                return;
            }
            const titleEl = document.getElementById('followListTitle');
            const container = document.getElementById('followListContainer');
            container.innerHTML = '';

            let rows = [];
            if(type === 'followers') {
                titleEl.innerText = `${viewingProfileUsername}'s Followers`;
                rows = globalFollowsCache.filter(f => f.following === viewingProfileUsername);
            } else {
                titleEl.innerText = `${viewingProfileUsername} is Following`;
                rows = globalFollowsCache.filter(f => f.follower === viewingProfileUsername);
            }

            // A single account can now appear here more than once (one row per persona face
            // followed), so group by account and collect which face(s) tie them together.
            const grouped = new Map();
            rows.forEach(f => {
                const u = type === 'followers' ? f.follower : f.following;
                if (!grouped.has(u)) grouped.set(u, new Set());
                if (f.persona) grouped.get(u).add(f.persona);
            });
            const users = Array.from(grouped.keys());

            if(users.length === 0) {
                container.innerHTML = `<p class="text-xs text-slate-400 text-center py-4">No users found.</p>`;
            } else {
                users.forEach(u => {
                    const av = globalProfilesCache[u];
                    const personaKeys = grouped.get(u);
                    const personaBadges = PERSONAS.filter(p => personaKeys.has(p.key)).map(p => `<span title="${p.label}">${p.emoji}</span>`).join('');
                    const div = document.createElement('div');
                    div.className = "flex items-center justify-between bg-slate-900 border border-slate-800 p-2 rounded-xl text-xs cursor-pointer hover:bg-slate-800 transition";
                    div.innerHTML = `
                        <div class="flex items-center space-x-2 w-full">
                            <div class="w-7 h-7 rounded-full bg-[#334155] flex items-center justify-center font-bold text-[11px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                            <span class="font-bold text-slate-200 truncate">${u}</span>
                            ${personaBadges ? `<span class="text-[11px] shrink-0 ml-auto pr-1" title="Faces followed">${personaBadges}</span>` : ''}
                        </div>
                    `;
                    div.onclick = () => {
                        closeFollowListModal();
                        closeProfileModal();
                        handleUserClick(u);
                    };
                    container.appendChild(div);
                });
            }

            document.getElementById('followListModal').classList.remove('hidden');
        }

        function closeFollowListModal() {
            document.getElementById('followListModal').classList.add('hidden');
        }

        function openCropperModal(input, target) {
            cropperTarget = target || 'profile';
            if (cropperTarget === 'group') {
                cropperTargetGroupId = document.getElementById('groupInfoModal').dataset.groupId;
            }
            if (input.files && input.files[0]) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = document.getElementById('imageToCrop');
                    img.src = e.target.result;
                    document.getElementById('cropperModal').classList.remove('hidden');
                    
                    if (cropper) cropper.destroy();
                    cropper = new Cropper(img, {
                        aspectRatio: 1,
                        viewMode: 1,
                        dragMode: 'move',
                        autoCropArea: 1,
                        cropBoxMovable: true,
                        cropBoxResizable: true,
                        toggleDragModeOnDblclick: false,
                    });
                };
                reader.readAsDataURL(input.files[0]);
            }
        }

        function cancelCropper() {
            document.getElementById('cropperModal').classList.add('hidden');
            if (cropper) { cropper.destroy(); cropper = null; }
            const inputId = cropperTarget === 'group' ? 'groupImageFileInput' : 'profileImageFileInput';
            const inputEl = document.getElementById(inputId);
            if (inputEl) inputEl.value = '';
        }

        async function cropAndUploadImage() {
            if (!cropper) return;
            
            const canvas = cropper.croppedCanvas || cropper.getCroppedCanvas({ width: 250, height: 250 });
            const uploadBtn = document.getElementById('cropAndUploadBtn');
            if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.innerText = 'Uploading...'; }

            canvas.toBlob(async (blob) => {
                // BUGFIX: canvas.toBlob() can hand back null (e.g. tainted/cross-origin canvas,
                // or the browser just failing to encode) — that used to silently fall through
                // and upload an empty/invalid file with no feedback to the user at all.
                if (!blob) {
                    console.error("Profile picture upload: canvas.toBlob() returned null blob.");
                    showAlertBanner("Photo crop fail ho gaya (blob null aaya) — dusri photo try karo.", 'error');
                    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.innerText = 'Save Photo'; }
                    return;
                }

                const isGroupTarget = cropperTarget === 'group';
                const fileName = `${Date.now()}_${isGroupTarget ? 'group' : 'profile'}.jpg`;
                const fileObj = new File([blob], fileName, { type: 'image/jpeg' });

                try {
                    const upAv = await uploadMediaFile(fileName, fileObj);
                    const data = null, error = upAv.error;
                    if (!error) {
                        const publicUrl = upAv.url;

                        // FEATURE: GROUP DP — same crop/upload flow as the profile picture, but
                        // writes to groups.avatar_url for the group open in Group Info instead of
                        // profiles.avatar_url. Needs an "avatar_url" text column on "groups".
                        if (isGroupTarget) {
                            const groupId = cropperTargetGroupId || document.getElementById('groupInfoModal').dataset.groupId;
                            const { error: groupError } = await supabaseClient.from('groups').update({ avatar_url: publicUrl }).eq('id', groupId);
                            if (groupError) {
                                console.error("Group avatar DB update failed (check for a 'groups.avatar_url' column):", groupError);
                                showAlertBanner('Photo upload hui, lekin group update fail ho gaya — Supabase "groups" table me "avatar_url" column check karo: ' + groupError.message, 'error');
                                if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.innerText = 'Save Photo'; }
                                return;
                            }
                            const grp = globalGroupsCache.find(g => String(g.id) === String(groupId));
                            if (grp) grp.avatar_url = publicUrl;

                            cancelCropper();
                            renderGroupsList();
                            openGroupInfoModal(groupId);
                            if (activeGroupId && String(activeGroupId) === String(groupId)) openGroupChat(groupId);
                            showAlertBanner('Group photo updated!', 'success');
                        } else {
                            const { error: profileError } = await supabaseClient.from('profiles').update({ avatar_url: publicUrl }).eq('username', currentUser);
                            if (profileError) {
                                console.error("Profile avatar DB update failed:", profileError);
                                showAlertBanner('Photo upload hui, lekin profile update fail ho gaya: ' + profileError.message, 'error');
                                if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.innerText = 'Save Photo'; }
                                return;
                            }
                            globalProfilesCache[currentUser] = publicUrl;

                            cancelCropper();
                            await fetchAllData();
                            openProfile(currentUser, false);
                            showAlertBanner('Profile picture updated successfully!', 'success');
                        }
                    } else {
                        console.error("Avatar storage upload failed:", error);
                        showAlertBanner("Upload failed: " + (error.message || "Make sure bucket 'media' is public."), 'error');
                    }
                } catch(err) {
                    // BUGFIX: this used to only console.error and leave the user staring at a
                    // modal that looked stuck, with no idea anything went wrong ("silent fail").
                    console.error("Picture upload threw an unexpected error:", err);
                    showAlertBanner("Photo upload karte waqt unexpected error aaya: " + (err.message || 'Unknown error'), 'error');
                } finally {
                    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.innerText = 'Save Photo'; }
                }
            }, 'image/jpeg');
        }

        async function saveProfileChanges() {
            const newUsername = document.getElementById('editUsernameInput').value.trim();
            if(!newUsername || newUsername === currentUser) return;

            const oldUsername = currentUser;

            const { error: renameError } = await supabaseClient.from('profiles').update({ username: newUsername }).eq('username', oldUsername);
            if (renameError) {
                showAlertBanner('Username update failed: ' + renameError.message, 'error');
                return;
            }

            // Cascade the rename across every table that stores the username as a text
            // reference (there's no real foreign key), so posts, followers/following,
            // chats, likes, comments, stories, groups, and calls all stay intact —
            // only the username label itself changes, just like Instagram.
            const cascadeUpdates = [
                supabaseClient.from('posts').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('follows').update({ follower: newUsername }).eq('follower', oldUsername),
                supabaseClient.from('follows').update({ following: newUsername }).eq('following', oldUsername),
                supabaseClient.from('follow_requests').update({ requester: newUsername }).eq('requester', oldUsername),
                supabaseClient.from('follow_requests').update({ target: newUsername }).eq('target', oldUsername),
                supabaseClient.from('post_likes').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('post_views').update({ viewer: newUsername }).eq('viewer', oldUsername),
                supabaseClient.from('comments').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('comment_likes').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('messages').update({ sender: newUsername }).eq('sender', oldUsername),
                supabaseClient.from('messages').update({ receiver: newUsername }).eq('receiver', oldUsername),
                supabaseClient.from('message_reactions').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('stories').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('story_views').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('blocked_users').update({ blocker: newUsername }).eq('blocker', oldUsername),
                supabaseClient.from('blocked_users').update({ blocked: newUsername }).eq('blocked', oldUsername),
                supabaseClient.from('group_members').update({ username: newUsername }).eq('username', oldUsername),
                supabaseClient.from('groups').update({ created_by: newUsername }).eq('created_by', oldUsername),
                supabaseClient.from('calls').update({ caller_id: newUsername }).eq('caller_id', oldUsername),
                supabaseClient.from('calls').update({ callee_id: newUsername }).eq('callee_id', oldUsername),
                supabaseClient.from('reports').update({ reporter: newUsername }).eq('reporter', oldUsername),
                supabaseClient.from('reports').update({ reported_user: newUsername }).eq('reported_user', oldUsername)
            ];

            const results = await Promise.allSettled(cascadeUpdates);
            results.forEach(r => {
                if (r.status === 'rejected' || (r.value && r.value.error)) {
                    console.error("Username cascade update issue (a table may not exist yet):", r.reason || (r.value && r.value.error));
                }
            });

            localStorage.setItem('nexus_user', newUsername);
            currentUser = newUsername;
            document.getElementById('displayUsername').innerText = newUsername;
            closeProfileModal();
            await fetchAllData();
            showAlertBanner('Username updated successfully!', 'success');
        }

        function selectChatUser(username, updateState = true) {
            activeChatUser = username;
            if(updateState) {
                localStorage.setItem('nexus_active_chat', username);
            }
            
            document.getElementById('mainNavbar').classList.add('hidden');
            document.getElementById('chatUsersView').classList.add('hidden');
            document.getElementById('chatRoomView').classList.remove('hidden');
            
            const titleEl = document.getElementById('chatWithTitle');
            titleEl.innerHTML = `<span class="inline-flex items-center gap-1">${username} ${verifiedBadgeHtml(username)} ${adminBadgeHtml(username)}</span>`;
            titleEl.onclick = () => openProfile(username);

            updateOnlineStatusUI();
            cancelReply();
            hideTypingIndicator();
            updateChatRequestUI(username); // FEATURE: MESSAGE REQUESTS

            // (Re)create a dedicated broadcast channel to send typing signals to this chat partner
            if (typingSendChannel) supabaseClient.removeChannel(typingSendChannel);
            typingSendChannel = supabaseClient.channel('typing_' + username);
            typingSendChannel.subscribe();
            
            loadDirectMessages(username, true);

            // PERF: this used to poll every 2.5s the entire time a chat was open — the
            // single biggest source of constant network load in the app. The realtime
            // channels above (widened to INSERT/UPDATE/DELETE) now catch everything that
            // poll was for instantly, so this is just a rare safety net in case a realtime
            // event ever gets dropped (e.g. a flaky connection reconnecting).
            if(messagePollingInterval) clearInterval(messagePollingInterval);
            messagePollingInterval = setInterval(() => {
                if(activeChatUser) {
                    loadDirectMessages(activeChatUser, false);
                }
            }, 25000);
        }

        function closeChatRoom() {
            activeChatUser = null;
            localStorage.removeItem('nexus_active_chat');
            if(messagePollingInterval) clearInterval(messagePollingInterval);
            if(typingSendChannel) { supabaseClient.removeChannel(typingSendChannel); typingSendChannel = null; }
            hideTypingIndicator();
            cancelReply();
            
            document.getElementById('mainNavbar').classList.remove('hidden');
            document.getElementById('chatRoomView').classList.add('hidden');
            document.getElementById('chatUsersView').classList.remove('hidden');
            loadLoggedUsers();
        }

        // Toggle the "..." options dropdown in the 1:1 chat header
        function toggleChatOptionsMenu(e) {
            e.stopPropagation();
            const menu = document.getElementById('chatOptionsMenu');
            menu.classList.toggle('hidden');
        }

        // Opens the "Delete Chat" choice modal (Delete for Me vs Delete for Everyone).
        // Called both from the open chat room ("..." menu) and directly from a row in the users list.
        function openDeleteChatModal(targetUser) {
            if (!targetUser) return;
            document.getElementById('deleteChatModal').dataset.targetUser = targetUser;
            document.getElementById('deleteChatModalUsername').innerText = targetUser;
            document.getElementById('deleteChatModal').classList.remove('hidden');
        }

        function closeDeleteChatModal() {
            document.getElementById('deleteChatModal').classList.add('hidden');
        }

        // "Delete for Me": hides this chat's message history on THIS account only.
        // Nothing is removed from the database — the other person's copy of the chat is untouched
        // and they will not know anything was deleted. Any new messages sent/received after this
        // point will still show up normally.
        function confirmDeleteChatForMe() {
            const targetUser = document.getElementById('deleteChatModal').dataset.targetUser;
            if (!targetUser) return;
            if (!confirm(`Delete chat with ${targetUser} sirf apni taraf se? ${targetUser} ko unki chat me kuch change nahi dikhega.`)) return;

            setDeletedForMeTimestamp(targetUser);
            closeDeleteChatModal();

            if (activeChatUser === targetUser) {
                loadDirectMessages(targetUser, true);
            } else {
                loadLoggedUsers();
            }
        }

        // "Delete for Everyone": permanently deletes every message both ways from the database.
        // This affects both users — once done, neither side can recover the chat.
        async function confirmDeleteChatForEveryone() {
            const targetUser = document.getElementById('deleteChatModal').dataset.targetUser;
            if (!targetUser) return;
            if (!confirm(`Delete entire chat with ${targetUser} for everyone? Ye sabhi messages dono taraf se hamesha ke liye delete ho jayenge.`)) return;

            await supabaseClient
                .from('messages')
                .delete()
                .or(`and(sender.eq.${currentUser},receiver.eq.${targetUser}),and(sender.eq.${targetUser},receiver.eq.${currentUser})`);

            disappearingChatsSet.delete(targetUser);
            clearDeletedForMeTimestamp(targetUser);
            closeDeleteChatModal();

            if (activeChatUser === targetUser) {
                closeChatRoom();
            } else {
                loadLoggedUsers();
            }
        }

        // --- "Delete for Me" storage helpers ---
        // Stored client-side (per logged-in username, keyed by chat partner) since messages are
        // shared rows in the DB and there's no per-user "hidden" column. This keeps the hide local
        // to this account/device without touching the other person's data.
        function getDeletedForMeMap() {
            try { return JSON.parse(localStorage.getItem('nexus_deleted_for_me') || '{}'); }
            catch (e) { return {}; }
        }
        function setDeletedForMeTimestamp(targetUser) {
            const map = getDeletedForMeMap();
            map[`${currentUser}|${targetUser}`] = new Date().toISOString();
            localStorage.setItem('nexus_deleted_for_me', JSON.stringify(map));
        }
        function clearDeletedForMeTimestamp(targetUser) {
            const map = getDeletedForMeMap();
            delete map[`${currentUser}|${targetUser}`];
            localStorage.setItem('nexus_deleted_for_me', JSON.stringify(map));
        }
        function getDeletedForMeTimestamp(targetUser) {
            const map = getDeletedForMeMap();
            return map[`${currentUser}|${targetUser}`] || null;
        }

        // Updates the online/offline dot + label in the chat header for the active chat partner
        function updateOnlineStatusUI() {
            if (!activeChatUser) return;
            const dot = document.getElementById('chatStatusDot');
            const label = document.getElementById('chatStatusLabel');
            if (!dot || !label) return;

            const isOnline = onlineUsersSet.has(activeChatUser);
            dot.className = isOnline ? "w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" : "w-1.5 h-1.5 rounded-full bg-slate-600";
            label.innerText = isOnline ? "Online" : "Offline";
            label.className = isOnline ? "text-[11px] font-semibold text-emerald-400" : "text-[11px] font-semibold text-slate-400";
        }

        // Shows the "typing..." indicator bar and auto-hides it if no new typing signal arrives
        function showTypingIndicator() {
            const bar = document.getElementById('typingIndicatorBar');
            const label = document.getElementById('typingIndicatorText');
            if (!bar) return;
            label.innerText = `${activeChatUser} is typing`;
            bar.classList.remove('hidden');
            bar.classList.add('flex');

            if (typingHideTimeout) clearTimeout(typingHideTimeout);
            typingHideTimeout = setTimeout(hideTypingIndicator, 2200);
        }

        function hideTypingIndicator() {
            const bar = document.getElementById('typingIndicatorBar');
            if (!bar) return;
            bar.classList.add('hidden');
            bar.classList.remove('flex');
            if (typingHideTimeout) { clearTimeout(typingHideTimeout); typingHideTimeout = null; }
        }

        // Broadcasts a "typing" event to the active chat partner (throttled to avoid spamming)
        function sendTypingBroadcast() {
            if (!typingSendChannel || !activeChatUser) return;
            const now = Date.now();
            if (now - lastTypingSentAt < 1200) return;
            lastTypingSentAt = now;
            typingSendChannel.send({
                type: 'broadcast',
                event: 'typing',
                payload: { from: currentUser }
            });
        }

        // Formats a Date into a short "HH:MM" time label for message bubbles
        function formatMessageTimestamp(date) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        // Formats a Date into "Today", "Yesterday", or a full date for date separators
        function formatDateSeparator(date) {
            const today = new Date();
            const yesterday = new Date();
            yesterday.setDate(today.getDate() - 1);

            const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

            if (isSameDay(date, today)) return 'Today';
            if (isSameDay(date, yesterday)) return 'Yesterday';
            return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
        }

        // Sets the message being replied to (triggered by swiping a message bubble) and shows the preview bar
        function setReplyTarget(messageId) {
            const msg = currentChatMessagesMap[messageId];
            if (!msg) return;
            replyingToMessage = {
                id: msg.id,
                sender: msg.sender === currentUser ? 'You' : msg.sender,
                text: msg.text
            };

            document.getElementById('replyPreviewSender').innerText = replyingToMessage.sender;
            document.getElementById('replyPreviewText').innerText = replyingToMessage.text;
            const bar = document.getElementById('replyPreviewBar');
            bar.classList.remove('hidden');
            bar.classList.add('flex');
            document.getElementById('chatInputText').focus();
        }

        function cancelReply() {
            replyingToMessage = null;
            const bar = document.getElementById('replyPreviewBar');
            if (!bar) return;
            bar.classList.add('hidden');
            bar.classList.remove('flex');
        }

        // Swipe-to-reply gesture: swipe your own message LEFT, or the other person's message RIGHT, to reply to it
        (function setupSwipeToReply() {
            let dragState = null;

            function onPointerDown(e) {
                const wrapper = e.target.closest('.msg-swipe-item');
                if (!wrapper) return;
                dragState = {
                    wrapper,
                    startX: e.clientX,
                    isMe: wrapper.dataset.isMe === '1',
                    msgId: wrapper.dataset.msgId,
                    dragging: true
                };
            }

            function onPointerMove(e) {
                if (!dragState || !dragState.dragging) return;
                let delta = e.clientX - dragState.startX;

                // Restrict movement to the allowed direction only: own messages swipe left (negative), others swipe right (positive)
                if (dragState.isMe) {
                    delta = Math.min(0, Math.max(delta, -70));
                } else {
                    delta = Math.max(0, Math.min(delta, 70));
                }

                dragState.wrapper.style.transform = `translateX(${delta}px)`;
                dragState.lastDelta = delta;
            }

            function onPointerUp() {
                if (!dragState) return;
                const delta = dragState.lastDelta || 0;
                dragState.wrapper.style.transform = 'translateX(0px)';

                if (Math.abs(delta) > 45) {
                    setReplyTarget(dragState.msgId);
                }
                dragState = null;
            }

            document.addEventListener('DOMContentLoaded', () => {
                const chatBox = document.getElementById('chatMessagesBox');
                if (!chatBox) return;
                chatBox.addEventListener('pointerdown', onPointerDown);
                chatBox.addEventListener('pointermove', onPointerMove);
                chatBox.addEventListener('pointerup', onPointerUp);
                chatBox.addEventListener('pointerleave', onPointerUp);
                chatBox.addEventListener('pointercancel', onPointerUp);
            });
        })();

        // FEATURE: FADING MESSAGE — blur/opacity grows the longer an opened-but-unreplied
        // incoming message sits ignored (capped at 24h). Purely a rendering-time computation
        // off the existing read_at column — no schema change needed.
        function computeFadingMessageStyle(readAtIso) {
            const FADE_WINDOW_MS = 24 * 60 * 60 * 1000;
            const elapsed = Date.now() - new Date(readAtIso).getTime();
            if (elapsed <= 0) return null;
            const progress = Math.min(1, elapsed / FADE_WINDOW_MS);
            if (progress < 0.03) return null; // negligible fade right after opening
            return {
                blur: (progress * 5).toFixed(1),
                opacity: Math.max(0.28, 1 - progress * 0.72).toFixed(2)
            };
        }

        // FIX: chat message lists get rebuilt on every poll / realtime update, which used to
        // blow away and recreate any <video> element inside the message bubbles (shared
        // reels/videos in DM & group chat) — so a video would play for ~1s and then jump
        // back to 0 the moment the next refresh landed. This snapshots the currentTime /
        // paused / muted state of any video the user is watching before the HTML is
        // replaced, and re-applies it to the new video element right after, so playback
        // continues smoothly across re-renders instead of restarting.
        function replaceChatHtmlPreservingVideo(container, newHtml) {
            const videoStates = {};
            container.querySelectorAll('video[data-msg-id]').forEach(v => {
                videoStates[v.getAttribute('data-msg-id')] = {
                    currentTime: v.currentTime,
                    paused: v.paused,
                    muted: v.muted
                };
            });

            container.innerHTML = newHtml;

            container.querySelectorAll('video[data-msg-id]').forEach(v => {
                const state = videoStates[v.getAttribute('data-msg-id')];
                if (!state) return;
                v.muted = state.muted;
                if (state.currentTime > 0.1) {
                    v.currentTime = state.currentTime;
                }
                if (!state.paused) {
                    v.play().catch(() => {});
                }
            });
        }

        // ===== FEATURE FIX: OPTIMISTIC MESSAGE SEND + OFFLINE/SLOW-NETWORK QUEUE =====
        // pendingMessages[partnerUsername] = array of messages that have been "sent" from the
        // user's point of view (input cleared, bubble shown) but haven't been confirmed saved
        // to Supabase yet. Status is 'sending' while a network attempt is in flight, or
        // 'failed' if the last attempt didn't make it through — failed ones are retried
        // automatically the moment the browser reports it's back online, and can also be
        // retried manually by tapping the bubble.
        let pendingMessages = {};

        window.addEventListener('online', () => { retryAllPendingMessages(); });

        async function retryAllPendingMessages() {
            for (const partner of Object.keys(pendingMessages)) {
                const list = pendingMessages[partner] || [];
                for (const pm of [...list]) {
                    if (pm.status === 'failed') await attemptSendPendingMessage(partner, pm.tempId);
                }
            }
        }

        async function attemptSendPendingMessage(partner, tempId, isRetryAfterRefresh = false) {
            const list = pendingMessages[partner] || [];
            const pm = list.find(p => p.tempId === tempId);
            if (!pm) return;

            pm.status = 'sending';
            if (partner === activeChatUser) loadDirectMessages(partner, true);

            try {
                // FIX: force a session check before every send. supabase-js's background
                // auto-refresh timer gets throttled/paused by mobile browsers once the tab
                // is backgrounded (installed PWA included) — so after the app sits idle for
                // a while, the cached access token can be stale by the time you come back
                // and hit Send. getSession() here checks expiry and silently refreshes if
                // needed, so the insert below uses a valid token instead of failing first.
                await supabaseClient.auth.getSession();

                let mediaUrl = null;
                if (pm.mediaFile) {
                    const fileName = `chat_${Date.now()}_${pm.mediaFile.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                    const upC = await uploadMediaFile(fileName, pm.mediaFile);
                    if (upC.error) throw upC.error;
                    mediaUrl = upC.url;
                }

                const messagePayload = {
                    sender: currentUser,
                    receiver: pm.receiver,
                    text: pm.text || '[Media Attachment]',
                    media_url: mediaUrl
                };
                if (pm.replyingToMessage) {
                    // FIX: keep the id as the same type the DB column expects — coerce to a
                    // number when it looks numeric instead of always sending a string, which
                    // some Postgres bigint columns reject depending on how strict the column's
                    // insert policy/check is.
                    const rid = pm.replyingToMessage.id;
                    messagePayload.reply_to_id = (typeof rid === 'string' && /^\d+$/.test(rid)) ? Number(rid) : rid;
                    messagePayload.reply_to_sender = pm.replyingToMessage.sender;
                    messagePayload.reply_to_text = pm.replyingToMessage.text;
                }
                if (pm.disappearing) {
                    messagePayload.expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                }

                const { error: msgInsertError } = await supabaseClient.from('messages').insert(messagePayload);
                if (msgInsertError) throw msgInsertError;

                // Success — drop it from the pending queue, the real row will show up
                // via the normal message fetch/realtime listener.
                pendingMessages[partner] = (pendingMessages[partner] || []).filter(p => p.tempId !== tempId);
                if (partner === activeChatUser) loadDirectMessages(partner, true);
                loadLoggedUsers();
            } catch (err) {
                // FIX: an expired/invalid JWT surfaces as a 401 or a Postgrest message
                // mentioning the token — force a hard session refresh and silently retry
                // ONCE before showing the user any failure. This is what fixes "works fine
                // at first, then fails after the app's been idle a bit".
                const msg = (err && err.message ? err.message : '').toLowerCase();
                const looksLikeAuthError = err && (err.status === 401 || err.code === 'PGRST301' || msg.includes('jwt') || msg.includes('token'));
                if (looksLikeAuthError && !isRetryAfterRefresh) {
                    console.warn('Message send hit an auth error, refreshing session and retrying once:', err);
                    try {
                        await supabaseClient.auth.refreshSession();
                    } catch (refreshErr) {
                        console.warn('Session refresh failed:', refreshErr);
                    }
                    return attemptSendPendingMessage(partner, tempId, true);
                }

                console.error('Message send failed:', err);
                pm.status = 'failed';
                if (partner === activeChatUser) loadDirectMessages(partner, true);
                // Only bother the user with a banner if we're actually online (so it's a real
                // error, e.g. permissions) — a plain offline failure just waits quietly to retry.
                if (navigator.onLine) {
                    const detail = err && (err.message || err.code) ? `${err.message || ''}${err.code ? ' [' + err.code + ']' : ''}` : 'network error';
                    showAlertBanner('Message send nahi hua: ' + detail, 'error');
                }
            }
        }

        function retryPendingMessage(partner, tempId) {
            attemptSendPendingMessage(partner, tempId);
        }

        function renderPendingMessagesHtml(targetUser) {
            const list = pendingMessages[targetUser] || [];
            return list.map(pm => `
                <div class="flex flex-col items-end space-y-0.5">
                    <div class="max-w-[80%] p-2.5 rounded-2xl text-xs bg-[#2563eb] text-white rounded-br-none space-y-1.5 relative shadow opacity-70">
                        ${pm.mediaPreviewUrl ? `<img src="${pm.mediaPreviewUrl}" class="w-full max-h-48 rounded-lg object-cover">` : ''}
                        <p class="leading-relaxed break-words">${pm.text}</p>
                    </div>
                    <span class="text-[11px] text-slate-400 px-1 flex items-center gap-1">
                        ${pm.status === 'failed'
                            ? `<i class="fa-solid fa-triangle-exclamation text-red-400"></i> Failed — <button onclick="retryPendingMessage('${targetUser}','${pm.tempId}')" class="underline text-[#60a5fa]">retry</button>`
                            : `<i class="fa-solid fa-clock"></i> Sending...`}
                    </span>
                </div>
            `).join('');
        }

        async function loadDirectMessages(targetUser, forceScroll = false) {
            // Clean up any expired disappearing messages first (best-effort; fire and forget)
            await cleanupExpiredMessages(targetUser);

            const { data: rawMessages, error } = await supabaseClient
                .from('messages')
                .select('*')
                .or(`and(sender.eq.${currentUser},receiver.eq.${targetUser}),and(sender.eq.${targetUser},receiver.eq.${currentUser})`)
                .order('created_at', { ascending: true });

            // "Delete for Me" is client-side only: messages sent/received before the timestamp
            // are hidden on THIS account only. The database rows are untouched, so the other
            // person's chat still shows everything normally.
            const deletedForMeAt = getDeletedForMeTimestamp(targetUser);
            const messages = (rawMessages || []).filter(m => !deletedForMeAt || new Date(m.created_at) > new Date(deletedForMeAt));

            const chatBox = document.getElementById('chatMessagesBox');

            // Update the disappearing-mode toggle icon for this chat
            const dIcon = document.getElementById('disappearingIcon');
            const dBtn = document.getElementById('disappearingToggleBtn');
            if (dIcon && dBtn) {
                const isOn = disappearingChatsSet.has(targetUser);
                dIcon.className = isOn ? "fa-solid fa-fire text-xs text-orange-400" : "fa-solid fa-fire text-xs";
                dBtn.className = isOn ? "w-8 h-8 rounded-full bg-orange-500/20 border border-orange-500 hover:bg-orange-500/30 text-orange-400 flex items-center justify-center transition shadow" : "w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 flex items-center justify-center transition shadow";
            }
            
            if (error || !messages || messages.length === 0) {
                const pendingHtml = renderPendingMessagesHtml(targetUser);
                chatBox.innerHTML = pendingHtml
                    ? `<div class="text-center text-xs text-slate-400 my-auto">No messages yet with ${targetUser}. Say hello! 👋</div>${pendingHtml}`
                    : `<div class="text-center text-xs text-slate-400 my-auto">No messages yet with ${targetUser}. Say hello! 👋</div>`;
                currentChatMessagesMap = {};
                updatePinnedBanner('dm');
                if (pendingHtml) chatBox.scrollTop = chatBox.scrollHeight;
                return;
            }

            let htmlContent = '';
            let lastDateLabel = null;
            currentChatMessagesMap = {}; // reset lookup map used by swipe-to-reply
            const unreadIncomingIds = [];

            // FEATURE: FADING MESSAGE — timestamps of everything *I've* sent in this thread,
            // used below to check whether an incoming message was ever replied to.
            const myOutgoingTimestamps = messages.filter(m => m.sender === currentUser).map(m => new Date(m.created_at).getTime());

            messages.forEach(msg => {
                currentChatMessagesMap[msg.id] = msg;

                const isMe = msg.sender === currentUser;
                if (!isMe && !msg.read_at) unreadIncomingIds.push(msg.id);

                const isVideoMedia = msg.media_url && msg.media_url.match(/\.(mp4|mov|webm)$/i);
                const msgDate = new Date(msg.created_at || Date.now());
                const dateLabel = formatDateSeparator(msgDate);
                const timeLabel = formatMessageTimestamp(msgDate);

                // Date separator: inserted whenever the day changes between messages
                if (dateLabel !== lastDateLabel) {
                    htmlContent += `
                        <div class="flex justify-center my-1.5">
                            <span class="bg-slate-900 border border-slate-800 text-slate-400 text-[11px] font-bold px-2.5 py-1 rounded-full">${dateLabel}</span>
                        </div>
                    `;
                    lastDateLabel = dateLabel;
                }

                // Quoted reply preview shown inside the bubble, if this message is a reply
                const replyBlockHtml = msg.reply_to_id ? `
                    <div class="border-l-2 ${isMe ? 'border-white/50' : 'border-[#3b82f6]'} pl-2 ${isMe ? 'bg-white/10' : 'bg-slate-950/60'} rounded-md py-1 mb-1">
                        <p class="text-[11px] font-bold ${isMe ? 'text-white/80' : 'text-[#60a5fa]'}">${msg.reply_to_sender || ''}</p>
                        <p class="text-[11px] ${isMe ? 'text-white/70' : 'text-slate-400'} truncate">${msg.reply_to_text || ''}</p>
                    </div>
                ` : (msg.reply_to_story_id ? `
                    <div class="flex items-center gap-1.5 border-l-2 ${isMe ? 'border-white/50' : 'border-[#3b82f6]'} pl-2 ${isMe ? 'bg-white/10' : 'bg-slate-950/60'} rounded-md py-1 mb-1">
                        ${msg.reply_to_story_media ? `<img src="${msg.reply_to_story_media}" class="w-6 h-8 object-cover rounded">` : ''}
                        <p class="text-[11px] font-bold ${isMe ? 'text-white/80' : 'text-[#60a5fa]'}"><i class="fa-solid fa-circle-play mr-0.5"></i>Replied to ${isMe ? (msg.reply_to_story_username || 'their') + "'s" : 'your'} story</p>
                    </div>
                ` : '');

                // Read receipt ticks - only shown on the sender's own messages
                let ticksHtml = '';
                if (isMe) {
                    ticksHtml = msg.read_at
                        ? `<i class="fa-solid fa-check-double text-[11px] text-[#38bdf8]" title="Read"></i>`
                        : `<i class="fa-solid fa-check text-[11px] text-slate-400" title="Sent"></i>`;
                }

                const reactionsHtml = renderReactionBadgesHtml(msg.id, 'dm');
                const disappearBadge = msg.expires_at ? `<i class="fa-solid fa-fire text-[11px] text-orange-400" title="Disappearing message"></i>` : '';
                const editedBadge = msg.edited_at && !msg.is_deleted ? `<span class="text-[11px] text-slate-400 italic">(edited)</span>` : '';

                // FEATURE: FADING MESSAGE — an incoming message you've opened but never replied
                // to gradually blurs/fades over the next 24 hours. Replying makes it sharp again.
                let fadeInfo = null;
                if (!isMe && msg.read_at && !msg.is_deleted && msg.type !== 'voice') {
                    const repliedAfter = myOutgoingTimestamps.some(t => t > new Date(msg.created_at).getTime());
                    if (!repliedAfter) fadeInfo = computeFadingMessageStyle(msg.read_at);
                }

                // Deleted-for-everyone: show placeholder instead of real content
                let bodyHtml;
                if (msg.is_deleted) {
                    bodyHtml = `<p class="leading-relaxed italic text-slate-400 flex items-center gap-1"><i class="fa-solid fa-ban text-[11px]"></i> This message was deleted</p>`;
                } else if (msg.type === 'voice' && msg.audio_url) {
                    bodyHtml = `<audio src="${msg.audio_url}" controls class="max-w-[220px] h-9"></audio>`;
                } else {
                    const fadeStyleAttr = fadeInfo ? ` style="filter:blur(${fadeInfo.blur}px); opacity:${fadeInfo.opacity}; transition: filter 1s ease, opacity 1s ease;"` : '';
                    const fadeBadge = fadeInfo ? `<i class="fa-solid fa-water text-[11px] text-slate-400 ml-1" title="Reply karo isse pehle ki ye poori tarah fade ho jaaye"></i>` : '';
                    bodyHtml = `
                        ${msg.media_url ? (
                            isVideoMedia ? 
                            `<video src="${msg.media_url}" data-msg-id="${msg.id}" onclick="event.stopPropagation(); openChatMediaTap('${msg.media_url}', true, ${msg.shared_post_id ? `'${msg.shared_post_id}'` : 'null'})" controls playsinline class="w-full max-h-48 rounded-lg object-cover cursor-pointer"></video>` :
                            `<img src="${msg.media_url}" onclick="event.stopPropagation(); openChatMediaTap('${msg.media_url}', false, ${msg.shared_post_id ? `'${msg.shared_post_id}'` : 'null'})" class="w-full max-h-48 rounded-lg object-cover cursor-pointer">`
                        ) : ''}
                        <p class="leading-relaxed break-words"${fadeStyleAttr} id="msgtext-${msg.id}">${msg.text} ${editedBadge}${fadeBadge}</p>
                    `;
                }

                const canModify = isMe && !msg.is_deleted && msg.type !== 'voice';

                htmlContent += `
                    <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-0.5 msg-swipe-item" data-msg-id="${msg.id}" data-is-me="${isMe ? '1' : '0'}" style="touch-action: pan-y;">
                        <div class="max-w-[80%] p-2.5 rounded-2xl shadow ${isMe ? 'bg-[#2563eb] text-white rounded-br-none' : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none'} text-xs space-y-1.5 relative group" ondblclick="${msg.is_deleted ? '' : `openReactionPicker(event, '${msg.id}', 'dm')`}">
                            ${replyBlockHtml}
                            ${bodyHtml}
                            ${!msg.is_deleted ? `<button onclick="setReplyTarget('${msg.id}')" class="absolute -top-2 ${isMe ? '-left-2' : '-right-2'} bg-slate-800 text-[#38bdf8] p-1 rounded-full text-[11px] shadow opacity-0 group-hover:opacity-100 transition" title="Reply"><i class="fa-solid fa-reply"></i></button>` : ''}
                            ${!msg.is_deleted ? `<button onclick="togglePinMessage('${msg.id}', 'dm')" class="absolute -bottom-2 ${isMe ? '-right-2' : '-left-2'} ${msg.pinned_at ? 'bg-yellow-500 text-black' : 'bg-slate-800 text-yellow-400'} p-1 rounded-full text-[11px] shadow opacity-0 group-hover:opacity-100 transition" title="${msg.pinned_at ? 'Unpin' : 'Pin'}"><i class="fa-solid fa-thumbtack"></i></button>` : ''}
                            ${!msg.is_deleted ? `<button onclick="openReactionPicker(event, '${msg.id}', 'dm')" class="absolute -bottom-2 ${isMe ? '-left-2' : 'left-2'} bg-slate-800 text-yellow-400 p-1 rounded-full text-[11px] shadow opacity-0 group-hover:opacity-100 transition" title="React"><i class="fa-solid fa-face-smile"></i></button>` : ''}
                            ${canModify ? `<button onclick="startEditMessage('${msg.id}')" class="absolute -top-2 ${isMe ? '-right-9' : '-right-9'} bg-slate-800 text-emerald-400 p-1 rounded-full text-[11px] shadow opacity-0 group-hover:opacity-100 transition" title="Edit"><i class="fa-solid fa-pencil"></i></button>` : ''}
                            ${isMe && !msg.is_deleted ? `<button onclick="deleteMessage('${msg.id}')" class="absolute -top-2 -right-2 bg-slate-800 text-red-400 p-1 rounded-full text-[11px] shadow opacity-0 group-hover:opacity-100 transition" title="Delete for everyone"><i class="fa-solid fa-xmark"></i></button>` : ''}
                        </div>
                        ${reactionsHtml}
                        <span class="text-[11px] text-slate-400 px-1 flex items-center gap-1">${timeLabel} ${disappearBadge} ${ticksHtml}</span>
                    </div>
                `;
            });

            htmlContent += renderPendingMessagesHtml(targetUser);

            // FIX: previously this force-scrolled to bottom any time the rendered HTML
            // differed at all — which is true on almost every 2.5s background poll (read
            // ticks, fading-message blur, relative timestamps all change the markup even
            // when no new message arrived). That yanked the user back to the bottom while
            // they were mid-scroll reading older messages, and made the keyboard-open
            // re-render feel like it was "auto scrolling on its own". Now: only jump to
            // bottom when the caller explicitly asked for it (opening the chat, sending
            // your own message) OR the user was already sitting at/near the bottom before
            // this update (so new incoming messages still auto-follow, like every chat app).
            const htmlChanged = chatBox.innerHTML !== htmlContent;
            const distanceFromBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight;
            const wasNearBottom = distanceFromBottom < 120;

            if (htmlChanged) {
                replaceChatHtmlPreservingVideo(chatBox, htmlContent);
            }

            if (forceScroll || (htmlChanged && wasNearBottom)) {
                chatBox.scrollTop = chatBox.scrollHeight;
            }

            if (unreadIncomingIds.length > 0 && !ghostModeEnabled) {
                markMessagesRead(unreadIncomingIds);
                // FEATURE: UNREAD MESSAGE COUNT — clear this sender's badge immediately so it
                // doesn't keep showing a stale count once we've actually opened their chat.
                if (unreadCountsBySender[targetUser]) {
                    delete unreadCountsBySender[targetUser];
                }
            }

            updatePinnedBanner('dm');

        }

        // ===== FEATURE: PINNED MESSAGES IN CHAT =====
        let dmPinnedIndex = 0;
        let groupPinnedIndex = 0;

        function getPinnedMessages(type) {
            const pool = type === 'dm' ? Object.values(currentChatMessagesMap || {}) : (globalGroupMessagesCache || []);
            return pool.filter(m => m.pinned_at).sort((a, b) => new Date(a.pinned_at) - new Date(b.pinned_at));
        }

        async function togglePinMessage(id, type) {
            const table = type === 'dm' ? 'messages' : 'group_messages';
            const pool = type === 'dm' ? currentChatMessagesMap : null;
            const msg = type === 'dm' ? (pool ? pool[id] : null) : globalGroupMessagesCache.find(m => m.id === id);
            if (!msg) return;

            const newValue = msg.pinned_at ? null : new Date().toISOString();
            msg.pinned_at = newValue; // optimistic local update so the pin icon reacts instantly
            await supabaseClient.from(table).update({ pinned_at: newValue }).eq('id', id);

            if (type === 'dm') {
                loadDirectMessages(activeChatUser);
            } else {
                renderGroupMessages();
            }
            updatePinnedBanner(type);
        }

        // Shows/hides the sticky "pinned" banner above the chat, with the count and current text.
        function updatePinnedBanner(type) {
            const pinned = getPinnedMessages(type);
            const banner = document.getElementById(type === 'dm' ? 'dmPinnedBanner' : 'groupPinnedBanner');
            const textEl = document.getElementById(type === 'dm' ? 'dmPinnedBannerText' : 'groupPinnedBannerText');
            if (!banner || !textEl) return;

            if (pinned.length === 0) {
                banner.classList.add('hidden');
                banner.classList.remove('flex');
                return;
            }
            banner.classList.remove('hidden');
            banner.classList.add('flex');
            const idxRef = type === 'dm' ? 'dmPinnedIndex' : 'groupPinnedIndex';
            if ((type === 'dm' ? dmPinnedIndex : groupPinnedIndex) >= pinned.length) {
                if (type === 'dm') dmPinnedIndex = 0; else groupPinnedIndex = 0;
            }
            const current = pinned[type === 'dm' ? dmPinnedIndex : groupPinnedIndex];
            const label = current.text || (current.media_url ? '📷 Photo' : 'Message');
            textEl.innerText = pinned.length > 1 ? `(${(type === 'dm' ? dmPinnedIndex : groupPinnedIndex) + 1}/${pinned.length}) ${label}` : label;
        }

        // Tapping the banner cycles through pinned messages and scrolls to the current one.
        function cyclePinnedMessage(type) {
            const pinned = getPinnedMessages(type);
            if (pinned.length === 0) return;
            if (type === 'dm') dmPinnedIndex = (dmPinnedIndex + 1) % pinned.length;
            else groupPinnedIndex = (groupPinnedIndex + 1) % pinned.length;
            updatePinnedBanner(type);

            const current = pinned[type === 'dm' ? dmPinnedIndex : groupPinnedIndex];
            const el = document.querySelector(`[data-msg-id="${current.id}"]`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('ring-2', 'ring-yellow-400');
                setTimeout(() => el.classList.remove('ring-2', 'ring-yellow-400'), 1200);
            }
        }

        function unpinCurrentBannerMessage(type) {
            const pinned = getPinnedMessages(type);
            if (pinned.length === 0) return;
            const current = pinned[type === 'dm' ? dmPinnedIndex : groupPinnedIndex];
            togglePinMessage(current.id, type);
        }

        // Marks incoming messages as read (sets read_at) so the sender sees the double-tick
        async function markMessagesRead(ids) {
            try {
                await supabaseClient.from('messages').update({ read_at: new Date().toISOString() }).in('id', ids);
            } catch (err) {
                console.error("markMessagesRead error:", err);
            }
        }

        // Deletes any disappearing messages between me and targetUser whose expiry has passed
        async function cleanupExpiredMessages(targetUser) {
            try {
                const nowIso = new Date().toISOString();
                await supabaseClient
                    .from('messages')
                    .delete()
                    .lt('expires_at', nowIso)
                    .or(`and(sender.eq.${currentUser},receiver.eq.${targetUser}),and(sender.eq.${targetUser},receiver.eq.${currentUser})`);
            } catch (err) {
                // Non-fatal - expired messages will just get cleaned up on a later load
            }
        }

        // Toggles "disappearing mode" for the currently open 1-1 chat. When ON, new messages
        // sent in this chat get an expires_at 24h in the future and are auto-deleted after.
        function toggleDisappearingMode() {
            if (!activeChatUser) return;
            if (disappearingChatsSet.has(activeChatUser)) {
                disappearingChatsSet.delete(activeChatUser);
            } else {
                disappearingChatsSet.add(activeChatUser);
            }
            localStorage.setItem('nexus_disappearing_chats', JSON.stringify(Array.from(disappearingChatsSet)));
            loadDirectMessages(activeChatUser, false);
        }

        // ---- Reactions (shared helper for both 1-1 messages and group messages) ----
        function renderReactionBadgesHtml(messageId, source) {
            const relevant = globalReactionsCache.filter(r => r.message_id === messageId && r.source === source);
            if (relevant.length === 0) return '';
            const counts = {};
            relevant.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
            const badges = Object.keys(counts).map(emoji => {
                const mine = relevant.some(r => r.emoji === emoji && r.username === currentUser);
                return `<span onclick="quickToggleReaction('${messageId}', '${emoji}', '${source}')" class="cursor-pointer text-[11px] px-1.5 py-0.5 rounded-full border ${mine ? 'bg-[#2563eb]/20 border-[#3b82f6] text-[#60a5fa]' : 'bg-slate-800 border-slate-700 text-slate-300'}">${emoji} ${counts[emoji]}</span>`;
            }).join(' ');
            return `<div class="flex flex-wrap gap-1 px-1">${badges}</div>`;
        }

        function openReactionPicker(event, messageId, source) {
            event.stopPropagation();
            activeReactionMsgId = messageId;
            activeReactionSource = source;
            const picker = document.getElementById('reactionPicker');
            const rect = event.currentTarget.getBoundingClientRect();
            picker.style.top = Math.max(10, rect.top - 44) + 'px';
            picker.style.left = Math.min(window.innerWidth - 190, Math.max(10, rect.left)) + 'px';
            picker.classList.remove('hidden');
            picker.classList.add('flex');
        }

        document.addEventListener('click', (e) => {
            const picker = document.getElementById('reactionPicker');
            if (picker && !picker.classList.contains('hidden') && !picker.contains(e.target)) {
                picker.classList.add('hidden');
                picker.classList.remove('flex');
            }

            const chatMenu = document.getElementById('chatOptionsMenu');
            if (chatMenu && !chatMenu.classList.contains('hidden') && !chatMenu.contains(e.target) && e.target.id !== 'chatOptionsBtn' && !e.target.closest('#chatOptionsBtn')) {
                chatMenu.classList.add('hidden');
            }
        });

        async function pickReaction(emoji) {
            if (!activeReactionMsgId) return;
            await quickToggleReaction(activeReactionMsgId, emoji, activeReactionSource);
            document.getElementById('reactionPicker').classList.add('hidden');
            activeReactionMsgId = null;
        }

        // Adds the reaction if the user hasn't reacted with this emoji yet, otherwise removes it (toggle)
        async function quickToggleReaction(messageId, emoji, source) {
            const existing = globalReactionsCache.find(r => r.message_id === messageId && r.username === currentUser && r.source === source);
            try {
                if (existing && existing.emoji === emoji) {
                    await supabaseClient.from('message_reactions').delete().eq('id', existing.id);
                } else if (existing) {
                    await supabaseClient.from('message_reactions').update({ emoji }).eq('id', existing.id);
                } else {
                    await supabaseClient.from('message_reactions').insert({ message_id: messageId, username: currentUser, emoji, source });
                }
                await fetchAllData();
                if (activeChatUser && source === 'dm') loadDirectMessages(activeChatUser, false);
                if (activeGroupId && source === 'group') renderGroupMessages();
            } catch (err) {
                console.error("Reaction error:", err);
            }
        }

        // Deletes a message "for everyone" — soft delete: text is replaced with a placeholder
        // for both users, rather than hard-removing the row (so both sides see it was removed).
        async function deleteMessage(id) {
            if (!confirm("Delete this message for everyone?")) return;
            try {
                await supabaseClient.from('messages').update({ is_deleted: true, text: 'This message was deleted' }).eq('id', id);
            } catch (err) {
                // Fallback for DBs that haven't run the is_deleted migration yet
                console.error("Soft-delete failed, is_deleted column missing? Falling back to hard delete:", err);
                await supabaseClient.from('messages').delete().eq('id', id);
            }
            if (activeChatUser) loadDirectMessages(activeChatUser, false);
        }

        // Puts a message bubble into inline-edit mode
        function startEditMessage(id) {
            const msg = currentChatMessagesMap[id];
            if (!msg) return;
            editingMessageId = id;
            const textEl = document.getElementById(`msgtext-${id}`);
            if (!textEl) return;
            textEl.innerHTML = `
                <span class="flex items-center gap-1.5">
                    <input type="text" id="editInput-${id}" value="${msg.text.replace(/"/g, '&quot;')}" class="flex-1 bg-black/20 border border-white/30 rounded-lg px-2 py-1 text-xs text-inherit focus:outline-none">
                    <button onclick="saveMessageEdit('${id}')" class="text-emerald-300"><i class="fa-solid fa-check"></i></button>
                    <button onclick="loadDirectMessages(activeChatUser, false)" class="text-red-300"><i class="fa-solid fa-xmark"></i></button>
                </span>
            `;
            document.getElementById(`editInput-${id}`).focus();
        }

        async function saveMessageEdit(id) {
            const input = document.getElementById(`editInput-${id}`);
            if (!input) return;
            const newText = input.value.trim();
            if (!newText) return;
            try {
                await supabaseClient.from('messages').update({ text: newText, edited_at: new Date().toISOString() }).eq('id', id);
            } catch (err) {
                console.error("Edit failed, edited_at column missing? Saving text only:", err);
                await supabaseClient.from('messages').update({ text: newText }).eq('id', id);
            }
            editingMessageId = null;
            if (activeChatUser) loadDirectMessages(activeChatUser, false);
        }

        // ===== FEATURE: MULTI-IMAGE CAROUSEL POSTS =====
        // Builds the media block for a post/reel: a normal single image/video when there's
        // only one, or a swipeable horizontal carousel with a "1/N" counter when there are several.
        function buildPostMediaHtml(post, carouselId) {
            const urls = Array.isArray(post.media_urls) && post.media_urls.length > 0 ? post.media_urls : (post.image_url ? [post.image_url] : []);
            if (urls.length === 0) return '';

            if (urls.length === 1) {
                const isVideo = post.platform === 'Reel' || urls[0].match(/\.(mp4|mov|webm)$/i);
                return `
                    <div onclick="openPostDetailModal('${post.id}')" class="rounded-xl overflow-hidden border border-slate-800 bg-slate-950 flex justify-center cursor-pointer">
                        ${isVideo ? `<video src="${urls[0]}" class="w-full max-h-80 object-cover pointer-events-none"></video>` : `<img src="${urls[0]}" class="w-full max-h-80 object-cover" />`}
                    </div>`;
            }

            const slides = urls.map(u => `<img src="${u}" class="w-full h-full object-cover snap-center shrink-0" style="scroll-snap-align: center;">`).join('');
            return `
                <div class="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950">
                    <div id="${carouselId}" onscroll="updateCarouselDots('${carouselId}')" onclick="openPostDetailModal('${post.id}')" class="flex overflow-x-auto no-scrollbar w-full h-72 cursor-pointer" style="scroll-snap-type: x mandatory;">
                        ${slides}
                    </div>
                    <span id="${carouselId}-counter" class="absolute top-2 right-2 bg-black/60 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">1/${urls.length}</span>
                    <div id="${carouselId}-dots" class="absolute bottom-2 inset-x-0 flex justify-center gap-1">
                        ${urls.map((_, i) => `<span class="w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-white' : 'bg-white/40'}" data-dot-index="${i}"></span>`).join('')}
                    </div>
                </div>`;
        }

        // Keeps the "1/N" counter and dot indicators in sync as the user swipes through a carousel.
        function updateCarouselDots(carouselId) {
            const el = document.getElementById(carouselId);
            if (!el) return;
            const slideWidth = el.clientWidth || 1;
            const index = Math.round(el.scrollLeft / slideWidth);
            const dotsWrap = document.getElementById(`${carouselId}-dots`);
            const counter = document.getElementById(`${carouselId}-counter`);
            if (dotsWrap) {
                dotsWrap.querySelectorAll('[data-dot-index]').forEach(dot => {
                    dot.className = `w-1.5 h-1.5 rounded-full ${Number(dot.dataset.dotIndex) === index ? 'bg-white' : 'bg-white/40'}`;
                });
            }
            if (counter) {
                const total = dotsWrap ? dotsWrap.children.length : 1;
                counter.innerText = `${index + 1}/${total}`;
            }
        }

        // FEATURE: ON THIS DAY — resurfaces your own posts from the same calendar day in past years
        let onThisDayDismissedToday = sessionStorage.getItem('nexus_otd_dismissed') === new Date().toDateString();
        function renderOnThisDay() {
            const card = document.getElementById('onThisDayCard');
            if (!card) return;
            if (onThisDayDismissedToday) { card.classList.add('hidden'); card.innerHTML = ''; return; }

            const today = new Date();
            const memories = globalPostsCache.filter(p => {
                if (p.username !== currentUser) return false;
                const d = new Date(p.created_at);
                return d.getMonth() === today.getMonth() && d.getDate() === today.getDate() && d.getFullYear() < today.getFullYear();
            }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            if (memories.length === 0) { card.classList.add('hidden'); card.innerHTML = ''; return; }

            const memory = memories[0];
            const yearsAgo = today.getFullYear() - new Date(memory.created_at).getFullYear();
            const thumb = memory.image_url && !memory.image_url.match(/\.(mp4|mov|webm)$/i) ? memory.image_url : null;

            card.classList.remove('hidden');
            card.innerHTML = `
                <div class="glass-panel rounded-2xl p-3 flex items-center gap-3 border-l-4" style="border-left-color:#f5a524">
                    ${thumb ? `<img src="${thumb}" class="w-12 h-12 rounded-xl object-cover shrink-0">` : `<div class="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center text-lg shrink-0">📅</div>`}
                    <div class="flex-1 min-w-0 cursor-pointer" onclick="openPostDetailModal('${memory.id}')">
                        <p class="text-[11px] font-bold text-amber-400">On This Day — ${yearsAgo} year${yearsAgo > 1 ? 's' : ''} ago</p>
                        <p class="text-xs text-slate-300 truncate">${(memory.content || '').replace(/</g,'&lt;')}</p>
                    </div>
                    <button onclick="dismissOnThisDay()" class="shrink-0 text-slate-400 hover:text-white text-xs px-1"><i class="fa-solid fa-xmark"></i></button>
                </div>
            `;
        }
        function dismissOnThisDay() {
            onThisDayDismissedToday = true;
            sessionStorage.setItem('nexus_otd_dismissed', new Date().toDateString());
            renderOnThisDay();
        }

        function renderFeed() {
            const feedStream = document.getElementById('feedStream');
            if (!globalPostsCache) return;

            renderOnThisDay();
            feedStream.innerHTML = '';
            globalPostsCache.filter(post => !isBlockedWith(post.username) && !isPrivateAndNotFollowing(post.username)).forEach(post => {
                const postLikes = globalLikesCache.filter(l => l.post_id === post.id);
                const hasLiked = postLikes.some(l => l.username === currentUser);
                const postComments = globalCommentsCache.filter(c => c.post_id === post.id);
                const posterAvatar = globalProfilesCache[post.username];
                // FEATURE: MULTI-PERSONA IDENTITY — a post's platform tag IS its persona face,
                // so the feed's Follow button follows just that one face, not the whole account.
                const postPersona = personaForKey(personaKeyForPlatform(post.platform));
                const isFollowingPersona = post.username === currentUser || globalFollowsCache.some(f => f.follower === currentUser && f.following === post.username && f.persona === postPersona.key);
                const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
                let styleAccent = '#38bdf8'; // Twit
                if (post.platform === 'Instagram') styleAccent = '#3b82f6'; // Post
                else if (post.platform === 'Telegram') styleAccent = '#14b8a6'; // Channel
                else if (post.platform === 'Reel') styleAccent = '#f5a524'; // Reel

                const card = document.createElement('div');
                card.className = "glass-panel rounded-2xl p-3 space-y-2.5 shadow-md";
                card.style.borderLeft = `3px solid ${styleAccent}`;
                card.innerHTML = `
                    <div class="flex justify-between items-center text-xs">
                        <div class="flex items-center space-x-2">
                            <div onclick="handleUserClick('${post.username}')" class="w-6 h-6 rounded-full bg-[#334155] flex items-center justify-center font-bold text-[11px] text-white cursor-pointer shadow overflow-hidden">
                                ${posterAvatar ? `<img src="${posterAvatar}" class="w-full h-full object-cover">` : post.username.charAt(0).toUpperCase()}
                            </div>
                            <span onclick="handleUserClick('${post.username}')" class="font-bold text-slate-200 cursor-pointer hover:text-[#60a5fa] transition flex items-center gap-1">${post.username} ${verifiedBadgeHtml(post.username)} ${adminBadgeHtml(post.username)}</span>
                            ${post.username !== currentUser ? `<button onclick="togglePersonaFollow('${post.username}','${postPersona.key}')" title="Follow just this face — not the whole account" class="ml-1 text-[11px] px-2 py-0.5 rounded-lg border ${isFollowingPersona ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-[#2563eb] border-[#3b82f6] text-white font-bold'} transition">${isFollowingPersona ? `Following ${postPersona.emoji}` : `Follow ${postPersona.emoji}`}</button>` : ''}
                        </div>
                        <div class="flex items-center space-x-2">
                            <span class="text-[11px] px-2 py-0.5 rounded-full border bg-[#2563eb]/10 to-[#3b82f6]/10 text-[#60a5fa] border-[#3b82f6]/20 flex items-center gap-1" title="${postPersona.label}">${postPersona.emoji} ${postPersona.label}</span>
                            ${post.pinned ? `<span class="text-[11px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1" title="Pinned"><i class="fa-solid fa-thumbtack text-[11px]"></i></span>` : ''}
                            ${post.username === currentUser ? `<button onclick="togglePinPost('${post.id}')" class="text-slate-400 hover:text-amber-400 text-xs transition" title="${post.pinned ? 'Unpin' : 'Pin to profile'}"><i class="fa-solid fa-thumbtack ${post.pinned ? 'text-amber-400' : ''}"></i></button>` : ''}
                            ${post.username === currentUser ? `<button onclick="deletePost('${post.id}')" class="text-slate-400 hover:text-red-400 text-xs transition" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ''}
                        </div>
                    </div>
                    <p class="text-xs text-slate-300 whitespace-pre-wrap break-words">${linkifyHashtags(post.content)}</p>
                    ${buildPostMediaHtml(post, `carousel-feed-${post.id}`)}
                    
                    <div class="flex items-center space-x-4 pt-1.5 border-t border-slate-800/80 text-[11px] text-slate-400">
                        <button onclick="toggleLike('${post.id}')" class="hover:text-[#60a5fa] transition flex items-center gap-1">
                            <i class="fa-solid fa-heart ${hasLiked ? 'text-[#60a5fa]' : 'text-slate-400'}"></i> <span>${postLikes.length}</span>
                        </button>
                        <button onclick="openCommentModal('${post.id}')" class="hover:text-[#38bdf8] transition flex items-center gap-1">
                            <i class="fa-solid fa-comment text-[#38bdf8]"></i> <span>${postComments.length}</span>
                        </button>
                        <button onclick="openSharePostModal('${post.id}')" class="hover:text-[#2dd4bf] transition flex items-center gap-1" title="Share">
                            <i class="fa-solid fa-share-nodes text-[#2dd4bf]"></i>
                        </button>
                        <button onclick="toggleSavePost('${post.id}')" class="hover:text-amber-400 transition flex items-center gap-1" title="Save"><i class="fa-solid fa-bookmark ${globalSavedPostsCache.some(s => s.post_id === post.id && s.username === currentUser) ? 'text-amber-400' : 'text-slate-400'}"></i></button>
                        ${post.username === currentUser ? `<button onclick="openPostAnalyticsModal('${post.id}')" class="hover:text-emerald-400 transition flex items-center gap-1 ml-auto" title="Post Analytics"><i class="fa-solid fa-chart-simple text-emerald-400"></i> <span>${globalPostViewsCache.filter(v => v.post_id === post.id).length}</span></button>` : ''}
                    </div>
                `;
                feedStream.appendChild(card);

                // Log an impression view (post analytics) the first time this post scrolls into view this session
                if (post.username !== currentUser && !trackedPostViewIds.has(post.id)) {
                    const io = new IntersectionObserver((entries) => {
                        entries.forEach(entry => {
                            if (entry.isIntersecting) { logPostView(post.id); io.disconnect(); }
                        });
                    }, { threshold: 0.5 });
                    io.observe(card);
                }
            });

            // PERF: the feed only holds the newest FEED_POST_WINDOW posts; this loads 60 more.
            if (globalPostsCache.length >= FEED_POST_WINDOW) {
                const more = document.createElement('button');
                more.className = 'w-full py-2.5 text-xs font-bold text-slate-300 glass-panel rounded-2xl hover:text-[#60a5fa] transition';
                more.textContent = 'Aur posts dekho';
                more.onclick = () => { more.disabled = true; more.textContent = 'Loading...'; loadMoreFeedPosts(); };
                feedStream.appendChild(more);
            }
        }

        function renderReels() {
            const container = document.getElementById('reelsStreamContainer');
            const reels = globalPostsCache.filter(p => (p.platform === 'Reel' || (p.image_url && p.image_url.match(/\.(mp4|mov|webm)$/i))) && !isBlockedWith(p.username) && !isPrivateAndNotFollowing(p.username));

            if (reels.length === 0) {
                container.innerHTML = `<div class="text-center text-xs text-slate-400 py-20">No reels found. Click the top-right '+' button to upload one!</div>`;
                return;
            }

            container.innerHTML = reels.map(reel => {
                const postLikes = globalLikesCache.filter(l => l.post_id === reel.id);
                const hasLiked = postLikes.some(l => l.username === currentUser);
                const postComments = globalCommentsCache.filter(c => c.post_id === reel.id);
                const avatar = globalProfilesCache[reel.username];

                return `
                    <div class="reel-item w-full h-full flex flex-col justify-between bg-black relative">
                        <video src="${reel.image_url}" loop ${reelSoundMuted ? 'muted' : ''} playsinline onclick="toggleReelSound(this)" class="reel-video absolute inset-0 w-full h-full object-cover"></video>
                        <div class="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/80 pointer-events-none"></div>

                        <div class="relative p-4 flex justify-between items-center z-10">
                            <div class="flex items-center space-x-2.5 cursor-pointer" onclick="handleUserClick('${reel.username}')">
                                <div class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden shadow">${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : reel.username.charAt(0)}</div>
                                <span class="text-xs font-bold text-white">${reel.username}</span>
                            </div>
                            <button onclick="event.stopPropagation(); toggleReelSound(this.closest('.reel-item').querySelector('.reel-video'))" class="reel-sound-btn w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-white text-xs shrink-0" title="${reelSoundMuted ? 'Unmute' : 'Mute'}">
                                <i class="fa-solid ${reelSoundMuted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>
                            </button>
                        </div>

                        <div class="relative p-4 z-10 flex justify-between items-end pb-12">
                            <div class="space-y-1 pr-4 max-w-[260px]">
                                <p class="text-xs font-bold text-white">@${reel.username}</p>
                                <p class="text-xs text-slate-200 break-words">${linkifyHashtags(reel.content)}</p>
                                ${reel.music_title ? `<p class="text-[11px] text-white/90 flex items-center gap-1"><i class="fa-solid fa-music"></i> ${reel.music_title}</p>` : ''}
                            </div>
                            <div class="flex flex-col space-y-4 items-center text-white text-xs">
                                <button onclick="toggleLike('${reel.id}')" class="flex flex-col items-center"><i class="fa-solid fa-heart text-xl ${hasLiked ? 'text-[#60a5fa]' : 'text-white'}"></i><span class="text-[11px] font-bold">${postLikes.length}</span></button>
                                <button onclick="openCommentModal('${reel.id}')" class="flex flex-col items-center"><i class="fa-solid fa-comment text-xl text-[#38bdf8]"></i><span class="text-[11px] font-bold">${postComments.length}</span></button>
                                <button onclick="event.stopPropagation(); openSharePostModal('${reel.id}')" class="flex flex-col items-center"><i class="fa-solid fa-share-nodes text-xl text-white"></i><span class="text-[11px] font-bold">Share</span></button>
                                <button onclick="event.stopPropagation(); toggleSavePost('${reel.id}')" class="flex flex-col items-center"><i class="fa-solid fa-bookmark text-xl ${globalSavedPostsCache.some(s => s.post_id === reel.id && s.username === currentUser) ? 'text-amber-400' : 'text-white'}"></i><span class="text-[11px] font-bold">Save</span></button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // FEATURE: REELS ONE-AT-A-TIME PLAYBACK — like Instagram, only the reel actually
            // in view should ever be playing/making sound. Previously every reel had
            // `autoplay`, so scrolling to reel #2 didn't stop reel #1 — both kept playing
            // (and both kept making sound) in the background. An IntersectionObserver now
            // plays whichever reel is mostly on-screen and pauses every other one.
            setupReelsScrollObserver();
        }

        let reelsIntersectionObserver = null;

        function setupReelsScrollObserver() {
            const container = document.getElementById('reelsStreamContainer');
            if (!container) return;
            if (reelsIntersectionObserver) reelsIntersectionObserver.disconnect();

            reelsIntersectionObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const video = entry.target.querySelector('.reel-video');
                    if (!video) return;
                    if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
                        if (video.paused) video.play().catch(() => {}); // autoplay can be blocked before any user interaction — harmless if so
                    } else if (!video.paused || video.currentTime > 0) {
                        video.pause();
                        video.currentTime = 0; // so scrolling back to it later starts fresh, same as opening a reel on Instagram
                    }
                });
            }, { root: container, threshold: [0, 0.6, 1] });

            container.querySelectorAll('.reel-item').forEach(item => reelsIntersectionObserver.observe(item));
        }

        // FEATURE: stop ALL reel sound the moment you leave the Reels section (switch tabs),
        // instead of letting whichever reel was in view keep quietly playing in the background.
        function pauseAllReels() {
            document.querySelectorAll('#reelsStreamContainer .reel-video').forEach(v => v.pause());
        }

        // FEATURE: REEL SOUND TOGGLE — tapping a reel (or its speaker icon) unmutes/mutes it,
        // and that choice is remembered (localStorage) and applied to every other reel too,
        // so scrolling to the next reel doesn't silently revert back to muted.
        function toggleReelSound(videoEl) {
            if (!videoEl) return;
            applyReelSoundState(!videoEl.muted);
        }

        // Applies a muted/unmuted state to every currently-rendered reel video + updates all
        // speaker icons, and persists the preference so newly-rendered reels pick it up too.
        function applyReelSoundState(muted) {
            reelSoundMuted = muted;
            localStorage.setItem('nexus_reel_muted', muted ? '1' : '0');
            document.querySelectorAll('#reelsStreamContainer .reel-video').forEach(v => { v.muted = muted; });
            document.querySelectorAll('#reelsStreamContainer .reel-sound-btn').forEach(btn => {
                btn.title = muted ? 'Unmute' : 'Mute';
                btn.innerHTML = `<i class="fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
            });
        }

        // =====================================================================================
        // FEATURE: MUSIC/SOUND LIBRARY — a small curated list of demo background tracks a user
        // can attach to a reel. Stored as `music_title`/`music_url` on the `posts` row if those
        // columns exist; degrades gracefully (reel still uploads, just without music tagging)
        // if they don't — same pattern as the other optional columns in this app.
        // =====================================================================================
        const REEL_MUSIC_LIBRARY = [
            { title: 'Chill Vibes', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
            { title: 'Upbeat Pop', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
            { title: 'Late Night Lo-fi', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
            { title: 'Energetic Beat', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
            { title: 'Dreamy Ambient', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3' },
        ];
        let selectedReelMusic = null; // { title, url } or null

        function renderReelMusicLibrary() {
            const wrap = document.getElementById('reelMusicLibraryContainer');
            if (!wrap) return;
            wrap.innerHTML = REEL_MUSIC_LIBRARY.map((track, i) => `
                <button type="button" onclick="selectReelMusic(${i})" class="flex items-center justify-between text-left px-2.5 py-1.5 rounded-xl border text-[11px] font-semibold transition ${selectedReelMusic && selectedReelMusic.title === track.title ? 'bg-[#2563eb] text-white border-transparent' : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-[#14b8a6]/40'}">
                    <span><i class="fa-solid fa-music mr-1.5"></i>${track.title}</span>
                    <i class="fa-solid fa-play"></i>
                </button>
            `).join('');
        }
        window.renderReelMusicLibrary = renderReelMusicLibrary;

        function selectReelMusic(i) {
            const track = REEL_MUSIC_LIBRARY[i];
            if (!track) return;
            selectedReelMusic = track;
            const player = document.getElementById('reelMusicPreviewPlayer');
            player.src = track.url;
            player.classList.remove('hidden');
            player.play().catch(() => {});
            document.getElementById('reelMusicClearBtn').classList.remove('hidden');
            renderReelMusicLibrary();
        }
        window.selectReelMusic = selectReelMusic;

        function clearReelMusicSelection() {
            selectedReelMusic = null;
            const player = document.getElementById('reelMusicPreviewPlayer');
            player.pause();
            player.src = '';
            player.classList.add('hidden');
            document.getElementById('reelMusicClearBtn').classList.add('hidden');
            renderReelMusicLibrary();
        }
        window.clearReelMusicSelection = clearReelMusicSelection;

        function openReelUploadModal() {
            document.getElementById('reelUploadModal').classList.remove('hidden');
            renderReelMusicLibrary();
        }

        function closeReelUploadModal() {
            document.getElementById('reelUploadModal').classList.add('hidden');
            const preview = document.getElementById('reelPreviewVideo');
            if (preview.src) URL.revokeObjectURL(preview.src);
            preview.src = '';
            preview.classList.add('hidden');
            document.getElementById('reelUploadForm').reset();
            clearReelMusicSelection();
        }

        // Shows a quick preview of the selected video so the user can review it before publishing
        function previewReelVideo(input) {
            const preview = document.getElementById('reelPreviewVideo');
            if (input.files && input.files[0]) {
                if (preview.src) URL.revokeObjectURL(preview.src);
                preview.src = URL.createObjectURL(input.files[0]);
                preview.classList.remove('hidden');
            } else {
                preview.classList.add('hidden');
            }
        }

        function updateReelUploadProgress(percent, label) {
            const badge = document.getElementById('reelUploadProgressBadge');
            badge.classList.remove('hidden');
            document.getElementById('reelUploadProgressBar').style.width = percent + '%';
            document.getElementById('reelUploadProgressPercentText').innerText = percent + '%';
            if (label) document.getElementById('reelUploadProgressLabel').innerText = label;
        }

        async function submitReelUpload(e) {
            e.preventDefault();
            const fileInput = document.getElementById('reelVideoFileInput');
            const caption = document.getElementById('reelCaptionInput').value.trim();
            if(!fileInput.files[0] || !caption) return;
            if (guardOfflineAction('Reel upload')) return; // FEATURE: OFFLINE MODE

            const file = fileInput.files[0];
            const musicForUpload = selectedReelMusic; // captured before the modal/state gets reset below

            // Close the modal right away — upload keeps running in the background,
            // tracked by the floating progress badge (visible from anywhere in the app).
            closeReelUploadModal();
            updateReelUploadProgress(0, 'Starting upload...');

            const fileName = `reel_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;

            try {
                // FIX: previously this sent `Authorization: Bearer <anon key>` here, which is
                // NOT the logged-in user's session — it made every reel upload look
                // "anonymous" to Supabase Storage, so it got silently rejected once RLS
                // required a real authenticated user (see ensureAuthSession). Fetching the
                // real session's access_token and sending THAT fixes it, while still using
                // raw XHR (instead of supabaseClient.storage.upload) so we can track % progress.
                // STORAGE: try the user's own Google Drive first (with real progress); only if
                // that isn't connected / fails do we use the Supabase XHR path below.
                let videoUrl = null;
                if (await driveAvailable()) {
                    try {
                        videoUrl = await DriveStore.upload(fileName, file, {
                            contentType: file.type,
                            onProgress: (pct) => updateReelUploadProgress(pct, `Uploading to your Drive... ${pct}%`)
                        });
                    } catch (driveErr) {
                        console.warn('[Drive] reel upload failed, falling back to Supabase:', driveErr);
                        videoUrl = null;
                    }
                }
                if (!videoUrl) {
                const { data: sessionData } = await supabaseClient.auth.getSession();
                const accessToken = sessionData && sessionData.session ? sessionData.session.access_token : SUPABASE_ANON_KEY;

                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/media/${fileName}`, true);
                    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
                    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
                    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
                    xhr.upload.onprogress = (evt) => {
                        if (evt.lengthComputable) {
                            const percent = Math.round((evt.loaded / evt.total) * 100);
                            updateReelUploadProgress(percent, `Uploading... ${percent}%`);
                        }
                    };
                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) resolve();
                        else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
                    };
                    xhr.onerror = () => reject(new Error('Network error during upload'));
                    xhr.send(file);
                });

                updateReelUploadProgress(100, 'Finishing up...');

                const { data: publicUrlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
                videoUrl = publicUrlData.publicUrl;
                }

                const basePostRow = { username: currentUser, platform: 'Reel', content: caption, image_url: videoUrl, likes_count: 0 };
                // FEATURE: MUSIC/SOUND LIBRARY — try with the music columns first; if that schema
                // doesn't exist yet on this install, fall back to the plain insert so the reel
                // still publishes (same graceful-degrade pattern used elsewhere in this file).
                let insertError = null;
                if (musicForUpload) {
                    const withMusic = await supabaseClient.from('posts').insert({ ...basePostRow, music_title: musicForUpload.title, music_url: musicForUpload.url });
                    insertError = withMusic.error;
                    if (insertError) {
                        const fallback = await supabaseClient.from('posts').insert(basePostRow);
                        insertError = fallback.error;
                    }
                } else {
                    const plain = await supabaseClient.from('posts').insert(basePostRow);
                    insertError = plain.error;
                }
                if (insertError) throw insertError;

                await fetchAllData();

                updateReelUploadProgress(100, 'Reel published!');
                setTimeout(() => document.getElementById('reelUploadProgressBadge').classList.add('hidden'), 2000);
            } catch (err) {
                console.error("Reel upload error:", err);
                const reason = (err && err.message) ? err.message : 'Upload failed';
                updateReelUploadProgress(0, reason.length > 60 ? reason.slice(0, 60) + '...' : reason);
                document.getElementById('reelUploadProgressBar').classList.add('bg-red-500');
                setTimeout(() => {
                    document.getElementById('reelUploadProgressBadge').classList.add('hidden');
                    document.getElementById('reelUploadProgressBar').classList.remove('bg-red-500');
                }, 6000);
            }
        }

        function openCommentModal(postId) {
            activeModalPostId = postId;
            renderCommentModal(postId);
            document.getElementById('commentModal').classList.remove('hidden');
        }

        function closeCommentModal() {
            activeModalPostId = null;
            cancelCommentReply();
            document.getElementById('commentModal').classList.add('hidden');
        }

        function renderCommentModal(postId) {
            const listContainer = document.getElementById('commentModalList');
            // BUGFIX: postId arrives here as a STRING (from onclick="openCommentModal('${post.id}')"),
            // but Supabase's post_id in the comments cache is a number — same id-type mismatch as
            // Post Analytics/openPostDetailModal. Without String() coercion this always filtered to
            // an empty list, so the modal said "No comments yet" even when the feed card's own count
            // (which compares post.id directly, not a stringified copy) correctly showed 2+.
            const allPostComments = globalCommentsCache.filter(c => String(c.post_id) === String(postId));
            const topLevel = allPostComments.filter(c => !c.parent_comment_id);

            if (allPostComments.length === 0) {
                listContainer.innerHTML = `<p class="text-center text-xs text-slate-400 py-6">No comments yet. Be the first!</p>`;
                return;
            }

            // Renders one comment plus (recursively) its nested replies
            function renderCommentNode(c, depth) {
                const av = globalProfilesCache[c.username];
                const likesForComment = globalCommentLikesCache.filter(l => l.comment_id === c.id);
                const iLikedComment = likesForComment.some(l => l.username === currentUser);
                const replies = allPostComments.filter(rc => rc.parent_comment_id === c.id);
                const marginClass = depth > 0 ? `ml-${Math.min(depth * 5, 10)} border-l-2 border-slate-800 pl-2` : '';
                let html = `
                    <div class="bg-slate-900 border border-slate-800 p-2.5 rounded-xl text-xs ${marginClass}">
                        <div class="flex justify-between items-start">
                            <div class="flex items-center space-x-2 min-w-0">
                                <div class="w-6 h-6 rounded-full bg-[#334155] flex items-center justify-center text-[11px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : c.username.charAt(0)}</div>
                                <div class="min-w-0"><span class="font-bold text-[#60a5fa] cursor-pointer" onclick="handleUserClick('${c.username}')">${c.username}</span> <p class="text-slate-300 break-words">${c.text}</p></div>
                            </div>
                            ${c.username === currentUser ? `<button onclick="deleteComment('${c.id}')" class="text-slate-400 hover:text-red-400 text-xs ml-2 shrink-0"><i class="fa-solid fa-xmark"></i></button>` : ''}
                        </div>
                        <div class="flex items-center gap-3 mt-1.5 pl-8 text-[11px] text-slate-400">
                            <button onclick="toggleCommentLike('${c.id}')" class="flex items-center gap-1 hover:text-[#60a5fa] transition ${iLikedComment ? 'text-[#60a5fa] font-bold' : ''}"><i class="fa-solid fa-heart"></i> ${likesForComment.length > 0 ? likesForComment.length : ''} Like</button>
                            <button onclick="setCommentReplyTarget('${c.id}', '${c.username}')" class="flex items-center gap-1 hover:text-[#38bdf8] transition"><i class="fa-solid fa-reply"></i> Reply</button>
                        </div>
                    </div>
                `;
                replies.forEach(r => { html += renderCommentNode(r, depth + 1); });
                return html;
            }

            listContainer.innerHTML = topLevel.map(c => renderCommentNode(c, 0)).join('');
        }

        // Sets which comment is being replied to (for nested/threaded replies) and shows a preview bar
        function setCommentReplyTarget(commentId, username) {
            replyingToCommentId = commentId;
            const bar = document.getElementById('commentReplyPreviewBar');
            if (bar) {
                bar.classList.remove('hidden');
                bar.classList.add('flex');
                document.getElementById('commentReplyPreviewText').innerText = `Replying to ${username}`;
            }
            document.getElementById('commentModalInput').placeholder = `Reply to ${username}...`;
            document.getElementById('commentModalInput').focus();
        }

        function cancelCommentReply() {
            replyingToCommentId = null;
            const bar = document.getElementById('commentReplyPreviewBar');
            if (bar) { bar.classList.add('hidden'); bar.classList.remove('flex'); }
            document.getElementById('commentModalInput').placeholder = 'Add a comment...';
        }

        // Toggles a like on a comment (comment_likes table)
        async function toggleCommentLike(commentId) {
            try {
                const existing = globalCommentLikesCache.find(l => l.comment_id === commentId && l.username === currentUser);
                if (existing) {
                    await supabaseClient.from('comment_likes').delete().eq('id', existing.id);
                } else {
                    await supabaseClient.from('comment_likes').insert({ comment_id: commentId, username: currentUser });
                }
                await fetchAllData();
                if (activeModalPostId) renderCommentModal(activeModalPostId);
            } catch (err) {
                console.error("Comment like error (did you run the comment_likes migration?):", err);
            }
        }

        async function submitModalComment(e) {
            e.preventDefault();
            if (!activeModalPostId) return;
            const input = document.getElementById('commentModalInput');
            const text = input.value.trim();
            if (!text) return;

            const payload = {
                post_id: activeModalPostId,
                username: currentUser,
                text
            };
            if (replyingToCommentId) payload.parent_comment_id = replyingToCommentId;

            await supabaseClient.from('comments').insert(payload);
            input.value = '';
            cancelCommentReply();
            await fetchAllData();
            renderCommentModal(activeModalPostId);
        }

        function openPostDetailModal(postId) {
            // FIX: post/reel tap not opening fullscreen — ANYWHERE (feed, explore, profile,
            // reels grid, shared posts). Every onclick="openPostDetailModal('${post.id}')" call
            // site passes the id as a STRING (quoted inside the onclick attribute), but
            // Supabase returns numeric primary keys as a JS number. `p.id === postId` was
            // comparing e.g. 42 === "42", which is always false in JS — so `post` was always
            // undefined and the function silently did nothing (`if (!post) return;`). Comparing
            // as strings on both sides fixes it for every caller, numeric or string IDs alike.
            const post = globalPostsCache.find(p => String(p.id) === String(postId));
            if (!post) return;
            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — final safety-net gate, in case something
            // (a stale link, a cached list) tries to open a private post the viewer can't see.
            if (isPrivateAndNotFollowing(post.username)) {
                showAlertBanner('🔒 Ye account private hai — dekhne ke liye pehle follow karo.');
                return;
            }
            logPostView(postId);

            document.getElementById('detailPostUser').innerText = `${post.username}'s Post`;
            const container = document.getElementById('detailPostContentContainer');
            const postLikes = globalLikesCache.filter(l => l.post_id === post.id);
            const hasLiked = postLikes.some(l => l.username === currentUser);
            const postComments = globalCommentsCache.filter(c => c.post_id === post.id);
            const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
            const posterAvatar = globalProfilesCache[post.username];
            const isOwnPost = post.username === currentUser;
            const ownerControlsHtml = isOwnPost ? `
                <button onclick="togglePinPost('${post.id}'); closePostDetailModal();" class="hover:text-amber-400 transition flex items-center gap-1 ml-auto" title="${post.pinned ? 'Unpin' : 'Pin to profile'}">
                    <i class="fa-solid fa-thumbtack ${post.pinned ? 'text-amber-400' : ''}"></i>
                </button>
                <button onclick="deletePost('${post.id}'); closePostDetailModal();" class="hover:text-red-400 transition flex items-center gap-1" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            ` : '';
            const detailUrls = Array.isArray(post.media_urls) && post.media_urls.length > 0 ? post.media_urls : (post.image_url ? [post.image_url] : []);
            const detailCarouselId = `carousel-detail-${post.id}`;
            const detailMediaHtml = detailUrls.length > 1 ? `
                <div class="relative w-full">
                    <div id="${detailCarouselId}" onscroll="updateCarouselDots('${detailCarouselId}')" class="flex overflow-x-auto no-scrollbar w-full max-h-[70vh]" style="scroll-snap-type: x mandatory;">
                        ${detailUrls.map(u => `<img src="${u}" class="w-full max-h-[70vh] object-contain snap-center shrink-0" style="scroll-snap-align: center;">`).join('')}
                    </div>
                    <span id="${detailCarouselId}-counter" class="absolute top-2 right-2 bg-black/60 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">1/${detailUrls.length}</span>
                    <div id="${detailCarouselId}-dots" class="absolute bottom-2 inset-x-0 flex justify-center gap-1">
                        ${detailUrls.map((_, i) => `<span class="w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-white' : 'bg-white/40'}" data-dot-index="${i}"></span>`).join('')}
                    </div>
                </div>
            ` : (isVideo ? `<video src="${post.image_url}" controls autoplay loop muted playsinline class="w-full max-h-[70vh] object-contain"></video>` : (post.image_url ? `<img src="${post.image_url}" class="w-full max-h-[70vh] object-contain" />` : ''));

            container.innerHTML = `
                <div class="w-full h-full flex flex-col justify-center items-center relative">
                    ${detailMediaHtml}
                    <div class="w-full p-3 bg-slate-900 border-t border-slate-800 space-y-2 mt-auto">
                        <div class="flex items-center space-x-2">
                            <div class="w-6 h-6 rounded-full bg-[#334155] flex items-center justify-center text-[11px] text-white overflow-hidden">${posterAvatar ? `<img src="${posterAvatar}" class="w-full h-full object-cover">` : post.username.charAt(0)}</div>
                            <span class="text-xs font-bold text-slate-200">${post.username}</span>
                        </div>
                        <p class="text-xs text-slate-300 break-words">${post.content}</p>
                        <div class="flex items-center space-x-4 pt-1 border-t border-slate-800 text-slate-400 text-xs">
                            <button onclick="toggleLike('${post.id}')" class="hover:text-[#60a5fa] transition flex items-center gap-1"><i class="fa-solid fa-heart ${hasLiked ? 'text-[#60a5fa]' : 'text-slate-400'}"></i> <span>${postLikes.length}</span></button>
                            <button onclick="openCommentModal('${post.id}')" class="hover:text-[#38bdf8] transition flex items-center gap-1"><i class="fa-solid fa-comment text-[#38bdf8]"></i> <span>${postComments.length}</span></button>
                            <button onclick="openSharePostModal('${post.id}')" class="hover:text-[#2dd4bf] transition flex items-center gap-1" title="Share"><i class="fa-solid fa-share-nodes text-[#2dd4bf]"></i></button>
                            <button onclick="toggleSavePost('${post.id}')" class="hover:text-amber-400 transition flex items-center gap-1" title="Save"><i class="fa-solid fa-bookmark ${globalSavedPostsCache.some(s => s.post_id === post.id && s.username === currentUser) ? 'text-amber-400' : 'text-slate-400'}"></i></button>
                            ${ownerControlsHtml}
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('postDetailModal').classList.remove('hidden');
        }

        function closePostDetailModal() {
            document.getElementById('postDetailModal').classList.add('hidden');
        }

        // FEATURE: FULLSCREEN CHAT MEDIA — tapping a photo/video inside a DM or group chat
        // bubble should open it fullscreen, same as Instagram. If the message is a shared
        // post (has shared_post_id), open the real post (with likes/comments) via
        // openPostDetailModal; otherwise it's just a raw sent photo/video, so open it in a
        // simple fullscreen viewer.
        function openChatMediaTap(mediaUrl, isVideo, sharedPostId) {
            if (sharedPostId) {
                const post = globalPostsCache.find(p => String(p.id) === String(sharedPostId));
                if (post) { openPostDetailModal(post.id); return; }
                // shared post no longer exists / not loaded — fall back to just showing the image
            }
            openChatMediaViewer(mediaUrl, isVideo);
        }

        function openChatMediaViewer(mediaUrl, isVideo) {
            const content = document.getElementById('chatMediaViewerContent');
            content.innerHTML = isVideo
                ? `<video src="${mediaUrl}" controls autoplay playsinline class="max-w-full max-h-full object-contain"></video>`
                : `<img src="${mediaUrl}" class="max-w-full max-h-full object-contain">`;
            document.getElementById('chatMediaViewerModal').classList.remove('hidden');
            document.getElementById('chatMediaViewerModal').classList.add('flex');
        }

        function closeChatMediaViewer() {
            document.getElementById('chatMediaViewerModal').classList.add('hidden');
            document.getElementById('chatMediaViewerModal').classList.remove('flex');
            document.getElementById('chatMediaViewerContent').innerHTML = '';
        }
        window.openChatMediaTap = openChatMediaTap;
        window.closeChatMediaViewer = closeChatMediaViewer;

        async function toggleLike(postId) {
            // BUGFIX: this used to wait for a full network round trip (select, then
            // insert/delete, then a full fetchAllData() re-fetch of every table) before
            // the heart icon or count changed at all — felt slow/unresponsive compared
            // to Instagram. Now we flip the UI instantly using the local cache, then sync
            // to the DB in the background and roll back only if it actually fails.
            const alreadyLiked = globalLikesCache.some(l => l.post_id === postId && l.username === currentUser);

            // Optimistic local update
            if (alreadyLiked) {
                globalLikesCache = globalLikesCache.filter(l => !(l.post_id === postId && l.username === currentUser));
            } else {
                globalLikesCache.push({ post_id: postId, username: currentUser, created_at: new Date().toISOString() });
            }
            renderFeed();
            if (activeModalPostId) renderCommentModal(activeModalPostId);
            if (viewingProfileUsername) renderProfileGrid();


            // Sync to DB in the background
            try {
                if (alreadyLiked) {
                    const { error } = await supabaseClient.from('post_likes').delete().eq('post_id', postId).eq('username', currentUser);
                    if (error) throw error;
                } else {
                    const { error } = await supabaseClient.from('post_likes').insert({ post_id: postId, username: currentUser });
                    if (error) throw error;
                }
            } catch (err) {
                console.error('toggleLike failed:', err);
                // A duplicate-key error means the like actually already exists in the DB
                // (our local cache was just out of sync) — so the correct outcome is
                // "liked", not a rollback to unliked. Any other error rolls back normally.
                const isDuplicate = err && (err.code === '23505' || (err.message || '').includes('duplicate key'));
                if (isDuplicate && !alreadyLiked) {
                    // Already liked server-side — keep the optimistic "liked" state, just resync quietly
                    fetchAllData();
                    return;
                }
                showAlertBanner('Like save nahi hui: ' + (err.message || 'network error'), 'error');
                // Roll back the optimistic change
                if (alreadyLiked) {
                    globalLikesCache.push({ post_id: postId, username: currentUser, created_at: new Date().toISOString() });
                } else {
                    globalLikesCache = globalLikesCache.filter(l => !(l.post_id === postId && l.username === currentUser));
                }
                renderFeed();
                if (activeModalPostId) renderCommentModal(activeModalPostId);
                if (viewingProfileUsername) renderProfileGrid();
                return;
            }

            // Quiet background refresh to stay in sync with anyone else's likes — doesn't block the UI
            fetchAllData();
        }

        // =====================================================================================
        // FEATURE: SAVE POST/REEL (bookmark) — same optimistic-update pattern as toggleLike.
        // Saved items only ever show up in the current user's own "My Activity → Save" page.
        // =====================================================================================
        async function toggleSavePost(postId) {
            const alreadySaved = globalSavedPostsCache.some(s => s.post_id === postId && s.username === currentUser);

            // Optimistic local update
            if (alreadySaved) {
                globalSavedPostsCache = globalSavedPostsCache.filter(s => !(s.post_id === postId && s.username === currentUser));
            } else {
                globalSavedPostsCache.push({ post_id: postId, username: currentUser, created_at: new Date().toISOString() });
            }
            renderFeed();
            renderReels();
            if (activeModalPostId) renderCommentModal(activeModalPostId);
            if (!document.getElementById('postDetailModal').classList.contains('hidden')) openPostDetailModal(postId);
            showAlertBanner(alreadySaved ? 'Post unsaved.' : 'Post saved.', 'success');

            try {
                if (alreadySaved) {
                    const { error } = await supabaseClient.from('saved_posts').delete().eq('post_id', postId).eq('username', currentUser);
                    if (error) throw error;
                } else {
                    const { error } = await supabaseClient.from('saved_posts').insert({ post_id: postId, username: currentUser });
                    if (error) throw error;
                }
            } catch (err) {
                console.error('toggleSavePost failed (saved_posts table setup baaki hai?):', err);
                const isDuplicate = err && (err.code === '23505' || (err.message || '').includes('duplicate key'));
                if (isDuplicate && !alreadySaved) { fetchAllData(); return; }
                showAlertBanner('Save nahi ho paaya: ' + (err.message || 'network error'), 'error');
                // Roll back the optimistic change
                if (alreadySaved) {
                    globalSavedPostsCache.push({ post_id: postId, username: currentUser, created_at: new Date().toISOString() });
                } else {
                    globalSavedPostsCache = globalSavedPostsCache.filter(s => !(s.post_id === postId && s.username === currentUser));
                }
                renderFeed();
                renderReels();
            }
        }

        async function deleteComment(commentId) {
            await supabaseClient.from('comments').delete().eq('id', commentId);
            await fetchAllData();
            if(activeModalPostId) renderCommentModal(activeModalPostId);
        }

        async function deletePost(id) {
            if(confirm("Delete this post?")) {
                await supabaseClient.from('posts').delete().eq('id', id);
                await fetchAllData();
            }
        }

        // FEATURE: PINNED POST — pins one post to the top of a profile
        async function togglePinPost(id) {
            const post = globalPostsCache.find(p => String(p.id) === String(id));
            if (!post) return;
            const newValue = !post.pinned;
            try {
                // Only one pinned post per user — unpin any previous one first.
                if (newValue) {
                    await supabaseClient.from('posts').update({ pinned: false }).eq('username', currentUser).eq('pinned', true);
                }
                const { error } = await supabaseClient.from('posts').update({ pinned: newValue }).eq('id', id);
                if (error) throw error;
                await fetchAllData();
                if (viewingProfileUsername === currentUser) renderProfileGrid();
            } catch (e) {
                console.warn('Nexus: posts.pinned column not set up yet.', e);
                showAlertBanner('Pinned Post feature ke liye ek chhoti SQL setup baaki hai — neeche diye gaye setup notes dekho.', 'warning');
            }
        }

        // =====================================================================================
        // FEATURE: HASHTAGS + EXPLORE
        // =====================================================================================
        function extractHashtags(content) {
            if (!content) return [];
            const matches = content.match(/#[a-zA-Z0-9_]+/g);
            return matches ? matches.map(m => m.toLowerCase()) : [];
        }

        // Wraps #hashtags in post/reel content with clickable accent-colored spans that jump to Explore
        function linkifyHashtags(content) {
            if (!content) return '';
            const escaped = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return escaped.replace(/#[a-zA-Z0-9_]+/g, (tag) => {
                const clean = tag.toLowerCase().replace(/[^a-z0-9_#]/g, '');
                return `<span onclick="event.stopPropagation(); jumpToExploreHashtag('${clean}')" class="text-[#60a5fa] font-bold cursor-pointer hover:underline">${tag}</span>`;
            });
        }

        function jumpToExploreHashtag(tag) {
            switchTab('explore');
            filterExploreByHashtag(tag);
        }

        let activeExploreFilterTag = null;

        function renderExplore() {
            // Trending hashtags: count occurrences across all posts/reels (private accounts you
            // don't follow are excluded, so their tags can't leak into public trending)
            const tagCounts = {};
            globalPostsCache.filter(p => !isBlockedWith(p.username) && !isPrivateAndNotFollowing(p.username)).forEach(p => {
                extractHashtags(p.content).forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
            });
            const sortedTags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]).slice(0, 15);

            const tagsContainer = document.getElementById('trendingHashtagsContainer');
            if (tagsContainer) {
                if (sortedTags.length === 0) {
                    tagsContainer.innerHTML = `<p class="text-[11px] text-slate-400">No hashtags yet. Add #tags to your posts!</p>`;
                } else {
                    tagsContainer.innerHTML = sortedTags.map(tag => `
                        <span onclick="filterExploreByHashtag('${tag}')" class="cursor-pointer text-[11px] font-bold px-2.5 py-1 rounded-full border ${activeExploreFilterTag === tag ? 'bg-[#2563eb] border-[#3b82f6] text-white' : 'bg-slate-900 border-slate-800 text-[#60a5fa] hover:border-[#3b82f6]'}">${tag} <span class="text-slate-400 font-normal">${tagCounts[tag]}</span></span>
                    `).join('');
                }
            }

            renderExploreGrid();
        }

        function renderExploreGrid() {
            const grid = document.getElementById('exploreGridContainer');
            const heading = document.getElementById('exploreHeading');
            const clearBtn = document.getElementById('clearExploreFilterBtn');
            if (!grid) return;

            let items;
            if (activeExploreFilterTag) {
                items = globalPostsCache.filter(p => extractHashtags(p.content).includes(activeExploreFilterTag) && !isBlockedWith(p.username) && !isPrivateAndNotFollowing(p.username));
                heading.innerText = `Posts tagged ${activeExploreFilterTag}`;
                clearBtn.classList.remove('hidden');
            } else {
                items = globalPostsCache.filter(p => !isBlockedWith(p.username) && !isPrivateAndNotFollowing(p.username)).sort((a, b) => {
                    const aLikes = globalLikesCache.filter(l => l.post_id === a.id).length;
                    const bLikes = globalLikesCache.filter(l => l.post_id === b.id).length;
                    return bLikes - aLikes;
                }).slice(0, 12);
                heading.innerText = 'Top Posts';
                clearBtn.classList.add('hidden');
            }

            if (items.length === 0) {
                grid.innerHTML = `<div class="col-span-2 text-center text-xs text-slate-400 py-8">Nothing to show here yet.</div>`;
                return;
            }

            grid.innerHTML = items.map(post => {
                const likeCount = globalLikesCache.filter(l => l.post_id === post.id).length;
                const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
                return `
                    <div onclick="openPostDetailModal('${post.id}')" class="relative aspect-square rounded-xl overflow-hidden bg-slate-900 border border-slate-800 cursor-pointer group">
                        ${post.image_url
                            ? (isVideo ? `<video src="${post.image_url}" class="w-full h-full object-cover"></video>` : `<img src="${post.image_url}" class="w-full h-full object-cover">`)
                            : `<div class="w-full h-full flex items-center justify-center p-2 text-[11px] text-slate-400 text-center">${post.content.slice(0, 60)}</div>`}
                        <div class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 flex items-center gap-1 text-[11px] text-white font-bold">
                            <i class="fa-solid fa-heart text-[#60a5fa]"></i> ${likeCount} <span class="text-slate-300 font-normal truncate">@${post.username}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function filterExploreByHashtag(tag) {
            activeExploreFilterTag = tag;
            renderExplore();
        }

        function clearExploreFilter() {
            activeExploreFilterTag = null;
            renderExplore();
        }

        // =====================================================================================
        // FEATURE: STORIES (24-hour, Instagram-style)
        // =====================================================================================
        function renderStoriesBar() {
            const container = document.getElementById('storiesBarContainer');
            if (!container) return;

            // Group active (non-expired - already filtered server-side to last 24h) stories by username
            const byUser = {};
            globalStoriesCache.forEach(s => {
                if (!byUser[s.username]) byUser[s.username] = [];
                byUser[s.username].push(s);
            });

            const otherUsernames = Object.keys(byUser).filter(u => u !== currentUser);
            const myAvatar = globalProfilesCache[currentUser];

            let html = `
                <div class="flex flex-col items-center gap-1 shrink-0 cursor-pointer" onclick="${byUser[currentUser] ? `openStoryViewer('${currentUser}')` : 'openStoryUploadModal()'}">
                    <div class="w-14 h-14 rounded-full p-[2px] ${byUser[currentUser] ? 'story-ring-unseen' : 'bg-slate-700'}">
                        <div class="w-full h-full rounded-full border-2 border-darker bg-slate-800 flex items-center justify-center overflow-hidden relative">
                            ${myAvatar ? `<img src="${myAvatar}" class="w-full h-full object-cover">` : `<span class="text-xs font-bold text-white">${currentUser ? currentUser.charAt(0).toUpperCase() : 'U'}</span>`}
                            <button onclick="event.stopPropagation(); openStoryUploadModal()" class="absolute bottom-0 right-0 w-4 h-4 bg-[#2563eb] rounded-full flex items-center justify-center text-white text-[11px] border border-darker"><i class="fa-solid fa-plus"></i></button>
                        </div>
                    </div>
                    <span class="text-[11px] text-slate-400 font-semibold">Your Story</span>
                </div>
            `;

            otherUsernames.forEach(username => {
                const stories = byUser[username];
                const allSeen = stories.every(s => globalStoryViewsCache.some(v => v.story_id === s.id && v.username === currentUser));
                const av = globalProfilesCache[username];
                html += `
                    <div class="flex flex-col items-center gap-1 shrink-0 cursor-pointer" onclick="openStoryViewer('${username}')">
                        <div class="w-14 h-14 rounded-full p-[2px] ${allSeen ? 'story-ring-seen' : 'story-ring-unseen'}">
                            <div class="w-full h-full rounded-full border-2 border-darker bg-slate-800 flex items-center justify-center overflow-hidden">
                                ${av ? `<img src="${av}" class="w-full h-full object-cover">` : `<span class="text-xs font-bold text-white">${username.charAt(0).toUpperCase()}</span>`}
                            </div>
                        </div>
                        <span class="text-[11px] text-slate-400 font-semibold truncate max-w-[56px]">${username}</span>
                    </div>
                `;
            });

            container.innerHTML = html;
        }

        function openStoryUploadModal() {
            document.getElementById('storyUploadModal').classList.remove('hidden');
        }

        function closeStoryUploadModal() {
            document.getElementById('storyUploadModal').classList.add('hidden');
            document.getElementById('storyUploadForm').reset();
            document.getElementById('storyPreviewWrap').classList.add('hidden');
            document.getElementById('storyPreviewImg').classList.add('hidden');
            document.getElementById('storyPreviewVideo').classList.add('hidden');
            selectedStoryFileObject = null;
        }

        function previewStoryMedia(input) {
            if (!input.files || !input.files[0]) return;
            selectedStoryFileObject = input.files[0];
            const wrap = document.getElementById('storyPreviewWrap');
            const img = document.getElementById('storyPreviewImg');
            const vid = document.getElementById('storyPreviewVideo');
            wrap.classList.remove('hidden');
            const url = URL.createObjectURL(selectedStoryFileObject);
            if (selectedStoryFileObject.type.startsWith('video')) {
                vid.src = url; vid.classList.remove('hidden'); img.classList.add('hidden');
            } else {
                img.src = url; img.classList.remove('hidden'); vid.classList.add('hidden');
            }
        }

        async function submitStoryUpload(e) {
            e.preventDefault();
            if (!selectedStoryFileObject) return;
            const statusEl = document.getElementById('storyUploadStatus');
            const btn = document.getElementById('storyUploadBtn');
            statusEl.classList.remove('hidden');
            btn.disabled = true;

            try {
                const fileName = `story_${Date.now()}_${selectedStoryFileObject.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                const upS = await uploadMediaFile(fileName, selectedStoryFileObject);
                if (upS.error) throw upS.error;

                const pubData = { publicUrl: upS.url };
                const mediaType = selectedStoryFileObject.type.startsWith('video') ? 'video' : 'image';

                const { data: insertedRows, error: insertError } = await supabaseClient.from('stories').insert({
                    username: currentUser,
                    media_url: pubData.publicUrl,
                    media_type: mediaType,
                    caption: document.getElementById('storyCaptionInput').value.trim() || null
                }).select();
                if (insertError) throw insertError;

                await fetchAllData();
                closeStoryUploadModal();
            } catch (err) {
                console.error("Story upload error:", err);
                showAlertBanner('Story upload failed: ' + (err.message || 'Unknown error'), 'error');
            } finally {
                statusEl.classList.add('hidden');
                btn.disabled = false;
            }
        }

        function openStoryViewer(username) {
            storyQueue = globalStoriesCache.filter(s => s.username === username).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            if (storyQueue.length === 0) return;
            storyQueueIndex = 0;
            document.getElementById('storyViewerModal').classList.remove('hidden');
            document.getElementById('storyViewerModal').classList.add('flex');
            renderCurrentStory();
        }

        function renderCurrentStory() {
            if (storyQueueIndex < 0) { storyQueueIndex = 0; }
            if (storyQueueIndex >= storyQueue.length) { closeStoryViewer(); return; }

            const story = storyQueue[storyQueueIndex];
            const av = globalProfilesCache[story.username];
            document.getElementById('storyViewerAvatar').innerHTML = av ? `<img src="${av}" class="w-full h-full object-cover">` : story.username.charAt(0).toUpperCase();
            document.getElementById('storyViewerUsername').innerText = story.username;
            document.getElementById('storyViewerTime').innerText = formatMessageTimestamp(new Date(story.created_at));
            document.getElementById('storyCaptionOverlay').innerText = story.caption || '';
            document.getElementById('storyDeleteBtn').classList.toggle('hidden', story.username !== currentUser);

            // FEATURE: STORY REPLY VIA DM — only shown on other people's stories, not your own
            const replyBar = document.getElementById('storyReplyBar');
            const isOwnStory = story.username === currentUser;
            replyBar.classList.toggle('hidden', isOwnStory);
            replyBar.classList.toggle('flex', !isOwnStory);
            document.getElementById('storyReplyInput').value = '';
            document.getElementById('storyCaptionOverlay').classList.toggle('bottom-16', !isOwnStory);
            document.getElementById('storyCaptionOverlay').classList.toggle('bottom-4', isOwnStory);

            const mediaContainer = document.getElementById('storyMediaContainer');
            const revealStyle = ' class="max-w-full max-h-full object-contain"';
            mediaContainer.innerHTML = story.media_type === 'video'
                ? `<video src="${story.media_url}"${revealStyle} autoplay playsinline muted></video>`
                : `<img src="${story.media_url}"${revealStyle}>`;

            // Progress bars: one segment per story in the queue
            const barsContainer = document.getElementById('storyProgressBarsContainer');
            barsContainer.innerHTML = storyQueue.map((s, i) => `
                <div class="flex-1 h-0.5 bg-white/30 rounded-full overflow-hidden">
                    <div class="h-full bg-white ${i < storyQueueIndex ? 'w-full' : (i === storyQueueIndex ? '' : 'w-0')}" id="storyBarFill-${i}" style="${i === storyQueueIndex ? `animation: storyProgress ${STORY_DURATION_MS}ms linear forwards;` : ''}"></div>
                </div>
            `).join('');

            markStorySeen(story.id);

            if (storyProgressTimer) clearTimeout(storyProgressTimer);
            storyProgressTimer = setTimeout(storyNavNext, STORY_DURATION_MS);
        }

        function storyNavNext() {
            storyQueueIndex++;
            renderCurrentStory();
        }

        function storyNavPrev() {
            storyQueueIndex--;
            if (storyQueueIndex < 0) { closeStoryViewer(); return; }
            renderCurrentStory();
        }

        function closeStoryViewer() {
            if (storyProgressTimer) clearTimeout(storyProgressTimer);
            document.getElementById('storyViewerModal').classList.add('hidden');
            document.getElementById('storyViewerModal').classList.remove('flex');
            storyQueue = [];
            storyQueueIndex = 0;
        }

        // FEATURE: STORY REPLY VIA DM
        function pauseStoryTimer() {
            if (storyProgressTimer) { clearTimeout(storyProgressTimer); storyProgressTimer = null; }
            const bar = document.getElementById(`storyBarFill-${storyQueueIndex}`);
            if (bar) bar.style.animationPlayState = 'paused';
        }

        function resumeStoryTimer() {
            // Simplification: resumes the current slide's full duration rather than tracking
            // exact elapsed time, so a paused progress bar restarts cleanly.
            if (storyQueueIndex >= storyQueue.length) return;
            const bar = document.getElementById(`storyBarFill-${storyQueueIndex}`);
            if (bar) {
                bar.style.animationPlayState = 'running';
                bar.style.animation = 'none';
                void bar.offsetWidth;
                bar.style.animation = `storyProgress ${STORY_DURATION_MS}ms linear forwards`;
            }
            if (storyProgressTimer) clearTimeout(storyProgressTimer);
            storyProgressTimer = setTimeout(storyNavNext, STORY_DURATION_MS);
        }

        async function sendStoryReply() {
            const input = document.getElementById('storyReplyInput');
            const text = input.value.trim();
            if (!text) return;
            const story = storyQueue[storyQueueIndex];
            if (!story || story.username === currentUser) return;

            // FEATURE: MESSAGE REQUESTS — private account gate
            if (!(await ensureMessageRequestForSend(story.username))) return;

            try {
                await supabaseClient.from('messages').insert({
                    sender: currentUser,
                    receiver: story.username,
                    text: text,
                    reply_to_story_id: story.id,
                    reply_to_story_media: story.media_url,
                    reply_to_story_username: story.username
                });
                input.value = '';
                const container = document.getElementById('inAppNotificationContainer');
                if (container) {
                    const banner = document.createElement('div');
                    banner.className = "pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border border-[#3b82f6]/40 rounded-2xl p-2.5 shadow-2xl flex items-center space-x-2 animate-slide-down text-xs text-slate-200";
                    banner.innerHTML = `<i class="fa-solid fa-paper-plane text-[#60a5fa]"></i> <span>Reply sent to ${story.username}'s story</span>`;
                    container.appendChild(banner);
                    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 2500);
                }
            } catch (err) {
                console.error('Story reply failed:', err);
                showAlertBanner('Could not send reply: ' + (err.message || 'Unknown error'), 'error');
            }
        }

        // Checks whether the chat partner is a registered bot and, if so, simulates its reply.
        // FEATURE: AI AUTO-REPLY WHEN AWAY
        // BUGFIX #1: this used to fire on EVERY single message sent to an away contact — send
        // 5 texts in a row and you'd get 5 separate "Abhi available nahi hoon" replies (this
        // is why it looked like the message was appearing on its own / being duplicated).
        // Real away-message features (WhatsApp, Gmail auto-reply) only send once per contact
        // within a cooldown window, not once per incoming message — match that here.
        // BUGFIX #2: this used to trust globalProfilesFullCache for the partner's away_mode.
        // That cache only gets refreshed by fetchAllData(), which does NOT run on a timer
        // while you're just sitting in a chat (only loadDirectMessages polls every 2.5s, and
        // that only refetches messages, not profiles). So if the other person turned Away
        // Mode on and then back off, your cached copy could keep saying "on" for a long time
        // and you'd keep getting auto-replies even though they'd already turned it off. Fix:
        // always check the LIVE value from the DB right before deciding to send one.
        async function maybeTriggerAwayAutoReply(chatPartnerUsername, incomingText) {
            if (chatPartnerUsername === currentUser) return;

            let targetProfile;
            try {
                const { data } = await supabaseClient.from('profiles').select('away_mode, away_message').eq('username', chatPartnerUsername).maybeSingle();
                targetProfile = data;
            } catch (e) { return; }
            if (!targetProfile || !targetProfile.away_mode) return;

            // Keep the cache in sync too, so other UI reading it isn't left stale either.
            if (globalProfilesFullCache[chatPartnerUsername]) {
                globalProfilesFullCache[chatPartnerUsername].away_mode = targetProfile.away_mode;
                globalProfilesFullCache[chatPartnerUsername].away_message = targetProfile.away_message;
            }

            const cooldownKey = `nexus_away_reply_sent_${currentUser}_${chatPartnerUsername}`;
            const lastSent = parseInt(localStorage.getItem(cooldownKey) || '0', 10);
            const AWAY_REPLY_COOLDOWN_MS = 15 * 60 * 1000; // one auto-reply per contact per 15 min
            if (lastSent && (Date.now() - lastSent) < AWAY_REPLY_COOLDOWN_MS) return;
            // Mark the cooldown immediately (not after the setTimeout below) — otherwise
            // sending several messages back-to-back, before the first reply finishes, would
            // let all of them slip through the check at the same time.
            localStorage.setItem(cooldownKey, String(Date.now()));

            setTimeout(async () => {
                let replyText = targetProfile.away_message || "Abhi available nahi hoon, thodi der mein reply karunga!";
                try {
                    const prompt = `Tum "${chatPartnerUsername}" ho aur abhi away/busy ho. Tumhara away note: "${targetProfile.away_message || 'Available nahi hoon abhi'}". Kisi ne tumhe yeh message bheja: "${incomingText}". Ek chhota (max 20 shabd), natural, casual Hinglish auto-reply likho jaise tum khud but away hote hue reply kar rahe ho.`;
                    const aiReply = await askNexusAIOnce(prompt, "Tum ek 'away mode' auto-reply generator ho. Sirf ek chhota, natural reply do, koi extra text nahi.");
                    if (aiReply) replyText = aiReply;
                } catch (e) { /* fall back to the plain away_message */ }

                await supabaseClient.from('messages').insert({
                    sender: chatPartnerUsername,
                    receiver: currentUser,
                    text: `🌙 ${replyText}`
                });
                if (activeChatUser === chatPartnerUsername) {
                    loadDirectMessages(chatPartnerUsername, true);
                }
            }, 900);
        }

        async function markStorySeen(storyId) {
            if (ghostModeEnabled) return;
            const alreadySeen = globalStoryViewsCache.some(v => v.story_id === storyId && v.username === currentUser);
            if (alreadySeen) return;
            try {
                await supabaseClient.from('story_views').insert({ story_id: storyId, username: currentUser });
                globalStoryViewsCache.push({ story_id: storyId, username: currentUser });
            } catch (err) { /* non-fatal */ }
        }

        async function deleteCurrentStory() {
            const story = storyQueue[storyQueueIndex];
            if (!story || !confirm("Delete this story?")) return;
            await supabaseClient.from('stories').delete().eq('id', story.id);
            await fetchAllData();
            closeStoryViewer();
        }

        // =====================================================================================
        // FEATURE: GROUP CHAT
        // =====================================================================================
        let groupsListSearchQuery = ''; // FEATURE: GROUP NAME SEARCH

        function filterGroupsList(query) {
            groupsListSearchQuery = query || '';
            renderGroupsList();
        }

        function renderGroupsList() {
            const container = document.getElementById('groupsListContainer');
            if (!container) return;

            // Groups tab only ever shows groups/channels the current user has actually joined —
            // discovering/joining others happens from a profile's Groups tab instead.
            const myGroupIds = new Set(globalGroupMembersCache.filter(m => m.username === currentUser).map(m => String(m.group_id)));
            let myGroups = globalGroupsCache.filter(g => myGroupIds.has(String(g.id)));

            const q = groupsListSearchQuery.trim().toLowerCase();
            if (q) myGroups = myGroups.filter(g => g.name && g.name.toLowerCase().includes(q));

            if (myGroups.length === 0) {
                container.innerHTML = q
                    ? `<div class="p-6 text-center text-xs text-slate-400">No groups match "${groupsListSearchQuery}".</div>`
                    : `<div class="p-6 text-center text-xs text-slate-400">No groups yet. Tap "New" to create one.</div>`;
                return;
            }

            container.innerHTML = myGroups.map(g => {
                const memberCount = globalGroupMembersCache.filter(m => String(m.group_id) === String(g.id)).length;
                return `
                    <div onclick="openGroupChat('${g.id}')" class="p-3 flex items-center space-x-3 cursor-pointer hover:bg-slate-800/60 fast-transition">
                        <div class="w-9 h-9 rounded-full bg-[#334155] flex items-center justify-center font-bold text-xs text-white shadow overflow-hidden shrink-0">${g.avatar_url ? `<img src="${g.avatar_url}" class="w-full h-full object-cover">` : `<i class="fa-solid ${g.is_channel ? 'fa-bullhorn' : 'fa-users'}"></i>`}</div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-slate-200 truncate">${g.name} ${g.is_channel ? '<span class="text-[11px] font-bold text-[#60a5fa] bg-[#2563eb]/10 border border-[#3b82f6]/30 px-1.5 py-0.5 rounded-full ml-1">CHANNEL</span>' : ''} ${g.is_private ? '<span class="text-[11px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded-full ml-1"><i class="fa-solid fa-lock"></i></span>' : ''}</p>
                            <p class="text-[11px] text-slate-400">${memberCount} ${g.is_channel ? 'subscribers' : 'members'}</p>
                        </div>
                        <button onclick="event.stopPropagation(); openGroupInfoModal('${g.id}')" title="Group Options" class="text-slate-400 hover:text-[#60a5fa] p-1.5 shrink-0"><i class="fa-solid fa-ellipsis-vertical text-xs"></i></button>
                        <i class="fa-solid fa-chevron-right text-xs text-slate-400"></i>
                    </div>
                `;
            }).join('');
        }

        function openCreateGroupModal() {
            newGroupSelectedMembers = new Set();
            newGroupIsPrivate = false;
            const searchInput = document.getElementById('newGroupMemberSearchInput');
            if (searchInput) searchInput.value = '';
            renderNewGroupMembersList('');
            updateNewGroupPrivacyButtons();
            document.getElementById('createGroupModal').classList.remove('hidden');
        }

        // FEATURE: GROUP MEMBER SEARCH — re-renders the checkbox list filtered by query, while
        // newGroupSelectedMembers (a Set, not the DOM) keeps track of who's actually selected so
        // a selection survives even after the person searches for someone else.
        function renderNewGroupMembersList(query) {
            const container = document.getElementById('newGroupMembersContainer');
            if (!container) return;
            // FEATURE: GROUP MEMBER LIST — every user shows up here now (not just people you
            // follow / who follow you), but the ones you're connected with (follow or followed by)
            // are sorted to the top so they're the first thing you see.
            const allUsers = cachedAllUsers.filter(u => u !== currentUser);
            if (allUsers.length === 0) {
                container.innerHTML = `<p class="text-[11px] text-slate-400 text-center py-2">Koi user nahi mila.</p>`;
                return;
            }
            const q = (query || '').trim().toLowerCase();
            const filtered = (q ? allUsers.filter(u => u.toLowerCase().includes(q)) : allUsers).slice();
            filtered.sort((a, b) => {
                const aConn = canMessageUser(a), bConn = canMessageUser(b);
                if (aConn !== bConn) return aConn ? -1 : 1;
                return a.localeCompare(b);
            });
            if (filtered.length === 0) {
                container.innerHTML = `<p class="text-[11px] text-slate-400 text-center py-2">Koi user nahi mila.</p>`;
                return;
            }
            container.innerHTML = filtered.map(u => `
                <label class="flex items-center gap-2 p-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-200 cursor-pointer">
                    <input type="checkbox" value="${u}" class="new-group-member-checkbox accent-[#3b82f6]" ${newGroupSelectedMembers.has(u) ? 'checked' : ''} onchange="toggleNewGroupMemberSelection('${u}', this.checked)">
                    <span class="flex-1 truncate">${u}</span>
                    ${canMessageUser(u) ? `<span class="text-[11px] font-bold text-[#38bdf8] bg-[#38bdf8]/10 border border-[#38bdf8]/30 px-1.5 py-0.5 rounded-full shrink-0">Follow</span>` : ''}
                </label>
            `).join('');
        }

        function toggleNewGroupMemberSelection(username, checked) {
            if (checked) newGroupSelectedMembers.add(username); else newGroupSelectedMembers.delete(username);
        }

        function filterNewGroupMembers(query) {
            renderNewGroupMembersList(query);
        }

        // FEATURE: PUBLIC/PRIVATE GROUPS & CHANNELS
        function setNewGroupPrivacy(isPrivate) {
            newGroupIsPrivate = !!isPrivate;
            updateNewGroupPrivacyButtons();
        }

        function updateNewGroupPrivacyButtons() {
            const pubBtn = document.getElementById('newGroupPublicBtn');
            const privBtn = document.getElementById('newGroupPrivateBtn');
            if (!pubBtn || !privBtn) return;
            const activeCls = "flex-1 py-2 rounded-xl text-[11px] font-bold border transition bg-[#2563eb]/15 border-[#3b82f6]/50 text-[#60a5fa]";
            const inactiveCls = "flex-1 py-2 rounded-xl text-[11px] font-bold border transition bg-slate-950 border-slate-800 text-slate-400";
            pubBtn.className = !newGroupIsPrivate ? activeCls : inactiveCls;
            privBtn.className = newGroupIsPrivate ? activeCls : inactiveCls;
        }

        function closeCreateGroupModal() {
            document.getElementById('createGroupModal').classList.add('hidden');
            document.getElementById('newGroupNameInput').value = '';
            document.getElementById('newGroupIsChannelCheckbox').checked = false;
            const searchInput = document.getElementById('newGroupMemberSearchInput');
            if (searchInput) searchInput.value = '';
            newGroupSelectedMembers = new Set();
            newGroupIsPrivate = false;
        }

        async function submitCreateGroup() {
            const name = document.getElementById('newGroupNameInput').value.trim();
            if (!name) { showAlertBanner('Please enter a group name.', 'warning'); return; }
            const checked = Array.from(newGroupSelectedMembers);
            if (checked.length === 0) { showAlertBanner('Select at least one member.', 'warning'); return; }
            const isChannel = document.getElementById('newGroupIsChannelCheckbox').checked; // FEATURE: CHANNELS

            // FEATURE: PUBLIC/PRIVATE GROUPS & CHANNELS — is_private controls whether joining
            // later requires admin approval (see joinOrRequestGroup / group_join_requests).
            const { data: group, error } = await supabaseClient.from('groups').insert({ name, created_by: currentUser, is_channel: isChannel, is_private: newGroupIsPrivate }).select().single();
            if (error || !group) { showAlertBanner('Could not create group: ' + (error ? error.message : 'unknown error'), 'error'); return; }

            const members = [...new Set([currentUser, ...checked])].map(u => ({ group_id: group.id, username: u }));
            const { error: membersError } = await supabaseClient.from('group_members').insert(members);
            if (membersError) {
                console.error('group_members insert failed (check Supabase RLS policies on group_members):', membersError);
                showAlertBanner('Group ban gaya lekin members add nahi ho paaye — Supabase "group_members" table ki RLS policy check karo. (' + membersError.message + ')', 'error');
            }

            // FEATURE: OPTIMISTIC CACHE UPDATE — push the new group/members into the local cache
            // immediately instead of waiting on fetchAllData(). If the DB's SELECT policy for
            // 'groups'/'group_members' is too restrictive (RLS misconfigured), a full refetch can
            // silently come back without the row we just created, which would otherwise make the
            // group vanish right after creation (shows generic "Group" / "0 members").
            if (!globalGroupsCache.some(g => g.id === group.id)) globalGroupsCache.push(group);
            if (!membersError) {
                members.forEach(m => {
                    if (!globalGroupMembersCache.some(gm => gm.group_id === m.group_id && gm.username === m.username)) {
                        globalGroupMembersCache.push(m);
                    }
                });
            }

            closeCreateGroupModal();
            renderGroupsList();
            openGroupChat(group.id);

            // Background sync — merge server truth in without letting a restrictive RLS SELECT
            // wipe out the group/members we just optimistically added above.
            fetchAllData().then(() => {
                if (!globalGroupsCache.some(g => g.id === group.id)) {
                    console.warn('New group missing after fetchAllData() — check the SELECT policy on the "groups" table.');
                    globalGroupsCache.push(group);
                }
                if (!membersError) {
                    members.forEach(m => {
                        if (!globalGroupMembersCache.some(gm => gm.group_id === m.group_id && gm.username === m.username)) {
                            console.warn('New group member missing after fetchAllData() — check the SELECT policy on the "group_members" table.');
                            globalGroupMembersCache.push(m);
                        }
                    });
                }
                renderGroupsList();
                if (activeGroupId === group.id) openGroupChat(group.id);
            });
        }

        function openGroupChat(groupId) {
            activeGroupId = groupId;
            document.getElementById('groupsListView').classList.add('hidden');
            document.getElementById('groupRoomView').classList.remove('hidden');

            const group = globalGroupsCache.find(g => String(g.id) === String(groupId));
            const memberCount = globalGroupMembersCache.filter(m => String(m.group_id) === String(groupId)).length;
            document.getElementById('groupRoomTitle').innerText = group ? group.name : 'Group';
            document.getElementById('groupRoomMemberCount').innerText = `${memberCount} ${group && group.is_channel ? 'subscribers' : 'members'}`;

            // FEATURE: GROUP DP — small avatar in the chat header
            const roomAvatar = document.getElementById('groupRoomAvatar');
            if (roomAvatar) {
                roomAvatar.innerHTML = group && group.avatar_url
                    ? `<img src="${group.avatar_url}" class="w-full h-full object-cover">`
                    : `<i class="fa-solid ${group && group.is_channel ? 'fa-bullhorn' : 'fa-users'} text-[11px]"></i>`;
            }

            // FEATURE: CHANNELS — only the creator can post in a broadcast-only channel
            const canPost = !group || !group.is_channel || group.created_by === currentUser;
            document.getElementById('groupMessageForm').classList.toggle('hidden', !canPost);
            document.getElementById('channelReadOnlyNotice').classList.toggle('hidden', canPost);

            // FEATURE: CHANNELS — voice calls are a Group-only feature; channels stay broadcast (text+media) only
            const callBtn = document.getElementById('groupCallBtn');
            if (callBtn) callBtn.classList.toggle('hidden', !!(group && group.is_channel));

            loadGroupMessages(groupId, true);
        }

        function closeGroupRoom() {
            activeGroupId = null;
            document.getElementById('groupRoomView').classList.add('hidden');
            document.getElementById('groupsListView').classList.remove('hidden');
            renderGroupsList();
        }

        // Group Info modal — shows all members (Insta-style), plus Leave Group / Delete Group (admin only).
        // Works both from an open group room and directly from a row in the groups list.
        function openGroupInfoModal(groupId) {
            if (!groupId) return;
            const group = globalGroupsCache.find(g => String(g.id) === String(groupId));
            if (!group) {
                console.warn('openGroupInfoModal: group not found in cache for id', groupId, '— check Supabase RLS SELECT policy on "groups".');
                showAlertBanner('Group info load nahi ho paayi — page refresh karke dobara try karo.', 'warning');
                return;
            }

            const memberUsernames = globalGroupMembersCache.filter(m => String(m.group_id) === String(groupId)).map(m => m.username);

            document.getElementById('groupInfoName').innerText = group.name;
            document.getElementById('groupInfoMemberCount').innerText = `${memberUsernames.length} ${group.is_channel ? 'subscriber' : 'member'}${memberUsernames.length === 1 ? '' : 's'}`;

            // FEATURE: GROUP DP — big avatar at the top of Group Info; only the admin (creator)
            // gets the pencil/edit overlay to change it.
            const infoAvatar = document.getElementById('groupInfoAvatar');
            if (infoAvatar) {
                infoAvatar.innerHTML = group.avatar_url
                    ? `<img src="${group.avatar_url}" class="w-full h-full object-cover">`
                    : `<i class="fa-solid ${group.is_channel ? 'fa-bullhorn' : 'fa-users'}"></i>`;
            }
            const infoAvatarEditBtn = document.getElementById('groupAvatarEditBtn');
            if (infoAvatarEditBtn) infoAvatarEditBtn.classList.toggle('hidden', group.created_by !== currentUser);

            const container = document.getElementById('groupInfoMembersContainer');
            container.innerHTML = memberUsernames.map(u => {
                const avatarUrl = globalProfilesCache[u];
                const isOnline = onlineUsersSet.has(u);
                const isAdmin = u === group.created_by;
                return `
                    <div class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-900/60">
                        <div class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center font-bold text-[11px] text-white shadow overflow-hidden relative shrink-0">
                            ${avatarUrl ? `<img src="${avatarUrl}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}
                            ${isOnline ? `<span class="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 border border-slate-950"></span>` : ''}
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-slate-200 truncate">${u}${u === currentUser ? ' (You)' : ''}</p>
                        </div>
                        ${isAdmin ? `<span class="text-[11px] font-bold text-[#60a5fa] bg-[#2563eb]/10 border border-[#3b82f6]/30 px-2 py-0.5 rounded-full shrink-0">Admin</span>` : ''}
                    </div>
                `;
            }).join('');

            // Only the group's creator (admin) can delete it for everyone; anyone can leave.
            const isAdminUser = group.created_by === currentUser;
            document.getElementById('deleteGroupBtn').classList.toggle('hidden', !isAdminUser);

            // FEATURE: PUBLIC/PRIVATE GROUPS & CHANNELS — only the admin can flip privacy
            const privacyRow = document.getElementById('groupPrivacyToggleRow');
            if (privacyRow) {
                if (isAdminUser) {
                    privacyRow.classList.remove('hidden');
                    privacyRow.classList.add('flex');
                    renderGroupPrivacyToggle(group);
                } else {
                    privacyRow.classList.add('hidden');
                    privacyRow.classList.remove('flex');
                }
            }

            // FEATURE: GROUP MEMBER SEARCH — "Add Members" entry point, admin-only, collapsed by default
            const addMembersBtn = document.getElementById('toggleAddMembersBtn');
            if (addMembersBtn) addMembersBtn.classList.toggle('hidden', !isAdminUser);
            const addMembersSection = document.getElementById('groupAddMembersSection');
            if (addMembersSection) addMembersSection.classList.add('hidden');
            addGroupMembersSelected = new Set();

            document.getElementById('groupInfoModal').dataset.groupId = groupId;
            document.getElementById('groupInfoModal').classList.remove('hidden');
        }

        function closeGroupInfoModal() {
            document.getElementById('groupInfoModal').classList.add('hidden');
        }

        // FEATURE: PUBLIC/PRIVATE GROUPS & CHANNELS
        function renderGroupPrivacyToggle(group) {
            const dot = document.getElementById('groupPrivacyToggleDot');
            const btn = document.getElementById('groupPrivacyToggleBtn');
            if (!dot || !btn) return;
            const isPrivate = !!group.is_private;
            dot.style.transform = isPrivate ? 'translateX(20px)' : 'translateX(0)';
            btn.className = isPrivate ? 'w-10 h-5 rounded-full bg-[#2563eb] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
        }

        async function toggleGroupPrivacy() {
            const groupId = document.getElementById('groupInfoModal').dataset.groupId;
            const group = globalGroupsCache.find(g => String(g.id) === String(groupId));
            if (!group || group.created_by !== currentUser) return;
            try {
                const { data, error } = await supabaseClient.from('groups').update({ is_private: !group.is_private }).eq('id', groupId).select();
                if (error) throw error;
                if (!data || data.length === 0) {
                    showAlertBanner("Privacy update save nahi hua — 'groups' table par UPDATE policy check karo (owner apni khud ki group update kar sake).", 'error');
                    return;
                }
                group.is_private = data[0].is_private;
                renderGroupPrivacyToggle(group);
                renderGroupsList();
                showAlertBanner(group.is_private ? 'Group/Channel ab Private hai — naye members ko admin approval chahiye.' : 'Group/Channel ab Public hai — koi bhi seedha join kar sakta hai.', 'success');
            } catch (err) {
                console.error("Toggle group privacy failed (did you run the groups.is_private migration?):", err);
                showAlertBanner("Privacy toggle ke liye ek chhoti si SQL setup baaki hai ('groups.is_private' column).", 'error');
            }
        }

        // FEATURE: GROUP MEMBER SEARCH — add existing users to an already-created group
        function toggleAddMembersSection() {
            const section = document.getElementById('groupAddMembersSection');
            if (!section) return;
            const willShow = section.classList.contains('hidden');
            section.classList.toggle('hidden');
            if (willShow) {
                addGroupMembersSelected = new Set();
                const searchInput = document.getElementById('groupAddMemberSearchInput');
                if (searchInput) searchInput.value = '';
                renderAddGroupMembersList('');
            }
        }

        function renderAddGroupMembersList(query) {
            const container = document.getElementById('groupAddMembersContainer');
            if (!container) return;
            const groupId = document.getElementById('groupInfoModal').dataset.groupId;
            const existingMembers = new Set(globalGroupMembersCache.filter(m => String(m.group_id) === String(groupId)).map(m => m.username));
            // FEATURE: GROUP MEMBER LIST — show every user who isn't already in the group, with
            // people you follow / who follow you sorted to the top.
            const addable = cachedAllUsers.filter(u => u !== currentUser && !existingMembers.has(u));
            const q = (query || '').trim().toLowerCase();
            const filtered = (q ? addable.filter(u => u.toLowerCase().includes(q)) : addable).slice();
            filtered.sort((a, b) => {
                const aConn = canMessageUser(a), bConn = canMessageUser(b);
                if (aConn !== bConn) return aConn ? -1 : 1;
                return a.localeCompare(b);
            });

            if (addable.length === 0) {
                container.innerHTML = `<p class="text-[11px] text-slate-400 text-center py-2">Add karne layak koi naya user nahi hai.</p>`;
                return;
            }
            if (filtered.length === 0) {
                container.innerHTML = `<p class="text-[11px] text-slate-400 text-center py-2">Koi user nahi mila.</p>`;
                return;
            }
            container.innerHTML = filtered.map(u => `
                <label class="flex items-center gap-2 p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] text-slate-200 cursor-pointer">
                    <input type="checkbox" value="${u}" class="accent-[#38bdf8]" ${addGroupMembersSelected.has(u) ? 'checked' : ''} onchange="toggleAddGroupMemberSelection('${u}', this.checked)">
                    <span class="flex-1 truncate">${u}</span>
                    ${canMessageUser(u) ? `<span class="text-[11px] font-bold text-[#38bdf8] bg-[#38bdf8]/10 border border-[#38bdf8]/30 px-1.5 py-0.5 rounded-full shrink-0">Follow</span>` : ''}
                </label>
            `).join('');
        }

        function toggleAddGroupMemberSelection(username, checked) {
            if (checked) addGroupMembersSelected.add(username); else addGroupMembersSelected.delete(username);
        }

        function filterAddGroupMembers(query) {
            renderAddGroupMembersList(query);
        }

        async function submitAddGroupMembers() {
            const groupId = document.getElementById('groupInfoModal').dataset.groupId;
            const group = globalGroupsCache.find(g => String(g.id) === String(groupId));
            if (!group) return;
            const toAdd = Array.from(addGroupMembersSelected);
            if (toAdd.length === 0) { showAlertBanner('Add karne ke liye kam se kam ek user select karo.', 'warning'); return; }

            try {
                const rows = toAdd.map(u => ({ group_id: groupId, username: u }));
                const { error } = await supabaseClient.from('group_members').insert(rows);
                if (error) throw error;
                showAlertBanner(`${toAdd.length} member${toAdd.length > 1 ? 's' : ''} add ho gaye.`, 'success');
                addGroupMembersSelected = new Set();
                document.getElementById('groupAddMembersSection').classList.add('hidden');
                await fetchAllData();
                openGroupInfoModal(groupId);
            } catch (err) {
                console.error('Add group members failed:', err);
                showAlertBanner('Members add nahi ho paaye — dobara try karo.', 'error');
            }
        }

        async function leaveCurrentGroup() {
            const groupId = document.getElementById('groupInfoModal').dataset.groupId;
            const group = globalGroupsCache.find(g => String(g.id) === String(groupId));
            if (!group) return;

            if (!confirm(`Leave "${group.name}"? Dobara add hone tak aap group messages nahi dekh payenge.`)) return;

            await supabaseClient.from('group_members').delete().eq('group_id', groupId).eq('username', currentUser);

            closeGroupInfoModal();
            if (String(activeGroupId) === String(groupId)) closeGroupRoom();
            await fetchAllData();
            renderGroupsList();
        }

        async function deleteCurrentGroup() {
            const groupId = document.getElementById('groupInfoModal').dataset.groupId;
            const group = globalGroupsCache.find(g => String(g.id) === String(groupId));
            if (!group) return;

            if (group.created_by !== currentUser) { showAlertBanner('Sirf group admin hi is group ko delete kar sakta hai.', 'warning'); return; }
            if (!confirm(`Delete "${group.name}" permanently for everyone? Ye action undo nahi ho sakta.`)) return;

            await supabaseClient.from('group_messages').delete().eq('group_id', groupId);
            await supabaseClient.from('group_members').delete().eq('group_id', groupId);
            await supabaseClient.from('groups').delete().eq('id', groupId);

            closeGroupInfoModal();
            if (String(activeGroupId) === String(groupId)) closeGroupRoom();
            await fetchAllData();
            renderGroupsList();
        }

        async function loadGroupMessages(groupId, forceScroll = false) {
            const { data: messages } = await supabaseClient.from('group_messages').select('*').eq('group_id', groupId).order('created_at', { ascending: true });
            globalGroupMessagesCache = messages || [];
            renderGroupMessages(forceScroll);
        }

        function renderGroupMessages(forceScroll = true) {
            const box = document.getElementById('groupMessagesBox');
            if (!box) return;

            if (globalGroupMessagesCache.length === 0) {
                box.innerHTML = `<div class="text-center text-xs text-slate-400 my-auto">No messages yet. Say hi to the group! 👋</div>`;
                updatePinnedBanner('group');
                return;
            }

            const groupHtmlContent = globalGroupMessagesCache.map(msg => {
                const isMe = msg.sender === currentUser;
                const isVideoMedia = msg.media_url && msg.media_url.match(/\.(mp4|mov|webm)$/i);
                const timeLabel = formatMessageTimestamp(new Date(msg.created_at || Date.now()));
                const av = globalProfilesCache[msg.sender];
                const reactionsHtml = renderReactionBadgesHtml(msg.id, 'group');

                const groupBodyHtml = `${msg.media_url ? (
                        isVideoMedia ?
                        `<video src="${msg.media_url}" data-msg-id="${msg.id}" onclick="event.stopPropagation(); openChatMediaTap('${msg.media_url}', true, ${msg.shared_post_id ? `'${msg.shared_post_id}'` : 'null'})" controls playsinline class="w-full max-h-48 rounded-lg object-cover cursor-pointer"></video>` :
                        `<img src="${msg.media_url}" onclick="event.stopPropagation(); openChatMediaTap('${msg.media_url}', false, ${msg.shared_post_id ? `'${msg.shared_post_id}'` : 'null'})" class="w-full max-h-48 rounded-lg object-cover cursor-pointer">`
                    ) : ''}
                       <p class="leading-relaxed break-words">${msg.text}</p>`;

                return `
                    <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-0.5">
                        ${!isMe ? `<span class="text-[11px] font-bold text-[#60a5fa] px-1">${msg.sender}</span>` : ''}
                        <div class="max-w-[80%] p-2.5 rounded-2xl shadow ${isMe ? 'bg-[#2563eb] text-white rounded-br-none' : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none'} text-xs space-y-1.5 relative group" ondblclick="openReactionPicker(event, '${msg.id}', 'group')">
                            ${groupBodyHtml}
                            <button onclick="togglePinMessage('${msg.id}', 'group')" class="absolute -bottom-2 ${isMe ? '-right-2' : '-left-2'} ${msg.pinned_at ? 'bg-yellow-500 text-black' : 'bg-slate-800 text-yellow-400'} p-1 rounded-full text-[11px] shadow opacity-0 group-hover:opacity-100 transition" title="${msg.pinned_at ? 'Unpin' : 'Pin'}"><i class="fa-solid fa-thumbtack"></i></button>
                            <button onclick="openReactionPicker(event, '${msg.id}', 'group')" class="absolute -bottom-2 ${isMe ? '-left-2' : 'left-2'} bg-slate-800 text-yellow-400 p-1 rounded-full text-[11px] shadow opacity-0 group-hover:opacity-100 transition" title="React"><i class="fa-solid fa-face-smile"></i></button>
                        </div>
                        ${reactionsHtml}
                        <span class="text-[11px] text-slate-400 px-1">${timeLabel}</span>
                    </div>
                `;
            }).join('');

            if (box.innerHTML !== groupHtmlContent) {
                replaceChatHtmlPreservingVideo(box, groupHtmlContent);
            }

            if (forceScroll) box.scrollTop = box.scrollHeight;
            updatePinnedBanner('group');
        }

        async function handleGroupMediaSelect(input) {
            if (input.files && input.files[0]) {
                selectedGroupMediaObject = await compressImageFile(input.files[0]);
                showAlertBanner(`Media attached: ${selectedGroupMediaObject.name}. Now click send.`, 'info');
            }
        }

        async function submitGroupMessage(e) {
            e.preventDefault();
            if (!activeGroupId) return;

            // FEATURE: CHANNELS — guard again here in case the form was still submitted somehow
            const activeGroup = globalGroupsCache.find(g => String(g.id) === String(activeGroupId));
            if (activeGroup && activeGroup.is_channel && activeGroup.created_by !== currentUser) {
                showAlertBanner('Only the channel admin can post here.', 'warning');
                return;
            }

            const input = document.getElementById('groupMessageInput');
            const text = input.value.trim();
            if (!text && !selectedGroupMediaObject) return;

            let mediaUrl = null;
            if (selectedGroupMediaObject) {
                try {
                    const fileName = `group_${Date.now()}_${selectedGroupMediaObject.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                    const upG = await uploadMediaFile(fileName, selectedGroupMediaObject);
                    if (!upG.error) {
                        mediaUrl = upG.url;
                    }
                } catch (err) { console.error(err); }
            }

            await supabaseClient.from('group_messages').insert({
                group_id: activeGroupId,
                sender: currentUser,
                text: text || '[Media Attachment]',
                media_url: mediaUrl
            });

            input.value = '';
            selectedGroupMediaObject = null;
            document.getElementById('groupMediaFileInput').value = '';
            loadGroupMessages(activeGroupId, true);
        }

        // =====================================================================================
        // FEATURE: GROUP VOICE CALLS (mesh WebRTC, audio-only)
        // Best-effort for small groups. Reliability depends on each participant's network/NAT,
        // same TURN servers as 1-1 calls are reused. This is more experimental than 1-1 calling.
        // =====================================================================================
        function startGroupCall() {
            if (!activeGroupId) return;
            const group = globalGroupsCache.find(g => String(g.id) === String(activeGroupId));
            const members = globalGroupMembersCache.filter(m => String(m.group_id) === String(activeGroupId)).map(m => m.username).filter(u => u !== currentUser);

            if (members.length === 0) { showAlertBanner('No other members in this group.', 'warning'); return; }

            // Notify all members with a group-invite row (lightweight, no SDP yet)
            members.forEach(async (member) => {
                await supabaseClient.from('calls').insert({
                    caller_id: currentUser,
                    callee_id: member,
                    call_type: 'audio',
                    status: 'group-invite',
                    group_id: activeGroupId,
                    group_name: group ? group.name : 'Group'
                });
            });

            joinGroupCallMesh(activeGroupId, group ? group.name : 'Group');
        }

        function handleIncomingGroupInvite(record) {
            // Ignore if already in this same group call
            if (String(groupCallId) === String(record.group_id)) return;
            document.getElementById('incomingGroupCallName').innerText = record.group_name || 'Group Call';
            document.getElementById('incomingGroupCallLabel').innerText = `${record.caller_id} started a group call`;
            document.getElementById('incomingGroupCallModal').dataset.groupId = record.group_id;
            document.getElementById('incomingGroupCallModal').dataset.groupName = record.group_name || 'Group';
            document.getElementById('incomingGroupCallModal').classList.remove('hidden');
        }

        function rejectGroupCall() {
            document.getElementById('incomingGroupCallModal').classList.add('hidden');
        }

        function acceptGroupCallInvite() {
            const modal = document.getElementById('incomingGroupCallModal');
            const groupId = modal.dataset.groupId;
            const groupName = modal.dataset.groupName;
            modal.classList.add('hidden');
            joinGroupCallMesh(groupId, groupName);
        }

        async function joinGroupCallMesh(groupId, groupName) {
            if (groupCallId) { showAlertBanner('You are already in a call.', 'warning'); return; }
            try {
                groupCallLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            } catch (err) {
                showAlertBanner('Microphone permission is required to join the group call.', 'warning');
                return;
            }

            groupCallId = groupId;
            isGroupCallMuted = false;
            document.getElementById('groupCallStatusText').innerText = `In call: ${groupName}`;
            document.getElementById('activeGroupCallBar').classList.remove('hidden');
            document.getElementById('activeGroupCallBar').classList.add('flex');

            // Presence channel for this group's call "room" so joined members can discover each other
            groupCallSignalChannel = supabaseClient.channel('groupcall_presence_' + groupId, {
                config: { presence: { key: currentUser } }
            });
            groupCallSignalChannel.on('presence', { event: 'sync' }, () => {
                const state = groupCallSignalChannel.presenceState();
                const present = Object.keys(state).filter(u => u !== currentUser);
                present.forEach(peer => {
                    // Deterministic tie-break: only the alphabetically-smaller username initiates the offer,
                    // so each pair only opens one connection instead of two racing each other.
                    if (currentUser < peer && !groupCallPeers[peer]) {
                        initiateOfferToGroupPeer(peer, groupId);
                    }
                });
            }).subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await groupCallSignalChannel.track({ joined_at: new Date().toISOString() });
                }
            });
        }

        function createGroupPeerConnection(peerUsername, groupId) {
            const pc = new RTCPeerConnection(rtcConfig);
            if (groupCallLocalStream) {
                groupCallLocalStream.getTracks().forEach(track => pc.addTrack(track, groupCallLocalStream));
            }

            pc.ontrack = (event) => {
                let audioEl = document.getElementById('groupCallAudio_' + peerUsername);
                if (!audioEl) {
                    audioEl = document.createElement('audio');
                    audioEl.id = 'groupCallAudio_' + peerUsername;
                    audioEl.autoplay = true;
                    audioEl.style.display = 'none';
                    document.body.appendChild(audioEl);
                }
                audioEl.srcObject = event.streams[0];
            };

            pc.onicecandidate = async (event) => {
                if (event.candidate) {
                    await supabaseClient.from('calls').insert({
                        caller_id: currentUser,
                        callee_id: peerUsername,
                        call_type: 'audio',
                        status: 'group-ice',
                        group_id: groupId,
                        ice_candidates: event.candidate
                    });
                }
            };

            groupCallPeers[peerUsername] = pc;
            return pc;
        }

        async function initiateOfferToGroupPeer(peerUsername, groupId) {
            const pc = createGroupPeerConnection(peerUsername, groupId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await supabaseClient.from('calls').insert({
                caller_id: currentUser,
                callee_id: peerUsername,
                call_type: 'audio',
                status: 'group-offer',
                group_id: groupId,
                sdp_offer: offer
            });
        }

        async function handleIncomingGroupOffer(record) {
            if (!groupCallId || groupCallId !== record.group_id) return; // must have already joined the call room
            const peerUsername = record.caller_id;
            const pc = groupCallPeers[peerUsername] || createGroupPeerConnection(peerUsername, record.group_id);
            await pc.setRemoteDescription(new RTCSessionDescription(record.sdp_offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await supabaseClient.from('calls').insert({
                caller_id: currentUser,
                callee_id: peerUsername,
                call_type: 'audio',
                status: 'group-answer',
                group_id: record.group_id,
                sdp_answer: answer
            });
        }

        async function handleIncomingGroupAnswer(record) {
            const pc = groupCallPeers[record.caller_id];
            if (!pc || pc.currentRemoteDescription) return;
            await pc.setRemoteDescription(new RTCSessionDescription(record.sdp_answer));
        }

        async function handleIncomingGroupIce(record) {
            const pc = groupCallPeers[record.caller_id];
            if (!pc) return;
            try {
                await pc.addIceCandidate(new RTCIceCandidate(record.ice_candidates));
            } catch (err) { console.error(err); }
        }

        function toggleGroupCallMute() {
            if (!groupCallLocalStream) return;
            isGroupCallMuted = !isGroupCallMuted;
            groupCallLocalStream.getAudioTracks().forEach(track => track.enabled = !isGroupCallMuted);
            document.getElementById('groupMuteIcon').className = isGroupCallMuted ? "fa-solid fa-microphone-slash" : "fa-solid fa-microphone";
        }

        function leaveGroupCall() {
            Object.values(groupCallPeers).forEach(pc => { try { pc.close(); } catch (e) {} });
            groupCallPeers = {};

            document.querySelectorAll('audio[id^="groupCallAudio_"]').forEach(el => el.remove());

            if (groupCallLocalStream) {
                groupCallLocalStream.getTracks().forEach(t => t.stop());
                groupCallLocalStream = null;
            }

            if (groupCallSignalChannel) {
                supabaseClient.removeChannel(groupCallSignalChannel);
                groupCallSignalChannel = null;
            }

            groupCallId = null;
            document.getElementById('activeGroupCallBar').classList.add('hidden');
            document.getElementById('activeGroupCallBar').classList.remove('flex');
        }

        // =====================================================================================
        // FEATURE: VOICE NOTES (record & send audio in chat)
        // =====================================================================================
        async function toggleVoiceRecording() {
            if (!activeChatUser) return;
            if (!isRecordingVoice) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    voiceRecordedChunks = [];
                    voiceMediaRecorder = new MediaRecorder(stream);
                    voiceMediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) voiceRecordedChunks.push(e.data); };
                    voiceMediaRecorder.onstop = async () => {
                        stream.getTracks().forEach(t => t.stop());
                        const blob = new Blob(voiceRecordedChunks, { type: 'audio/webm' });
                        if (blob.size > 0) await sendVoiceNote(blob);
                    };
                    voiceMediaRecorder.start();
                    isRecordingVoice = true;
                    const btn = document.getElementById('voiceRecordBtn');
                    const icon = document.getElementById('voiceRecordIcon');
                    btn.classList.add('bg-red-600', 'animate-pulse');
                    btn.classList.remove('bg-slate-800', 'hover:bg-slate-700');
                    icon.className = 'fa-solid fa-stop';
                    btn.title = 'Stop & send voice note';
                } catch (err) {
                    console.error("Mic access error:", err);
                    showAlertBanner('Mic access nahi mila. Browser permissions check karein.', 'error');
                }
            } else {
                if (voiceMediaRecorder && voiceMediaRecorder.state !== 'inactive') voiceMediaRecorder.stop();
                isRecordingVoice = false;
                const btn = document.getElementById('voiceRecordBtn');
                const icon = document.getElementById('voiceRecordIcon');
                btn.classList.remove('bg-red-600', 'animate-pulse');
                btn.classList.add('bg-slate-800', 'hover:bg-slate-700');
                icon.className = 'fa-solid fa-microphone';
                btn.title = 'Record voice note';
            }
        }

        async function sendVoiceNote(blob) {
            if (!activeChatUser) return;
            // FEATURE: MESSAGE REQUESTS — private account gate
            if (!(await ensureMessageRequestForSend(activeChatUser))) return;
            try {
                const fileName = `voice_${Date.now()}_${currentUser}.webm`;
                const upV = await uploadMediaFile(fileName, blob, { contentType: 'audio/webm' });
                if (upV.error) throw upV.error;
                const pubData = { publicUrl: upV.url };

                const messagePayload = {
                    sender: currentUser,
                    receiver: activeChatUser,
                    text: '🎤 Voice message',
                    audio_url: pubData.publicUrl,
                    type: 'voice'
                };
                if (disappearingChatsSet.has(activeChatUser)) {
                    messagePayload.expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                }
                await supabaseClient.from('messages').insert(messagePayload);
                loadDirectMessages(activeChatUser, true);
                updateChatRequestUI(activeChatUser); // FEATURE: MESSAGE REQUESTS
            } catch (err) {
                console.error("Voice note send failed (did you run the messages.type/audio_url migration?):", err);
                showAlertBanner('Voice note bhejne me error aayi. Console check karein (DB migration run hui?).', 'error');
            }
        }

        // =====================================================================================
        // FEATURE: SUGGESTED USERS (based on mutual follows)
        // =====================================================================================
        function renderSuggestedUsers() {
            const section = document.getElementById('suggestedUsersSection');
            const container = document.getElementById('suggestedUsersContainer');
            if (!section || !container) return;

            const iFollow = new Set(globalFollowsCache.filter(f => f.follower === currentUser).map(f => f.following));
            const scores = {};

            // For every person I follow, look at who THEY follow — that's a mutual-based suggestion
            iFollow.forEach(followedUser => {
                globalFollowsCache.filter(f => f.follower === followedUser).forEach(f => {
                    const candidate = f.following;
                    if (candidate === currentUser || iFollow.has(candidate)) return;
                    if (isBlockedWith(candidate)) return;
                    scores[candidate] = (scores[candidate] || 0) + 1;
                });
            });

            let suggestions = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);

            // Fallback: if no mutuals yet, just suggest a few users I don't already follow
            if (suggestions.length === 0) {
                suggestions = cachedAllUsers.filter(u => u !== currentUser && !iFollow.has(u) && !isBlockedWith(u)).slice(0, 6);
            }

            suggestions = suggestions.slice(0, 10);

            if (suggestions.length === 0) {
                section.classList.add('hidden');
                return;
            }
            section.classList.remove('hidden');

            container.innerHTML = suggestions.map(u => {
                const av = globalProfilesCache[u];
                const mutualCount = scores[u] || 0;
                return `
                    <div class="shrink-0 w-24 bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-center space-y-1.5">
                        <div onclick="handleUserClick('${u}')" class="w-10 h-10 mx-auto rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden cursor-pointer shadow">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                        <p class="text-[11px] font-bold text-slate-200 truncate">${u}</p>
                        <p class="text-[11px] text-slate-400">${mutualCount > 0 ? mutualCount + ' mutual' + (mutualCount > 1 ? 's' : '') : 'Suggested'}</p>
                        <button onclick="toggleFollowFromFeed('${u}')" class="w-full bg-[#2563eb] hover:bg-[#2563eb] text-white text-[11px] font-bold py-1 rounded-lg transition">Follow</button>
                    </div>
                `;
            }).join('');
        }

        // =====================================================================================
        // FEATURE: BLOCK / REPORT USER
        // =====================================================================================
        async function toggleBlockUser(username) {
            const existing = globalBlockedCache.find(b => b.blocker === currentUser && b.blocked === username);
            try {
                if (existing) {
                    await supabaseClient.from('blocked_users').delete().eq('id', existing.id);
                } else {
                    if (!confirm(`Block ${username}? Aapko unke posts, comments aur messages nahi dikhenge.`)) return;
                    await supabaseClient.from('blocked_users').insert({ blocker: currentUser, blocked: username });
                    // Blocking also removes any existing follow relationship both ways
                    await supabaseClient.from('follows').delete().eq('follower', currentUser).eq('following', username);
                    await supabaseClient.from('follows').delete().eq('follower', username).eq('following', currentUser);
                }
                closeUserActionModal();
                await fetchAllData();
                // Keep the Blocked Users card in sync if it's currently open on our own profile
                if (viewingProfileUsername === currentUser && profileFlipped) renderBlockedUsersCard(true);
            } catch (err) {
                console.error("Block failed (did you run the blocked_users migration?):", err);
                showAlertBanner('Block feature ke liye database migration chahiye. Console check karein.', 'error');
            }
        }

        function openReportUserModal(username) {
            activeBlockReportUsername = username;
            document.getElementById('reportModalUsername').innerText = username;
            closeUserActionModal();
            document.getElementById('reportUserModal').classList.remove('hidden');
        }

        function closeReportUserModal() {
            activeBlockReportUsername = null;
            document.getElementById('reportUserModal').classList.add('hidden');
        }

        async function submitReport(reason) {
            if (!activeBlockReportUsername) return;
            try {
                await supabaseClient.from('reports').insert({
                    reporter: currentUser,
                    reported_user: activeBlockReportUsername,
                    reason
                });
                showAlertBanner(`${activeBlockReportUsername} report kar diya gaya. Hamari team review karegi.`, 'success');
            } catch (err) {
                console.error("Report failed (did you run the reports migration?):", err);
                showAlertBanner('Report submit nahi ho paayi. Console check karein (DB migration run hui?).', 'error');
            }
            closeReportUserModal();
        }

        // =====================================================================================
        // FEATURE: PRIVATE ACCOUNT + FOLLOW REQUEST APPROVAL
        // =====================================================================================
        // FEATURE: AI AUTO-REPLY WHEN AWAY
        let awayModeAvailable = true;
        async function toggleAwayMode() {
            const myProfile = globalProfilesFullCache[currentUser] || {};
            const newState = !myProfile.away_mode;
            const message = document.getElementById('awayMessageInput').value.trim();
            try {
                const { error } = await supabaseClient.from('profiles').update({ away_mode: newState, away_message: message || null }).eq('username', currentUser);
                if (error) throw error;
                awayModeAvailable = true;
                document.getElementById('awayModeFeatureNotice').classList.add('hidden');

                // DELAY FIX: same root cause as the Private Account toggle — this used to
                // `await fetchAllData()` (refetching every table) before flipping the switch,
                // which made it feel slow next to Ghost Mode's instant, purely-local flip.
                // We already know the new state locally, so update the cache + switch now and
                // let the background refetch just keep everything else in sync.
                globalProfilesFullCache[currentUser] = { ...myProfile, away_mode: newState, away_message: message || null };
                renderAwayModeToggle();
                fetchAllData();
            } catch (e) {
                console.warn('Nexus: profiles.away_mode/away_message columns not set up yet.', e);
                awayModeAvailable = false;
                document.getElementById('awayModeFeatureNotice').classList.remove('hidden');
            }
        }
        async function saveAwayMessage() {
            const myProfile = globalProfilesFullCache[currentUser] || {};
            if (!myProfile.away_mode || !awayModeAvailable) return; // only persist live if away mode is already on
            const message = document.getElementById('awayMessageInput').value.trim();
            try {
                await supabaseClient.from('profiles').update({ away_message: message || null }).eq('username', currentUser);
            } catch (e) { /* non-fatal */ }
        }
        function renderAwayModeToggle() {
            const myProfile = globalProfilesFullCache[currentUser] || {};
            const dot = document.getElementById('awayModeToggleDot');
            const btn = document.getElementById('awayModeToggleBtn');
            if (!dot || !btn) return;
            const isAway = !!myProfile.away_mode;
            dot.style.transform = isAway ? 'translateX(20px)' : 'translateX(0)';
            btn.className = isAway ? 'w-10 h-5 rounded-full bg-[#0f766e] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
            document.getElementById('awayMessageInput').value = myProfile.away_message || '';
        }

        // FEATURE: GHOST MODE — purely a local browser setting, nothing synced to Supabase
        function toggleGhostMode() {
            ghostModeEnabled = !ghostModeEnabled;
            localStorage.setItem('nexus_ghost_mode', ghostModeEnabled ? '1' : '0');
            renderGhostModeToggle();
            showInAppBanner(ghostModeEnabled ? '👻 Ghost Mode ON' : 'Ghost Mode OFF', ghostModeEnabled ? 'Ab tumhare views/read-receipts track nahi honge.' : 'Wapas normal tracking chalu.');
        }
        function renderGhostModeToggle() {
            const dot = document.getElementById('ghostModeToggleDot');
            const btn = document.getElementById('ghostModeToggleBtn');
            const navIndicator = document.getElementById('ghostModeNavIndicator');
            if (navIndicator) navIndicator.classList.toggle('hidden', !ghostModeEnabled);
            if (!dot || !btn) return;
            dot.style.transform = ghostModeEnabled ? 'translateX(20px)' : 'translateX(0)';
            btn.className = ghostModeEnabled ? 'w-10 h-5 rounded-full bg-[#0f766e] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
        }

        // Small, cheap, standalone re-render for just the private-account switch — this is
        // what lets togglePrivateAccount() flip the UI instantly instead of waiting on a
        // full openProfile()/fetchAllData() round trip (see note inside togglePrivateAccount).
        function renderPrivateAccountToggle() {
            const myProfile = globalProfilesFullCache[currentUser];
            const isPrivate = !!(myProfile && myProfile.is_private);
            const dot = document.getElementById('privateAccountToggleDot');
            const toggleBtn = document.getElementById('privateAccountToggleBtn');
            if (dot && toggleBtn) {
                dot.style.transform = isPrivate ? 'translateX(20px)' : 'translateX(0)';
                toggleBtn.className = isPrivate ? 'w-10 h-5 rounded-full bg-[#2563eb] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
            }
        }

        async function togglePrivateAccount() {
            const myProfile = globalProfilesFullCache[currentUser];
            const isPrivate = !!(myProfile && myProfile.is_private);
            try {
                // .select() added so we get back the rows that were actually updated.
                // Supabase does NOT throw an "error" when an RLS policy silently blocks
                // the update — it just returns an empty data array with error = null.
                // Without checking data.length, the toggle looks like it "does nothing".
                const { data, error } = await supabaseClient
                    .from('profiles')
                    .update({ is_private: !isPrivate })
                    .eq('username', currentUser)
                    .select();

                if (error) throw error;

                if (!data || data.length === 0) {
                    // Update ran but 0 rows were affected -> almost always an RLS UPDATE
                    // policy on the "profiles" table blocking this user from updating
                    // their own row (or the row wasn't matched by "username").
                    showAlertBanner("Private account toggle save nahi hua. Supabase 'profiles' table par UPDATE policy check karein — logged-in user ko apni khud ki row update karne ki permission honi chahiye (username match par).", 'error');
                    console.error("togglePrivateAccount: update affected 0 rows — check RLS UPDATE policy on 'profiles' table.");
                    return;
                }

                // Optimistically reflect the change immediately (don't wait on a full refetch)
                globalProfilesFullCache[currentUser] = data[0];

                // DELAY FIX: this used to `await fetchAllData()` (a full refetch of every
                // table in the app) before flipping the switch — that's why this toggle felt
                // sluggish next to Ghost Mode (which is purely local/instant, no network call
                // at all). We already have the updated row from Supabase above, so paint the
                // switch right now and let the full data refresh happen quietly afterwards.
                renderPrivateAccountToggle();
                updateFollowRequestsBadge();
                fetchAllData().then(() => {
                    if (viewingProfileUsername === currentUser) openProfile(currentUser, false);
                });
            } catch (err) {
                console.error("Private account toggle failed (did you run the profiles.is_private migration?):", err);
                showAlertBanner('Private account feature ke liye database migration chahiye. Console check karein.', 'error');
            }
        }

        function updateFollowRequestsBadge() {
            const bell = document.getElementById('followRequestsBellBtn');
            const badge = document.getElementById('followRequestsBadge');
            if (!bell || !badge) return;
            const myProfile = globalProfilesFullCache[currentUser];
            const isPrivate = !!(myProfile && myProfile.is_private);
            const pending = globalFollowRequestsCache.filter(r => r.target === currentUser);

            if (!isPrivate && pending.length === 0) {
                bell.classList.add('hidden');
                return;
            }
            bell.classList.remove('hidden');
            if (pending.length > 0) {
                badge.classList.remove('hidden');
                badge.innerText = pending.length;
            } else {
                badge.classList.add('hidden');
            }
        }

        function openFollowRequestsModal() {
            renderFollowRequests();
            document.getElementById('followRequestsModal').classList.remove('hidden');
        }

        function closeFollowRequestsModal() {
            document.getElementById('followRequestsModal').classList.add('hidden');
        }

        function renderFollowRequests() {
            const container = document.getElementById('followRequestsContainer');
            const pending = globalFollowRequestsCache.filter(r => r.target === currentUser);

            if (pending.length === 0) {
                container.innerHTML = `<p class="text-center text-xs text-slate-400 py-6">Koi pending follow request nahi hai.</p>`;
                return;
            }

            container.innerHTML = pending.map(r => {
                const av = globalProfilesCache[r.requester];
                return `
                    <div class="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl p-2.5">
                        <div class="flex items-center space-x-2 min-w-0">
                            <div onclick="handleUserClick('${r.requester}')" class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden cursor-pointer shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : r.requester.charAt(0).toUpperCase()}</div>
                            <span class="text-xs font-bold text-slate-200 truncate">${r.requester}</span>
                        </div>
                        <div class="flex gap-1.5 shrink-0">
                            <button onclick="approveFollowRequest('${r.id}', '${r.requester}')" class="bg-[#2563eb] hover:bg-[#2563eb] text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition">Accept</button>
                            <button onclick="declineFollowRequest('${r.id}')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition">Decline</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // FEATURE: FOLLOW REQUEST ACCEPT — FIXED. Inserting `{ follower: requesterUsername, ... }`
        // directly from the client used to get silently blocked by RLS (the logged-in user
        // approving is the TARGET, not the requester, so a normal "follower = auth user" policy
        // rejects it) — the code never checked the insert's error and deleted the request anyway,
        // so Accept looked exactly like Decline. Fixed by calling a SECURITY DEFINER RPC
        // (rpc_approve_follow_request — run supabase_follow_request_fix.sql once) that verifies
        // the caller really is the request's target before creating the follow row. Falls back to
        // the old direct-insert path only if that migration hasn't been run yet, and now actually
        // surfaces failures to the user instead of hiding them.
        async function approveFollowRequest(requestId, requesterUsername) {
            try {
                const { data: rpcOk, error: rpcErr } = await supabaseClient.rpc('rpc_approve_follow_request', { p_request_id: String(requestId) });

                if (rpcErr) {
                    console.warn("rpc_approve_follow_request not available yet, falling back to direct insert (run supabase_follow_request_fix.sql to fix properly):", rpcErr);
                    const { error: insertErr } = await supabaseClient.from('follows').insert({ follower: requesterUsername, following: currentUser });
                    if (insertErr) {
                        console.error("Approve follow request failed:", insertErr);
                        showAlertBanner('Follow request accept nahi ho paayi — dobara try karo.', 'error');
                        return;
                    }
                    await supabaseClient.from('follow_requests').delete().eq('id', requestId);
                } else if (rpcOk === false) {
                    showAlertBanner('Ye follow request ab valid nahi hai.', 'error');
                    return;
                }

                await fetchAllData();
                renderFollowRequests();
                renderNotificationsList(); // FEATURE: NOTIFICATIONS
                showAlertBanner(`${requesterUsername} ab tumhe follow karta hai!`, 'success');
            } catch (err) {
                console.error("Approve follow request failed:", err);
                showAlertBanner('Follow request accept nahi ho paayi — dobara try karo.', 'error');
            }
        }

        async function declineFollowRequest(requestId) {
            try {
                const { error } = await supabaseClient.from('follow_requests').delete().eq('id', requestId);
                if (error) {
                    console.error("Decline follow request failed:", error);
                    showAlertBanner('Request decline nahi ho paayi — dobara try karo.', 'error');
                    return;
                }
                await fetchAllData();
                renderFollowRequests();
                renderNotificationsList(); // FEATURE: NOTIFICATIONS
            } catch (err) {
                console.error("Decline follow request failed:", err);
                showAlertBanner('Request decline nahi ho paayi — dobara try karo.', 'error');
            }
        }

        // =====================================================================================
        // FEATURE: PUBLIC/PRIVATE GROUPS & CHANNELS — join requests
        // Public groups/channels: joining inserts into group_members directly, no approval needed.
        // Private groups/channels: joining inserts into group_join_requests instead; only once the
        // group's admin approves does a matching group_members row get created.
        // =====================================================================================
        function isGroupMember(groupId, username) {
            return globalGroupMembersCache.some(m => String(m.group_id) === String(groupId) && m.username === username);
        }

        function hasPendingGroupJoinRequest(groupId, username) {
            return globalGroupJoinRequestsCache.some(r => String(r.group_id) === String(groupId) && r.username === username);
        }

        function openGroupChatFromProfile(groupId) {
            closeProfileModal();
            switchTab('groups');
            openGroupChat(groupId);
        }

        // Called from the new "Groups" tab on a profile — Join for public groups/channels,
        // Request for private ones.
        async function joinOrRequestGroup(groupId) {
            const group = globalGroupsCache.find(g => String(g.id) === String(groupId));
            if (!group) return;

            if (isGroupMember(groupId, currentUser)) { openGroupChatFromProfile(groupId); return; }

            if (group.is_private) {
                if (hasPendingGroupJoinRequest(groupId, currentUser)) {
                    showAlertBanner('Request pehle se pending hai — admin ke accept karne ka wait karo.', 'warning');
                    return;
                }
                try {
                    const { error } = await supabaseClient.from('group_join_requests').insert({ group_id: groupId, username: currentUser });
                    if (error) throw error;
                    globalGroupJoinRequestsCache.push({ group_id: groupId, username: currentUser });
                    showAlertBanner(`"${group.name}" ke liye join request bhej di gayi — admin accept karega tab add hoge.`, 'success');
                    renderProfileGroupsList();
                } catch (err) {
                    console.error("Group join request failed (did you run the group_join_requests migration?):", err);
                    showAlertBanner("Private group join karne ke liye ek chhoti si SQL setup baaki hai ('group_join_requests' table).", 'error');
                }
            } else {
                try {
                    const { error } = await supabaseClient.from('group_members').insert({ group_id: groupId, username: currentUser });
                    if (error) throw error;
                    globalGroupMembersCache.push({ group_id: groupId, username: currentUser });
                    showAlertBanner(`Aap "${group.name}" me join ho gaye!`, 'success');
                    await fetchAllData();
                    renderProfileGroupsList();
                } catch (err) {
                    console.error('Join group failed:', err);
                    showAlertBanner('Group join nahi ho paaya — dobara try karo.', 'error');
                }
            }
        }

        function updateGroupJoinRequestsBadge() {
            const bell = document.getElementById('groupJoinRequestsBellBtn');
            const badge = document.getElementById('groupJoinRequestsBadge');
            if (!bell || !badge) return;
            const myGroupIds = new Set(globalGroupsCache.filter(g => g.created_by === currentUser).map(g => g.id));
            const pending = globalGroupJoinRequestsCache.filter(r => myGroupIds.has(r.group_id));

            if (pending.length === 0) {
                bell.classList.add('hidden');
                badge.classList.add('hidden');
                return;
            }
            bell.classList.remove('hidden');
            badge.classList.remove('hidden');
            badge.innerText = pending.length;
        }

        function openGroupJoinRequestsModal() {
            renderGroupJoinRequests();
            document.getElementById('groupJoinRequestsModal').classList.remove('hidden');
        }

        function closeGroupJoinRequestsModal() {
            document.getElementById('groupJoinRequestsModal').classList.add('hidden');
        }

        function renderGroupJoinRequests() {
            const container = document.getElementById('groupJoinRequestsContainer');
            if (!container) return;
            const myGroupIds = new Set(globalGroupsCache.filter(g => g.created_by === currentUser).map(g => g.id));
            const pending = globalGroupJoinRequestsCache.filter(r => myGroupIds.has(r.group_id));

            if (pending.length === 0) {
                container.innerHTML = `<p class="text-center text-xs text-slate-400 py-6">Koi pending group join request nahi hai.</p>`;
                return;
            }

            container.innerHTML = pending.map(r => {
                const group = globalGroupsCache.find(g => g.id === r.group_id);
                const av = globalProfilesCache[r.username];
                return `
                    <div class="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl p-2.5">
                        <div class="flex items-center space-x-2 min-w-0">
                            <div onclick="handleUserClick('${r.username}')" class="w-8 h-8 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white overflow-hidden cursor-pointer shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : r.username.charAt(0).toUpperCase()}</div>
                            <div class="min-w-0">
                                <p class="text-xs font-bold text-slate-200 truncate">${r.username}</p>
                                <p class="text-[11px] text-slate-400 truncate">wants to join "${group ? group.name : 'Group'}"</p>
                            </div>
                        </div>
                        <div class="flex gap-1.5 shrink-0">
                            <button onclick="approveGroupJoinRequest('${r.id}', '${r.group_id}', '${r.username}')" class="bg-[#2563eb] hover:bg-[#2563eb] text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition">Accept</button>
                            <button onclick="declineGroupJoinRequest('${r.id}')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition">Decline</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function approveGroupJoinRequest(requestId, groupId, username) {
            try {
                const { error: insertErr } = await supabaseClient.from('group_members').insert({ group_id: groupId, username });
                if (insertErr) throw insertErr;
                await supabaseClient.from('group_join_requests').delete().eq('id', requestId);
                await fetchAllData();
                renderGroupJoinRequests();
                showAlertBanner(`${username} ko group me add kar diya gaya.`, 'success');
            } catch (err) {
                console.error('Approve group join request failed:', err);
                showAlertBanner('Request accept nahi ho payi — dobara try karo.', 'error');
            }
        }

        async function declineGroupJoinRequest(requestId) {
            try {
                const { error } = await supabaseClient.from('group_join_requests').delete().eq('id', requestId);
                if (error) throw error;
                await fetchAllData();
                renderGroupJoinRequests();
            } catch (err) {
                console.error('Decline group join request failed:', err);
                showAlertBanner('Request decline nahi ho payi — dobara try karo.', 'error');
            }
        }

        // =====================================================================================
        // FEATURE: PROFILE GROUPS/CHANNELS TAB — shows the groups & channels a profile is part of,
        // right next to Posts/Reels/Twits, with a direct Join / Request-to-Join action.
        // =====================================================================================
        function renderProfileGroupsList() {
            const container = document.getElementById('profileGroupsListContainer');
            if (!container) return;
            const username = viewingProfileUsername;
            if (!username) return;

            const memberGroupIds = new Set(globalGroupMembersCache.filter(m => m.username === username).map(m => String(m.group_id)));
            const theirGroups = globalGroupsCache.filter(g => memberGroupIds.has(String(g.id)));

            if (theirGroups.length === 0) {
                container.innerHTML = `<div class="text-center py-10 text-xs text-slate-400">${username === currentUser ? 'Aapne abhi tak koi group ya channel nahi banaya/join kiya.' : `${username} ka koi group ya channel nahi mila.`}</div>`;
                return;
            }

            container.innerHTML = theirGroups.map(g => {
                const memberCount = globalGroupMembersCache.filter(m => String(m.group_id) === String(g.id)).length;
                const iAmMember = isGroupMember(g.id, currentUser);
                const requested = hasPendingGroupJoinRequest(g.id, currentUser);
                let actionBtn;
                if (iAmMember) {
                    actionBtn = `<button onclick="event.stopPropagation(); openGroupChatFromProfile('${g.id}')" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold px-3 py-1.5 rounded-lg transition shrink-0">Open</button>`;
                } else if (requested) {
                    actionBtn = `<button disabled class="bg-slate-800 text-slate-400 text-[11px] font-bold px-3 py-1.5 rounded-lg shrink-0 cursor-not-allowed">Requested</button>`;
                } else {
                    actionBtn = `<button onclick="event.stopPropagation(); joinOrRequestGroup('${g.id}')" class="bg-[#2563eb] hover:bg-[#2563eb] text-white text-[11px] font-bold px-3 py-1.5 rounded-lg transition shrink-0">${g.is_private ? 'Request' : 'Join'}</button>`;
                }
                return `
                    <div class="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800">
                        <div class="w-9 h-9 rounded-full bg-[#334155] flex items-center justify-center text-xs text-white shadow shrink-0"><i class="fa-solid ${g.is_channel ? 'fa-bullhorn' : 'fa-users'}"></i></div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-slate-200 truncate">${g.name} ${g.is_channel ? '<span class="text-[11px] font-bold text-[#60a5fa] bg-[#2563eb]/10 border border-[#3b82f6]/30 px-1.5 py-0.5 rounded-full ml-1">CHANNEL</span>' : ''} ${g.is_private ? '<span class="text-[11px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded-full ml-1"><i class="fa-solid fa-lock"></i></span>' : ''}</p>
                            <p class="text-[11px] text-slate-400">${memberCount} ${g.is_channel ? 'subscribers' : 'members'}</p>
                        </div>
                        ${actionBtn}
                    </div>
                `;
            }).join('');
        }

        // =====================================================================================
        // FEATURE: NOTIFICATIONS — an Instagram-style unified feed of who liked your posts, who
        // followed you, and pending follow requests (with inline accept/decline). Derived
        // entirely from existing caches — no new table needed.
        // =====================================================================================
        function notificationsSeenKey() { return `nexus_notif_seen_${currentUser}`; }

        function getUnseenNotificationCount() {
            const lastSeen = localStorage.getItem(notificationsSeenKey());
            const lastSeenTime = lastSeen ? new Date(lastSeen).getTime() : 0;
            const myPostIds = new Set(globalPostsCache.filter(p => p.username === currentUser).map(p => p.id));

            let count = 0;
            globalLikesCache.forEach(l => { if (myPostIds.has(l.post_id) && l.username !== currentUser && l.created_at && new Date(l.created_at).getTime() > lastSeenTime) count++; });
            globalFollowsCache.forEach(f => { if (f.following === currentUser && f.created_at && new Date(f.created_at).getTime() > lastSeenTime) count++; });
            count += globalFollowRequestsCache.filter(r => r.target === currentUser).length; // pending requests always count
            return count;
        }

        function updateNotificationsBadge() {
            const badge = document.getElementById('notificationsBadge');
            if (!badge) return;
            const count = getUnseenNotificationCount();
            if (count > 0) {
                badge.classList.remove('hidden');
                badge.innerText = count > 9 ? '9+' : count;
            } else {
                badge.classList.add('hidden');
            }
        }

        function openNotificationsModal() {
            renderNotificationsList();
            document.getElementById('notificationsModal').classList.remove('hidden');
            document.getElementById('notificationsModal').classList.add('flex');
            localStorage.setItem(notificationsSeenKey(), new Date().toISOString());
            updateNotificationsBadge();
        }

        function closeNotificationsModal() {
            document.getElementById('notificationsModal').classList.add('hidden');
            document.getElementById('notificationsModal').classList.remove('flex');
        }

        function renderNotificationsList() {
            const container = document.getElementById('notificationsListContainer');
            if (!container) return;
            const myPostIds = new Set(globalPostsCache.filter(p => p.username === currentUser).map(p => p.id));

            const likeEvents = globalLikesCache
                .filter(l => myPostIds.has(l.post_id) && l.username !== currentUser)
                .map(l => ({ type: 'like', username: l.username, postId: l.post_id, time: l.created_at || null }));

            const followEvents = globalFollowsCache
                .filter(f => f.following === currentUser)
                .map(f => ({ type: 'follow', username: f.follower, time: f.created_at || null }));

            const requestEvents = globalFollowRequestsCache
                .filter(r => r.target === currentUser)
                .map(r => ({ type: 'request', username: r.requester, requestId: r.id, time: r.created_at || null }));

            const all = [...requestEvents, ...likeEvents, ...followEvents]
                .sort((a, b) => (b.type === 'request') - (a.type === 'request') || new Date(b.time || 0) - new Date(a.time || 0));

            if (all.length === 0) {
                container.innerHTML = `<div class="text-center text-xs text-slate-400 py-14"><i class="fa-solid fa-bell-slash text-xl mb-2"></i><p>Koi notification abhi tak nahi hai.</p></div>`;
                return;
            }

            container.innerHTML = all.map(ev => {
                const avatar = globalProfilesCache[ev.username];
                const avatarHtml = avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : ev.username.charAt(0).toUpperCase();
                const timeLabel = ev.time ? formatMessageTimestamp(new Date(ev.time)) : '';

                if (ev.type === 'like') {
                    return `
                        <div onclick="closeNotificationsModal(); handleUserClick('${ev.username}')" class="flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-900/60 cursor-pointer transition">
                            <div class="w-9 h-9 rounded-full bg-[#334155] flex items-center justify-center font-bold text-xs text-white overflow-hidden shrink-0">${avatarHtml}</div>
                            <p class="flex-1 text-xs text-slate-300 min-w-0"><span class="font-bold text-slate-100">${ev.username}</span> ne tumhari post like ki <i class="fa-solid fa-heart text-[#60a5fa] ml-0.5"></i></p>
                            <span class="text-[11px] text-slate-400 shrink-0">${timeLabel}</span>
                        </div>`;
                } else if (ev.type === 'follow') {
                    return `
                        <div onclick="closeNotificationsModal(); handleUserClick('${ev.username}')" class="flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-900/60 cursor-pointer transition">
                            <div class="w-9 h-9 rounded-full bg-[#334155] flex items-center justify-center font-bold text-xs text-white overflow-hidden shrink-0">${avatarHtml}</div>
                            <p class="flex-1 text-xs text-slate-300 min-w-0"><span class="font-bold text-slate-100">${ev.username}</span> ne tumhe follow kiya <i class="fa-solid fa-user-plus text-[#38bdf8] ml-0.5"></i></p>
                            <span class="text-[11px] text-slate-400 shrink-0">${timeLabel}</span>
                        </div>`;
                } else {
                    return `
                        <div class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-900/40 border border-slate-800">
                            <div onclick="closeNotificationsModal(); handleUserClick('${ev.username}')" class="w-9 h-9 rounded-full bg-[#334155] flex items-center justify-center font-bold text-xs text-white overflow-hidden shrink-0 cursor-pointer">${avatarHtml}</div>
                            <p class="flex-1 text-xs text-slate-300 min-w-0"><span class="font-bold text-slate-100">${ev.username}</span> ne follow request bheji hai</p>
                            <div class="flex gap-1 shrink-0">
                                <button onclick="approveFollowRequest('${ev.requestId}', '${ev.username}')" class="px-2.5 py-1 rounded-lg bg-[#2563eb] text-white text-[11px] font-bold">Accept</button>
                                <button onclick="declineFollowRequest('${ev.requestId}')" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-[11px] font-bold">Decline</button>
                            </div>
                        </div>`;
                }
            }).join('');
        }

        // =====================================================================================
        // THEMES: exactly three — Dark, Light and Old Film (black & white TV look).
        // The header button cycles through them; the pencil opens a small picker.
        // =====================================================================================
        const THEME_CLASS_MAP = { dark: null, light: 'light-theme', film: 'film-theme' };
        const THEME_ORDER = ['dark', 'light', 'film'];
        const THEME_OPTIONS = [
            { key: 'dark', label: 'Dark', preview: '#0b0d10', ring: '#3a424d' },
            { key: 'light', label: 'Light', preview: '#f5f5f5', ring: '#c8c8c8' },
            { key: 'film', label: 'Old Film', preview: '#1b1b1b', ring: '#8a8a8a' }
        ];
        const THEME_ICONS = { dark: 'fa-moon', light: 'fa-sun', film: 'fa-film' };

        function normalizeTheme(t) { return THEME_CLASS_MAP.hasOwnProperty(t) ? t : 'dark'; }
        function currentThemeKey() {
            let t = null;
            try { t = localStorage.getItem('nexus_theme'); } catch (e) {}
            return normalizeTheme(t);
        }

        function applyTheme(theme) {
            theme = normalizeTheme(theme);
            const html = document.documentElement;
            Object.values(THEME_CLASS_MAP).forEach(cls => { if (cls) html.classList.remove(cls); });
            const cls = THEME_CLASS_MAP[theme];
            if (cls) html.classList.add(cls);
            html.classList.toggle('dark', theme !== 'light'); // keeps Tailwind's dark: variants working on the non-light themes
            const icon = document.getElementById('themeToggleIcon');
            if (icon) icon.className = 'fa-solid ' + THEME_ICONS[theme];
            const btn = document.getElementById('themeToggleBtn');
            if (btn) btn.title = 'Theme: ' + (THEME_OPTIONS.find(t => t.key === theme) || THEME_OPTIONS[0]).label + ' (tap to change)';
        }

        function toggleTheme() {
            const next = THEME_ORDER[(THEME_ORDER.indexOf(currentThemeKey()) + 1) % THEME_ORDER.length];
            try { localStorage.setItem('nexus_theme', next); } catch (e) {}
            applyTheme(next);
        }

        // Apply saved theme immediately; old saved themes (ocean/sunset/forest) fall back to Dark.
        // Also drop the per-page accent colours the old Customize Page feature saved.
        try {
            const saved = localStorage.getItem('nexus_theme');
            if (saved && !THEME_CLASS_MAP.hasOwnProperty(saved)) localStorage.setItem('nexus_theme', 'dark');
            Object.keys(localStorage).filter(k => k.startsWith('nexus_page_accent_')).forEach(k => localStorage.removeItem(k));
        } catch (e) {}
        applyTheme(currentThemeKey());

        // The pencil icon opens the theme picker. (customizingPageKey is only kept so that
        // "Reset" can also put that page's block order back to default.)
        let customizingPageKey = null;

        // Which element holds a page's reorderable blocks (used by the layout-reorder feature).
        function pageCustomizeElementId(key) {
            return key === 'profile' ? 'profileModalPanel' : 'section-' + key;
        }

        function openPageCustomizeForCurrentPage() {
            const profileModal = document.getElementById('profileModal');
            openPageCustomize(profileModal && !profileModal.classList.contains('hidden') ? 'profile' : currentTab);
        }
        window.openPageCustomizeForCurrentPage = openPageCustomizeForCurrentPage;

        function openPageCustomize(key) {
            customizingPageKey = key;
            const cur = currentThemeKey();
            document.getElementById('pageCustomizeThemes').innerHTML = THEME_OPTIONS.map(t => `
                <button onclick="applyThemeChoice('${t.key}')" class="flex flex-col items-center gap-1 shrink-0" aria-pressed="${cur === t.key}">
                    <span class="w-12 h-12 rounded-xl border-2 ${cur === t.key ? 'scale-105' : ''} transition flex items-center justify-center" style="background:${t.preview};border-color:${cur === t.key ? '#ffffff' : t.ring}">
                        <i class="fa-solid ${THEME_ICONS[t.key]}" style="color:${t.key === 'light' ? '#161616' : '#e6e6e6'}"></i>
                    </span>
                    <span class="text-[11px] font-bold ${cur === t.key ? 'text-white' : 'text-slate-400'}">${t.label}</span>
                </button>
            `).join('');
            document.getElementById('pageCustomizeModal').classList.remove('hidden');
            document.getElementById('pageCustomizeModal').classList.add('flex');
        }
        window.openPageCustomize = openPageCustomize;

        function applyThemeChoice(themeKey) {
            try { localStorage.setItem('nexus_theme', normalizeTheme(themeKey)); } catch (e) {}
            applyTheme(themeKey);
            if (customizingPageKey) openPageCustomize(customizingPageKey); // re-render so the picked theme shows selected
        }
        window.applyThemeChoice = applyThemeChoice;

        function resetPageCustomization() {
            if (customizingPageKey) resetLayoutOrder(customizingPageKey); // also undoes any block re-ordering
            try { localStorage.setItem('nexus_theme', 'dark'); } catch (e) {}
            applyTheme('dark');
            closePageCustomizeModal();
        }
        window.resetPageCustomization = resetPageCustomization;

        function closePageCustomizeModal() {
            document.getElementById('pageCustomizeModal').classList.add('hidden');
            document.getElementById('pageCustomizeModal').classList.remove('flex');
            customizingPageKey = null;
        }
        window.closePageCustomizeModal = closePageCustomizeModal;

        function applyAllSavedPageCustomizations() {
            applyLayoutOrder('feed'); // only Feed supports reordering for now
        }

        // =====================================================================================
        // FEATURE: LAYOUT REORDER — lets the user rearrange a page's fixed blocks (composer,
        // search, stories, etc.) up/down to their own preference. Only the STATIC blocks are
        // reorderable, not individual posts/messages inside a block (those regenerate on every
        // fetch, so a saved position for one of them wouldn't mean anything). Currently wired
        // up for Feed only; order is saved per-user per-page in localStorage.
        // =====================================================================================
        const DEFAULT_LAYOUT_ORDER = {
            feed: ['stories', 'search', 'postComposer', 'twitComposer', 'onThisDay', 'feedStream']
        };
        let layoutEditingPageKey = null;

        function layoutOrderStorageKey(pageKey) {
            return `nexus_layout_order_${currentUser}_${pageKey}`;
        }

        function applyLayoutOrder(pageKey) {
            if (!currentUser || !DEFAULT_LAYOUT_ORDER[pageKey]) return;
            const container = document.getElementById(pageCustomizeElementId(pageKey));
            if (!container) return;
            let order;
            try { order = JSON.parse(localStorage.getItem(layoutOrderStorageKey(pageKey))); } catch (e) { order = null; }
            if (!Array.isArray(order) || order.length === 0) return; // nothing saved — leave default markup order as-is
            order.forEach(blockId => {
                const block = container.querySelector(`:scope > .layout-block[data-block-id="${blockId}"]`);
                if (block) container.appendChild(block); // re-appending in saved order re-sorts the DOM
            });
        }

        function enterLayoutEditMode(pageKey) {
            if (!DEFAULT_LAYOUT_ORDER[pageKey]) {
                showAlertBanner('Is page ke liye layout reorder abhi available nahi hai.', 'info');
                return;
            }
            closePageCustomizeModal();
            layoutEditingPageKey = pageKey;
            const container = document.getElementById(pageCustomizeElementId(pageKey));
            if (!container) return;
            container.classList.add('layout-edit-mode');
            renderLayoutEditHandles(pageKey);
            showLayoutEditDoneBar();
        }
        window.enterLayoutEditMode = enterLayoutEditMode;

        function renderLayoutEditHandles(pageKey) {
            const container = document.getElementById(pageCustomizeElementId(pageKey));
            if (!container) return;
            const blocks = Array.from(container.querySelectorAll(':scope > .layout-block'));
            blocks.forEach((block, i) => {
                let handle = block.querySelector(':scope > .layout-drag-handle');
                if (!handle) {
                    handle = document.createElement('div');
                    handle.className = 'layout-drag-handle';
                    handle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;background:rgba(20,184,166,0.15);border:1px dashed #14b8a6;border-radius:10px;padding:6px 10px;margin-bottom:6px;font-size:10px;font-weight:bold;color:#c4b5fd;';
                    block.prepend(handle);
                }
                handle.innerHTML = `
                    <span><i class="fa-solid fa-up-down-left-right mr-1"></i>${block.dataset.blockId}</span>
                    <span class="flex gap-1.5">
                        <button type="button" ${i === 0 ? 'disabled' : ''} onclick="moveLayoutBlock('${pageKey}','${block.dataset.blockId}',-1)" class="w-6 h-6 rounded-lg bg-slate-800 ${i === 0 ? 'opacity-30' : 'hover:bg-slate-700'} text-slate-200 flex items-center justify-center"><i class="fa-solid fa-chevron-up"></i></button>
                        <button type="button" ${i === blocks.length - 1 ? 'disabled' : ''} onclick="moveLayoutBlock('${pageKey}','${block.dataset.blockId}',1)" class="w-6 h-6 rounded-lg bg-slate-800 ${i === blocks.length - 1 ? 'opacity-30' : 'hover:bg-slate-700'} text-slate-200 flex items-center justify-center"><i class="fa-solid fa-chevron-down"></i></button>
                    </span>
                `;
            });
        }

        function moveLayoutBlock(pageKey, blockId, direction) {
            const container = document.getElementById(pageCustomizeElementId(pageKey));
            if (!container) return;
            const block = container.querySelector(`:scope > .layout-block[data-block-id="${blockId}"]`);
            if (!block) return;
            if (direction < 0 && block.previousElementSibling) {
                container.insertBefore(block, block.previousElementSibling);
            } else if (direction > 0 && block.nextElementSibling) {
                container.insertBefore(block.nextElementSibling, block);
            }
            renderLayoutEditHandles(pageKey);
        }
        window.moveLayoutBlock = moveLayoutBlock;

        function showLayoutEditDoneBar() {
            let bar = document.getElementById('layoutEditDoneBar');
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'layoutEditDoneBar';
                bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:60;display:flex;gap:8px;padding:10px 14px;background:rgba(15,23,42,0.97);border-top:1px solid #334155;';
                bar.innerHTML = `
                    <button onclick="resetLayoutOrder(layoutEditingPageKey)" class="flex-1 bg-slate-800 hover:bg-slate-700 font-bold py-2.5 rounded-xl text-xs text-slate-200 transition"><i class="fa-solid fa-rotate-left mr-1"></i> Default Order</button>
                    <button onclick="exitLayoutEditMode()" class="flex-1 bg-[#2563eb] font-bold py-2.5 rounded-xl text-xs text-white shadow transition"><i class="fa-solid fa-check mr-1"></i> Done, Save</button>
                `;
                document.body.appendChild(bar);
            }
            bar.classList.remove('hidden');
        }

        function exitLayoutEditMode() {
            const pageKey = layoutEditingPageKey;
            if (!pageKey) return;
            const container = document.getElementById(pageCustomizeElementId(pageKey));
            if (container) {
                const order = Array.from(container.querySelectorAll(':scope > .layout-block')).map(b => b.dataset.blockId);
                localStorage.setItem(layoutOrderStorageKey(pageKey), JSON.stringify(order));
                container.classList.remove('layout-edit-mode');
                container.querySelectorAll(':scope > .layout-block > .layout-drag-handle').forEach(h => h.remove());
            }
            // BUGFIX: the bar's inline style="display:flex" always wins over the Tailwind
            // .hidden class (inline styles beat stylesheet rules regardless of specificity),
            // so classList.add('hidden') was silently doing nothing and the bar stayed stuck
            // on screen. Removing the element outright avoids that fight entirely.
            const bar = document.getElementById('layoutEditDoneBar');
            if (bar) bar.remove();
            layoutEditingPageKey = null;
            showAlertBanner('✅ Layout save ho gaya!', 'success');
        }
        window.exitLayoutEditMode = exitLayoutEditMode;

        function resetLayoutOrder(pageKey) {
            if (!pageKey || !DEFAULT_LAYOUT_ORDER[pageKey]) return;
            localStorage.removeItem(layoutOrderStorageKey(pageKey));
            const container = document.getElementById(pageCustomizeElementId(pageKey));
            if (container) {
                DEFAULT_LAYOUT_ORDER[pageKey].forEach(blockId => {
                    const block = container.querySelector(`:scope > .layout-block[data-block-id="${blockId}"]`);
                    if (block) container.appendChild(block);
                });
                if (layoutEditingPageKey === pageKey) renderLayoutEditHandles(pageKey);
            }
        }
        window.resetLayoutOrder = resetLayoutOrder;

        // =====================================================================================
        // FEATURE: POST ANALYTICS (views + reach on own posts)
        // =====================================================================================
        async function logPostView(postId) {
            if (ghostModeEnabled) return;
            if (trackedPostViewIds.has(postId)) return;
            trackedPostViewIds.add(postId);
            const post = globalPostsCache.find(p => String(p.id) === String(postId));
            if (!post) return;
            if (post.username === currentUser) return; // don't count your own views
            const canonicalId = post.id; // use the DB's own id type, not whatever the caller passed in

            try {
                // BUGFIX: was comparing v.post_id === postId without type coercion — Supabase's
                // numeric post_id vs. a string id passed in from an onclick="...('${post.id}')"
                // call never matched, so this always thought "not viewed yet" and Post Analytics
                // always showed 0 regardless of real activity.
                const alreadyViewed = globalPostViewsCache.some(v => String(v.post_id) === String(canonicalId) && v.viewer === currentUser);
                if (alreadyViewed) return;
                await supabaseClient.from('post_views').insert({ post_id: canonicalId, viewer: currentUser });
                globalPostViewsCache.push({ post_id: canonicalId, viewer: currentUser });
            } catch (err) {
                // Non-fatal - analytics migration may not be run yet
            }
        }

        function openPostAnalyticsModal(postId) {
            const post = globalPostsCache.find(p => String(p.id) === String(postId));
            if (!post) return;
            // BUGFIX: same id type mismatch as above — these three filters need the same
            // String() coercion as the `post` lookup line right above, or they silently return
            // zero results even when views/likes/comments genuinely exist for this post.
            const views = globalPostViewsCache.filter(v => String(v.post_id) === String(postId));
            const uniqueReach = new Set(views.map(v => v.viewer)).size;
            const likeCount = globalLikesCache.filter(l => String(l.post_id) === String(postId)).length;
            const commentCount = globalCommentsCache.filter(c => String(c.post_id) === String(postId)).length;

            document.getElementById('postAnalyticsContent').innerHTML = `
                <div class="grid grid-cols-2 gap-2.5">
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-emerald-400">${views.length}</p>
                        <p class="text-[11px] text-slate-400 tracking-wide">Views</p>
                    </div>
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-[#38bdf8]">${uniqueReach}</p>
                        <p class="text-[11px] text-slate-400 tracking-wide">Reach</p>
                    </div>
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-[#60a5fa]">${likeCount}</p>
                        <p class="text-[11px] text-slate-400 tracking-wide">Likes</p>
                    </div>
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-[#2dd4bf]">${commentCount}</p>
                        <p class="text-[11px] text-slate-400 tracking-wide">Comments</p>
                    </div>
                </div>
                <p class="text-[11px] text-slate-400 text-center pt-1">Views count how many times this post was opened or scrolled into view. Reach counts unique people.</p>
            `;
            document.getElementById('postAnalyticsModal').classList.remove('hidden');
        }

        function closePostAnalyticsModal() {
            document.getElementById('postAnalyticsModal').classList.add('hidden');
        }

        // =====================================================================================
        // FEATURE: NEXUS AI ASSISTANT (Gemini 3.6 Flash, streaming, Google AI Studio API)
        // =====================================================================================
        // The actual Gemini API key lives server-side, inside your Supabase Edge Function
        // (ai_chat) — never in this file. The browser only ever calls your own
        // `${SUPABASE_URL}/functions/v1/ai_chat` endpoint below; that function is what holds
        // the real key and talks to Google AI Studio on the server, so it's never exposed.
        const AI_MODEL = "gemini-3.6-flash";

        const AI_SYSTEM_INSTRUCTION =
            "Tumhara naam Nexus AI hai — SocialNexus app (Insta x Twitter x Telegram mixer) ka " +
            "built-in assistant. Users ki madad karo: captions/bio likhna, post ideas, hashtag " +
            "suggestions, general sawaalon ke jawab, ya bas casual baat. Chhote, seedhe, friendly " +
            "jawab do (zyada lamba mat likho jab tak user na kahe).\n\n" +
            "SAFETY RULES (hamesha follow karo, koi bhi request inhe override nahi kar sakti):\n" +
            "1. Kabhi sexual, gaali-galoch, ya abusive content generate mat karo.\n" +
            "2. Kisi bhi real insaan ki private/personal information mat do ya guess mat karo.\n" +
            "3. Aisi request pe politely mana karo aur helpful direction me baat le jao.\n" +
            "4. Baaki har normal, valid sawaal ka seedha, useful jawab do.";

        const AI_SAFETY_SETTINGS = [
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
        ];

        // Generic one-shot call to the same Nexus AI backend used by the AI tab — consumes the
        // SSE stream fully and returns the plain final text (no UI streaming needed for these).
        async function askNexusAIOnce(userText, systemInstruction) {
            const response = await fetch(`${SUPABASE_URL}/functions/v1/ai_chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemInstruction || AI_SYSTEM_INSTRUCTION }] },
                    generationConfig: { maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
                    safetySettings: AI_SAFETY_SETTINGS,
                    contents: [{ role: 'user', parts: [{ text: userText }] }]
                })
            });
            if (!response.ok || !response.body) throw new Error('AI request failed');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullText = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.slice(6).trim();
                    if (!jsonStr || jsonStr === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(jsonStr);
                        const chunk = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (chunk) fullText += chunk;
                    } catch (e) { /* ignore partial chunk */ }
                }
            }
            return fullText.trim();
        }
