// ============================================================
// SocialNexus — app.js
// Plain JS, no framework, talks directly to Supabase.
// Organized in sections — search for the "====" headers.
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
    .select("id, username, avatar_url")
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
// NAVIGATION
// ============================================================
function initNav() {
  document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  $("openExploreBtn").addEventListener("click", () => switchView("exploreView"));
  $("openChatBtn").addEventListener("click", () => switchView("chatView"));
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
        <button class="action-btn like-btn ${liked ? "liked" : ""}" data-post="${post.id}" data-liked="${liked}">
          ${liked ? "♥" : "♡"} ${post.likes.length}
        </button>
        <button class="action-btn comment-toggle" data-post="${post.id}">💬 ${post.comments.length}</button>
      </div>
      <div class="comment-list hidden" id="comments-${post.id}">${commentsHtml}</div>
      <form class="comment-form hidden" id="comment-form-${post.id}" data-post="${post.id}">
        <input type="text" placeholder="Add a comment..." maxlength="1000" />
        <button type="submit" class="btn-primary small">Post</button>
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
// COMPOSER (create post / reel + hashtags)
// ============================================================
let composerType = "post";
let composerFilesSelected = [];

function initComposer() {
  $("openComposerBtn").addEventListener("click", () => $("composerModal").classList.remove("hidden"));
  $("closeComposerBtn").addEventListener("click", () => $("composerModal").classList.add("hidden"));

  document.querySelectorAll(".type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("active"));
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

  // Note: for a small app this per-tag count query is fine.
  // At scale, replace with a Postgres view that pre-aggregates counts.
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

  // mark viewed (ignore duplicate-key errors from repeat views)
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
// DM CHAT (Feature 10 + story replies land here)
// ============================================================
function initChat() {
  $("newChatBtn").addEventListener("click", startNewConversation);
  $("backToChatList").addEventListener("click", () => {
    $("chatThreadPane").classList.add("hidden");
    activeConversationId = null;
    loadConversations();
  });
  $("chatSendForm").addEventListener("submit", sendChatMessage);
}

async function loadConversations() {
  const { data: myRows } = await supabaseClient
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", currentUser.id);

  const list = $("conversationList");
  list.innerHTML = "";
  if (!myRows || myRows.length === 0) {
    list.innerHTML = `<div class="empty-state">No conversations yet.</div>`;
    return;
  }

  for (const row of myRows) {
    const { data: others } = await supabaseClient
      .from("conversation_participants")
      .select("user_id, profiles:user_id ( username, avatar_url )")
      .eq("conversation_id", row.conversation_id)
      .neq("user_id", currentUser.id);

    const other = others && others[0];
    const name = other && other.profiles ? other.profiles.username : "Conversation";

    const { data: lastMsgArr } = await supabaseClient
      .from("messages")
      .select("content, created_at")
      .eq("conversation_id", row.conversation_id)
      .order("created_at", { ascending: false })
      .limit(1);
    const preview = lastMsgArr && lastMsgArr[0] ? lastMsgArr[0].content : "Say hello 👋";

    const el = document.createElement("div");
    el.className = "conversation-row";
    el.innerHTML = `
      <img class="avatar" src="${other && other.profiles && other.profiles.avatar_url ? other.profiles.avatar_url : ""}" alt="">
      <div>
        <div class="conversation-name">${escapeHtml(name)}</div>
        <div class="conversation-preview">${escapeHtml((preview || "").slice(0, 40))}</div>
      </div>
    `;
    el.addEventListener("click", () => openConversation(row.conversation_id, name));
    list.appendChild(el);
  }
}

async function startNewConversation() {
  const username = prompt("Start a conversation with username:");
  if (!username) return;
  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("id, username")
    .eq("username", username.trim().toLowerCase())
    .single();
  if (error || !profile) { showToast("User not found"); return; }

  const { data: convId, error: rpcError } = await supabaseClient.rpc("find_or_create_direct_conversation", {
    other_user: profile.id
  });
  if (rpcError) { showToast("Could not start conversation"); console.error(rpcError); return; }
  openConversation(convId, profile.username);
}

async function openConversation(conversationId, name) {
  activeConversationId = conversationId;
  activeConversationName = name;
  $("chatThreadName").textContent = name;
  $("chatThreadPane").classList.remove("hidden");
  await loadMessages();
}

async function loadMessages() {
  const { data, error } = await supabaseClient
    .from("messages")
    .select("id, content, sender_id, reply_to_story_id, created_at")
    .eq("conversation_id", activeConversationId)
    .order("created_at", { ascending: true });

  if (error) { console.error(error); return; }

  const box = $("chatMessages");
  box.innerHTML = (data || []).map(m => `
    <div class="msg-bubble ${m.sender_id === currentUser.id ? "mine" : "theirs"}">
      ${m.reply_to_story_id ? `<span class="msg-story-ref">↩ replied to a story</span>` : ""}
      ${escapeHtml(m.content || "")}
    </div>
  `).join("");
  box.scrollTop = box.scrollHeight;
}

async function sendChatMessage(e) {
  e.preventDefault();
  const input = $("chatInput");
  const content = input.value.trim();
  if (!content || !activeConversationId) return;
  input.value = "";
  const { error } = await supabaseClient.from("messages").insert({
    conversation_id: activeConversationId,
    sender_id: currentUser.id,
    content
  });
  if (error) { showToast("Message failed to send"); return; }
  loadMessages();
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
