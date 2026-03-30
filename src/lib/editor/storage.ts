import { type EditorState } from './history';

export class EditorStorage {
	public static STORAGE_KEY = 'ez-blank-session-v1';

	static save(state: EditorState) {
		try {
			const serialized = JSON.stringify(state);
			localStorage.setItem(this.STORAGE_KEY, serialized);
		} catch (e) {
			console.error('Failed to save editor state:', e);
		}
	}

	static load(): EditorState | null {
		try {
			const serialized = localStorage.getItem(this.STORAGE_KEY);
			if (!serialized) return null;
			return JSON.parse(serialized) as EditorState;
		} catch (e) {
			console.error('Failed to load editor state:', e);
			return null;
		}
	}
}
