export const BLANK_DB_NAME = 'blank';
export const BLANK_DB_VERSION = 1;
export const NOTES_STORE_NAME = 'notes';
export const SETTINGS_STORE_NAME = 'settings';
export const USER_ID_INDEX = 'userId';

export const ANONYMOUS_USERID = 'anonymous';

export type NoteSyncStatus = 'synced' | 'dirty' | 'pending_push' | 'conflict';

export interface NoteRecord {
	id: string;
	userId: string;
	title: string;
	content: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	lastSyncedAt: string | null;
	lastKnownRemoteUpdatedAt: string | null;
	lastKnownRemoteDeletedAt: string | null;
	syncStatus: NoteSyncStatus;
}

export interface SettingRecord {
	key: string;
	userId: string | null;
	value: unknown;
	updatedAt: string;
}

export const SETTING_ACTIVE_PAGE_ID = 'activePageId';
export const SETTING_THEME = 'theme';
export const SETTING_WORD_COUNT_VISIBILITY = 'wordCountVisibility';
export const SETTING_SPELLCHECK_ENABLED = 'spellcheckEnabled';
export const SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT = 'hasPromptedForAnonymousImport';
