        
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
        let messagePollingInterval = null;
        let selectedFileObject = null;
        let selectedFileObjects = []; // FEATURE: MULTI-IMAGE CAROUSEL POSTS — holds all files chosen for the current post
        let selectedChatMediaObject = null;
        let cachedAllUsers = [];
        let globalPostsCache = [];
        let globalProfilesCache = {};
        let globalProfilesFullCache = {}; // username -> full profile row (adds is_private support)
        let closeFriendsCache = new Set(); // FEATURE: CLOSE FRIENDS — usernames *this* user has marked as close friends
        let closeFriendsFeatureAvailable = true; // flips to false if the close_friends table isn't set up in Supabase yet
        let anonQuestionsCache = []; // FEATURE: ANONYMOUS Q&A
        let anonQaFeatureAvailable = true;
        let timeCapsulesCache = []; // FEATURE: TIME CAPSULE
        let timeCapsuleFeatureAvailable = true;

        // FEATURE: SILENT SUPPORT PING — anonymous, one-way "thinking of you" signal.
        // No likes/comments/DM semantics; receiver only ever sees a private aggregate count.
        let supportPingFeatureAvailable = true;
        let supportPingCountCache = {}; // username -> count (only ever fetched for the logged-in user's own profile)

        // FEATURE: PROFILE FLIP — flips the profile card to reveal newly-added features.
        let profileFlipped = false;

        // FEATURE: MULTI-PERSONA IDENTITY — one account, 3 independently-followable "faces"
        // (Post-persona, Twit-persona, Channel-persona), each with its own tone + bio.
        // Reuses the existing post "platform" field (Instagram/Twitter/Telegram) as the persona map.
        const PERSONAS = [
            { key: 'post', label: 'Post-Persona', emoji: '📸', platform: 'Instagram', color: '#ff4d8d' },
            { key: 'twit', label: 'Twit-Persona', emoji: '🐦', platform: 'Twitter', color: '#35c7ff' },
            { key: 'channel', label: 'Channel-Persona', emoji: '📢', platform: 'Telegram', color: '#9d7bff' }
        ];
        const PERSONA_TONE_PRESETS = ['Chill 😎', 'Funny 😂', 'Professional 💼', 'Aesthetic ✨', 'Motivational 🔥', 'Savage 😈', 'Wholesome 🌸'];
        function personaForKey(key) { return PERSONAS.find(p => p.key === key) || PERSONAS[0]; }
        function personaKeyForPlatform(platform) {
            const p = PERSONAS.find(p => p.platform === platform);
            return p ? p.key : 'post'; // Reels/anything else default to the Post-persona face
        }
        let personaFollowAvailable = true; // flips to false if follows/follow_requests.persona column isn't set up yet
        let ghostModeEnabled = localStorage.getItem('nexus_ghost_mode') === '1'; // FEATURE: GHOST MODE — purely local, no read receipts/view tracking while on
        let reelSoundMuted = localStorage.getItem('nexus_reel_muted') !== '0'; // FEATURE: REEL SOUND TOGGLE — muted by default (like Instagram), remembers choice locally
        let lastSmartReplyTrigger = null; // FEATURE: AI SMART REPLIES — tracks last message id we generated chips for
        let globalFollowsCache = [];
        let globalLikesCache = [];
        let globalCommentsCache = [];
        let viewingProfileUsername = null;
        let profileActiveTab = 'posts';
        let activeModalPostId = null;
        let cropper = null;

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
        let revealSlowlyOptionEnabled = false; // FEATURE: REVERSE REVEAL STORY — upload-time toggle

        // FEATURE: HONEST USAGE MIRROR state
        let usageActiveTickInterval = null;
        let usageDwellObserver = null;
        let usageDwellEntryTimestamps = {};

        let globalGroupsCache = [];
        let globalBotsCache = []; // FEATURE: BOTS/AUTOMATION
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
        let globalPostViewsCache = [];
        let globalMessageRequestsCache = []; // FEATURE: MESSAGE REQUESTS — private account DM gate
        let replyingToCommentId = null;
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
            handlePlatformChange();

            // Request Browser Notification Permission on Load
            if ("Notification" in window && Notification.permission !== "granted") {
                Notification.requestPermission();
            }

            // Register Service Worker so notifications can be shown reliably even when
            // this tab is backgrounded/minimized (works while the browser/app process is running).
            // NOTE: true "closed app" push still requires a server-side push sender; this covers
            // the common "app open in background / installed as PWA" case.
            if ("serviceWorker" in navigator) {
                navigator.serviceWorker.register('sw.js').then(reg => {
                    swRegistration = reg;
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
                    signupBtn.className = 'flex-1 py-1.5 rounded-lg transition bg-gradient-to-r from-[#9d7bff] to-[#ff4d8d] text-white';
                    loginBtn.className = 'flex-1 py-1.5 rounded-lg transition text-slate-400';
                } else {
                    loginForm.classList.remove('hidden');
                    signupForm.classList.add('hidden');
                    loginBtn.className = 'flex-1 py-1.5 rounded-lg transition bg-gradient-to-r from-[#9d7bff] to-[#ff4d8d] text-white';
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
                const platform = document.getElementById('postPlatform').value;
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
                            const { error: uploadError } = await supabaseClient.storage
                                .from('media')
                                .upload(fileName, fileObj);

                            if (!uploadError) {
                                const { data: publicUrlData } = supabaseClient.storage
                                    .from('media')
                                    .getPublicUrl(fileName);
                                uploadedUrls.push(publicUrlData.publicUrl);
                            }
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

                // FEATURE: BOTS/AUTOMATION — if this chat partner is a bot, auto-generate its reply
                maybeTriggerBotReply(activeChatUser, text);
                // FEATURE: AI AUTO-REPLY WHEN AWAY — if this chat partner has Away Mode on
                maybeTriggerAwayAutoReply(activeChatUser, text);
            });

            // Sends a real-time typing broadcast to the active chat partner as the user types
            document.getElementById('chatInputText').addEventListener('input', () => {
                if (activeChatUser) sendTypingBroadcast();
            });
        });

        function handleChatMediaSelect(input) {
            if (input.files && input.files[0]) {
                selectedChatMediaObject = input.files[0];
                showAlertBanner(`Media attached: ${selectedChatMediaObject.name}. Now click send.`, 'info');
            }
        }

        function handlePlatformChange() {
            const select = document.getElementById('postPlatform');
            const platform = select.value;
            const grid = document.getElementById('postInputGrid');
            const wrapper = document.getElementById('imageUploadWrapper');

            const accent = platform === 'Instagram' ? '#ff4d8d' : platform === 'Telegram' ? '#9d7bff' : '#35c7ff';
            select.style.borderColor = accent;

            if (platform === 'Twitter') {
                grid.className = "grid grid-cols-1 gap-2";
                wrapper.classList.add('hidden');
                wrapper.classList.remove('flex');
                selectedFileObject = null;
                selectedFileObjects = [];
            } else {
                grid.className = "grid grid-cols-2 gap-2";
                wrapper.classList.remove('hidden');
                wrapper.classList.add('flex');
            }
        }

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
            startUsageActiveTracking(); // FEATURE: HONEST USAGE MIRROR
            
            await fetchAllData();
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
            supabaseClient.channel('public:messages_' + username).on('postgres_changes', { 
                event: 'INSERT', 
                schema: 'public', 
                table: 'messages',
                filter: `receiver=eq.${username}`
            }, payload => {
                const msg = payload.new;
                if (!msg) return;

                // 1. If currently inside this chat room, load direct messages
                if (activeChatUser && msg.sender === activeChatUser) {
                    loadDirectMessages(activeChatUser, true);
                }

                // 2. Trigger Real-Time Notification (In-App Banner Popup + System/Chrome Notification)
                triggerNewMessageNotification(msg);

                // 3. Reorder Chat Section list instantly so the sender's ID appears at the very top
                loadLoggedUsers();
            }).subscribe();

            supabaseClient.channel('public:messages_sent_' + username).on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'messages',
                filter: `sender=eq.${username}`
            }, () => {
                loadLoggedUsers();
            }).subscribe();

            supabaseClient.channel('public:all_changes').on('postgres_changes', { event: '*', schema: 'public' }, async (payload) => {
                // FEATURE: LIVE GLOBAL PULSE — piggybacks on this already-existing catch-all
                // channel instead of opening a second subscription, just to notice real 'posts'
                // inserts (from ANY user, not just people we follow) and pulse the radar.
                if (payload && payload.table === 'posts' && payload.eventType === 'INSERT' && payload.new) {
                    handleGlobalPulseEvent(payload.new);
                }
                await fetchAllData();
                if (viewingProfileUsername) openProfile(viewingProfileUsername, false);
                if (activeModalPostId) renderCommentModal(activeModalPostId);
            }).subscribe();
        }

        // Notification System Handler (In-App Banner + Background Chrome/System Notification)
        function triggerNewMessageNotification(msg) {
            const senderId = msg.sender;
            const messageText = msg.text || 'Sent an attachment';

            // A. Display In-App Notification Banner Pop-Up
            const container = document.getElementById('inAppNotificationContainer');
            if (container) {
                const banner = document.createElement('div');
                banner.className = "pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border border-[#ff4d8d]/40 rounded-2xl p-3 shadow-2xl flex items-center space-x-3 animate-slide-down cursor-pointer";
                const av = globalProfilesCache[senderId];
                banner.innerHTML = `
                    <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-xs text-white shrink-0 overflow-hidden shadow">
                        ${av ? `<img src="${av}" class="w-full h-full object-cover">` : senderId.charAt(0).toUpperCase()}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between items-center">
                            <h4 class="text-xs font-bold text-white truncate">${senderId}</h4>
                            <span class="text-[9px] text-[#ff4d8d] font-semibold">Just now</span>
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
            banner.className = "pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border border-[#9d7bff]/40 rounded-2xl p-2.5 shadow-2xl animate-slide-down text-xs text-slate-200";
            banner.innerHTML = `<p class="font-bold text-[#ff4d8d]">${title}</p><p class="text-slate-300 mt-0.5">${body}</p>`;
            container.appendChild(banner);
            setTimeout(() => { if (banner.parentNode) banner.remove(); }, 4000);
        }

        // Sundar in-app alert banner — replaces ugly native alert() popups everywhere in the app.
        // type: 'error' (red) | 'success' (green) | 'info' (purple, default) | 'warning' (amber)
        function showAlertBanner(message, type = 'error') {
            const container = document.getElementById('inAppNotificationContainer');
            if (!container) { console.warn('showAlertBanner: container missing, message was:', message); return; }

            const styles = {
                error: { border: 'border-red-500/40', icon: 'fa-circle-exclamation', iconColor: 'text-red-400' },
                success: { border: 'border-emerald-500/40', icon: 'fa-circle-check', iconColor: 'text-emerald-400' },
                info: { border: 'border-[#9d7bff]/40', icon: 'fa-circle-info', iconColor: 'text-[#9d7bff]' },
                warning: { border: 'border-amber-500/40', icon: 'fa-triangle-exclamation', iconColor: 'text-amber-400' },
            };
            const s = styles[type] || styles.error;

            const banner = document.createElement('div');
            banner.className = `pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border ${s.border} rounded-2xl p-3 shadow-2xl animate-slide-down text-xs text-slate-200 flex items-start gap-2.5`;
            banner.innerHTML = `
                <i class="fa-solid ${s.icon} ${s.iconColor} text-sm mt-0.5 shrink-0"></i>
                <p class="flex-1 leading-snug">${message}</p>
                <button class="text-slate-500 hover:text-white shrink-0 -mt-0.5" aria-label="Dismiss"><i class="fa-solid fa-xmark text-xs"></i></button>
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

        async function fetchAllData() {
            try {
                const { data: profiles } = await supabaseClient.from('profiles').select('*');
                if (profiles) {
                    globalProfilesCache = {};
                    globalProfilesFullCache = {};
                    profiles.forEach(p => { if(p.username) { globalProfilesCache[p.username] = p.avatar_url; globalProfilesFullCache[p.username] = p; } });
                }

                const { data: follows } = await supabaseClient.from('follows').select('*');
                globalFollowsCache = follows || [];

                const { data: posts } = await supabaseClient.from('posts').select('*').order('created_at', { ascending: false });
                globalPostsCache = posts || [];

                const { data: likes } = await supabaseClient.from('post_likes').select('*');
                globalLikesCache = likes || [];

                const { data: comments } = await supabaseClient.from('comments').select('*').order('created_at', { ascending: true });
                globalCommentsCache = comments || [];

                // --- New feature data: Stories, Groups, Reactions ---
                const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const { data: stories } = await supabaseClient.from('stories').select('*').gte('created_at', cutoff).order('created_at', { ascending: true });
                globalStoriesCache = stories || [];

                const { data: storyViews } = await supabaseClient.from('story_views').select('*');
                globalStoryViewsCache = storyViews || [];

                const { data: groups } = await supabaseClient.from('groups').select('*');
                globalGroupsCache = groups || [];

                const { data: groupMembers } = await supabaseClient.from('group_members').select('*');
                globalGroupMembersCache = groupMembers || [];

                const { data: reactions } = await supabaseClient.from('message_reactions').select('*');
                globalReactionsCache = reactions || [];

                // FEATURE: BOTS/AUTOMATION
                try { const { data: bots } = await supabaseClient.from('bots').select('*'); globalBotsCache = bots || []; } catch(e) { globalBotsCache = []; }

                // --- New feature data: Comment likes, Blocks, Follow Requests, Post Views ---
                try { const { data: cl } = await supabaseClient.from('comment_likes').select('*'); globalCommentLikesCache = cl || []; } catch(e) { globalCommentLikesCache = []; }
                try { const { data: bl } = await supabaseClient.from('blocked_users').select('*'); globalBlockedCache = bl || []; } catch(e) { globalBlockedCache = []; }
                try { const { data: fr } = await supabaseClient.from('follow_requests').select('*'); globalFollowRequestsCache = fr || []; } catch(e) { globalFollowRequestsCache = []; }
                try { const { data: pv } = await supabaseClient.from('post_views').select('*'); globalPostViewsCache = pv || []; } catch(e) { globalPostViewsCache = []; }
                // FEATURE: MESSAGE REQUESTS — private account DM gate (optional table; no-ops until SQL setup is run)
                try { const { data: mr } = await supabaseClient.from('message_requests').select('*'); globalMessageRequestsCache = mr || []; } catch(e) { globalMessageRequestsCache = []; }

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

                // FEATURE: ANONYMOUS Q&A — optional table
                try {
                    const { data: aq, error: aqErr } = await supabaseClient.from('anon_questions').select('*').order('created_at', { ascending: false });
                    if (aqErr) throw aqErr;
                    anonQuestionsCache = aq || [];
                    anonQaFeatureAvailable = true;
                } catch (e) {
                    anonQuestionsCache = [];
                    anonQaFeatureAvailable = false;
                }

                // FEATURE: TIME CAPSULE — optional table
                try {
                    const { data: tc, error: tcErr } = await supabaseClient.from('time_capsules').select('*')
                        .or(`from_username.eq.${currentUser},to_username.eq.${currentUser}`)
                        .order('unlock_at', { ascending: true });
                    if (tcErr) throw tcErr;
                    timeCapsulesCache = tc || [];
                    timeCapsuleFeatureAvailable = true;
                } catch (e) {
                    timeCapsulesCache = [];
                    timeCapsuleFeatureAvailable = false;
                }

                // FEATURE: SILENT SUPPORT PING — optional table. We only ever need our OWN
                // private received-count here; sender identity is never fetched for anyone.
                try {
                    const { error: spErr, count } = await supabaseClient.from('support_pings')
                        .select('id', { count: 'exact', head: true })
                        .eq('receiver_username', currentUser);
                    if (spErr) throw spErr;
                    supportPingCountCache[currentUser] = count || 0;
                    supportPingFeatureAvailable = true;
                } catch (e) {
                    supportPingFeatureAvailable = false;
                }

                detectAndNotifyNewActivity();

                renderFeed();
                renderReels();
                renderStoriesBar();
                renderGroupsList();
                renderExplore();
                renderSuggestedUsers();
                updateFollowRequestsBadge();
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
                ? `<i class="fa-solid fa-circle-check text-[#35c7ff]" title="Verified"></i>`
                : '';
        }

        // Small "Admin" pill shown next to NEXUS's username everywhere (profile, feed, search,
        // chat list, chat header) so the app's owner account is always clearly labeled.
        function adminBadgeHtml(username) {
            return username === NEXUS_ADMIN_USERNAME
                ? `<span class="text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-gradient-to-r from-[#9d7bff] to-[#ff4d8d] text-white shrink-0">Admin</span>`
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
                : "w-full bg-gradient-to-r from-[#35c7ff] to-[#9d7bff] font-bold py-2.5 rounded-xl text-xs text-white transition";
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
                container.innerHTML = `<p class="text-center text-xs text-slate-500 py-6">Koi pending message request nahi hai.</p>`;
                return;
            }

            container.innerHTML = pending.map(r => {
                const av = globalProfilesCache[r.requester];
                return `
                    <div class="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl p-2.5">
                        <div class="flex items-center space-x-2 min-w-0 cursor-pointer" onclick="closeMessageRequestsModal(); selectChatUser('${r.requester}', true)">
                            <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-xs text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : r.requester.charAt(0).toUpperCase()}</div>
                            <span class="text-xs font-bold text-slate-200 truncate">${r.requester}</span>
                        </div>
                        <div class="flex gap-1.5 shrink-0">
                            <button onclick="approveMessageRequest('${r.id}')" class="bg-[#ff4d8d] hover:bg-[#ff4d8d] text-white text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition">Accept</button>
                            <button onclick="declineMessageRequest('${r.id}', '${r.requester}')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition">Decline</button>
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
                    }
                });
                Object.keys(commentCounts).forEach(pid => {
                    const before = prevCommentsCount[pid] || 0;
                    if (commentCounts[pid] > before) {
                        showAppNotification('New Comment 💬', 'Someone commented on your post', null, () => switchTab('feed'));
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
                container.innerHTML = `<div class="text-center text-[11px] text-slate-500 py-4">No saved accounts yet.</div>`;
                return;
            }
            container.innerHTML = accounts.map(u => {
                const isActive = u === currentUser;
                const avatar = globalProfilesCache ? globalProfilesCache[u] : null;
                return `
                    <div class="flex items-center justify-between gap-2 p-2.5 rounded-xl ${isActive ? 'bg-[#ff4d8d]/15 border border-[#ff4d8d]/40' : 'bg-slate-900 border border-slate-800 hover:border-[#9d7bff]/50'} transition">
                        <div onclick="switchToAccount('${u}')" class="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer">
                            <div class="w-9 h-9 shrink-0 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-xs text-white overflow-hidden">
                                ${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}
                            </div>
                            <div class="min-w-0">
                                <p class="text-xs font-bold text-slate-200 truncate">${u}</p>
                                ${isActive ? '<p class="text-[9px] font-bold text-[#ff4d8d]">Active now</p>' : '<p class="text-[9px] text-slate-500"><i class="fa-solid fa-lock mr-1"></i>Tap to switch</p>'}
                            </div>
                        </div>
                        ${!isActive ? `<button onclick="removeSavedAccount('${u}')" class="text-slate-500 hover:text-red-400 text-xs shrink-0 p-1.5" title="Remove from list"><i class="fa-solid fa-xmark"></i></button>` : ''}
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

            ['feed', 'chat', 'reels', 'calls', 'groups', 'explore', 'ai'].forEach(t => {
                document.getElementById('section-' + t).classList.add('hidden');
                const btn = document.getElementById('tab-' + t);
                btn.className = "px-2 py-1 rounded-md text-[11px] font-bold fast-transition text-slate-400 hover:text-slate-200 shrink-0";
            });

            document.getElementById('section-' + tab).classList.remove('hidden');
            document.getElementById('tab-' + tab).className = "px-2 py-1 rounded-md text-[11px] font-bold fast-transition bg-gradient-to-r from-[#ff4d8d] to-[#9d7bff] text-white shadow shrink-0";
            
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
            } else if (tab === 'ai') {
                if(messagePollingInterval) clearInterval(messagePollingInterval);
                if (typeof initAiAssistant === 'function') initAiAssistant();
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
                const { data: profiles, error: profilesErr } = await supabaseClient.from('profiles').select('username');
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
                const { data: msgs } = await supabaseClient.from('messages').select('sender, receiver, created_at, text, read_at');
                unreadCountsBySender = {};
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
                        if (m.receiver === currentUser && m.sender !== currentUser && !m.read_at) {
                            unreadCountsBySender[m.sender] = (unreadCountsBySender[m.sender] || 0) + 1;
                        }
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
                container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">No users found.</div>`;
                return;
            }

            usersArray.forEach(username => {
                const avatarUrl = globalProfilesCache[username];
                const isOnline = onlineUsersSet.has(username);
                // FEATURE: MESSAGE REQUESTS — surface pending request state right in the chat list
                let reqLabel = '';
                if (isPendingIncomingRequest(username)) {
                    reqLabel = `<p class="text-[9px] font-bold text-[#ff4d8d]"><i class="fa-solid fa-envelope mr-1"></i>Message request</p>`;
                } else if (isPendingOutgoingRequest(username)) {
                    reqLabel = `<p class="text-[9px] text-slate-500 italic"><i class="fa-solid fa-clock mr-1"></i>Requested</p>`;
                }
                // FEATURE: UNREAD MESSAGE COUNT — small pill next to the sender's name showing
                // how many unread messages they've sent, e.g. "username [3]". Bold white text
                // for anyone with unread messages so the row stands out, like Instagram/WhatsApp.
                const unreadCount = unreadCountsBySender[username] || 0;
                const unreadBadgeHtml = unreadCount > 0
                    ? `<span class="ml-1 shrink-0 bg-[#ff4d8d] text-white text-[9px] font-bold rounded-full px-1.5 py-0.5 leading-none">${unreadCount > 99 ? '99+' : unreadCount}</span>`
                    : '';

                const item = document.createElement('div');
                item.className = `p-3 flex items-center space-x-3 cursor-pointer hover:bg-slate-800/60 fast-transition`;
                item.innerHTML = `
                    <div onclick="event.stopPropagation(); handleUserClick('${username}')" class="w-8 h-8 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-xs text-white shadow overflow-hidden relative">
                        ${avatarUrl ? `<img src="${avatarUrl}" class="w-full h-full object-cover">` : username.charAt(0).toUpperCase()}
                        ${isOnline ? `<span class="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 border border-slate-950"></span>` : ''}
                    </div>
                    <div class="flex-1 min-w-0" onclick="selectChatUser('${username}', true)">
                        <p class="text-xs font-bold ${unreadCount > 0 ? 'text-white' : 'text-slate-200'} truncate flex items-center gap-1">${username} ${verifiedBadgeHtml(username)} ${adminBadgeHtml(username)} ${unreadBadgeHtml}</p>
                        ${reqLabel || `<p class="text-[10px] ${isOnline ? 'text-emerald-400' : 'text-slate-500'} flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-slate-600'} inline-block"></span> ${isOnline ? 'Online' : 'Offline'}</p>`}
                    </div>
                    <button onclick="event.stopPropagation(); openDeleteChatModal('${username}')" title="Delete Chat" class="text-slate-600 hover:text-red-400 p-1.5 shrink-0"><i class="fa-solid fa-trash text-xs"></i></button>
                    <i class="fa-solid fa-chevron-right text-xs text-slate-600"></i>
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
                container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">No users found for calls.</div>`;
                return;
            }

            container.innerHTML = users.map(u => {
                const av = globalProfilesCache[u];
                return `
                    <div class="glass-panel rounded-2xl p-3 flex items-center justify-between text-xs">
                        <div class="flex items-center space-x-2.5 cursor-pointer" onclick="openProfile('${u}')">
                            <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-xs text-white overflow-hidden shadow">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                            <span class="font-bold text-slate-200">${u}</span>
                        </div>
                        <div class="flex gap-1.5">
                            <button onclick="startRealCall('${u}', 'audio')" class="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1 shadow"><i class="fa-solid fa-phone"></i> Audio</button>
                            <button onclick="startRealCall('${u}', 'video')" class="bg-[#9d7bff] hover:bg-[#9d7bff] text-white px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1 shadow"><i class="fa-solid fa-video"></i> Video</button>
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

            const activeClass = "flex-1 py-1.5 rounded-xl text-[11px] font-bold transition bg-[#ff4d8d] text-white shadow";
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
            container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">Loading call history...</div>`;

            try {
                const { data: callLogs, error } = await supabaseClient
                    .from('calls')
                    .select('*')
                    .eq('status', 'offer')
                    .or(`caller_id.eq.${currentUser},callee_id.eq.${currentUser}`)
                    .order('created_at', { ascending: false })
                    .limit(50);

                if (error || !callLogs || callLogs.length === 0) {
                    container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">No call history yet.</div>`;
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
                                <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-xs text-white overflow-hidden shadow">${av ? `<img src="${av}" class="w-full h-full object-cover">` : (otherUser ? otherUser.charAt(0).toUpperCase() : '?')}</div>
                                <div>
                                    <p class="font-bold text-slate-200">${otherUser}</p>
                                    <p class="text-[10px] ${isOutgoing ? 'text-[#35c7ff]' : 'text-emerald-400'} flex items-center gap-1">
                                        <i class="fa-solid ${isOutgoing ? 'fa-arrow-up-right' : 'fa-arrow-down-left'}"></i>
                                        ${isOutgoing ? 'Outgoing' : 'Incoming'} · <i class="fa-solid ${typeIcon}"></i> ${log.call_type === 'video' ? 'Video' : 'Audio'}
                                    </p>
                                </div>
                            </div>
                            <div class="flex flex-col items-end gap-1.5">
                                <span class="text-[10px] text-slate-500">${timeLabel}</span>
                                <button onclick="startRealCall('${otherUser}', '${log.call_type}')" class="bg-slate-800 hover:bg-slate-700 text-white w-7 h-7 rounded-full flex items-center justify-center transition"><i class="fa-solid ${typeIcon} text-[10px]"></i></button>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                console.error(e);
                container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">Could not load call history.</div>`;
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
                dropdown.innerHTML = `<div class="p-3 text-xs text-slate-500 text-center">No results found</div>`;
                dropdown.classList.remove('hidden');
                return;
            }

            let html = '';

            if (userMatches.length > 0) {
                html += `<div class="px-2.5 pt-2 pb-1 text-[9px] font-bold tracking-wide text-slate-500">Users</div>`;
                userMatches.forEach(u => {
                    const av = globalProfilesCache[u];
                    html += `
                        <div onclick="handleUserClick('${u}'); ${closeDropdown}" class="p-2.5 flex items-center space-x-2.5 cursor-pointer hover:bg-slate-800/80 text-xs font-bold text-slate-200">
                            <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-[10px] text-white overflow-hidden">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                            <span class="flex items-center gap-1">${u} ${verifiedBadgeHtml(u)} ${adminBadgeHtml(u)} ${u === currentUser ? '(You)' : ''}</span>
                        </div>
                    `;
                });
            }

            if (hashtagMatches.length > 0) {
                html += `<div class="px-2.5 pt-2 pb-1 text-[9px] font-bold tracking-wide text-slate-500 border-t border-slate-800">Hashtags</div>`;
                hashtagMatches.slice(0, 8).forEach(tag => {
                    const count = globalPostsCache.filter(p => extractHashtags(p.content).includes(tag)).length;
                    html += `
                        <div onclick="jumpToExploreHashtag('${tag}'); ${closeDropdown}" class="p-2.5 flex items-center space-x-2.5 cursor-pointer hover:bg-slate-800/80 text-xs font-bold text-[#35c7ff]">
                            <div class="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-[10px]"><i class="fa-solid fa-hashtag"></i></div>
                            <span>${tag} <span class="text-slate-500 font-normal">· ${count} post${count === 1 ? '' : 's'}</span></span>
                        </div>
                    `;
                });
            }

            if (postMatches.length > 0) {
                html += `<div class="px-2.5 pt-2 pb-1 text-[9px] font-bold tracking-wide text-slate-500 border-t border-slate-800">Posts</div>`;
                postMatches.forEach(p => {
                    html += `
                        <div onclick="openPostDetailModal('${p.id}'); ${closeDropdown}" class="p-2.5 flex items-center space-x-2.5 cursor-pointer hover:bg-slate-800/80 text-xs text-slate-300">
                            <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-[10px] text-white overflow-hidden shrink-0">${globalProfilesCache[p.username] ? `<img src="${globalProfilesCache[p.username]}" class="w-full h-full object-cover">` : p.username.charAt(0).toUpperCase()}</div>
                            <span class="truncate"><span class="font-bold text-slate-200">${p.username}:</span> ${p.content}</span>
                        </div>
                    `;
                });
            }

            dropdown.innerHTML = html;
            dropdown.classList.remove('hidden');
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
            const isNewProfileView = viewingProfileUsername !== username;
            viewingProfileUsername = username;
            if (resetTab) profileActiveTab = 'posts';
            if (isNewProfileView) resetProfileFlipToFront();

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
                otherActions.classList.add('hidden');
                editAvatarBtn.classList.remove('hidden');
                editAvatarBtn.classList.add('flex');
                document.getElementById('editUsernameInput').value = currentUser;
                const myFull = globalProfilesFullCache[currentUser] || {};
                document.getElementById('moodTextInput').value = myFull.mood || '';
                selectMoodEmoji(myFull.mood_emoji || '😊');

                // Reflect current private-account state on the toggle switch
                renderPrivateAccountToggle();
                renderGhostModeToggle();
                renderAwayModeToggle();
                renderSecretAdmirer();
            } else {
                editSection.classList.add('hidden');
                otherActions.classList.remove('hidden');
                editAvatarBtn.classList.add('hidden');
                editAvatarBtn.classList.remove('flex');
                document.getElementById('secretAdmirerCard').classList.add('hidden');
                document.getElementById('secretAdmirerCard').classList.remove('flex');

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
                    verifyBtn.className = `w-full py-2 rounded-xl text-xs font-bold transition border flex items-center justify-center gap-1.5 ${verified ? 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700' : 'bg-[#35c7ff]/10 border-[#35c7ff]/40 text-[#35c7ff] hover:bg-[#35c7ff]/20'}`;
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

            // FEATURE: STREAKS — consecutive days with at least one post, computed purely
            // from existing post timestamps (no schema change needed).
            const streakBadge = document.getElementById('modalStreakBadge');
            if (!locked) {
                const streak = computePostStreak(userPostsAll);
                if (streak > 0) {
                    streakBadge.classList.remove('hidden');
                    streakBadge.classList.add('flex');
                    streakBadge.innerHTML = `<i class="fa-solid fa-fire"></i> ${streak} day${streak > 1 ? 's' : ''}`;
                } else {
                    streakBadge.classList.add('hidden');
                    streakBadge.classList.remove('flex');
                }
            } else {
                streakBadge.classList.add('hidden');
                streakBadge.classList.remove('flex');
            }

            // FEATURE: MOOD STATUS — reads profiles.mood / profiles.mood_emoji if that
            // column exists in this Supabase project; hides quietly if not set up yet.
            const moodBadge = document.getElementById('modalMoodBadge');
            const fullProfile = globalProfilesFullCache[username];
            if (!locked && fullProfile && fullProfile.mood) {
                moodBadge.classList.remove('hidden');
                moodBadge.innerText = `${fullProfile.mood_emoji || '💭'} ${fullProfile.mood}`;
            } else {
                moodBadge.classList.add('hidden');
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

            // FEATURE: CONTENT DNA FINGERPRINT mini badge — derived from their posts, so it
            // stays hidden for a locked private account same as the post grid does
            if (!locked) {
                renderDnaMiniBadge(username);
            } else {
                const dnaBadge = document.getElementById('dnaMiniBadge');
                if (dnaBadge) { dnaBadge.classList.add('hidden'); dnaBadge.classList.remove('flex'); }
            }

            renderPersonaHub(username, isMe);
            renderProfileGrid();
            renderAnonQaSection(username);
            if (profileFlipped && !locked) renderNewFeaturesPanel(username, isMe);
            document.getElementById('profileModal').classList.remove('hidden');
        }

        // =====================================================================================
        // FEATURE: PROFILE FLIP — flips the profile card (with a quick 3D animation) to reveal
        // the panel of newly-added features: Silent Support Ping + Content DNA Fingerprint.
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
                if (icon) icon.className = profileFlipped ? 'fa-solid fa-rotate-left text-xs text-[#ff4d8d]' : 'fa-solid fa-rotate text-xs';
                if (profileFlipped) renderNewFeaturesPanel(viewingProfileUsername, viewingProfileUsername === currentUser);

                card.style.transform = 'rotateY(-90deg)';
                requestAnimationFrame(() => { card.style.transform = 'rotateY(0deg)'; });
            }, 220);
        }

        function renderNewFeaturesPanel(username, isMe) {
            if (!username) return;
            renderLivePulseCard(username, isMe);
            renderAuraBattleCard(username, isMe);
            renderVibeCardFeature(username, isMe);
            renderSlowFollowCard(username, isMe);
            renderSilentSupportPingCard(username, isMe);
            renderContentDnaFingerprint(username);
            renderHonestUsageMirrorCard(isMe);
            renderAccountSecurityCard(isMe);
            renderBlockedUsersCard(isMe);
            renderDataExportCard(isMe);
            renderTrueDeleteCard(isMe);
            renderNexusUniverseCard(username, isMe);
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

            wrap.innerHTML = `<p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-user-slash text-red-400"></i> Blocked Users</p><p class="text-[9px] text-slate-500">Loading...</p>`;

            let blocked = [];
            try {
                const { data, error } = await supabaseClient.from('blocked_users').select('*').eq('blocker', currentUser);
                if (error) throw error;
                blocked = data || [];
            } catch (err) {
                console.error("renderBlockedUsersCard: blocked_users select failed:", err);
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-user-slash text-red-400"></i> Blocked Users</p>
                    <p class="text-[9px] text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>blocked_users table/RLS check karo Supabase me.</p>
                `;
                return;
            }

            if (blocked.length === 0) {
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-user-slash text-red-400"></i> Blocked Users</p>
                    <p class="text-[9px] text-slate-500">Aapne abhi tak kisi ko block nahi kiya.</p>
                `;
                return;
            }

            const rowsHtml = blocked.map(b => {
                const u = b.blocked;
                const av = globalProfilesCache[u];
                return `
                    <div class="flex items-center justify-between bg-slate-950/60 rounded-xl px-2.5 py-2 gap-2">
                        <div class="flex items-center gap-2 min-w-0 cursor-pointer" onclick="openProfile('${u}')">
                            <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-[10px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                            <span class="text-[11px] font-bold text-slate-200 truncate">${u}</span>
                        </div>
                        <button onclick="unblockUserFromCard('${u}')" class="shrink-0 bg-slate-800 hover:bg-emerald-600 text-emerald-400 hover:text-white text-[9px] font-bold px-2.5 py-1.5 rounded-lg transition"><i class="fa-solid fa-lock-open mr-1"></i>Unblock</button>
                    </div>
                `;
            }).join('');

            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-user-slash text-red-400"></i> Blocked Users (${blocked.length})</p>
                <div class="space-y-1.5 max-h-52 overflow-y-auto">${rowsHtml}</div>
            `;
        }

        // Unblock straight from the Blocked Users card — no confirm() popup needed since
        // unblocking is a harmless, reversible action (unlike blocking).
        async function unblockUserFromCard(username) {
            try {
                await supabaseClient.from('blocked_users').delete().eq('blocker', currentUser).eq('blocked', username);
                await fetchAllData();
                showAlertBanner(`${username} ko unblock kar diya.`, 'success');
                renderBlockedUsersCard(true);
            } catch (err) {
                console.error("unblockUserFromCard failed:", err);
                showAlertBanner('Unblock nahi ho paaya, dobara try karo.', 'error');
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

            wrap.innerHTML = `<p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-shield-halved text-[#9d7bff]"></i> Account Security</p><p class="text-[9px] text-slate-500">Loading...</p>`;

            const { data: profile, error } = await supabaseClient.from('profiles').select('two_factor_enabled, security_question').eq('username', currentUser).maybeSingle();
            if (error) {
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-shield-halved text-[#9d7bff]"></i> Account Security</p>
                    <p class="text-[9px] text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>2FA / Password reset ke liye ek chhoti si SQL setup baaki hai — upar comment me diye gaye ALTER TABLE statements Supabase me run karo.</p>
                `;
                return;
            }

            currentProfileSecurityInfo = profile || {};
            const twoFaOn = !!(profile && profile.two_factor_enabled);
            const hasSecurityQ = !!(profile && profile.security_question);

            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-shield-halved text-[#9d7bff]"></i> Account Security</p>
                <div class="flex items-center justify-between bg-slate-950/60 rounded-xl px-2.5 py-2">
                    <span class="text-[10px] text-slate-300">Two-Factor Authentication</span>
                    <span class="text-[9px] font-bold px-2 py-0.5 rounded-full ${twoFaOn ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/15 text-red-400 border border-red-500/30'}">${twoFaOn ? 'ON' : 'OFF'}</span>
                </div>
                <button onclick="openTwoFactorSetupModal()" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-2 rounded-xl text-xs text-[#9d7bff] transition"><i class="fa-solid fa-shield-halved mr-1"></i> ${twoFaOn ? 'Change 2FA PIN' : 'Set Up 2FA'}</button>
                <button onclick="openChangePasswordModal()" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-2 rounded-xl text-xs text-[#35c7ff] transition"><i class="fa-solid fa-key mr-1"></i> Change Password</button>
                ${!hasSecurityQ ? `<button onclick="openSecurityQuestionSetupModal()" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-2 rounded-xl text-xs text-slate-300 transition"><i class="fa-solid fa-circle-question mr-1"></i> Set Security Question (for password reset)</button>` : `<p class="text-[9px] text-slate-500 px-1"><i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>Security question set — password reset ready.</p>`}
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
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-file-export text-[#35c7ff]"></i> Data Export</p>
                <p class="text-[9px] text-slate-500">Apna saara data (posts, messages, stories, follows, comments) ek JSON file me download karo — True Delete se pehle ek achhi habit.</p>
                <button id="dataExportBtn" onclick="exportMyData()" class="w-full bg-slate-800 hover:bg-slate-700 border border-[#35c7ff]/30 font-bold py-2 rounded-xl text-xs text-[#35c7ff] transition"><i class="fa-solid fa-download mr-1"></i> Download My Data</button>
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
                    stories, storyViews, following, followers, blockedByMe, closeFriends, timeCapsulesSent, timeCapsulesReceived] = await Promise.all([
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
                    safe('time_capsules_sent', supabaseClient.from('time_capsules').select('*').eq('from_username', u)),
                    safe('time_capsules_received', supabaseClient.from('time_capsules').select('*').eq('to_username', u)),
                ]);

                const exportBundle = {
                    exported_at: new Date().toISOString(),
                    username: u,
                    note: 'Nexus data export — GDPR-style download of everything tied to this account. password_hash and two_factor_pin_hash are one-way hashes, not your real password/PIN.',
                    profile: (profile[0] ? { ...profile[0], password_hash: undefined, two_factor_pin_hash: undefined, security_answer_hash: undefined } : null),
                    posts, comments, comment_likes: commentLikes, post_likes: postLikes, post_views: postViews,
                    messages_sent: messagesSent, messages_received: messagesReceived,
                    stories, story_views: storyViews, following, followers,
                    blocked_by_me: blockedByMe, close_friends: closeFriends,
                    time_capsules_sent: timeCapsulesSent, time_capsules_received: timeCapsulesReceived
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
                wrap.innerHTML = `<p class="text-[10px] text-slate-500 text-center py-3">Koi user nahi mila.</p>`;
                return;
            }

            wrap.innerHTML = users.map(u => {
                const av = globalProfilesCache[u];
                return `
                    <div class="flex items-center gap-2 p-1.5 rounded-xl hover:bg-slate-900/60 transition">
                        <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-[10px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                        <span class="flex-1 text-xs font-bold text-slate-200 truncate">${u}</span>
                        <button onclick="shareToUserDM('${u}')" class="text-[10px] font-bold bg-[#35c7ff] hover:opacity-90 text-white px-3 py-1.5 rounded-lg transition">Send</button>
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
                    <stop offset="0%" stop-color="#9d7bff"/><stop offset="100%" stop-color="#ff4d8d"/>
                </linearGradient></defs>
                <rect width="600" height="800" fill="#0f0f1a"/>
                <rect width="600" height="800" fill="url(#g)" opacity="0.12"/>
                <text x="40" y="360" fill="#f1f1f4" font-family="sans-serif" font-size="24" font-weight="bold">${tspans}</text>
                <text x="40" y="750" fill="#ff4d8d" font-family="sans-serif" font-size="18" font-weight="bold">@${username}</text>
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

        // =====================================================================================
        // FEATURE: SLOW FOLLOW — following someone starts a private "growing" period instead of
        // an instant relationship. Grows fully in 7 days, or fast-tracks to 2 days if you
        // genuinely view (not skip) 3+ of their posts. Purely local/personal — doesn't touch or
        // replace the app's existing instant multi-persona follow system.
        // =====================================================================================
        function slowFollowStorageKey(following) { return `nexus_slowfollow_${currentUser}_${following}`; }

        function getSlowFollowState(following) {
            try {
                const raw = localStorage.getItem(slowFollowStorageKey(following));
                return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
        }

        function saveSlowFollowState(following, state) {
            localStorage.setItem(slowFollowStorageKey(following), JSON.stringify(state));
        }

        function countGenuineViews(username) {
            const targetPostIds = new Set(globalPostsCache.filter(p => p.username === username).map(p => p.id));
            if (targetPostIds.size === 0) return 0;
            return globalPostViewsCache.filter(v => v.viewer === currentUser && targetPostIds.has(v.post_id)).length;
        }

        function startSlowFollow(following) {
            if (!following || following === currentUser || getSlowFollowState(following)) return;
            saveSlowFollowState(following, { started_at: Date.now(), confirmed: false });
            renderSlowFollowCard(following, false);
            showInAppBanner('🌱 Growing', `${following} ke saath ek slow-follow relationship shuru ho gaya.`);
        }

        function renderSlowFollowCard(username, isMe) {
            const wrap = document.getElementById('slowFollowCard');
            if (!wrap) return;
            if (isMe || !username) { wrap.innerHTML = ''; return; }

            let state = getSlowFollowState(username);

            if (state && !state.confirmed) {
                const daysElapsed = (Date.now() - state.started_at) / (24 * 60 * 60 * 1000);
                const requiredDays = countGenuineViews(username) >= 3 ? 2 : 7;
                if (daysElapsed >= requiredDays) {
                    state.confirmed = true;
                    saveSlowFollowState(username, state);
                }
            }

            if (!state) {
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-seedling text-emerald-400"></i> Slow Follow</p>
                    <p class="text-[9px] text-slate-500">Instant follow ke bajaye ek relationship jo waqt maangta hai — 7 din mein grow hoti hai, ya jaldi agar tum genuinely inki posts dekho (skip nahi).</p>
                    <button onclick="startSlowFollow('${username}')" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-2 rounded-xl text-xs text-emerald-400 transition"><i class="fa-solid fa-seedling mr-1"></i> Start Growing</button>
                `;
                return;
            }

            const daysElapsed = (Date.now() - state.started_at) / (24 * 60 * 60 * 1000);
            const genuineViews = countGenuineViews(username);
            const fastTrack = genuineViews >= 3;
            const requiredDays = fastTrack ? 2 : 7;
            const progressPct = Math.min(100, Math.round((daysElapsed / requiredDays) * 100));
            const stageEmoji = state.confirmed ? '🌳' : (progressPct >= 50 ? '🌿' : '🌱');

            wrap.innerHTML = state.confirmed ? `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-seedling text-emerald-400"></i> Slow Follow</p>
                <p class="text-xs text-emerald-400 font-bold">🌳 Grown — ye connection ab pakka hai</p>
                <p class="text-[9px] text-slate-500">${daysElapsed.toFixed(1)} din mein grow hui, ${genuineViews} posts genuinely dekhne ke saath.</p>
            ` : `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-seedling text-emerald-400"></i> Slow Follow</p>
                <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-emerald-500 to-[#35c7ff] transition-all" style="width:${progressPct}%"></div>
                </div>
                <p class="text-xs text-slate-200">${stageEmoji} ${progressPct}% grown${fastTrack ? ' (fast-track — genuine views se)' : ''}</p>
                <p class="text-[9px] text-slate-500">${genuineViews} posts genuinely dekhi hain — 3+ dekhne se growth 7 din se ghatkar 2 din ho jaati hai.</p>
            `;
        }

        // =====================================================================================
        // FEATURE: SILENT SUPPORT PING — anonymous, one-way "thinking of you" signal.
        // No likes, no comments, no DM. Sender identity is never surfaced anywhere, including
        // to us — the receiver only ever sees a private aggregate count on their OWN profile.
        // =====================================================================================
        function renderSilentSupportPingCard(username, isMe) {
            const wrap = document.getElementById('silentSupportPingCard');
            if (!wrap) return;

            if (!supportPingFeatureAvailable) {
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center justify-center gap-1.5"><i class="fa-solid fa-wind text-[#35c7ff]"></i> Silent Support Ping</p>
                    <p class="text-[9px] text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Iske liye ek chhoti si SQL setup baaki hai (support_pings table) — ban jaane ke baad yeh feature turant kaam karega.</p>
                `;
                return;
            }

            if (isMe) {
                const count = supportPingCountCache[username] || 0;
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center justify-center gap-1.5"><i class="fa-solid fa-wind text-[#35c7ff]"></i> Silent Support Ping</p>
                    <p class="text-[9px] text-slate-500">Anonymous, one-way care signal — no likes, no comments, no DM. Sirf tumhe dikhta hai.</p>
                    <p class="text-sm text-slate-200 font-display font-bold pt-1">🫧 ${count} log tumhare baare me soch rahe hain</p>
                `;
            } else {
                const localKey = `nexus_ping_sent_${currentUser}_${username}`;
                const lastSent = parseInt(localStorage.getItem(localKey) || '0', 10);
                const onCooldown = lastSent && (Date.now() - lastSent) < 12 * 60 * 60 * 1000;
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center justify-center gap-1.5"><i class="fa-solid fa-wind text-[#35c7ff]"></i> Silent Support Ping</p>
                    <p class="text-[9px] text-slate-500">Bura din ho, exam ho, breakup ho — bina awkward comment likhe silently support bhejo. Kaun bheja pata nahi chalega.</p>
                    <button id="sendSupportPingBtn" onclick="sendSilentSupportPing('${username}')" ${onCooldown ? 'disabled' : ''} class="w-full font-bold py-2 rounded-xl text-xs shadow transition ${onCooldown ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-gradient-to-r from-[#35c7ff] to-[#9d7bff] text-white'}">
                        ${onCooldown ? '🫧 Bhej diya — thodi der baad phir se' : '🫧 Sending strength'}
                    </button>
                `;
            }
        }

        async function sendSilentSupportPing(receiverUsername) {
            if (!supportPingFeatureAvailable || !receiverUsername || receiverUsername === currentUser) return;
            const localKey = `nexus_ping_sent_${currentUser}_${receiverUsername}`;
            const lastSent = parseInt(localStorage.getItem(localKey) || '0', 10);
            if (lastSent && (Date.now() - lastSent) < 12 * 60 * 60 * 1000) return;

            try {
                const { error } = await supabaseClient.from('support_pings').insert({
                    sender_username: currentUser,
                    receiver_username: receiverUsername
                });
                if (error) throw error;
                localStorage.setItem(localKey, String(Date.now()));
                showInAppBanner('🫧 Sent', 'Silently bhej diya — non-transactional, non-public care signal.');
                renderSilentSupportPingCard(receiverUsername, false);
            } catch (e) {
                console.warn('Nexus: support_pings table not set up yet.', e);
                supportPingFeatureAvailable = false;
                renderSilentSupportPingCard(receiverUsername, false);
            }
        }

        // =====================================================================================
        // =====================================================================================
        // FEATURE: NEXUS VIBE CARD — an auto-generated, shareable "recap" card (Spotify-Wrapped
        // style) built entirely from the user's own real activity (posts, followers, streak,
        // posting habits). Meant to be shared to WhatsApp Status / Instagram Stories — the
        // branding + app link are baked directly into the image, so anyone who sees it in a
        // friend's story gets nudged to come download Nexus themselves. Fully client-side,
        // canvas-rendered, no schema needed.
        // =====================================================================================
        const VIBE_GENERIC_TITLES = ['Chaos Poster 🌀', 'Vibes Curator ✨', 'Low-Key Legend 🕶️', 'Serial Scroller 📱', 'Certified Nexus Native 🪐', 'Feed Whisperer 🍃'];

        function computeVibeCardStats(username) {
            const posts = globalPostsCache.filter(p => p.username === username);
            const followerCount = globalFollowsCache.filter(f => f.following === username).length;
            const followingCount = globalFollowsCache.filter(f => f.follower === username).length;
            const streak = posts.length ? computePostStreak(posts) : 0;
            const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
            let emojiCount = 0, totalLen = 0;
            const hourHist = new Array(24).fill(0);
            posts.forEach(p => {
                const content = p.content || '';
                totalLen += content.length;
                const m = content.match(emojiRegex);
                emojiCount += m ? m.length : 0;
                const d = new Date(p.created_at);
                if (!isNaN(d.getTime())) hourHist[d.getHours()]++;
            });
            const peakHour = posts.length ? hourHist.indexOf(Math.max(...hourHist)) : 12;

            const signature = `${username}|${posts.length}|${followerCount}|${followingCount}|${streak}|${emojiCount}|${peakHour}`;
            let hash = 0;
            for (let i = 0; i < signature.length; i++) hash = (Math.imul(hash, 31) + signature.charCodeAt(i)) | 0;
            hash = hash >>> 0;

            return { postsCount: posts.length, followerCount, followingCount, streak, emojiCount, peakHour, avgLen: posts.length ? totalLen / posts.length : 0, hash };
        }

        function pickVibeTitle(stats) {
            const pool = [];
            if (stats.peakHour >= 0 && stats.peakHour < 5) pool.push('Certified Night Owl 🦉');
            if (stats.streak >= 5) pool.push('Consistency Machine 🔥');
            if (stats.postsCount > 0 && stats.emojiCount > stats.postsCount * 2) pool.push('Emoji Overlord 😎');
            if (stats.followerCount > 5 && stats.followerCount > stats.followingCount * 2) pool.push('Certified Main Character 🌟');
            if (stats.postsCount === 0) pool.push('Silent Observer 👀');
            if (stats.avgLen > 150) pool.push('Storyteller Supreme 📖');
            const full = pool.length ? pool : VIBE_GENERIC_TITLES;
            return full[stats.hash % full.length];
        }

        function renderVibeCardFeature(username, isMe) {
            const wrap = document.getElementById('vibeCardCard');
            if (!wrap) return;
            const stats = computeVibeCardStats(username);
            const vibe = pickVibeTitle(stats);
            const initial = username.charAt(0).toUpperCase();
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center justify-center gap-1.5"><i class="fa-solid fa-wand-magic-sparkles text-[#ff4d8d]"></i> Nexus Vibe Card</p>
                <p class="text-[9px] text-slate-500">${username} ki apni real activity se generate hua ek shareable recap card — WhatsApp Status ya Instagram Story pe daal do.</p>
                <div class="rounded-2xl overflow-hidden p-4 space-y-2" style="background: linear-gradient(135deg, #1a0b2e, #2d0a3d 45%, #05050c); border:1px solid rgba(157,123,255,0.25);">
                    <div class="w-12 h-12 mx-auto rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-lg font-bold text-white shadow-lg">${initial}</div>
                    <p class="text-[13px] font-extrabold text-white">${vibe}</p>
                    <p class="text-[10px] text-slate-400">@${username}</p>
                    <div class="grid grid-cols-3 gap-1.5 pt-1">
                        <div class="bg-black/30 rounded-xl py-1.5"><p class="text-[13px] font-bold text-[#ff4d8d]">${stats.postsCount}</p><p class="text-[8px] text-slate-500">Posts</p></div>
                        <div class="bg-black/30 rounded-xl py-1.5"><p class="text-[13px] font-bold text-[#9d7bff]">${stats.followerCount}</p><p class="text-[8px] text-slate-500">Followers</p></div>
                        <div class="bg-black/30 rounded-xl py-1.5"><p class="text-[13px] font-bold text-[#35c7ff]">${stats.streak}</p><p class="text-[8px] text-slate-500">Day Streak</p></div>
                    </div>
                    <p class="text-[8px] text-slate-500 pt-1">📲 Made with SocialNexus</p>
                </div>
                <button onclick="shareVibeCard('${username}')" class="text-[9px] font-bold text-[#35c7ff] hover:text-[#9d7bff] transition"><i class="fa-solid fa-share-nodes mr-1"></i>Share Vibe Card</button>
            `;
        }

        function vibeRoundRect(ctx, x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }

        function vibeWrapText(ctx, text, x, y, maxWidth, lineHeight) {
            const words = text.split(' ');
            let line = '';
            const lines = [];
            for (let n = 0; n < words.length; n++) {
                const testLine = line + words[n] + ' ';
                if (ctx.measureText(testLine).width > maxWidth && n > 0) {
                    lines.push(line.trim());
                    line = words[n] + ' ';
                } else {
                    line = testLine;
                }
            }
            lines.push(line.trim());
            const totalH = lines.length * lineHeight;
            const startY = y - totalH / 2 + lineHeight / 2;
            lines.forEach((l, i) => ctx.fillText(l, x, startY + i * lineHeight));
        }

        function shareVibeCard(username) {
            const stats = computeVibeCardStats(username);
            const vibe = pickVibeTitle(stats);
            const canvas = document.createElement('canvas');
            canvas.width = 720; canvas.height = 1280; // 9:16 — drops straight into WhatsApp/IG Stories
            const ctx = canvas.getContext('2d');
            const cx = canvas.width / 2;

            const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            grad.addColorStop(0, '#1a0b2e');
            grad.addColorStop(0.5, '#2d0a3d');
            grad.addColorStop(1, '#05050c');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            [['#ff4d8d22', 150, 220], ['#9d7bff22', 570, 900], ['#35c7ff1a', 560, 300]].forEach(([c, x, y]) => {
                ctx.beginPath();
                ctx.fillStyle = c;
                ctx.arc(x, y, 200, 0, Math.PI * 2);
                ctx.fill();
            });

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const avatarGrad = ctx.createLinearGradient(cx - 70, 260, cx + 70, 400);
            avatarGrad.addColorStop(0, '#9d7bff');
            avatarGrad.addColorStop(1, '#ff4d8d');
            ctx.beginPath();
            ctx.fillStyle = avatarGrad;
            ctx.arc(cx, 330, 70, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 64px sans-serif';
            ctx.fillText(username.charAt(0).toUpperCase(), cx, 335);

            ctx.font = 'bold 34px sans-serif';
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText('@' + username, cx, 450);

            ctx.font = 'bold 52px sans-serif';
            ctx.fillStyle = '#ffffff';
            vibeWrapText(ctx, vibe, cx, 570, 620, 62);

            const statsData = [
                { label: 'POSTS', value: stats.postsCount, color: '#ff4d8d' },
                { label: 'FOLLOWERS', value: stats.followerCount, color: '#9d7bff' },
                { label: 'DAY STREAK', value: stats.streak, color: '#35c7ff' }
            ];
            const boxW = 180, boxGap = 30, startX = cx - (boxW * 3 + boxGap * 2) / 2;
            statsData.forEach((s, i) => {
                const x = startX + i * (boxW + boxGap);
                const y = 780;
                ctx.fillStyle = 'rgba(255,255,255,0.07)';
                vibeRoundRect(ctx, x, y, boxW, 160, 24);
                ctx.fill();
                ctx.fillStyle = s.color;
                ctx.font = 'bold 56px sans-serif';
                ctx.fillText(String(s.value), x + boxW / 2, y + 68);
                ctx.fillStyle = '#94a3b8';
                ctx.font = 'bold 20px sans-serif';
                ctx.fillText(s.label, x + boxW / 2, y + 122);
            });

            // Footer CTA — the part designed to actually drive downloads once this card gets
            // reposted onto someone else's WhatsApp Status / Instagram Story.
            ctx.font = 'bold 30px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.fillText('📲 Made with SocialNexus', cx, 1120);
            ctx.font = '24px sans-serif';
            ctx.fillStyle = '#35c7ff';
            ctx.fillText(window.location.origin.replace(/^https?:\/\//, ''), cx, 1165);
            ctx.font = '20px sans-serif';
            ctx.fillStyle = '#64748b';
            ctx.fillText('Join the app to see your own vibe', cx, 1200);

            canvas.toBlob(async (blob) => {
                if (!blob) return;
                const file = new File([blob], `${username}-nexus-vibe.png`, { type: 'image/png' });
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({ files: [file], title: 'My Nexus Vibe', text: `${vibe} — check my Nexus Vibe Card! 🔥` });
                        return;
                    } catch (e) { /* user cancelled share, fall through to download */ }
                }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${username}-nexus-vibe.png`;
                a.click();
            }, 'image/png');
        }

        // =====================================================================================
        // FEATURE: LIVE GLOBAL PULSE — an ambient real-time radar showing the whole Nexus user-
        // base posting live, right now, anywhere in the app. Every user gets a deterministic
        // pseudo-position on the radar (hashed from their username — no real location data is
        // ever collected or needed), so when ANY user's post lands, everyone with this panel
        // open sees a pulse fire in real time. Purely a vibe/ambient feature — never fabricates
        // activity that didn't happen.
        // =====================================================================================
        let recentPulseEvents = []; // small ring buffer so the panel isn't empty on open

        function pulseCoordsForUser(username) {
            const rand = mulberry32((username || '').split('').reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7) >>> 0);
            return { x: 10 + rand() * 180, y: 10 + rand() * 80 };
        }

        function renderLivePulseCard(username, isMe) {
            const wrap = document.getElementById('livePulseCard');
            if (!wrap) return;
            const dots = Array.from({ length: 22 }, (_, i) => {
                const r = mulberry32(i * 977 + 3);
                return `<circle cx="${(10 + r() * 180).toFixed(1)}" cy="${(10 + r() * 80).toFixed(1)}" r="1.1" fill="#9d7bff" opacity="0.25"/>`;
            }).join('');
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center justify-center gap-1.5"><i class="fa-solid fa-satellite-dish text-[#35c7ff]"></i> Live Global Pulse</p>
                <p class="text-[9px] text-slate-500">Nexus pe abhi, is second, jo bhi log real mein post kar rahe hain — unka live pulse.</p>
                <div class="rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 relative">
                    <svg id="livePulseSvg" viewBox="0 0 200 100" class="w-full h-28">
                        <rect width="200" height="100" fill="#050509"/>
                        <circle cx="100" cy="50" r="46" fill="none" stroke="#9d7bff" stroke-width="0.4" opacity="0.25"/>
                        <circle cx="100" cy="50" r="30" fill="none" stroke="#9d7bff" stroke-width="0.4" opacity="0.25"/>
                        <circle cx="100" cy="50" r="14" fill="none" stroke="#9d7bff" stroke-width="0.4" opacity="0.25"/>
                        ${dots}
                    </svg>
                </div>
                <div id="livePulseFeed" class="space-y-1 text-left max-h-16 overflow-y-auto"></div>
            `;
            renderPulseFeedList();
        }

        function renderPulseFeedList() {
            const feed = document.getElementById('livePulseFeed');
            if (!feed) return;
            if (!recentPulseEvents.length) {
                feed.innerHTML = `<p class="text-[9px] text-slate-600 text-center py-1">Koi live activity abhi nahi — jaise hi koi post karega, yahan dikhega.</p>`;
                return;
            }
            feed.innerHTML = recentPulseEvents.slice(0, 6).map(e =>
                `<p class="text-[9px] text-slate-500"><span class="text-[#35c7ff] font-bold">@${e.username}</span> just posted <span class="text-slate-600">· ${e.timeLabel}</span></p>`
            ).join('');
        }

        function spawnPulseOnMap(username) {
            const svg = document.getElementById('livePulseSvg');
            if (!svg) return; // panel isn't open right now — skip the animation, feed list still updates
            const { x, y } = pulseCoordsForUser(username);
            const ns = 'http://www.w3.org/2000/svg';
            const ring = document.createElementNS(ns, 'circle');
            ring.setAttribute('cx', x.toFixed(1));
            ring.setAttribute('cy', y.toFixed(1));
            ring.setAttribute('r', '1.5');
            ring.setAttribute('fill', 'none');
            ring.setAttribute('stroke', '#ff4d8d');
            ring.setAttribute('stroke-width', '1');
            ring.style.transition = 'r 1.4s ease-out, opacity 1.4s ease-out';
            ring.style.opacity = '1';
            svg.appendChild(ring);

            const dot = document.createElementNS(ns, 'circle');
            dot.setAttribute('cx', x.toFixed(1));
            dot.setAttribute('cy', y.toFixed(1));
            dot.setAttribute('r', '2');
            dot.setAttribute('fill', '#ff4d8d');
            svg.appendChild(dot);

            requestAnimationFrame(() => {
                ring.setAttribute('r', '18');
                ring.style.opacity = '0';
            });
            setTimeout(() => { ring.remove(); dot.remove(); }, 1500);
        }

        function handleGlobalPulseEvent(postRow) {
            const username = postRow.username;
            if (!username) return;
            recentPulseEvents.unshift({ username, timeLabel: 'abhi' });
            recentPulseEvents = recentPulseEvents.slice(0, 8);
            spawnPulseOnMap(username);
            renderPulseFeedList();
        }

        // =====================================================================================
        // FEATURE: NEXUS AURA BATTLE — head-to-head comparison of two users' Vibe Card stats.
        // Reuses computeVibeCardStats (already built for the Vibe Card) against any username in
        // the app, declares a winner per category + overall, and exports a shareable VS card —
        // same download-driving CTA baked into the image as the Vibe Card.
        // =====================================================================================
        function computeAuraScore(stats) {
            return Math.round(stats.postsCount * 2 + stats.followerCount * 3 + stats.streak * 4);
        }

        function renderAuraBattleCard(username, isMe) {
            const wrap = document.getElementById('auraBattleCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-bolt text-[#ff4d8d]"></i> Nexus Aura Battle</p>
                <p class="text-[9px] text-slate-500">Kisi bhi Nexus user ke against apna Aura Score battle karo — posts, followers aur streak ke basis pe.</p>
                <div class="flex gap-1.5">
                    <input type="text" id="auraBattleOpponentInput" placeholder="Opponent ka username..." class="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-2.5 py-1.5 text-[10px] text-white outline-none focus:border-[#ff4d8d]">
                    <button onclick="runAuraBattle('${username}')" class="bg-gradient-to-r from-[#ff4d8d] to-[#9d7bff] text-white text-[10px] font-bold px-3 py-1.5 rounded-xl">Battle</button>
                </div>
                <div id="auraBattleResult"></div>
            `;
        }

        function runAuraBattle(myUsername) {
            const input = document.getElementById('auraBattleOpponentInput');
            const resultBox = document.getElementById('auraBattleResult');
            const opponent = (input ? input.value : '').trim();
            if (!opponent) return;
            if (opponent === myUsername) {
                resultBox.innerHTML = `<p class="text-[9px] text-amber-400 text-center pt-1">Khud se battle nahi ho sakti 😅</p>`;
                return;
            }
            if (!globalProfilesFullCache[opponent]) {
                resultBox.innerHTML = `<p class="text-[9px] text-amber-400 text-center pt-1">"${opponent}" naam ka koi user nahi mila.</p>`;
                return;
            }

            const myStats = computeVibeCardStats(myUsername);
            const oppStats = computeVibeCardStats(opponent);
            const myScore = computeAuraScore(myStats);
            const oppScore = computeAuraScore(oppStats);
            const iWin = myScore >= oppScore;

            const rowsHtml = [
                ['Posts', myStats.postsCount, oppStats.postsCount],
                ['Followers', myStats.followerCount, oppStats.followerCount],
                ['Day Streak', myStats.streak, oppStats.streak]
            ].map(([label, a, b]) => `
                <div class="flex items-center justify-between text-[10px]">
                    <span class="font-bold ${a >= b ? 'text-[#ff4d8d]' : 'text-slate-500'}">${a}</span>
                    <span class="text-slate-600">${label}</span>
                    <span class="font-bold ${b >= a ? 'text-[#9d7bff]' : 'text-slate-500'}">${b}</span>
                </div>
            `).join('');

            resultBox.innerHTML = `
                <div class="rounded-2xl bg-slate-950 border border-slate-800 p-3 space-y-2 mt-1">
                    <div class="flex items-center justify-between text-[11px] font-bold">
                        <span class="text-[#ff4d8d]">@${myUsername} (${myScore})</span>
                        <span class="text-slate-500 text-[9px]">VS</span>
                        <span class="text-[#9d7bff]">@${opponent} (${oppScore})</span>
                    </div>
                    ${rowsHtml}
                    <p class="text-center text-[10px] font-bold ${iWin ? 'text-emerald-400' : 'text-amber-400'} pt-1">${iWin ? `@${myUsername} wins this Aura Battle 🏆` : `@${opponent} wins this Aura Battle 🏆`}</p>
                    <button onclick="shareAuraBattle('${myUsername}', '${opponent}')" class="w-full text-[9px] font-bold text-[#35c7ff] hover:text-[#9d7bff] transition text-center"><i class="fa-solid fa-share-nodes mr-1"></i>Share Battle Result</button>
                </div>
            `;
        }

        function shareAuraBattle(myUsername, opponent) {
            const myStats = computeVibeCardStats(myUsername);
            const oppStats = computeVibeCardStats(opponent);
            const myScore = computeAuraScore(myStats);
            const oppScore = computeAuraScore(oppStats);
            const iWin = myScore >= oppScore;

            const canvas = document.createElement('canvas');
            canvas.width = 720; canvas.height = 1280;
            const ctx = canvas.getContext('2d');
            const cx = canvas.width / 2;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            grad.addColorStop(0, '#1a0b2e');
            grad.addColorStop(0.5, '#2d0a3d');
            grad.addColorStop(1, '#05050c');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.font = 'bold 30px sans-serif';
            ctx.fillStyle = '#94a3b8';
            ctx.fillText('NEXUS AURA BATTLE', cx, 160);

            [{ u: myUsername, s: myScore, x: cx / 2, color: '#ff4d8d' }, { u: opponent, s: oppScore, x: cx + cx / 2, color: '#9d7bff' }].forEach(p => {
                const g = ctx.createLinearGradient(p.x - 70, 260, p.x + 70, 400);
                g.addColorStop(0, p.color); g.addColorStop(1, '#35c7ff');
                ctx.beginPath();
                ctx.fillStyle = g;
                ctx.arc(p.x, 340, 70, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 60px sans-serif';
                ctx.fillText(p.u.charAt(0).toUpperCase(), p.x, 345);
                ctx.font = 'bold 28px sans-serif';
                ctx.fillStyle = '#e2e8f0';
                ctx.fillText('@' + p.u, p.x, 450);
                ctx.font = 'bold 46px sans-serif';
                ctx.fillStyle = p.color;
                ctx.fillText(String(p.s), p.x, 510);
            });

            ctx.font = 'bold 40px sans-serif';
            ctx.fillStyle = '#64748b';
            ctx.fillText('VS', cx, 340);

            ctx.font = 'bold 40px sans-serif';
            ctx.fillStyle = '#34d399';
            ctx.fillText(`${iWin ? myUsername : opponent} wins 🏆`, cx, 640);

            ctx.font = 'bold 30px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.fillText('📲 Made with SocialNexus', cx, 1120);
            ctx.font = '24px sans-serif';
            ctx.fillStyle = '#35c7ff';
            ctx.fillText(window.location.origin.replace(/^https?:\/\//, ''), cx, 1165);
            ctx.font = '20px sans-serif';
            ctx.fillStyle = '#64748b';
            ctx.fillText('Battle your friends on Nexus', cx, 1200);

            canvas.toBlob(async (blob) => {
                if (!blob) return;
                const file = new File([blob], `${myUsername}-vs-${opponent}-aura-battle.png`, { type: 'image/png' });
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({ files: [file], title: 'Nexus Aura Battle', text: `${myUsername} vs ${opponent} — who's got the bigger Nexus aura? 🔥` });
                        return;
                    } catch (e) { /* user cancelled, fall through to download */ }
                }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${myUsername}-vs-${opponent}-aura-battle.png`;
                a.click();
            }, 'image/png');
        }

        // FEATURE: CONTENT DNA FINGERPRINT — generates a unique abstract "fingerprint" pattern
        // purely from a user's own post data (tone/length, timing, hashtags, emoji-usage,
        // activity pattern). Deterministic per-user, evolves as their posting habits change,
        // and never the same for two different data sets. Fully client-side, no schema needed.
        // =====================================================================================
        function mulberry32(seed) {
            return function () {
                seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        function computeContentDnaSignature(username) {
            const posts = globalPostsCache.filter(p => p.username === username);
            if (!posts.length) return null;

            const hourHist = new Array(24).fill(0);
            let hashtagCount = 0, emojiCount = 0, totalLen = 0;
            const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

            posts.forEach(p => {
                const d = new Date(p.created_at);
                if (!isNaN(d.getTime())) hourHist[d.getHours()]++;
                const content = p.content || '';
                totalLen += content.length;
                hashtagCount += extractHashtags(content).length;
                const matches = content.match(emojiRegex);
                emojiCount += matches ? matches.length : 0;
            });

            const avgLen = totalLen / posts.length;
            const peakHour = hourHist.indexOf(Math.max(...hourHist));
            const streak = computePostStreak(posts);

            const signature = `${username}|${posts.length}|${avgLen.toFixed(2)}|${hashtagCount}|${emojiCount}|${peakHour}|${streak}|${hourHist.join(',')}`;
            let hash = 0;
            for (let i = 0; i < signature.length; i++) {
                hash = (Math.imul(hash, 31) + signature.charCodeAt(i)) | 0;
            }
            hash = hash >>> 0;

            return { hash, postsCount: posts.length, avgLen, hashtagCount, emojiCount, peakHour, streak, hourHist };
        }

        function buildDnaSvg(dna) {
            const rand = mulberry32(dna.hash);
            const colors = ['#ff4d8d', '#9d7bff', '#35c7ff'];
            const numWaves = 3 + (dna.hashtagCount % 3);
            let paths = '';

            for (let w = 0; w < numWaves; w++) {
                const color = colors[w % colors.length];
                const amplitude = 6 + rand() * 16;
                const freq = 1 + Math.floor(rand() * 4);
                const phase = rand() * Math.PI * 2;
                const yBase = 14 + w * (62 / numWaves);
                let d = `M 0 ${yBase.toFixed(1)}`;
                for (let x = 0; x <= 120; x += 4) {
                    const hourWeight = dna.hourHist[Math.floor((x / 120) * 24)] || 0;
                    const y = yBase + Math.sin((x / 120) * Math.PI * 2 * freq + phase) * amplitude * (0.4 + hourWeight * 0.15);
                    d += ` L ${x} ${y.toFixed(1)}`;
                }
                paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${(1.2 + rand() * 1.6).toFixed(1)}" stroke-linecap="round" opacity="${(0.5 + rand() * 0.4).toFixed(2)}"/>`;
            }

            const dots = Math.min(14, dna.emojiCount + 3);
            let dotSvg = '';
            for (let i = 0; i < dots; i++) {
                const angle = (i / dots) * Math.PI * 2;
                const r = 26 + rand() * 12;
                const cx = 60 + Math.cos(angle) * r;
                const cy = 45 + Math.sin(angle) * r * 0.55;
                dotSvg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(1 + rand() * 2).toFixed(1)}" fill="${colors[i % colors.length]}" opacity="0.7"/>`;
            }

            return `<svg viewBox="0 0 120 90" class="w-full h-24" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="90" fill="#050509"/>${paths}${dotSvg}</svg>`;
        }

        function renderDnaMiniBadge(username) {
            const badge = document.getElementById('dnaMiniBadge');
            if (!badge) return;
            const dna = computeContentDnaSignature(username);
            if (!dna) { badge.classList.add('hidden'); badge.classList.remove('flex'); return; }
            const hex = (dna.hash % 0xFFFFFF).toString(16).padStart(6, '0');
            badge.classList.remove('hidden');
            badge.classList.add('flex');
            badge.innerHTML = `<span class="w-2 h-2 rounded-full inline-block" style="background:#${hex}"></span> DNA`;
        }

        function renderContentDnaFingerprint(username) {
            const wrap = document.getElementById('contentDnaCard');
            if (!wrap) return;
            const dna = computeContentDnaSignature(username);

            if (!dna) {
                wrap.innerHTML = `
                    <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-dna text-[#9d7bff]"></i> Content DNA Fingerprint</p>
                    <p class="text-[10px] text-slate-500 text-center py-3">Abhi koi post nahi hai — pehla post karte hi fingerprint ban jayega.</p>
                `;
                return;
            }

            const svg = buildDnaSvg(dna);
            const dnaCode = dna.hash.toString(16).toUpperCase().slice(0, 6);
            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-dna text-[#9d7bff]"></i> Content DNA Fingerprint</p>
                <p class="text-[9px] text-slate-500">${username} ke posts ke tone, timing, hashtags, emoji-usage aur activity pattern se generate hua — purely unka data, kabhi kisi se match nahi karega.</p>
                <div class="rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 p-2">${svg}</div>
                <div class="flex items-center justify-between pt-0.5">
                    <span class="text-[9px] text-slate-500 font-mono">DNA-${dnaCode}</span>
                    <button onclick="shareContentDna('${username}')" class="text-[9px] font-bold text-[#35c7ff] hover:text-[#9d7bff] transition"><i class="fa-solid fa-share-nodes mr-1"></i>Share</button>
                </div>
            `;
        }

        function shareContentDna(username) {
            const svgEl = document.querySelector('#contentDnaCard svg');
            if (!svgEl) return;
            const svgData = new XMLSerializer().serializeToString(svgEl);
            const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();
            img.onload = function () {
                const canvas = document.createElement('canvas');
                canvas.width = 480; canvas.height = 360;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#050509';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                canvas.toBlob(async (blob) => {
                    if (!blob) return;
                    const file = new File([blob], `${username}-content-dna.png`, { type: 'image/png' });
                    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                        try {
                            await navigator.share({ files: [file], title: `${username}'s Content DNA`, text: `${username} ka unique Content DNA fingerprint on Nexus 🧬` });
                            return;
                        } catch (e) { /* user cancelled share, fall through to download */ }
                    }
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${username}-content-dna.png`;
                    a.click();
                }, 'image/png');
            };
            img.src = url;
        }

        // =====================================================================================
        // FEATURE: HONEST USAGE MIRROR — a blunt, no-sugarcoating daily/weekly usage summary
        // (total time-in-app vs. genuine post-dwell time), plus an undismissable-for-5s nudge
        // once usage crosses a threshold. Purely local (per-device), no schema needed.
        // =====================================================================================
        function usageTodayKey() { return new Date().toISOString().split('T')[0]; }
        function usageStorageKey(dateKey) { return `nexus_usage_${currentUser}_${dateKey}`; }

        function getUsageStats(dateKey) {
            try {
                const raw = localStorage.getItem(usageStorageKey(dateKey));
                return raw ? JSON.parse(raw) : { activeSeconds: 0, dwellSeconds: 0 };
            } catch (e) { return { activeSeconds: 0, dwellSeconds: 0 }; }
        }

        function saveUsageStats(dateKey, stats) {
            localStorage.setItem(usageStorageKey(dateKey), JSON.stringify(stats));
        }

        function startUsageActiveTracking() {
            if (usageActiveTickInterval) return;
            usageActiveTickInterval = setInterval(() => {
                if (document.visibilityState === 'visible' && document.hasFocus()) {
                    addUsageActiveSeconds(5);
                }
            }, 5000);
        }

        function addUsageActiveSeconds(sec) {
            const key = usageTodayKey();
            const stats = getUsageStats(key);
            stats.activeSeconds = (stats.activeSeconds || 0) + sec;
            saveUsageStats(key, stats);
            maybeTriggerUsageNudge(stats);
        }

        function addUsageDwellSeconds(sec) {
            const key = usageTodayKey();
            const stats = getUsageStats(key);
            stats.dwellSeconds = (stats.dwellSeconds || 0) + sec;
            saveUsageStats(key, stats);
        }

        function getUsageDwellObserver() {
            if (usageDwellObserver) return usageDwellObserver;
            usageDwellObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const postId = entry.target.dataset.usagePostId;
                    if (!postId) return;
                    if (entry.isIntersecting) {
                        usageDwellEntryTimestamps[postId] = Date.now();
                    } else {
                        const enteredAt = usageDwellEntryTimestamps[postId];
                        if (enteredAt) {
                            const dwellMs = Date.now() - enteredAt;
                            if (dwellMs >= 1200) addUsageDwellSeconds(dwellMs / 1000); // ignore quick scroll-pasts
                            delete usageDwellEntryTimestamps[postId];
                        }
                    }
                });
            }, { threshold: 0.6 });
            return usageDwellObserver;
        }

        // Called right before a feed re-render clears the DOM, so any post that was mid-dwell
        // still gets credited instead of silently losing that time.
        function flushUsageDwellObserver() {
            if (usageDwellObserver) usageDwellObserver.disconnect();
            Object.keys(usageDwellEntryTimestamps).forEach(postId => {
                const dwellMs = Date.now() - usageDwellEntryTimestamps[postId];
                if (dwellMs >= 1200) addUsageDwellSeconds(dwellMs / 1000);
            });
            usageDwellEntryTimestamps = {};
            usageDwellObserver = null;
        }

        // Undismissable-for-5s nudge — fires once per threshold per day
        function maybeTriggerUsageNudge(stats) {
            const thresholds = [2700, 5400]; // 45 min, 90 min
            for (const t of thresholds) {
                const flag = `nudged_${t}`;
                if (stats.activeSeconds >= t && !stats[flag]) {
                    stats[flag] = true;
                    saveUsageStats(usageTodayKey(), stats);
                    showUsageNudgeModal(stats.activeSeconds);
                    break;
                }
            }
        }

        function showUsageNudgeModal(activeSeconds) {
            const modal = document.getElementById('usageNudgeModal');
            const text = document.getElementById('usageNudgeText');
            const btn = document.getElementById('usageNudgeCloseBtn');
            if (!modal || !text || !btn) return;
            const mins = Math.round(activeSeconds / 60);
            text.innerText = `Tumne aaj ${mins} minute se zyada scroll kar liya hai — thodi der real life mein bhi ruko.`;
            modal.classList.remove('hidden'); modal.classList.add('flex');
            btn.disabled = true;
            btn.className = 'w-full bg-slate-800 text-slate-500 font-bold py-2.5 rounded-xl text-xs cursor-not-allowed transition';

            let remaining = 5;
            btn.innerText = `Wait ${remaining}s...`;
            const timer = setInterval(() => {
                remaining--;
                if (remaining <= 0) {
                    clearInterval(timer);
                    btn.disabled = false;
                    btn.innerText = 'Theek hai, samajh gaya';
                    btn.className = 'w-full bg-gradient-to-r from-amber-500 to-[#ff4d8d] text-white font-bold py-2.5 rounded-xl text-xs transition';
                } else {
                    btn.innerText = `Wait ${remaining}s...`;
                }
            }, 1000);
        }

        function closeUsageNudgeModal() {
            document.getElementById('usageNudgeModal').classList.add('hidden');
            document.getElementById('usageNudgeModal').classList.remove('flex');
        }

        function renderHonestUsageMirrorCard(isMe) {
            const wrap = document.getElementById('honestUsageMirrorCard');
            if (!wrap) return;
            if (!isMe) { wrap.innerHTML = ''; return; }

            const today = getUsageStats(usageTodayKey());
            const activeMin = Math.round((today.activeSeconds || 0) / 60);
            const dwellMin = Math.round((today.dwellSeconds || 0) / 60);
            const mindlessMin = Math.max(0, activeMin - dwellMin);
            const mindlessPct = activeMin > 0 ? Math.round((mindlessMin / activeMin) * 100) : 0;

            let weekActiveSec = 0;
            for (let i = 0; i < 7; i++) {
                const d = new Date(); d.setDate(d.getDate() - i);
                weekActiveSec += (getUsageStats(d.toISOString().split('T')[0]).activeSeconds || 0);
            }
            const weekActiveHrs = (weekActiveSec / 3600).toFixed(1);

            wrap.innerHTML = `
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-hourglass-half text-amber-400"></i> Honest Usage Mirror</p>
                <p class="text-[9px] text-slate-500">No sugarcoating — app khud tumhe bataata hai, business-interest ke against.</p>
                ${activeMin > 0 ? `
                    <p class="text-xs text-slate-200">Aaj: <b>${activeMin} min</b> app khula, jisme se sirf <b class="text-emerald-400">${dwellMin} min</b> genuinely kisi post pe ruke.</p>
                    <p class="text-[10px] text-amber-400">${mindlessPct}% mindless scroll tha.</p>
                ` : `<p class="text-[10px] text-slate-500">Aaj abhi tak track karne layak usage nahi hui.</p>`}
                <p class="text-[9px] text-slate-500">Pichle 7 din: ${weekActiveHrs} ghante total.</p>
            `;
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
                <p class="text-[9px] text-slate-500">Koi 30-din wapasi nahi, koi hidden backup nahi — sirf ek genuine confirmation, phir sab kuch turant gone.</p>
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
                await safeDelete('bots you own', supabaseClient.from('bots').delete().eq('owner', u));

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
                    safeDelete('support pings sent', supabaseClient.from('support_pings').delete().eq('sender_username', u)),
                    safeDelete('support pings received', supabaseClient.from('support_pings').delete().eq('receiver_username', u)),
                    // NOTE: this is 'target_username', not 'to_username' — that's the actual
                    // column anon_questions uses (see askAnonQuestion).
                    safeDelete('anon questions to you', supabaseClient.from('anon_questions').delete().eq('target_username', u)),
                    safeDelete('time capsules sent', supabaseClient.from('time_capsules').delete().eq('from_username', u)),
                    safeDelete('time capsules received', supabaseClient.from('time_capsules').delete().eq('to_username', u)),
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
                <p class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><i class="fa-solid fa-meteor text-[#9d7bff]"></i> ${isMe ? 'Your' : username + "'s"} Nexus Universe</p>
                <p class="text-[9px] text-slate-500">Connections se banti ek generative 3D galaxy — har follower/following ek star, tumhare posts comets ki tarah.</p>
                <button onclick="openNexusUniverseModal('${username}')" class="w-full bg-gradient-to-r from-[#9d7bff] to-[#35c7ff] font-bold py-2 rounded-xl text-xs text-white shadow"><i class="fa-solid fa-meteor mr-1"></i> Open Universe</button>
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
            grad.addColorStop(0.4, 'rgba(157,123,255,0.5)');
            grad.addColorStop(1, 'rgba(157,123,255,0)');
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(center.sx, center.sy, 22 * center.scale, 0, Math.PI * 2); ctx.fill();

            // Comets (own posts) — small dim trail dots
            ctx.fillStyle = 'rgba(53,199,255,0.55)';
            data.comets.forEach(c => {
                const p = project(c.x, c.y, c.z);
                ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(0.6, 1.2 * p.scale), 0, Math.PI * 2); ctx.fill();
            });

            // Connection lines + stars, sorted back-to-front for correct overlap
            const projected = data.stars.map(s => ({ s, p: project(s.x, s.y, s.z) })).sort((a, b) => b.p.z2 - a.p.z2);

            projected.forEach(({ s, p }) => {
                ctx.strokeStyle = s.isMutual ? 'rgba(255,77,141,0.25)' : 'rgba(148,163,184,0.12)';
                ctx.lineWidth = 0.6;
                ctx.beginPath(); ctx.moveTo(center.sx, center.sy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
            });

            projected.forEach(({ s, p }) => {
                const r = Math.max(0.8, s.size * p.scale);
                const color = s.isMutual ? '255,77,141' : '53,199,255';
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

        // FEATURE: MULTI-PERSONA IDENTITY — renders the 3 face-cards (Post/Twit/Channel).
        // Own profile: editable tone + bio per face. Other profiles: bio + a follow button
        // scoped to just that one face, so people can follow a single persona, not the whole account.
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
                                <span class="text-[9px] text-slate-500 shrink-0">${faceFollowerCount} following this face</span>
                            </div>
                            <select id="personaToneInput-${p.key}" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[10px] text-slate-200 focus:outline-none focus:border-[#9d7bff]">
                                <option value="">Tone (select one)...</option>
                                ${toneOptions}
                            </select>
                            <textarea id="personaBioInput-${p.key}" rows="2" maxlength="150" placeholder="${p.label} bio..." class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[10px] text-slate-200 focus:outline-none focus:border-[#9d7bff] resize-none">${bio}</textarea>
                            <button onclick="savePersonaProfile('${p.key}')" class="w-full bg-slate-800 hover:bg-slate-700 font-bold py-1.5 rounded-lg text-[10px] text-slate-200 transition">Save ${p.label}</button>
                        </div>
                    `;
                }

                const isFollowingPersona = globalFollowsCache.some(f => f.follower === currentUser && f.following === username && f.persona === p.key);
                const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === username && r.persona === p.key);
                let btnLabel = 'Follow', btnClass = 'bg-[#ff4d8d] border-[#ff4d8d] text-white';
                if (isFollowingPersona) { btnLabel = 'Following'; btnClass = 'bg-slate-800 border-slate-700 text-slate-300'; }
                else if (hasPendingRequest) { btnLabel = 'Requested'; btnClass = 'bg-slate-800 border-slate-700 text-slate-500'; }

                if (locked) {
                    return `
                        <div class="bg-slate-900/60 rounded-xl p-2.5 space-y-1.5" style="border-left:3px solid ${p.color}">
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-xs font-bold text-slate-200">${p.emoji} ${p.label}</span>
                                <button ${hasPendingRequest ? 'disabled' : `onclick="togglePersonaFollow('${username}','${p.key}')"`} class="shrink-0 text-[10px] px-2.5 py-1 rounded-lg border font-bold transition ${btnClass}">${btnLabel}</button>
                            </div>
                            <p class="text-[9px] text-slate-500 italic"><i class="fa-solid fa-lock mr-1"></i>Follow to see bio</p>
                        </div>
                    `;
                }

                return `
                    <div class="bg-slate-900/60 rounded-xl p-2.5 space-y-1.5" style="border-left:3px solid ${p.color}">
                        <div class="flex items-center justify-between gap-2">
                            <div class="min-w-0 truncate">
                                <span class="text-xs font-bold text-slate-200">${p.emoji} ${p.label}</span>
                                ${tone ? `<span class="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-300">${tone}</span>` : ''}
                            </div>
                            <button ${hasPendingRequest ? 'disabled' : `onclick="togglePersonaFollow('${username}','${p.key}')"`} class="shrink-0 text-[10px] px-2.5 py-1 rounded-lg border font-bold transition ${btnClass}">${btnLabel}</button>
                        </div>
                        <p class="text-[10px] text-slate-400">${bio ? bio.replace(/</g, '&lt;') : `<span class="text-slate-600 italic">No bio for this face yet.</span>`}</p>
                        <p class="text-[9px] text-slate-500">${faceFollowerCount} following this face</p>
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
            if (!targetUser || targetUser === currentUser) return;
            const isFollowing = globalFollowsCache.some(f => f.follower === currentUser && f.following === targetUser && f.persona === personaKey);
            const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === targetUser && r.persona === personaKey);

            try {
                if (isFollowing) {
                    const { error } = await supabaseClient.from('follows').delete().eq('follower', currentUser).eq('following', targetUser).eq('persona', personaKey);
                    if (error) throw error;
                } else if (hasPendingRequest) {
                    return;
                } else if (isPrivateAndNotFollowing(targetUser)) {
                    const { error } = await supabaseClient.from('follow_requests').insert({ requester: currentUser, target: targetUser, persona: personaKey });
                    if (error) throw error;
                } else {
                    const { error } = await supabaseClient.from('follows').insert({ follower: currentUser, following: targetUser, persona: personaKey });
                    if (error) throw error;
                }
                personaFollowAvailable = true;
            } catch (e) {
                console.warn('Nexus: follows/follow_requests.persona column not set up yet (see Multi-Persona SQL setup).', e);
                personaFollowAvailable = false;
            }
            await fetchAllData();
            if (viewingProfileUsername) openProfile(viewingProfileUsername, false);
        }

        function renderCloseFriendToggle(username) {
            const btn = document.getElementById('closeFriendToggleBtn');
            if (!closeFriendsFeatureAvailable) {
                btn.innerHTML = `<i class="fa-solid fa-star"></i> Close Friends setup pending`;
                btn.className = "w-full flex items-center justify-center gap-1.5 text-[11px] font-bold py-1.5 rounded-xl border border-slate-800 text-slate-500 cursor-not-allowed";
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


        // =====================================================================================
        // FEATURE: ANONYMOUS Q&A
        // =====================================================================================
        function renderAnonQaSection(username) {
            const wrap = document.getElementById('anonQaSection');
            const isMe = username === currentUser;

            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — questions/answers are profile detail too
            if (!isMe && isPrivateAndNotFollowing(username)) {
                wrap.innerHTML = `<p class="text-[10px] text-slate-500 text-center py-1"><i class="fa-solid fa-lock mr-1"></i>Follow ${username} to see this.</p>`;
                return;
            }

            if (!anonQaFeatureAvailable) {
                wrap.innerHTML = `<p class="text-[9px] text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Anonymous Q&A ke liye ek chhoti si SQL setup baaki hai.</p>`;
                return;
            }

            const answered = anonQuestionsCache.filter(q => q.target_username === username && q.answer);
            let html = '';

            if (isMe) {
                const pending = anonQuestionsCache.filter(q => q.target_username === username && !q.answer);
                html += `<h2 class="text-[10px] font-bold tracking-wide text-slate-400 flex items-center gap-1.5"><i class="fa-solid fa-comments text-[#ff4d8d]"></i> Anonymous Questions ${pending.length ? `<span class="text-[#ff4d8d]">(${pending.length})</span>` : ''}</h2>`;
                if (pending.length === 0) {
                    html += `<p class="text-[10px] text-slate-500">Koi naya anonymous sawaal nahi hai abhi.</p>`;
                } else {
                    html += pending.map(q => `
                        <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-2.5 space-y-1.5">
                            <p class="text-xs text-slate-200">${(q.question || '').replace(/</g,'&lt;')}</p>
                            <div class="flex gap-1.5">
                                <input type="text" id="anonAnswerInput-${q.id}" placeholder="Public jawab likho..." class="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-[#ff4d8d]">
                                <button onclick="answerAnonQuestion('${q.id}')" class="shrink-0 bg-[#ff4d8d] px-2.5 py-1 rounded-lg text-[10px] font-bold text-white">Reply</button>
                                <button onclick="deleteAnonQuestion('${q.id}')" class="shrink-0 text-slate-500 hover:text-red-400 text-[11px] px-1" title="Delete"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                    `).join('');
                }
            } else {
                html += `<h2 class="text-[10px] font-bold tracking-wide text-slate-400 flex items-center gap-1.5"><i class="fa-solid fa-comments text-[#ff4d8d]"></i> Ask ${username} anonymously</h2>`;
                html += `
                    <div class="flex gap-1.5">
                        <input type="text" id="anonQuestionInput" maxlength="150" placeholder="Kuch bhi pucho, tumhara naam nahi dikhega..." class="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[#ff4d8d]">
                        <button onclick="askAnonQuestion('${username}')" class="shrink-0 bg-[#ff4d8d] px-3 py-1.5 rounded-xl text-[11px] font-bold text-white">Send</button>
                    </div>
                `;
            }

            if (answered.length > 0) {
                html += `<div class="pt-1.5 space-y-1.5">` + answered.slice(0, 8).map(q => `
                    <div class="bg-slate-900/40 border border-slate-800/70 rounded-xl p-2.5 space-y-1">
                        <p class="text-[10px] text-slate-500"><i class="fa-solid fa-user-secret mr-1"></i>Anonymous asked</p>
                        <p class="text-xs text-slate-300">${(q.question || '').replace(/</g,'&lt;')}</p>
                        <p class="text-xs text-slate-100 border-l-2 border-[#ff4d8d] pl-2">${(q.answer || '').replace(/</g,'&lt;')}</p>
                    </div>
                `).join('') + `</div>`;
            }

            wrap.innerHTML = html;
        }

        async function askAnonQuestion(targetUsername) {
            const input = document.getElementById('anonQuestionInput');
            const text = input.value.trim();
            if (!text) return;
            try {
                const { error } = await supabaseClient.from('anon_questions').insert({ target_username: targetUsername, question: text });
                if (error) throw error;
                input.value = '';
                await fetchAllData();
                renderAnonQaSection(targetUsername);
                showInAppBanner('✅ Sent', 'Tumhara anonymous sawaal bhej diya gaya.');
            } catch (e) {
                console.warn('Nexus: anon_questions table not set up yet.', e);
                anonQaFeatureAvailable = false;
                renderAnonQaSection(targetUsername);
            }
        }

        async function answerAnonQuestion(id) {
            const input = document.getElementById('anonAnswerInput-' + id);
            const text = input ? input.value.trim() : '';
            if (!text) return;
            await supabaseClient.from('anon_questions').update({ answer: text, answered_at: new Date().toISOString() }).eq('id', id);
            await fetchAllData();
            renderAnonQaSection(currentUser);
        }

        async function deleteAnonQuestion(id) {
            await supabaseClient.from('anon_questions').delete().eq('id', id);
            await fetchAllData();
            renderAnonQaSection(currentUser);
        }

        // =====================================================================================
        // FEATURE: VIBE MATCH — AI-estimated compatibility score based on shared chat history
        // =====================================================================================
        async function checkVibeMatch(targetUser) {
            if (!targetUser || targetUser === currentUser) return;
            const modal = document.getElementById('vibeMatchModal');
            const body = document.getElementById('vibeMatchBody');
            modal.classList.remove('hidden');
            body.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-2xl text-[#35c7ff]"></i>`;

            try {
                const { data: rawMessages } = await supabaseClient
                    .from('messages').select('*')
                    .or(`and(sender.eq.${currentUser},receiver.eq.${targetUser}),and(sender.eq.${targetUser},receiver.eq.${currentUser})`)
                    .order('created_at', { ascending: false }).limit(40);
                const recent = (rawMessages || []).reverse().filter(m => m.text);

                const prompt = recent.length > 0
                    ? `Yeh do dosto (Main aur ${targetUser}) ke beech ek chat transcript hai:\n${recent.map(m => `${m.sender === currentUser ? 'Main' : targetUser}: ${m.text}`).join('\n')}\n\nIsse ek fun, halka-fulka "vibe match %" (0-100 ke beech ek number) nikaalo based on energy/tone match, aur ek chhoti (max 15 shabd) mazedaar wajah do. Sirf JSON return karo: {"score": number, "reason": "..."}`
                    : `${currentUser} aur ${targetUser} ke beech abhi tak koi chat nahi hui hai. Ek random, fun "vibe match %" (40-90 ke beech) generate karo naye dosti ke liye, aur ek chhoti (max 15 shabd) chulbuli wajah do. Sirf JSON return karo: {"score": number, "reason": "..."}`;

                const raw = await askNexusAIOnce(prompt, "Tum ek fun 'vibe match' calculator ho ek social app ke liye. Sirf requested JSON object return karo, koi extra text nahi.");
                const match = raw.match(/\{[\s\S]*\}/);
                const result = match ? JSON.parse(match[0]) : { score: 60, reason: "Vibes are immeasurable ✨" };
                const score = Math.max(0, Math.min(100, parseInt(result.score) || 60));

                body.innerHTML = `
                    <div class="text-5xl font-display font-extrabold bg-gradient-to-r from-[#ff4d8d] via-[#9d7bff] to-[#35c7ff] bg-clip-text text-transparent">${score}%</div>
                    <p class="text-xs text-slate-300 mt-2">${currentUser} × ${targetUser}</p>
                    <p class="text-[11px] text-slate-400 mt-1.5 px-2">${(result.reason || '').replace(/</g,'&lt;')}</p>
                `;
            } catch (e) {
                // BUGFIX: this error was being swallowed with no logging at all, so a broken
                // AI call, a bad Supabase query, or a JSON parse failure all looked identical
                // to the user and were impossible to diagnose from the console.
                console.error("checkVibeMatch failed for target user:", targetUser, e);
                body.innerHTML = `<p class="text-xs text-slate-400">Vibe check abhi available nahi hai, thodi der baad try karo.</p>`;
            }
        }

        // =====================================================================================
        // FEATURE: NEXUS WRAPPED — AI-generated recap of the last 30 days
        // =====================================================================================
        async function generateNexusWrapped() {
            const modal = document.getElementById('wrappedModal');
            const body = document.getElementById('wrappedBody');
            modal.classList.remove('hidden');
            body.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-2xl"></i>`;

            try {
                const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
                const myPosts = globalPostsCache.filter(p => p.username === currentUser && new Date(p.created_at).getTime() >= cutoff);
                const myPostIds = new Set(myPosts.map(p => p.id));
                const likesReceived = globalLikesCache.filter(l => myPostIds.has(l.post_id)).length;
                const commentsReceived = globalCommentsCache.filter(c => myPostIds.has(c.post_id)).length;
                const newFollowers = globalFollowsCache.filter(f => f.following === currentUser).length;
                const streak = computePostStreak(globalPostsCache.filter(p => p.username === currentUser));

                const stats = `Posts: ${myPosts.length}, Likes received: ${likesReceived}, Comments received: ${commentsReceived}, Total followers: ${newFollowers}, Current streak: ${streak} din`;
                const prompt = `Yeh ${currentUser} ke pichle 30 din ke Nexus app stats hain: ${stats}.\n\nEk fun, hype-filled, casual Hinglish "Wrapped" style recap likho (jaise Spotify Wrapped) — 3-4 chhoti lines mein, emojis ke sath, thoda celebratory tone mein.`;
                const recap = await askNexusAIOnce(prompt, "Tum ek hype, fun 'yearly/monthly recap' generator ho, jaise Spotify Wrapped. Short, energetic, casual Hinglish, emojis zaroor use karo.");

                body.innerHTML = `
                    <div class="grid grid-cols-2 gap-2 mb-3 text-left">
                        <div class="bg-white/15 rounded-xl p-2"><p class="text-lg font-display font-bold">${myPosts.length}</p><p class="text-[9px] opacity-80">Posts (30d)</p></div>
                        <div class="bg-white/15 rounded-xl p-2"><p class="text-lg font-display font-bold">${likesReceived}</p><p class="text-[9px] opacity-80">Likes</p></div>
                        <div class="bg-white/15 rounded-xl p-2"><p class="text-lg font-display font-bold">${commentsReceived}</p><p class="text-[9px] opacity-80">Comments</p></div>
                        <div class="bg-white/15 rounded-xl p-2"><p class="text-lg font-display font-bold">🔥 ${streak}</p><p class="text-[9px] opacity-80">Day streak</p></div>
                    </div>
                    <p class="text-xs leading-relaxed whitespace-pre-wrap">${(recap || '').replace(/</g,'&lt;')}</p>
                `;
            } catch (e) {
                // BUGFIX: same silent-catch issue as Vibe Check — nothing was ever logged,
                // so a failed AI call or a bad stats computation left zero trace to debug.
                console.error("generateNexusWrapped failed for user:", currentUser, e);
                body.innerHTML = `<p class="text-xs">Wrapped abhi generate nahi ho paya, thodi der baad try karo.</p>`;
            }
        }

        // =====================================================================================
        // FEATURE: TIME CAPSULE — locked messages that unlock on a future date
        // =====================================================================================
        function openTimeCapsuleModal() {
            document.getElementById('timeCapsuleForUser').innerText = activeChatUser ? `for ${activeChatUser}` : '';
            document.getElementById('timeCapsuleText').value = '';
            const dateInput = document.getElementById('timeCapsuleDate');
            const minDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            dateInput.min = minDate;
            dateInput.value = minDate;
            document.getElementById('timeCapsuleFeatureNotice').classList.toggle('hidden', timeCapsuleFeatureAvailable);
            renderTimeCapsuleList();
            document.getElementById('timeCapsuleModal').classList.remove('hidden');
        }

        async function sendTimeCapsule() {
            if (!timeCapsuleFeatureAvailable) return;
            const text = document.getElementById('timeCapsuleText').value.trim();
            const dateVal = document.getElementById('timeCapsuleDate').value;
            const to = activeChatUser || currentUser;
            if (!text || !dateVal) return;
            try {
                const { error } = await supabaseClient.from('time_capsules').insert({
                    from_username: currentUser,
                    to_username: to,
                    content: text,
                    unlock_at: new Date(dateVal + 'T00:00:00').toISOString()
                });
                if (error) throw error;
                document.getElementById('timeCapsuleText').value = '';
                await fetchAllData();
                renderTimeCapsuleList();
                showInAppBanner('🔒 Locked', `Capsule ${to} ke liye lock ho gaya.`);
            } catch (e) {
                console.warn('Nexus: time_capsules table not set up yet.', e);
                timeCapsuleFeatureAvailable = false;
                document.getElementById('timeCapsuleFeatureNotice').classList.remove('hidden');
            }
        }

        function renderTimeCapsuleList() {
            const wrap = document.getElementById('timeCapsuleList');
            if (!timeCapsuleFeatureAvailable) { wrap.innerHTML = ''; return; }

            const relevant = timeCapsulesCache.filter(c => c.from_username === currentUser || c.to_username === currentUser);
            if (relevant.length === 0) {
                wrap.innerHTML = `<p class="text-[10px] text-slate-500">Koi capsule nahi hai abhi.</p>`;
                return;
            }
            const now = Date.now();
            wrap.innerHTML = relevant.map(c => {
                const isUnlocked = new Date(c.unlock_at).getTime() <= now;
                const otherParty = c.from_username === currentUser ? `To ${c.to_username}` : `From ${c.from_username}`;
                return `
                    <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-2.5 space-y-1">
                        <div class="flex items-center justify-between text-[9px] text-slate-500">
                            <span>${otherParty}</span>
                            <span>${isUnlocked ? '🔓 Unlocked' : '🔒 ' + new Date(c.unlock_at).toLocaleDateString()}</span>
                        </div>
                        <p class="text-xs text-slate-200">${isUnlocked ? (c.content || '').replace(/</g,'&lt;') : '•••••••••••••••••'}</p>
                    </div>
                `;
            }).join('');
        }


        // Counts consecutive calendar days (ending today or yesterday) that have at least one post.
        function computePostStreak(userPosts) {
            if (!userPosts || !userPosts.length) return 0;
            const dayKeys = new Set(userPosts.map(p => new Date(p.created_at).toDateString()));
            let streak = 0;
            let cursor = new Date();
            // Allow the streak to still show if today has no post yet, as long as yesterday does.
            if (!dayKeys.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
            while (dayKeys.has(cursor.toDateString())) {
                streak++;
                cursor.setDate(cursor.getDate() - 1);
            }
            return streak;
        }

        function switchProfileTab(tab) {
            profileActiveTab = tab;
            const postsBtn = document.getElementById('profTabPostsBtn');
            const reelsBtn = document.getElementById('profTabReelsBtn');

            if(tab === 'posts') {
                postsBtn.className = "flex-1 py-2 text-center text-[#ff4d8d] border-b-2 border-[#ff4d8d] transition";
                reelsBtn.className = "flex-1 py-2 text-center text-slate-400 border-b-2 border-transparent transition";
            } else {
                reelsBtn.className = "flex-1 py-2 text-center text-[#ff4d8d] border-b-2 border-[#ff4d8d] transition";
                postsBtn.className = "flex-1 py-2 text-center text-slate-400 border-b-2 border-transparent transition";
            }
            renderProfileGrid();
        }

        function renderProfileGrid() {
            const container = document.getElementById('profileGridContainer');

            // FEATURE: PRIVATE ACCOUNT ENFORCEMENT — non-followers see a lock, not the grid
            if (isPrivateAndNotFollowing(viewingProfileUsername)) {
                container.innerHTML = `
                    <div class="col-span-3 text-center py-14 text-slate-500">
                        <i class="fa-solid fa-lock text-2xl mb-2"></i>
                        <p class="text-xs font-bold text-slate-300">This Account is Private</p>
                        <p class="text-[10px] mt-1">Follow ${viewingProfileUsername} to see their posts and reels.</p>
                    </div>
                `;
                return;
            }

            const userPosts = globalPostsCache.filter(p => {
                const isReel = p.platform === 'Reel' || (p.image_url && p.image_url.match(/\.(mp4|mov|webm)$/i));
                if (profileActiveTab === 'reels') return p.username === viewingProfileUsername && isReel;
                return p.username === viewingProfileUsername && !isReel;
            }).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            if (userPosts.length === 0) {
                container.innerHTML = `<div class="col-span-3 text-center py-10 text-xs text-slate-500">No ${profileActiveTab} found.</div>`;
                return;
            }

            container.innerHTML = userPosts.map(post => {
                const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
                return `
                    <div onclick="openPostDetailModal('${post.id}')" class="aspect-square bg-slate-900 border ${post.pinned ? 'border-amber-500/50' : 'border-slate-800/80'} rounded-sm overflow-hidden relative cursor-pointer group">
                        ${post.pinned ? `<div class="absolute top-1.5 left-1.5 z-10 text-amber-400 text-[10px] drop-shadow"><i class="fa-solid fa-thumbtack"></i></div>` : ''}
                        ${isVideo ? 
                            `<video src="${post.image_url}" class="w-full h-full object-cover"></video><div class="absolute top-1.5 right-1.5 bg-black/60 px-1.5 py-0.5 rounded text-[9px] text-white"><i class="fa-solid fa-clapperboard"></i></div>` :
                            post.image_url ? 
                                `<img src="${post.image_url}" class="w-full h-full object-cover">` : 
                                `<div class="w-full h-full p-2 flex items-center justify-center text-[10px] text-slate-300 text-center bg-slate-950">${post.content.substring(0, 40)}...</div>`
                        }
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
            if(!viewingProfileUsername || viewingProfileUsername === currentUser) return;
            const isFollowing = globalFollowsCache.some(f => f.follower === currentUser && f.following === viewingProfileUsername);
            const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === viewingProfileUsername);

            if(isFollowing) {
                await supabaseClient.from('follows').delete().eq('follower', currentUser).eq('following', viewingProfileUsername);
            } else if (hasPendingRequest) {
                return; // request already pending, nothing to do
            } else if (isPrivateAndNotFollowing(viewingProfileUsername)) {
                // Private account: send a follow request instead of following directly
                try {
                    await supabaseClient.from('follow_requests').insert({ requester: currentUser, target: viewingProfileUsername });
                } catch (err) {
                    console.error("Follow request failed (did you run the follow_requests migration?):", err);
                }
            } else {
                await supabaseClient.from('follows').insert({ follower: currentUser, following: viewingProfileUsername });
            }
            await fetchAllData();
            openProfile(viewingProfileUsername, false);
        }

        async function toggleFollowFromFeed(targetUser) {
            if(targetUser === currentUser) return;
            const isFollowing = globalFollowsCache.some(f => f.follower === currentUser && f.following === targetUser);
            const hasPendingRequest = globalFollowRequestsCache.some(r => r.requester === currentUser && r.target === targetUser);

            if(isFollowing) {
                await supabaseClient.from('follows').delete().eq('follower', currentUser).eq('following', targetUser);
            } else if (hasPendingRequest) {
                return;
            } else if (isPrivateAndNotFollowing(targetUser)) {
                try {
                    await supabaseClient.from('follow_requests').insert({ requester: currentUser, target: targetUser });
                } catch (err) {
                    console.error("Follow request failed (did you run the follow_requests migration?):", err);
                }
            } else {
                await supabaseClient.from('follows').insert({ follower: currentUser, following: targetUser });
            }
            await fetchAllData();
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
                container.innerHTML = `<p class="text-xs text-slate-500 text-center py-4">No users found.</p>`;
            } else {
                users.forEach(u => {
                    const av = globalProfilesCache[u];
                    const personaKeys = grouped.get(u);
                    const personaBadges = PERSONAS.filter(p => personaKeys.has(p.key)).map(p => `<span title="${p.label}">${p.emoji}</span>`).join('');
                    const div = document.createElement('div');
                    div.className = "flex items-center justify-between bg-slate-900 border border-slate-800 p-2 rounded-xl text-xs cursor-pointer hover:bg-slate-800 transition";
                    div.innerHTML = `
                        <div class="flex items-center space-x-2 w-full">
                            <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-[10px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                            <span class="font-bold text-slate-200 truncate">${u}</span>
                            ${personaBadges ? `<span class="text-[10px] shrink-0 ml-auto pr-1" title="Faces followed">${personaBadges}</span>` : ''}
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

        function openCropperModal(input) {
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
            document.getElementById('profileImageFileInput').value = '';
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

                const fileName = `${Date.now()}_profile.jpg`;
                const fileObj = new File([blob], fileName, { type: 'image/jpeg' });

                try {
                    const { data, error } = await supabaseClient.storage.from('media').upload(fileName, fileObj);
                    if (!error) {
                        const { data: publicUrlData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
                        const publicUrl = publicUrlData.publicUrl;

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
                    } else {
                        console.error("Profile avatar storage upload failed:", error);
                        showAlertBanner("Upload failed: " + (error.message || "Make sure bucket 'media' is public."), 'error');
                    }
                } catch(err) {
                    // BUGFIX: this used to only console.error and leave the user staring at a
                    // modal that looked stuck, with no idea anything went wrong ("silent fail").
                    console.error("Profile picture upload threw an unexpected error:", err);
                    showAlertBanner("Photo upload karte waqt unexpected error aaya: " + (err.message || 'Unknown error'), 'error');
                } finally {
                    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.innerText = 'Save Photo'; }
                }
            }, 'image/jpeg');
        }

        // FEATURE: MOOD STATUS
        let selectedMoodEmoji = '😊';
        function selectMoodEmoji(emoji) {
            selectedMoodEmoji = emoji;
            document.querySelectorAll('#moodEmojiPicker [data-mood-emoji]').forEach(el => {
                el.classList.toggle('bg-slate-800', el.dataset.moodEmoji === emoji);
            });
        }
        async function saveMoodStatus() {
            const text = document.getElementById('moodTextInput').value.trim();
            try {
                const { error } = await supabaseClient.from('profiles')
                    .update({ mood: text || null, mood_emoji: text ? selectedMoodEmoji : null, mood_updated_at: new Date().toISOString() })
                    .eq('username', currentUser);
                if (error) throw error;
                document.getElementById('moodFeatureNotice').classList.add('hidden');
                await fetchAllData();
                openProfile(currentUser, false);
            } catch (e) {
                console.warn('Nexus: mood columns not set up on profiles yet.', e);
                document.getElementById('moodFeatureNotice').classList.remove('hidden');
            }
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

        // FEATURE: CUSTOM CHAT THEMES — purely local (localStorage per chat partner), no DB needed
        const CHAT_THEMES = [
            { key: 'default', label: 'Default', css: '' },
            { key: 'sunset', label: 'Sunset', css: 'linear-gradient(160deg, rgba(255,77,141,0.18), rgba(15,15,24,0))' },
            { key: 'ocean', label: 'Ocean', css: 'linear-gradient(160deg, rgba(53,199,255,0.18), rgba(15,15,24,0))' },
            { key: 'violet', label: 'Violet', css: 'linear-gradient(160deg, rgba(157,123,255,0.18), rgba(15,15,24,0))' },
            { key: 'forest', label: 'Forest', css: 'linear-gradient(160deg, rgba(16,185,129,0.16), rgba(15,15,24,0))' },
            { key: 'amber', label: 'Amber', css: 'linear-gradient(160deg, rgba(245,165,36,0.16), rgba(15,15,24,0))' },
            { key: 'mono', label: 'Mono', css: 'linear-gradient(160deg, rgba(148,163,184,0.14), rgba(15,15,24,0))' },
            { key: 'nexus', label: 'Nexus', css: 'linear-gradient(160deg, rgba(255,77,141,0.14), rgba(157,123,255,0.10), rgba(53,199,255,0.10))' }
        ];
        function chatThemeKey(username) { return 'nexus_chat_theme_' + currentUser + '_' + username; }
        function applyChatTheme(username) {
            const saved = localStorage.getItem(chatThemeKey(username)) || 'default';
            const theme = CHAT_THEMES.find(t => t.key === saved) || CHAT_THEMES[0];
            document.getElementById('chatMessagesBox').style.backgroundImage = theme.css;
        }
        function openChatThemeModal() {
            if (!activeChatUser) return;
            document.getElementById('chatThemeForUser').innerText = 'with ' + activeChatUser;
            const current = localStorage.getItem(chatThemeKey(activeChatUser)) || 'default';
            document.getElementById('chatThemeGrid').innerHTML = CHAT_THEMES.map(t => `
                <button onclick="selectChatTheme('${t.key}')" class="aspect-square rounded-xl border-2 ${current === t.key ? 'border-[#ff4d8d]' : 'border-slate-800'} flex items-center justify-center text-[9px] text-slate-300 font-semibold overflow-hidden relative" style="background: #0f0f18; background-image: ${t.css || 'none'}">
                    ${t.label}
                </button>
            `).join('');
            document.getElementById('chatThemeModal').classList.remove('hidden');
        }
        function selectChatTheme(key) {
            if (!activeChatUser) return;
            localStorage.setItem(chatThemeKey(activeChatUser), key);
            applyChatTheme(activeChatUser);
            document.getElementById('chatThemeModal').classList.add('hidden');
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
            applyChatTheme(username);
            updateChatRequestUI(username); // FEATURE: MESSAGE REQUESTS

            // (Re)create a dedicated broadcast channel to send typing signals to this chat partner
            if (typingSendChannel) supabaseClient.removeChannel(typingSendChannel);
            typingSendChannel = supabaseClient.channel('typing_' + username);
            typingSendChannel.subscribe();
            
            loadDirectMessages(username, true);

            if(messagePollingInterval) clearInterval(messagePollingInterval);
            messagePollingInterval = setInterval(() => {
                if(activeChatUser) {
                    loadDirectMessages(activeChatUser, false);
                }
            }, 2500);
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
            label.className = isOnline ? "text-[9px] font-semibold text-emerald-400" : "text-[9px] font-semibold text-slate-500";
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

        async function attemptSendPendingMessage(partner, tempId) {
            const list = pendingMessages[partner] || [];
            const pm = list.find(p => p.tempId === tempId);
            if (!pm) return;

            pm.status = 'sending';
            if (partner === activeChatUser) loadDirectMessages(partner, true);

            try {
                let mediaUrl = null;
                if (pm.mediaFile) {
                    const fileName = `chat_${Date.now()}_${pm.mediaFile.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                    const { error: uploadErr } = await supabaseClient.storage.from('media').upload(fileName, pm.mediaFile);
                    if (uploadErr) throw uploadErr;
                    const { data: pubData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
                    mediaUrl = pubData.publicUrl;
                }

                const messagePayload = {
                    sender: currentUser,
                    receiver: pm.receiver,
                    text: pm.text || '[Media Attachment]',
                    media_url: mediaUrl
                };
                if (pm.replyingToMessage) {
                    messagePayload.reply_to_id = pm.replyingToMessage.id;
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
                console.error('Message send failed (will retry when online):', err);
                pm.status = 'failed';
                if (partner === activeChatUser) loadDirectMessages(partner, true);
                // Only bother the user with a banner if we're actually online (so it's a real
                // error, e.g. permissions) — a plain offline failure just waits quietly to retry.
                if (navigator.onLine) {
                    showAlertBanner('Message send nahi hua, dobara try kar raha hoon: ' + (err.message || 'network error'), 'error');
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
                    <div class="max-w-[80%] p-2.5 rounded-2xl text-xs bg-[#ff4d8d] text-white rounded-br-none space-y-1.5 relative shadow opacity-70">
                        ${pm.mediaPreviewUrl ? `<img src="${pm.mediaPreviewUrl}" class="w-full max-h-48 rounded-lg object-cover">` : ''}
                        <p class="leading-relaxed break-words">${pm.text}</p>
                    </div>
                    <span class="text-[9px] text-slate-500 px-1 flex items-center gap-1">
                        ${pm.status === 'failed'
                            ? `<i class="fa-solid fa-triangle-exclamation text-red-400"></i> Failed — <button onclick="retryPendingMessage('${targetUser}','${pm.tempId}')" class="underline text-[#ff4d8d]">retry</button>`
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
                    ? `<div class="text-center text-xs text-slate-500 my-auto">No messages yet with ${targetUser}. Say hello! 👋</div>${pendingHtml}`
                    : `<div class="text-center text-xs text-slate-500 my-auto">No messages yet with ${targetUser}. Say hello! 👋</div>`;
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
                            <span class="bg-slate-900 border border-slate-800 text-slate-400 text-[9px] font-bold px-2.5 py-1 rounded-full">${dateLabel}</span>
                        </div>
                    `;
                    lastDateLabel = dateLabel;
                }

                // Quoted reply preview shown inside the bubble, if this message is a reply
                const replyBlockHtml = msg.reply_to_id ? `
                    <div class="border-l-2 ${isMe ? 'border-white/50' : 'border-[#ff4d8d]'} pl-2 ${isMe ? 'bg-white/10' : 'bg-slate-950/60'} rounded-md py-1 mb-1">
                        <p class="text-[9px] font-bold ${isMe ? 'text-white/80' : 'text-[#ff4d8d]'}">${msg.reply_to_sender || ''}</p>
                        <p class="text-[9px] ${isMe ? 'text-white/70' : 'text-slate-400'} truncate">${msg.reply_to_text || ''}</p>
                    </div>
                ` : (msg.reply_to_story_id ? `
                    <div class="flex items-center gap-1.5 border-l-2 ${isMe ? 'border-white/50' : 'border-[#ff4d8d]'} pl-2 ${isMe ? 'bg-white/10' : 'bg-slate-950/60'} rounded-md py-1 mb-1">
                        ${msg.reply_to_story_media ? `<img src="${msg.reply_to_story_media}" class="w-6 h-8 object-cover rounded">` : ''}
                        <p class="text-[9px] font-bold ${isMe ? 'text-white/80' : 'text-[#ff4d8d]'}"><i class="fa-solid fa-circle-play mr-0.5"></i>Replied to ${isMe ? (msg.reply_to_story_username || 'their') + "'s" : 'your'} story</p>
                    </div>
                ` : '');

                // Read receipt ticks - only shown on the sender's own messages
                let ticksHtml = '';
                if (isMe) {
                    ticksHtml = msg.read_at
                        ? `<i class="fa-solid fa-check-double text-[10px] text-[#35c7ff]" title="Read"></i>`
                        : `<i class="fa-solid fa-check text-[10px] text-slate-500" title="Sent"></i>`;
                }

                const reactionsHtml = renderReactionBadgesHtml(msg.id, 'dm');
                const disappearBadge = msg.expires_at ? `<i class="fa-solid fa-fire text-[9px] text-orange-400" title="Disappearing message"></i>` : '';
                const editedBadge = msg.edited_at && !msg.is_deleted ? `<span class="text-[8px] text-slate-500 italic">(edited)</span>` : '';

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
                    bodyHtml = `<p class="leading-relaxed italic text-slate-500 flex items-center gap-1"><i class="fa-solid fa-ban text-[10px]"></i> This message was deleted</p>`;
                } else if (msg.type === 'voice' && msg.audio_url) {
                    bodyHtml = `<audio src="${msg.audio_url}" controls class="max-w-[220px] h-9"></audio>`;
                } else {
                    const fadeStyleAttr = fadeInfo ? ` style="filter:blur(${fadeInfo.blur}px); opacity:${fadeInfo.opacity}; transition: filter 1s ease, opacity 1s ease;"` : '';
                    const fadeBadge = fadeInfo ? `<i class="fa-solid fa-water text-[8px] text-slate-500 ml-1" title="Reply karo isse pehle ki ye poori tarah fade ho jaaye"></i>` : '';
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
                        <div class="max-w-[80%] p-2.5 rounded-2xl text-xs ${isMe ? 'bg-[#ff4d8d] text-white rounded-br-none' : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none'} space-y-1.5 relative group shadow" ondblclick="${msg.is_deleted ? '' : `openReactionPicker(event, '${msg.id}', 'dm')`}">
                            ${replyBlockHtml}
                            ${bodyHtml}
                            ${!msg.is_deleted ? `<button onclick="setReplyTarget('${msg.id}')" class="absolute -top-2 ${isMe ? '-left-2' : '-right-2'} bg-slate-800 text-[#35c7ff] p-1 rounded-full text-[9px] shadow opacity-0 group-hover:opacity-100 transition" title="Reply"><i class="fa-solid fa-reply"></i></button>` : ''}
                            ${!msg.is_deleted ? `<button onclick="togglePinMessage('${msg.id}', 'dm')" class="absolute -bottom-2 ${isMe ? '-right-2' : '-left-2'} ${msg.pinned_at ? 'bg-yellow-500 text-black' : 'bg-slate-800 text-yellow-400'} p-1 rounded-full text-[9px] shadow opacity-0 group-hover:opacity-100 transition" title="${msg.pinned_at ? 'Unpin' : 'Pin'}"><i class="fa-solid fa-thumbtack"></i></button>` : ''}
                            ${!msg.is_deleted ? `<button onclick="openReactionPicker(event, '${msg.id}', 'dm')" class="absolute -bottom-2 ${isMe ? '-left-2' : 'left-2'} bg-slate-800 text-yellow-400 p-1 rounded-full text-[9px] shadow opacity-0 group-hover:opacity-100 transition" title="React"><i class="fa-solid fa-face-smile"></i></button>` : ''}
                            ${canModify ? `<button onclick="startEditMessage('${msg.id}')" class="absolute -top-2 ${isMe ? '-right-9' : '-right-9'} bg-slate-800 text-emerald-400 p-1 rounded-full text-[9px] shadow opacity-0 group-hover:opacity-100 transition" title="Edit"><i class="fa-solid fa-pencil"></i></button>` : ''}
                            ${isMe && !msg.is_deleted ? `<button onclick="deleteMessage('${msg.id}')" class="absolute -top-2 -right-2 bg-slate-800 text-red-400 p-1 rounded-full text-[9px] shadow opacity-0 group-hover:opacity-100 transition" title="Delete for everyone"><i class="fa-solid fa-xmark"></i></button>` : ''}
                        </div>
                        ${reactionsHtml}
                        <span class="text-[9px] text-slate-500 px-1 flex items-center gap-1">${timeLabel} ${disappearBadge} ${ticksHtml}</span>
                    </div>
                `;
            });

            htmlContent += renderPendingMessagesHtml(targetUser);

            if (chatBox.innerHTML !== htmlContent) {
                replaceChatHtmlPreservingVideo(chatBox, htmlContent);
                forceScroll = true;
            }

            if (forceScroll) {
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

            // FEATURE: AI SMART REPLIES — only (re)generate when a *new* incoming message arrives
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.sender === targetUser && !lastMsg.is_deleted && lastMsg.text) {
                if (lastSmartReplyTrigger !== lastMsg.id) {
                    lastSmartReplyTrigger = lastMsg.id;
                    generateSmartReplies(messages.slice(-6));
                }
            } else {
                hideSmartReplies();
            }
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
                return `<span onclick="quickToggleReaction('${messageId}', '${emoji}', '${source}')" class="cursor-pointer text-[10px] px-1.5 py-0.5 rounded-full border ${mine ? 'bg-[#ff4d8d]/20 border-[#ff4d8d] text-[#ff4d8d]' : 'bg-slate-800 border-slate-700 text-slate-300'}">${emoji} ${counts[emoji]}</span>`;
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
                    <span id="${carouselId}-counter" class="absolute top-2 right-2 bg-black/60 text-white text-[9px] font-bold px-2 py-0.5 rounded-full">1/${urls.length}</span>
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
                        <p class="text-[10px] font-bold text-amber-400">On This Day — ${yearsAgo} year${yearsAgo > 1 ? 's' : ''} ago</p>
                        <p class="text-xs text-slate-300 truncate">${(memory.content || '').replace(/</g,'&lt;')}</p>
                    </div>
                    <button onclick="dismissOnThisDay()" class="shrink-0 text-slate-500 hover:text-white text-xs px-1"><i class="fa-solid fa-xmark"></i></button>
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
            flushUsageDwellObserver(); // FEATURE: HONEST USAGE MIRROR — settle any in-flight dwell time before re-render
            feedStream.innerHTML = '';
            globalPostsCache.filter(post => !isBlockedWith(post.username) && !isPrivateAndNotFollowing(post.username)).forEach(post => {
                const postLikes = globalLikesCache.filter(l => l.post_id === post.id);
                const hasLiked = postLikes.some(l => l.username === currentUser);
                // FEATURE: REACTION SPEED GAME — badge for whoever liked this post first (needs post_likes.created_at)
                const timedLikes = postLikes.filter(l => l.created_at).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                const firstReactor = timedLikes.length > 0 ? timedLikes[0].username : null;
                const postComments = globalCommentsCache.filter(c => c.post_id === post.id);
                const posterAvatar = globalProfilesCache[post.username];
                // FEATURE: MULTI-PERSONA IDENTITY — a post's platform tag IS its persona face,
                // so the feed's Follow button follows just that one face, not the whole account.
                const postPersona = personaForKey(personaKeyForPlatform(post.platform));
                const isFollowingPersona = post.username === currentUser || globalFollowsCache.some(f => f.follower === currentUser && f.following === post.username && f.persona === postPersona.key);
                const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
                let styleAccent = '#35c7ff'; // Twit
                if (post.platform === 'Instagram') styleAccent = '#ff4d8d'; // Post
                else if (post.platform === 'Telegram') styleAccent = '#9d7bff'; // Channel
                else if (post.platform === 'Reel') styleAccent = '#f5a524'; // Reel

                const card = document.createElement('div');
                card.className = "glass-panel rounded-2xl p-3 space-y-2.5 shadow-md";
                card.style.borderLeft = `3px solid ${styleAccent}`;
                card.innerHTML = `
                    <div class="flex justify-between items-center text-xs">
                        <div class="flex items-center space-x-2">
                            <div onclick="handleUserClick('${post.username}')" class="w-6 h-6 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-[10px] text-white cursor-pointer shadow overflow-hidden">
                                ${posterAvatar ? `<img src="${posterAvatar}" class="w-full h-full object-cover">` : post.username.charAt(0).toUpperCase()}
                            </div>
                            <span onclick="handleUserClick('${post.username}')" class="font-bold text-slate-200 cursor-pointer hover:text-[#ff4d8d] transition flex items-center gap-1">${post.username} ${verifiedBadgeHtml(post.username)} ${adminBadgeHtml(post.username)}</span>
                            ${post.username !== currentUser ? `<button onclick="togglePersonaFollow('${post.username}','${postPersona.key}')" title="Follow just this face — not the whole account" class="ml-1 text-[10px] px-2 py-0.5 rounded-lg border ${isFollowingPersona ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-[#ff4d8d] border-[#ff4d8d] text-white font-bold'} transition">${isFollowingPersona ? `Following ${postPersona.emoji}` : `Follow ${postPersona.emoji}`}</button>` : ''}
                        </div>
                        <div class="flex items-center space-x-2">
                            <span class="text-[9px] px-2 py-0.5 rounded-full border bg-gradient-to-r from-[#9d7bff]/10 to-[#ff4d8d]/10 text-[#ff4d8d] border-[#ff4d8d]/20 flex items-center gap-1" title="${postPersona.label}">${postPersona.emoji} ${postPersona.label}</span>
                            ${post.pinned ? `<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1" title="Pinned"><i class="fa-solid fa-thumbtack text-[8px]"></i></span>` : ''}
                            ${post.username === currentUser ? `<button onclick="togglePinPost('${post.id}')" class="text-slate-500 hover:text-amber-400 text-xs transition" title="${post.pinned ? 'Unpin' : 'Pin to profile'}"><i class="fa-solid fa-thumbtack ${post.pinned ? 'text-amber-400' : ''}"></i></button>` : ''}
                            ${post.username === currentUser ? `<button onclick="deletePost('${post.id}')" class="text-slate-500 hover:text-red-400 text-xs transition" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ''}
                        </div>
                    </div>
                    <p class="text-xs text-slate-300 whitespace-pre-wrap break-words">${linkifyHashtags(post.content)}</p>
                    ${buildPostMediaHtml(post, `carousel-feed-${post.id}`)}
                    
                    <div class="flex items-center space-x-4 pt-1.5 border-t border-slate-800/80 text-[11px] text-slate-400">
                        <button onclick="toggleLike('${post.id}')" class="hover:text-[#ff4d8d] transition flex items-center gap-1">
                            <i class="fa-solid fa-heart ${hasLiked ? 'text-[#ff4d8d]' : 'text-slate-500'}"></i> <span>${postLikes.length}</span>
                        </button>
                        ${firstReactor ? `<span class="text-[9px] text-amber-400 flex items-center gap-1 truncate max-w-[90px]" title="First to react"><i class="fa-solid fa-bolt shrink-0"></i><span class="truncate">${firstReactor}${firstReactor === currentUser ? ' (you!)' : ''}</span></span>` : ''}
                        <button onclick="openCommentModal('${post.id}')" class="hover:text-[#35c7ff] transition flex items-center gap-1">
                            <i class="fa-solid fa-comment text-[#35c7ff]"></i> <span>${postComments.length}</span>
                        </button>
                        <button onclick="openSharePostModal('${post.id}')" class="hover:text-[#9d7bff] transition flex items-center gap-1" title="Share">
                            <i class="fa-solid fa-share-nodes text-[#9d7bff]"></i>
                        </button>
                        ${post.username === currentUser ? `<button onclick="openPostAnalyticsModal('${post.id}')" class="hover:text-emerald-400 transition flex items-center gap-1 ml-auto" title="Post Analytics"><i class="fa-solid fa-chart-simple text-emerald-400"></i> <span>${globalPostViewsCache.filter(v => v.post_id === post.id).length}</span></button>` : ''}
                    </div>
                `;
                feedStream.appendChild(card);

                // FEATURE: HONEST USAGE MIRROR — track continuous genuine dwell time per post
                card.dataset.usagePostId = post.id;
                getUsageDwellObserver().observe(card);

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
        }

        function renderReels() {
            const container = document.getElementById('reelsStreamContainer');
            const reels = globalPostsCache.filter(p => (p.platform === 'Reel' || (p.image_url && p.image_url.match(/\.(mp4|mov|webm)$/i))) && !isBlockedWith(p.username) && !isPrivateAndNotFollowing(p.username));

            if (reels.length === 0) {
                container.innerHTML = `<div class="text-center text-xs text-slate-500 py-20">No reels found. Click the top-right '+' button to upload one!</div>`;
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
                                <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-xs text-white overflow-hidden shadow">${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : reel.username.charAt(0)}</div>
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
                            </div>
                            <div class="flex flex-col space-y-4 items-center text-white text-xs">
                                <button onclick="toggleLike('${reel.id}')" class="flex flex-col items-center"><i class="fa-solid fa-heart text-xl ${hasLiked ? 'text-[#ff4d8d]' : 'text-white'}"></i><span class="text-[10px] font-bold">${postLikes.length}</span></button>
                                <button onclick="openCommentModal('${reel.id}')" class="flex flex-col items-center"><i class="fa-solid fa-comment text-xl text-[#35c7ff]"></i><span class="text-[10px] font-bold">${postComments.length}</span></button>
                                <button onclick="event.stopPropagation(); openSharePostModal('${reel.id}')" class="flex flex-col items-center"><i class="fa-solid fa-share-nodes text-xl text-white"></i><span class="text-[10px] font-bold">Share</span></button>
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

        function openReelUploadModal() {
            document.getElementById('reelUploadModal').classList.remove('hidden');
        }

        function closeReelUploadModal() {
            document.getElementById('reelUploadModal').classList.add('hidden');
            const preview = document.getElementById('reelPreviewVideo');
            if (preview.src) URL.revokeObjectURL(preview.src);
            preview.src = '';
            preview.classList.add('hidden');
            document.getElementById('reelUploadForm').reset();
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

            const file = fileInput.files[0];

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
                const videoUrl = publicUrlData.publicUrl;

                const { error: insertError } = await supabaseClient.from('posts').insert({
                    username: currentUser,
                    platform: 'Reel',
                    content: caption,
                    image_url: videoUrl,
                    likes_count: 0
                });
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
            const allPostComments = globalCommentsCache.filter(c => c.post_id === postId);
            const topLevel = allPostComments.filter(c => !c.parent_comment_id);

            if (allPostComments.length === 0) {
                listContainer.innerHTML = `<p class="text-center text-xs text-slate-500 py-6">No comments yet. Be the first!</p>`;
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
                                <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-[10px] text-white overflow-hidden shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : c.username.charAt(0)}</div>
                                <div class="min-w-0"><span class="font-bold text-[#ff4d8d] cursor-pointer" onclick="handleUserClick('${c.username}')">${c.username}</span> <p class="text-slate-300 break-words">${c.text}</p></div>
                            </div>
                            ${c.username === currentUser ? `<button onclick="deleteComment('${c.id}')" class="text-slate-500 hover:text-red-400 text-xs ml-2 shrink-0"><i class="fa-solid fa-xmark"></i></button>` : ''}
                        </div>
                        <div class="flex items-center gap-3 mt-1.5 pl-8 text-[10px] text-slate-500">
                            <button onclick="toggleCommentLike('${c.id}')" class="flex items-center gap-1 hover:text-[#ff4d8d] transition ${iLikedComment ? 'text-[#ff4d8d] font-bold' : ''}"><i class="fa-solid fa-heart"></i> ${likesForComment.length > 0 ? likesForComment.length : ''} Like</button>
                            <button onclick="setCommentReplyTarget('${c.id}', '${c.username}')" class="flex items-center gap-1 hover:text-[#35c7ff] transition"><i class="fa-solid fa-reply"></i> Reply</button>
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
                    <span id="${detailCarouselId}-counter" class="absolute top-2 right-2 bg-black/60 text-white text-[9px] font-bold px-2 py-0.5 rounded-full">1/${detailUrls.length}</span>
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
                            <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-[10px] text-white overflow-hidden">${posterAvatar ? `<img src="${posterAvatar}" class="w-full h-full object-cover">` : post.username.charAt(0)}</div>
                            <span class="text-xs font-bold text-slate-200">${post.username}</span>
                        </div>
                        <p class="text-xs text-slate-300 break-words">${post.content}</p>
                        <div class="flex items-center space-x-4 pt-1 border-t border-slate-800 text-slate-400 text-xs">
                            <button onclick="toggleLike('${post.id}')" class="hover:text-[#ff4d8d] transition flex items-center gap-1"><i class="fa-solid fa-heart ${hasLiked ? 'text-[#ff4d8d]' : 'text-slate-500'}"></i> <span>${postLikes.length}</span></button>
                            <button onclick="openCommentModal('${post.id}')" class="hover:text-[#35c7ff] transition flex items-center gap-1"><i class="fa-solid fa-comment text-[#35c7ff]"></i> <span>${postComments.length}</span></button>
                            <button onclick="openSharePostModal('${post.id}')" class="hover:text-[#9d7bff] transition flex items-center gap-1" title="Share"><i class="fa-solid fa-share-nodes text-[#9d7bff]"></i></button>
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

        // FEATURE: MILESTONE CONFETTI
        function fireConfetti() {
            const container = document.getElementById('confettiContainer');
            const colors = ['#ff4d8d', '#9d7bff', '#35c7ff', '#f5a524'];
            const pieceCount = 60;
            for (let i = 0; i < pieceCount; i++) {
                const piece = document.createElement('div');
                piece.className = 'confetti-piece';
                piece.style.left = Math.random() * 100 + 'vw';
                piece.style.background = colors[Math.floor(Math.random() * colors.length)];
                piece.style.animationDuration = (1.6 + Math.random() * 1.2) + 's';
                piece.style.animationDelay = (Math.random() * 0.3) + 's';
                piece.style.transform = `rotate(${Math.random() * 360}deg)`;
                container.appendChild(piece);
                setTimeout(() => piece.remove(), 3200);
            }
        }

        async function toggleLike(postId) {
            // BUGFIX: this used to wait for a full network round trip (select, then
            // insert/delete, then a full fetchAllData() re-fetch of every table) before
            // the heart icon or count changed at all — felt slow/unresponsive compared
            // to Instagram. Now we flip the UI instantly using the local cache, then sync
            // to the DB in the background and roll back only if it actually fails.
            const alreadyLiked = globalLikesCache.some(l => l.post_id === postId && l.username === currentUser);
            const justLiked = !alreadyLiked;

            // Optimistic local update
            if (alreadyLiked) {
                globalLikesCache = globalLikesCache.filter(l => !(l.post_id === postId && l.username === currentUser));
            } else {
                globalLikesCache.push({ post_id: postId, username: currentUser, created_at: new Date().toISOString() });
            }
            renderFeed();
            if (activeModalPostId) renderCommentModal(activeModalPostId);
            if (viewingProfileUsername) renderProfileGrid();

            // FEATURE: MILESTONE CONFETTI — celebrate a post crossing a like milestone
            if (justLiked) {
                const newCount = globalLikesCache.filter(l => l.post_id === postId).length;
                if ([10, 25, 50, 100, 250, 500, 1000].includes(newCount)) {
                    fireConfetti();
                }
            }

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

        // Wraps #hashtags in post/reel content with clickable pink spans that jump to Explore
        function linkifyHashtags(content) {
            if (!content) return '';
            const escaped = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return escaped.replace(/#[a-zA-Z0-9_]+/g, (tag) => {
                const clean = tag.toLowerCase().replace(/[^a-z0-9_#]/g, '');
                return `<span onclick="event.stopPropagation(); jumpToExploreHashtag('${clean}')" class="text-[#ff4d8d] font-bold cursor-pointer hover:underline">${tag}</span>`;
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
                    tagsContainer.innerHTML = `<p class="text-[10px] text-slate-500">No hashtags yet. Add #tags to your posts!</p>`;
                } else {
                    tagsContainer.innerHTML = sortedTags.map(tag => `
                        <span onclick="filterExploreByHashtag('${tag}')" class="cursor-pointer text-[11px] font-bold px-2.5 py-1 rounded-full border ${activeExploreFilterTag === tag ? 'bg-[#ff4d8d] border-[#ff4d8d] text-white' : 'bg-slate-900 border-slate-800 text-[#ff4d8d] hover:border-[#ff4d8d]'}">${tag} <span class="text-slate-500 font-normal">${tagCounts[tag]}</span></span>
                    `).join('');
                }
            }

            renderStreakLeaderboard();
            renderExploreGrid();
        }

        // FEATURE: STREAK LEADERBOARD — ranks the people you follow (+ you) by current post streak
        function renderStreakLeaderboard() {
            const container = document.getElementById('streakLeaderboardContainer');
            if (!container) return;

            const friendUsernames = new Set([currentUser]);
            globalFollowsCache.filter(f => f.follower === currentUser).forEach(f => friendUsernames.add(f.following));

            const ranked = Array.from(friendUsernames).map(username => {
                const userPosts = globalPostsCache.filter(p => p.username === username);
                return { username, streak: computePostStreak(userPosts) };
            }).filter(r => r.streak > 0).sort((a, b) => b.streak - a.streak).slice(0, 10);

            if (ranked.length === 0) {
                container.innerHTML = `<p class="text-[10px] text-slate-500">Koi active streak nahi hai abhi — roz post karo aur yahan top pe aa jao!</p>`;
                return;
            }

            const medals = ['🥇', '🥈', '🥉'];
            container.innerHTML = ranked.map((r, i) => {
                const avatar = globalProfilesCache[r.username];
                return `
                    <div onclick="handleUserClick('${r.username}')" class="flex items-center gap-2 p-1.5 rounded-xl hover:bg-slate-900/60 cursor-pointer transition ${r.username === currentUser ? 'bg-slate-900/40' : ''}">
                        <span class="w-5 text-center text-xs shrink-0">${medals[i] || (i + 1)}</span>
                        <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-[10px] text-white overflow-hidden shrink-0">
                            ${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : r.username.charAt(0).toUpperCase()}
                        </div>
                        <span class="flex-1 min-w-0 text-xs font-semibold text-slate-200 truncate">${r.username}${r.username === currentUser ? ' (You)' : ''}</span>
                        <span class="text-[10px] font-bold text-amber-400 flex items-center gap-0.5 shrink-0"><i class="fa-solid fa-fire"></i> ${r.streak}</span>
                    </div>
                `;
            }).join('');
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
                grid.innerHTML = `<div class="col-span-2 text-center text-xs text-slate-500 py-8">Nothing to show here yet.</div>`;
                return;
            }

            grid.innerHTML = items.map(post => {
                const likeCount = globalLikesCache.filter(l => l.post_id === post.id).length;
                const isVideo = post.image_url && (post.platform === 'Reel' || post.image_url.match(/\.(mp4|mov|webm)$/i));
                return `
                    <div onclick="openPostDetailModal('${post.id}')" class="relative aspect-square rounded-xl overflow-hidden bg-slate-900 border border-slate-800 cursor-pointer group">
                        ${post.image_url
                            ? (isVideo ? `<video src="${post.image_url}" class="w-full h-full object-cover"></video>` : `<img src="${post.image_url}" class="w-full h-full object-cover">`)
                            : `<div class="w-full h-full flex items-center justify-center p-2 text-[10px] text-slate-400 text-center">${post.content.slice(0, 60)}</div>`}
                        <div class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 flex items-center gap-1 text-[10px] text-white font-bold">
                            <i class="fa-solid fa-heart text-[#ff4d8d]"></i> ${likeCount} <span class="text-slate-300 font-normal truncate">@${post.username}</span>
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
                            <button onclick="event.stopPropagation(); openStoryUploadModal()" class="absolute bottom-0 right-0 w-4 h-4 bg-[#ff4d8d] rounded-full flex items-center justify-center text-white text-[8px] border border-darker"><i class="fa-solid fa-plus"></i></button>
                        </div>
                    </div>
                    <span class="text-[9px] text-slate-400 font-semibold">Your Story</span>
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
                        <span class="text-[9px] text-slate-400 font-semibold truncate max-w-[56px]">${username}</span>
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
            revealSlowlyOptionEnabled = false;
            const dot = document.getElementById('revealSlowlyToggleDot');
            const btn = document.getElementById('revealSlowlyToggleBtn');
            if (dot && btn) {
                dot.style.transform = 'translateX(0)';
                btn.className = 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
            }
            document.getElementById('revealSlowlyFeatureNotice').classList.add('hidden');
        }

        // FEATURE: REVERSE REVEAL STORY — toggle for the upload-time "blur until they stay" option
        function toggleRevealSlowlyOption() {
            revealSlowlyOptionEnabled = !revealSlowlyOptionEnabled;
            const dot = document.getElementById('revealSlowlyToggleDot');
            const btn = document.getElementById('revealSlowlyToggleBtn');
            dot.style.transform = revealSlowlyOptionEnabled ? 'translateX(20px)' : 'translateX(0)';
            btn.className = revealSlowlyOptionEnabled ? 'w-10 h-5 rounded-full bg-[#9d7bff] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
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
                const { error: uploadError } = await supabaseClient.storage.from('media').upload(fileName, selectedStoryFileObject);
                if (uploadError) throw uploadError;

                const { data: pubData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
                const mediaType = selectedStoryFileObject.type.startsWith('video') ? 'video' : 'image';

                const { data: insertedRows, error: insertError } = await supabaseClient.from('stories').insert({
                    username: currentUser,
                    media_url: pubData.publicUrl,
                    media_type: mediaType,
                    caption: document.getElementById('storyCaptionInput').value.trim() || null
                }).select();
                if (insertError) throw insertError;

                // FEATURE: REVERSE REVEAL STORY — separate follow-up update so a missing
                // reveal_slowly column can never block the core story post above.
                if (revealSlowlyOptionEnabled && insertedRows && insertedRows[0]) {
                    try {
                        const { error: rsErr } = await supabaseClient.from('stories').update({ reveal_slowly: true }).eq('id', insertedRows[0].id);
                        if (rsErr) throw rsErr;
                    } catch (rsEx) {
                        console.warn('Nexus: reveal_slowly column not set up on stories yet.', rsEx);
                    }
                }

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
            const isRevealSlowly = !!story.reveal_slowly;
            const revealStyle = isRevealSlowly ? ` id="storyRevealMedia" class="max-w-full max-h-full object-contain reveal-slowly-media" style="animation: revealBlurClear ${STORY_DURATION_MS}ms linear forwards;"` : ' class="max-w-full max-h-full object-contain"';
            mediaContainer.innerHTML = story.media_type === 'video'
                ? `<video src="${story.media_url}"${revealStyle} autoplay playsinline muted></video>`
                : `<img src="${story.media_url}"${revealStyle}>`;

            const revealBadge = document.getElementById('storyRevealBadge');
            if (revealBadge) revealBadge.classList.toggle('hidden', !isRevealSlowly);

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
            const revealMedia = document.getElementById('storyRevealMedia');
            if (revealMedia) revealMedia.style.animationPlayState = 'paused';
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
            const revealMedia = document.getElementById('storyRevealMedia');
            if (revealMedia) revealMedia.style.animationPlayState = 'running';
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
                    banner.className = "pointer-events-auto w-full max-w-sm glass-panel bg-slate-900/95 border border-[#ff4d8d]/40 rounded-2xl p-2.5 shadow-2xl flex items-center space-x-2 animate-slide-down text-xs text-slate-200";
                    banner.innerHTML = `<i class="fa-solid fa-paper-plane text-[#ff4d8d]"></i> <span>Reply sent to ${story.username}'s story</span>`;
                    container.appendChild(banner);
                    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 2500);
                }
            } catch (err) {
                console.error('Story reply failed:', err);
                showAlertBanner('Could not send reply: ' + (err.message || 'Unknown error'), 'error');
            }
        }

        // =====================================================================================
        // FEATURE: BOTS/AUTOMATION
        // A "bot" here is just a normal profile (so it's chattable like any user) plus a row in
        // the `bots` table describing its keyword -> reply rules. Since this app has no server
        // backend, the auto-reply is simulated on the SENDER's own browser right after they send
        // a message to a bot's username — there is no always-on process, so a bot only "replies"
        // to the person actively chatting with it in that moment (same limitation any client-only
        // demo app has without serverless functions).
        // =====================================================================================
        function openBotsModal() {
            renderMyBotsList();
            document.getElementById('newBotRulesContainer').innerHTML = '';
            addBotRuleRow();
            document.getElementById('botsModal').classList.remove('hidden');
            document.getElementById('botsModal').classList.add('flex');
        }

        function closeBotsModal() {
            document.getElementById('botsModal').classList.add('hidden');
            document.getElementById('botsModal').classList.remove('flex');
        }

        function renderMyBotsList() {
            const container = document.getElementById('myBotsListContainer');
            const myBots = globalBotsCache.filter(b => b.owner === currentUser);
            if (myBots.length === 0) {
                container.innerHTML = `<div class="text-center text-[10px] text-slate-500 py-2">You haven't created any bots yet.</div>`;
                return;
            }
            container.innerHTML = myBots.map(b => `
                <div class="flex items-center justify-between gap-2 p-2 rounded-xl bg-slate-900 border border-slate-800">
                    <div onclick="closeBotsModal(); switchTab('chat'); selectChatUser('${b.bot_username}')" class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                        <div class="w-8 h-8 shrink-0 rounded-full bg-gradient-to-tr from-[#9d7bff] to-indigo-600 flex items-center justify-center text-white text-xs"><i class="fa-solid fa-robot"></i></div>
                        <div class="min-w-0">
                            <p class="text-xs font-bold text-slate-200 truncate">${b.bot_username}</p>
                            <p class="text-[9px] text-slate-500">${(b.rules || []).length} rule${(b.rules || []).length === 1 ? '' : 's'}</p>
                        </div>
                    </div>
                    <button onclick="deleteBot('${b.id}')" class="text-slate-500 hover:text-red-400 text-xs p-1" title="Delete bot"><i class="fa-solid fa-trash"></i></button>
                </div>
            `).join('');
        }

        function addBotRuleRow(keyword = '', reply = '') {
            const container = document.getElementById('newBotRulesContainer');
            const row = document.createElement('div');
            row.className = 'flex items-center gap-1.5 bot-rule-row';
            row.innerHTML = `
                <input type="text" placeholder="keyword" value="${keyword}" class="bot-rule-keyword w-1/3 bg-slate-950 border border-slate-800 rounded-lg p-2 text-[10px] text-slate-200 focus:outline-none focus:border-[#9d7bff]">
                <input type="text" placeholder="reply text" value="${reply}" class="bot-rule-reply flex-1 bg-slate-950 border border-slate-800 rounded-lg p-2 text-[10px] text-slate-200 focus:outline-none focus:border-[#9d7bff]">
                <button onclick="this.closest('.bot-rule-row').remove()" class="text-slate-500 hover:text-red-400 p-1 shrink-0"><i class="fa-solid fa-xmark"></i></button>
            `;
            container.appendChild(row);
        }

        async function submitCreateBot() {
            const botUsername = document.getElementById('newBotUsernameInput').value.trim();
            if (!botUsername) { showAlertBanner('Please enter a bot username.', 'warning'); return; }
            if (globalProfilesCache.hasOwnProperty(botUsername)) { showAlertBanner('That username is already taken.', 'warning'); return; }

            const defaultReply = document.getElementById('newBotDefaultReplyInput').value.trim() || "Sorry, I didn't understand that. 🤖";
            const rules = Array.from(document.querySelectorAll('.bot-rule-row')).map(row => ({
                keyword: row.querySelector('.bot-rule-keyword').value.trim().toLowerCase(),
                reply: row.querySelector('.bot-rule-reply').value.trim()
            })).filter(r => r.keyword && r.reply);

            // A bot needs a profile row too, so it shows up like any normal chattable user.
            await supabaseClient.from('profiles').upsert({ username: botUsername }, { onConflict: 'username' });
            const { error } = await supabaseClient.from('bots').insert({
                bot_username: botUsername,
                owner: currentUser,
                rules: rules,
                default_reply: defaultReply
            });
            if (error) { showAlertBanner('Could not create bot: ' + error.message, 'error'); return; }

            document.getElementById('newBotUsernameInput').value = '';
            document.getElementById('newBotDefaultReplyInput').value = '';
            document.getElementById('newBotRulesContainer').innerHTML = '';
            addBotRuleRow();

            await fetchAllData();
            renderMyBotsList();
        }

        async function deleteBot(botId) {
            if (!confirm('Delete this bot? Its profile and chat history will remain, but it will stop auto-replying.')) return;
            await supabaseClient.from('bots').delete().eq('id', botId);
            await fetchAllData();
            renderMyBotsList();
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
            if (globalBotsCache.some(b => b.bot_username === chatPartnerUsername)) return; // bots have their own reply logic

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

        async function maybeTriggerBotReply(chatPartnerUsername, incomingText) {
            const bot = globalBotsCache.find(b => b.bot_username === chatPartnerUsername);
            if (!bot) return;

            const lowerText = (incomingText || '').toLowerCase();
            const matchedRule = (bot.rules || []).find(r => r.keyword && lowerText.includes(r.keyword));
            const replyText = matchedRule ? matchedRule.reply : (bot.default_reply || "Sorry, I didn't understand that. 🤖");

            setTimeout(async () => {
                await supabaseClient.from('messages').insert({
                    sender: bot.bot_username,
                    receiver: currentUser,
                    text: replyText
                });
                if (activeChatUser === bot.bot_username) {
                    loadDirectMessages(bot.bot_username, true);
                }
            }, 700); // small delay so the reply doesn't feel instant/robotic
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
        function renderGroupsList() {
            const container = document.getElementById('groupsListContainer');
            if (!container) return;

            const myGroupIds = new Set(globalGroupMembersCache.filter(m => m.username === currentUser).map(m => m.group_id));
            const myGroups = globalGroupsCache.filter(g => myGroupIds.has(g.id));

            if (myGroups.length === 0) {
                container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">No groups yet. Tap "New" to create one.</div>`;
                return;
            }

            container.innerHTML = myGroups.map(g => {
                const memberCount = globalGroupMembersCache.filter(m => m.group_id === g.id).length;
                return `
                    <div onclick="openGroupChat('${g.id}')" class="p-3 flex items-center space-x-3 cursor-pointer hover:bg-slate-800/60 fast-transition">
                        <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-xs text-white shadow"><i class="fa-solid ${g.is_channel ? 'fa-bullhorn' : 'fa-users'}"></i></div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-slate-200 truncate">${g.name} ${g.is_channel ? '<span class="text-[8px] font-bold text-[#ff4d8d] bg-[#ff4d8d]/10 border border-[#ff4d8d]/30 px-1.5 py-0.5 rounded-full ml-1">CHANNEL</span>' : ''}</p>
                            <p class="text-[10px] text-slate-500">${memberCount} ${g.is_channel ? 'subscribers' : 'members'}</p>
                        </div>
                        <button onclick="event.stopPropagation(); openGroupInfoModal('${g.id}')" title="Group Options" class="text-slate-600 hover:text-[#ff4d8d] p-1.5 shrink-0"><i class="fa-solid fa-ellipsis-vertical text-xs"></i></button>
                        <i class="fa-solid fa-chevron-right text-xs text-slate-600"></i>
                    </div>
                `;
            }).join('');
        }

        function openCreateGroupModal() {
            const container = document.getElementById('newGroupMembersContainer');
            // FEATURE: GROUPS FOLLOW GATE — same as Instagram: you can only add people you follow
            // or who follow you (either direction is enough) to a new group.
            const addableUsers = cachedAllUsers.filter(canMessageUser);
            container.innerHTML = addableUsers.map(u => `
                <label class="flex items-center gap-2 p-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-200 cursor-pointer">
                    <input type="checkbox" value="${u}" class="new-group-member-checkbox accent-[#ff4d8d]">
                    <span>${u}</span>
                </label>
            `).join('') || `<p class="text-[10px] text-slate-500 text-center">Follow karo ya jinke follower ho unhi ko group me add kar sakte ho.</p>`;
            document.getElementById('createGroupModal').classList.remove('hidden');
        }

        function closeCreateGroupModal() {
            document.getElementById('createGroupModal').classList.add('hidden');
            document.getElementById('newGroupNameInput').value = '';
            document.getElementById('newGroupIsChannelCheckbox').checked = false;
        }

        async function submitCreateGroup() {
            const name = document.getElementById('newGroupNameInput').value.trim();
            if (!name) { showAlertBanner('Please enter a group name.', 'warning'); return; }
            const checked = Array.from(document.querySelectorAll('.new-group-member-checkbox:checked')).map(c => c.value);
            if (checked.length === 0) { showAlertBanner('Select at least one member.', 'warning'); return; }
            const isChannel = document.getElementById('newGroupIsChannelCheckbox').checked; // FEATURE: CHANNELS

            const { data: group, error } = await supabaseClient.from('groups').insert({ name, created_by: currentUser, is_channel: isChannel }).select().single();
            if (error || !group) { showAlertBanner('Could not create group: ' + (error ? error.message : 'unknown error'), 'error'); return; }

            const members = [...new Set([currentUser, ...checked])].map(u => ({ group_id: group.id, username: u }));
            await supabaseClient.from('group_members').insert(members);

            await fetchAllData();
            closeCreateGroupModal();
            openGroupChat(group.id);
        }

        function openGroupChat(groupId) {
            activeGroupId = groupId;
            document.getElementById('groupsListView').classList.add('hidden');
            document.getElementById('groupRoomView').classList.remove('hidden');

            const group = globalGroupsCache.find(g => g.id === groupId);
            const memberCount = globalGroupMembersCache.filter(m => m.group_id === groupId).length;
            document.getElementById('groupRoomTitle').innerText = group ? group.name : 'Group';
            document.getElementById('groupRoomMemberCount').innerText = `${memberCount} ${group && group.is_channel ? 'subscribers' : 'members'}`;

            // FEATURE: CHANNELS — only the creator can post in a broadcast-only channel
            const canPost = !group || !group.is_channel || group.created_by === currentUser;
            document.getElementById('groupMessageForm').classList.toggle('hidden', !canPost);
            document.getElementById('channelReadOnlyNotice').classList.toggle('hidden', canPost);

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
            const group = globalGroupsCache.find(g => g.id === groupId);
            if (!group) return;

            const memberUsernames = globalGroupMembersCache.filter(m => m.group_id === groupId).map(m => m.username);

            document.getElementById('groupInfoName').innerText = group.name;
            document.getElementById('groupInfoMemberCount').innerText = `${memberUsernames.length} ${group.is_channel ? 'subscriber' : 'member'}${memberUsernames.length === 1 ? '' : 's'}`;

            const container = document.getElementById('groupInfoMembersContainer');
            container.innerHTML = memberUsernames.map(u => {
                const avatarUrl = globalProfilesCache[u];
                const isOnline = onlineUsersSet.has(u);
                const isAdmin = u === group.created_by;
                return `
                    <div class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-900/60">
                        <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-[10px] text-white shadow overflow-hidden relative shrink-0">
                            ${avatarUrl ? `<img src="${avatarUrl}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}
                            ${isOnline ? `<span class="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 border border-slate-950"></span>` : ''}
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-slate-200 truncate">${u}${u === currentUser ? ' (You)' : ''}</p>
                        </div>
                        ${isAdmin ? `<span class="text-[9px] font-bold text-[#ff4d8d] bg-[#ff4d8d]/10 border border-[#ff4d8d]/30 px-2 py-0.5 rounded-full shrink-0">Admin</span>` : ''}
                    </div>
                `;
            }).join('');

            // Only the group's creator (admin) can delete it for everyone; anyone can leave.
            document.getElementById('deleteGroupBtn').classList.toggle('hidden', group.created_by !== currentUser);

            document.getElementById('groupInfoModal').dataset.groupId = groupId;
            document.getElementById('groupInfoModal').classList.remove('hidden');
        }

        function closeGroupInfoModal() {
            document.getElementById('groupInfoModal').classList.add('hidden');
        }

        async function leaveCurrentGroup() {
            const groupId = document.getElementById('groupInfoModal').dataset.groupId;
            const group = globalGroupsCache.find(g => g.id === groupId);
            if (!group) return;

            if (!confirm(`Leave "${group.name}"? Dobara add hone tak aap group messages nahi dekh payenge.`)) return;

            await supabaseClient.from('group_members').delete().eq('group_id', groupId).eq('username', currentUser);

            closeGroupInfoModal();
            if (activeGroupId === groupId) closeGroupRoom();
            await fetchAllData();
            renderGroupsList();
        }

        async function deleteCurrentGroup() {
            const groupId = document.getElementById('groupInfoModal').dataset.groupId;
            const group = globalGroupsCache.find(g => g.id === groupId);
            if (!group) return;

            if (group.created_by !== currentUser) { showAlertBanner('Sirf group admin hi is group ko delete kar sakta hai.', 'warning'); return; }
            if (!confirm(`Delete "${group.name}" permanently for everyone? Ye action undo nahi ho sakta.`)) return;

            await supabaseClient.from('group_messages').delete().eq('group_id', groupId);
            await supabaseClient.from('group_members').delete().eq('group_id', groupId);
            await supabaseClient.from('groups').delete().eq('id', groupId);

            closeGroupInfoModal();
            if (activeGroupId === groupId) closeGroupRoom();
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
                box.innerHTML = `<div class="text-center text-xs text-slate-500 my-auto">No messages yet. Say hi to the group! 👋</div>`;
                updatePinnedBanner('group');
                return;
            }

            const groupHtmlContent = globalGroupMessagesCache.map(msg => {
                const isMe = msg.sender === currentUser;
                const isVideoMedia = msg.media_url && msg.media_url.match(/\.(mp4|mov|webm)$/i);
                const timeLabel = formatMessageTimestamp(new Date(msg.created_at || Date.now()));
                const av = globalProfilesCache[msg.sender];
                const reactionsHtml = renderReactionBadgesHtml(msg.id, 'group');

                return `
                    <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-0.5">
                        ${!isMe ? `<span class="text-[9px] font-bold text-[#ff4d8d] px-1">${msg.sender}</span>` : ''}
                        <div class="max-w-[80%] p-2.5 rounded-2xl text-xs ${isMe ? 'bg-[#ff4d8d] text-white rounded-br-none' : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none'} space-y-1.5 relative group shadow" ondblclick="openReactionPicker(event, '${msg.id}', 'group')">
                            ${msg.media_url ? (
                                isVideoMedia ?
                                `<video src="${msg.media_url}" data-msg-id="${msg.id}" onclick="event.stopPropagation(); openChatMediaTap('${msg.media_url}', true, ${msg.shared_post_id ? `'${msg.shared_post_id}'` : 'null'})" controls playsinline class="w-full max-h-48 rounded-lg object-cover cursor-pointer"></video>` :
                                `<img src="${msg.media_url}" onclick="event.stopPropagation(); openChatMediaTap('${msg.media_url}', false, ${msg.shared_post_id ? `'${msg.shared_post_id}'` : 'null'})" class="w-full max-h-48 rounded-lg object-cover cursor-pointer">`
                            ) : ''}
                            <p class="leading-relaxed break-words">${msg.text}</p>
                            <button onclick="togglePinMessage('${msg.id}', 'group')" class="absolute -bottom-2 ${isMe ? '-right-2' : '-left-2'} ${msg.pinned_at ? 'bg-yellow-500 text-black' : 'bg-slate-800 text-yellow-400'} p-1 rounded-full text-[9px] shadow opacity-0 group-hover:opacity-100 transition" title="${msg.pinned_at ? 'Unpin' : 'Pin'}"><i class="fa-solid fa-thumbtack"></i></button>
                            <button onclick="openReactionPicker(event, '${msg.id}', 'group')" class="absolute -bottom-2 ${isMe ? '-left-2' : 'left-2'} bg-slate-800 text-yellow-400 p-1 rounded-full text-[9px] shadow opacity-0 group-hover:opacity-100 transition" title="React"><i class="fa-solid fa-face-smile"></i></button>
                        </div>
                        ${reactionsHtml}
                        <span class="text-[9px] text-slate-500 px-1">${timeLabel}</span>
                    </div>
                `;
            }).join('');

            if (box.innerHTML !== groupHtmlContent) {
                replaceChatHtmlPreservingVideo(box, groupHtmlContent);
            }

            if (forceScroll) box.scrollTop = box.scrollHeight;
            updatePinnedBanner('group');
        }

        function handleGroupMediaSelect(input) {
            if (input.files && input.files[0]) {
                selectedGroupMediaObject = input.files[0];
                showAlertBanner(`Media attached: ${selectedGroupMediaObject.name}. Now click send.`, 'info');
            }
        }

        async function submitGroupMessage(e) {
            e.preventDefault();
            if (!activeGroupId) return;

            // FEATURE: CHANNELS — guard again here in case the form was still submitted somehow
            const activeGroup = globalGroupsCache.find(g => g.id === activeGroupId);
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
                    const { error: uploadErr } = await supabaseClient.storage.from('media').upload(fileName, selectedGroupMediaObject);
                    if (!uploadErr) {
                        const { data: pubData } = supabaseClient.storage.from('media').getPublicUrl(fileName);
                        mediaUrl = pubData.publicUrl;
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
            const group = globalGroupsCache.find(g => g.id === activeGroupId);
            const members = globalGroupMembersCache.filter(m => m.group_id === activeGroupId).map(m => m.username).filter(u => u !== currentUser);

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
            if (groupCallId === record.group_id) return;
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
                const { error: uploadErr } = await supabaseClient.storage.from('media').upload(fileName, blob, { contentType: 'audio/webm' });
                if (uploadErr) throw uploadErr;
                const { data: pubData } = supabaseClient.storage.from('media').getPublicUrl(fileName);

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
                        <div onclick="handleUserClick('${u}')" class="w-10 h-10 mx-auto rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-xs text-white overflow-hidden cursor-pointer shadow">${av ? `<img src="${av}" class="w-full h-full object-cover">` : u.charAt(0).toUpperCase()}</div>
                        <p class="text-[10px] font-bold text-slate-200 truncate">${u}</p>
                        <p class="text-[8px] text-slate-500">${mutualCount > 0 ? mutualCount + ' mutual' + (mutualCount > 1 ? 's' : '') : 'Suggested'}</p>
                        <button onclick="toggleFollowFromFeed('${u}')" class="w-full bg-[#ff4d8d] hover:bg-[#ff4d8d] text-white text-[9px] font-bold py-1 rounded-lg transition">Follow</button>
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
            btn.className = isAway ? 'w-10 h-5 rounded-full bg-[#9d7bff] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
            document.getElementById('awayMessageInput').value = myProfile.away_message || '';
        }

        // FEATURE: SECRET ADMIRER — teases the person who's interacted with your posts the most
        function renderSecretAdmirer() {
            const card = document.getElementById('secretAdmirerCard');
            const myPostIds = new Set(globalPostsCache.filter(p => p.username === currentUser).map(p => p.id));
            if (myPostIds.size === 0) { card.classList.add('hidden'); card.classList.remove('flex'); return; }

            const scores = {};
            globalLikesCache.filter(l => myPostIds.has(l.post_id) && l.username !== currentUser).forEach(l => {
                scores[l.username] = (scores[l.username] || 0) + 2;
            });
            globalPostViewsCache.filter(v => myPostIds.has(v.post_id) && v.viewer !== currentUser).forEach(v => {
                scores[v.viewer] = (scores[v.viewer] || 0) + 1;
            });

            const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
            if (ranked.length === 0) { card.classList.add('hidden'); card.classList.remove('flex'); return; }

            const [topUser, score] = ranked[0];
            const masked = topUser.charAt(0).toUpperCase() + '•'.repeat(Math.max(topUser.length - 1, 2));
            card.classList.remove('hidden');
            card.classList.add('flex');
            card.innerHTML = `
                <div class="text-xl shrink-0">👀</div>
                <div class="min-w-0">
                    <p class="text-[11px] font-bold text-slate-200">Secret Admirer</p>
                    <p class="text-[10px] text-slate-400">Kisi ka naam <span class="font-bold text-[#ff4d8d]">${masked}</span> se hai — unhone tumhare posts ${score} baar like/view kiye 👀</p>
                </div>
            `;
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
            btn.className = ghostModeEnabled ? 'w-10 h-5 rounded-full bg-[#9d7bff] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
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
                toggleBtn.className = isPrivate ? 'w-10 h-5 rounded-full bg-[#ff4d8d] relative transition shrink-0' : 'w-10 h-5 rounded-full bg-slate-700 relative transition shrink-0';
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
                container.innerHTML = `<p class="text-center text-xs text-slate-500 py-6">Koi pending follow request nahi hai.</p>`;
                return;
            }

            container.innerHTML = pending.map(r => {
                const av = globalProfilesCache[r.requester];
                return `
                    <div class="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl p-2.5">
                        <div class="flex items-center space-x-2 min-w-0">
                            <div onclick="handleUserClick('${r.requester}')" class="w-8 h-8 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-xs text-white overflow-hidden cursor-pointer shrink-0">${av ? `<img src="${av}" class="w-full h-full object-cover">` : r.requester.charAt(0).toUpperCase()}</div>
                            <span class="text-xs font-bold text-slate-200 truncate">${r.requester}</span>
                        </div>
                        <div class="flex gap-1.5 shrink-0">
                            <button onclick="approveFollowRequest('${r.id}', '${r.requester}')" class="bg-[#ff4d8d] hover:bg-[#ff4d8d] text-white text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition">Accept</button>
                            <button onclick="declineFollowRequest('${r.id}')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition">Decline</button>
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
                container.innerHTML = `<div class="text-center text-xs text-slate-500 py-14"><i class="fa-solid fa-bell-slash text-xl mb-2"></i><p>Koi notification abhi tak nahi hai.</p></div>`;
                return;
            }

            container.innerHTML = all.map(ev => {
                const avatar = globalProfilesCache[ev.username];
                const avatarHtml = avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : ev.username.charAt(0).toUpperCase();
                const timeLabel = ev.time ? formatMessageTimestamp(new Date(ev.time)) : '';

                if (ev.type === 'like') {
                    return `
                        <div onclick="closeNotificationsModal(); handleUserClick('${ev.username}')" class="flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-900/60 cursor-pointer transition">
                            <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-xs text-white overflow-hidden shrink-0">${avatarHtml}</div>
                            <p class="flex-1 text-xs text-slate-300 min-w-0"><span class="font-bold text-slate-100">${ev.username}</span> ne tumhari post like ki <i class="fa-solid fa-heart text-[#ff4d8d] ml-0.5"></i></p>
                            <span class="text-[9px] text-slate-500 shrink-0">${timeLabel}</span>
                        </div>`;
                } else if (ev.type === 'follow') {
                    return `
                        <div onclick="closeNotificationsModal(); handleUserClick('${ev.username}')" class="flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-900/60 cursor-pointer transition">
                            <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-xs text-white overflow-hidden shrink-0">${avatarHtml}</div>
                            <p class="flex-1 text-xs text-slate-300 min-w-0"><span class="font-bold text-slate-100">${ev.username}</span> ne tumhe follow kiya <i class="fa-solid fa-user-plus text-[#35c7ff] ml-0.5"></i></p>
                            <span class="text-[9px] text-slate-500 shrink-0">${timeLabel}</span>
                        </div>`;
                } else {
                    return `
                        <div class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-900/40 border border-slate-800">
                            <div onclick="closeNotificationsModal(); handleUserClick('${ev.username}')" class="w-9 h-9 rounded-full bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center font-bold text-xs text-white overflow-hidden shrink-0 cursor-pointer">${avatarHtml}</div>
                            <p class="flex-1 text-xs text-slate-300 min-w-0"><span class="font-bold text-slate-100">${ev.username}</span> ne follow request bheji hai</p>
                            <div class="flex gap-1 shrink-0">
                                <button onclick="approveFollowRequest('${ev.requestId}', '${ev.username}')" class="px-2.5 py-1 rounded-lg bg-[#ff4d8d] text-white text-[10px] font-bold">Accept</button>
                                <button onclick="declineFollowRequest('${ev.requestId}')" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-[10px] font-bold">Decline</button>
                            </div>
                        </div>`;
                }
            }).join('');
        }

        // =====================================================================================
        // FEATURE: DARK / LIGHT THEME TOGGLE
        // =====================================================================================
        function applyTheme(theme) {
            const html = document.documentElement;
            if (theme === 'light') {
                html.classList.remove('dark');
                html.classList.add('light-theme');
                document.getElementById('themeToggleIcon').className = 'fa-solid fa-sun';
            } else {
                html.classList.add('dark');
                html.classList.remove('light-theme');
                document.getElementById('themeToggleIcon').className = 'fa-solid fa-moon';
            }
        }

        function toggleTheme() {
            const current = localStorage.getItem('nexus_theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem('nexus_theme', next);
            applyTheme(next);
        }

        // Apply saved theme preference immediately on load
        applyTheme(localStorage.getItem('nexus_theme') || 'dark');

        // =====================================================================================
        // FEATURE: POST ANALYTICS (views + reach on own posts)
        // =====================================================================================
        async function logPostView(postId) {
            if (ghostModeEnabled) return;
            if (trackedPostViewIds.has(postId)) return;
            trackedPostViewIds.add(postId);
            const post = globalPostsCache.find(p => String(p.id) === String(postId));
            if (post && post.username === currentUser) return; // don't count your own views

            try {
                const alreadyViewed = globalPostViewsCache.some(v => v.post_id === postId && v.viewer === currentUser);
                if (alreadyViewed) return;
                await supabaseClient.from('post_views').insert({ post_id: postId, viewer: currentUser });
                globalPostViewsCache.push({ post_id: postId, viewer: currentUser });
            } catch (err) {
                // Non-fatal - analytics migration may not be run yet
            }
        }

        function openPostAnalyticsModal(postId) {
            const post = globalPostsCache.find(p => String(p.id) === String(postId));
            if (!post) return;
            const views = globalPostViewsCache.filter(v => v.post_id === postId);
            const uniqueReach = new Set(views.map(v => v.viewer)).size;
            const likeCount = globalLikesCache.filter(l => l.post_id === postId).length;
            const commentCount = globalCommentsCache.filter(c => c.post_id === postId).length;

            document.getElementById('postAnalyticsContent').innerHTML = `
                <div class="grid grid-cols-2 gap-2.5">
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-emerald-400">${views.length}</p>
                        <p class="text-[9px] text-slate-500 tracking-wide">Views</p>
                    </div>
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-[#35c7ff]">${uniqueReach}</p>
                        <p class="text-[9px] text-slate-500 tracking-wide">Reach</p>
                    </div>
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-[#ff4d8d]">${likeCount}</p>
                        <p class="text-[9px] text-slate-500 tracking-wide">Likes</p>
                    </div>
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
                        <p class="text-lg font-display font-bold text-[#9d7bff]">${commentCount}</p>
                        <p class="text-[9px] text-slate-500 tracking-wide">Comments</p>
                    </div>
                </div>
                <p class="text-[9px] text-slate-500 text-center pt-1">Views count how many times this post was opened or scrolled into view. Reach counts unique people.</p>
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

        // FEATURE: AI SMART REPLIES
        async function generateSmartReplies(recentMsgs) {
            const wrap = document.getElementById('smartReplyChips');
            try {
                const transcript = recentMsgs.map(m => `${m.sender === currentUser ? 'Main' : m.sender}: ${m.text || '[media]'}`).join('\n');
                const prompt = `Yeh ek chat ka recent transcript hai:\n${transcript}\n\nMujhe iska jawab dene ke liye 3 bahut chhote (max 6 shabd), casual, alag-alag tone ke quick-reply options do. Sirf ek JSON array of 3 strings ke roop mein jawab do, kuch aur text nahi likhna. Example: ["Haan bilkul!", "Abhi busy hoon", "😂😂 sahi hai"]`;
                const raw = await askNexusAIOnce(prompt, "Tum ek chat app ka smart-reply generator ho. Sirf requested JSON array return karo, koi extra text ya markdown nahi.");
                const match = raw.match(/\[[\s\S]*\]/);
                const options = match ? JSON.parse(match[0]) : [];
                if (!Array.isArray(options) || options.length === 0) throw new Error('empty');

                wrap.innerHTML = options.slice(0, 3).map(opt =>
                    `<button onclick="useSmartReply(${JSON.stringify(opt)})" class="shrink-0 bg-slate-900 border border-slate-800 hover:border-[#35c7ff] text-slate-300 text-[10.5px] font-semibold px-2.5 py-1.5 rounded-full transition whitespace-nowrap">${opt}</button>`
                ).join('');
                wrap.classList.remove('hidden');
                wrap.classList.add('flex');
            } catch (e) {
                hideSmartReplies();
            }
        }
        function hideSmartReplies() {
            const wrap = document.getElementById('smartReplyChips');
            wrap.classList.add('hidden');
            wrap.classList.remove('flex');
            wrap.innerHTML = '';
        }
        function useSmartReply(text) {
            document.getElementById('chatInputText').value = text;
            hideSmartReplies();
            document.getElementById('chatInputText').focus();
        }

        // FEATURE: AI CHAT VIBE SUMMARY
        async function summarizeChatVibe() {
            const btn = document.getElementById('chatVibeBtn');
            const targetUser = activeChatUser;
            if (!targetUser) return;
            const original = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs"></i>';
            try {
                const { data: rawMessages } = await supabaseClient
                    .from('messages').select('*')
                    .or(`and(sender.eq.${currentUser},receiver.eq.${targetUser}),and(sender.eq.${targetUser},receiver.eq.${currentUser})`)
                    .order('created_at', { ascending: false }).limit(25);
                const recent = (rawMessages || []).reverse().filter(m => m.text);
                if (recent.length === 0) { showAlertBanner('Summarize karne ke liye abhi koi text message nahi hai.', 'warning'); return; }

                const transcript = recent.map(m => `${m.sender === currentUser ? 'Main' : m.sender}: ${m.text}`).join('\n');
                const prompt = `Is chat transcript ko padho aur 2-3 chhoti lines mein bta do: overall vibe/mood kya hai, kya baat ho rahi hai. Casual Hinglish mein, emoji ke sath.\n\n${transcript}`;
                const summary = await askNexusAIOnce(prompt, "Tum ek chat vibe-checker ho. Short, casual, friendly Hinglish summary do — 2-3 lines se zyada nahi.");
                showInAppBanner(`✨ Vibe Check: ${targetUser}`, summary || "Kuch khaas pata nahi chala, chat continue karo!");
            } catch (e) {
                // BUGFIX: previously silent — no console output — so a broken AI call or a
                // bad Supabase query for message history was completely undiagnosable.
                console.error("summarizeChatVibe failed for chat with:", targetUser, e);
                showAlertBanner('Vibe check abhi available nahi hai, thodi der baad try karo.', 'error');
            } finally {
                btn.innerHTML = original;
            }
        }

        const AI_QUICK_ACTIONS = [
            { label: "✍️ Suggest a caption", prompt: "AI_ACTION_CAPTION" },
            { label: "👤 Improve my bio", prompt: "Mere liye ek catchy, short social media bio likho." },
            { label: "#️⃣ Trending hashtags", prompt: "Mujhe kuch trending/relevant hashtag ideas do meri niche ke liye — pucho pehle meri niche kya hai." },
            { label: "💬 Chat icebreaker", prompt: "Kisi naye follower ko message karne ke liye ek achha, friendly icebreaker line do." }
        ];

        let aiChatHistory = [];
        let aiLastUserText = "";
        let aiInitialized = false;

        function aiStorageKey() { return 'nexus_ai_chat_' + (currentUser || 'guest'); }

        function initAiAssistant() {
            renderAiQuickActions();
            if (aiInitialized) return;
            aiInitialized = true;
            try {
                aiChatHistory = JSON.parse(localStorage.getItem(aiStorageKey()) || "[]");
            } catch (e) { aiChatHistory = []; }

            const container = document.getElementById('aiMessages');
            if (aiChatHistory.length === 0) {
                addAiMessageToUI('bot', 'Hi ' + (currentUser || '') + '! Main Nexus AI hoon 👋 Caption, bio, hashtags — kuch bhi pucho.', false);
            } else {
                aiChatHistory.forEach(turn => {
                    addAiMessageToUI(turn.role === 'user' ? 'user' : 'bot', turn.parts[0].text, false);
                });
            }
            container.scrollTop = container.scrollHeight;
        }

        function renderAiQuickActions() {
            const wrap = document.getElementById('aiQuickActions');
            wrap.innerHTML = AI_QUICK_ACTIONS.map((a, i) =>
                `<button onclick="runAiQuickAction(${i})" class="shrink-0 bg-slate-900 border border-slate-800 hover:border-[#ff4d8d] text-slate-300 text-[10.5px] font-bold px-2.5 py-1.5 rounded-full transition">${a.label}</button>`
            ).join('');
        }

        function runAiQuickAction(i) {
            const action = AI_QUICK_ACTIONS[i];
            if (action.prompt === "AI_ACTION_CAPTION") {
                const draft = (document.getElementById('postContentInput') || {}).value || "";
                const prompt = draft.trim()
                    ? `Mere is post draft ke liye 3 catchy caption options suggest karo:\n"${draft.trim()}"`
                    : "Mujhe ek social media post ke liye 3 catchy caption ideas do (general/aesthetic vibe).";
                sendAiMessage(prompt);
            } else {
                sendAiMessage(action.prompt);
            }
        }

        function clearAiChat() {
            aiChatHistory = [];
            localStorage.removeItem(aiStorageKey());
            document.getElementById('aiMessages').innerHTML = '';
            addAiMessageToUI('bot', 'Chat clear ho gayi. Kuch bhi pucho!', false);
        }

        function aiAutoResize(el) {
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 96) + 'px';
        }

        function formatAiText(text) {
            const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return escaped
                .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
                .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener" class="text-[#35c7ff] underline">$1</a>');
        }

        function addAiMessageToUI(role, text, showMeta = true) {
            const container = document.getElementById('aiMessages');
            const wrap = document.createElement('div');
            wrap.className = role === 'user' ? 'flex flex-col items-end' : 'flex items-start gap-2';

            if (role === 'bot') {
                const avatar = document.createElement('div');
                avatar.className = 'w-6 h-6 rounded-lg bg-gradient-to-tr from-[#9d7bff] to-[#ff4d8d] flex items-center justify-center text-white text-[10px] shadow shrink-0 mt-0.5';
                avatar.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
                wrap.appendChild(avatar);
            }

            const col = document.createElement('div');
            col.className = 'flex flex-col max-w-[80%] ' + (role === 'user' ? 'items-end' : 'items-start');

            const bubble = document.createElement('div');
            bubble.className = role === 'user'
                ? 'bg-gradient-to-r from-[#9d7bff] to-[#ff4d8d] text-white text-xs leading-relaxed px-3 py-2 rounded-2xl rounded-br-sm shadow whitespace-pre-wrap break-words'
                : 'bg-slate-900 border border-slate-800 text-slate-200 text-xs leading-relaxed px-3 py-2 rounded-2xl rounded-bl-sm whitespace-pre-wrap break-words';
            bubble.innerHTML = formatAiText(text);
            col.appendChild(bubble);

            if (showMeta && role === 'bot') {
                const meta = document.createElement('div');
                meta.className = 'flex items-center gap-2 mt-1 px-1';
                const time = document.createElement('span');
                time.className = 'text-[9px] text-slate-500';
                time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const copyBtn = document.createElement('button');
                copyBtn.className = 'text-[9px] text-slate-500 hover:text-[#ff4d8d] font-bold';
                copyBtn.textContent = 'Copy';
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(bubble.textContent);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => copyBtn.textContent = 'Copy', 1200);
                };
                meta.appendChild(time);
                meta.appendChild(copyBtn);
                col.appendChild(meta);
            }

            wrap.appendChild(col);
            container.appendChild(wrap);
            container.scrollTop = container.scrollHeight;
            return bubble;
        }

        function addAiRetryButton() {
            const container = document.getElementById('aiMessages');
            const btn = document.createElement('button');
            btn.className = 'ml-8 bg-slate-900 border border-slate-800 hover:border-[#ff4d8d] text-slate-300 text-[10px] font-bold px-2.5 py-1 rounded-full';
            btn.innerHTML = '<i class="fa-solid fa-rotate-right mr-1"></i>Retry';
            btn.onclick = () => { btn.remove(); sendAiMessage(aiLastUserText); };
            container.appendChild(btn);
            container.scrollTop = container.scrollHeight;
        }

        async function sendAiMessage(forcedText) {
            const input = document.getElementById('aiInput');
            const text = (forcedText !== undefined ? forcedText : input.value.trim());
            if (!text) return;

            aiLastUserText = text;
            if (forcedText === undefined) {
                input.value = '';
                aiAutoResize(input);
                addAiMessageToUI('user', text, false);
            }
            document.getElementById('aiSendBtn').disabled = true;

            aiChatHistory.push({ role: 'user', parts: [{ text: text }] });

            const botBubble = addAiMessageToUI('bot', 'Type kar raha hai...');
            botBubble.classList.add('italic', 'text-slate-500');
            let streamedText = '';
            let gotFirstChunk = false;

            try {
                const response = await fetch(`${SUPABASE_URL}/functions/v1/ai_chat`,
    {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: AI_SYSTEM_INSTRUCTION }] },
            generationConfig: {
                maxOutputTokens: 1024,
                thinkingConfig: { thinkingBudget: 0 }
            },
            safetySettings: AI_SAFETY_SETTINGS,
            contents: aiChatHistory
        })
    }
);

                if (!response.ok || !response.body) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error ? errData.error.message : `HTTP ${response.status}`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let lastCand = null;
                let promptBlockReason = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const frames = buffer.split('\n\n');
                    buffer = frames.pop();

                    for (const frame of frames) {
                        const line = frame.trim();
                        if (!line.startsWith('data:')) continue;
                        const jsonStr = line.slice(5).trim();
                        if (!jsonStr) continue;
                        try {
                            const parsed = JSON.parse(jsonStr);

                            if (parsed.promptFeedback && parsed.promptFeedback.blockReason) {
                                promptBlockReason = parsed.promptFeedback.blockReason;
                            }

                            const cand = parsed.candidates && parsed.candidates[0];
                            if (cand) lastCand = cand;

                            // Gemini "thinking" models can send multiple parts per chunk —
                            // some are internal reasoning (part.thought === true) and must be
                            // skipped; only concatenate the real answer text parts.
                            const allParts = (cand && cand.content && cand.content.parts) || [];
                            const piece = allParts
                                .filter(p => !p.thought && typeof p.text === 'string')
                                .map(p => p.text)
                                .join('');

                            if (piece) {
                                streamedText += piece;
                                if (!gotFirstChunk) {
                                    botBubble.classList.remove('italic', 'text-slate-500');
                                    gotFirstChunk = true;
                                }
                                botBubble.innerHTML = formatAiText(streamedText);
                                document.getElementById('aiMessages').scrollTop = document.getElementById('aiMessages').scrollHeight;
                            }
                        } catch (e) { /* incomplete chunk, ignore */ }
                    }
                }

                if (!streamedText) {
                    // Nothing came through — log full diagnostics to console so the real
                    // cause (safety block, finishReason, empty candidates, etc.) is visible
                    // via F12 > Console, instead of just failing silently.
                    console.warn('Nexus AI: empty response.', {
                        promptBlockReason,
                        lastCandidate: lastCand
                    });
                    if (promptBlockReason) {
                        streamedText = `⚠️ Request block ho gayi (reason: ${promptBlockReason}). Sawaal thoda reword karke try karo.`;
                    } else if (lastCand && lastCand.finishReason && lastCand.finishReason !== 'STOP') {
                        streamedText = `⚠️ Jawab generate nahi hua (reason: ${lastCand.finishReason}). Dobara try karo ya sawaal thoda alag se pucho.`;
                    } else {
                        streamedText = 'Sorry, main is baat ka jawab nahi de sakta. Kuch aur pucho?';
                    }
                }
                botBubble.classList.remove('italic', 'text-slate-500');
                botBubble.innerHTML = formatAiText(streamedText);

                aiChatHistory.push({ role: 'model', parts: [{ text: streamedText }] });
                localStorage.setItem(aiStorageKey(), JSON.stringify(aiChatHistory.slice(-30)));

                const meta = document.createElement('div');
                meta.className = 'flex items-center gap-2 mt-1 px-1';
                const time = document.createElement('span');
                time.className = 'text-[9px] text-slate-500';
                time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const copyBtn = document.createElement('button');
                copyBtn.className = 'text-[9px] text-slate-500 hover:text-[#ff4d8d] font-bold';
                copyBtn.textContent = 'Copy';
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(botBubble.textContent);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => copyBtn.textContent = 'Copy', 1200);
                };
                meta.appendChild(time);
                meta.appendChild(copyBtn);
                botBubble.parentElement.appendChild(meta);

            } catch (err) {
                botBubble.classList.remove('italic', 'text-slate-500');
                botBubble.classList.add('border-red-500/60', 'text-red-300');
                botBubble.textContent = '⚠️ ' + err.message;
                aiChatHistory.pop();
                addAiRetryButton();
            } finally {
                document.getElementById('aiSendBtn').disabled = false;
            }
        }
