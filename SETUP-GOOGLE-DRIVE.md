# Google Drive storage — setup (10 minutes, ek hi baar)

Is se users ki photos / videos / voice notes / story media unke **apne Google Drive**
("SocialNexus" folder) me jayengi. Supabase me sirf link save hota hai.
Agar `GOOGLE_CLIENT_ID` khali hai ya user ne Drive connect nahi kiya, app purane tareeke
(Supabase Storage) se chalta rahta hai — kuch toot'ta nahi.

## 1. Google Cloud project
1. https://console.cloud.google.com -> **New Project** -> naam: `SocialNexus`.
2. **APIs & Services -> Library** -> **Google Drive API** -> **Enable**.

## 2. OAuth consent screen
1. **APIs & Services -> OAuth consent screen** (ya "Google Auth Platform").
2. User type: **External**. App name: `SocialNexus`, apna email daalo.
3. **Scopes** me sirf ye add karo: `.../auth/drive.file`
   (ye non-sensitive scope hai — app sirf apni banayi files dekh sakta hai, user ka baaki Drive nahi).
4. **Publishing status -> Publish app** (Production). Testing me rahega to sirf 100 test users
   chalenge aur token 7 din me expire hoga.

## 3. Client ID banao
1. **Credentials -> Create credentials -> OAuth client ID -> Web application**.
2. **Authorized JavaScript origins** me apni site ka URL daalo, jaise
   `https://your-app.onrender.com` (aur testing ke liye `http://localhost:3000`). Path nahi, sirf origin.
3. Create karo, **Client ID** copy karo (`xxxx.apps.googleusercontent.com`).
   Client Secret ki zaroorat NAHI hai.

## 4. App me lagao
`supabase-config.js` me:

    const GOOGLE_CLIENT_ID = "xxxx.apps.googleusercontent.com";

Deploy karo. Login ke baad neeche-left me **"Connect Google Drive"** button dikhega.

## Kaise kaam karta hai
- User button dabata hai -> Google ka permission popup -> folder `SocialNexus` banta hai.
- Upload (post, reel, story, chat photo, voice note, profile photo) pehle Drive me jata hai,
  file "anyone with the link can view" hoti hai, aur Supabase me sirf URL save hota hai.
- Token ~1 ghante chalta hai; purane connected users ko app silently naya token le leta hai.
  Na mile to upload automatic Supabase Storage par chala jata hai.

## Dhyan rakhne wali baatein
- Bahut viral video par Google "download quota exceeded" laga sakta hai. Chhote clips/images ke liye theek.
- Agar user Drive se file delete kare ya disconnect kare, to us post ka media gayab ho jayega.
- Purani posts (jo Supabase Storage me hain) waise hi chalti rahengi.
