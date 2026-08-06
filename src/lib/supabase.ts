"use client";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim();

export const supabase = createClient(url, key);
