<script lang="ts">
	import { browser } from '$app/environment';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount, tick } from 'svelte';
	import { cubicIn, cubicOut } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import Editor from '$lib/Editor.svelte';
	import FloatingMenu from '$lib/FloatingMenu.svelte';
	import Icon from '$lib/Icon.svelte';
	import Modal from '$lib/Modal.svelte';
	import OtpInput from '$lib/OtpInput.svelte';
	import {
		getSettledAppSyncStatus as deriveSettledAppSyncStatus,
		type AppSyncStatus
	} from '$lib/editor/app-sync-status';
	import { createActivePageController } from '$lib/editor/active-page-controller';
	import {
		applyEditorStateUpdate,
		applyHydratedSession,
		applySessionUpdate,
		type PageEditorUpdate
	} from '$lib/editor/core/app-state';
	import { createSyncController } from '$lib/editor/sync-controller';
	import {
		areEditorSessionsEquivalent,
		getChangedPageEvents,
		type ChangedPageEvent,
		type LocalPageEventType
	} from '$lib/editor/persistence/session-events';
	import { mergeEditorSelections } from '$lib/editor/persistence/session-selection';
	import { AuthBroadcastChannel } from '$lib/auth/auth-broadcast';
	import {
		cycleCountVisibility,
		DEFAULT_PREFERENCES,
		getCountVisibilityLabel,
		normalizePreferences,
		type EditorPreferences,
		type ThemeMode
	} from '$lib/editor/core/preferences';
	import {
		findSavedAuthSessionByEmail,
		removeSavedAuthSession,
		saveAuthSession
	} from '$lib/auth/session-vault';
	import { EditorStorage } from '$lib/editor/persistence/storage';
	import { ANONYMOUS_USERID } from '$lib/editor/persistence/records';
	import {
		fetchRemoteActivePageId,
		pushRemoteActivePageId,
		reconcileSyncResult,
		syncUserPages
	} from '$lib/editor/sync';
	import { clearActiveSupabaseSession, getSupabaseClient } from '$lib/supabaseClient';
	import {
		clonePageForUser,
		createPage,
		createSession,
		markPageDeleted,
		ensureValidActivePage,
		getRemoteActivePageUpdateTarget,
		hasVisibleEphemeralActivePage,
		sortPagesByRecency,
		materializePage,
		type EditorPage,
	type EditorSession,
	updatePageTitle
	} from '$lib/editor/core/session';

let session: EditorSession = { pages: [], activePageId: '' };
	let drawerOpen = false;
	let loaded = false;
	let menuPageId: string | null = null;
	let editingPageId: string | null = null;
	let deletePageId: string | null = null;
	let titleDraft = '';
	let countDisplayMode: 'words' | 'characters' | 'paragraphs' | 'lines' = 'words';
	let chromeVisible = true;
	let previousActiveText = '';

	let emailDraft = '';
	let otpDraft = '';
	let loginModalOpen = false;
	let importPromptOpen = false;
	let supabase = getSupabaseClient();
	let authUser: User | null = null;
	let authBusy = false;
	let authMessage = '';
	let loginSubmitting = false;
	let loginStep: 'email' | 'otp' = 'email';
	let otpVerifying = false;
	let otpShake = false;
	let resendCooldownRemaining = 0;
	let resendCooldownInterval: ReturnType<typeof setInterval> | null = null;
	let pendingAnonymousImportSession: EditorSession | null = null;
	let currentAuthRequestId = 0;
	let authSubscription: { unsubscribe: () => void } | null = null;
	let suppressSavedSessionRemoval = false;
	let syncBusy = false;
	let appSyncStatus: AppSyncStatus = 'synced';

	let titleInput: HTMLInputElement | null = null;
	let countButton: HTMLButtonElement | null = null;
	let settingsButton: HTMLButtonElement | null = null;

	let countMenuOpen = false;
	let settingsMenuOpen = false;
	let hideChromeTimeout: ReturnType<typeof setTimeout> | null = null;
	let preferences: EditorPreferences = DEFAULT_PREFERENCES;

	let toastNotices: Array<{ id: number; message: string }> = [];
	let nextToastId = 1;
	let toastTimeouts = new Map<number, number>();
	let workspacePersistQueue: Promise<void> = Promise.resolve();
	let pagesChannel: BroadcastChannel | null = null;
	let authBroadcastChannel: AuthBroadcastChannel | null = null;
	let editorIdleTimeout: ReturnType<typeof setTimeout> | null = null;

	const tabId =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `tab-${Math.random().toString(36).slice(2, 10)}`;
	const LOCAL_PAGE_EVENT_TYPES: Set<LocalPageEventType> = new Set([
		'page-updated',
		'title-updated',
		'new-page',
		'deleted-page'
	]);
	const AUTH_CHANNEL_NAME = 'auth';

	const TOP_REVEAL_HEIGHT = 112;
	const CHROME_HIDE_DELAY = 1400;
	const APP_UPDATED_NOTICE_KEY = 'blank-app-updated-notice';
	const EDIT_SYNC_DEBOUNCE_MS = 3000;
	const ACTIVE_PAGE_PUSH_DEBOUNCE_MS = 300;
	const syncController = createSyncController({
		delayMs: EDIT_SYNC_DEBOUNCE_MS,
		runSync: executeSync
	});
	const activePageController = createActivePageController({
		delayMs: ACTIVE_PAGE_PUSH_DEBOUNCE_MS,
		runPush: async (pageId: string) => {
			if (!supabase || !authUser || !loaded) {
				return;
			}

			await pushRemoteActivePageId(supabase, authUser.id, pageId);
		}
	});

	$: activePage = getActivePage(session);
	$: visiblePages = session.pages.filter((page) => page.deletedAt === null);
	$: activeText = activePage.content;
	$: hasDocumentContent = activeText.length > 0;
	$: wordCount = getWordCount(activeText);
	$: characterCount = activeText.length;
	$: paragraphCount = getParagraphCount(activeText);
	$: lineCount = getLineCount(activeText);
	$: countOptions = [
		{ id: 'words', label: pluralize(wordCount, 'word') },
		{ id: 'characters', label: pluralize(characterCount, 'character') },
		{ id: 'paragraphs', label: pluralize(paragraphCount, 'paragraph') },
		{ id: 'lines', label: pluralize(lineCount, 'line') }
	] as const;
	$: currentCountLabel =
		countOptions.find((option) => option.id === countDisplayMode)?.label ?? countOptions[0].label;
	$: countVisibleInChrome = preferences.countVisibility !== 'hidden';
	$: countPinnedVisible = preferences.countVisibility === 'pinned';
	$: countVisible = countVisibleInChrome && (chromeVisible || countPinnedVisible || countMenuOpen);
	$: countDockedRight = countPinnedVisible && !chromeVisible && !settingsMenuOpen;
	$: pageTheme = preferences.themeMode;
	$: deletePage = deletePageId
		? (session.pages.find((page) => page.id === deletePageId) ?? null)
		: null;
	$: syncStatusLabel = getSyncStatusLabel(appSyncStatus);

	$: if (!hasDocumentContent || drawerOpen || countMenuOpen || settingsMenuOpen) {
		chromeVisible = true;
		clearHideChromeTimeout();
	}

	$: if (activeText !== previousActiveText) {
		const textIsEmpty = activeText.length === 0;
		previousActiveText = activeText;

		if (textIsEmpty) {
			chromeVisible = true;
			clearHideChromeTimeout();
		} else if (!drawerOpen && !countMenuOpen) {
			chromeVisible = false;
			clearHideChromeTimeout();
		}
	}

	$: if (loaded) {
		applyTheme(pageTheme);
	}

	function getActivePage(currentSession: EditorSession): EditorPage {
		const visiblePage =
			currentSession.pages.find((page) => page.id === currentSession.activePageId && page.deletedAt === null) ??
			currentSession.pages.find((page) => page.deletedAt === null);

		if (visiblePage) {
			return visiblePage;
		}

		return currentSession.pages[0] ?? createPage('', { userId: getScopedUserId() });
	}

	function getSettledAppSyncStatus(currentSession: EditorSession): AppSyncStatus {
		return deriveSettledAppSyncStatus(currentSession, isBrowserOnline());
	}

	function queueRemoteActivePageUpdate(previousSession: EditorSession, nextSession: EditorSession) {
		const pageId = getRemoteActivePageUpdateTarget(previousSession, nextSession);
		if (!pageId || !authUser || !supabase || !loaded) {
			return;
		}

		activePageController.schedule(pageId);
	}

	function persistSession(nextSession: EditorSession) {
		const normalizedSession = ensureValidActivePage(nextSession);
		const previousSession = session;
		const transition = applySessionUpdate({ session, loaded }, normalizedSession);
		session = transition.state.session;
		queueRemoteActivePageUpdate(previousSession, transition.state.session);
		if (transition.persistedSession) {
			void persistWorkspaceState(previousSession, transition.persistedSession);
		}
	}

	function replaceLocalSession(
		nextSession: EditorSession,
		options: {
			persist?: boolean;
			source?: string;
			details?: Record<string, unknown>;
		} = {}
	) {
		const previousSession = session;
		session = ensureValidActivePage(nextSession);
		queueRemoteActivePageUpdate(previousSession, session);
		if (loaded && options.persist) {
			void persistWorkspaceState(previousSession, session);
		}
	}

	function updateActivePage(update: PageEditorUpdate) {
		if (!session.pages.some((page) => page.id === update.pageId)) {
			return;
		}

		const previousSession = session;
		const transition = applyEditorStateUpdate({ session, loaded }, update);
		session = {
			...transition.state.session,
			pages: sortPagesByRecency(transition.state.session.pages)
		};
		queueRemoteActivePageUpdate(previousSession, transition.state.session);
		if (transition.persistedSession) {
			const previousPage = previousSession.pages.find((page) => page.id === previousSession.activePageId);
			const nextPage = transition.state.session.pages.find(
				(page) => page.id === transition.state.session.activePageId
			);
			const changedNoteData =
				!!previousPage &&
				!!nextPage &&
				(previousPage.title !== nextPage.title ||
					previousPage.content !== nextPage.content ||
					previousPage.deletedAt !== nextPage.deletedAt);
			if (changedNoteData) {
				markSavedLocally();
				scheduleEditorIdleFlush();
				scheduleDebouncedSync();
			}
			void persistWorkspaceState(previousSession, transition.persistedSession);
		}
	}

	function handleEditorFocusChange(focused: boolean) {
		void focused;
	}

	function scheduleEditorIdleFlush() {
		clearEditorIdleFlush();
		editorIdleTimeout = setTimeout(() => {
			editorIdleTimeout = null;
		}, 900);
	}

	function clearEditorIdleFlush() {
		if (editorIdleTimeout) {
			clearTimeout(editorIdleTimeout);
			editorIdleTimeout = null;
		}
	}

	function selectPage(pageId: string) {
		if (editingPageId) return;
		const targetPage = session.pages.find((page) => page.id === pageId && page.deletedAt === null);
		if (!targetPage) return;
		persistSession({
			...session,
			activePageId: pageId
		});
		menuPageId = null;
		drawerOpen = false;
	}

	function addPage() {
		const currentActivePageId = session.activePageId;
		const page = createPage('', { userId: getScopedUserId(), isEphemeral: true });
		persistSession({
			pages: [
				...session.pages.map((existingPage) =>
					existingPage.id === currentActivePageId ? materializePage(existingPage) : existingPage
				),
				page
			],
			activePageId: page.id
		});
		markSavedLocally();
		menuPageId = null;
		drawerOpen = false;
	}

	function closePage(pageId: string) {
		const deletedPage = session.pages.find((page) => page.id === pageId);
		if (!deletedPage) {
			menuPageId = null;
			deletePageId = null;
			return;
		}

		const nextPages = session.pages.map((page) =>
			page.id === pageId ? markPageDeleted(page) : page
		);
		const nextVisiblePages = nextPages.filter((page) => page.deletedAt === null);
		if (nextVisiblePages.length === 0) {
			const replacementPage = createPage('', { userId: getScopedUserId(), isEphemeral: true });
			nextPages.push(replacementPage);
			persistSession({
				pages: nextPages,
				activePageId: replacementPage.id
			});
		} else {
			const nextActivePageId =
				session.activePageId === pageId
					? (nextVisiblePages[0]?.id ?? session.activePageId)
					: session.activePageId;

			persistSession({
				pages: nextPages,
				activePageId: nextActivePageId
			});
		}
		menuPageId = null;
		deletePageId = null;
		markSavedLocally();
		requestImmediateSync();
	}

	function toggleMenu(pageId: string) {
		if (editingPageId === pageId) return;
		menuPageId = menuPageId === pageId ? null : pageId;
	}

	async function startEditingTitle(pageId: string) {
		const page = session.pages.find((entry) => entry.id === pageId);
		if (!page) return;
		menuPageId = null;
		editingPageId = pageId;
		titleDraft = page.title;
		await tick();
		titleInput?.focus();
		titleInput?.select();
	}

	function confirmTitleEdit() {
		if (!editingPageId) return;

		const pageId = editingPageId;
		editingPageId = null;
		persistSession({
			...session,
			pages: session.pages.map((entry) =>
				entry.id === pageId ? updatePageTitle(entry, titleDraft) : entry
			)
		});
		markSavedLocally();
		requestImmediateSync();
	}

	function cancelTitleEdit() {
		editingPageId = null;
		titleDraft = '';
	}

	function queueWorkspacePersist(task: () => Promise<void>) {
		workspacePersistQueue = workspacePersistQueue
			.then(task)
			.catch((error) => {
				console.error('Failed to persist editor workspace:', error);
			});

		return workspacePersistQueue;
	}

	function openDeleteModal(pageId: string) {
		menuPageId = null;
		deletePageId = pageId;
	}

	function closeDeleteModal() {
		deletePageId = null;
	}

	function closeLoginModal() {
		if (loginSubmitting || otpVerifying) return;
		loginModalOpen = false;
		loginStep = 'email';
		otpDraft = '';
		stopResendCooldown();
		authMessage = '';
	}

	async function submitLogin() {
		if (!supabase) {
			authMessage = 'Supabase is not configured yet.';
			return;
		}

		const email = emailDraft.trim();
		if (!email) {
			authMessage = 'Enter an email address.';
			return;
		}

		loginSubmitting = true;
		authMessage = '';

		const savedSession = findSavedAuthSessionByEmail(email);
		if (savedSession) {
			const { error: restoreError } = await supabase.auth.setSession({
				access_token: savedSession.session.access_token,
				refresh_token: savedSession.session.refresh_token
			});

			if (!restoreError) {
				loginSubmitting = false;
				loginModalOpen = false;
				loginStep = 'email';
				otpDraft = '';
				return;
			}

			removeSavedAuthSession(savedSession.userId);
		}

		const { error } = await supabase.auth.signInWithOtp({ email });

		loginSubmitting = false;

		if (error) {
			authMessage = error.message;
			return;
		}

		loginStep = 'otp';
		otpDraft = '';
		startResendCooldown();
	}

	async function verifyOtpCode(code: string) {
		if (!supabase || otpVerifying || code.length !== 8) return;

		otpVerifying = true;
		authMessage = '';

		const { error } = await supabase.auth.verifyOtp({
			email: emailDraft.trim(),
			token: code,
			type: 'email'
		});

		otpVerifying = false;

		if (error) {
			otpDraft = '';
			authMessage = error.message;
			triggerOtpShake();
			return;
		}

		loginModalOpen = false;
		loginStep = 'email';
		otpDraft = '';
		stopResendCooldown();
	}

	async function resendOtpCode() {
		if (!supabase || resendCooldownRemaining > 0 || loginSubmitting || otpVerifying) return;

		loginSubmitting = true;
		authMessage = '';

		const { error } = await supabase.auth.signInWithOtp({
			email: emailDraft.trim()
		});

		loginSubmitting = false;

		if (error) {
			authMessage = error.message;
			return;
		}

		startResendCooldown();
		authMessage = 'A new code was sent.';
	}

	function startResendCooldown() {
		stopResendCooldown();
		resendCooldownRemaining = 30;
		resendCooldownInterval = setInterval(() => {
			resendCooldownRemaining = Math.max(0, resendCooldownRemaining - 1);
			if (resendCooldownRemaining === 0) {
				stopResendCooldown();
			}
		}, 1000);
	}

	function stopResendCooldown() {
		if (resendCooldownInterval) {
			clearInterval(resendCooldownInterval);
			resendCooldownInterval = null;
		}
	}

	function triggerOtpShake() {
		otpShake = false;
		requestAnimationFrame(() => {
			otpShake = true;
			setTimeout(() => {
				otpShake = false;
			}, 300);
		});
	}

	async function logout() {
		if (authBusy || syncBusy) return;

		authBusy = true;
		authMessage = '';
		clearAllToasts();
		suppressSavedSessionRemoval = true;
		await clearActiveSupabaseSession();
		suppressSavedSessionRemoval = false;
		authBusy = false;
		settingsMenuOpen = false;
	}

	async function resolveAnonymousImport(addAnonymousToAccount: boolean) {
		if (authUser && pendingAnonymousImportSession) {
			await EditorStorage.markPromptedForAnonymousImport(authUser.id);
		}

		if (addAnonymousToAccount && pendingAnonymousImportSession) {
			const targetUserId = getScopedUserId(authUser?.id);
			const nextSession: EditorSession = {
				pages: [
					...session.pages,
					...pendingAnonymousImportSession.pages.map((page) => clonePageForUser(page, targetUserId))
				],
				activePageId: session.activePageId
			};

			replaceLocalSession(nextSession, {
				persist: true
			});
		}

		pendingAnonymousImportSession = null;
		importPromptOpen = false;
		loginModalOpen = false;
	}

	function getWordCount(value: string) {
		const trimmed = value.trim();
		return trimmed ? trimmed.split(/\s+/).length : 0;
	}

	function pluralize(count: number, label: string) {
		return `${count} ${label}${count === 1 ? '' : 's'}`;
	}

	function getParagraphCount(value: string) {
		const trimmed = value.trim();
		if (!trimmed) return 0;
		return trimmed.split(/\n\s*\n+/).filter(Boolean).length;
	}

	function getLineCount(value: string) {
		if (!value) return 0;
		return value.split('\n').length;
	}

	function clearHideChromeTimeout() {
		if (hideChromeTimeout) {
			clearTimeout(hideChromeTimeout);
			hideChromeTimeout = null;
		}
	}

	function scheduleChromeHide() {
		clearHideChromeTimeout();
		if (!hasDocumentContent || drawerOpen || countMenuOpen || settingsMenuOpen) return;

		hideChromeTimeout = setTimeout(() => {
			chromeVisible = false;
			hideChromeTimeout = null;
		}, CHROME_HIDE_DELAY);
	}

	function revealChrome(persist = false) {
		chromeVisible = true;
		if (persist) {
			clearHideChromeTimeout();
			return;
		}

		scheduleChromeHide();
	}

	function toggleCountMenu() {
		countMenuOpen = !countMenuOpen;
		settingsMenuOpen = false;
		if (countMenuOpen) {
			revealChrome(true);
			return;
		}

		scheduleChromeHide();
	}

	function selectCountDisplay(nextMode: 'words' | 'characters' | 'paragraphs' | 'lines') {
		countDisplayMode = nextMode;
		countMenuOpen = false;
		scheduleChromeHide();
	}

	function toggleSettingsMenu() {
		settingsMenuOpen = !settingsMenuOpen;
		countMenuOpen = false;
		if (settingsMenuOpen) {
			revealChrome(true);
			return;
		}

		scheduleChromeHide();
	}

	function updatePreferences(nextPreferences: EditorPreferences) {
		preferences = nextPreferences;
		void savePreferences(nextPreferences);
	}

	function toggleThemeMode() {
		updatePreferences({
			...preferences,
			themeMode: preferences.themeMode === 'dark' ? 'light' : 'dark'
		});
	}

	function toggleSpellcheck() {
		updatePreferences({
			...preferences,
			spellcheckEnabled: !preferences.spellcheckEnabled
		});
	}

	function cycleWordCountVisibility() {
		updatePreferences({
			...preferences,
			countVisibility: cycleCountVisibility(preferences.countVisibility)
		});
	}

	function handleMouseMove(event: MouseEvent) {
		if (event.clientY <= TOP_REVEAL_HEIGHT) {
			revealChrome();
		}
	}

	function handleWindowPointerDown(event: MouseEvent) {
		const target = event.target;
		if (!(target instanceof Node)) return;

		if (countMenuOpen) {
			if (
				countButton?.contains(target) ||
				(target instanceof Element && target.closest('.count-control'))
			) {
				return;
			}
			countMenuOpen = false;
		}

		if (settingsMenuOpen) {
			if (
				settingsButton?.contains(target) ||
				(target instanceof Element && target.closest('.settings-control'))
			) {
				return;
			}
			settingsMenuOpen = false;
		}

		scheduleChromeHide();
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;

		if (countMenuOpen) {
			countMenuOpen = false;
			scheduleChromeHide();
		}

		if (settingsMenuOpen) {
			settingsMenuOpen = false;
			scheduleChromeHide();
		}

		if (drawerOpen) {
			drawerOpen = false;
			menuPageId = null;
		}
	}

	function handleDocumentVisibilityChange() {
		if (browser && document.visibilityState === 'hidden') {
			requestImmediateSync();
		}
	}

	function handleWindowOffline() {
		appSyncStatus = 'offline';
	}

	onMount(() => {
		document.addEventListener('visibilitychange', handleDocumentVisibilityChange);

		void (async () => {
			let initialAuthSession: Session | null = null;
			if (supabase) {
				const {
					data: { session: authSession },
					error
				} = await supabase.auth.getSession();

				if (error) {
					authMessage = error.message;
				} else {
					initialAuthSession = authSession;
					if (authSession) {
						saveAuthSession(authSession);
					}
				}
			}

			await hydrateInitialLocalState(initialAuthSession?.user ?? null);
			previousActiveText = getActivePage(session).content;
			applyTheme(preferences.themeMode);
			loadQueuedNotice();
			setupAuthChannel();
			setupNotesChannel();
			void initializeAuth(initialAuthSession);
		})();
	});

	onDestroy(() => {
		clearHideChromeTimeout();
		clearEditorIdleFlush();
		syncController.cancel();
		activePageController.cancel();
		stopResendCooldown();
		clearAllToasts();
		if (browser) {
			document.removeEventListener('visibilitychange', handleDocumentVisibilityChange);
		}
		pagesChannel?.close();
		pagesChannel = null;
		authBroadcastChannel?.close();
		authBroadcastChannel = null;
		authSubscription?.unsubscribe();
	});

async function loadPreferences(userId = getScopedUserId()) {
	const loadedPreferences = await EditorStorage.loadPreferences(userId);
	return normalizePreferences(loadedPreferences);
}

async function hydrateInitialLocalState(nextUser: User | null) {
	authUser = nextUser;

	if (!nextUser) {
		const [anonymousSession, anonymousPreferences] = await Promise.all([
			EditorStorage.loadUserState(ANONYMOUS_USERID),
			loadPreferences(ANONYMOUS_USERID)
		]);
		const hydratedState = applyHydratedSession(anonymousSession ?? createSession(ANONYMOUS_USERID));
		session = hydratedState.session;
		loaded = hydratedState.loaded;
		preferences = anonymousPreferences;
		appSyncStatus = getSettledAppSyncStatus(session);
		return;
	}

	const [userLocal, userPreferences] = await Promise.all([
		EditorStorage.loadUserState(nextUser.id),
		loadPreferences(nextUser.id)
	]);
	const hydratedState = applyHydratedSession(userLocal ?? createSession(nextUser.id));
	session = hydratedState.session;
	loaded = hydratedState.loaded;
	preferences = userPreferences;
	appSyncStatus = getSettledAppSyncStatus(session);
}

async function savePreferences(nextPreferences: EditorPreferences) {
	await EditorStorage.savePreferences(getScopedUserId(), nextPreferences);
}

	function applyTheme(themeMode: ThemeMode) {
		if (!browser) {
			return;
		}

		document.body.dataset.theme = themeMode;
	}

	function isBrowserOnline() {
		return !browser || navigator.onLine;
	}

	function loadQueuedNotice() {
		if (!browser) {
			return;
		}

		try {
			const queued = localStorage.getItem(APP_UPDATED_NOTICE_KEY);
			if (!queued) return;

			localStorage.removeItem(APP_UPDATED_NOTICE_KEY);
			showStatusNotice(queued);
		} catch (error) {
			console.error('Failed to load queued notice:', error);
		}
	}

	async function initializeAuth(initialAuthSession?: Session | null) {
		if (!supabase) {
			return;
		}

		authBusy = true;
		let authSession = initialAuthSession;

		if (initialAuthSession === undefined) {
			const {
				data: { session: nextAuthSession },
				error
			} = await supabase.auth.getSession();

			if (error) {
				authMessage = error.message;
				authBusy = false;
				return;
			}

			authSession = nextAuthSession;
			if (authSession) {
				saveAuthSession(authSession);
			}
		}

		await syncAuthState(authSession?.user ?? null);
		authBusy = false;

		const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
			if (nextSession) {
				saveAuthSession(nextSession);
			} else if (event === 'SIGNED_OUT' && authUser && !suppressSavedSessionRemoval) {
				removeSavedAuthSession(authUser.id);
			}
			broadcastAuthSessionChanged(nextSession?.user?.id ?? null);
			void syncAuthState(nextSession?.user ?? null);
		});

		authSubscription = data.subscription;
	}

	async function syncAuthState(nextUser: User | null) {
		const requestId = ++currentAuthRequestId;
		authUser = nextUser;

		if (!nextUser) {
			pendingAnonymousImportSession = null;
			importPromptOpen = false;
			loginModalOpen = false;
			appSyncStatus = getSettledAppSyncStatus(session);
			const [anonymousSession, anonymousPreferences] = await Promise.all([
				EditorStorage.loadAnonymousState(),
				loadPreferences(ANONYMOUS_USERID)
			]);
			preferences = anonymousPreferences;
			applyTheme(preferences.themeMode);
			replaceLocalSession(anonymousSession, {
				source: 'syncAuthState:anonymous-session'
			});
			return;
		}

		authBusy = true;
		authMessage = '';

		try {
			const [userLocal, anonymousSession, alreadyPrompted, userPreferences] = await Promise.all([
				EditorStorage.loadUserState(nextUser.id),
				EditorStorage.loadAnonymousState(),
				EditorStorage.hasPromptedForAnonymousImport(nextUser.id),
				loadPreferences(nextUser.id)
			]);
			const hasAnonymousData = anonymousSession.pages.some(
				(page) => page.deletedAt === null && (page.content.trim().length > 0 || page.title !== 'Untitled')
			);

			if (currentAuthRequestId !== requestId) {
				return;
			}

			preferences = userPreferences;
			applyTheme(preferences.themeMode);

			const baseSession = userLocal ?? createSession(nextUser.id);
			let syncedSession = baseSession;
			if (supabase) {
				appSyncStatus = isBrowserOnline() ? 'syncing' : 'offline';
				try {
					syncedSession = (await syncUserPages(supabase, nextUser.id, baseSession)).session;
					appSyncStatus = getSettledAppSyncStatus(syncedSession);
				} catch (error) {
					appSyncStatus = isBrowserOnline() ? 'error' : 'offline';
					throw error;
				}
			}
			const remoteActivePageId =
				supabase ? await fetchRemoteActivePageId(supabase, nextUser.id) : null;
			const shouldPreserveLocalEphemeralPage = hasVisibleEphemeralActivePage(syncedSession);
			const nextSession =
				!shouldPreserveLocalEphemeralPage &&
				remoteActivePageId &&
				syncedSession.pages.some((page) => page.id === remoteActivePageId && page.deletedAt === null)
					? {
							...syncedSession,
							activePageId: remoteActivePageId
						}
					: syncedSession;
			if (!areEditorSessionsEquivalent(nextSession, session)) {
				replaceLocalSession(mergeEditorSelections(nextSession, session), {
					source: 'syncAuthState:nextSession',
					details: { requestId }
				});
			}

			if (hasAnonymousData && !alreadyPrompted) {
				pendingAnonymousImportSession = anonymousSession;
				importPromptOpen = true;
			} else {
				pendingAnonymousImportSession = null;
				importPromptOpen = false;
			}

			loginModalOpen = false;
		} catch (error) {
			authMessage = getErrorMessage(error, 'Unable to load saved notes.');
		} finally {
			if (currentAuthRequestId === requestId) {
				authBusy = false;
			}
		}
	}

	async function persistWorkspaceState(
		previousSession: EditorSession,
		nextSession: EditorSession
	): Promise<ChangedPageEvent[]> {
		const targetUserId = getScopedUserId();
		const sessionSnapshot: EditorSession = {
			activePageId: nextSession.activePageId,
			pages: nextSession.pages.map((page) => ({ ...page, userId: targetUserId }))
		};
		const changedEvents = getChangedPageEvents(previousSession, sessionSnapshot);

		await queueWorkspacePersist(async () => {
			if (targetUserId === ANONYMOUS_USERID) {
				await EditorStorage.saveAnonymousState(sessionSnapshot);
			} else {
				await EditorStorage.saveUserState(targetUserId, sessionSnapshot);
			}

			broadcastPageUpdates(changedEvents);
		});

		return changedEvents;
	}

	function setupAuthChannel() {
		if (!browser || typeof BroadcastChannel === 'undefined') {
			return;
		}

		authBroadcastChannel?.close();
		authBroadcastChannel = new AuthBroadcastChannel({
			channelName: AUTH_CHANNEL_NAME,
			tabId,
			getCurrentUserId: () => authUser?.id ?? null,
			onRemoteAuthChanged: () => {
				void refreshAuthFromBroadcast();
			}
		});
		authBroadcastChannel.open();
	}

	function broadcastAuthSessionChanged(userId: string | null) {
		authBroadcastChannel?.broadcast(userId);
	}

	async function refreshAuthFromBroadcast() {
		if (!supabase) {
			return;
		}

		const {
			data: { session: nextAuthSession },
			error
		} = await supabase.auth.getSession();

		if (error) {
			console.error('Failed to refresh auth session from broadcast:', error);
			return;
		}

		if (nextAuthSession?.user?.id === authUser?.id) {
			return;
		}

		void syncAuthState(nextAuthSession?.user ?? null);
	}

	function setupNotesChannel() {
		if (!browser || typeof BroadcastChannel === 'undefined') {
			return;
		}

		pagesChannel?.close();
		pagesChannel = new BroadcastChannel('pages');
		pagesChannel.onmessage = (event) => {
			const message = event.data as { type?: unknown; id?: unknown; userId?: unknown } | null;
			if (
				!message ||
				typeof message.type !== 'string' ||
				typeof message.id !== 'string' ||
				typeof message.userId !== 'string'
			) {
				return;
			}

			if (!LOCAL_PAGE_EVENT_TYPES.has(message.type as LocalPageEventType)) {
				return;
			}
			if (message.userId !== getScopedUserId()) {
				return;
			}

			void refreshPageFromIndexedDb(message.type as LocalPageEventType, message.id);
		};
	}

	function broadcastPageUpdates(events: ChangedPageEvent[]) {
		if (!pagesChannel || events.length === 0) {
			return;
		}

		const userId = getScopedUserId();
		for (const event of events) {
			pagesChannel.postMessage({ type: event.type, id: event.id, userId });
		}
	}

	async function applyPageEventsLocally(
		events: ChangedPageEvent[],
		options: { allowActiveWhileFocused?: boolean } = {}
	) {
		void options;
		if (events.length === 0) {
			return;
		}

		const eventById = new Map<string, LocalPageEventType>();
		for (const event of events) {
			const current = eventById.get(event.id);
			if (!current || compareEventPriority(event.type, current) < 0) {
				eventById.set(event.id, event.type);
			}
		}

		for (const [id, type] of eventById) {
			await refreshPageFromIndexedDb(type, id);
		}
	}

	async function refreshPageFromIndexedDb(eventType: LocalPageEventType, noteId: string) {
		const page = authUser
			? await EditorStorage.loadUserPage(authUser.id, noteId)
			: await EditorStorage.loadAnonymousPage(noteId);
		if (!page) {
			if (eventType !== 'deleted-page') {
				return;
			}

			const nextSession = {
				...session,
				pages: session.pages.filter((entry) => entry.id !== noteId)
			};
			if (areEditorSessionsEquivalent(nextSession, session)) {
				return;
			}

			replaceLocalSession(nextSession, {
				persist: false,
				source: 'refreshPageFromIndexedDb:deleted-page',
				details: { eventType, noteId }
			});
			return;
		}

		const existingPage = session.pages.find((entry) => entry.id === noteId) ?? null;
		const nextSession: EditorSession = existingPage
			? {
					...session,
					pages: session.pages.map((entry) => (entry.id === noteId ? { ...page } : entry))
				}
			: {
					...session,
					pages: [...session.pages, { ...page }]
				};

		if (areEditorSessionsEquivalent(nextSession, session)) {
			return;
		}

		replaceLocalSession(mergeEditorSelections(nextSession, session), {
			persist: false,
			source: 'refreshPageFromIndexedDb:page-load',
			details: { eventType, noteId }
		});
	}

	function compareEventPriority(left: LocalPageEventType, right: LocalPageEventType) {
		const order: Record<LocalPageEventType, number> = {
			'deleted-page': 0,
			'new-page': 1,
			'page-updated': 2,
			'title-updated': 3
		};
		return order[left] - order[right];
	}

	function showStatusNotice(message: string) {
		if (!browser) return;

		try {
			localStorage.removeItem(APP_UPDATED_NOTICE_KEY);
		} catch (error) {
			void error;
		}

		const id = nextToastId++;
		toastNotices = [{ id, message }, ...toastNotices];
		toastTimeouts.set(
			id,
			window.setTimeout(() => {
				dismissToast(id);
			}, 4000)
		);
	}

	function dismissToast(id: number) {
		const timeout = toastTimeouts.get(id);
		if (timeout) {
			window.clearTimeout(timeout);
			toastTimeouts.delete(id);
		}

		toastNotices = toastNotices.filter((toast) => toast.id !== id);
	}

	function clearAllToasts() {
		for (const timeout of toastTimeouts.values()) {
			window.clearTimeout(timeout);
		}
		toastTimeouts.clear();
		toastNotices = [];
	}

	function getErrorMessage(error: unknown, fallback: string) {
		if (error instanceof Error && error.message) {
			return error.message;
		}

		if (
			typeof error === 'object' &&
			error &&
			'message' in error &&
			typeof error.message === 'string'
		) {
			return error.message;
		}

		return fallback;
	}

	function getScopedUserId(userId: string | null = authUser?.id ?? null) {
		return userId ?? ANONYMOUS_USERID;
	}

	function markSavedLocally() {
		if (!authUser) {
			return;
		}

		appSyncStatus = getSettledAppSyncStatus(session);
	}

	function getSyncStatusLabel(status: AppSyncStatus) {
		switch (status) {
			case 'offline':
				return 'Offline';
			case 'syncing':
				return 'Syncing…';
			case 'synced':
				return 'Synced';
			case 'saved_locally':
				return 'Saved locally';
			case 'error':
				return 'Sync error';
		}
	}

	function scheduleDebouncedSync() {
		if (!supabase || !authUser || !loaded) {
			return;
		}

		syncController.scheduleDebounced();
	}

	function requestImmediateSync(options: { showSuccessNotice?: boolean } = {}) {
		if (!supabase || !authUser || !loaded) {
			return;
		}

		syncController.requestImmediate({ showSuccessNotice: options.showSuccessNotice ?? false });
	}

	async function executeSync(options: { showSuccessNotice: boolean }) {
		if (!supabase || !authUser || !loaded) {
			return;
		}

		const syncSourceSession = session;
		syncBusy = true;
		appSyncStatus = isBrowserOnline() ? 'syncing' : 'offline';
		authMessage = '';

		try {
			const result = await syncUserPages(supabase, authUser.id, syncSourceSession);

			if (!areEditorSessionsEquivalent(session, syncSourceSession)) {
				const reconciledSession = reconcileSyncResult(session, syncSourceSession, result.session);
				replaceLocalSession(mergeEditorSelections(reconciledSession, session), {
					persist: true,
					source: 'executeSync:reconciled-result'
				});
				syncController.queueFollowUp(options);
				return;
			}

			replaceLocalSession(mergeEditorSelections(result.session, session), {
				persist: true,
				source: 'executeSync:result'
			});

			if (result.conflictCount > 0) {
				showStatusNotice(
					result.conflictCount === 1
						? 'Sync complete with 1 conflict fork'
						: `Sync complete with ${result.conflictCount} conflict forks`
				);
			} else if (options.showSuccessNotice && (result.pushedCount > 0 || result.pulledCount > 0)) {
				showStatusNotice('Sync complete');
			}
			appSyncStatus = getSettledAppSyncStatus(session);
		} catch (error) {
			appSyncStatus = isBrowserOnline() ? 'error' : 'offline';
			authMessage = getErrorMessage(error, 'Unable to sync pages.');
		} finally {
			syncBusy = false;
		}
	}

	function handleWindowBlur() {
		requestImmediateSync();
	}

	function handleWindowOnline() {
		appSyncStatus = getSettledAppSyncStatus(session);
		requestImmediateSync();
	}

	function handleWindowBeforeUnload() {
		void persistWorkspaceState(session, session);
		requestImmediateSync();
	}
</script>

<svelte:window
	on:beforeunload={handleWindowBeforeUnload}
	on:blur={handleWindowBlur}
	on:online={handleWindowOnline}
	on:offline={handleWindowOffline}
	on:mousemove={handleMouseMove}
	on:mousedown={handleWindowPointerDown}
	on:keydown={handleWindowKeydown}
/>

<div class="page-shell">
	<div class:visible={loaded && chromeVisible} class="top-bar-shell">
		<div class="top-bar">
			<button
				class="drawer-toggle"
				type="button"
				aria-label={drawerOpen ? 'Close pages' : 'Open pages'}
				aria-expanded={drawerOpen}
				on:click={() => (drawerOpen = !drawerOpen)}
			>
				<Icon name="bars-3" />
			</button>
			<div class="settings-control">
				<button
					bind:this={settingsButton}
					class="settings-toggle"
					type="button"
					aria-haspopup="menu"
					aria-expanded={settingsMenuOpen}
					aria-label="Open editor settings"
					on:click={toggleSettingsMenu}
				>
					<Icon name="ellipsis-horizontal" />
				</button>
				{#if settingsMenuOpen}
					<FloatingMenu label="Editor settings" verticalOffset="0.45rem">
						<button type="button" on:click={toggleThemeMode}>
							{preferences.themeMode === 'dark' ? 'Light mode' : 'Dark mode'}
						</button>
						<button type="button" on:click={toggleSpellcheck}>
							{preferences.spellcheckEnabled ? 'Spellcheck on' : 'Spellcheck off'}
						</button>
						<button
							type="button"
							aria-label={`Cycle word count visibility, currently ${getCountVisibilityLabel(preferences.countVisibility).toLowerCase()}`}
							on:click={cycleWordCountVisibility}
						>
							{getCountVisibilityLabel(preferences.countVisibility)}
						</button>
						{#if authUser}
							<button
								type="button"
								disabled={syncBusy || appSyncStatus === 'offline'}
								on:click={() => requestImmediateSync({ showSuccessNotice: true })}
							>
								{syncStatusLabel}
							</button>
							<button type="button" disabled={authBusy || syncBusy} on:click={logout}>Logout</button>
							<div class="menu-stat">{authUser.email ?? authUser.id}</div>
						{:else}
							<button
								type="button"
								on:click={() => {
									loginModalOpen = true;
									settingsMenuOpen = false;
									authMessage = '';
								}}
							>
								Login
							</button>
						{/if}
						{#if authMessage && !loginModalOpen}
							<div class="menu-stat">{authMessage}</div>
						{/if}
					</FloatingMenu>
				{/if}
			</div>
		</div>
	</div>

	<div class:count-visible={countVisible} class:docked-right={countDockedRight} class="count-shell">
		{#if countVisibleInChrome}
			<div class="count-control">
				<button
					bind:this={countButton}
					class="count-toggle"
					type="button"
					aria-haspopup="menu"
					aria-expanded={countMenuOpen}
					aria-label={`Open count menu, currently showing ${currentCountLabel}`}
					on:click={toggleCountMenu}
				>
					{currentCountLabel}
				</button>
				{#if countMenuOpen}
					<FloatingMenu label="Count display options" verticalOffset="0.45rem">
						{#each countOptions as option (option.id)}
							<button
								type="button"
								role="menuitemradio"
								aria-checked={option.id === countDisplayMode}
								on:click={() => selectCountDisplay(option.id)}
							>
								{option.label}
							</button>
						{/each}
					</FloatingMenu>
				{/if}
			</div>
		{/if}
	</div>

	{#if drawerOpen}
		<button
			class="scrim"
			type="button"
			aria-label="Close pages"
			on:click={() => {
				drawerOpen = false;
				menuPageId = null;
			}}
		></button>
	{/if}

	{#if deletePage}
		<Modal title="Delete page?" onClose={closeDeleteModal}>
			<p>{deletePage.title}</p>
			<svelte:fragment slot="actions">
				<button type="button" class="modal-button" on:click={closeDeleteModal}>Cancel</button>
				<button
					type="button"
					class="modal-button modal-button-delete"
					on:click={() => closePage(deletePage.id)}
				>
					Delete
				</button>
			</svelte:fragment>
		</Modal>
	{/if}

	{#if loginModalOpen}
		<Modal title="Login" onClose={closeLoginModal}>
			{#if loginStep === 'email'}
				<label class="auth-field">
					<span>Email</span>
					<input
						bind:value={emailDraft}
						class="auth-input"
						type="email"
						placeholder="you@example.com"
						autocomplete="email"
						on:keydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void submitLogin();
							}
						}}
					/>
				</label>
			{:else}
				<div class="auth-field">
					<span>Code sent to {emailDraft.trim()}</span>
					<OtpInput
						value={otpDraft}
						disabled={otpVerifying}
						shake={otpShake}
						on:change={(event) => {
							otpDraft = event.detail.value;
						}}
						on:complete={(event) => {
							void verifyOtpCode(event.detail.value);
						}}
					/>
				</div>
			{/if}
			{#if authMessage}
				<p class="auth-message">{authMessage}</p>
			{/if}
			<svelte:fragment slot="actions">
				{#if loginStep === 'otp'}
					<button
						type="button"
						class="modal-button"
						disabled={resendCooldownRemaining > 0 || loginSubmitting || otpVerifying}
						on:click={resendOtpCode}
					>
						{#if resendCooldownRemaining > 0}
							Resend code ({resendCooldownRemaining}s)
						{:else}
							Resend code
						{/if}
					</button>
					<button
						type="button"
						class="modal-button"
						disabled={otpVerifying}
						on:click={() => {
							loginStep = 'email';
							otpDraft = '';
							authMessage = '';
						}}
					>
						Back
					</button>
					<div class="auth-status" aria-live="polite">
						{otpVerifying ? 'Verifying…' : ''}
					</div>
				{:else}
					<button type="button" class="modal-button" on:click={closeLoginModal}>Cancel</button>
					<button
						type="button"
						class="modal-button modal-button-primary"
						disabled={loginSubmitting}
						on:click={submitLogin}
					>
						{loginSubmitting ? 'Sending…' : 'Send Email'}
					</button>
				{/if}
			</svelte:fragment>
		</Modal>
	{/if}

	{#if importPromptOpen && pendingAnonymousImportSession}
		<Modal title="Add local data to this account?" dismissible={false}>
			<p>Do you want the notes already stored on this device added to this account's local workspace?</p>
			<svelte:fragment slot="actions">
				<button
					type="button"
					class="modal-button"
					disabled={authBusy}
					on:click={() => resolveAnonymousImport(false)}
				>
					No
				</button>
				<button
					type="button"
					class="modal-button modal-button-primary"
					disabled={authBusy}
					on:click={() => resolveAnonymousImport(true)}
				>
					Yes
				</button>
			</svelte:fragment>
		</Modal>
	{/if}

	<aside class:open={drawerOpen} class="drawer" aria-label="Pages">
		<div class="drawer-header">
			<h1>Pages</h1>
			<button type="button" class="add-page" aria-label="New page" on:click={addPage}>+</button>
		</div>

		<nav class="page-list" aria-label="Page tabs">
			{#each visiblePages as page (page.id)}
				<div class:active={page.id === session.activePageId} class="page-row">
					{#if editingPageId === page.id}
						<div class="page-tab page-tab-editing">
							<input
								bind:this={titleInput}
								bind:value={titleDraft}
								class="title-input"
								type="text"
								aria-label="Edit page title"
								on:blur={cancelTitleEdit}
								on:keydown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										confirmTitleEdit();
									}
									if (event.key === 'Escape') {
										event.preventDefault();
										cancelTitleEdit();
									}
								}}
							/>
							<button
								type="button"
								class="confirm-title"
								aria-label="Confirm title"
								on:mousedown|preventDefault={() => {}}
								on:click={confirmTitleEdit}
							>
								✓
							</button>
						</div>
					{:else}
						<button type="button" class="page-tab" on:click={() => selectPage(page.id)}>
							<span class="page-title">{page.title}</span>
						</button>
					{/if}
					<div class="page-actions">
						<button
							type="button"
							class="menu-toggle"
							aria-label={`Page menu for ${page.title}`}
							aria-expanded={menuPageId === page.id}
							on:click={() => toggleMenu(page.id)}
						>
							<Icon name="ellipsis-horizontal" />
						</button>
						{#if menuPageId === page.id}
							<FloatingMenu label={`Page menu for ${page.title}`}>
								<button type="button" on:click={() => startEditingTitle(page.id)}>Edit title</button
								>
								<button type="button" on:click={() => openDeleteModal(page.id)}>Delete</button>
							</FloatingMenu>
						{/if}
					</div>
				</div>
			{/each}
		</nav>
	</aside>

	<section class="workspace">
		{#if loaded}
			{#key activePage.id}
				<Editor
					pageId={activePage.id}
					initialState={{
						text: activePage.content,
						selectionStart: activePage.selectionStart,
						selectionEnd: activePage.selectionEnd
					}}
					spellcheckEnabled={preferences.spellcheckEnabled}
					onFocusChange={handleEditorFocusChange}
					onChange={updateActivePage}
				/>
			{/key}
		{/if}
	</section>

	{#if toastNotices.length > 0}
		<div class="toast-stack" aria-live="polite" aria-atomic="false">
			{#each toastNotices as toast (toast.id)}
				<button
					type="button"
					class="toast"
					on:click={() => dismissToast(toast.id)}
					in:fly={{ x: 28, duration: 140, easing: cubicOut }}
					out:fly={{ x: 28, duration: 110, easing: cubicIn }}
				>
					<span class="toast-message">{toast.message}</span>
				</button>
			{/each}
		</div>
	{/if}
	</div>

<style>
	:global(body) {
		--page-background: #fff;
		--text-color: #111;
		--muted-text-color: rgba(0, 0, 0, 0.68);
		--subtle-text-color: rgba(0, 0, 0, 0.5);
		--surface-color: rgba(255, 255, 255, 0.94);
		--surface-border-color: rgba(0, 0, 0, 0.08);
		--surface-shadow-color: rgba(0, 0, 0, 0.06);
		--hover-background-color: rgba(0, 0, 0, 0.035);
		--chrome-scrim-color: rgba(255, 255, 255, 0.72);
		--modal-scrim-color: rgba(255, 255, 255, 0.8);
		--line-color: #111;
		--accent-background: rgba(0, 0, 0, 0.035);
		--editor-caret-color: #555;
		--editor-selection-color: rgba(180, 213, 255, 0.6);
		--editor-placeholder-color: #999;
		--editor-code-background: rgba(0, 0, 0, 0.04);
		--editor-muted-color: #666;
		margin: 0;
		background: var(--page-background);
		color: var(--text-color);
		font-family: 'Roboto Mono', monospace;
		transition:
			background-color 180ms ease,
			color 180ms ease;
	}

	:global(body[data-theme='dark']) {
		--page-background: #121314;
		--text-color: #f1f1ec;
		--muted-text-color: rgba(241, 241, 236, 0.7);
		--subtle-text-color: rgba(241, 241, 236, 0.62);
		--surface-color: rgba(26, 28, 30, 0.94);
		--surface-border-color: rgba(255, 255, 255, 0.12);
		--surface-shadow-color: rgba(0, 0, 0, 0.34);
		--hover-background-color: rgba(255, 255, 255, 0.06);
		--chrome-scrim-color: rgba(18, 19, 20, 0.78);
		--modal-scrim-color: rgba(18, 19, 20, 0.82);
		--line-color: #f1f1ec;
		--accent-background: rgba(255, 255, 255, 0.07);
		--editor-caret-color: #d9d9d2;
		--editor-selection-color: rgba(103, 141, 204, 0.45);
		--editor-placeholder-color: rgba(241, 241, 236, 0.42);
		--editor-code-background: rgba(255, 255, 255, 0.06);
		--editor-muted-color: rgba(241, 241, 236, 0.56);
	}

	.page-shell {
		position: relative;
		min-height: 100vh;
	}

	.top-bar-shell {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 20;
		padding: max(0.75rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0
			max(0.75rem, env(safe-area-inset-left));
		opacity: 0;
		pointer-events: none;
		transition: opacity 180ms ease;
	}

	.top-bar-shell.visible {
		opacity: 1;
		pointer-events: auto;
	}

	.toast-stack {
		position: fixed;
		top: max(4.25rem, calc(env(safe-area-inset-top) + 3rem));
		right: max(1rem, env(safe-area-inset-right));
		z-index: 40;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.65rem;
		pointer-events: none;
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		max-width: min(22rem, calc(100vw - 2rem));
		padding: 0.85rem 0.95rem;
		border: 1px solid var(--surface-border-color);
		border-radius: 0.85rem;
		background: var(--surface-color);
		color: var(--text-color);
		box-shadow: 0 18px 38px -24px var(--surface-shadow-color);
		backdrop-filter: blur(12px);
		cursor: pointer;
		text-align: left;
		white-space: normal;
		font: inherit;
		font-family: inherit;
		appearance: none;
		-webkit-appearance: none;
	}

	.toast-message {
		min-width: 0;
		flex: 1;
		font-size: 0.82rem;
		line-height: 1.35;
	}

	.top-bar {
		position: relative;
		width: 100%;
		box-sizing: border-box;
		min-height: 2rem;
	}

	.settings-control,
	.count-shell {
		position: absolute;
		top: 0;
		right: 0;
	}

	.count-control {
		position: relative;
		min-width: 0;
	}

	.count-shell {
		z-index: 21;
		padding: max(0.75rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0
			max(0.75rem, env(safe-area-inset-left));
		opacity: 0;
		pointer-events: none;
		transform: translateX(calc(-2.55rem));
		transition:
			opacity 180ms ease,
			transform 220ms ease;
	}

	.count-shell.count-visible {
		opacity: 1;
		pointer-events: auto;
	}

	.count-shell.docked-right {
		transform: translateX(0);
	}

	.count-toggle,
	.drawer-toggle,
	.settings-toggle {
		position: static;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.count-toggle {
		display: block;
		min-height: 2rem;
		max-width: min(12rem, calc(100vw - 6rem));
		padding: 0.45rem 0.75rem;
		border-radius: 999px;
		font: inherit;
		font-size: 0.75rem;
		letter-spacing: 0.02em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.count-control :global(.floating-menu) {
		min-width: max-content;
	}

	.count-control :global(.floating-menu button),
	.count-control :global(.floating-menu .menu-stat) {
		text-align: right;
	}

	.count-control :global(.floating-menu button[aria-checked='true']) {
		color: var(--subtle-text-color);
	}

	.drawer-toggle {
		width: 2rem;
		height: 2rem;
		padding: 0;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.drawer-toggle :global(svg) {
		width: 1.1rem;
		height: 1.1rem;
		color: var(--line-color);
	}

	.settings-toggle {
		width: 2rem;
		height: 2rem;
		padding: 0;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.2rem;
	}

	.settings-toggle :global(svg) {
		color: var(--line-color);
		fill: currentColor;
	}

	.scrim {
		position: fixed;
		inset: 0;
		z-index: 10;
		border: 0;
		background: var(--chrome-scrim-color);
	}

	.modal-button {
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		padding: 0.5rem 0.75rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}

	.modal-button:hover {
		background: var(--hover-background-color);
	}

	.modal-button-delete {
		background: #b42318;
		color: #fff;
	}

	.modal-button-delete:hover {
		background: #9f1f15;
	}

	.modal-button-primary {
		background: var(--text-color);
		color: var(--page-background);
	}

	.modal-button-primary:hover {
		background: var(--text-color);
		opacity: 0.9;
	}

	.modal-button:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.auth-field {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		font-size: 0.7rem;
	}

	.auth-input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--surface-border-color);
		border-radius: 0.4rem;
		background: transparent;
		color: inherit;
		font: inherit;
	}

	.auth-message {
		margin-top: 0.55rem;
	}

	.auth-status {
		font: inherit;
		font-size: 0.74rem;
		color: var(--muted-text-color);
	}

	.auth-status {
		min-width: 4.5rem;
		text-align: right;
	}

	.drawer {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 25;
		width: min(18rem, 82vw);
		padding: 4.25rem 1rem 1rem;
		box-sizing: border-box;
		background: var(--surface-color);
		border-right: 1px solid var(--surface-border-color);
		transform: translateX(-100%);
		transition: transform 180ms ease;
	}

	.drawer.open {
		transform: translateX(0);
	}

	.drawer-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.drawer-header h1 {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 400;
	}

	.add-page,
	.page-tab,
	.menu-toggle,
	.confirm-title {
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.add-page,
	.menu-toggle {
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.page-list {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.page-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		border-radius: 0.35rem;
	}

	.page-row.active {
		background: var(--accent-background);
	}

	.page-tab {
		min-width: 0;
		padding: 0.55rem 0.65rem;
		text-align: left;
	}

	.page-tab-editing {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		padding: 0.35rem 0.45rem 0.35rem 0.65rem;
		gap: 0.25rem;
	}

	.page-title {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.82rem;
	}

	.page-actions {
		position: relative;
		display: flex;
		align-items: center;
	}

	.menu-toggle {
		border-radius: 999px;
	}

	.menu-toggle :global(svg) {
		color: var(--line-color);
		fill: currentColor;
	}

	.title-input {
		min-width: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.82rem;
	}

	.confirm-title {
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border-radius: 999px;
	}

	.workspace {
		min-height: 100vh;
	}
</style>
