import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { browser } from '$app/environment';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { activeAuthStorage } from '$lib/auth/session-vault';

const supabaseUrl = PUBLIC_SUPABASE_URL;
const supabaseKey = PUBLIC_SUPABASE_PUBLISHABLE_KEY;

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient() {
	if (!browser || !supabaseUrl || !supabaseKey) {
		return null;
	}

	if (!supabaseClient) {
		supabaseClient = createClient(supabaseUrl, supabaseKey, {
			auth: {
				detectSessionInUrl: true,
				persistSession: true,
				autoRefreshToken: true,
				storage: activeAuthStorage
			}
		});
	}

	return supabaseClient;
}

export async function clearActiveSupabaseSession() {
	const client = getSupabaseClient();
	if (!client) {
		return;
	}

	await (
		client.auth as unknown as {
			_removeSession: () => Promise<void>;
		}
	)._removeSession();
}
