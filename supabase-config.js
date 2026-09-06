// ============================================================
// Fill these in from your Supabase project:
// Dashboard -> Project Settings -> API
//
// IMPORTANT: only ever put the "anon public" key here.
// NEVER put the "service_role" key in any file that goes to
// GitHub or is served to the browser — that key bypasses RLS.
// ============================================================
const SUPABASE_URL = "https://znhyjuibgbcmrcqijtpi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hMMTzT2Jojy2ZQfpxlLy-A_UR4V86BM";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
