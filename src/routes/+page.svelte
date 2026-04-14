<script lang="ts">
	import type { User } from '@supabase/supabase-js';
	import { onDestroy, onMount, tick } from 'svelte';
	import Editor from '$lib/Editor.svelte';
	import FloatingMenu from '$lib/FloatingMenu.svelte';
	import Icon from '$lib/Icon.svelte';
	import Modal from '$lib/Modal.svelte';
	import {
		applyEditorStateUpdate,
		applyHydratedSession,
		applySessionUpdate
	} from '$lib/editor/app-state';
	import {
		applyPageIdMap,
		buildSessionFromRemote,
		hasRemoteContent,
		hasSessionContent,
		readRemoteSession,
		saveRemoteSession
	} from '$lib/editor/remote-session';
	import {
		cycleCountVisibility,
		DEFAULT_PREFERENCES,
		getCountVisibilityLabel,
		normalizePreferences,
		type EditorPreferences,
		type ThemeMode
	} from '$lib/editor/preferences';
	import { type EditorState } from '$lib/editor/history';
	import { EditorStorage } from '$lib/editor/storage';
	import { supabase } from '$lib/supabaseClient';
	import {
		createPage,
		createSession,
		type EditorPage,
		type EditorSession,
		updatePageTitle
	} from '$lib/editor/session';

	let session: EditorSession = createSession();
	let drawerOpen = false;
	let loaded = false;
	let menuPageId: string | null = null;
	let editingPageId: string | null = null;
	let deletePageId: string | null = null;
	let titleDraft = '';
	let emailDraft = '';
	let titleInput: HTMLInputElement | null = null;
	let countButton: HTMLButtonElement | null = null;
	let settingsButton: HTMLButtonElement | null = null;
	let countMenuOpen = false;
	let settingsMenuOpen = false;
	let loginModalOpen = false;
	let importPromptOpen = false;
	let countDisplayMode: 'words' | 'characters' | 'paragraphs' | 'lines' = 'words';
	let chromeVisible = true;
	let previousActiveText = '';
	let hideChromeTimeout: ReturnType<typeof setTimeout> | null = null;
	let remoteSyncTimeout: ReturnType<typeof setTimeout> | null = null;
	let preferences: EditorPreferences = DEFAULT_PREFERENCES;
	let authUser: User | null = null;
	let authBusy = false;
	let authMessage = '';
	let loginSubmitting = false;
	let syncBusy = false;
	let syncQueued = false;
	let pendingAnonymousImportSession: EditorSession | null = null;
	let currentAuthRequestId = 0;
	let authSubscription: { unsubscribe: () => void } | null = null;

	const TOP_REVEAL_HEIGHT = 112;
	const CHROME_HIDE_DELAY = 1400;
	const REMOTE_SYNC_DEBOUNCE_MS = 800;
	const PREFERENCES_KEY = 'ez-blank-preferences-v1';

	$: activePage = getActivePage(session);
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
		return (
			currentSession.pages.find((page) => page.id === currentSession.activePageId) ??
			currentSession.pages[0] ??
			createPage()
		);
	}

	function persistSession(nextSession: EditorSession) {
		const transition = applySessionUpdate({ session, loaded }, nextSession);
		session = transition.state.session;
		if (transition.persistedSession) {
			persistWorkspaceState(transition.persistedSession, authUser ? { dirty: true } : undefined);
		}
		if (authUser) {
			scheduleRemoteSync();
		}
	}

	function replaceLocalSession(
		nextSession: EditorSession,
		options: { persist?: boolean; dirty?: boolean; lastSyncedAt?: string | null } = {}
	) {
		session = nextSession;
		if (loaded && options.persist) {
			persistWorkspaceState(nextSession, {
				dirty: options.dirty,
				lastSyncedAt: options.lastSyncedAt
			});
		}
	}

	function updateActivePage(state: EditorState) {
		const transition = applyEditorStateUpdate({ session, loaded }, state);
		session = transition.state.session;
		if (transition.persistedSession) {
			persistWorkspaceState(transition.persistedSession, authUser ? { dirty: true } : undefined);
		}
		if (authUser) {
			scheduleRemoteSync();
		}
	}

	function selectPage(pageId: string) {
		if (editingPageId) return;
		persistSession({
			...session,
			activePageId: pageId
		});
		menuPageId = null;
		drawerOpen = false;
	}

	function addPage() {
		const page = createPage();
		persistSession({
			pages: [...session.pages, page],
			activePageId: page.id
		});
		menuPageId = null;
		drawerOpen = false;
	}

	function closePage(pageId: string) {
		if (session.pages.length === 1) {
			const replacementPage = createPage();
			persistSession({
				pages: [replacementPage],
				activePageId: replacementPage.id
			});
			menuPageId = null;
			return;
		}

		const nextPages = session.pages.filter((page) => page.id !== pageId);
		const nextActivePageId =
			session.activePageId === pageId
				? (nextPages[0]?.id ?? session.activePageId)
				: session.activePageId;

		persistSession({
			pages: nextPages,
			activePageId: nextActivePageId
		});
		menuPageId = null;
		deletePageId = null;
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
	}

	function cancelTitleEdit() {
		editingPageId = null;
		titleDraft = '';
	}

	function openDeleteModal(pageId: string) {
		menuPageId = null;
		deletePageId = pageId;
	}

	function closeDeleteModal() {
		deletePageId = null;
	}

	function closeLoginModal() {
		if (loginSubmitting) return;
		loginModalOpen = false;
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

		const { error } = await supabase.auth.signInWithOtp({
			email,
			options: {
				emailRedirectTo: window.location.href
			}
		});

		loginSubmitting = false;

		if (error) {
			authMessage = error.message;
			return;
		}

		authMessage = 'Check your email for the login link.';
	}

	async function logout() {
		if (!supabase || authBusy) return;

		authBusy = true;
		authMessage = '';
		clearRemoteSyncTimeout();

		const { error } = await supabase.auth.signOut();

		authBusy = false;

		if (error) {
			authMessage = error.message;
			return;
		}

		settingsMenuOpen = false;
	}

	function resolveAnonymousImport(addAnonymousToAccount: boolean) {
		if (authUser && pendingAnonymousImportSession) {
			EditorStorage.markPromptedUserId(authUser.id);
		}

		if (addAnonymousToAccount && pendingAnonymousImportSession) {
			const nextSession: EditorSession = {
				pages: [...session.pages, ...pendingAnonymousImportSession.pages],
				activePageId: session.activePageId
			};

			replaceLocalSession(nextSession, {
				persist: true,
				dirty: true,
				lastSyncedAt: null
			});
			scheduleRemoteSync();
		}

		pendingAnonymousImportSession = null;
		importPromptOpen = false;
		loginModalOpen = false;
	}

	function handleStorage(event: StorageEvent) {
		if (event.key === PREFERENCES_KEY) {
			preferences = loadPreferences();
			return;
		}

		if (authUser) {
			if (event.key === EditorStorage.getUserStateKey(authUser.id)) {
				const userSession = EditorStorage.loadUserState(authUser.id);
				if (userSession) {
					session = userSession;
				}
			}
			return;
		}

		if (event.key === EditorStorage.getAnonymousStateKey()) {
			session = EditorStorage.loadAnonymousState();
		}
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

	function clearRemoteSyncTimeout() {
		if (remoteSyncTimeout) {
			clearTimeout(remoteSyncTimeout);
			remoteSyncTimeout = null;
		}
	}

	function scheduleRemoteSync() {
		if (!canSyncRemotely()) return;

		if (syncBusy) {
			syncQueued = true;
			return;
		}

		clearRemoteSyncTimeout();
		remoteSyncTimeout = setTimeout(() => {
			void flushRemoteSync();
		}, REMOTE_SYNC_DEBOUNCE_MS);
	}

	function canSyncRemotely() {
		return loaded && !!supabase && !!authUser && !importPromptOpen;
	}

	async function flushRemoteSync() {
		if (!supabase || !authUser || !loaded) return;

		clearRemoteSyncTimeout();
		syncBusy = true;
		authMessage = '';
		const saveUserId = authUser.id;
		const snapshot = session;
		const syncedAt = new Date().toISOString();

		try {
			const result = await saveRemoteSession(supabase, saveUserId, snapshot);

			if (authUser?.id !== saveUserId) {
				return;
			}

			if (result.pageIdMap.size > 0) {
				const remote = await readRemoteSession(supabase, saveUserId);
				if (authUser?.id !== saveUserId) {
					return;
				}
				replaceLocalSession(buildSessionFromRemote(remote), {
					persist: true,
					dirty: false,
					lastSyncedAt: syncedAt
				});
			} else {
				replaceLocalSession(
					applyPageIdMap(session, result.pageIdMap, result.activePageId ?? session.activePageId),
					{
						persist: true,
						dirty: false,
						lastSyncedAt: syncedAt
					}
				);
			}
		} catch (error) {
			authMessage = getErrorMessage(error, 'Unable to sync changes.');
		} finally {
			syncBusy = false;

			if (syncQueued && authUser?.id === saveUserId) {
				syncQueued = false;
				scheduleRemoteSync();
			}
		}
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
		savePreferences(nextPreferences);
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

	onMount(() => {
		const hydratedState = applyHydratedSession(
			{ session, loaded },
			EditorStorage.loadAnonymousState()
		);
		session = hydratedState.session;
		loaded = hydratedState.loaded;
		preferences = loadPreferences();
		previousActiveText = getActivePage(session).content;
		applyTheme(preferences.themeMode);
		void initializeAuth();
	});

	onDestroy(() => {
		clearHideChromeTimeout();
		clearRemoteSyncTimeout();
		authSubscription?.unsubscribe();
	});

	function loadPreferences(): EditorPreferences {
		try {
			const saved = localStorage.getItem(PREFERENCES_KEY);
			return saved ? normalizePreferences(JSON.parse(saved)) : DEFAULT_PREFERENCES;
		} catch (e) {
			console.error('Failed to load editor preferences:', e);
			return DEFAULT_PREFERENCES;
		}
	}

	function savePreferences(nextPreferences: EditorPreferences) {
		try {
			localStorage.setItem(PREFERENCES_KEY, JSON.stringify(nextPreferences));
		} catch (e) {
			console.error('Failed to save editor preferences:', e);
		}
	}

	function applyTheme(themeMode: ThemeMode) {
		document.body.dataset.theme = themeMode;
	}

	async function initializeAuth() {
		if (!supabase) {
			return;
		}

		authBusy = true;

		const {
			data: { session: authSession },
			error
		} = await supabase.auth.getSession();

		if (error) {
			authMessage = error.message;
			authBusy = false;
			return;
		}

		await syncAuthState(authSession?.user ?? null);
		authBusy = false;

		const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
			void syncAuthState(nextSession?.user ?? null);
		});

		authSubscription = data.subscription;
	}

	async function syncAuthState(nextUser: User | null) {
		const requestId = ++currentAuthRequestId;
		authUser = nextUser;
		clearRemoteSyncTimeout();
		syncQueued = false;

		if (!nextUser) {
			pendingAnonymousImportSession = null;
			importPromptOpen = false;
			loginModalOpen = false;
			replaceLocalSession(EditorStorage.loadAnonymousState());
			return;
		}

		authBusy = true;
		authMessage = '';

		try {
			if (!supabase) return;

			const userLocal = EditorStorage.loadUserState(nextUser.id);
			const userSyncMeta = EditorStorage.loadUserSyncMeta(nextUser.id);
			const anonymousSession = EditorStorage.loadAnonymousState();
			const hasAnonymousData = hasSessionContent(anonymousSession);
			const alreadyPrompted = EditorStorage.hasPromptedUserId(nextUser.id);

			if (userLocal) {
				replaceLocalSession(userLocal);
			}

			const remote = await readRemoteSession(supabase, nextUser.id);

			if (currentAuthRequestId !== requestId) {
				return;
			}

			if (userLocal) {
				if (!userSyncMeta.dirty && hasRemoteContent(remote)) {
					const remoteSession = buildSessionFromRemote(remote);
					replaceLocalSession(remoteSession, {
						persist: true,
						dirty: false,
						lastSyncedAt: userSyncMeta.lastSyncedAt
					});
				} else if (userSyncMeta.dirty) {
					scheduleRemoteSync();
				}

				if (hasAnonymousData && !alreadyPrompted) {
					pendingAnonymousImportSession = anonymousSession;
					importPromptOpen = true;
				}

				loginModalOpen = false;
				return;
			}

			const nextSession = hasRemoteContent(remote)
				? buildSessionFromRemote(remote)
				: createSession();
			replaceLocalSession(nextSession, {
				persist: true,
				dirty: false,
				lastSyncedAt: null
			});

			if (hasAnonymousData && !alreadyPrompted) {
				pendingAnonymousImportSession = anonymousSession;
				importPromptOpen = true;
			}
			loginModalOpen = false;
		} catch (error) {
			authMessage = getErrorMessage(error, 'Unable to load synced notes.');
		} finally {
			if (currentAuthRequestId === requestId) {
				authBusy = false;
			}
		}
	}

	function persistWorkspaceState(
		nextSession: EditorSession,
		options: { dirty?: boolean; lastSyncedAt?: string | null } = {}
	) {
		if (!authUser) {
			EditorStorage.saveAnonymousState(nextSession);
			return;
		}

		EditorStorage.saveUserState(authUser.id, nextSession);
		const currentMeta = EditorStorage.loadUserSyncMeta(authUser.id);
		EditorStorage.saveUserSyncMeta(authUser.id, {
			dirty: options.dirty ?? currentMeta.dirty,
			lastSyncedAt:
				options.lastSyncedAt === undefined ? currentMeta.lastSyncedAt : options.lastSyncedAt
		});
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
</script>

<svelte:window
	on:beforeunload={() => persistWorkspaceState(session)}
	on:storage={handleStorage}
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
							<button type="button" disabled={authBusy} on:click={logout}>Logout</button>
							<div class="menu-stat">{syncBusy ? 'Syncing...' : authUser.email}</div>
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
			{#if authMessage}
				<p class="auth-message">{authMessage}</p>
			{/if}
			<svelte:fragment slot="actions">
				<button type="button" class="modal-button" on:click={closeLoginModal}>Cancel</button>
				<button
					type="button"
					class="modal-button modal-button-primary"
					disabled={loginSubmitting}
					on:click={submitLogin}
				>
					{loginSubmitting ? 'Sending...' : 'Send link'}
				</button>
			</svelte:fragment>
		</Modal>
	{/if}

	{#if importPromptOpen && pendingAnonymousImportSession}
		<Modal title="Add local data to remote data?" dismissible={false}>
			<p>Do you want local data added to remote data for this account?</p>
			<svelte:fragment slot="actions">
				<button
					type="button"
					class="modal-button"
					disabled={syncBusy}
					on:click={() => resolveAnonymousImport(false)}
				>
					No
				</button>
				<button
					type="button"
					class="modal-button modal-button-primary"
					disabled={syncBusy}
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
			{#each session.pages as page (page.id)}
				<div class:active={page.id === session.activePageId} class="page-row">
					{#if editingPageId === page.id}
						<div class="page-tab page-tab-editing">
							<input
								bind:this={titleInput}
								bind:value={titleDraft}
								class="title-input"
								type="text"
								aria-label="Edit page title"
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
					initialState={{
						text: activePage.content,
						selectionStart: activePage.selectionStart,
						selectionEnd: activePage.selectionEnd
					}}
					spellcheckEnabled={preferences.spellcheckEnabled}
					onChange={updateActivePage}
				/>
			{/key}
		{/if}
	</section>
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
		font-size: 0.78rem;
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
