// ============================================================
// SocialNexus — app.js
// Plain JS, no framework, talks directly to Supabase.
// Organized in sections — search for the "====" headers.
//
// Features 1-10 kept from the original build. Features 11-20
// added below: Group Chat, Channels, 1-1 Calls, Group Calls,
// Voice Notes, Pinned Messages, Custom Chat Themes, Fading
// Messages, Nexus AI Assistant, AI Smart Replies.
//
// NOTE on "AI" features (19 & 20): there's no AI API key in
// this project, so the assistant runs as a fast, on-device
// heuristic (keyword + template based) rather than calling a
// paid LLM. It's wired up so you can later swap
// generateAiCaption()/generateAiBio()/generateSmartReplies()
// for a call to a Supabase Edge Function without touching the
// UI code.
// ============================================================

let currentUser = null;      // Supabase auth user
let currentProfile = null;   // row from public.profiles
let viewedStoryIds = new Set();
let storyGroups = [];        // [{userId, username, avatarUrl, stories:[...]}]
let storyGroupIndex = 0;
let storyIndex = 0;
let storyAdvanceTimer = null;

let activeConversationId = null;
let activeConversationName = "";
let activeConversationType = "direct";   // 'direct' | 'group' | 'channel'
let activeConversationTheme = "aurora";
let activeConversationIsAdmin = false;
let activeConversationMemberCount = 0;
let lastIncomingMessage = null;

const FADE_WINDOW_MS = 60 * 1000; // demo window: fades if unreplied within 60s

// ---------------- Small helpers ----------------
function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function linkifyCaption(text) {
  const escaped = escapeHtml(text || "");
  return escaped.replace(/#(\w+)/g, '<span class="tag" data-tag="$1">#$1</span>');
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  return Math.floor(diff / 86400) + "d";
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function extOf(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "bin";
}

// ============================================================
// AUTH
// ============================================================
function initAuthTabs() {
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const isLogin = tab.dataset.tab === "login";
      $("loginForm").classList.toggle("hidden", !isLogin);
      $("signupForm").classList.toggle("hidden", isLogin);
    });
  });
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) $("loginError").textContent = error.message;
});

$("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("signupError").textContent = "";
  const username = $("signupUsername").value.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "");
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;

  if (username.length < 3) {
    $("signupError").textContent = "Username must be at least 3 characters (letters, numbers, _ .)";
    return;
  }

  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  if (error) { $("signupError").textContent = error.message; return; }

  if (data.user) {
    const { error: profileError } = await supabaseClient
      .from("profiles")
      .insert({ id: data.user.id, username });
    if (profileError) {
      console.error(profileError);
      const msg = (profileError.message || "").toLowerCase();
      $("signupError").textContent = msg.includes("duplicate") || msg.includes("unique")
        ? "That username is already taken."
        : "Could not save profile: " + profileError.message
          + " (tip: if 'Confirm email' is ON in Supabase Auth settings, there's no active session yet — turn it off while testing, or the profile will get created on first login instead).";
      return;
    }
  }
  showToast("Account created! Check your email if confirmation is required.");
});

$("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
});

async function ensureProfileLoaded() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, username, avatar_url, bio")
    .eq("id", currentUser.id)
    .single();
  if (!error) currentProfile = data;
}

supabaseClient.auth.onAuthStateChange(async (_event, session) => {
  if (session && session.user) {
    currentUser = session.user;
    await ensureProfileLoaded();
    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    await bootApp();
  } else {
    currentUser = null;
    currentProfile = null;
    $("app").classList.add("hidden");
    $("authScreen").classList.remove("hidden");
  }
});

// ============================================================
// NAVIGATION (top nav now — see initNav)
// ============================================================
function initNav() {
  document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  $("openProfileBtn").addEventListener("click", openProfileModal);
}

function switchView(viewId) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(viewId).classList.add("active");
  document.querySelectorAll(".nav-btn[data-view]").forEach(b => {
    b.classList.toggle("active", b.dataset.view === viewId);
  });
  if (viewId === "exploreView") loadExplore();
  if (viewId === "chatView") loadConversations();
}

// ============================================================
// PROFILE + NEXUS AI ASSISTANT for bio (Feature 19)
// ============================================================
function openProfileModal() {
  $("profileUsernameLabel").textContent = currentProfile ? "@" + currentProfile.username : "";
  $("profileBio").value = (currentProfile && currentProfile.bio) || "";
  $("profileError").textContent = "";
  $("profileModal").classList.remove("hidden");
}

function generateAiBio(username, seedWords) {
  const vibes = ["quietly curious", "chronic overthinker", "here for the vibes", "collecting small moments", "making things & sharing them"];
  const vibe = vibes[Math.floor(Math.random() * vibes.length)];
  const extra = seedWords ? ` · ${seedWords}` : "";
  return `${vibe}${extra} ✦ @${username}`.slice(0, 150);
}

function initProfileModal() {
  $("closeProfileBtn").addEventListener("click", () => $("profileModal").classList.add("hidden"));
  $("aiAssistBioBtn").addEventListener("click", () => {
    const seed = $("profileBio").value.trim().split(/\s+/).slice(0, 3).join(" ");
    $("profileBio").value = generateAiBio(currentProfile ? currentProfile.username : "you", seed);
    showToast("Nexus AI drafted a bio — tweak it and hit Save");
  });
  $("saveProfileBtn").addEventListener("click", async () => {
    $("profileError").textContent = "";
    const bio = $("profileBio").value.trim();
    const { error } = await supabaseClient.from("profiles").update({ bio }).eq("id", currentUser.id);
    if (error) { $("profileError").textContent = "Could not save: " + error.message; return; }
    currentProfile.bio = bio;
    $("profileModal").classList.add("hidden");
    showToast("Profile saved");
  });
}

// ============================================================
// FEED (Feature 1 Feed Posts, 2 Carousel, 3 Reels, 7 Pinned)
// ============================================================
async function loadFeed() {
  const { data, error } = await supabaseClient
    .from("posts")
    .select(`
      id, caption, type, is_pinned, created_at, user_id,
      profiles:user_id ( username, avatar_url ),
      post_media ( id, media_url, media_type, position ),
      likes ( user_id ),
      comments ( id, content, created_at, user_id, profiles:user_id ( username ) )
    `)
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .order("position", { foreignTable: "post_media", ascending: true })
    .order("created_at", { foreignTable: "comments", ascending: true });

  if (error) { console.error(error); showToast("Could not load feed"); return; }

  const feedList = $("feedList");
  feedList.innerHTML = "";

  if (!data || data.length === 0) {
    feedList.innerHTML = `<div class="empty-state">No posts yet. Be the first to share something.</div>`;
    return;
  }

  data.forEach(post => feedList.appendChild(renderPostCard(post)));
}

function renderPostCard(post) {
  const card = document.createElement("article");
  card.className = "post-card" + (post.is_pinned ? " pinned" : "");

  const liked = post.likes.some(l => l.user_id === currentUser.id);
  const username = post.profiles ? post.profiles.username : "unknown";
  const avatar = post.profiles && post.profiles.avatar_url
    ? post.profiles.avatar_url
    : "";

  let mediaHtml = "";
  if (post.type === "reel" && post.post_media[0]) {
    mediaHtml = `<div class="post-media-wrap">
        <video src="${post.post_media[0].media_url}" playsinline muted loop controls></video>
        <span class="reel-badge">Reel</span>
      </div>`;
  } else if (post.post_media.length > 1) {
    const slides = post.post_media.map(m =>
      m.media_type === "video"
        ? `<video src="${m.media_url}" playsinline muted controls></video>`
        : `<img src="${m.media_url}" alt="" />`
    ).join("");
    const dots = post.post_media.map(() => "<span></span>").join("");
    mediaHtml = `<div class="post-media-wrap">
        <div class="carousel-track">${slides}</div>
        <div class="carousel-dots">${dots}</div>
      </div>`;
  } else if (post.post_media.length === 1) {
    const m = post.post_media[0];
    mediaHtml = `<div class="post-media-wrap">
        ${m.media_type === "video"
          ? `<video src="${m.media_url}" playsinline muted controls></video>`
          : `<img src="${m.media_url}" alt="" />`}
      </div>`;
  }

  const commentsHtml = post.comments.map(c => `
    <div class="comment-row">
      <b>${escapeHtml(c.profiles ? c.profiles.username : "user")}</b>${escapeHtml(c.content)}
    </div>
  `).join("");

  card.innerHTML = `
    ${post.is_pinned ? `<div class="pin-flag">📌 Pinned</div>` : ""}
    <div class="post-head">
      ${avatar ? `<img class="avatar" src="${avatar}" alt="">` : `<div class="avatar"></div>`}
      <div>
        <div class="post-username">${escapeHtml(username)}</div>
        <div class="post-time">${timeAgo(post.created_at)}</div>
      </div>
    </div>
    ${mediaHtml}
    <div class="post-body">
      ${post.caption ? `<p class="post-caption">${linkifyCaption(post.caption)}</p>` : ""}
      <div class="post-actions">
        <button class="action-btn like-btn ${liked ? "liked" : ""}" data-post="${post.id}" data-liked="${liked}" title="Like this post">
          ${liked ? "♥" : "♡"} ${post.likes.length}
        </button>
        <button class="action-btn comment-toggle" data-post="${post.id}" title="View / add comments">💬 ${post.comments.length}</button>
      </div>
      <div class="comment-list hidden" id="comments-${post.id}">${commentsHtml}</div>
      <form class="comment-form hidden" id="comment-form-${post.id}" data-post="${post.id}">
        <input type="text" placeholder="Add a comment..." maxlength="1000" />
        <button type="submit" class="btn-primary small" title="Post comment">Post</button>
      </form>
    </div>
  `;

  card.querySelector(".like-btn").addEventListener("click", (e) => toggleLike(e.currentTarget));
  card.querySelector(".comment-toggle").addEventListener("click", () => {
    card.querySelector(`#comments-${post.id}`).classList.toggle("hidden");
    card.querySelector(`#comment-form-${post.id}`).classList.toggle("hidden");
  });
  card.querySelector(`#comment-form-${post.id}`).addEventListener("submit", submitComment);
  card.querySelectorAll(".tag").forEach(tagEl => {
    tagEl.addEventListener("click", () => {
      switchView("exploreView");
      setTimeout(() => filterByHashtag(tagEl.dataset.tag), 150);
    });
  });

  return card;
}

async function toggleLike(btn) {
  const postId = btn.dataset.post;
  const liked = btn.dataset.liked === "true";
  if (liked) {
    await supabaseClient.from("likes").delete().eq("post_id", postId).eq("user_id", currentUser.id);
  } else {
    await supabaseClient.from("likes").insert({ post_id: postId, user_id: currentUser.id });
  }
  loadFeed();
}

async function submitComment(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const input = form.querySelector("input");
  const content = input.value.trim();
  if (!content) return;
  const { error } = await supabaseClient.from("comments").insert({
    post_id: form.dataset.post,
    user_id: currentUser.id,
    content
  });
  if (error) { showToast("Comment failed"); return; }
  input.value = "";
  loadFeed();
}

// ============================================================
// COMPOSER (create post / reel + hashtags + Nexus AI Assistant)
// ============================================================
let composerType = "post";
let composerFilesSelected = [];

function initComposer() {
  $("openComposerBtn").addEventListener("click", () => $("composerModal").classList.remove("hidden"));
  $("closeComposerBtn").addEventListener("click", () => $("composerModal").classList.add("hidden"));

  document.querySelectorAll(".type-btn[data-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".type-btn[data-type]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      composerType = btn.dataset.type;
      $("composerFiles").accept = composerType === "reel" ? "video/*" : "image/*";
      $("composerFiles").multiple = composerType !== "reel";
    });
  });

  $("composerFiles").addEventListener("change", (e) => {
    composerFilesSelected = Array.from(e.target.files);
    const preview = $("composerPreview");
    preview.innerHTML = "";
    composerFilesSelected.forEach(f => {
      const url = URL.createObjectURL(f);
      preview.insertAdjacentHTML("beforeend",
        f.type.startsWith("video") ? `<video src="${url}" muted></video>` : `<img src="${url}">`
      );
    });
  });

  $("submitPostBtn").addEventListener("click", createPost);
  $("aiAssistCaptionBtn").addEventListener("click", runAiCaptionAssist);
}

// Feature 19 — Nexus AI Assistant: caption + hashtag suggestions.
// Heuristic/on-device version (no external AI key configured).
const AI_HASHTAG_BANK = {
  default: ["nexus", "goodvibes", "moment", "mood"],
  photo: ["photodump", "aesthetic", "nexus"],
  reel: ["reel", "watchthis", "nexus"]
};

function generateAiCaption(seedText, type) {
  const openers = ["Chasing this feeling", "A little moment worth keeping", "Not much to say, just felt like this", "Here for it", "Small win today"];
  const opener = openers[Math.floor(Math.random() * openers.length)];
  const base = seedText ? `${opener} — ${seedText}` : opener;
  const bankKey = type === "reel" ? "reel" : "photo";
  const tags = [...new Set([...AI_HASHTAG_BANK[bankKey], ...AI_HASHTAG_BANK.default])].slice(0, 4);
  return `${base} ${tags.map(t => "#" + t).join(" ")}`;
}

function runAiCaptionAssist() {
  const seed = $("composerCaption").value.trim();
  const suggestion = generateAiCaption(seed, composerType);
  $("composerCaption").value = suggestion;
  showToast("Nexus AI suggested a caption + hashtags");
}

async function extractAndLinkHashtags(caption, postId) {
  const matches = [...new Set((caption.match(/#(\w+)/g) || []).map(t => t.slice(1).toLowerCase()))];
  for (const tag of matches) {
    await supabaseClient.from("hashtags").upsert({ tag }, { onConflict: "tag", ignoreDuplicates: true });
    const { data: tagRow } = await supabaseClient.from("hashtags").select("id").eq("tag", tag).single();
    if (tagRow) {
      await supabaseClient.from("post_hashtags").insert({ post_id: postId, hashtag_id: tagRow.id });
    }
  }
}

async function createPost() {
  $("composerError").textContent = "";
  const caption = $("composerCaption").value.trim();
  const isPinned = $("composerPin").checked;

  if (composerFilesSelected.length === 0 && !caption) {
    $("composerError").textContent = "Add a photo/video or write something.";
    return;
  }

  $("submitPostBtn").disabled = true;
  try {
    const { data: post, error: postError } = await supabaseClient
      .from("posts")
      .insert({ user_id: currentUser.id, caption, type: composerType, is_pinned: isPinned })
      .select()
      .single();
    if (postError) throw postError;

    let position = 0;
    for (const file of composerFilesSelected) {
      const path = `${currentUser.id}/${crypto.randomUUID()}.${extOf(file.name)}`;
      const { error: uploadError } = await supabaseClient.storage
        .from("post-media")
        .upload(path, file, { cacheControl: "3600", upsert: false });
      if (uploadError) throw uploadError;

      const { data: pub } = supabaseClient.storage.from("post-media").getPublicUrl(path);
      await supabaseClient.from("post_media").insert({
        post_id: post.id,
        media_url: pub.publicUrl,
        media_type: file.type.startsWith("video") ? "video" : "image",
        position: position++
      });
    }

    if (caption) await extractAndLinkHashtags(caption, post.id);

    $("composerModal").classList.add("hidden");
    $("composerCaption").value = "";
    $("composerFiles").value = "";
    $("composerPreview").innerHTML = "";
    $("composerPin").checked = false;
    composerFilesSelected = [];
    showToast("Posted!");
    loadFeed();
  } catch (err) {
    console.error(err);
    $("composerError").textContent = "Something went wrong: " + err.message;
  } finally {
    $("submitPostBtn").disabled = false;
  }
}

// ============================================================
// EXPLORE / HASHTAGS (Feature 8)
// ============================================================
let activeHashtagFilter = null;

async function loadExplore() {
  const { data: tags } = await supabaseClient.from("hashtags").select("id, tag");
  const cloud = $("hashtagCloud");
  cloud.innerHTML = "";

  if (!tags || tags.length === 0) {
    cloud.innerHTML = `<p class="empty-state">No hashtags yet — add #tags to a caption.</p>`;
    $("exploreFeed").innerHTML = "";
    return;
  }

  const withCounts = await Promise.all(tags.map(async t => {
    const { count } = await supabaseClient
      .from("post_hashtags")
      .select("*", { count: "exact", head: true })
      .eq("hashtag_id", t.id);
    return { ...t, count: count || 0 };
  }));
  withCounts.sort((a, b) => b.count - a.count);

  withCounts.slice(0, 25).forEach(t => {
    const chip = document.createElement("button");
    chip.className = "hashtag-chip" + (activeHashtagFilter === t.tag ? " active" : "");
    chip.textContent = `#${t.tag} · ${t.count}`;
    chip.addEventListener("click", () => filterByHashtag(t.tag));
    cloud.appendChild(chip);
  });

  if (activeHashtagFilter) {
    filterByHashtag(activeHashtagFilter);
  } else {
    $("exploreFeed").innerHTML = `<p class="empty-state">Tap a hashtag to see its posts.</p>`;
  }
}

async function filterByHashtag(tag) {
  activeHashtagFilter = tag;
  document.querySelectorAll(".hashtag-chip").forEach(c => {
    c.classList.toggle("active", c.textContent.startsWith(`#${tag} `));
  });

  const { data: tagRow } = await supabaseClient.from("hashtags").select("id").eq("tag", tag).single();
  if (!tagRow) return;
  const { data: links } = await supabaseClient.from("post_hashtags").select("post_id").eq("hashtag_id", tagRow.id);
  const postIds = (links || []).map(l => l.post_id);
  const exploreFeed = $("exploreFeed");
  exploreFeed.innerHTML = "";

  if (postIds.length === 0) {
    exploreFeed.innerHTML = `<div class="empty-state">No posts with #${escapeHtml(tag)} yet.</div>`;
    return;
  }

  const { data: posts } = await supabaseClient
    .from("posts")
    .select(`
      id, caption, type, is_pinned, created_at, user_id,
      profiles:user_id ( username, avatar_url ),
      post_media ( id, media_url, media_type, position ),
      likes ( user_id ),
      comments ( id, content, created_at, user_id, profiles:user_id ( username ) )
    `)
    .in("id", postIds)
    .order("created_at", { ascending: false });

  (posts || []).forEach(post => exploreFeed.appendChild(renderPostCard(post)));
}

// ============================================================
// STORIES (Feature 4 Stories, 5 Reverse Reveal, 6 Reply via DM)
// ============================================================
function initStoryModal() {
  $("addStoryBtn").addEventListener("click", () => $("storyModal").classList.remove("hidden"));
  $("closeStoryModalBtn").addEventListener("click", () => $("storyModal").classList.add("hidden"));

  $("storyFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const preview = $("storyPreview");
    preview.innerHTML = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    preview.innerHTML = file.type.startsWith("video")
      ? `<video src="${url}" muted></video>`
      : `<img src="${url}">`;
  });

  $("submitStoryBtn").addEventListener("click", uploadStory);
  $("closeStoryViewerBtn").addEventListener("click", closeStoryViewer);
}

async function uploadStory() {
  $("storyError").textContent = "";
  const file = $("storyFile").files[0];
  if (!file) { $("storyError").textContent = "Choose a photo or video first."; return; }

  $("submitStoryBtn").disabled = true;
  try {
    const path = `${currentUser.id}/${crypto.randomUUID()}.${extOf(file.name)}`;
    const { error: uploadError } = await supabaseClient.storage
      .from("story-media")
      .upload(path, file, { cacheControl: "3600", upsert: false });
    if (uploadError) throw uploadError;

    const { data: pub } = supabaseClient.storage.from("story-media").getPublicUrl(path);
    const { error: insertError } = await supabaseClient.from("stories").insert({
      user_id: currentUser.id,
      media_url: pub.publicUrl,
      media_type: file.type.startsWith("video") ? "video" : "image",
      is_reverse_reveal: $("storyReverseReveal").checked
    });
    if (insertError) throw insertError;

    $("storyModal").classList.add("hidden");
    $("storyFile").value = "";
    $("storyPreview").innerHTML = "";
    $("storyReverseReveal").checked = false;
    showToast("Story shared — visible for 24 hours");
    loadStoriesRail();
  } catch (err) {
    console.error(err);
    $("storyError").textContent = "Something went wrong: " + err.message;
  } finally {
    $("submitStoryBtn").disabled = false;
  }
}

async function loadStoriesRail() {
  const { data: myViews } = await supabaseClient
    .from("story_views")
    .select("story_id")
    .eq("viewer_id", currentUser.id);
  viewedStoryIds = new Set((myViews || []).map(v => v.story_id));

  const { data, error } = await supabaseClient
    .from("stories")
    .select(`
      id, user_id, media_url, media_type, caption, is_reverse_reveal, created_at, expires_at,
      profiles:user_id ( username, avatar_url )
    `)
    .order("created_at", { ascending: true });

  if (error) { console.error(error); return; }

  const groupsMap = new Map();
  (data || []).forEach(story => {
    if (!groupsMap.has(story.user_id)) {
      groupsMap.set(story.user_id, {
        userId: story.user_id,
        username: story.profiles ? story.profiles.username : "user",
        avatarUrl: story.profiles ? story.profiles.avatar_url : "",
        stories: []
      });
    }
    groupsMap.get(story.user_id).stories.push(story);
  });
  storyGroups = Array.from(groupsMap.values());

  const rail = $("storiesRail");
  rail.querySelectorAll(".story-bubble:not(.add-story)").forEach(el => el.remove());

  storyGroups.forEach((group, idx) => {
    const allSeen = group.stories.every(s => viewedStoryIds.has(s.id));
    const bubble = document.createElement("button");
    bubble.className = "story-bubble";
    bubble.innerHTML = `
      <div class="story-ring ${allSeen ? "seen" : ""}">
        ${group.avatarUrl ? `<img src="${group.avatarUrl}" alt="">` : `<span>${escapeHtml(group.username[0] || "?")}</span>`}
      </div>
      <span>${escapeHtml(group.username)}</span>
    `;
    bubble.addEventListener("click", () => openStoryViewer(idx));
    rail.appendChild(bubble);
  });
}

function openStoryViewer(groupIdx) {
  storyGroupIndex = groupIdx;
  storyIndex = 0;
  $("storyViewer").classList.remove("hidden");
  renderCurrentStory();
}

function renderCurrentStory() {
  clearTimeout(storyAdvanceTimer);
  const group = storyGroups[storyGroupIndex];
  if (!group) { closeStoryViewer(); return; }
  const story = group.stories[storyIndex];
  if (!story) { advanceStory(); return; }

  const media = $("storyViewerMedia");
  const isReveal = story.is_reverse_reveal;
  media.innerHTML = `
    ${story.media_type === "video"
      ? `<video src="${story.media_url}" autoplay muted playsinline class="${isReveal ? "blurred" : ""}" style="${isReveal ? "filter:blur(24px)" : ""}"></video>`
      : `<img src="${story.media_url}" style="${isReveal ? "filter:blur(24px)" : ""}">`}
    ${isReveal ? `<div class="reveal-hint">Press and hold to reveal</div>` : ""}
  `;

  if (isReveal) {
    const el = media.querySelector("img, video");
    const reveal = () => { el.style.filter = "none"; el.classList.add("revealed"); };
    const hide = () => { el.style.filter = "blur(24px)"; el.classList.remove("revealed"); };
    el.addEventListener("mousedown", reveal);
    el.addEventListener("touchstart", reveal);
    el.addEventListener("mouseup", hide);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("touchend", hide);
  }

  supabaseClient.from("story_views").upsert(
    { story_id: story.id, viewer_id: currentUser.id },
    { onConflict: "story_id,viewer_id", ignoreDuplicates: true }
  );

  storyAdvanceTimer = setTimeout(advanceStory, 6000);
}

function advanceStory() {
  const group = storyGroups[storyGroupIndex];
  if (group && storyIndex < group.stories.length - 1) {
    storyIndex++;
    renderCurrentStory();
  } else if (storyGroupIndex < storyGroups.length - 1) {
    storyGroupIndex++;
    storyIndex = 0;
    renderCurrentStory();
  } else {
    closeStoryViewer();
  }
}

function closeStoryViewer() {
  clearTimeout(storyAdvanceTimer);
  $("storyViewer").classList.add("hidden");
  $("storyViewerMedia").innerHTML = "";
  loadStoriesRail();
}

$("storyReplySendBtn").addEventListener("click", sendStoryReply);
async function sendStoryReply() {
  const input = $("storyReplyInput");
  const text = input.value.trim();
  if (!text) return;
  const group = storyGroups[storyGroupIndex];
  const story = group.stories[storyIndex];

  const { data: convId, error } = await supabaseClient.rpc("find_or_create_direct_conversation", {
    other_user: group.userId
  });
  if (error) { showToast("Could not send reply"); console.error(error); return; }

  await supabaseClient.from("messages").insert({
    conversation_id: convId,
    sender_id: currentUser.id,
    content: text,
    reply_to_story_id: story.id
  });

  input.value = "";
  showToast("Reply sent");
}

// ============================================================
// ON THIS DAY (Feature 9)
// ============================================================
async function loadOnThisDay() {
  const { data, error } = await supabaseClient
    .from("posts")
    .select("id, caption, created_at, post_media ( media_url, media_type )")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  if (error || !data) return;

  const today = new Date();
  const matches = data.filter(p => {
    const d = new Date(p.created_at);
    return d.getMonth() === today.getMonth()
      && d.getDate() === today.getDate()
      && d.getFullYear() < today.getFullYear();
  });

  const section = $("onThisDay");
  if (matches.length === 0) { section.classList.add("hidden"); return; }

  section.classList.remove("hidden");
  const scroll = $("otdScroll");
  scroll.innerHTML = matches.map(p => {
    const thumb = p.post_media[0];
    const yearsAgo = today.getFullYear() - new Date(p.created_at).getFullYear();
    return thumb
      ? `<img src="${thumb.media_url}" title="${yearsAgo} year(s) ago" alt="">`
      : `<div class="empty-state" style="padding:4px">${yearsAgo}y ago: ${escapeHtml((p.caption || "").slice(0, 40))}</div>`;
  }).join("");
}

// ============================================================
// CHAT — DMs (Feature 10), Group Chat (11), Channels (12),
// Pinned Messages (16), Custom Themes (17), Fading Messages (18),
// AI Smart Replies (20)
// ============================================================
let newChatType = "direct";
let pinnedMessagesCache = [];
let fadeToggleActive = false;

function initChat() {
  $("newChatBtn").addEventListener("click", () => {
    $("newChatError").textContent = "";
    $("newChatName").value = "";
    $("newChatUsernames").value = "";
    $("newChatModal").classList.remove("hidden");
  });
  $("closeNewChatBtn").addEventListener("click", () => $("newChatModal").classList.add("hidden"));

  document.querySelectorAll("#newChatTypeToggle .type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#newChatTypeToggle .type-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      newChatType = btn.dataset.ctype;
      $("newChatName").classList.toggle("hidden", newChatType === "direct");
      const hints = {
        direct: "Enter one username to start a direct message.",
        group: "Give the group a name, then list everyone's usernames (comma separated).",
        channel: "Only you (the admin) can post here. List usernames to add as readers."
      };
      $("newChatHint").textContent = hints[newChatType];
    });
  });

  $("createChatBtn").addEventListener("click", createConversationFromModal);

  $("backToChatList").addEventListener("click", () => {
    $("chatThreadPane").classList.add("hidden");
    activeConversationId = null;
    loadConversations();
  });

  $("chatSendForm").addEventListener("submit", sendChatMessage);

  $("fadeToggleBtn").addEventListener("click", () => {
    fadeToggleActive = !fadeToggleActive;
    $("fadeToggleBtn").classList.toggle("active", fadeToggleActive);
    showToast(fadeToggleActive ? "Next message will fade if it's not replied to" : "Fading message off");
  });

  $("chatThemeBtn").addEventListener("click", () => $("themeModal").classList.remove("hidden"));
  $("closeThemeBtn").addEventListener("click", () => $("themeModal").classList.add("hidden"));
  document.querySelectorAll(".swatch").forEach(sw => {
    sw.addEventListener("click", () => applyChatTheme(sw.dataset.theme));
  });

  $("pinnedListBtn").addEventListener("click", () => {
    $("pinnedBar").classList.toggle("hidden");
  });

  initVoiceNotes();
  initCalls();
}

async function resolveUsernames(csv) {
  const names = csv.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return [];
  const { data, error } = await supabaseClient.from("profiles").select("id, username").in("username", names);
  if (error) { console.error(error); return []; }
  return data || [];
}

// ---------------- Group Chat (Feature 11) & Channels (Feature 12) ----------------
async function createConversationFromModal() {
  $("newChatError").textContent = "";
  $("createChatBtn").disabled = true;
  try {
    if (newChatType === "direct") {
      const username = $("newChatUsernames").value.trim().toLowerCase();
      if (!username) { $("newChatError").textContent = "Enter a username."; return; }
      const { data: profile, error } = await supabaseClient
        .from("profiles").select("id, username").eq("username", username).single();
      if (error || !profile) { $("newChatError").textContent = "User not found."; return; }

      const { data: convId, error: rpcError } = await supabaseClient.rpc("find_or_create_direct_conversation", {
        other_user: profile.id
      });
      if (rpcError) { $("newChatError").textContent = "Could not start conversation."; console.error(rpcError); return; }

      $("newChatModal").classList.add("hidden");
      openConversation(convId, profile.username, "direct");
      return;
    }

    // group or channel
    const name = $("newChatName").value.trim();
    if (!name) { $("newChatError").textContent = "Give it a name."; return; }
    const members = await resolveUsernames($("newChatUsernames").value);
    if (members.length === 0) { $("newChatError").textContent = "Add at least one valid username."; return; }

    const { data: conv, error: convError } = await supabaseClient
      .from("conversations")
      .insert({ type: newChatType, name, created_by: currentUser.id })
      .select()
      .single();
    if (convError) throw convError;

    const participantRows = [
      { conversation_id: conv.id, user_id: currentUser.id },
      ...members.map(m => ({ conversation_id: conv.id, user_id: m.id }))
    ];
    const { error: partError } = await supabaseClient.from("conversation_participants").insert(participantRows);
    if (partError) throw partError;

    await supabaseClient.from("conversation_admins").insert({ conversation_id: conv.id, user_id: currentUser.id });

    $("newChatModal").classList.add("hidden");
    showToast(newChatType === "channel" ? "Channel created" : "Group created");
    openConversation(conv.id, name, newChatType);
  } catch (err) {
    console.error(err);
    $("newChatError").textContent = "Something went wrong: " + err.message;
  } finally {
    $("createChatBtn").disabled = false;
  }
}

async function loadConversations() {
  const { data: myRows } = await supabaseClient
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", currentUser.id);

  const list = $("conversationList");
  list.innerHTML = "";
  if (!myRows || myRows.length === 0) {
    list.innerHTML = `<div class="empty-state">No conversations yet. Tap "New" to start a direct message, group or channel.</div>`;
    return;
  }

  for (const row of myRows) {
    const { data: conv } = await supabaseClient
      .from("conversations")
      .select("id, type, name, avatar_url")
      .eq("id", row.conversation_id)
      .single();
    const convType = (conv && conv.type) || "direct";

    let name = conv && conv.name;
    let avatarUrl = conv && conv.avatar_url;

    if (convType === "direct") {
      const { data: others } = await supabaseClient
        .from("conversation_participants")
        .select("user_id, profiles:user_id ( username, avatar_url )")
        .eq("conversation_id", row.conversation_id)
        .neq("user_id", currentUser.id);
      const other = others && others[0];
      name = other && other.profiles ? other.profiles.username : "Conversation";
      avatarUrl = other && other.profiles ? other.profiles.avatar_url : "";
    }

    const { data: lastMsgArr } = await supabaseClient
      .from("messages")
      .select("content, kind, created_at")
      .eq("conversation_id", row.conversation_id)
      .order("created_at", { ascending: false })
      .limit(1);
    const lastMsg = lastMsgArr && lastMsgArr[0];
    const preview = lastMsg ? (lastMsg.kind === "voice" ? "🎙️ Voice note" : lastMsg.content) : "Say hello 👋";

    const el = document.createElement("div");
    el.className = "conversation-row";
    el.innerHTML = `
      <img class="avatar" src="${avatarUrl || ""}" alt="">
      <div>
        <div class="conversation-name">
          ${escapeHtml(name || "Conversation")}
          ${convType === "group" ? `<span class="chip-kind group">GROUP</span>` : ""}
          ${convType === "channel" ? `<span class="chip-kind channel">CHANNEL</span>` : ""}
        </div>
        <div class="conversation-preview">${escapeHtml((preview || "").slice(0, 40))}</div>
      </div>
    `;
    el.addEventListener("click", () => openConversation(row.conversation_id, name, convType));
    list.appendChild(el);
  }
}

async function openConversation(conversationId, name, type) {
  activeConversationId = conversationId;
  activeConversationName = name;
  activeConversationType = type || "direct";
  $("chatThreadName").textContent = name;
  $("chatThreadPane").classList.remove("hidden");

  // load conversation meta: theme + admin status + member count
  const { data: conv } = await supabaseClient
    .from("conversations")
    .select("theme")
    .eq("id", conversationId)
    .single();
  activeConversationTheme = (conv && conv.theme) || "aurora";
  applyChatTheme(activeConversationTheme, /*persist*/ false);

  const { data: admins } = await supabaseClient
    .from("conversation_admins")
    .select("user_id")
    .eq("conversation_id", conversationId);
  activeConversationIsAdmin = (admins || []).some(a => a.user_id === currentUser.id);

  const { count } = await supabaseClient
    .from("conversation_participants")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  activeConversationMemberCount = count || 0;

  const subParts = [];
  if (activeConversationType === "group") subParts.push(`Group · ${activeConversationMemberCount} members`);
  if (activeConversationType === "channel") subParts.push(`Channel · ${activeConversationIsAdmin ? "you're the admin" : "read only"}`);
  $("chatThreadSub").textContent = subParts.join(" · ");

  // Channels: only admins can post
  const canPost = activeConversationType !== "channel" || activeConversationIsAdmin;
  $("chatInput").disabled = !canPost;
  $("voiceNoteBtn").disabled = !canPost;
  $("fadeToggleBtn").disabled = !canPost;
  $("chatSendForm").querySelector("button[type=submit]").disabled = !canPost;
  $("chatInput").placeholder = canPost ? "Message..." : "Only the admin can post in this channel";

  await loadMessages();
}

function applyChatTheme(theme, persist = true) {
  activeConversationTheme = theme;
  $("chatMessages").dataset.theme = theme;
  document.querySelectorAll(".swatch").forEach(sw => sw.classList.toggle("active", sw.dataset.theme === theme));
  if (persist && activeConversationId) {
    supabaseClient.from("conversations").update({ theme }).eq("id", activeConversationId);
    $("themeModal").classList.add("hidden");
    showToast("Theme updated");
  }
}

// ---------------- Pinned Messages (Feature 16) ----------------
function renderPinnedBar() {
  const bar = $("pinnedBar");
  if (pinnedMessagesCache.length === 0) {
    bar.innerHTML = "";
    bar.classList.add("hidden");
    return;
  }
  bar.innerHTML = pinnedMessagesCache.map(m => `
    <div class="pinned-row" data-msg="${m.id}"><b>📌</b> ${escapeHtml((m.content || "voice note").slice(0, 60))}</div>
  `).join("");
}

async function togglePinMessage(messageId, pinned) {
  await supabaseClient.from("messages").update({ is_pinned: pinned }).eq("id", messageId);
  loadMessages();
}

// ---------------- Fading Messages (Feature 18) ----------------
async function markFadingMessagesReplied(conversationId, otherSenderIsMe) {
  // Whenever I send a message, any earlier fading messages from someone
  // else in this thread now count as "replied to" and stop fading.
  await supabaseClient
    .from("messages")
    .update({ replied: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", currentUser.id)
    .eq("replied", false);
}

// ---------------- Message rendering ----------------
async function loadMessages() {
  const { data, error } = await supabaseClient
    .from("messages")
    .select("id, content, kind, media_url, sender_id, reply_to_story_id, is_pinned, fades_at, replied, created_at, profiles:sender_id ( username )")
    .eq("conversation_id", activeConversationId)
    .order("created_at", { ascending: true });

  if (error) { console.error(error); return; }

  pinnedMessagesCache = (data || []).filter(m => m.is_pinned);
  renderPinnedBar();

  const box = $("chatMessages");
  const showSenderName = activeConversationType !== "direct";
  const now = Date.now();

  box.innerHTML = (data || []).map(m => {
    const mine = m.sender_id === currentUser.id;
    const isFaded = !mine && m.fades_at && !m.replied && new Date(m.fades_at).getTime() < now;
    const senderLabel = showSenderName && !mine
      ? `<div class="msg-sender">${escapeHtml(m.profiles ? m.profiles.username : "member")}</div>`
      : "";

    const bodyHtml = m.kind === "voice"
      ? `<div class="voice-msg">🎙️ <audio controls src="${m.media_url}"></audio></div>`
      : `${m.reply_to_story_id ? `<span class="msg-story-ref">↩ replied to a story</span>` : ""}${escapeHtml(m.content || "")}`;

    return `
      <div>
        ${senderLabel}
        <div class="msg-meta-row ${mine ? "mine" : ""}">
          <div class="msg-bubble ${mine ? "mine" : "theirs"} ${isFaded ? "faded" : ""}" data-msg="${m.id}">${bodyHtml}</div>
          <button class="msg-pin-btn ${m.is_pinned ? "pinned" : ""}" data-msg="${m.id}" data-pinned="${m.is_pinned}" title="${m.is_pinned ? "Unpin" : "Pin this message"}">📌</button>
        </div>
      </div>
    `;
  }).join("");

  box.querySelectorAll(".msg-pin-btn").forEach(btn => {
    btn.addEventListener("click", () => togglePinMessage(btn.dataset.msg, btn.dataset.pinned !== "true"));
  });
  box.querySelectorAll(".msg-bubble.faded").forEach(el => {
    el.addEventListener("click", () => { el.classList.remove("faded"); }, { once: true });
  });
  box.scrollTop = box.scrollHeight;

  const last = (data || [])[data.length - 1];
  if (last && last.sender_id !== currentUser.id) {
    lastIncomingMessage = last;
    renderSmartReplies(last);
  } else {
    $("smartReplies").classList.add("hidden");
  }
}

async function sendChatMessage(e) {
  e.preventDefault();
  const input = $("chatInput");
  const content = input.value.trim();
  if (!content || !activeConversationId) return;
  input.value = "";

  const payload = {
    conversation_id: activeConversationId,
    sender_id: currentUser.id,
    content,
    kind: "text",
    replied: false
  };
  if (fadeToggleActive) {
    payload.fades_at = new Date(Date.now() + FADE_WINDOW_MS).toISOString();
    fadeToggleActive = false;
    $("fadeToggleBtn").classList.remove("active");
  }

  const { error } = await supabaseClient.from("messages").insert(payload);
  if (error) { showToast("Message failed to send"); return; }

  await markFadingMessagesReplied(activeConversationId);
  loadMessages();
}

// ---------------- AI Smart Replies (Feature 20) ----------------
// Heuristic/on-device suggestions based on the last incoming message.
function generateSmartReplies(message) {
  const text = (message.content || "").toLowerCase();
  if (message.kind === "voice") return ["Listening now 🎧", "Got it, thanks!", "Can you also text it?"];
  if (/\?$/.test(text.trim())) return ["Yes!", "Not sure yet", "Tell me more"];
  if (/\b(hi|hey|hello|yo)\b/.test(text)) return ["Hey! 👋", "What's up?", "Hi there!"];
  if (/\b(thanks|thank you|thx)\b/.test(text)) return ["Anytime!", "No problem 🙂", "Of course"];
  if (/😂|lol|lmao|haha/.test(text)) return ["😂😂", "I know right", "Stop 😭"];
  if (/\b(sorry|sry)\b/.test(text)) return ["No worries", "It's okay", "All good!"];
  return ["Got it", "Sounds good 👍", "Tell me more"];
}

function renderSmartReplies(message) {
  const container = $("smartReplies");
  const canPost = activeConversationType !== "channel" || activeConversationIsAdmin;
  if (!canPost) { container.classList.add("hidden"); return; }
  const chips = generateSmartReplies(message);
  container.innerHTML = chips.map(c => `<button type="button" class="smart-reply-chip">${escapeHtml(c)}</button>`).join("");
  container.classList.remove("hidden");
  container.querySelectorAll(".smart-reply-chip").forEach(chip => {
    chip.addEventListener("click", async () => {
      $("chatInput").value = chip.textContent;
      $("chatSendForm").requestSubmit();
    });
  });
}

// ---------------- Voice Notes (Feature 15) ----------------
let mediaRecorder = null;
let recordedChunks = [];

function initVoiceNotes() {
  const btn = $("voiceNoteBtn");
  const start = (e) => { e.preventDefault(); startVoiceRecording(); };
  const stop = () => stopVoiceRecording();
  btn.addEventListener("mousedown", start);
  btn.addEventListener("touchstart", start, { passive: false });
  btn.addEventListener("mouseup", stop);
  btn.addEventListener("mouseleave", stop);
  btn.addEventListener("touchend", stop);
}

async function startVoiceRecording() {
  if (!activeConversationId || $("voiceNoteBtn").disabled) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      $("recordingBadge").classList.add("hidden");
      uploadVoiceNote(new Blob(recordedChunks, { type: "audio/webm" }));
    };
    mediaRecorder.start();
    $("voiceNoteBtn").classList.add("recording");
    $("recordingBadge").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    showToast("Microphone permission is needed for voice notes");
  }
}

function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  $("voiceNoteBtn").classList.remove("recording");
}

async function uploadVoiceNote(blob) {
  if (blob.size < 500) return; // ignore accidental taps
  try {
    const path = `${currentUser.id}/${crypto.randomUUID()}.webm`;
    const { error: uploadError } = await supabaseClient.storage
      .from("voice-notes")
      .upload(path, blob, { cacheControl: "3600", upsert: false, contentType: "audio/webm" });
    if (uploadError) throw uploadError;

    const { data: pub } = supabaseClient.storage.from("voice-notes").getPublicUrl(path);
    await supabaseClient.from("messages").insert({
      conversation_id: activeConversationId,
      sender_id: currentUser.id,
      kind: "voice",
      media_url: pub.publicUrl,
      replied: false
    });
    await markFadingMessagesReplied(activeConversationId);
    loadMessages();
  } catch (err) {
    console.error(err);
    showToast("Voice note failed to upload — make sure the 'voice-notes' storage bucket exists");
  }
}

// ---------------- Calls: 1-1 (Feature 13) and Group (Feature 14) ----------------
// Signaling goes over a Supabase Realtime broadcast channel scoped to the
// conversation — no extra backend needed beyond Realtime being enabled.
let callChannel = null;
let localStream = null;
let peerConnections = {}; // userId -> RTCPeerConnection
let isVideoCall = false;
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function initCalls() {
  $("callVoiceBtn").addEventListener("click", () => startCall(false));
  $("callVideoBtn").addEventListener("click", () => startCall(true));
  $("endCallBtn").addEventListener("click", endCall);
  $("toggleMicBtn").addEventListener("click", () => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled);
    $("toggleMicBtn").classList.toggle("off", !localStream.getAudioTracks()[0].enabled);
  });
  $("toggleCamBtn").addEventListener("click", () => {
    if (!localStream) return;
    localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled);
    $("toggleCamBtn").classList.toggle("off", !(localStream.getVideoTracks()[0] && localStream.getVideoTracks()[0].enabled));
  });
}

async function startCall(withVideo) {
  if (!activeConversationId) return;
  isVideoCall = withVideo;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  } catch (err) {
    showToast("Camera/microphone permission is needed to call");
    return;
  }

  $("callModal").classList.remove("hidden");
  $("callStatus").textContent = activeConversationType === "direct"
    ? `Calling ${activeConversationName}...`
    : `Calling ${activeConversationName} (group)...`;
  $("callVideoGrid").innerHTML = "";
  addCallTile("me", "You", localStream, true, withVideo);

  callChannel = supabaseClient.channel(`call-${activeConversationId}`, { config: { broadcast: { self: false } } });
  callChannel.on("broadcast", { event: "signal" }, ({ payload }) => handleSignal(payload));
  callChannel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      callChannel.send({ type: "broadcast", event: "signal", payload: { kind: "join", from: currentUser.id, video: withVideo } });
      $("callStatus").textContent = "Waiting for the other side to join...";
    }
  });
}

function addCallTile(id, label, stream, isLocal, withVideo) {
  const grid = $("callVideoGrid");
  const tile = document.createElement("div");
  tile.className = "call-tile";
  tile.id = `call-tile-${id}`;
  const mediaEl = document.createElement(withVideo ? "video" : "audio");
  mediaEl.srcObject = stream;
  mediaEl.autoplay = true;
  mediaEl.playsInline = true;
  if (isLocal) mediaEl.muted = true;
  tile.appendChild(mediaEl);
  const labelEl = document.createElement("span");
  labelEl.className = "call-tile-label";
  labelEl.textContent = label;
  tile.appendChild(labelEl);
  grid.appendChild(tile);
  grid.classList.toggle("multi", grid.children.length > 1);
}

async function ensurePeerConnection(remoteId) {
  if (peerConnections[remoteId]) return peerConnections[remoteId];
  const pc = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      callChannel.send({ type: "broadcast", event: "signal", payload: { kind: "candidate", from: currentUser.id, to: remoteId, candidate: e.candidate } });
    }
  };
  pc.ontrack = (e) => {
    if (!$(`call-tile-${remoteId}`)) {
      addCallTile(remoteId, "Member", e.streams[0], false, isVideoCall);
    }
  };

  peerConnections[remoteId] = pc;
  return pc;
}

async function handleSignal(payload) {
  if (!payload || payload.from === currentUser.id) return;
  if (payload.to && payload.to !== currentUser.id) return;

  if (payload.kind === "join") {
    $("callStatus").textContent = "Connected";
    // Simple glare avoidance: the lexicographically larger id makes the offer.
    if (currentUser.id > payload.from) {
      const pc = await ensurePeerConnection(payload.from);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      callChannel.send({ type: "broadcast", event: "signal", payload: { kind: "offer", from: currentUser.id, to: payload.from, sdp: offer } });
    } else {
      callChannel.send({ type: "broadcast", event: "signal", payload: { kind: "join", from: currentUser.id, to: payload.from, video: isVideoCall } });
    }
  } else if (payload.kind === "offer") {
    const pc = await ensurePeerConnection(payload.from);
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    callChannel.send({ type: "broadcast", event: "signal", payload: { kind: "answer", from: currentUser.id, to: payload.from, sdp: answer } });
    $("callStatus").textContent = "Connected";
  } else if (payload.kind === "answer") {
    const pc = peerConnections[payload.from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    $("callStatus").textContent = "Connected";
  } else if (payload.kind === "candidate") {
    const pc = peerConnections[payload.from];
    if (pc) { try { await pc.addIceCandidate(payload.candidate); } catch (e) { console.error(e); } }
  } else if (payload.kind === "leave") {
    const pc = peerConnections[payload.from];
    if (pc) { pc.close(); delete peerConnections[payload.from]; }
    const tile = $(`call-tile-${payload.from}`);
    if (tile) tile.remove();
  }
}

function endCall() {
  if (callChannel) {
    callChannel.send({ type: "broadcast", event: "signal", payload: { kind: "leave", from: currentUser.id } });
    supabaseClient.removeChannel(callChannel);
    callChannel = null;
  }
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  $("callVideoGrid").innerHTML = "";
  $("callModal").classList.add("hidden");
}

// ============================================================
// BOOT
// ============================================================
async function bootApp() {
  await loadFeed();
  await loadStoriesRail();
  await loadOnThisDay();
}

initAuthTabs();
initNav();
initComposer();
initStoryModal();
initChat();
initProfileModal();
