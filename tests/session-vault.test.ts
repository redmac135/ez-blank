import type { Session } from '@supabase/supabase-js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	activeAuthStorage,
	clearActiveAuthSession,
	findSavedAuthSessionByEmail,
	loadSavedAuthSessions,
	removeSavedAuthSession,
	saveAuthSession
} from '../src/lib/auth/session-vault.ts';

class MemoryStorage {
	private values = new Map<string, string>();

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string) {
		this.values.set(key, value);
	}

	removeItem(key: string) {
		this.values.delete(key);
	}
}

function createSupabaseSession(userId: string, email: string): Session {
	return {
		access_token: `access-${userId}`,
		refresh_token: `refresh-${userId}`,
		expires_in: 3600,
		expires_at: 1_800_000_000,
		token_type: 'bearer',
		user: {
			id: userId,
			email,
			app_metadata: {},
			user_metadata: {},
			aud: 'authenticated',
			created_at: '2026-04-14T00:00:00.000Z'
		}
	} as Session;
}

test.beforeEach(() => {
	Object.defineProperty(globalThis, 'localStorage', {
		value: new MemoryStorage(),
		configurable: true
	});
});

test('session vault is safe when localStorage is unavailable', () => {
	Reflect.deleteProperty(globalThis, 'localStorage');

	assert.equal(activeAuthStorage.getItem('sb-test-auth-token'), null);
	assert.deepEqual(loadSavedAuthSessions(), []);
	assert.doesNotThrow(() => clearActiveAuthSession());
});

test('active auth storage reads and clears the active session slot', () => {
	activeAuthStorage.setItem('blank-auth-active-session', 'session-json');

	assert.equal(activeAuthStorage.getItem('blank-auth-active-session'), 'session-json');

	clearActiveAuthSession();

	assert.equal(activeAuthStorage.getItem('blank-auth-active-session'), null);
});

test('active auth storage keeps multiple Supabase session keys across reads', () => {
	activeAuthStorage.setItem('sb-test-auth-token', 'access-token');
	activeAuthStorage.setItem('sb-test-auth-token-code-verifier', 'code-verifier');

	assert.equal(activeAuthStorage.getItem('sb-test-auth-token'), 'access-token');
	assert.equal(activeAuthStorage.getItem('sb-test-auth-token-code-verifier'), 'code-verifier');
});

test('saved auth sessions can be restored by email and updated per user', () => {
	saveAuthSession(createSupabaseSession('user-a', 'Alpha@example.com'));
	saveAuthSession(createSupabaseSession('user-a', 'Alpha@example.com'));
	saveAuthSession(createSupabaseSession('user-b', 'beta@example.com'));

	assert.equal(loadSavedAuthSessions().length, 2);
	assert.equal(findSavedAuthSessionByEmail('alpha@example.com')?.userId, 'user-a');
	assert.equal(findSavedAuthSessionByEmail('BETA@example.com')?.userId, 'user-b');
});

test('saved auth sessions can be removed', () => {
	saveAuthSession(createSupabaseSession('user-a', 'alpha@example.com'));
	removeSavedAuthSession('user-a');

	assert.deepEqual(loadSavedAuthSessions(), []);
});
