export type ThemeMode = 'light' | 'dark';
export type CountVisibility = 'pinned' | 'auto' | 'hidden';

export interface EditorPreferences {
	themeMode: ThemeMode;
	spellcheckEnabled: boolean;
	countVisibility: CountVisibility;
}

export const DEFAULT_PREFERENCES: EditorPreferences = {
	themeMode: 'light',
	spellcheckEnabled: true,
	countVisibility: 'auto'
};

const COUNT_VISIBILITY_ORDER: CountVisibility[] = ['pinned', 'auto', 'hidden'];

export function normalizePreferences(value: unknown): EditorPreferences {
	if (!value || typeof value !== 'object') {
		return DEFAULT_PREFERENCES;
	}

	const candidate = value as Partial<EditorPreferences>;

	return {
		themeMode: candidate.themeMode === 'dark' ? 'dark' : 'light',
		spellcheckEnabled:
			typeof candidate.spellcheckEnabled === 'boolean'
				? candidate.spellcheckEnabled
				: DEFAULT_PREFERENCES.spellcheckEnabled,
		countVisibility: COUNT_VISIBILITY_ORDER.includes(candidate.countVisibility as CountVisibility)
			? (candidate.countVisibility as CountVisibility)
			: DEFAULT_PREFERENCES.countVisibility
	};
}

export function cycleCountVisibility(value: CountVisibility): CountVisibility {
	const currentIndex = COUNT_VISIBILITY_ORDER.indexOf(value);
	return COUNT_VISIBILITY_ORDER[(currentIndex + 1) % COUNT_VISIBILITY_ORDER.length]!;
}

export function getCountVisibilityLabel(value: CountVisibility): string {
	switch (value) {
		case 'pinned':
			return 'Count pinned';
		case 'hidden':
			return 'Count hidden';
		default:
			return 'Count shown';
	}
}
